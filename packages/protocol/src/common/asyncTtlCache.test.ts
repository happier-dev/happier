import { describe, expect, it } from 'vitest';

import { AsyncTtlCache } from './asyncTtlCache.js';

describe('AsyncTtlCache', () => {
  it('observes native signals without a throwIfAborted method', async () => {
    const cache = new AsyncTtlCache<number>({ successTtlMs: 10, errorTtlMs: 5 });
    const caller = new AbortController();
    // React Native's installed abort-controller boundary exposes events/aborted, not this method.
    Object.defineProperty(caller.signal, 'throwIfAborted', { value: undefined });
    await expect(cache.runDedupe('native', async () => 42, { signal: caller.signal })).resolves.toBe(42);
  });

  it('tracks freshness based on expiresAt', () => {
    const cache = new AsyncTtlCache<string>({ successTtlMs: 10, errorTtlMs: 5 });
    cache.setSuccess('k', 'v', { nowMs: 100, ttlMs: 10 });
    const entry = cache.get('k');
    expect(entry?.kind).toBe('success');
    expect(cache.isFresh(entry!, 109)).toBe(true);
    expect(cache.isFresh(entry!, 110)).toBe(false);
  });

  it('dedupes concurrent runs per key', async () => {
    const cache = new AsyncTtlCache<number>({ successTtlMs: 10, errorTtlMs: 5 });
    let calls = 0;
    const run = async () => {
      calls++;
      await Promise.resolve();
      return 42;
    };

    const [a, b] = await Promise.all([
      cache.runDedupe('k', run),
      cache.runDedupe('k', run),
    ]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });

  it('clears stored entries', () => {
    const cache = new AsyncTtlCache<string>({ successTtlMs: 10, errorTtlMs: 5 });
    cache.setSuccess('a', 'x', { nowMs: 100, ttlMs: 10 });
    cache.setError('b', { nowMs: 100, ttlMs: 10 });
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('b')).not.toBeNull();
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  it('deletes a single key (including inflight)', async () => {
    const cache = new AsyncTtlCache<number>({ successTtlMs: 10, errorTtlMs: 5 });
    cache.setSuccess('k', 1, { nowMs: 100, ttlMs: 10 });
    expect(cache.get('k')?.kind).toBe('success');
    cache.delete('k');
    expect(cache.get('k')).toBeNull();

    let resolveRun!: (v: number) => void;
    const run = () => new Promise<number>((resolve) => { resolveRun = resolve; });
    const p1 = cache.runDedupe('k', run);
    cache.delete('k');
    const p2 = cache.runDedupe('k', async () => 2);
    resolveRun(1);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('exposes cache keys', () => {
    const cache = new AsyncTtlCache<string>({ successTtlMs: 10, errorTtlMs: 5 });
    cache.setSuccess('a', 'x', { nowMs: 100, ttlMs: 10 });
    cache.setError('b', { nowMs: 100, ttlMs: 10 });
    expect(Array.from(cache.keys()).sort()).toEqual(['a', 'b']);
  });

  it('retires abandoned work without letting its completion remove a live replacement', async () => {
    const cache = new AsyncTtlCache<number>({ successTtlMs: 10, errorTtlMs: 5 });
    const caller = new AbortController();
    let releaseOld!: (value: number) => void;
    let releaseNew!: (value: number) => void;
    let oldSignal!: AbortSignal;
    let oldIsCurrent!: () => boolean;
    const old = cache.runDedupe('k', async (context) => {
      oldSignal = context?.signal;
      oldIsCurrent = context?.isCurrent;
      return await new Promise<number>((resolve) => { releaseOld = resolve; });
    }, { signal: caller.signal });
    const cancelled = Promise.race([
      old.then((value) => value, (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 25)),
    ]);
    caller.abort('cancelled');
    expect(await cancelled).toBe('cancelled');
    expect(oldSignal.aborted).toBe(true);
    expect(oldIsCurrent()).toBe(false);
    const replacement = cache.runDedupe('k', async () => await new Promise<number>((resolve) => {
      releaseNew = resolve;
    }));
    releaseOld(1);
    await Promise.resolve();
    await Promise.resolve();
    const joined = cache.runDedupe('k', async () => 99);
    releaseNew(2);
    await expect(Promise.all([replacement, joined])).resolves.toEqual([2, 2]);
  });

  it('keeps shared work alive for a second observer after the first cancels', async () => {
    const cache = new AsyncTtlCache<number>({ successTtlMs: 10, errorTtlMs: 5 });
    const caller = new AbortController();
    let release!: (value: number) => void;
    let transportSignal!: AbortSignal;
    const first = cache.runDedupe('k', async (context) => {
      transportSignal = context?.signal;
      return await new Promise<number>((resolve) => { release = resolve; });
    }, { signal: caller.signal });
    const second = cache.runDedupe('k', async () => 99);
    const cancelled = Promise.race([
      first.then((value) => value, (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 25)),
    ]);
    caller.abort('cancelled');
    expect(await cancelled).toBe('cancelled');
    expect(transportSignal.aborted).toBe(false);
    release(42);
    await expect(second).resolves.toBe(42);
  });
});
