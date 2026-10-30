// Tremor simulation, the spiral test, scoring and a small spectrum analyser.

// Seeded random numbers, so a simulated stroke can be replayed exactly.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A rest tremor is a fairly regular oscillation, typically 4–6 Hz in
// Parkinson's. Its strength drifts a little over time, and the two axes are
// out of phase, so the hand traces a small ellipse. A little sensor noise
// is added on top.
export function makeTremor({ freq = 5, amp = 6, seed = 7 } = {}) {
  const rand = rng(seed);
  const phase = rand() * Math.PI * 2;
  const drift = 0.3 + rand() * 0.3;
  return (t) => {
    const envelope = 1 + 0.25 * Math.sin(2 * Math.PI * drift * t);
    const w = 2 * Math.PI * freq * t + phase;
    return {
      dx: amp * envelope * Math.sin(w) + 0.5 * gaussian(rand),
      dy: amp * 0.8 * envelope * Math.sin(w + 1.1) + 0.5 * gaussian(rand),
    };
  };
}

// Archimedean spiral r = b·θ, the shape used in the classic spiral-drawing
// test for tremor.
export function spiral(cx, cy, radius, turns = 3) {
  const maxTheta = turns * 2 * Math.PI;
  return { cx, cy, b: radius / maxTheta, maxTheta };
}

export function spiralPoint(sp, theta) {
  const r = sp.b * theta;
  return { x: sp.cx + r * Math.cos(theta), y: sp.cy + r * Math.sin(theta) };
}

// Distance from a point to the spiral, measured along the radius. That is
// close to the true distance when the spiral's arms are far apart.
export function spiralDistance(sp, p) {
  const dx = p.x - sp.cx, dy = p.y - sp.cy;
  const r = Math.hypot(dx, dy);
  let theta = Math.atan2(dy, dx);
  if (theta < 0) theta += 2 * Math.PI;
  let best = Infinity;
  for (let th = theta; th <= sp.maxTheta + 2 * Math.PI; th += 2 * Math.PI) {
    best = Math.min(best, Math.abs(r - sp.b * Math.min(th, sp.maxTheta)));
  }
  return best;
}

// A made-up but realistic attempt at tracing the spiral: uneven speed, a bit
// of slow wander, and pointer events arriving at an irregular ~90 Hz.
export function demoStroke(sp, { seed = 3, seconds = 14 } = {}) {
  const rand = rng(seed);
  const samples = [];
  let t = 0;
  while (t < seconds) {
    const progress = t / seconds;
    const eased = progress * progress * (3 - 2 * progress) * 0.25 + progress * 0.75;
    const theta = eased * sp.maxTheta;
    const p = spiralPoint(sp, theta);
    const wander = 2.2 * Math.sin(1.3 * t + 0.7) + 1.4 * Math.sin(0.55 * t);
    const nx = Math.cos(theta), ny = Math.sin(theta);
    samples.push({ t, cx: p.x + wander * nx, cy: p.y + wander * ny });
    t += (1 / 90) * (0.7 + rand() * 0.6);
  }
  return samples;
}

// --- Scoring -----------------------------------------------------------------

// Average distance between where the filter put the point and where the hand
// was really trying to go. Lag shows up here too, since a late point is a
// wrong point.
export function intentError(filtered, samples) {
  let sum = 0;
  for (let i = 0; i < filtered.length; i++) {
    sum += Math.hypot(filtered[i].x - samples[i].cx, filtered[i].y - samples[i].cy);
  }
  return filtered.length ? sum / filtered.length : NaN;
}

// Splits the error into two parts by sliding the filtered path back in time
// until it lines up best with the intended one. The shift is the lag; what is
// left over after lining up is the shake the filter didn't remove.
export function lagAndWobble(filtered, samples, maxShift = 40) {
  if (filtered.length < maxShift * 2) return { lagMs: NaN, wobble: NaN };
  const meanDt = (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1);
  let bestShift = 0, bestErr = Infinity;
  for (let k = 0; k <= maxShift; k++) {
    let err = 0;
    for (let i = maxShift; i < filtered.length; i++) {
      err += Math.hypot(filtered[i].x - samples[i - k].cx, filtered[i].y - samples[i - k].cy);
    }
    if (err < bestErr) { bestErr = err; bestShift = k; }
  }
  return { lagMs: bestShift * meanDt * 1000, wobble: bestErr / (filtered.length - maxShift) };
}

export function meanSpiralDistance(sp, points) {
  if (!points.length) return NaN;
  let sum = 0;
  for (const p of points) sum += spiralDistance(sp, p);
  return sum / points.length;
}

// --- Spectrum ------------------------------------------------------------------

// Resample the pointer's velocity onto an even 100 Hz grid, then take the
// magnitude spectrum with a Hann window. Velocity instead of position removes
// the slow drawing motion, which would otherwise swamp the low frequencies.
export function spectrum(points, { rate = 100, size = 256 } = {}) {
  if (points.length < 16) return null;
  const end = points[points.length - 1].t;
  const start = Math.max(points[0].t, end - (size - 1) / rate);
  const n = Math.floor((end - start) * rate) + 1;
  if (n < 64) return null;

  const xs = new Float64Array(n), ys = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = start + i / rate;
    while (j < points.length - 2 && points[j + 1].t < t) j++;
    const a = points[j], b = points[j + 1];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    xs[i] = a.x + (b.x - a.x) * f;
    ys[i] = a.y + (b.y - a.y) * f;
  }

  const m = n - 1;
  const bins = Math.floor(m / 2);
  const power = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    let reX = 0, imX = 0, reY = 0, imY = 0;
    for (let i = 0; i < m; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1));
      const vx = (xs[i + 1] - xs[i]) * w, vy = (ys[i + 1] - ys[i]) * w;
      const angle = (-2 * Math.PI * k * i) / m;
      const c = Math.cos(angle), s = Math.sin(angle);
      reX += vx * c; imX += vx * s;
      reY += vy * c; imY += vy * s;
    }
    power[k] = reX * reX + imX * imX + reY * reY + imY * imY;
  }

  let peak = 0;
  for (let k = 1; k < bins; k++) {
    const hz = (k * rate) / m;
    if (hz >= 2 && hz <= 15 && power[k] > power[peak]) peak = k;
  }
  return { power, binHz: rate / m, peakHz: peak ? (peak * rate) / m : NaN };
}
