/* ============================================================
   Smart Energy Monitoring & Decision Support — Web app
   SPA · iAWE dataset prototype · consistent calculations
   ============================================================ */

/* ---------- State ---------- */
let addedAppliances = [];             // user-added appliance ids
let removedAppliances = new Set();/* ---------- SVG icon helper ---------- */
const ICONS = {
  home: 'home', plug: 'plug', bulb: 'bulb', user: 'user', bell: 'bell',
  plus: 'plus', close: 'close', menu: 'menu', back: 'arrow-left', dots: 'dots',
  down: 'chevron-down', bolt: 'bolt', moon: 'moon', sun: 'sun', wifi: 'wifi-off',
  shield: 'shield', download: 'download', trash: 'trash', info: 'info', file: 'file',
  tag: 'tag', target: 'target', clock: 'clock', leaf: 'leaf', check: 'check',
  alert: 'alert', snow: 'snow', fridge: 'fridge', fan: 'fan', tv: 'tv',
  washer: 'washer', trend: 'trend',
  ac: 'ac', laptop: 'laptop', iron: 'iron', kitchen: 'kitchen', water: 'water', motor: 'motor'
};

/* Icon per appliance id — keeps every device on a real symbol so no empty
   "icon" containers can render. Derived from the dataset appliance ids. */
const APPLIANCE_ICONS = {
  ac1: 'ac', ac2: 'ac', fridge: 'fridge', wm: 'washer', laptop: 'laptop',
  iron: 'iron', kitchen: 'kitchen', tv: 'tv', wfilter: 'water', wmotor: 'motor'
};
function icon(name, size) {
  return `<svg width="${size || 20}" height="${size || 20}" aria-hidden="true"><use href="#i-${ICONS[name] || name}"/></svg>`;
}
function injectIcons(scope = document) {
  scope.querySelectorAll('[data-ico]').forEach(el => {
    if (el.querySelector('svg')) return;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.ico, el.dataset.size || 20));
    if (el.closest('button, a')) return;
    el.setAttribute('aria-hidden', 'true');
  });
}

/* ============================================================
   Data layer — SINGLE SOURCE OF TRUTH
   ============================================================
   window.ENERGY_DATA is defined by data/energy-data.js, which is generated
   from the iAWE dataset by scripts/process_iawe.py. Every kWh, ₹ figure,
   percentage, chart series and recommendation below is derived from that
   object — nothing is hard-coded. If it is missing the app shows a friendly
   error state instead of fabricating numbers.
   ============================================================ */
const DATA = window.ENERGY_DATA || null;

let tariff = Number(localStorage.getItem('se-tariff') || (DATA ? DATA.tariff : 8));
let theme = localStorage.getItem('se-theme') || 'dark';

const APP_COLORS = ['#0fb981', '#4f7cff', '#f5b83d', '#e5484d', '#9a6cf0', '#38bdf8', '#fb7185', '#34d399', '#a3a3a3', '#f59e0b'];

/* ---------- Centralized heuristic constants (single source, from pipeline) ---------- */
const CONFIG = (DATA && DATA.config) ? DATA.config : {
  tariff: 8, currency: 'INR', peakWindow: [19, 23],
  score: { goalRatios: 0.85, goalPoints: [100, 70, 30, 0], formula: '' },
  recommendations: { topConsumerShare: 0.15, increaseMinKwh: 0.1, eveningShare: 0.3, impactRangeUpper: 1.5, fallbackSavingRate: 0.05 },
  notifications: { topShareWarn: 0.2, eveningWarn: 0.3 }
};

/* ============================================================
   Electricity tariff engine — state-based, slab-based billing
   ============================================================
   Expected bills are always computed through calculateBill(kwh, profile)
   using the selected state's real tariff structure. No bill is ever
   computed as `consumption × flatRate`. Consumption figures remain
   exclusively from ENERGY_DATA; only monetary (tariff-dependent) values
   change when the user switches state.

   Slab rates are the officially published FY 2025–26 domestic (LT)
   structures for each DISCOM and are clearly flagged as estimates that
   may differ from an issued bill.
   ============================================================ */

const TARIFF_PROFILES = {
  tn: {
    id: 'tn', state: 'Tamil Nadu', provider: 'TANGEDCO / TNPDCL',
    cycle: 'bi-monthly', billingDays: 60, cycleLabel: 'Bi-monthly',
    description: 'TNERC LT-I(A) domestic with Government of Tamil Nadu free-unit subsidy. 200 free units per 60-day cycle under 500 units, 100 free units above 500 (telescopic).',
    source: 'TNERC Tariff Order, FY 2025–26 (effective 01 Jul 2025)',
    freeLe500: 200, freeGt500: 100,
    le500Segs: [[200, 4.95], [100, 6.65]],
    gt500Segs: [[300, 4.95], [100, 6.65], [100, 8.80], [200, 9.95], [200, 11.05], [Infinity, 12.15]],
    fixed: 0, dutyPct: 0
  },
  kl: {
    id: 'kl', state: 'Kerala', provider: 'KSEB',
    cycle: 'monthly', billingDays: 30, cycleLabel: 'Monthly',
    description: 'KSERC LT-I domestic (single phase). Telescopic slabs up to 250 units/month; above 250 units a single non-telescopic rate applies to the whole bill.',
    source: 'KSERC tariff order, w.e.f. 01 Apr 2025',
    telescopeBands: [[50, 3.35], [50, 4.25], [50, 5.35], [50, 7.20], [Infinity, 8.50]],
    nonTelTiers: [[300, 6.75], [350, 7.60], [400, 7.95], [500, 8.25], [Infinity, 9.20]],
    fixedTel: [[50, 50], [50, 85], [50, 105], [50, 140], [Infinity, 160]],
    fixedNonTel: [[300, 220], [350, 240], [400, 260], [500, 285], [Infinity, 310]],
    nonTelBreak: 250, dutyPct: 10, fuelPerKwh: 0.07
  },
  ka: {
    id: 'ka', state: 'Karnataka', provider: 'BESCOM',
    cycle: 'monthly', billingDays: 30, cycleLabel: 'Monthly',
    description: 'KERC LT-1 domestic, FY 2025-26. KERC abolished the domestic slabs: a single flat energy rate applies to all units plus a fixed charge per kW of sanctioned load (assumed 2 kW). Excludes temporary surcharges.',
    source: 'KERC Combined Tariff Order 2025 / BESCOM',
    rate: 5.80, fixedPerKw: 145, loadKw: 2, fixed: 290, dutyPct: 6
  },
  mh: {
    id: 'mh', state: 'Maharashtra', provider: 'MSEDCL',
    cycle: 'monthly', billingDays: 30, cycleLabel: 'Monthly',
    description: 'MERC MYT Order LT-I(B) residential, single phase, FY 2025-26. Combined per-unit rates (energy + Fuel Adjustment charges) with slab-wise fixed connection charge.',
    source: 'MERC MYT Order, Case 217 of 2024 (FY 2025-26)',
    bands: [[100, 5.67], [200, 10.88], [200, 14.07], [Infinity, 15.57]],
    fixed: 130, dutyPct: 16
  },
  custom: {
    id: 'custom', state: 'Custom', provider: 'Flat rate',
    cycle: 'monthly', billingDays: 30, cycleLabel: 'Monthly',
    description: 'A single user-chosen rate per kWh. Useful for comparing, but no DISCOM uses a flat domestic rate.',
    source: 'User configured',
    rate: 8, fixed: 0, dutyPct: 0, flat: true
  }
};
TARIFF_PROFILES.custom.rate = tariff;

const DEFAULT_STATE = 'tn';
let selectedState = localStorage.getItem('se-state') && TARIFF_PROFILES[localStorage.getItem('se-state')]
  ? localStorage.getItem('se-state') : DEFAULT_STATE;

const datasetDays = DATA && DATA.metadata && DATA.metadata.dateRange
  ? Number(DATA.metadata.dateRange.windowDays) || 30 : 30;
const avgDailyKwh = DATA && DATA.house.monthKwh > 0
  ? DATA.house.monthKwh / datasetDays
  : (DATA ? DATA.house.avgDaily : 0);

/* Progressive slab calculator: the first `freeLeading` kWh are free, then each
   band [width, rate] prices the next `width` kWh (Infinity = to the end). */
function slider(kwh, freeLeading, segs) {
  let energy = 0;
  let remaining = Math.max(0, kwh - freeLeading);
  for (const [w, rate] of segs) {
    if (remaining <= 0) break;
    const take = w === Infinity ? remaining : Math.min(remaining, w);
    energy += take * rate;
    remaining -= take;
  }
  return energy;
}

/* Consumes kWh inside progressive bands [width, rate] starting from zero. */
function progressive(kwh, bands) {
  let remaining = kwh, energy = 0;
  for (const [w, rate] of bands) {
    if (remaining <= 0) break;
    const take = w === Infinity ? remaining : Math.min(remaining, w);
    energy += take * rate;
    remaining -= take;
  }
  return energy;
}

/* The tariff engine. Returns a bill breakdown object. `kwh` must already be
   the projected consumption for the billing period being estimated. */
function calculateBill(kwh, prof) {
  const p = prof || TARIFF_PROFILES[selectedState];
  const r = { energy: 0, fixed: p.fixed || 0, fuel: 0, duty: 0, total: 0 };
  if (p.id === 'tn') {
    const sc = kwh > 500;
    r.energy = slider(kwh, sc ? p.freeGt500 : p.freeLe500, sc ? p.gt500Segs : p.le500Segs);
    r.fixed = 0;
  } else if (p.id === 'kl') {
    const nt = kwh > p.nonTelBreak;
    if (nt) {
      const tier = p.nonTelTiers.find(([max]) => kwh <= max);
      r.energy = kwh * tier[1];
      r.fixed = p.fixedNonTel.find(([max]) => kwh <= max)[1];
    } else {
      r.energy = progressive(kwh, p.telescopeBands);
      r.fixed = p.fixedTel.find(([max]) => kwh <= max)[1] || 0;
    }
    r.fuel = kwh * (p.fuelPerKwh || 0);
  } else if (p.id === 'ka') {
    r.energy = kwh * p.rate;
    r.fixed = p.fixedPerKw * p.loadKw;
  } else if (p.id === 'mh') {
    r.energy = progressive(kwh, p.bands);
    r.fixed = p.fixed;
  } else {
    r.energy = kwh * p.rate;
    r.fixed = p.fixed || 0;
  }
  r.duty = ((r.energy + r.fixed + r.fuel) * (p.dutyPct || 0)) / 100;
  r.total = r.energy + r.fixed + r.fuel + r.duty;
  return r;
}

/* Forecast functions (all usage projections derive from the dataset's observed
   average daily consumption, never from hard-coded totals). */
function estimateMonthlyUsage() { return avgDailyKwh * 30; }
function estimateBillingCycleUsage(p) {
  p = p || TARIFF_PROFILES[selectedState];
  return avgDailyKwh * p.billingDays;
}
function monthlyEstimateBill(p) { p = p || TARIFF_PROFILES[selectedState]; return calculateBill(avgDailyKwh * 30, p); }
function billingCycleBill(p) { p = p || TARIFF_PROFILES[selectedState]; return calculateBill(avgDailyKwh * p.billingDays, p); }
function monthlyEquivalent(p) {
  p = p || TARIFF_PROFILES[selectedState];
  const cyc = billingCycleBill(p);
  return cyc.total / (p.billingDays / 30);
}

