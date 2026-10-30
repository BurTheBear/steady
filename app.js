import { MovingAverage, Exponential, OneEuro, Kalman, Notch, run } from './src/filters.js';
import {
  spiral, spiralPoint, demoStroke, makeTremor,
  intentError, lagAndWobble, meanSpiralDistance, spectrum,
} from './src/signal.js';

// Everything is stored in a fixed 800×600 space and scaled to the canvas.
const W = 800, H = 600;
const SPIRAL = spiral(W / 2, H / 2, 250, 3);

const FILTERS = [
  {
    id: 'ma', name: 'Moving average', cls: MovingAverage,
    about: 'Averages the last few points. Simple, but always a step behind.',
    params: [{ key: 'window', label: 'Window', min: 1, max: 30, step: 1, value: 4, fmt: (v) => `${v} pts`, grid: [1, 2, 3, 4, 6, 8, 12, 16, 24] }],
  },
  {
    id: 'exp', name: 'Exponential', cls: Exponential,
    about: 'Moves part of the way toward each new point.',
    params: [{ key: 'alpha', label: 'Follow', min: 0.02, max: 1, step: 0.01, value: 0.3, fmt: (v) => v.toFixed(2), grid: [0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1] }],
  },
  {
    id: 'euro', name: '1€ filter', cls: OneEuro,
    about: 'Smooths hard when you move slowly and lightly when you move fast.',
    params: [
      { key: 'minCutoff', label: 'Min cutoff', min: 0.1, max: 5, step: 0.1, value: 0.5, fmt: (v) => `${v.toFixed(1)} Hz`, grid: [0.2, 0.5, 1, 2, 3] },
      { key: 'beta', label: 'Speed boost', min: 0, max: 0.1, step: 0.001, value: 0.01, fmt: (v) => v.toFixed(3), grid: [0, 0.005, 0.01, 0.02, 0.05, 0.1] },
    ],
  },
  {
    id: 'kalman', name: 'Kalman', cls: Kalman,
    about: 'Predicts where the hand is heading, then corrects with each reading.',
    params: [
      { key: 'q', label: 'Agility', min: 3, max: 8, step: 0.1, value: 6, log: true, fmt: (v) => `1e${v.toFixed(1)}`, grid: [4, 5, 6, 7, 8] },
      { key: 'r', label: 'Noise', min: 5, max: 400, step: 5, value: 100, fmt: (v) => `${v} px²`, grid: [10, 30, 60, 100, 200, 400] },
    ],
  },
  {
    id: 'notch', name: 'Notch', cls: Notch,
    about: 'Cuts out just the tremor frequency. It has to know what that is.',
    params: [
      { key: 'freq', label: 'Frequency', min: 2, max: 12, step: 0.1, value: 5, fmt: (v) => `${v.toFixed(1)} Hz`, grid: null },
      { key: 'q', label: 'Narrowness', min: 0.3, max: 6, step: 0.1, value: 2, fmt: (v) => v.toFixed(1), grid: [0.7, 1, 1.5, 2, 3, 4, 6] },
    ],
  },
];

const TREMOR_PARAMS = [
  { key: 'freq', label: 'Frequency', min: 2, max: 12, step: 0.1, value: 5, fmt: (v) => `${v.toFixed(1)} Hz` },
  { key: 'amp', label: 'Strength', min: 0, max: 16, step: 0.5, value: 6, fmt: (v) => `${v.toFixed(1)} px` },
];

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const spec = $('spectrum');
const sctx = spec.getContext('2d');

const state = {
  mode: 'spiral',
  simulate: true,
  showIntent: true,
  tremor: Object.fromEntries(TREMOR_PARAMS.map((p) => [p.key, p.value])),
  seed: 7,
  clean: [],          // [{ t, cx, cy }] where the hand meant to go
  samples: [],        // clean + tremor: [{ t, x, y, cx, cy }]
  outputs: {},        // filter id -> smoothed points
  hidden: new Set(),
  focus: null,        // filter id drawn on top while the others fade
  drawing: null,
  animation: 0,
  tuned: false,
};

const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const paramValue = (p) => (p.log ? 10 ** p.value : p.value);
const paramsOf = (f) => Object.fromEntries(f.params.map((p) => [p.key, paramValue(p)]));

// --- Building the samples ----------------------------------------------------

