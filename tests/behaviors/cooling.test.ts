import {describe, expect, it} from 'vitest';
import {Signal} from '../../src';

const microtask = () => Promise.resolve();

/**
 * Cooling — a polyfill-layer attempt to restore the proposal's guarantee that an
 * unwatched computed is garbage-collectable. alien's push core keeps a strong
 * forward edge from a source to every computed that read it (by design —
 * stackblitz/alien-signals#79), so a never-watched computed that is dropped is
 * retained. Cooling parks a standalone-read computed and detaches its dep edges
 * on the next microtask, so it becomes collectable.
 *
 * IMPORTANT — this restoration is ASYNCHRONOUS, and necessarily so: a push-based
 * engine cannot detach synchronously without breaking memoization (a same-tick
 * re-read would recompute; see `pruning.test.ts`). So the forward edge still
 * exists synchronously and is gone only after a microtask. That is weaker than
 * the poll polyfill, which never creates the edge at all (synchronous /
 * structural — "unwatched signals don't create such edges", alxhub,
 * proposal-signals/signal-polyfill#44 comment-2588178926).
 *
 * These tests therefore DOCUMENT the async behavior; they do not assert that it
 * satisfies the proposal. Whether async GC-ability is acceptable for the polyfill
 * — given a native implementation could do this synchronously — is an open
 * question for the maintainers.
 */
describe('unwatched-computed cooling', () => {
  it('synchronously the edge still exists (push core), gone after a microtask', async () => {
    const s = new Signal.State(0);
    {
      const c = new Signal.Computed(() => s.get() + 1);
      c.get();
      expect(Signal.subtle.introspectSinks(s)).toHaveLength(1); // not cooled yet
    }
    await microtask();
    expect(Signal.subtle.introspectSinks(s)).toHaveLength(0); // cooled → GC-able
    expect(Signal.subtle.hasSinks(s)).toBe(false);
  });

  it('cools many throwaway computeds', async () => {
    const s = new Signal.State(0);
    for (let i = 0; i < 1000; i++) {
      const c = new Signal.Computed(() => s.get() + 1);
      c.get();
    }
    await microtask();
    expect(Signal.subtle.introspectSinks(s)).toHaveLength(0);
  });

  it('does NOT cool a watched computed', async () => {
    const s = new Signal.State(0);
    const c = new Signal.Computed(() => s.get() + 1);
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(c);
    c.get();
    await microtask();
    expect(Signal.subtle.introspectSinks(s).length).toBeGreaterThan(0); // live → retained
    w.unwatch(c);
  });

  it('warms up: a cooled computed recomputes with the latest value on next read', async () => {
    const s = new Signal.State(1);
    const c = new Signal.Computed(() => s.get() * 10);
    expect(c.get()).toBe(10);
    await microtask(); // cooled (detached from s)
    s.set(2);
    expect(c.get()).toBe(20); // warms up: recomputes, re-links
    await microtask();
    s.set(3);
    expect(c.get()).toBe(30);
  });

  it('cools a transitive unwatched chain back to the source', async () => {
    const s = new Signal.State(0);
    {
      const a = new Signal.Computed(() => s.get() + 1);
      const b = new Signal.Computed(() => a.get() + 1);
      b.get(); // only b is read at top level; a is read inside b
    }
    await microtask();
    expect(Signal.subtle.introspectSinks(s)).toHaveLength(0); // chain unwound via unwatched cascade
  });
});
