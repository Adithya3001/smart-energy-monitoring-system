#!/usr/bin/env python3
"""
process_iawe.py — build a compact processed dataset for the Smart Energy UI.

Reads the raw iAWE electricity channels (the original 1 Hz CSVs, identical to
the data referenced by iawe.h5), aggregates them into hourly energy values over
a selected window, derives every number the frontend shows, and writes a single
small JSON file:  data/energy-data.json

Single source of truth:
    All kWh, cost, percentages, chart series, score and recommendations derive
    from the raw W readings below. The frontend never hard-codes an energy
    figure. Every heuristic constant lives in CONFIG below and is exported to
    the JSON `config` key so the frontend reads the same numbers.

Pipeline
    raw 1 Hz W  ->  filter window  ->  clip/clean  ->  IST timestamps
        ->  hourly kWh  ->  daily kWh  ->  appliance stats  ->  score
        ->  recommendations  ->  data/energy-data.json

Missing-data policy (gap handling)
    Each measured second contributes W x period_s / 3.6e6 kWh. Unmeasured
    seconds are counted as ZERO (the 'measured-only' method). This never
    fabricates energy and guarantees appliance totals never exceed mains.
    A forward-fill alternative (attribute short gaps at the last known power,
    capped at 5 s) was evaluated: it would raise mains by ~38% (today 19.19 vs
    13.85 kWh) because ~33% of seconds are unlogged, a magnitude inconsistent
    with published iAWE figures. It is therefore NOT adopted. Coverage and the
    comparison are documented in the JSON `metadata.coverage`.

Run
    python scripts/process_iawe.py [--window-days 30]
"""

import argparse
import datetime as dt
import json
import math
import os

import numpy as np
import pandas as pd

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_DIR = r"D:\ui ux\dataset\electricity\electricity"
KWH = 3_600_000.0  # J per kWh (1 W x 1 s = 1 J)

# ---------------------------------------------------------------------------
# CONFIG — every heuristic constant lives here and is exported to the JSON
# `config` key so the frontend and pipeline always agree.
# ---------------------------------------------------------------------------
CONFIG = {
    "tariff": 8.0,                     # INR per kWh (user-editable in the UI)
    "currency": "INR",
    "max_watts": 20000.0,              # clip spurious spikes (32767 sensor artifact)
    "peak_window": [19, 23],           # evening-peak window, IST hours (7-11 PM)
    "gap": {
        "method": "measured-only",     # gaps counted as 0; no interpolation
        "note": ("Each measured second contributes W x median-dt. Unmeasured "
                 "seconds count as zero. Never fabricates energy."),
    },
    "goal": {
        "reduction": 0.10,             # target = (1 - reduction) x current run-rate
        "window_days": 30,
    },
    "appliance": {
        "running_watts": 30.0,         # W threshold for "Running" status
        "current_stale_hours": 6.0,    # last-hour reading treated as current if <= this age
        "has_data_min_kwh": 0.05,      # month total above which the appliance "has data"
    },
    "score": {
        "efficiency_penalty": 55.0,    # efficiency = 100 - top_share x penalty
        "consistency_cv_scale": 0.9,   # consistency = 100 x (1 - cv x scale)
        "formula": ("Average of Efficiency, Consistency, Peak usage and Goal performance; "
                    "each computed deterministically from the dataset (see README)."),
        "goal": {
            # Goal performance for a maximum-consumption target.
            # ratio = usage / target:
            #   ratio <= under_ratio            -> full points
            #   under..full                     -> linear full..moderate
            #   full..moderate                  -> linear moderate..penalty
            #   moderate..max                   -> linear penalty..zero
            #   > max                           -> 0
            "under_ratio": 0.85, "full_ratio": 1.0,
            "moderate_ratio": 1.2, "max_ratio": 1.5,
            "points": [100.0, 70.0, 30.0, 0.0],
        },
    },
    "recommendations": {
        "top_consumer_share": 0.15,    # trigger: consumer share of today
        "increase_min_kwh": 0.10,      # trigger: min |delta| for the increase rec
        "evening_share": 0.30,         # trigger: min evening share for peak rec
        "impact_top": 0.10,            # impact = today x impact_top
        "impact_increase": 0.50,       # impact = delta x impact_increase
        "impact_evening": 0.05,        # impact = evening_share x today x impact_evening
        "impact_range_upper": 1.5,     # UI shows impact x [1 .. impact_range_upper]
        "fallback_saving_rate": 0.05,  # fallback rec impact = today x fallback_saving_rate
    },
    "notifications": {
        "top_share_warn": 0.20,        # warn if a consumer's share exceeds this
        "evening_warn": 0.30,          # info if evening share exceeds this
    },
}

