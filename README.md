# Steady

**Try it: https://burthebear.github.io/steady/**

When I was working on [TypeParkinson](https://github.com/BurTheBear/TypeParkinson-CAC), a keyboard for people with Parkinson's, I kept running into the same question: if you want to smooth out a shaky hand, which filter should you use? Steady lets you draw with a simulated tremor (or your real one) and watch six filters try to clean it up, side by side, with numbers.

<img src="assets/screenshot.png" alt="Steady: a spiral traced with a simulated tremor, the raw line in grey and the notch-filtered line in green, with the results table on the right" width="860">

## What it does

In the spiral test you trace an Archimedean spiral, the same shape used in spiral-drawing tests for tremor, and each filter is scored on how far it strays from it. With the simulation on, a 4 to 6 Hz wobble (the usual range for a Parkinson's rest tremor) is added on top of your pointer. That means the page knows exactly what you meant to draw, so it can measure error, lag and leftover wobble separately. It also resamples your input to 100 Hz and runs a Fourier transform to find the strongest shake frequency. The Tune button tries a grid of settings for every filter and keeps the best ones for the stroke you just drew.

## The filters

| Filter | Idea |
|---|---|
| Moving average | Average the last *n* points. |
| Exponential | Move a fixed fraction of the way toward each new point. |
| [1€ filter](https://gery.casiez.net/1euro/) | A low-pass filter whose cutoff rises with speed. It smooths a lot when you're slow and gets out of the way when you're fast. |
| Kalman | Keeps an estimate of position *and* velocity, predicts ahead, then corrects with each reading. |
| Notch | Removes one narrow band of frequencies, ideally the tremor's, and leaves everything else. |
| Adaptive notch | A notch that keeps measuring the tremor's frequency (by counting zero crossings after filtering out the drawing motion) and retunes itself. |

## What I found

On the built-in demo (a 5 Hz, 6 px tremor while tracing the spiral at a normal pace), with each filter tuned by the Tune button:

| | Error (px) | Lag (ms) | Wobble left (px) |
|---|---:|---:|---:|
| No filter | 5.4 | 0 | 5.4 |
| Moving average | 5.4 | 0 | 5.4 |
| Exponential | 5.1 | 11 | 4.7 |
| 1€ filter | 4.6 | 22 | 4.1 |
| Kalman | 3.1 | 0 | 3.1 |
| Notch | 2.0 | 11 | 1.6 |
| Adaptive notch | 2.1 | 11 | 1.8 |

The surprise for me was that the simple filters barely help. When the hand is moving, any filter strong enough to remove a 5 Hz shake is also slow enough to fall behind, and the lag costs about as much accuracy as the shake did. The Kalman filter avoids most of that because it predicts where the hand is going. The notch filter does best, because a tremor is close to one steady frequency, so it can be cut out without slowing everything else down.

### When the tremor drifts

That first test flatters the notch filter, because the simulated tremor stays at exactly 5 Hz. Real tremors drift. So I added a "Drift" slider that moves the frequency up and down over about six seconds, and built an adaptive notch that keeps re-measuring the frequency as it goes. With the drift at ±1.5 Hz:

| | Error (px) | Lag (ms) | Wobble left (px) |
|---|---:|---:|---:|
| No filter | 5.4 | 0 | 5.4 |
| Kalman | 3.2 | 0 | 3.2 |
| Notch (fixed) | 3.8 | 11 | 3.0 |
| Adaptive notch | 2.8 | 11 | 2.3 |

The fixed notch drops behind the Kalman filter once the frequency moves. The adaptive one stays ahead. Its frequency estimate is the weak spot: it uses a half-second window, so when the tremor changes quickly the notch is a little behind. A smarter estimator, maybe a small Kalman filter on the frequency itself, is what I'd try next.

## Running it

```bash
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # filter and signal tests (Node 20+)
```

No libraries. The filters are in `src/filters.js` and the tremor model, scoring and spectrum are in `src/signal.js`.

This is for exploring filters. It isn't a medical tool and doesn't diagnose anything.

MIT license.
