// Filters for smoothing shaky 2D pointer input. Each one takes samples one at
// a time ({ t: seconds, x, y }) and returns the smoothed point, so the same
// code works live while drawing and in batch over a recorded stroke.

export class MovingAverage {
  constructor({ window = 8 } = {}) {
    this.window = Math.max(1, Math.round(window));
    this.buffer = [];
    this.sumX = 0;
    this.sumY = 0;
  }

  next(s) {
    this.buffer.push(s);
    this.sumX += s.x;
    this.sumY += s.y;
    if (this.buffer.length > this.window) {
      const old = this.buffer.shift();
      this.sumX -= old.x;
      this.sumY -= old.y;
    }
    const n = this.buffer.length;
    return { t: s.t, x: this.sumX / n, y: this.sumY / n };
  }
}

export class Exponential {
  constructor({ alpha = 0.25 } = {}) {
    this.alpha = alpha;
    this.p = null;
  }

  next(s) {
    if (!this.p) this.p = { x: s.x, y: s.y };
    else {
      this.p.x += this.alpha * (s.x - this.p.x);
      this.p.y += this.alpha * (s.y - this.p.y);
    }
    return { t: s.t, x: this.p.x, y: this.p.y };
  }
}

// Smoothing factor of a first-order low-pass filter with the given cutoff (Hz).
function smoothing(dt, cutoff) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

// The 1€ filter (Casiez, Roussel & Vogel, CHI 2012). It is a low-pass filter
// whose cutoff rises with speed: heavy smoothing when the hand is nearly still
// (where jitter is most visible), light smoothing during fast moves (where lag
// is most visible).
class OneEuro1D {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  next(x, dt) {
    if (this.x === null) { this.x = x; return x; }
    const rawSpeed = (x - this.x) / dt;
    this.dx += smoothing(dt, this.dCutoff) * (rawSpeed - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothing(dt, cutoff) * (x - this.x);
    return this.x;
  }
}

export class OneEuro {
  constructor({ minCutoff = 1, beta = 0.01, dCutoff = 1 } = {}) {
    this.fx = new OneEuro1D(minCutoff, beta, dCutoff);
    this.fy = new OneEuro1D(minCutoff, beta, dCutoff);
    this.t = null;
  }

  next(s) {
    const dt = this.t === null ? 1 / 60 : Math.max(1e-3, s.t - this.t);
    this.t = s.t;
    return { t: s.t, x: this.fx.next(s.x, dt), y: this.fy.next(s.y, dt) };
  }
}

// Constant-velocity Kalman filter, one per axis. State is [position, velocity].
// `q` is how much the velocity is allowed to change (process noise), `r` is
// how noisy each measurement is (in px²).
class Kalman1D {
  constructor(q, r) {
    this.q = q;
    this.r = r;
    this.pos = null;
  }

  next(z, dt) {
    if (this.pos === null) {
      this.pos = z;
      this.vel = 0;
      this.P = [this.r, 0, 0, 1e4];
      return z;
    }
    // Predict: x = F x, P = F P Fᵀ + Q
    const pos = this.pos + this.vel * dt;
    const vel = this.vel;
    let [a, b, c, d] = this.P;
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt;
    a = a + dt * (b + c) + dt2 * d + this.q * dt4 / 4;
    b = b + dt * d + this.q * dt3 / 2;
    c = c + dt * d + this.q * dt3 / 2;
    d = d + this.q * dt2;
    // Update with the measured position.
    const s = a + this.r;
    const k0 = a / s, k1 = c / s;
    const innovation = z - pos;
    this.pos = pos + k0 * innovation;
    this.vel = vel + k1 * innovation;
    this.P = [(1 - k0) * a, (1 - k0) * b, c - k1 * a, d - k1 * b];
    return this.pos;
  }
}

export class Kalman {
  constructor({ q = 1e6, r = 40 } = {}) {
    this.fx = new Kalman1D(q, r);
    this.fy = new Kalman1D(q, r);
    this.t = null;
  }

  next(s) {
    const dt = this.t === null ? 1 / 60 : Math.max(1e-3, s.t - this.t);
    this.t = s.t;
    return { t: s.t, x: this.fx.next(s.x, dt), y: this.fy.next(s.y, dt) };
  }
}

export function run(FilterClass, params, samples) {
  const f = new FilterClass(params);
  return samples.map((s) => f.next(s));
}

// Notch filter: removes a narrow band around one frequency and passes the
// rest. A tremor is close to periodic, so cutting just its frequency removes
// most of the shake while leaving slower, deliberate movement nearly
// untouched. Coefficients follow the RBJ audio cookbook and are recomputed
// per sample because pointer events don't arrive at a fixed rate.
class Notch1D {
  constructor(freq, q) {
    this.freq = freq;
    this.q = q;
    this.x1 = this.x2 = this.y1 = this.y2 = null;
  }

  next(x, dt) {
    if (this.x1 === null) { this.x1 = this.x2 = this.y1 = this.y2 = x; return x; }
    const w0 = Math.min(2 * Math.PI * this.freq * dt, Math.PI * 0.98);
    const alpha = Math.sin(w0) / (2 * this.q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    const y = (x - 2 * cos * this.x1 + this.x2 + 2 * cos * this.y1 - (1 - alpha) * this.y2) / a0;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export class Notch {
  constructor({ freq = 5, q = 0.7 } = {}) {
    this.fx = new Notch1D(freq, q);
    this.fy = new Notch1D(freq, q);
    this.t = null;
  }

  next(s) {
    const dt = this.t === null ? 1 / 60 : Math.max(1e-3, s.t - this.t);
    this.t = s.t;
    return { t: s.t, x: this.fx.next(s.x, dt), y: this.fy.next(s.y, dt) };
  }
}