/* Average effective rate used for short-term "estimated daily/monthly cost"
   labels. Derived from the selected state's tariff engine — changes with the
   selected state, never hard-coded. */
function effRate() {
  const p = TARIFF_PROFILES[selectedState];
  if (p.flat) return tariff;
  const mb = monthlyEstimateBill(p);
  return monthUsed > 0 ? mb.total / monthUsed : 0;
}

/* ---------- House-level derived metrics ---------- */
const todayKwh = DATA ? DATA.house.todayKwh : 0;
const yesterdayKwh = DATA ? DATA.house.yesterdayKwh : 0;
const todayDeltaKwh = +(todayKwh - yesterdayKwh).toFixed(1);
const todayDeltaPct = yesterdayKwh > 0 ? Math.round(todayDeltaKwh / yesterdayKwh * 100) : 0;

const weekKwh = DATA ? DATA.house.weekKwh : 0;
const monthUsed = DATA ? DATA.house.monthKwh : 0;
const monthProjected = DATA ? DATA.house.monthProjected : 0;

const monthSeries = DATA ? DATA.house.monthSeries : [];
const lastWeekKwh = monthSeries.length > 14
  ? +monthSeries.slice(-14, -7).reduce((a, b) => a + b, 0).toFixed(1) : weekKwh;
const weekPct = lastWeekKwh > 0 ? Math.round((weekKwh - lastWeekKwh) / lastWeekKwh * 100) : 0;

const hourly = DATA ? DATA.house.todayHourly : [];            // today, kWh per hour
const peakHourIndex = DATA ? DATA.peakUsage.peakHour : 20;    // local hour
const weekSeries = DATA ? DATA.house.weekSeries : [];
const weekLabels = DATA ? DATA.house.weekLabels : [];
const monthLabels = DATA ? DATA.house.monthLabels : [];
const weekdayAvg = weekSeries.length >= 7 ? +(weekSeries.slice(0, 5).reduce((a, b) => a + b, 0) / 5).toFixed(2) : 0;
const weekendAvg = weekSeries.length >= 7 ? +(weekSeries.slice(5, 7).reduce((a, b) => a + b, 0) / 2).toFixed(2) : 0;

const GOAL = DATA ? (() => {
  const g = Object.assign({}, DATA.house.goal);
  const stored = parseFloat(localStorage.getItem('se-goal-target'));
  if (stored > 0) g.targetKwh = stored;
  if (g.targetKwh > 0) {
    g.usedKwh = DATA.house.monthKwh;
    g.overKwh = Math.max(0, +(g.usedKwh - g.targetKwh).toFixed(1));
    g.remainingKwh = Math.max(0, +(g.targetKwh - g.usedKwh).toFixed(1));
  }
  return g;
})() : { targetKwh: 0, usedKwh: 0, overKwh: 0, remainingKwh: 0, label: '' };

/* ---------- Score (deterministic, computed in Python) ---------- */
const scoreHow = [
  ['Efficiency', 'How evenly load is spread across appliances — a single dominant consumer lowers it.'],
  ['Consistency', 'How steady your daily usage is — sudden spikes lower this score.'],
  ['Peak usage', 'How much usage falls in the expensive 7–11 PM window.'],
  ['Goal performance', 'Performance against the 30-day consumption target — under target scores high, over target scores low.']
];

/* Data-driven takeaway for the score card — built from the lowest-scoring
   factors, never from hard-coded values. */
const SCORE_ADVICE = {
  'Efficiency': 'balancing load across appliances',
  'Consistency': 'steadying your daily usage',
  'Peak usage': 'reducing evening peak consumption',
  'Goal performance': 'staying closer to your energy target'
};
function scoreAdvice() {
  if (!score.factors.length) return score.why || '';
  const worst = [...score.factors].sort((a, b) => a[1] - b[1]).slice(0, 2);
  const parts = worst.map(([name]) => SCORE_ADVICE[name]).filter(Boolean);
  if (!parts.length) return score.why || '';
  return 'Your biggest opportunity is ' + parts.join(' and ') + '.';
}

const recentAvg = (DATA ? DATA.house.avgPrev7 : 0);

const score = DATA ? {
  value: DATA.score.value,
  label: DATA.score.label,
  weekDelta: DATA.score.weekDelta,
  factors: DATA.score.factors.map(f => [f.name, f.value]),
  why: DATA.score.why
} : { value: 0, label: '—', weekDelta: 0, factors: [], why: '' };

/* Matching the pipeline's assumption: an illustrative 10% usage reduction. */
const ILLUSTRATIVE_REDUCTION = 0.1;

/* ---------- Appliances ---------- */
function applianceRecommendation(id, a) {
  const rec = (DATA ? DATA.recommendations : []).find(r => r.appliance === id);
  return {
    ico: a.ico,
    title: rec ? rec.title : `${a.short} — keep an eye on runtime`,
    problem: recProblem(a),
    insight: rec ? rec.action : 'Review when it runs and whether it is essential during peak hours.',
    impact: recImpact(a),
    difficulty: 'medium'
  };
}

function buildAppliances() {
  if (!DATA) return [];
  return DATA.appliances.map((a, i) => {
    const lastHr = (a.todayHourly || []).reduce((acc, v, idx) => v > 0 ? idx : acc, -1);
    const avgPower = a.monthTotal > 0 ? a.monthTotal / 30 / 24 * 1000 : 0;
    const usualNote = a.today >= a.usual
      ? `${a.short} is running more than your recent average today.`
      : `${a.short} is below its recent average today.`;
    return {
      id: a.id, name: a.name, short: a.short, ico: APPLIANCE_ICONS[a.id] || a.ico, status: a.status,
      watts: a.currentWatts, today: a.today, yesterday: a.yesterday, usual: a.usual,
      deltaToday: +(a.today - a.yesterday).toFixed(3),
      deltaUsual: a.deltaUsual != null ? a.deltaUsual : +(a.today - a.usual).toFixed(3),
      sharePct: a.sharePct,
      color: APP_COLORS[i % APP_COLORS.length],
      week: a.week, month: a.month, hours: a.todayHourly,
      avgPower,
      hasData: a.hasData,
      usualNote,
      whyReason: a.deltaUsual > 0
        ? `${a.short} used ${a.deltaUsual.toFixed(2)} kWh more today than its recent average.`
        : a.deltaUsual < 0
          ? `${a.short} used ${(-a.deltaUsual).toFixed(2)} kWh less today than its recent average.`
          : `${a.short} usage today is about its recent average.`,
      tech: [
        ['Most recent power', a.currentWatts > 0 ? `${(a.currentWatts / 1000).toFixed(2)} kW` : '—'],
        ['Energy today', `${a.today.toFixed(2)} kWh`],
        ['Last 7 days', `${a.weekTotal} kWh`],
        ['Last 30 days', `${a.monthTotal} kWh`],
        ['Share of home', `${a.sharePct}%`],
        ['Last activity', lastHr >= 0 ? `${hourLabel(lastHr)}` : 'No data']
      ]
    };
  });
}
const appliances = buildAppliances();
appliances.forEach(a => { a.recommendation = applianceRecommendation(a.id, a); });

/* ---------- Notifications (data-driven) ---------- */
function buildNotifications() {
  if (!DATA) return [];
  const list = [];
  const ncfg = CONFIG.notifications;
  const top = DATA.house.topConsumers[0];
  if (top && top.sharePct >= ncfg.topShareWarn * 100) {
    list.push({ ico: 'alert', type: 'warn', title: 'Large consumer', msg: `${top.name} is ${top.sharePct}% of today's usage (${top.kwh.toFixed(1)} kWh).`, time: 'today' });
  }
  if (DATA.peakUsage.eveningShare >= ncfg.eveningWarn) {
    list.push({ ico: 'trend', type: 'info', title: 'Evening peak', msg: `${Math.round(DATA.peakUsage.eveningShare * 100)}% of today's usage falls in the 7–11 PM window.`, time: 'today' });
  }
  if (GOAL.targetKwh > 0) {
    const over = GOAL.overKwh > 0;
    list.push({ ico: over ? 'alert' : 'check', type: over ? 'warn' : 'good', title: '30-day goal', msg: over
      ? `Usage is ${GOAL.overKwh.toFixed(1)} kWh above your ${GOAL.targetKwh} kWh target.`
      : `You're on track — ${(GOAL.targetKwh - GOAL.usedKwh).toFixed(1)} kWh under target so far.`, time: '30-day window' });
  }
  if (DATA.house.avgPrev7 > 0) {
    const dPct = Math.round((DATA.house.todayKwh - DATA.house.avgPrev7) / DATA.house.avgPrev7 * 100);
    if (dPct < 0) {
      list.push({ ico: 'check', type: 'good', title: 'Great job!', msg: `Today's usage is ${-dPct}% below your recent average (${DATA.house.avgPrev7.toFixed(1)} kWh/day).`, time: 'recent' });
    } else if (dPct > 0) {
      list.push({ ico: 'alert', type: 'warn', title: 'Higher than usual', msg: `Today's energy usage is ${dPct}% higher than your recent average (${DATA.house.todayKwh.toFixed(1)} vs ${DATA.house.avgPrev7.toFixed(1)} kWh).`, time: 'today' });
    } else {
      list.push({ ico: 'clock', type: 'info', title: 'About average', msg: `Today's usage is on par with your recent average (${DATA.house.todayKwh.toFixed(1)} kWh).`, time: 'today' });
    }
  }
  return list;
}
const notifications = buildNotifications();

function liveAppliances() {
  return appliances.filter(a => !removedAppliances.has(a.id) && a.hasData);
}

function getConsumers() {
  const list = liveAppliances().map(a => {
    const pct = +(a.today / todayKwh * 100).toFixed(1);
    return { id: a.id, name: a.short, ico: a.ico, pct, kwh: a.today, cost: a.today * effRate(), color: a.color };
  });
  list.sort((x, y) => y.kwh - x.kwh);
  const usedPct = list.reduce((s, x) => s + x.pct, 0);
  if (usedPct < 100) {
    list.push({
      id: 'mains', name: 'Mains / un-metered', ico: 'bolt',
      pct: +(100 - usedPct).toFixed(1),
      kwh: +(todayKwh - list.reduce((s, x) => s + x.kwh, 0)).toFixed(2),
      cost: +(todayKwh - list.reduce((s, x) => s + x.kwh, 0)).toFixed(2) * effRate(),
      color: '#3a4a74', mains: true
    });
  }
  return list;
}

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = kwh => '₹' + (kwh * effRate()).toFixed(kwh >= 10 ? 0 : 2);
const fmtMoney = amt => '₹' + (amt >= 1000 ? Math.round(amt).toLocaleString('en-IN') : (amt >= 100 ? amt.toFixed(0) : amt.toFixed(2)));
const fmtDelta = (cur, prev) => (cur - prev) >= 0 ? `+${(cur - prev).toFixed(2)} kWh` : `${(cur - prev).toFixed(2)} kWh`;
const scaleSum = (arr, target) => {
  const sum = arr.reduce((a, b) => a + b, 0) || 1;
  return arr.map(v => v * target / sum);
};