function rebuildSamples() {
  const tremor = makeTremor({ ...state.tremor, seed: state.seed });
  state.samples = state.clean.map((c) => {
    if (!state.simulate) return { t: c.t, x: c.cx, y: c.cy, cx: c.cx, cy: c.cy };
    const o = tremor(c.t);
    return { t: c.t, x: c.cx + o.dx, y: c.cy + o.dy, cx: c.cx, cy: c.cy };
  });
}

function refilter() {
  for (const f of FILTERS) state.outputs[f.id] = run(f.cls, paramsOf(f), state.samples);
}

function update({ results = true } = {}) {
  rebuildSamples();
  refilter();
  draw();
  if (results) {
    renderResults();
    renderSpectrum();
  }
}

// --- Drawing input -------------------------------------------------------------

function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  stopAnimation();
  canvas.setPointerCapture(e.pointerId);
  state.drawing = { t0: e.timeStamp };
  state.seed = (Math.random() * 1e9) | 0;
  state.clean = [];
  state.tuned = false;
  state.focusBest = true;
  addPoint(e);
  $('hint').hidden = true;
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) addPoint(ev);
  update({ results: false });
});

const finish = () => {
  if (!state.drawing) return;
  state.drawing = null;
  update();
};
canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);

function addPoint(e) {
  const p = toLogical(e);
  const t = Math.max(0, (e.timeStamp - state.drawing.t0) / 1000);
  const last = state.clean[state.clean.length - 1];
  if (last && t <= last.t) return;
  state.clean.push({ t, cx: p.x, cy: p.y });
}

// --- Demo ----------------------------------------------------------------------

function playDemo(animate = true) {
  stopAnimation();
  state.focusBest = true;
  state.mode = 'spiral';
  state.seed = 7;
  state.tuned = false;
  markMode();
  const full = demoStroke(SPIRAL);
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.clean = full;
    update();
    return;
  }
  const start = performance.now();
  const speed = 2.5;
  const step = (now) => {
    const t = ((now - start) / 1000) * speed;
    state.clean = full.filter((s) => s.t <= t);
    const done = state.clean.length === full.length;
    update({ results: done });
    if (!done) state.animation = requestAnimationFrame(step);
    else state.animation = 0;
  };
  state.animation = requestAnimationFrame(step);
}

function stopAnimation() {
  if (state.animation) cancelAnimationFrame(state.animation);
  state.animation = 0;
}

// --- Rendering -------------------------------------------------------------------

function resizeCanvas(c, context) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { w, h, dpr, cssW: r.width, cssH: r.height, context };
}

function path(points, key = 'x') {
  const ky = key === 'x' ? 'y' : 'cy';
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p[key], p[ky]) : ctx.moveTo(p[key], p[ky])));
  ctx.stroke();
}

function draw() {
  const { w, h } = resizeCanvas(canvas);
  ctx.setTransform(w / W, 0, 0, h / H, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (state.mode === 'spiral') {
    ctx.strokeStyle = color('--guide');
    ctx.lineWidth = 16;
    ctx.beginPath();
    for (let th = 0; th <= SPIRAL.maxTheta; th += 0.04) {
      const p = spiralPoint(SPIRAL, th);
      th ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  }

  if (!state.samples.length) return;

  if (state.simulate && state.showIntent) {
    ctx.strokeStyle = color('--intent');
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 4]);
    path(state.samples, 'cx');
    ctx.setLineDash([]);
  }

  if (!state.hidden.has('raw')) {
    ctx.strokeStyle = color('--c-raw');
    ctx.lineWidth = 1.4;
    path(state.samples);
  }

  const order = [...FILTERS].sort((a, b) => (a.id === state.focus) - (b.id === state.focus));
  for (const f of order) {
    if (state.hidden.has(f.id)) continue;
    const dimmed = state.focus && f.id !== state.focus;
    ctx.globalAlpha = dimmed ? 0.18 : 1;
    ctx.strokeStyle = color(`--c-${f.id}`);
    ctx.lineWidth = dimmed ? 1.6 : 2.6;
    path(state.outputs[f.id] || []);
  }
  ctx.globalAlpha = 1;
}

function score(points) {
  const out = { error: NaN, lag: NaN, wobble: NaN, spiral: NaN };
  if (points.length < 2) return out;
  if (state.simulate) {
    out.error = intentError(points, state.samples);
    const lw = lagAndWobble(points, state.samples);
    out.lag = lw.lagMs;
    out.wobble = lw.wobble;
  }
  if (state.mode === 'spiral') out.spiral = meanSpiralDistance(SPIRAL, points);
  return out;
}