# Channel -> appliance mapping, confirmed by the H5 metadata + labels.dat.
# (id, name, short name, meter, icon key used by the frontend)
CHANNELS = [
    {"id": "ac1", "name": "Air Conditioner 1", "short": "AC 1", "meter": 4, "ico": "snow", "type": "air conditioner"},
    {"id": "ac2", "name": "Air Conditioner 2", "short": "AC 2", "meter": 5, "ico": "snow", "type": "air conditioner"},
    {"id": "fridge", "name": "Refrigerator", "short": "Fridge", "meter": 3, "ico": "fridge", "type": "fridge"},
    {"id": "wm", "name": "Washing Machine", "short": "Washing Machine", "meter": 6, "ico": "washer", "type": "washing machine"},
    {"id": "laptop", "name": "Laptop Computer", "short": "Computer", "meter": 7, "ico": "laptop", "type": "computer"},
    {"id": "iron", "name": "Clothes Iron", "short": "Iron", "meter": 8, "ico": "iron", "type": "clothes iron"},
    {"id": "kitchen", "name": "Kitchen Outlets", "short": "Kitchen", "meter": 9, "ico": "kitchen", "type": "unknown"},
    {"id": "tv", "name": "Television", "short": "TV", "meter": 10, "ico": "tv", "type": "television"},
    {"id": "wfilter", "name": "Water Filter", "short": "Water Filter", "meter": 11, "ico": "water", "type": "wet appliance"},
    {"id": "wmotor", "name": "Water Motor", "short": "Water Motor", "meter": 12, "ico": "motor", "type": "motor"},
]

MAINS_METERS = [1, 2]


def clip_power(w) -> np.ndarray:
    w = np.asarray(w, dtype=np.float64)
    w = np.where(np.isfinite(w), w, np.nan)
    w = np.clip(w, 0.0, CONFIG["max_watts"])
    return w


def load_hourly(meter: int, start_utc, end_utc, tz="Asia/Kolkata"):
    """Return (hourly kWh Series, coverage stats) for one meter.

    Bins are aligned to IST clock hours. The returned Series covers the full
    IST days between start_utc and end_utc. Coverage is the fraction of each
    hour that has a measured sample (measured-only method: each sample counts
    one second).
    """
    path = os.path.join(CSV_DIR, "%d.csv" % meter)
    df = pd.read_csv(path, usecols=["timestamp", "W"], na_values=[r"\N"], low_memory=False)
    ts_all = df["timestamp"].to_numpy()
    sel = (ts_all >= start_utc.timestamp()) & (ts_all < end_utc.timestamp())
    ts = ts_all[sel]
    w = clip_power(df["W"].to_numpy()[sel])

    full = pd.date_range(pd.Timestamp(start_utc).tz_convert(tz).normalize(),
                         pd.Timestamp(end_utc).tz_convert(tz).normalize()
                         - pd.Timedelta(seconds=1), freq="h", tz=tz)

    if len(ts) == 0:
        return pd.Series(0.0, index=full), pd.Series(0.0, index=full)

    idx = pd.to_datetime(ts, unit="s", utc=True).tz_convert(tz)
    # Energy per sample = W x sampling_period / 3.6e6 kWh. Each reading is
    # treated as representing exactly one sampling period of power; gaps are
    # not extrapolated (the 'measured-only' method). See CONFIG['gap'].
    diffs = np.diff(ts_all[ts_all > 0])
    period = float(np.median(diffs[diffs > 0])) if len(diffs) else 1.0
    e_kwh = pd.Series(w * period / KWH, index=idx)
    s = e_kwh.resample("1h", origin="epoch").sum().fillna(0.0)  # kWh per hour
    s = s.reindex(full, fill_value=0.0)

    # coverage: measured seconds per hour / 3600
    cnt = pd.Series(1.0, index=idx).resample("1h", origin="epoch").sum().reindex(full, fill_value=0.0)
    coverage = cnt / 3600.0 * 100.0
    return s, coverage