/* Dynamic energy formatting so small non-zero values are never shown as "0.0":
   >= 1 kWh: 1 decimal · 0.1–0.99: 2 decimals · < 0.1: up to 3 decimals. */
function fmtKwh(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '0';
  const s = n >= 1 ? n.toFixed(1) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3);
  return s.replace(/\.?0+$/, '');
}

/* Dataset day label derived from ENERGY_DATA (e.g. "Dataset day · Aug 4, 2013"). */
function datasetDayLabel() {
  if (!DATA || !DATA.metadata || !DATA.metadata.dateRange) return '';
  const d = DATA.metadata.dateRange.today || '';
  const p = d.split('-');
  if (p.length !== 3) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Dataset day · ${months[+p[1] - 1]} ${+p[2]}, ${p[0]}`;
}

function rankedLive() { return [...liveAppliances()].sort((x, y) => y.today - x.today); }
function isLargestLive(a) {
  const r = rankedLive();
  return r.length > 0 && r[0].id === a.id;
}

/* Recommendation copy is derived from ENERGY_DATA values at runtime so a
   single appliance is never incorrectly labelled the largest consumer. */
function recProblem(a) {
  const share = a.sharePct;
  if (isLargestLive(a) && rankedLive().length > 1) {
    return `${a.short} is your largest individually monitored consumer at ${fmtKwh(a.today)} kWh (${share}% of today's usage).`;
  }
  return `${a.short} used ${fmtKwh(a.today)} kWh today, accounting for ${share}% of household usage.`;
}
function recImpact(a) {
  const saving = a.today * 30 * ILLUSTRATIVE_REDUCTION * effRate();
  const txt = saving >= 100 ? Math.round(saving).toLocaleString('en-IN') : saving.toFixed(2);
  return `Illustrative saving if usage is reduced by 10% every day for a month: ~₹${txt}/month`;
}
function recommendationList() {
  return rankedLive()
    .filter(a => a.today >= 0.05)
    .map((a, i) => ({ a, r: a.recommendation, diff: +(a.today - a.usual).toFixed(2), rank: i }));
}
function priorityTier(rank) { return rank === 0 ? 'High impact' : rank < 3 ? 'Medium impact' : 'Low impact'; }

/* ---------- Charts ---------- */
function hourLabel(i) {
  if (i === 0) return '12 AM';
  if (i === 12) return '12 PM';
  return i < 12 ? `${i} AM` : `${i - 12} PM`;
}

function lineChart(el, data, { peakIndex = -1, unit = 'kWh', labels = null } = {}) {
  const W = 800, H = 180, PAD = 8;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const x = i => PAD + i * (W - PAD * 2) / (data.length - 1);
  const y = v => H - PAD - (v - min) / range * (H - PAD * 2);
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `${PAD},${H - PAD} ${pts} ${W - PAD},${H - PAD}`;

  const peak = peakIndex >= 0 ? data[peakIndex] : max;
  const peakI = peakIndex >= 0 ? peakIndex : data.indexOf(max);
  const gradId = 'grad-' + (el.id || Math.random().toString(36).slice(2));

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Chart of energy usage, peaking at ${peak.toFixed(2)} ${unit}">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity=".35"/>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="${area}" fill="url(#${gradId})"/>
      <polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="3"
                stroke-linecap="round" stroke-linejoin="round"/>
      ${data.map((v, i) => `
        <circle cx="${x(i)}" cy="${y(v)}" r="${i === peakI ? 5 : 3}"
                fill="${i === peakI ? 'var(--amber)' : 'var(--surface)'}"
                stroke="${i === peakI ? 'var(--amber)' : 'var(--brand)'}" stroke-width="2"
                tabindex="0" role="img" aria-label="${labels ? labels[i] + ' — ' : ''}${v.toFixed(2)} ${unit}"
                data-i="${i}">
          <title>${labels ? labels[i] + ' · ' : ''}${v.toFixed(2)} ${unit}</title>
        </circle>`).join('')}
      <circle cx="${x(peakI)}" cy="${y(peak)}" r="14" fill="none" stroke="var(--amber)"
              stroke-width="1.5" stroke-dasharray="4 4" opacity=".7"/>
    </svg>`;

  // interactive tooltip (desktop hover + keyboard, mobile tap)
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.setAttribute('role', 'tooltip');
  el.appendChild(tip);

  const show = (i) => {
    const v = data[i];
    const t = labels ? labels[i] : `#${i + 1}`;
    tip.innerHTML = `<b>${t}</b><span>${v.toFixed(2)} kWh</span><span>${money(v)}</span>`;
    tip.style.display = 'block';
    const rect = el.getBoundingClientRect();
    const c = el.querySelector(`circle[data-i="${i}"]`);
    if (c) {
      const cRect = c.getBoundingClientRect();
      const cx = cRect.left - rect.left + cRect.width / 2;
      const cy = cRect.top - rect.top;
      tip.style.left = Math.min(Math.max(6, cx - tip.offsetWidth / 2), rect.width - tip.offsetWidth - 6) + 'px';
      tip.style.top = (cy - tip.offsetHeight - 10) + 'px';
    }
  };
  const hide = () => { tip.style.display = 'none'; };

  el.querySelectorAll('circle[data-i]').forEach(c => {
    c.addEventListener('mouseenter', e => show(+c.dataset.i, e));
    c.addEventListener('mouseleave', hide);
    c.addEventListener('focus', () => show(+c.dataset.i));
    c.addEventListener('blur', hide);
    c.addEventListener('touchstart', e => show(+c.dataset.i, e), { passive: true });
    c.addEventListener('click', e => show(+c.dataset.i, e));
  });
  el.addEventListener('mouseleave', hide);

  return { peak: peak.toFixed(1), peakIndex: peakI };
}

function barChart(el, data, { unit = 'kWh', today = -1, highlight = [] } = {}) {
  const max = Math.max(...data);
  el.classList.add('bar-chart');
  el.innerHTML = data.map((v, i) => `
    <div class="bar${i === today ? ' is-today' : ''}${highlight.includes(i) ? ' highlight' : ''}"
         style="height:${Math.max(v / max * 100, 6)}%"
         role="img" aria-label="Value ${v.toFixed(1)} ${unit}">
      <span class="bar-value">${v.toFixed(1)}</span>
    </div>`).join('');
}

/* ---------- Home ---------- */
let homeRange = 'today';

function renderHome() {
  $('#greeting').textContent = greeting();
  const ctx = $('#hero-ctx');
  if (ctx && !ctx.textContent) ctx.textContent = datasetDayLabel();
  $('#hero-kwh').innerHTML = `${fmtKwh(todayKwh)}<span class="hero-unit">kWh</span>`;
  $('#today-vs-yday').textContent = todayDeltaPct > 0
    ? `▲ ${todayDeltaPct}% more than yesterday`
    : todayDeltaPct < 0 ? `▼ ${-todayDeltaPct}% less than yesterday`
    : 'Same as yesterday';
  $('#hero-explain').textContent = todayDeltaPct > 0
    ? "You're using slightly more energy than yesterday — let's find out why."
    : "You're using less energy than yesterday. Nice work.";
  $('#today-cost').textContent = money(todayKwh);
  const cn = $('#cost-note');
  if (cn) cn.textContent = `Estimated at your ${stateProfile().state} tariff (avg ${fmtMoney(effRate())}/kWh)`;
  $('#hero-yesterday').textContent = fmtKwh(yesterdayKwh) + ' kWh';
  const goalOver = GOAL.overKwh > 0;
  const goalPct = GOAL.targetKwh > 0 ? Math.min(100, GOAL.usedKwh / GOAL.targetKwh * 100) : 0;
  $('#goal-mini-num').textContent = `${fmtKwh(GOAL.usedKwh)} / ${fmtKwh(GOAL.targetKwh)} kWh`;
  $('#goal-mini-num').classList.toggle('over', goalOver);
  $('#goal-mini-bar').style.width = goalPct + '%';
  $('#goal-mini-bar').parentElement.classList.toggle('over', goalOver);
  $('#score-num').textContent = score.value;

  renderHomeChart(homeRange);
  renderWhatChanged();
  renderConsumers();
  renderPeak();
  renderHomeInsight();
  renderHomeRecommendation();
  renderBillForecast();
}

function renderPeak() {
  if (!DATA) return;
  const p = DATA.peakUsage;
  const seg = $('#peak-seg');
  const max = Math.max(...hourly, 0.01);
  seg.innerHTML = hourly.map(v => {
    const r = v / max;
    const cls = r > 0.7 ? 'high' : r > 0.35 ? 'med' : 'low';
    return `<div class="seg-part ${cls}" title="${v.toFixed(2)} kWh"></div>`;
  }).join('');
  const pct = Math.round(p.eveningShare * 100);
  $('#peak-text').innerHTML = `<b>${pct}% of today's usage</b> falls between <b>7 PM – 11 PM</b>.`;
  $('#peak-note').innerHTML = `Peak hour is <b>${p.peakLabel}</b> (${p.peakKwh.toFixed(1)} kWh) · lowest usage is around <b>${p.lowestHour}</b>.`;
  const pt = $('#peak-text-p');
  if (pt) pt.innerHTML = `Your highest energy usage occurs between <b>7 PM – 11 PM</b> · <b>${pct}%</b> of today's total.`;
  const pn = $('#peak-note-p');
  if (pn) pn.innerHTML = `Peak hour is <b>${p.peakLabel}</b> (${p.peakKwh.toFixed(1)} kWh) · lowest usage is around <b>${p.lowestHour}</b>.`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning 👋';
  if (h < 17) return 'Good afternoon 👋';
  return 'Good evening 👋';
}

function renderHomeChart(range) {
  const el = $('#home-chart');
  const labels = $('#home-labels');
  const totalEl = $('#home-chart-total');

  if (range === 'today') {
    const { peak } = lineChart(el, hourly, { peakIndex: peakHourIndex, labels: hourly.map((_, i) => hourLabel(i)) });
    $('#home-chart-peak').innerHTML = `Peak: <b>${(DATA && DATA.peakUsage) ? DATA.peakUsage.peakLabel : hourLabel(peakHourIndex)} · ${peak} kWh</b>`;
    totalEl.textContent = `Total today: ${todayKwh.toFixed(1)} kWh`;
    labels.innerHTML = [0, 6, 12, 18, 23].map(h => `<span style="flex:1;text-align:center">${hourLabel(h)}</span>`).join('');
  } else if (range === 'week') {
    barChart(el, weekSeries, { today: weekSeries.length - 1 });
    const hiI = weekSeries.indexOf(Math.max(...weekSeries));
    $('#home-chart-peak').innerHTML = `Highest day: <b>${weekLabels[hiI]} · ${Math.max(...weekSeries)} kWh</b>`;
    totalEl.textContent = `Total this week: ${weekKwh} kWh · ${weekPct >= 0 ? `↑${weekPct}%` : `↓${-weekPct}%`} vs previous week`;
    labels.innerHTML = weekLabels.map(l => `<span style="flex:1;text-align:center">${l.slice(0, 1)}</span>`).join('');
  } else {
    barChart(el, monthSeries, { today: monthSeries.length - 1 });
    const hiI = monthSeries.indexOf(Math.max(...monthSeries));
    $('#home-chart-peak').innerHTML = `Highest day: <b>${monthLabels[hiI]} · ${Math.max(...monthSeries)} kWh</b>`;
    totalEl.textContent = `Used over 30 days: ${fmtKwh(monthUsed)} kWh`;
    labels.innerHTML = monthLabels.filter((_, i) => i % 2 === 0).map(l => `<span style="flex:1;text-align:center">${l}</span>`).join('');
  }
}

