import { describe, expect, it, vi } from 'vitest';

describe('createKeyedLatestWorkScheduler', () => {
  it('retains every pending write across long disconnection when no caller capacity or age bound exists', async () => {
    const { createKeyedLatestWorkScheduler } = await import('./createKeyedLatestWorkScheduler');
    let now = 0;
    let connected = false;
    const writes = new Set<number>();
    const scheduler = createKeyedLatestWorkScheduler<string, number>({
      run: async (_key, payload) => { writes.add(payload); },
      maxConcurrent: 2,
      minKeyIntervalMs: 0,
      now: () => now,
      isConnected: () => connected,
    });
    try {
      for (let index = 0; index < 1_025; index += 1) scheduler.enqueue(`quota:${index}`, index);
      now = 2 * 60 * 60_000;
      scheduler.enqueue('quota:1025', 1_025);
      connected = true;
      scheduler.notifyConnectivityChanged();
      await scheduler.flushAll(1_000);
      expect(writes).toEqual(new Set(Array.from({ length: 1_026 }, (_, index) => index)));
      expect(scheduler.getStats().pendingKeyCount).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });

  it('settles flush waiters when pending work is cancelled or its owner is disposed', async () => {
    const { createKeyedLatestWorkScheduler } = await import('./createKeyedLatestWorkScheduler');
    const writes: number[] = [];
    const scheduler = createKeyedLatestWorkScheduler<string, number>({
      run: async (_key, payload) => { writes.push(payload); },
      maxConcurrent: 1,
      minKeyIntervalMs: 0,
      isConnected: () => false,
    });
    scheduler.enqueue('cancelled', 1);
    scheduler.enqueue('disposed', 2);
    const cancelledFlush = scheduler.flushKey('cancelled', 1_000);
    scheduler.cancelKey('cancelled');
    await expect(cancelledFlush).resolves.toBe(true);
    const disposedFlush = scheduler.flushKey('disposed', 1_000);
    scheduler.dispose();
    await expect(disposedFlush).resolves.toBe(true);
    expect(writes).toEqual([]);
  });

  it('keeps only the latest pending payload for a key and flushes it', async () => {
    const mod = await import('./createKeyedLatestWorkScheduler').catch(() => null);
    expect(mod?.createKeyedLatestWorkScheduler).toBeTypeOf('function');
    if (!mod) return;

    const writes: number[] = [];
    const scheduler = mod.createKeyedLatestWorkScheduler<string, number>({
      run: async (_key, payload) => {
        writes.push(payload);
      },
      maxConcurrent: 1,
      minKeyIntervalMs: 5_000,
      maxKeys: 10,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      now: () => Date.now(),
    });

    expect(scheduler.enqueue('quota:work', 1)).toEqual({ type: 'accepted' });
    expect(scheduler.enqueue('quota:work', 2)).toEqual({ type: 'coalesced' });

    await scheduler.flushAll(100);

    expect(writes).toEqual([2]);
  });

  it('defers work while disconnected and resumes after connectivity changes', async () => {
    let connected = false;
    const writes: string[] = [];
    const mod = await import('./createKeyedLatestWorkScheduler').catch(() => null);
    expect(mod?.createKeyedLatestWorkScheduler).toBeTypeOf('function');
    if (!mod) return;

    const scheduler = mod.createKeyedLatestWorkScheduler<string, string>({
      run: async (_key, payload) => {
        writes.push(payload);
      },
      maxConcurrent: 1,
      minKeyIntervalMs: 0,
      maxKeys: 10,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      isConnected: () => connected,
    });

    scheduler.enqueue('quota:work', 'latest');
    await scheduler.flushAll(20);
    expect(writes).toEqual([]);

    connected = true;
    scheduler.notifyConnectivityChanged();
    await scheduler.flushAll(100);
    expect(writes).toEqual(['latest']);
  });

  it('retains only bounded keys when many distinct keys are enqueued', async () => {
    const mod = await import('./createKeyedLatestWorkScheduler').catch(() => null);
    expect(mod?.createKeyedLatestWorkScheduler).toBeTypeOf('function');
    if (!mod) return;

    const scheduler = mod.createKeyedLatestWorkScheduler<string, string>({
      run: async () => {},
      maxConcurrent: 1,
      minKeyIntervalMs: 1_000,
      maxKeys: 3,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      isConnected: () => false,
    });

    for (let index = 0; index < 10; index += 1) {
      scheduler.enqueue(`quota:${index}`, `payload:${index}`);
    }

    expect(scheduler.getStats().retainedKeyCount).toBeLessThanOrEqual(3);
    expect(scheduler.getStats().pendingKeyCount).toBeLessThanOrEqual(3);
  });

  it('backs off retryable failures and retries the latest payload', async () => {
    let now = 1_000;
    const mod = await import('./createKeyedLatestWorkScheduler').catch(() => null);
    const backoffMod = await import('./createKeyedBackoffTracker').catch(() => null);
    expect(mod?.createKeyedLatestWorkScheduler).toBeTypeOf('function');
    expect(backoffMod?.createKeyedBackoffTracker).toBeTypeOf('function');
    if (!mod || !backoffMod) return;

    const writes: string[] = [];
    const scheduler = mod.createKeyedLatestWorkScheduler<string, string>({
      run: async (_key, payload) => {
        writes.push(payload);
        if (writes.length === 1) throw new Error('retryable');
      },
      maxConcurrent: 1,
      minKeyIntervalMs: 0,
      maxKeys: 10,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      now: () => now,
      backoff: backoffMod.createKeyedBackoffTracker({
        baseDelayMs: 500,
        maxDelayMs: 500,
        jitterRatio: 0,
        now: () => now,
      }),
      shouldRetry: () => true,
    });

    scheduler.enqueue('quota:work', 'first');
    await scheduler.flushAll(20);
    expect(writes).toEqual(['first']);

    scheduler.enqueue('quota:work', 'latest');
    now += 500;
    scheduler.notifyConnectivityChanged();
    await scheduler.flushAll(100);

    expect(writes).toEqual(['first', 'latest']);
  });
  it('waits for a key to settle without polling while its work is parked offline', async () => {
    const { createKeyedLatestWorkScheduler } = await import('./createKeyedLatestWorkScheduler');
    vi.useFakeTimers();
    let connected = false;
    const scheduler = createKeyedLatestWorkScheduler<string, number>({
      run: async () => {}, maxConcurrent: 1, minKeyIntervalMs: 0, isConnected: () => connected,
    });
    try {
      scheduler.enqueue('parked', 1);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      let settled: boolean | null = null;
      void scheduler.flushKey('parked', 60_000).then(value => { settled = value; });
      await vi.advanceTimersByTimeAsync(1_000);
      // One deadline timer for the waiter; no 25 ms re-checks while nothing changes.
      expect({ timersArmed: setTimeoutSpy.mock.calls.length, settled }).toEqual({ timersArmed: 1, settled: null });
      connected = true;
      scheduler.notifyConnectivityChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });
});
