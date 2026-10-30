import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MovingAverage, Exponential, OneEuro, Kalman, Notch, AdaptiveNotch, FrequencyTracker, run } from '../src/filters.js';
import {
  spiral, spiralPoint, spiralDistance, demoStroke, makeTremor,
  intentError, lagAndWobble, meanSpiralDistance, spectrum,
} from '../src/signal.js';

const ALL = [
  [MovingAverage, { window: 6 }],
  [Exponential, { alpha: 0.3 }],
  [OneEuro, { minCutoff: 1, beta: 0.01 }],
  [Kalman, { q: 1e6, r: 100 }],
  [Notch, { freq: 5, q: 2 }],
  [AdaptiveNotch, { q: 3 }],
];

const steady = (n, x = 100, y = 50) => Array.from({ length: n }, (_, i) => ({ t: i / 100, x, y }));

test('every filter leaves a still point where it is', () => {
  for (const [F, p] of ALL) {
    const out = run(F, p, steady(200));
    const last = out[out.length - 1];
    assert.ok(Math.abs(last.x - 100) < 1e-6 && Math.abs(last.y - 50) < 1e-6, F.name);
  }
});

test('every filter settles on a new position after a jump', () => {
  for (const [F, p] of ALL) {
    const samples = [...steady(50), ...steady(400, 300, 200).map((s) => ({ ...s, t: s.t + 0.5 }))];
    const last = run(F, p, samples).at(-1);
    assert.ok(Math.hypot(last.x - 300, last.y - 200) < 0.5, `${F.name} ended at ${last.x.toFixed(1)}, ${last.y.toFixed(1)}`);
  }
});

test('the Kalman filter follows steady motion without falling behind', () => {
  const samples = Array.from({ length: 300 }, (_, i) => ({ t: i / 100, x: 200 * (i / 100), y: 0 }));
  const last = run(Kalman, { q: 1e6, r: 100 }, samples).at(-1);
  assert.ok(Math.abs(last.x - samples.at(-1).x) < 0.5);
});

test('the notch filter removes a sine at its frequency', () => {
  const samples = Array.from({ length: 600 }, (_, i) => {
    const t = i / 100;
    return { t, x: 10 * Math.sin(2 * Math.PI * 5 * t), y: 0 };
  });
  const tail = run(Notch, { freq: 5, q: 2 }, samples).slice(-100);
  const peak = Math.max(...tail.map((p) => Math.abs(p.x)));
  assert.ok(peak < 1, `left ${peak.toFixed(2)} px of a 10 px tremor`);
});

test('spectrum finds the tremor frequency', () => {
  for (const freq of [4, 5, 6.5]) {
    const tremor = makeTremor({ freq, amp: 6, seed: 11 });
    const points = Array.from({ length: 400 }, (_, i) => {
      const t = i / 90;
      const o = tremor(t);
      return { t, x: 300 + o.dx, y: 200 + o.dy };
    });
    const s = spectrum(points);
    assert.ok(Math.abs(s.peakHz - freq) < 0.5, `expected ${freq} Hz, got ${s.peakHz.toFixed(2)}`);
  }
});

test('points on the spiral are at distance zero from it', () => {
  const sp = spiral(0, 0, 200, 3);
  for (const theta of [0.5, 3, 7.5, 12, 18]) {
    assert.ok(spiralDistance(sp, spiralPoint(sp, theta)) < 1e-9);
  }
  assert.ok(Math.abs(spiralDistance(sp, { x: spiralPoint(sp, 9).x * 1.05, y: spiralPoint(sp, 9).y * 1.05 }) - sp.b * 9 * 0.05) < 1e-9);
});

test('on a simulated tremor stroke, the Kalman and notch filters beat raw input', () => {
  const sp = spiral(400, 300, 240, 3);
  const tremor = makeTremor({ freq: 5, amp: 6 });
  const samples = demoStroke(sp).map((s) => {
    const o = tremor(s.t);
    return { ...s, x: s.cx + o.dx, y: s.cy + o.dy };
  });
  const raw = intentError(samples, samples);
  for (const [F, p] of [[Kalman, { q: 1e6, r: 100 }], [Notch, { freq: 5, q: 2 }]]) {
    const out = run(F, p, samples);
    assert.ok(intentError(out, samples) < raw * 0.8, F.name);
    assert.ok(meanSpiralDistance(sp, out) < meanSpiralDistance(sp, samples), F.name);
  }
  const { lagMs, wobble } = lagAndWobble(run(Exponential, { alpha: 0.1 }, samples), samples);
  assert.ok(lagMs > 30, 'heavy exponential smoothing should show clear lag');
  assert.ok(wobble < raw, 'but less wobble');
});

test('the frequency tracker follows a drifting tremor', () => {
  const tremor = makeTremor({ freq: 5, amp: 6, wander: 1, seed: 5 });
  const tracker = new FrequencyTracker();
  let errSum = 0, n = 0;
  for (let i = 0; i < 1200; i++) {
    const t = i / 90;
    const o = tremor(t);
    const f = tracker.next(o.dx + o.dy, t, 1 / 90);
    if (t > 2) { errSum += Math.abs(f - (5 + Math.sin((2 * Math.PI * t) / 6))); n++; }
  }
  assert.ok(errSum / n < 0.5, `average tracking error ${(errSum / n).toFixed(2)} Hz`);
});

test('the adaptive notch beats a fixed notch when the tremor drifts', () => {
  const sp = spiral(400, 300, 250, 3);
  const tremor = makeTremor({ freq: 5, amp: 6, wander: 1.5 });
  const samples = demoStroke(sp).map((s) => {
    const o = tremor(s.t);
    return { ...s, x: s.cx + o.dx, y: s.cy + o.dy };
  });
  const fixed = intentError(run(Notch, { freq: 5, q: 3 }, samples), samples);
  const adaptive = intentError(run(AdaptiveNotch, {}, samples), samples);
  assert.ok(adaptive < fixed, `adaptive ${adaptive.toFixed(2)} vs fixed ${fixed.toFixed(2)}`);
});