// What "best" means depends on what we know. With simulated tremor we know
// the intended path exactly. With a real hand we only know the spiral.
function objective(s) {
  return state.simulate ? s.error : s.spiral;
}

function renderResults() {
  const table = $('results');
  const fmt = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
  const rows = [{ id: 'raw', name: 'No filter', points: state.samples }, ...FILTERS.map((f) => ({ id: f.id, name: f.name, points: state.outputs[f.id] || [] }))];
  const scored = rows.map((r) => ({ ...r, s: score(r.points) }));
  const ranked = scored.filter((r) => r.id !== 'raw' && Number.isFinite(objective(r.s)));
  const best = ranked.length ? ranked.reduce((a, b) => (objective(b.s) < objective(a.s) ? b : a)).id : null;

  if (state.focusBest && best) { state.focus = best; state.focusBest = false; draw(); }

  let html = '<thead><tr><th>Filter</th><th title="Average distance from the intended path">Error</th><th title="How far behind the hand">Lag</th><th title="Shake left after accounting for lag">Wobble</th><th title="Average distance from the spiral">Spiral</th></tr></thead><tbody>';
  for (const r of scored) {
    const cls = [r.id === 'raw' ? 'raw' : '', r.id === best ? 'best' : '', r.id === state.focus ? 'focus' : ''].join(' ');
    html += `<tr class="${cls}" data-id="${r.id}" style="--c: var(--c-${r.id})"><td><span class="dot"></span>${r.name}</td>`;
    html += `<td>${fmt(r.s.error)}</td><td>${fmt(r.s.lag, 0)}</td><td>${fmt(r.s.wobble)}</td><td>${fmt(r.s.spiral)}</td></tr>`;
  }
  table.innerHTML = `${html}</tbody>`;

  let note;
  if (!state.samples.length) note = 'Draw something to see scores.';
  else if (state.simulate) note = 'Distances are in px, lag in ms. Error is the average distance from where your hand was really going.';
  else if (state.mode === 'spiral') note = 'Without simulated tremor there\'s no "intended path" to compare to, so only the spiral score is shown.';
  else note = 'Turn on simulated tremor or switch to the spiral test to get scores.';
  if (state.tuned) note += ' Each filter is now tuned for this stroke.';
  $('resultsNote').textContent = note;
  $('tune').disabled = !state.samples.length || !(state.simulate || state.mode === 'spiral');
}

function renderSpectrum() {
  const { w, h, dpr } = resizeCanvas(spec);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = w / dpr, ch = h / dpr;
  sctx.clearRect(0, 0, cw, ch);
  const maxHz = 15;
  const x = (hz) => (hz / maxHz) * cw;
  const base = ch - 18;

  sctx.fillStyle = color('--band');
  sctx.fillRect(x(4), 0, x(6) - x(4), base);
  sctx.fillStyle = color('--dim');
  sctx.font = '11px "IBM Plex Mono", monospace';
  for (let hz = 0; hz <= maxHz; hz += 5) sctx.fillText(`${hz} Hz`, Math.min(x(hz), cw - 34), ch - 3);

  const s = spectrum(state.samples);
  if (!s) {
    $('peak').textContent = 'Draw for a couple of seconds to see the frequency spectrum.';
    return;
  }
  // Below ~1.5 Hz is the drawing motion itself, so it's left off the chart.
  const first = Math.ceil(1.5 / s.binHz);
  let max = 0;
  for (let k = first; k < s.power.length && k * s.binHz <= maxHz; k++) max = Math.max(max, s.power[k]);
  sctx.strokeStyle = color('--accent');
  sctx.lineWidth = 1.6;
  sctx.beginPath();
  for (let k = first; k < s.power.length && k * s.binHz <= maxHz; k++) {
    const px = x(k * s.binHz), py = base - (s.power[k] / (max || 1)) * (base - 6);
    k === first ? sctx.moveTo(px, py) : sctx.lineTo(px, py);
  }
  sctx.stroke();
  const peak = Number.isFinite(s.peakHz) ? `Strongest shake at ${s.peakHz.toFixed(1)} Hz.` : '';
  $('peak').textContent = `${peak} The shaded band is 4–6 Hz, where a Parkinson's rest tremor usually sits.`;
  state.peakHz = s.peakHz;
}