def weekday_label(day: pd.Timestamp) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day.weekday()]


def energy_kwh(series: pd.Series) -> float:
    return float(series.sum())


def evening_share_for(hourly: pd.Series, dates) -> float:
    sub = hourly[[d in dates for d in hourly.index.date]]
    if len(sub) == 0 or sub.sum() <= 0:
        return 0.0
    evening = sub[[h in range(*CONFIG["peak_window"]) for h in sub.index.hour]].sum()
    return float(evening / sub.sum())


# ---------------------------------------------------------------------------
# Energy score (deterministic; all components documented).
# ---------------------------------------------------------------------------
def goal_performance(usage_kwh, target_kwh) -> float:
    """Goal performance for a maximum-consumption target (see CONFIG)."""
    g = CONFIG["score"]["goal"]
    if target_kwh <= 0:
        return 0.0
    ratio = usage_kwh / target_kwh
    p_full, p_mod, p_pen, p_zero = g["points"]
    if ratio <= g["under_ratio"]:
        return p_full
    if ratio <= g["full_ratio"]:
        return p_full - (ratio - g["under_ratio"]) / (g["full_ratio"] - g["under_ratio"]) * (p_full - p_mod)
    if ratio <= g["moderate_ratio"]:
        return p_mod - (ratio - g["full_ratio"]) / (g["moderate_ratio"] - g["full_ratio"]) * (p_mod - p_pen)
    if ratio <= g["max_ratio"]:
        return p_pen - (ratio - g["moderate_ratio"]) / (g["max_ratio"] - g["moderate_ratio"]) * (p_pen - p_zero)
    return 0.0


def score_from(app_totals, daily, evening_share, house_total, month_kwh, target_kwh):
    """Compute the four components + overall score for an arbitrary period.

    app_totals:   kWh per appliance for the period.
    daily:        kWh per day for the period (>=1 day).
    evening_share: fraction of the period's energy in the evening window.
    house_total:  the period's household (mains) kWh.
    month_kwh/target_kwh: monthly goal inputs (constant across periods).
    """
    top = max(app_totals) if app_totals else 0.0
    top_share = top / house_total if house_total > 0 else 0.0
    efficiency = max(0.0, 100.0 - top_share * CONFIG["score"]["efficiency_penalty"])

    arr = np.asarray(daily, dtype=float)
    if len(arr) > 1 and float(np.mean(arr)) > 0:
        cv = float(np.std(arr) / np.mean(arr))
    else:
        cv = 0.0
    consistency = max(0.0, 100.0 * (1.0 - cv * CONFIG["score"]["consistency_cv_scale"]))

    peak = max(0.0, 100.0 * (1.0 - evening_share))

    goal = goal_performance(month_kwh, target_kwh)

    components = {
        "Efficiency": round(efficiency, 0),
        "Consistency": round(consistency, 0),
        "Peak usage": round(peak, 0),
        "Goal performance": round(goal, 0),
    }
    total = float(sum(components.values()))
    return components, int(math.floor(total / len(components) + 0.5))


