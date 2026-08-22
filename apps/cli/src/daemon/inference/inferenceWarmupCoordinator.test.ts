import { describe, expect, it, vi } from 'vitest';

import { createInferenceWarmupCoordinator } from './inferenceWarmupCoordinator';

describe('inferenceWarmupCoordinator', () => {
  it('singleflights concurrent warm calls for the same model', async () => {
    const loader = vi.fn(async () => ({ id: 'm1' }));
    const coordinator = createInferenceWarmupCoordinator();

    const [first, second] = await Promise.all([
      coordinator.warm('m1', loader),
      coordinator.warm('m1', loader),
    ]);

    expect(first).toEqual({ id: 'm1' });
    expect(second).toEqual({ id: 'm1' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(coordinator.isWarm('m1')).toBe(true);
  });

  it('releases warm models and cancels their pending residency timer', async () => {
    const timerToken = { id: 'timer-1' } as unknown as ReturnType<typeof setTimeout>;
    let scheduledRelease: (() => void) | null = null;
    const scheduleRelease = Object.assign(
      ((handler: Parameters<typeof setTimeout>[0], __?: number) => {
        scheduledRelease = handler as () => void;
        return timerToken;
      }) as typeof setTimeout,
      { __promisify__: setTimeout.__promisify__ },
    );
    const cancelRelease = vi.fn();
    const onRelease = vi.fn(async () => {});
    const loader = vi.fn(async () => ({ id: 'm1' }));
    const coordinator = createInferenceWarmupCoordinator({
      residencyMs: 1_000,
      scheduleRelease,
      cancelRelease,
      onRelease,
    });

    await coordinator.warm('m1', loader);
    expect(coordinator.isWarm('m1')).toBe(true);

    await coordinator.release('m1');

    expect(cancelRelease).toHaveBeenCalledWith(timerToken);
    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
    expect(coordinator.isWarm('m1')).toBe(false);

    await coordinator.warm('m1', loader);
    expect(loader).toHaveBeenCalledTimes(2);

    const releaseHandler: () => void =
      scheduledRelease ??
      (() => {
        throw new Error('scheduled_release_missing');
      });
    releaseHandler();
    await Promise.resolve();

    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
    expect(coordinator.isWarm('m1')).toBe(false);
  });

  it('evicts the least-recently-used warm model when the loaded-byte budget is exceeded', async () => {
    const onRelease = vi.fn(async () => {});
    const bytesByModel: Record<string, number> = { a: 100, b: 200 };
    const coordinator = createInferenceWarmupCoordinator<{ id: string }>({
      maxLoadedBytes: 250,
      resolveLoadedBytes: (modelId) => bytesByModel[modelId] ?? 0,
      onRelease,
    });

    await coordinator.warm('a', async () => ({ id: 'a' })); // 100 loaded bytes
    await coordinator.warm('b', async () => ({ id: 'b' })); // total 300 > 250, evict LRU 'a'

    expect(onRelease).toHaveBeenCalledWith('a', { id: 'a' });
    expect(coordinator.isWarm('a')).toBe(false);
    expect(coordinator.isWarm('b')).toBe(true);
    expect(coordinator.loadedBytes()).toBe(200);
  });

  it('treats a fresh warm/touch as most-recently-used so the older model is evicted first', async () => {
    const onRelease = vi.fn(async () => {});
    const coordinator = createInferenceWarmupCoordinator<{ id: string }>({
      maxLoadedBytes: 250,
      resolveLoadedBytes: () => 100,
      onRelease,
    });

    await coordinator.warm('a', async () => ({ id: 'a' }));
    await coordinator.warm('b', async () => ({ id: 'b' }));
    // Touch 'a' so it becomes most-recently-used.
    await coordinator.warm('a', async () => ({ id: 'a' }));
    // Loading 'c' pushes loaded bytes to 300 > 250, LRU is now 'b'.
    await coordinator.warm('c', async () => ({ id: 'c' }));

    expect(onRelease).toHaveBeenCalledWith('b', { id: 'b' });
    expect(coordinator.isWarm('a')).toBe(true);
    expect(coordinator.isWarm('b')).toBe(false);
    expect(coordinator.isWarm('c')).toBe(true);
  });

  it('never evicts a model reported as in-use even when it is the least-recently-used', async () => {
    const onRelease = vi.fn(async () => {});
    const inUse = new Set<string>(['a']);
    const coordinator = createInferenceWarmupCoordinator<{ id: string }>({
      maxLoadedBytes: 250,
      resolveLoadedBytes: () => 100,
      isInUse: (modelId) => inUse.has(modelId),
      onRelease,
    });

    await coordinator.warm('a', async () => ({ id: 'a' })); // LRU but in-use
    await coordinator.warm('b', async () => ({ id: 'b' })); // total 200 <= 250, no eviction
    await coordinator.warm('c', async () => ({ id: 'c' })); // total 300 > 250; LRU 'a' is in-use -> evict next-LRU 'b'

    // 'a' is mid-inference and must survive; the budget is honored by evicting 'b' instead.
    expect(onRelease).not.toHaveBeenCalledWith('a', { id: 'a' });
    expect(onRelease).toHaveBeenCalledWith('b', { id: 'b' });
    expect(coordinator.isWarm('a')).toBe(true);
    expect(coordinator.isWarm('b')).toBe(false);
    expect(coordinator.isWarm('c')).toBe(true);
  });

  it('never evicts an in-use model when the idle residency timer fires, and releases it once idle (L2)', async () => {
    vi.useFakeTimers();
    try {
      const onRelease = vi.fn(async () => {});
      const inUse = new Set<string>(['a']);
      const coordinator = createInferenceWarmupCoordinator<{ id: string }>({
        residencyMs: 1_000,
        isInUse: (modelId) => inUse.has(modelId),
        onRelease,
      });

      await coordinator.warm('a', async () => ({ id: 'a' }));
      expect(coordinator.isWarm('a')).toBe(true);

      // The idle timer fires while 'a' is mid-inference: it must NOT be evicted (symmetric with
      // the memory-budget LRU's isInUse skip). The timer re-arms for another residency window.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRelease).not.toHaveBeenCalled();
      expect(coordinator.isWarm('a')).toBe(true);

      // Once the lease is dropped, the re-armed idle timer releases the now-idle model.
      inUse.delete('a');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRelease).toHaveBeenCalledWith('a', { id: 'a' });
      expect(coordinator.isWarm('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a model if release happens while warm is still in flight', async () => {
    let resolveLoader!: (value: { id: string }) => void;
    const loader = vi.fn(async () => await new Promise<{ id: string }>((resolve) => {
      resolveLoader = resolve;
    }));
    const onRelease = vi.fn(async () => {});
    const coordinator = createInferenceWarmupCoordinator({
      onRelease,
    });

    const warmPromise = coordinator.warm('m1', loader);
    await Promise.resolve();

    await coordinator.release('m1');
    resolveLoader({ id: 'm1' });
    await expect(warmPromise).resolves.toEqual({ id: 'm1' });
    await Promise.resolve();

    expect(coordinator.isWarm('m1')).toBe(false);
    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
  });
});
