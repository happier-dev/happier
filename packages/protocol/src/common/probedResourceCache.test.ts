import { describe, expect, it, vi } from 'vitest';

import { ProbedResourceCache } from './probedResourceCache.js';

describe('ProbedResourceCache', () => {
  it('keeps existing data while refreshing (SWR)', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<string>({
      staleTimeMs: 10,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    cache.setSuccess('k', 'old');
    now = 25;

    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p = cache.ensure('k', fetcher);
    const snapDuring = cache.getSnapshot('k');
    expect(snapDuring.phase).toBe('refreshing');
    expect(snapDuring.data).toBe('old');

    resolveFetch('new');
    await p;

    const snapAfter = cache.getSnapshot('k');
    expect(snapAfter.phase).toBe('idle');
    expect(snapAfter.data).toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent refreshes per key', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<number>({
      staleTimeMs: 0,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    let resolveFetch!: (v: number) => void;
    const fetcher = vi.fn(
      async () =>
        await new Promise<number>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = cache.ensure('k', fetcher);
    const p2 = cache.ensure('k', fetcher);

    expect(cache.getSnapshot('k').phase).toBe('loading');
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(42);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(42);
    expect(b).toBe(42);
  });

  it('respects error cooldown for auto refresh; force bypasses', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<string>({
      staleTimeMs: 0,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    const failingFetcher = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(cache.ensure('k', failingFetcher)).resolves.toBeNull();
    expect(failingFetcher).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot('k').error).toBeTruthy();

    now = 50;
    const succeedingFetcher = vi.fn(async () => 'ok');
    await expect(cache.ensure('k', succeedingFetcher)).resolves.toBeNull();
    expect(succeedingFetcher).toHaveBeenCalledTimes(0);

    await expect(cache.ensure('k', succeedingFetcher, { force: true })).resolves.toBe('ok');
    expect(succeedingFetcher).toHaveBeenCalledTimes(1);
  });

  it('exposes keys for invalidation helpers', () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 10, errorCooldownMs: 10, nowMs: () => 100 });
    cache.setSuccess('a', 'x');
    cache.setError('b', new Error('nope'));
    expect(Array.from(cache.keys()).sort()).toEqual(['a', 'b']);
  });
});