function renderWhatChanged() {
  const rows = liveAppliances().map(a => {
    const d = a.today - a.yesterday;
    const abs = Math.abs(d);
    const pct = Math.round(d / Math.max(a.yesterday, 0.01) * 100);
    return { id: a.id, name: a.short, ico: a.ico, d, abs, pct, color: a.color };
  })
    .filter(r => r.abs >= 0.01)
    .sort((a, b) => b.abs - a.abs);

  if (rows.length === 0) {
    $('#what-changed').innerHTML = '<p class="muted">No notable changes between days.</p>';
    $('#changed-sentence').textContent = '';
    $('#what-changed-chip').textContent = 'Same as yesterday';
    return;
  }
  const maxAbs = Math.max(...rows.map(r => r.abs), 0.1);

  $('#what-changed').innerHTML = rows.map(r => `
    <div class="changed-row">
      <span class="changed-ico">${icon(r.ico, 15)}</span>
      <span class="changed-name">${r.name}</span>
      <div class="changed-track">
        <div class="changed-fill" style="width:${r.abs / maxAbs * 100}%;background:${r.d >= 0 ? 'var(--red)' : 'var(--brand)'}"></div>
      </div>
      <span class="changed-val ${r.d > 0 ? 'up' : r.d < 0 ? 'down' : ''}">
        ${r.d > 0 ? '▲' : r.d < 0 ? '▼' : '—'} ${fmtKwh(r.abs)} kWh
      </span>
    </div>`).join('');

  const top = rows[0];
  $('#changed-sentence').textContent = top.d > 0
    ? `${top.name} is the main reason today's energy usage increased (+${fmtKwh(top.d)} kWh).`
    : `Today's usage changed most for ${top.name}.`;
  $('#what-changed-chip').textContent = todayDeltaPct > 0
    ? `▲ +${fmtKwh(todayDeltaKwh)} kWh vs yesterday`
    : todayDeltaPct < 0 ? `▼ -${fmtKwh(-todayDeltaKwh)} kWh vs yesterday`
    : 'Same as yesterday';
}

function renderConsumers() {
  const list = getConsumers();
  let acc = 0;
  const grad = [];
  for (const c of list) { grad.push(`${c.color} ${acc * 3.6}deg ${(acc + c.pct) * 3.6}deg`); acc += c.pct; }
  $('#donut').style.background = `conic-gradient(${grad.join(', ')})`;
  $('#donut').innerHTML = `<div class="donut-center"><span>${fmtKwh(todayKwh)}</span><small>kWh today</small></div>`;

  const apps = list.filter(c => !c.mains).slice(0, 5);
  const mains = list.filter(c => c.mains).slice(0, 1);

  $('#consumers-bars').innerHTML =
    apps.map((c, i) => `
    <div class="consumer-row" data-go-detail="${c.id}">
      <span class="consumer-rank">${i + 1}</span>
      <span class="consumer-ico">${icon(c.ico, 15)}</span>
      <div class="consumer-mid">
        <div class="consumer-topline"><span class="consumer-name">${c.name}</span><span class="consumer-pct">${c.pct}%</span></div>
        <div class="consumer-track"><div class="consumer-fill" style="width:${c.pct}%;background:${c.color}"></div></div>
        <div class="consumer-meta">${fmtKwh(c.kwh)} kWh · ${money(c.kwh)}</div>
      </div>
    </div>`).join('') +
    mains.map(c => `
    <div class="consumer-other">
      <div class="consumer-other-head">
        <span>Other / unmetered</span>
        <span class="info-hint" data-ico="info" aria-label="What is unmetered usage?" title="Household consumption recorded by the mains meter that isn't individually attributed to a monitored appliance."></span>
      </div>
      <div class="consumer-row mains" aria-hidden="true">
        <span class="consumer-rank">—</span>
        <span class="consumer-ico">${icon(c.ico, 15)}</span>
        <div class="consumer-mid">
          <div class="consumer-topline"><span class="consumer-name">${c.name}</span><span class="consumer-pct">${c.pct}%</span></div>
          <div class="consumer-track"><div class="consumer-fill" style="width:${c.pct}%;background:${c.color}"></div></div>
          <div class="consumer-meta">${fmtKwh(c.kwh)} kWh · ${money(c.kwh)}</div>
          <div class="consumer-mains-note">Household consumption recorded by the mains meter that isn't individually attributed to a monitored appliance.</div>
        </div>
      </div>
    </div>`).join('');
  injectIcons($('#consumers-bars'));
}

function renderHomeInsight() {
  const avg = DATA ? DATA.house.avgPrev7 : recentAvg;
  const diffKwh = +(todayKwh - avg).toFixed(2);
  const diffPct = avg > 0 ? Math.round(diffKwh / avg * 100) : 0;

  const balanced = liveAppliances()
    .map(a => ({ a, deltaUsual: +(a.today - a.usual).toFixed(3) }))
    .filter(o => o.deltaUsual !== 0);
  const bigger = balanced.filter(o => o.deltaUsual > 0)
    .sort((x, y) => y.deltaUsual - x.deltaUsual)[0];
  const lower = balanced.filter(o => o.deltaUsual < 0)
    .sort((x, y) => x.deltaUsual - y.deltaUsual)[0];
  const biggest = [...liveAppliances()].sort((x, y) => y.today - x.today)[0];

  const barsFor = (a) => {
    const maxV = Math.max(a.today, a.usual, 0.01);
    return `
      <div class="cmp-row">
        <span class="cmp-label">Today</span>
        <div class="cmp-track"><div class="cmp-fill" style="width:${(a.today / maxV * 100).toFixed(0)}%"></div></div>
        <b class="cmp-val">${fmtKwh(a.today)} kWh</b>
      </div>
      <div class="cmp-row">
        <span class="cmp-label">Usual</span>
        <div class="cmp-track"><div class="cmp-fill usual" style="width:${(a.usual / maxV * 100).toFixed(0)}%"></div></div>
        <b class="cmp-val">${fmtKwh(a.usual)} kWh</b>
      </div>`;
  };

  let whyId = biggest ? biggest.id : '';
  if (diffPct >= 2) {
    const main = bigger || lower || null;
    $('#home-insight').innerHTML = `Today's energy usage is <b>${diffPct}% higher</b> than your recent average (<b>${fmtKwh(avg)} kWh</b>).`;
    $('#home-insight-sub').innerHTML = main
      ? `${main.a.short} was the largest contributor, using <b>${fmtKwh(main.deltaUsual)} kWh more</b> than usual.`
      : 'The increase is spread across the home — no single appliance stands out.';
    $('#home-insight-bars').innerHTML = main ? barsFor(main.a)
      : homeBars(diffKwh, avg);
    if (main) whyId = main.a.id;
  } else if (diffPct <= -2) {
    const main = lower || bigger || null;
    $('#home-insight').innerHTML = `Today's energy usage is <b>${-diffPct}% lower</b> than your recent average (<b>${fmtKwh(avg)} kWh</b>).`;
    $('#home-insight-sub').innerHTML = main
      ? `${main.a.short} was the biggest drop, using <b>${fmtKwh(-main.deltaUsual)} kWh less</b> than usual.`
      : 'No single appliance explains it — usage is down across the home.';
    $('#home-insight-bars').innerHTML = main ? barsFor(main.a)
      : homeBars(diffKwh, avg);
    if (main) whyId = main.a.id;
  } else {
    $('#home-insight').innerHTML = `Today's energy usage is <b>about your recent average</b> (<b>${fmtKwh(avg)} kWh</b>).`;
    $('#home-insight-sub').innerHTML = biggest
      ? `${biggest.short} is your largest consumer at ${fmtKwh(biggest.today)} kWh today (${Math.round(biggest.today / todayKwh * 100)}% of the home).`
      : 'Your usage today is steady.';
    $('#home-insight-bars').innerHTML = biggest ? barsFor(biggest)
      : homeBars(diffKwh, avg);
  }
  $('#home-insight').closest('.card').querySelector('[data-open-why]').dataset.openWhy = whyId;
}

function homeBars(diffKwh, avg) {
  const maxV = Math.max(todayKwh, avg, 0.01);
  return `
    <div class="cmp-row">
      <span class="cmp-label">Today</span>
      <div class="cmp-track"><div class="cmp-fill" style="width:${(todayKwh / maxV * 100).toFixed(0)}%"></div></div>
      <b class="cmp-val">${fmtKwh(todayKwh)} kWh</b>
    </div>
    <div class="cmp-row">
      <span class="cmp-label">Usual</span>
      <div class="cmp-track"><div class="cmp-fill usual" style="width:${(avg / maxV * 100).toFixed(0)}%"></div></div>
      <b class="cmp-val">${fmtKwh(avg)} kWh</b>
    </div>`;
}

function topRecommendation() {
  const list = recommendationList();
  if (!list.length) return null;
  const { a, r } = list[0];
  return {
    id: a.id,
    ico: a.ico,
    title: r.title,
    problem: r.problem,
    impact: r.impact
  };
}

function renderHomeRecommendation() {
  const r = topRecommendation();
  if (!r) { $('#home-recommendation').innerHTML = '<p class="muted">No recommendation available yet.</p>'; return; }
  $('#home-recommendation').innerHTML = `
    <div class="rec-hero">
      <span class="rec-ico big">${icon(r.ico, 24)}</span>
      <div>
        <p class="rec-title">${r.title}</p>
        <p class="rec-why">${r.problem}</p>
      </div>
    </div>
    <div class="rec-save">
      <span>Illustrative saving · 10% less usage</span>
      <b>${r.impact.split(': ')[1]}</b>
    </div>
    <div class="rec-actions">
      <button class="btn-why" data-go="Insights" data-tab="recommend">View recommendation</button>
      <button class="btn-ghost" data-go="Insights" data-tab="goals">Set as goal</button>
    </div>`;
  injectIcons($('#home-recommendation'));
}

