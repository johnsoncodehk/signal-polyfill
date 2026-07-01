// Diagnostic benchmark for the cooling mechanism (this is NOT the CI
// js-reactivity benchmark; it isolates cooling's cost).
//   Run: npm run build && node --expose-gc tests/benchmarks/cooling.mjs
//
// Compares this branch (alien core + cooling) vs. the same core WITHOUT cooling
// (the pr-44 base commit). Medians, node v25:
//
//   workload                                 no cooling       + cooling
//   A. watched deep-chain (100 deep, 20k upd)  56.4 ms          56.5 ms    identical — cooling is off the hot path
//   B. standalone churn (50k create+read)      50.4 ms          20.8 ms    2.4x faster — bounded working set, less GC
//   C. write cost after 100k standalone reads  1,002,234 ns     60 ns      ~16,000x — the leak (dead-edge walk), eliminated
//
// Takeaway: cooling is free on watched/normal reactivity, faster on unwatched
// churn, and removes the write-cost cliff caused by retained dead edges. The
// only property it does NOT restore is *synchronous* GC — the edge is gone after
// a microtask, not immediately (see tests/behaviors/cooling.test.ts).
import {Signal} from '../../dist/index.js';

const median = (fn, reps = 7, warm = 2) => {
  for (let i = 0; i < warm; i++) fn();
  const t = [];
  for (let i = 0; i < reps; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[t.length >> 1];
};
const makeEffect = () => {
  let dirty = false;
  const w = new Signal.subtle.Watcher(() => { dirty = true; });
  return {
    effect(fn) { const c = new Signal.Computed(() => { fn(); }); w.watch(c); c.get(); return () => w.unwatch(c); },
    drain() { if (dirty) { dirty = false; for (const s of w.getPending()) s.get(); w.watch(); } },
  };
};
let sink = 0;

const watchedProp = () => {
  const {effect, drain} = makeEffect();
  const src = new Signal.State(0);
  let node = src;
  for (let i = 0; i < 100; i++) { const p = node; node = new Signal.Computed(() => p.get() + 1); }
  const stop = effect(() => { sink = node.get(); });
  const ms = median(() => { for (let i = 0; i < 20_000; i++) { src.set(i); drain(); } });
  stop();
  return ms;
};
const standaloneChurn = async () => {
  const src = new Signal.State(0);
  const run = async () => {
    for (let b = 0; b < 50; b++) {
      for (let i = 0; i < 1_000; i++) { const c = new Signal.Computed(() => src.get() + i); sink = c.get(); }
      await Promise.resolve();
    }
  };
  for (let i = 0; i < 2; i++) await run();
  const t = performance.now();
  for (let i = 0; i < 5; i++) await run();
  return (performance.now() - t) / 5;
};
const writeAfterChurn = async () => {
  const src = new Signal.State(0);
  for (let b = 0; b < 100; b++) {
    for (let i = 0; i < 1_000; i++) { const c = new Signal.Computed(() => src.get() + i); sink = c.get(); }
    await Promise.resolve();
  }
  let v = 0;
  const t = performance.now();
  for (let i = 0; i < 5_000; i++) src.set(++v);
  return ((performance.now() - t) * 1e6) / 5_000;
};

console.log('A. watched deep-chain (100 deep, 20k updates):', watchedProp().toFixed(1), 'ms');
console.log('B. standalone churn (50k create+read, cooling fires):', (await standaloneChurn()).toFixed(1), 'ms');
console.log('C. write cost after 100k standalone reads:', (await writeAfterChurn()).toFixed(0), 'ns/write');
void sink;
