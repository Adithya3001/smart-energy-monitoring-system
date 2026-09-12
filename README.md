# Smart Energy — Monitoring & Decision Support

A UI/UX-focused energy monitoring and decision-support SPA (plain HTML/CSS/JS — no build step). It reads **real** electricity data from the [iAWE household energy dataset](https://iawe.github.io/) and turns raw meter readings into usage, cost, patterns, insights and recommendations.

The frontend is **fully data-driven**: a single processed dataset (`data/energy-data.js` / `.json`) is the only source of truth. Nothing is hard-coded or fabricated in the UI.

---

## What it shows

- **Home** — today's usage & cost vs yesterday, 24 h / 7 day / 30 day charts, peak-usage window, a "what changed" breakdown, a data-driven insight and a top recommendation.
- **My appliances** — per-appliance cards, today/yesterday comparison, live status, and a breakdown of today's consumption.
- **Insights** — monthly projection, usage, hourly & weekday patterns, recommendations, and an energy-score with an editable monthly consumption target.
- **Profile** — tariff (₹/kWh, editable), theme, privacy / download / delete / about, onboarding replay.

---

## Data pipeline

```
iawe.h5 + electricity CSVs  (1 Hz, sub-metered, May–Sep 2013)
        │
        ▼
scripts/process_iawe.py     (Python 3.11 · numpy · pandas)
        │
        ▼
data/energy-data.json       (17.5 KB, canonical)
data/energy-data.js         (sets window.ENERGY_DATA, for static file:// loading)
        │
        ▼
index.html  →  data/energy-data.js  →  app.js (renders everything from DATA)
```

### Pipeline steps

1. Load 1 Hz `W` readings for the mains (2 channels) and 10 sub-metered appliances from the bundled CSV channels (the H5 data chunks are corrupt; see below).
2. Clip to `0–20000 W`, resample to IST-hour averages, and integrate energy with `W × period / 3.6e6` (one-sample-period method so appliance totals never exceed mains). **Gap policy: measured-only.** Samples are binned only when a reading exists; mains coverage is ~67% of seconds (0 hours ≥ 90%) and is recorded in `metadata.coverage`. A forward-fill (≤ 5 s) alternative was evaluated but rejected — it raised today's mains total to ~19 kWh, inconsistent with iAWE magnitudes — and is documented in JSON as `evaluatedAlternative`.
3. Compute per-appliance and house stats for a **30-day window ending 2013-08-04** (IST), the last full day of mains data: today / yesterday / week / month, hourly profiles, top consumers, peak window, weekday/weekend averages.
4. Generate notifications, recommendations and a deterministic 0–100 energy score.
5. Export compact JSON + a JS wrapper.

### Tuning constants (`CONFIG`)

Every heuristic lives in one place — the `CONFIG` dict at the top of `scripts/process_iawe.py` — and is exported as the JSON `config` key, which the frontend reads as `CONFIG` (single source of truth). Key entries:

| Constant | Default | Meaning |
|----------|---------|---------|
| `tariff` | 8.0 | ₹/kWh used for all cost estimates |
| `max_watts` | 20000 | clipping ceiling for W readings |
| `peak_window` | [19, 23] | evening/peak hours (19–23 IST) |
| `goal.reduction` | 0.10 | default monthly target = 10% below rolling month average → 294 kWh |
| score.* | — | efficiency penalty 55, consistency CV scale 0.9, goal bands 100/70/30/0 |
| recommendations.* | — | thresholds for top-consumer / increase / evening-share impacts |
| notifications.* | — | warning thresholds for consumers and evening share |

### Energy score (deterministic)

```
Efficiency      = 100 − 55 × (share of day from the #1 consumer)        ≥ 0
Consistency     = 100 × (1 − 0.9 × CV of last 7 daily totals)           ≥ 0
Peak usage      = 100 × (1 − share of usage in peak window [19–23h])
Goal performance= bands on month÷target: ≤0.85→100 · 0.85–1.0→100..70 ·
                  1.0–1.2→70..30 · 1.2–1.5→30..0 · >1.5→0
Score           = round-half-up(mean of the four factors)
```

Current dataset yields **69 "Good"**, `weekDelta = −3` (last 7 days vs previous 7). Results are exported once and rendered verbatim; `app.js` never recomputes a score.

### Channels (from H5 metadata + `labels.dat`)

| # | Channel | | # | Channel |
|---|---------|-|---|---------|
| 1 | Mains phase 1 | | 7 | Laptop computer |
| 2 | Mains phase 2 | | 8 | Clothes iron |
| 3 | Fridge | | 9 | Kitchen outlets |
| 4 | AC 1 | | 10 | Television |
| 5 | AC 2 | | 11 | Water filter |
| 6 | Washing machine | | 12 | Water motor |

Sub-metered appliances do **not** sum to mains — un-metered loads exist — so each sample represents one sampling period.

---

## Usage

Open `index.html` in a browser. No server required (the `data/energy-data.js` wrapper avoids `file://` CORS).

### Regenerate the dataset

```bash
cd scripts
python process_iawe.py          # reads ../dataset CSVs (or edit paths), writes ../data/energy-data.{json,js}
python inspect_iawe.py          # optional: print H5 structure / channel stats
```

Paths, the time window, tariff, goal target, and all recommendation/score/notification heuristics are configured in the `CONFIG` dict at the top of `scripts/process_iawe.py` and exported to the JSON `config` key (single source of truth for the frontend as well).

---

## Known limitations

- **`iawe.h5` data chunks are unreadable** (`OSError: can't synchronously read data`). Metadata, shapes and dtypes are intact, but the readings were sourced from the identical bundled per-channel CSVs instead. Recorded in the JSON metadata.
- **Missing samples are dropped, not interpolated** (measured-only gap policy). Mains coverage is ~67% of seconds (0 hours ≥ 90%); daily totals are therefore conservative and the exact figure is exported in `metadata.coverage`. Interpolating short gaps would raise today's total ~40%, which diverges from published iAWE magnitudes.
- Appliance "status" derives from the last measured hour (≤ 6 h stale; > 30 W running, > 0 W idle, else off).
- Recommendations are heuristic rules (top consumer, evening-share, weekday/weekend patterns), not professional energy audits.
- Costs are estimates at the configured tariff (default ₹8/kWh).

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Structure, SVG sprite, onboarding |
| `styles.css` | Design tokens, light/dark themes, responsive layout |
| `app.js` | Rendering, navigation, charts, modals — all reads from `window.ENERGY_DATA` |
| `data/energy-data.json` | Canonical processed dataset |
| `data/energy-data.js` | `window.ENERGY_DATA` wrapper for static loading |
| `scripts/process_iawe.py` | Full processing pipeline |
| `scripts/inspect_iawe.py` | Dataset inspection (read-only) |