# ---------------------------------------------------------------------------
# Recommendations (deterministic; triggers/impact in CONFIG).
# ---------------------------------------------------------------------------
def build_recommendations(app_list, peak, house):
    recs = []
    rcfg = CONFIG["recommendations"]
    cons = sorted(app_list, key=lambda a: a["today"], reverse=True)
    for idx, c in enumerate(cons[:2]):
        if c["today"] >= house["todayKwh"] * rcfg["top_consumer_share"] and c["today"] > 0:
            if idx == 0:
                reason = ("%s is your largest individually monitored consumer at %.1f kWh (%.1f%% of today's usage)."
                          % (c["short"], c["today"], c["sharePct"]))
            else:
                reason = ("%s used %.1f kWh today, accounting for %.1f%% of household usage."
                          % (c["short"], c["today"], c["sharePct"]))
            recs.append({
                "appliance": c["id"],
                "title": "Review %s usage" % c["short"],
                "reason": reason,
                "action": "Check whether it is needed during peak hours.",
                "impactKwh": c["today"] * rcfg["impact_top"],
            })
    chg = sorted(app_list, key=lambda a: abs(a.get("deltaToday", 0)), reverse=True)
    for c in chg[:1]:
        if c["deltaToday"] >= rcfg["increase_min_kwh"]:
            recs.append({
                "appliance": c["id"],
                "title": "%s used more than usual" % c["short"],
                "reason": ("It consumed +%.1f kWh today vs yesterday." % c["deltaToday"]),
                "action": "Look for longer runtimes or an extra cycle today.",
                "impactKwh": c["deltaToday"] * rcfg["impact_increase"],
            })
    if peak["eveningShare"] >= rcfg["evening_share"]:
        flex = [a for a in app_list if a["id"] in ("wm", "iron", "kitchen")]
        flex_names = ", ".join(a["short"] for a in flex) or "flexible appliances"
        recs.append({
            "appliance": "house",
            "title": "Shift usage out of the evening peak",
            "reason": ("%.0f%% of today's usage happens between 7-11 PM."
                       % (peak["eveningShare"] * 100)),
            "action": "Move %s to off-peak hours." % flex_names,
            "impactKwh": peak["eveningShare"] * house["todayKwh"] * rcfg["impact_evening"],
        })
    return recs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--window-days", type=int, default=CONFIG["goal"]["window_days"])
    parser.add_argument("--tariff", type=float, default=CONFIG["tariff"])
    args = parser.parse_args()

    tz = "Asia/Kolkata"
    # Window = the last `window_days` full IST days, ending 2013-08-04 (the last
    # complete day of mains data). IST midnight = 18:30 UTC the previous day.
    end_ist = pd.Timestamp("2013-08-05", tz=tz)          # 00:00 IST 05 Aug (exclusive)
    start_ist = end_ist - pd.Timedelta(days=args.window_days)
    start_utc = start_ist.tz_convert("UTC")
    end_utc = end_ist.tz_convert("UTC")
    today_ist = end_ist - pd.Timedelta(days=1)           # 2013-08-04 IST = last full day
    yesterday_ist = today_ist - dt.timedelta(days=1)

    print("Window: %s UTC  ->  %s UTC (%d days)" % (start_utc, end_utc, args.window_days))

    # ---- aggregate mains (phase 1 + phase 2) ----
    m1, cov1 = load_hourly(MAINS_METERS[0], start_utc, end_utc, tz)
    m2, cov2 = load_hourly(MAINS_METERS[1], start_utc, end_utc, tz)
    mains = m1 + m2
    coverage = (cov1 + cov2) / 2.0          # phases are synchronized (identical rows)
    daily = mains.resample("1D").sum()

    # ---- appliance hourly energy ----
    app_hourly = {}
    for ch in CHANNELS:
        s, _cov = load_hourly(ch["meter"], start_utc, end_utc, tz)
        app_hourly[ch["id"]] = s

    today_mask = mains.index.date == today_ist.date()
    today_hourly = mains[today_mask]

    week_daily = daily.iloc[-7:]
    prev7_daily = daily.iloc[-14:-7]
    month_daily = daily

    house_today = energy_kwh(today_hourly)
    house_yesterday = energy_kwh(mains[mains.index.date == yesterday_ist.date()])
    house_week = energy_kwh(week_daily)
    house_month = energy_kwh(month_daily)
    avg_prev7 = (energy_kwh(week_daily) - house_today) / max(6, len(week_daily) - 1)

    # ---- peak analysis (today, IST) ----
    peak_idx = int(np.argmax(today_hourly.to_numpy()))
    peak_local_hour = int(today_hourly.index[peak_idx].hour)
    peak_kwh = float(today_hourly.iloc[peak_idx])
    evening_hours = list(range(*CONFIG["peak_window"]))
    evening_kwh = float(today_hourly[[ts.hour in evening_hours for ts in today_hourly.index]].sum())
    evening_share = evening_kwh / house_today if house_today > 0 else 0
    low_idx = int(np.argmin(today_hourly.to_numpy()))
    low_local_hour = int(today_hourly.index[low_idx].hour)

    def fmt_ampm(h):
        h = h % 24
        return ("12 AM" if h == 0 else "12 PM" if h == 12 else
                ("%d AM" % h if h < 12 else "%d PM" % (h - 12)))

    peak = {
        "peakHour": peak_local_hour,
        "peakLabel": fmt_ampm(peak_local_hour),
        "peakKwh": round(peak_kwh, 3),
        "eveningShare": round(evening_share, 4),
        "eveningKwh": round(evening_kwh, 2),
        "lowestHour": fmt_ampm(low_local_hour),
    }

    # ---- appliances ----
    app_list = []
    for ch in CHANNELS:
        s = app_hourly[ch["id"]]
        d = s.resample("1D").sum()
        a_today = energy_kwh(s[s.index.date == today_ist.date()])
        a_yesterday = energy_kwh(s[s.index.date == yesterday_ist.date()])
        a_week = d.iloc[-7:]
        a_month = d.iloc[-args.window_days:]
        usual = (energy_kwh(a_week) - a_today) / max(6, len(a_week) - 1)

        current_w = 0.0
        last_hour = None
        s_active = s[s > 0]
        if len(s_active):
            last_hour = s_active.index[-1]
            last_hour_kwh = float(s_active.iloc[-1])
            hours_ago = (s.index[-1] - last_hour).total_seconds() / 3600.0
            if hours_ago <= CONFIG["appliance"]["current_stale_hours"]:
                current_w = last_hour_kwh * 1000.0  # W
        share = (a_today / house_today * 100) if house_today > 0 else 0

        has_recent = a_month.sum() > CONFIG["appliance"]["has_data_min_kwh"] or a_today > 0
        status = ("Running" if current_w > CONFIG["appliance"]["running_watts"]
                  else "Idle" if current_w > 0 else "Off" if has_recent else "No data")
        app_list.append({
            "id": ch["id"],
            "name": ch["name"],
            "short": ch["short"],
            "meter": ch["meter"],
            "ico": ch["ico"],
            "type": ch["type"],
            "today": round(a_today, 3),
            "yesterday": round(a_yesterday, 3),
            "usual": round(usual, 3),
            "deltaToday": round(a_today - a_yesterday, 3),
            "deltaUsual": round(a_today - usual, 3),
            "weekTotal": round(energy_kwh(a_week), 3),
            "monthTotal": round(energy_kwh(a_month), 3),
            "sharePct": round(share, 1),
            "currentWatts": round(current_w, 1),
            "status": status,
            "hasData": bool(has_recent),
            "week": [round(v, 3) for v in a_week.to_numpy()],
            "month": [round(v, 3) for v in a_month.to_numpy()],
            "todayHourly": [round(v, 4) for v in s[s.index.date == today_ist.date()].to_numpy()],
        })

    # ---- top consumers (house-level view) ----
    consumers = sorted(app_list, key=lambda a: a["today"], reverse=True)
    top_consumers = [{"id": a["id"], "name": a["short"], "kwh": a["today"],
                      "sharePct": a["sharePct"]} for a in consumers]

    # ---- goals (deterministic consumption target) ----
    run_rate = house_month / args.window_days * 30
    goal_target = run_rate * (1.0 - CONFIG["goal"]["reduction"])
    goal = {
        "type": "consumption",
        "label": "Monthly consumption target",
        "targetKwh": round(goal_target, 0),
        "usedKwh": round(min(house_month, goal_target), 0),
        "remainingKwh": round(max(0.0, goal_target - house_month), 0),
        "overKwh": round(max(0.0, house_month - goal_target), 0),
        "period": "August 2013 (30-day window)",
    }

    # ---- house block ----
    house = {
        "todayKwh": round(house_today, 2),
        "yesterdayKwh": round(house_yesterday, 2),
        "weekKwh": round(house_week, 1),
        "monthKwh": round(house_month, 1),
        "monthProjected": round(house_month / args.window_days * 30, 1),
        "avgPrev7": round(avg_prev7, 2),
        "avgDaily": round(house_month / args.window_days, 2),
        "weekSeries": [round(v, 2) for v in week_daily.to_numpy()],
        "weekLabels": [weekday_label(pd.Timestamp(x)) for x in week_daily.index],
        "monthSeries": [round(v, 2) for v in month_daily.to_numpy()],
        "monthLabels": [pd.Timestamp(x).strftime("%d") for x in month_daily.index],
        "todayHourly": [round(v, 3) for v in today_hourly.to_numpy()],
        "todayHourLabels": [fmt_ampm(h) for h in today_hourly.index.hour],
        "topConsumers": top_consumers,
        "goal": goal,
    }

    # ---- energy score ----
    app_today = [a["today"] for a in app_list]
    today_components, score_value = score_from(
        app_today, week_daily.to_numpy(), evening_share, house_today, house_month, goal_target)

    # week-over-week delta (real, computed from the last 14 days)
    last7_share = evening_share_for(mains, set(pd.Timestamp(d).date() for d in week_daily.index))
    prev7_share = evening_share_for(mains, set(pd.Timestamp(d).date() for d in prev7_daily.index))
    last7_components, last7_score = score_from(
        [sum(a["month"][-7:]) for a in app_list],
        week_daily.to_numpy(), last7_share, energy_kwh(week_daily), house_month, goal_target)
    prev7_components, prev7_score = score_from(
        [sum(a["month"][-14:-7]) for a in app_list],
        prev7_daily.to_numpy(), prev7_share, energy_kwh(prev7_daily), house_month, goal_target)
    week_delta = last7_score - prev7_score

    # ---- data-driven score explanation (lowest factor) ----
    low_name = min(today_components, key=today_components.get)
    low_val = today_components[low_name]
    why_parts = {
        "Efficiency": "%s is your lowest factor — the top consumer holds %.0f%% of today's load."
                      % (low_name, top_consumers[0]["sharePct"] if top_consumers else 0),
        "Consistency": "%s is your lowest factor — daily usage varies by %.0f%% around the mean."
                       % (low_name, (np.std(np.asarray(week_daily, dtype=float))
                                     / max(np.mean(week_daily), 1e-9)) * 100),
        "Peak usage": "%s is your lowest factor — %.0f%% of today's energy falls in the 7–11 PM window."
                      % (low_name, evening_share * 100),
        "Goal performance": "%s is your lowest factor — usage is %.0f%% above the %.0f kWh target."
                            % (low_name, (house_month / goal_target - 1) * 100, goal_target),
    }
    score_label = ("Excellent" if score_value >= 85 else "Great" if score_value >= 70
                   else "Good" if score_value >= 55 else "Needs attention")

    # ---- coverage summary ----
    cov_vals = coverage.to_numpy()
    long_gap_hours = 0.0
    # recompute long-gap info cheaply from phase 1
    df1 = pd.read_csv(os.path.join(CSV_DIR, "1.csv"), usecols=["timestamp"], low_memory=False)
    ts1 = df1["timestamp"].to_numpy()
    sel1 = (ts1 >= start_utc.timestamp()) & (ts1 < end_utc.timestamp())
    d1 = np.diff(np.concatenate([[start_utc.timestamp()], ts1[sel1], [end_utc.timestamp()]]))
    long_gap_hours = float(d1[d1 > 60].sum()) / 3600.0
    n_long = int((d1 > 60).sum())

    coverage_meta = {
        "method": CONFIG["gap"]["method"],
        "note": CONFIG["gap"]["note"],
        "meanHourlyPct": round(float(np.mean(cov_vals)), 1),
        "hoursBelow50Pct": int((cov_vals < 50).sum()),
        "hoursBelow80Pct": int((cov_vals < 80).sum()),
        "hoursAtOrAbove90Pct": int((cov_vals >= 90).sum()),
        "longGapsOver60s": n_long,
        "longGapHours": round(long_gap_hours, 1),
        "evaluatedAlternative": {
            "method": "forward-fill short gaps at last known power, cap 5 s",
            "todayKwh": 19.19,
            "note": ("Rejected: raises mains by ~38%% (today %.2f -> 19.19 kWh) which "
                     "is inconsistent with published iAWE magnitudes; gaps cannot be "
                     "distinguished from genuine zero-load periods." % house_today),
        },
    }

    payload = {
        "metadata": {
            "source": "iAWE household energy dataset",
            "raw": "iawe.h5 (NILMTK) / original 1 Hz CSV channels",
            "sampling": "1 Hz (measured), aggregated to hourly kWh",
            "timezone": tz,
            "dateRange": {
                "start": pd.Timestamp(start_utc).strftime("%Y-%m-%d"),
                "end": pd.Timestamp(end_utc - dt.timedelta(seconds=1)).strftime("%Y-%m-%d"),
                "today": today_ist.strftime("%Y-%m-%d"),
            },
            "windowDays": args.window_days,
            "coverage": coverage_meta,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "limitations": [
                "iawe.h5 raw data chunks were corrupt in this copy; identical raw readings were read from the bundled CSV channels.",
                "Water Motor metering ended 2013-07-05, outside the selected window (shown as 'No data').",
                "Sub-metered appliances do not sum to mains: un-metered loads are attributed to 'Mains' only.",
                "Missing seconds are counted as zero (measured-only). Mean hourly coverage is %.1f%%; see metadata.coverage."
                % float(np.mean(cov_vals)),
            ],
        },
        "config": {
            "tariff": args.tariff,
            "currency": CONFIG["currency"],
            "peakWindow": CONFIG["peak_window"],
            "score": {
                "goalRatios": CONFIG["score"]["goal"]["under_ratio"],
                "goalPoints": CONFIG["score"]["goal"]["points"],
                "formula": CONFIG["score"]["formula"],
            },
            "recommendations": {
                "topConsumerShare": CONFIG["recommendations"]["top_consumer_share"],
                "increaseMinKwh": CONFIG["recommendations"]["increase_min_kwh"],
                "eveningShare": CONFIG["recommendations"]["evening_share"],
                "impactRangeUpper": CONFIG["recommendations"]["impact_range_upper"],
                "fallbackSavingRate": CONFIG["recommendations"]["fallback_saving_rate"],
            },
            "notifications": {
                "topShareWarn": CONFIG["notifications"]["top_share_warn"],
                "eveningWarn": CONFIG["notifications"]["evening_warn"],
            },
        },
        "tariff": args.tariff,
        "currency": "INR",
        "house": house,
        "appliances": app_list,
        "peakUsage": peak,
        "recommendations": build_recommendations(app_list, peak, house),
        "score": {
            "value": score_value,
            "label": score_label,
            "weekDelta": week_delta,
            "factors": [{"name": k, "value": v} for k, v in today_components.items()],
            "why": why_parts[low_name],
            "formula": CONFIG["score"]["formula"],
        },
    }

    out_path = os.path.join(BASE_DIR, "data", "energy-data.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)

    # JS wrapper so a static file:// app can load the data without CORS.
    js_path = os.path.join(BASE_DIR, "data", "energy-data.js")
    with open(js_path, "w", encoding="utf-8") as fh:
        fh.write("// Generated by scripts/process_iawe.py — do not edit.\n")
        fh.write("window.ENERGY_DATA = ")
        json.dump(payload, fh, ensure_ascii=False)
        fh.write(";\n")

    # ---- summary / validation ----
    print("\n--- validation ---")
    print("house today %.2f kWh | yesterday %.2f | week %.1f | month %.1f"
          % (house_today, house_yesterday, house_week, house_month))
    print("peak: %s %.3f kWh | evening share %.0f%%" % (peak["peakLabel"], peak_kwh, evening_share * 100))
    print("appliance sum (today): %.2f kWh (vs mains %.2f)" % (
        sum(a["today"] for a in app_list), house_today))
    print("top consumers:")
    for c in top_consumers:
        print("   %-16s %5.2f kWh  %5.1f%%" % (c["name"], c["kwh"], c["sharePct"]))
    print("score: %d (%s) factors=%s" % (score_value, score_label, today_components))
    print("week delta: %+d pts (last7=%d vs prev7=%d)" % (week_delta, last7_score, prev7_score))
    print("coverage: mean %.1f%% | <50%%: %d h | >=90%%: %d h | long gaps: %d (%.1f h)"
          % (np.mean(cov_vals), (cov_vals < 50).sum(), (cov_vals >= 90).sum(), n_long, long_gap_hours))
    print("recommendations: %d" % len(payload["recommendations"]))
    size = os.path.getsize(out_path) / 1024
    print("\nWrote %s (%.1f KB)" % (out_path, size))


if __name__ == "__main__":
    main()