// --- Controls ----------------------------------------------------------------------

function slider(p, onInput) {
  const row = document.createElement('div');
  row.className = 'param';
  const id = `p-${Math.random().toString(36).slice(2, 8)}`;
  row.innerHTML = `<label for="${id}">${p.label}</label><input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}"><output>${p.fmt(p.value)}</output>`;
  const input = row.querySelector('input'), out = row.querySelector('output');
  input.addEventListener('input', () => {
    p.value = +input.value;
    out.textContent = p.fmt(p.value);
    onInput();
  });
  p.sync = () => { input.value = p.value; out.textContent = p.fmt(p.value); };
  return row;
}

function buildControls() {
  const tremorBox = $('tremorControls');
  for (const p of TREMOR_PARAMS) {
    tremorBox.appendChild(slider(p, () => {
      state.tremor[p.key] = p.value;
      state.tuned = false;
      update();
    }));
  }

  const filterBox = $('filterControls');
  for (const f of FILTERS) {
    const el = document.createElement('div');
    el.className = 'filter';
    el.style.setProperty('--c', `var(--c-${f.id})`);
    el.innerHTML = `<div class="filter-head"><span class="dot"></span><b>${f.name}</b></div><p>${f.about}</p>`;
    if (f.id === 'notch') {
      const match = document.createElement('button');
      match.className = 'link';
      match.textContent = 'Match the measured shake';
      match.onclick = () => {
        if (!Number.isFinite(state.peakHz)) return;
        f.params[0].value = Math.round(state.peakHz * 10) / 10;
        f.params[0].sync();
        update();
      };
      el.querySelector('.filter-head').appendChild(match);
    }
    for (const p of f.params) el.appendChild(slider(p, () => { state.tuned = false; update(); }));
    filterBox.appendChild(el);
  }

  const legend = $('legend');
  for (const item of [{ id: 'raw', name: 'No filter' }, ...FILTERS]) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.setProperty('--c', `var(--c-${item.id})`);
    chip.innerHTML = `<i></i>${item.name}`;
    chip.setAttribute('aria-pressed', 'true');
    chip.onclick = () => {
      const off = !state.hidden.has(item.id);
      off ? state.hidden.add(item.id) : state.hidden.delete(item.id);
      chip.classList.toggle('off', off);
      chip.setAttribute('aria-pressed', String(!off));
      draw();
    };
    legend.appendChild(chip);
  }
}

// Grid search over each filter's settings for the current stroke.
function tune() {
  for (const f of FILTERS) {
    const grids = f.params.map((p) => (p.key === 'freq' && f.id === 'notch'
      ? [state.peakHz, state.tremor.freq].filter(Number.isFinite).map((v) => Math.round(v * 10) / 10)
      : p.grid));
    let best = null;
    const combos = grids.reduce((acc, g) => acc.flatMap((c) => g.map((v) => [...c, v])), [[]]);
    for (const combo of combos) {
      const params = Object.fromEntries(f.params.map((p, i) => [p.key, p.log ? 10 ** combo[i] : combo[i]]));
      const s = score(run(f.cls, params, state.samples));
      const value = objective(s);
      if (Number.isFinite(value) && (!best || value < best.value)) best = { value, combo };
    }
    if (best) f.params.forEach((p, i) => { p.value = best.combo[i]; p.sync(); });
  }
  state.tuned = true;
  update();
}

function markMode() {
  for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === state.mode);
}

$('mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.mode = b.dataset.mode;
  markMode();
  update();
});
$('simulate').addEventListener('change', (e) => { state.simulate = e.target.checked; state.tuned = false; update(); });
$('showIntent').addEventListener('change', (e) => { state.showIntent = e.target.checked; draw(); });
$('demo').onclick = () => playDemo(true);
$('clear').onclick = () => {
  stopAnimation();
  state.clean = [];
  state.tuned = false;
  $('hint').hidden = false;
  update();
};
$('tune').onclick = tune;
$('results').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row || row.dataset.id === 'raw') return;
  state.focus = state.focus === row.dataset.id ? null : row.dataset.id;
  renderResults();
  draw();
});

new ResizeObserver(() => { draw(); renderSpectrum(); }).observe(canvas);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { draw(); renderSpectrum(); });

buildControls();
playDemo(false);