/* ---------- Appliances ---------- */
function renderAppliances() {
  const list = liveAppliances();
  const slot = $('#appliances-slot');

  if (list.length === 0) {
    slot.innerHTML = `
      <div class="empty-state span-2">
        <span class="empty-ico" data-ico="plug"></span>
        <h3>No appliances in your view</h3>
        <p>Explore the appliances in the dataset to preview their recorded usage.</p>
        <button class="btn-why" data-open-add>Explore appliances</button>
        <p class="muted" style="font-size:11px">Prototype interaction — nothing is physically connected.</p>
      </div>`;
    injectIcons(slot);
    return;
  }

  const compare = list.map(a => ({
    id: a.id, name: a.short, today: a.today, yesterday: a.yesterday,
    diffKwh: +(a.today - a.yesterday).toFixed(2)
  }));

  slot.innerHTML = `
    <div class="card span-2">
      <div class="card-head">
        <h3>Comparison vs yesterday</h3>
        <span class="card-sub">Recorded kWh for the dataset day</span>
      </div>
      <div class="table-scroll">
      <table class="compare-table">
        <thead><tr><th>Appliance</th><th>Today</th><th>Yesterday</th><th>Change</th></tr></thead>
        <tbody>
          ${compare.map(r => `
            <tr data-go-detail="${r.id}">
              <td>${r.name}</td><td>${fmtKwh(r.today)} kWh</td><td>${fmtKwh(r.yesterday)} kWh</td>
              <td class="${r.diffKwh > 0 ? 'up' : r.diffKwh < 0 ? 'down' : ''}">
                ${r.diffKwh > 0 ? '▲' : r.diffKwh < 0 ? '▼' : '—'} ${fmtKwh(Math.abs(r.diffKwh))} kWh
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>

    <p class="appl-section-title span-2">All appliances</p>
    <div class="appl-list span-2">
      ${list.map(a => `
        <div class="appl-card" data-go-detail="${a.id}">
          <span class="appl-ico">${icon(a.ico, 26)}</span>
          <div class="appl-info">
            <div class="appl-name">${a.name}</div>
            <div class="appl-sub">${a.watts > 0 ? `${fmtKwh(a.watts / 1000)} kW · ` : ''}${fmtKwh(a.today)} kWh recorded</div>
          </div>
          <div class="appl-right">
            <div class="appl-kwh">${money(a.today)}</div>
            <div class="status ${a.status === 'Running' ? 'running' : 'off'}">● ${a.status}</div>
            <div class="appl-change ${a.today - a.yesterday > 0 ? 'up' : a.today - a.yesterday < 0 ? 'down' : ''}">
              ${fmtDelta(a.today, a.yesterday)} vs yesterday
            </div>
          </div>
        </div>`).join('')}
    </div>

    <div class="card span-2">
      <div class="empty-state" style="padding: var(--s4)">
        <p style="color:var(--text-2);font-size:14px">Explore another appliance from the dataset</p>
        <button class="btn-ghost" data-open-add>${icon('plus', 18)} Explore an appliance</button>
        <p class="muted" style="font-size:11px;margin-top:4px">Prototype interaction — nothing is physically connected.</p>
      </div>
    </div>`;
  injectIcons(slot);
}

function renderHouseholdChip() {
  const chip = $('#household-chip');
  if (chip) chip.textContent = `Household · ${liveAppliances().length} appliances`;
}

/* ---------- Appliance detail ---------- */
let detailRange = 'today';

function renderDetail(id) {
  const a = appliances.find(x => x.id === id) || appliances[0];
  currentDetailId = a.id;
  $('#detail-name').textContent = a.short;
  $('#detail-status').textContent = '● ' + a.status;
  $('#detail-status').className = 'status ' + (a.status === 'Running' ? 'running' : 'off');
  const ctx = $('#detail-ctx');
  if (ctx && !ctx.textContent) ctx.textContent = datasetDayLabel();
  $('#detail-watts').innerHTML = a.watts > 0 ? `${fmtKwh(a.watts / 1000)}<span class="hero-unit">kW</span>` : `0<span class="hero-unit">kW</span>`;
  $('#detail-watts-note').textContent = a.watts > 0
    ? `Latest recorded power: ${fmtKwh(a.watts / 1000)} kW · ≈ ${money(a.watts / 1000)}/hour at your avg effective rate.`
    : a.status === 'No data'
      ? `No measured readings in this dataset window — last seen around ${a.tech[5][1]}.`
      : `No recent power draw recorded for this appliance.`;
  $('#detail-perhour').textContent = a.watts > 0 ? `${money(a.watts / 1000)}/hour` : '—/hour';
  $('#detail-tariff-note').textContent = a.watts > 0
    ? `${money(a.watts / 1000)}/hour is the latest recorded rate · ${money(a.today)} is the day's total at your avg effective rate.`
    : `No recent draw · ${money(a.today)} is the day's total at your avg effective rate.`;
  $('#detail-today').textContent = fmtKwh(a.today) + ' kWh';
  $('#detail-cost').textContent = money(a.today);
  const diff = +(a.today - a.yesterday).toFixed(2);
  $('#detail-diff').textContent = diff > 0 ? `▲ ${fmtKwh(diff)} kWh` : diff < 0 ? `▼ ${fmtKwh(-diff)} kWh` : '—';
  $('#detail-diff').className = 'stat ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '');
  $('#detail-share').textContent = Math.round(a.today / todayKwh * 100) + '%';

  renderDetailChart(a, detailRange);
  renderDetailWhy(a);
  renderDetailRec(a);

  $('#detail-why-btn').dataset.openWhy = a.id;

  $('#tech-grid').innerHTML = a.tech.map(([k, v]) =>
    `<div class="tech-item"><span>${k}</span><b>${v}</b></div>`).join('');
  $('#danger-zone').hidden = removedAppliances.has(a.id);
}

function renderDetailChart(a, range) {
  const el = $('#detail-chart');
  const stats = $('#detail-chart-stats');
  const labels = $('#detail-labels');
  $('#detail-chart-title').textContent = range === 'today' ? 'Energy usage today'
    : range === '7d' ? `${a.short} — last 7 days` : `${a.short} — last 30 days`;

  if (range === 'today') {
    const hs = scaleSum(a.hours, a.today);
    lineChart(el, hs, { peakIndex: hs.indexOf(Math.max(...hs)), labels: hs.map((_, i) => hourLabel(i)) });
    stats.innerHTML = `
      <div class="dstat"><span>Recorded today</span><b>${fmtKwh(a.today)} kWh</b></div>
      <div class="dstat"><span>Peak hour</span><b>${peakLabel(hs)}</b></div>
      <div class="dstat"><span>Latest draw</span><b>${fmtKwh(a.watts / 1000)} kW</b></div>
      <div class="dstat"><span>Cost today</span><b>${money(a.today)}</b></div>`;
    labels.innerHTML = ['12a', '6a', '12p', '6p', '11p'].map(l => `<span style="flex:1;text-align:center">${l}</span>`).join('');
  } else {
    const data = range === '7d' ? a.week : a.month;
    const lbl = range === '7d' ? weekLabels : monthLabels;
    const total = data.reduce((x, y) => x + y, 0);
    const avg = total / data.length;
    const hi = Math.max(...data), lo = Math.min(...data);
    const hiLabel = lbl[data.indexOf(hi)];
    const loLabel = lbl[data.indexOf(lo)];
    barChart(el, data, { today: data.length - 1 });
    stats.innerHTML = `
      <div class="dstat"><span>Total</span><b>${total.toFixed(1)} kWh</b></div>
      <div class="dstat"><span>Average</span><b>${avg.toFixed(2)} kWh/day</b></div>
      <div class="dstat"><span>Highest</span><b>${hiLabel} · ${hi.toFixed(1)} kWh</b></div>
      <div class="dstat"><span>Lowest</span><b>${loLabel} · ${lo.toFixed(1)} kWh</b></div>`;
    labels.innerHTML = lbl.filter((_, i) => i % 2 === 0).map(l => `<span style="flex:1;text-align:center">${l}</span>`).join('');
  }
}

function peakLabel(data) {
  const i = data.indexOf(Math.max(...data));
  const h = i;
  const hr = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
  return `${hr} · ${Math.max(...data).toFixed(2)} kWh`;
}

function renderDetailWhy(a) {
  const diff = +(a.today - a.usual).toFixed(1);
  $('#detail-why').innerHTML = diff > 0
    ? `Today you used <b>${diff} kWh more</b> than your usual day. ${a.whyReason}`
    : `Today you used <b>${Math.abs(diff)} kWh less</b> than your usual day. ${a.whyReason}`;
}

function renderDetailRec(a) {
  const r = a.recommendation;
  $('#detail-rec').innerHTML = `
    <div class="rec-step">
      <span class="rec-ico">${icon('leaf', 20)}</span>
      <div><p class="rec-v"><b>${r.title}</b></p></div>
    </div>
    <div class="rec-step">
      <span class="rec-ico">${icon('target', 20)}</span>
      <div><p class="rec-k">Expected impact</p><p class="rec-v">${r.impact}</p></div>
    </div>
    <div class="rec-actions">
      <button class="btn-ghost" data-go="Insights" data-tab="recommend">See all recommendations</button>
    </div>`;
  injectIcons($('#detail-rec'));
}

/* ---------- Why modal ---------- */
function openWhy(id) {
  const a = appliances.find(x => x.id === id);
  const diff = +(a.today - a.usual).toFixed(1);
  const hrs = a.avgPower > 0 ? Math.max(0, +(diff / (a.avgPower / 1000)).toFixed(1)) : 0;
  openModal('How we calculated this', `
    <p class="why-sentence" style="margin-top:0">${a.whyReason}</p>
    <div class="why-stats">
      <div class="why-stat"><span>Today's ${a.short}</span><b>${a.today.toFixed(2)} kWh</b></div>
      <div class="why-stat"><span>Your usual</span><b>${a.usual.toFixed(2)} kWh</b></div>
      <div class="why-stat"><span>Difference</span><b class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${diff.toFixed(2)} kWh</b></div>
    </div>
    <div class="why-stats">
      <div class="why-stat"><span>${a.short} runtime</span><b>${hrs > 0 ? '≈' : ''}${hrs.toFixed(1)} h ${hrs > 0 ? 'extra' : ''}</b></div>
      <div class="why-stat"><span>Avg draw</span><b>${(a.avgPower / 1000).toFixed(2)} kW</b></div>
      <div class="why-stat"><span>Extra cost today</span><b class="up">${money(Math.abs(diff))}</b></div>
    </div>
    <p class="why-sentence">${diff > 0 ? `Your longer ${a.short.toLowerCase()} runtime is the main contributor to today's higher usage.` : 'Your usage today is close to your usual amount.'}</p>
    <h4 style="font-size:14px">Your usage today</h4>
    <div class="line-chart" id="why-chart" style="height:120px"></div>
    <div class="rec-actions">
      <button class="btn-why" data-go-detail="${a.id}">View recommendation</button>
    </div>`, () => {
    const hs = scaleSum(a.hours, a.today);
    lineChart($('#why-chart'), hs, { peakIndex: hs.indexOf(Math.max(...hs)), labels: hs.map((_, i) => hourLabel(i)) });
  });
}

/* ---------- Insights ---------- */
let currentTab = 'usage';

function renderInsights(tab) {
  currentTab = tab;
  $$('.seg').forEach(s => s.classList.toggle('active', s.dataset.tab === tab));
  const panes = { usage: 'tab-usage', patterns: 'tab-patterns', recommend: 'tab-recommend', goals: 'tab-goals' };
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === panes[tab]));
  if (tab === 'usage') renderUsage();
  if (tab === 'patterns') renderPatterns();
  if (tab === 'recommend') renderRecommend();
  if (tab === 'goals') renderGoals();
}

function renderUsage() {
  $('#m-usage').textContent = fmtKwh(monthUsed) + ' kWh';
  $('#m-avg').textContent = fmtKwh(avgDailyKwh) + ' kWh/day';
  $('#m-usage-sub').textContent = `Observed over ${datasetDays} days of iAWE data · ${(DATA && DATA.metadata && DATA.metadata.dateRange) ? DATA.metadata.dateRange.start + ' – ' + DATA.metadata.dateRange.end : '30-day window'}`;
  $('#m-note').innerHTML = `The <b>${fmtKwh(monthUsed)} kWh</b> above is the actual 30-day usage recorded in the dataset. Estimated costs appear in the bill forecast below.`;

  barChart($('#month-chart'), monthSeries, { today: monthSeries.length - 1 });
  $('#month-labels').innerHTML = monthLabels.filter((_, i) => i % 2 === 0)
    .map(l => `<span style="flex:1;text-align:center">${l}</span>`).join('');

  const wk = weekPct >= 0 ? `↑${weekPct}%` : `↓${-weekPct}%`;
  $('#week-sum').textContent = `${fmtKwh(weekKwh)} kWh · ${wk} vs previous week`;
  barChart($('#insight-week-chart'), weekSeries, { today: weekSeries.length - 1 });
  $('#insight-week-labels').innerHTML = weekLabels.map(l => `<span style="flex:1;text-align:center">${l.slice(0, 1)}</span>`).join('');

  const todayArrow = todayDeltaPct > 0 ? `▲ ${todayDeltaPct}%` : todayDeltaPct < 0 ? `▼ ${-todayDeltaPct}%` : 'same as';
  const days = [
    { label: 'Today', v: fmtKwh(todayKwh) + ' kWh', sub: `${todayArrow} vs yesterday` },
    { label: 'Yesterday', v: fmtKwh(yesterdayKwh) + ' kWh', sub: 'baseline day' },
    { label: 'This week', v: fmtKwh(weekKwh) + ' kWh', sub: `${wk} vs last week` }
  ];
  $('#compare-days').innerHTML = days.map(d =>
    `<div class="day-card"><span>${d.label}</span><b>${d.v}</b><span>${d.sub}</span></div>`).join('');

  renderBillForecast();
}

function renderPatterns() {
  barChart($('#hour-chart'), hourly, { highlight: [17, 18, 19, 20, 21, 22] });
  $('#hour-chart').classList.remove('line-chart');
  $('#hour-chart').classList.add('bar-chart');
  $('#hour-chart').style.height = '160px';

  barChart($('#weekday-chart'), [weekdayAvg, weekendAvg]);
  $('#weekday-chart').style.height = '90px';
}

function renderRecommend() {
  const list = recommendationList();
  $('#rec-list').innerHTML = list.map(({ a, r, diff, rank }) => `
      <div class="card rec-card">
        <div class="rec-head">
          <span class="rec-ico">${icon(r.ico, 22)}</span>
          <div>
            <p class="rec-title">${r.title}</p>
            <p class="muted">${a.short} · ${diff > 0.01 ? `${fmtKwh(diff)} kWh above usual` : diff < -0.01 ? `${fmtKwh(-diff)} kWh below usual` : 'about usual'}</p>
          </div>
        </div>
        <p class="rec-v">${r.problem}</p>
        <p class="rec-v" style="color:var(--text-2)">${r.insight}</p>
        <div class="rec-tags">
          <span class="rec-impact">${r.impact}</span>
          <span class="rec-diff ${rank === 0 ? 'highest' : rank < 3 ? 'medium' : ''}">${priorityTier(rank)}</span>
        </div>
        <div class="rec-actions">
          <button class="btn-ghost" data-go-detail="${a.id}">View ${a.short} usage</button>
        </div>
      </div>`).join('');
  injectIcons($('#rec-list'));
}

function renderGoals() {
  const used = GOAL.usedKwh, target = GOAL.targetKwh;
  const over = GOAL.overKwh > 0;
  const prog = target > 0 ? Math.min(100, used / target * 100) : 0;
  const left = Math.max(0, target - used);
  const goalBox = document.querySelector('.goal-box');
  if (goalBox) goalBox.classList.toggle('over', over);
  $('#goal-used').innerHTML = `${fmtKwh(used)}<span> / ${fmtKwh(target)} kWh target</span>`;
  const bar = $('#goal-bar');
  if (bar) bar.classList.toggle('over', over);
  $('#goal-bar-fill').style.width = (over ? 100 : prog) + '%';
  $('#goal-left').innerHTML = over
    ? `${fmtKwh(GOAL.overKwh)} kWh over target`
    : `${fmtKwh(left)} kWh of headroom before reaching target`;
  const gv = $('#goal-value');
  if (gv) gv.innerHTML = `${fmtKwh(target)} kWh <span class="chev">›</span>`;
  $('#score-num-2').textContent = score.value;
  $('#score-label').textContent = score.label;
  $('#score-delta').textContent = (score.weekDelta >= 0 ? '▲ +' : '▼ ') + Math.abs(score.weekDelta) + ' pts vs last week';
  $('#score-factors').innerHTML = score.factors.map(([name, val]) => `
    <div class="factor">
      <span class="name">${name}</span>
      <div class="factor-track"><div class="factor-fill" style="width:${val}%"></div></div>
      <span class="factor-val">${val}</span>
    </div>`).join('');
  $('#score-why').textContent = scoreAdvice();
}

/* ---------- Notifications ---------- */
function renderNotifications() {
  $('#notif-list').innerHTML = notifications.map(n => `
    <div class="notif-item">
      <span class="notif-ico ${n.type}">${icon(n.ico, 20)}</span>
      <div>
        <p class="notif-title">${n.title}</p>
        <p class="notif-msg">${n.msg}</p>
        <span class="notif-time">${n.time}</span>
      </div>
    </div>`).join('');
  injectIcons($('#notif-list'));
}

function openNotifs() {
  renderNotifications();
  $('#bell-badge').style.display = 'none';
  $('#notif-panel').classList.add('open');
  $('#notif-panel').setAttribute('aria-hidden', 'false');
  $('#notif-scrim').hidden = false;
}
function closeNotifs() {
  $('#notif-panel').classList.remove('open');
  $('#notif-panel').setAttribute('aria-hidden', 'true');
  $('#notif-scrim').hidden = true;
}

/* ---------- Navigation ---------- */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + id));
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === id));
  $$('.side-item').forEach(n => n.classList.toggle('active', n.dataset.nav === id));
  if (id === 'Home') renderHome();
  if (id === 'Appliances') renderAppliances();
  if (id === 'Insights') renderInsights(currentTab);
  if (id === 'Profile') renderTariffSettings();
  closeSidebar();
  closeNotifs();
  window.scrollTo({ top: 0 });
}

/* ---------- Sidebar ---------- */
function openSidebar() { $('#sidebar').classList.add('open'); $('#side-backdrop').hidden = false; }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#side-backdrop').hidden = true; }

/* ---------- Modal ---------- */
function openModal(title, body, after) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal').hidden = false;
  if (after) after();
  injectIcons($('#modal-body'));
}
function closeModal() { $('#modal').hidden = true; }

/* ---------- Score explainer ---------- */
function openScoreExplain() {
  openModal('How your energy score works', `
    <p style="color:var(--text-2)">Your score is an average of four factors, each from 0–100, computed deterministically from the 30-day dataset window.</p>
    ${scoreHow.map(([n, d]) => `
      <div class="rec-step">
        <span class="rec-ico">${icon('target', 20)}</span>
        <div><p class="rec-v"><b>${n}</b></p><p class="rec-v" style="color:var(--text-2)">${d}</p></div>
      </div>`).join('')}
    <p class="why-sentence">${scoreAdvice()}</p>`);
}

/* ---------- Privacy / about modals ---------- */
function openInfoModal(kind) {
  const content = {
    privacy: `
      <p style="color:var(--text-2)">Energy usage data is treated as sensitive household information.</p>
      <ul style="margin-left:20px;color:var(--text-2);display:flex;flex-direction:column;gap:6px">
        <li>You can only access your own energy data.</li>
        <li>Data is transmitted securely between sensors and servers.</li>
        <li>We minimize collection of personal information.</li>
        <li>Historical data is retained for 24 months by default.</li>
      </ul>`,
    download: `
      <p style="color:var(--text-2)">You can download your energy history as a CSV file. It includes daily usage, costs and appliance-level data.</p>
      <div class="rec-actions">
        <button class="btn-why" id="dl-demo">Prepare download…</button>
      </div>`,
    delete: `
      <p style="color:var(--red);font-weight:600">This permanently deletes your energy history and settings.</p>
      <p style="color:var(--text-2)">This action cannot be undone.</p>
      <div class="rec-actions">
        <button class="btn-danger" id="del-demo">Delete my data</button>
      </div>`,
    about: `
      <p style="color:var(--text-2)">Smart Energy is a UI/UX-focused energy monitoring and decision-support system.</p>
      <p style="color:var(--text-2)">It turns raw electricity measurements into simple, actionable information — usage, cost, patterns, insights and recommendations.</p>
      <p class="muted">Prototype · Powered by the iAWE household energy dataset (1 Hz submetered electricity, May–Sep 2013). Displays a 30-day window ending 2013-08-04. All figures are computed from real meter readings.</p>`,
    terms: `
      <p style="color:var(--text-2)">This is a demonstration prototype. Electricity costs are estimates based on your configured tariff and may differ from your final bill.</p>
      <p class="muted">Recommendations are heuristic, not professional energy audits.</p>`
  };
  const titles = { privacy: 'Privacy settings', download: 'Download my data', delete: 'Delete my data', about: 'About Smart Energy', terms: 'Terms & privacy policy' };
  openModal(titles[kind], content[kind]);
  const dl = $('#dl-demo');
  if (dl) dl.addEventListener('click', () => { dl.textContent = '✓ Requested — check your email'; dl.style.background = 'var(--brand-strong)'; });
  const del = $('#del-demo');
  if (del) del.addEventListener('click', () => { openModal('Data deleted', '<p style="color:var(--text-2)">Your energy history and settings have been deleted from this demo.</p>'); });
}

/* ---------- Tariff & billing forecast ---------- */
function stateProfile() { return TARIFF_PROFILES[selectedState]; }

function renderBillForecast() {
  const p = stateProfile();
  const cyc = billingCycleBill(p);
  const mo = monthlyEstimateBill(p);
  const eqPerMonth = monthlyEquivalent(p);
  const isBiMonthly = p.billingDays > 30;

  const fcAmount = $('#fc-amount');
  if (fcAmount) {
    fcAmount.textContent = fmtMoney(cyc.total);
    const lbl = isBiMonthly ? `Expected bill · every ${p.billingDays} days` : 'Expected monthly bill';
    $('#fc-cycle-label').textContent = lbl;
    $('#fc-sub').textContent = `Estimated usage: ${fmtKwh(estimateBillingCycleUsage(p))} kWh · ${p.cycleLabel} · ${p.state} · ${p.provider}`;
    $('#fc-note').textContent = `Based on your average daily usage of ${fmtKwh(avgDailyKwh)} kWh, across ${datasetDays} days of iAWE household data.`;
    const moEl = $('#fc-mo');
    if (moEl) moEl.innerHTML = isBiMonthly
      ? `<div class="fc-eq"><span class="muted">Monthly equivalent</span><b>${fmtMoney(eqPerMonth)}/month</b></div>`
      : `<div class="fc-eq"><span class="muted">Billing cycle</span><b>${p.cycleLabel} · ${p.billingDays} days</b></div>`;
  }

  /* Monthly estimate vs billing-cycle cards */
  const cc = $('#compare-cycles');
  if (cc) {
    const monthCard = `
      <div class="ccard">
        <span class="muted">MONTHLY ESTIMATE</span>
        <b>${fmtKwh(estimateMonthlyUsage())} kWh</b>
        <strong>${fmtMoney(mo.total)}</strong>
        <span class="muted">30-day projection at ${p.state} tariff</span>
      </div>`;
    const cycleCard = isBiMonthly ? `
      <div class="ccard accent">
        <span class="muted">EXPECTED BILLING CYCLE</span>
        <b>${fmtKwh(estimateBillingCycleUsage(p))} kWh</b>
        <strong>${fmtMoney(cyc.total)}</strong>
        <span class="muted">${p.state} · ${p.cycleLabel} · ${p.billingDays} days</span>
      </div>` : '';
    cc.innerHTML = monthCard + cycleCard + `
      <p class="cc-note">${isBiMonthly
        ? `${fmtKwh(estimateMonthlyUsage())} kWh is the 30-day usage; the ${fmtKwh(estimateBillingCycleUsage(p))} kWh bill period is ${p.billingDays} days. They are different periods — never compared as equal.`
        : `Both cards reflect the same 30-day billing cycle, so they are shown as one expected monthly bill.`}</p>`;
  }

  /* Home compact card */
  $('#home-bill').textContent = fmtMoney(cyc.total);
  $('#home-bill-cycle').textContent = `${p.state} · ${p.cycleLabel}`;
}

function openForecastInfo() {
  openModal('How is this estimate calculated?', `
    <p style="color:var(--text-2)">Your estimate is based on your average daily energy use and your state's electricity tariff.</p>
    ${[
      'We calculate your average daily energy consumption from the available iAWE dataset.',
      'We project that usage across the selected state\u2019s billing period.',
      'We apply the selected state\u2019s domestic tariff structure (slabs, fixed charges, duty).',
      'The result is an estimated bill, not an actual EB bill.'
    ].map((s, i) => `
      <div class="rec-step">
        <span class="rec-ico">${icon(['download', 'target', 'bolt', 'check'][i], 20)}</span>
        <div><p class="rec-v" style="color:var(--text-2)">${i + 1}. ${s}</p></div>
      </div>`).join('')}
    <p class="muted">Estimated from your recent energy usage pattern · Based on ${datasetDays} days of iAWE household data.</p>`);
}

function openBillBreakdown() {
  const p = stateProfile();
  const cyc = billingCycleBill(p);
  const row = (k, v) => `<div class="bk-row"><span>${k}</span><b>${v}</b></div>`;
  openModal(`Estimated bill breakdown · ${p.state}`, `
    <p style="color:var(--text-2)">For the projected ${fmtKwh(estimateBillingCycleUsage(p))} kWh in this ${p.cycleLabel.toLowerCase()} billing cycle (${p.billingDays} days).</p>
    <div class="bill-breakdown">
      ${row('Energy charges', fmtMoney(cyc.energy))}
      ${row('Fixed charges', fmtMoney(cyc.fixed))}
      ${cyc.fuel > 0 ? row('Fuel surcharge', fmtMoney(cyc.fuel)) : ''}
      ${cyc.duty > 0 ? row(`Electricity duty (${p.dutyPct}%)`, fmtMoney(cyc.duty)) : ''}
      <div class="bk-line"></div>
      ${row('Estimated total', fmtMoney(cyc.total))}
    </div>
    <p class="muted" style="margin-top:10px">${p.description}</p>
    <p class="muted">${p.source} · May differ from an issued bill.</p>`);
}

function openTariff() {
  openModal('State &amp; electricity tariff', `
    <p style="color:var(--text-2)">Expected bills use the selected state's domestic tariff and billing cycle. Consumption never changes — only the estimated cost.</p>
    <div class="state-grid">
      ${Object.entries(TARIFF_PROFILES).map(([id, t]) => `
        <button class="state-item ${selectedState === id ? 'selected' : ''}" data-state="${id}">
          <b>${t.state}</b>
          <span>${t.provider} · ${t.cycleLabel} · ${t.billingDays} days</span>
        </button>`).join('')}
    </div>
    <div class="form-row" id="custom-rate-row" ${selectedState === 'custom' ? '' : 'hidden'}>
      <label for="tariff-input">Rate (₹/kWh)</label>
      <input id="tariff-input" class="input" type="number" step="0.5" min="1" max="50" value="${tariff}">
    </div>
    <p class="muted">Tariff rates are the published FY 2025–26 domestic slabs for each state.</p>
    <div class="rec-actions">
      <button class="btn-ghost" id="view-tariff-details">View tariff details</button>
      <button class="btn-why" id="save-tariff">Apply</button>
    </div>`);
  document.querySelectorAll('[data-state]').forEach(b => b.addEventListener('click', () => {
    selectedState = b.dataset.state;
    localStorage.setItem('se-state', selectedState);
    document.querySelectorAll('[data-state]').forEach(x => x.classList.toggle('selected', x === b));
    $('#custom-rate-row').hidden = selectedState !== 'custom';
  }));
  $('#view-tariff-details').setAttribute('data-open-tariff-details', '');
  $('#save-tariff').addEventListener('click', () => {
    if (selectedState === 'custom') {
      const v = parseFloat($('#tariff-input').value);
      if (v > 0) { tariff = v; localStorage.setItem('se-tariff', v); TARIFF_PROFILES.custom.rate = v; }
    }
    closeModal();
    renderHome(); renderAppliances(); renderInsights(currentTab); renderTariffSettings();
  });
}

function openTariffDetails() {
  const p = stateProfile();
  const rows = [];
  if (p.id === 'tn') {
    rows.push('<p class="muted">Bi-monthly (60-day) slabs · LT-I(A):</p>',
      '<div class="bk-row"><span>0 – ' + (p.freeGt500) + ' / 0 – ' + p.freeLe500 + ' units (short scheme)</span><b>Free</b></div>',
      '<div class="bk-row"><span>Next 300 units</span><b>₹4.95/unit</b></div>',
      '<div class="bk-row"><span>Next 100</span><b>₹6.65</b></div>',
      '<div class="bk-row"><span>Next 100</span><b>₹8.80</b></div>',
      '<div class="bk-row"><span>Next 200</span><b>₹9.95</b></div>',
      '<div class="bk-row"><span>Next 200</span><b>₹11.05</b></div>',
      '<div class="bk-row"><span>Beyond 1,000</span><b>₹12.15</b></div>',
      `<p class="muted">Free-unit allowance: 200 units ≤500 consumed, 100 units above 500 (telescopic). Fixed charges not applicable for LT-I(A).</p>`);
  } else if (p.id === 'kl') {
    rows.push('<p class="muted">Monthly slabs · LT-I domestic (single phase):</p>',
      '<div class="bk-row"><span>Telescopic ≤250 · 0–50</span><b>₹3.35 + ₹50 fixed</b></div>',
      '<div class="bk-row"><span>51–100</span><b>₹4.25 + ₹85</b></div>',
      '<div class="bk-row"><span>101–150</span><b>₹5.35 + ₹105</b></div>',
      '<div class="bk-row"><span>151–200</span><b>₹7.20 + ₹140</b></div>',
      '<div class="bk-row"><span>201–250</span><b>₹8.50 + ₹160</b></div>',
      '<div class="bk-row"><span>&gt;250 non-telescopic</span><b>₹6.75 – ₹9.20 all units</b></div>',
      `<p class="muted">Plus electricity duty ${p.dutyPct}% and ₹${p.fuelPerKwh}/unit fuel surcharge on the projected bill.</p>`);
  } else if (p.id === 'ka') {
    rows.push('<p class="muted">Monthly · LT-1 domestic, FY 2025–26 (single flat energy rate):</p>',
      '<div class="bk-row"><span>All units</span><b>₹5.80/unit</b></div>',
      '<div class="bk-row"><span>Fixed charge (assumed 2 kW sanctioned load)</span><b>₹' + (p.fixedPerKw * p.loadKw) + '/month</b></div>',
      `<p class="muted">Plus electricity duty ${p.dutyPct}%. Excludes temporary surcharges (P&G, true-up).</p>`);
  } else if (p.id === 'mh') {
    rows.push('<p class="muted">Monthly slabs · LT-I(B) residential, single phase:</p>',
      '<div class="bk-row"><span>1–100 units</span><b>₹5.67/unit</b></div>',
      '<div class="bk-row"><span>101–300</span><b>₹10.88</b></div>',
      '<div class="bk-row"><span>301–500</span><b>₹14.07</b></div>',
      '<div class="bk-row"><span>Above 500</span><b>₹15.57</b></div>',
      '<div class="bk-row"><span>Fixed connection charge</span><b>₹130/month</b></div>',
      `<p class="muted">Combined per-unit rates include Fuel Adjustment charges. Plus electricity duty ${p.dutyPct}%.</p>`);
  } else {
    rows.push('<div class="bk-row"><span>Flat rate</span><b>₹' + tariff + '/kWh</b></div>');
  }
  closeModal();
  openModal(`${p.state} tariff details`, rows.join('') +
    `<p class="muted" style="margin-top:10px">${p.source} · Rates are illustrative estimates for this prototype and may differ from an issued bill.</p>`);
}

function renderTariffSettings() {
  const p = stateProfile();
  const v = $('#tariff-value');
  if (v) v.innerHTML = `${p.state} · ${fmtMoney(effRate())}/kWh avg <span class="chev">›</span>`;
  const fill = (id, txt) => { const el = document.getElementById(id); if (el) el.innerHTML = txt; };
  fill('ts-provider', p.provider);
  fill('ts-cycle', `${p.cycleLabel} · ${p.billingDays} days`);
  fill('ts-period', `${p.billingDays} days`);
  fill('ts-rate', `${fmtMoney(effRate())}/kWh avg effective`);
  fill('ts-fixed', p.id === 'kl' ? 'Varies by slab' : p.id === 'custom' ? 'None' : fmtMoney(p.fixed || 0));
}

/* ---------- Add appliance flow ---------- */
let addStep = 0;
let addType = null;
let addName = '';
const APPLIANCE_TYPES = [
  { id: 'ac', name: 'AC', ico: 'snow' },
  { id: 'fridge', name: 'Refrigerator', ico: 'fridge' },
  { id: 'fan', name: 'Fan', ico: 'fan' },
  { id: 'tv', name: 'TV', ico: 'tv' },
  { id: 'other', name: 'Other', ico: 'plug' }
];

function openAddFlow() {
  addStep = 0; addType = null; addName = '';
  $('#add-flow').hidden = false;
  renderAddStep();
}
function closeAddFlow() { $('#add-flow').hidden = true; }
function renderAddStep() {
  const body = $('#add-body');
  $('#add-title').textContent = 'Explore an appliance';
  if (addStep === 0) {
    body.innerHTML = `
      <p style="color:var(--text-2)">Which appliance would you like to explore in the demo?</p>
      <div class="choose-grid">
        ${APPLIANCE_TYPES.map(t => `
          <button class="choose-item ${addType === t.id ? 'selected' : ''}" data-add-type="${t.id}">
            ${icon(t.ico, 26)}<span>${t.name}</span>
          </button>`).join('')}
      </div>
      <div class="rec-actions">
        <button class="btn-why" id="add-next" ${addType ? '' : 'disabled'}>Continue →</button>
      </div>`;
    injectIcons(body);
    body.querySelectorAll('[data-add-type]').forEach(b => b.addEventListener('click', () => {
      addType = b.dataset.addType; renderAddStep();
    }));
    $('#add-next').addEventListener('click', () => { addStep = 1; renderAddStep(); });
    if (!addType) $('#add-next').disabled = true;
  } else if (addStep === 1) {
    const t = APPLIANCE_TYPES.find(x => x.id === addType);
    body.innerHTML = `
      <p style="color:var(--text-2)">Give it a name so you can recognise it later.</p>
      <div class="form-row">
        <label for="add-name">Appliance name</label>
        <input id="add-name" class="input" type="text" value="${t.name}">
      </div>
      <div class="rec-actions">
        <button class="btn-ghost" id="add-back">Back</button>
        <button class="btn-why" id="add-connect">Preview →</button>
      </div>`;
    $('#add-back').addEventListener('click', () => { addStep = 0; renderAddStep(); });
    $('#add-connect').addEventListener('click', () => {
      addName = $('#add-name').value.trim() || t.name;
      addStep = 2; renderAddStep();
    });
  } else if (addStep === 2) {
    body.innerHTML = `
      <div class="add-status">
        <div class="spinner" role="status" aria-label="Preparing preview"></div>
        <h3 style="font-size:18px">Preparing preview…</h3>
        <p style="color:var(--text-2)">Reading the recorded data for this appliance from the dataset.</p>
      </div>`;
    setTimeout(() => { addStep = 3; renderAddStep(); }, 1800);
  } else {
    const name = addName || (APPLIANCE_TYPES.find(x => x.id === addType) || {}).name;
    const t = APPLIANCE_TYPES.find(x => x.id === addType);
    body.innerHTML = `
      <div class="add-status">
        <span class="add-check">${icon('check', 32)}</span>
        <h3 style="font-size:20px">${name} added to your view</h3>
        <p style="color:var(--text-2)">Preview its recorded usage from the dataset.</p>
        <p class="muted">Prototype: simulated addition — no physical device is connected.</p>
      </div>
      <div class="rec-actions">
        <button class="btn-why" id="add-done">Done</button>
      </div>`;
    $('#add-done').addEventListener('click', () => {
      if (t) addedAppliances.push({ type: t.id, name });
      closeAddFlow();
      renderAppliances();
      renderHouseholdChip();
    });
  }
}

/* ---------- Remove appliance ---------- */
function removeAppliance(id) {
  removedAppliances.add(id);
  closeModal();
  showScreen('Appliances');
  renderAppliances();
  renderHouseholdChip();
}

/* ---------- Onboarding ---------- */
let onbIndex = 0;
function showOnboarding(force) {
  if (!force && localStorage.getItem('se-onboarded')) return;
  $('#onboarding').hidden = false;
  onbIndex = 0;
  renderOnboarding();
}
function renderOnboarding() {
  const slides = $('#onb-slides').children;
  [...slides].forEach((s, i) => s.classList.toggle('active', i === onbIndex));
  $('#onb-dots').innerHTML = [...slides].map((_, i) =>
    `<span class="onb-dot ${i === onbIndex ? 'active' : ''}"></span>`).join('');
  const next = $('#onb-next');
  next.textContent = onbIndex === slides.length - 1 ? 'Get Started →' : 'Next →';
}
function closeOnboarding() { $('#onboarding').hidden = true; localStorage.setItem('se-onboarded', '1'); }

/* ---------- Theme ---------- */
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('se-theme', t);
  const tog = $('#dark-toggle');
  if (tog) tog.checked = t === 'dark';
}

/* ---------- Offline ---------- */
function setOffline(off) { $('#offline-banner').hidden = !off; }

/* ---------- Boot ---------- */
function boot() {
  if (!DATA || !DATA.appliances.length) {
    document.getElementById('boot').hidden = true;
    const main = document.getElementById('main');
    main.innerHTML = `<div class="empty-state" style="padding:48px;text-align:center">
      <h3>Energy data not found</h3>
      <p style="color:var(--text-2)">Load data/energy-data.js alongside app.js to enable the demo.</p>
    </div>`;
    return;
  }
  const od = document.getElementById('offline-date');
  if (od) od.textContent = ' · dataset through ' + DATA.metadata.dateRange.today + '.';
  renderHome();
  renderAppliances();
  renderHouseholdChip();
  renderDetail(currentDetailId);
  renderInsights('usage');
  renderNotifications();
  $('#side-score').textContent = score.value;
  applyTheme(theme);
  injectIcons();
  setTimeout(() => {
    const b = $('#boot');
    b.style.opacity = '0';
    setTimeout(() => { b.hidden = true; showOnboarding(); }, 400);
  }, 1100);
}

/* ============================================================
   Events
   ============================================================ */
document.addEventListener('click', e => {
  const target = e.target.closest('button, [data-go], [data-go-detail], .appl-card, .consumer-row, tr[data-go-detail], [data-close-modal], [data-close-add], #side-backdrop, #btn-remove-appliance');
  if (!target) return;

  // nav
  const nav = target.closest('.nav-item, .side-item');
  if (nav) { showScreen(nav.dataset.nav); return; }

  // overlays first (before generic [data-go] which some share)
  if (target.closest('#side-backdrop')) { closeSidebar(); return; }
  if (target.closest('#btn-remove-appliance')) { removeAppliance(currentDetailId); return; }
  if (target.closest('[data-close-modal]')) { closeModal(); return; }
  if (target.closest('[data-close-add]')) { closeAddFlow(); return; }

  // generic navigation with optional tab
  const go = target.closest('[data-go]');
  if (go) {
    showScreen(go.dataset.go);
    if (go.dataset.tab) setTimeout(() => renderInsights(go.dataset.tab), 0);
    return;
  }

  // appliance detail
  const dt = target.closest('[data-go-detail]');
  if (dt) { renderDetail(dt.dataset.goDetail); showScreen('Detail'); return; }

  // why / modals / flows
  const why = target.closest('[data-open-why]');
  if (why) { openWhy(why.dataset.openWhy); return; }
  if (target.closest('[data-open-score]')) { openScoreExplain(); return; }
  if (target.closest('[data-open-tariff]')) { openTariff(); return; }
  if (target.closest('[data-open-tariff-details]')) { openTariffDetails(); return; }
  if (target.closest('[data-open-forecast-info]')) { openForecastInfo(); return; }
  if (target.closest('[data-open-bill-breakdown]')) { openBillBreakdown(); return; }
  if (target.closest('[data-open-notif]')) { openNotifs(); return; }
  if (target.closest('[data-open-add]')) { openAddFlow(); return; }
  const info = target.closest('[data-open-modal]');
  if (info) { openInfoModal(info.dataset.openModal); return; }
  if (target.closest('[data-replay-onboarding]')) { showOnboarding(true); return; }
  if (target.closest('[data-open-sidebar]')) { openSidebar(); return; }
});

/* range tabs on home */
$$('.range').forEach(b => b.addEventListener('click', () => {
  $$('.range').forEach(x => x.classList.toggle('active', x === b));
  homeRange = b.dataset.range;
  renderHomeChart(homeRange);
}));

/* range tabs on detail */
$$('[data-drange]').forEach(b => b.addEventListener('click', () => {
  $$('[data-drange]').forEach(x => x.classList.toggle('active', x === b));
  detailRange = b.dataset.drange;
  renderDetail(currentDetailId);
}));

let currentDetailId = (DATA && DATA.appliances.length) ? DATA.appliances[0].id : 'fridge';

/* notifications */
$('#bell-btn').addEventListener('click', openNotifs);
$('#notif-close').addEventListener('click', closeNotifs);
$('#notif-scrim').addEventListener('click', closeNotifs);
$('#detail-back').addEventListener('click', () => showScreen('Appliances'));
$('#tech-toggle').addEventListener('click', toggleTech);
function toggleTech() {
  const panel = $('#tech-panel');
  panel.hidden = !panel.hidden;
  $('#tech-toggle').setAttribute('aria-expanded', String(!panel.hidden));
}

/* insights tabs */
$$('.seg').forEach(s => s.addEventListener('click', () => renderInsights(s.dataset.tab)));

/* onboarding */
$('#onb-next').addEventListener('click', () => {
  const slides = $('#onb-slides').children;
  if (onbIndex < slides.length - 1) { onbIndex++; renderOnboarding(); }
  else closeOnboarding();
});
$('#onb-skip').addEventListener('click', closeOnboarding);

/* theme toggle */
$('#dark-toggle').addEventListener('change', () => applyTheme($('#dark-toggle').checked ? 'dark' : 'light'));

/* goal edit */
$('#goal-edit').addEventListener('click', () => {
  openModal('Set your 30-day target', `
    <p style="color:var(--text-2)">A realistic reduction is 5–10% of your 30-day usage. Target is measured in kWh over the dataset window.</p>
    <div class="form-row">
      <label for="goal-input">Target (kWh, 30 days)</label>
      <input id="goal-input" class="input" type="number" min="1" max="2000" value="${GOAL.targetKwh.toFixed(0)}">
    </div>
    <div class="rec-actions">
      <button class="btn-why" id="save-goal">Save</button>
    </div>`);
  $('#save-goal').addEventListener('click', () => {
    const v = parseFloat($('#goal-input').value);
    if (v > 0) {
      GOAL.targetKwh = v;
      GOAL.overKwh = Math.max(0, +(monthUsed - v).toFixed(1));
      GOAL.remainingKwh = Math.max(0, +(v - monthUsed).toFixed(1));
      localStorage.setItem('se-goal-target', v);
      closeModal(); renderHome(); renderGoals();
    }
  });
});

/* sidebar / backdrop / esc / offline */
$$('[data-open-sidebar]').forEach(b => b.addEventListener('click', openSidebar));
$('#side-backdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeAddFlow(); closeNotifs(); closeSidebar(); }
});
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => setOffline(false));

/* init */
document.addEventListener('DOMContentLoaded', boot);