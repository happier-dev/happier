import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKeyedSingleFlightScheduler } from './createKeyedSingleFlightScheduler';

describe('createKeyedSingleFlightScheduler', () => {
  function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most once for the same key when scheduled multiple times before the delay', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const run = vi.fn(async () => {});

    scheduler.schedule('a', run);
    scheduler.schedule('a', run);
    scheduler.schedule('a', run);

    await vi.runAllTimersAsync();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not start a second run for the same key while the first run is in-flight', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });

    const deferred = createDeferredVoid();
    const run = vi.fn(async () => {
      await deferred.promise;
    });

    scheduler.schedule('a', run);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule('a', run);
    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await vi.runAllTimersAsync();

    scheduler.schedule('a', run);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel prevents a scheduled run from starting', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const run = vi.fn(async () => {});

    scheduler.schedule('a', run);
    scheduler.cancel('a');

    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(0);
  });

  it('limits concurrent runs across keys', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 0, maxConcurrent: 1 });

    const deferredA = createDeferredVoid();
    const runA = vi.fn(async () => {
      await deferredA.promise;
    });

    const runB = vi.fn(async () => {});

    scheduler.schedule('a', runA);
    scheduler.schedule('b', runB);

    await vi.runAllTimersAsync();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(0);

    deferredA.resolve();
    await vi.runAllTimersAsync();

    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('shares the same result promise for duplicate result schedules', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const deferred = createDeferred<string>();
    const run = vi.fn(async () => deferred.promise);

    const first = scheduler.scheduleResult('a', run);
    const second = scheduler.scheduleResult('a', run);

    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    deferred.resolve('ok');
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
  });

  it('limits concurrent result runs across keys', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 0, maxConcurrent: 1 });
    const deferredA = createDeferred<string>();
    const runA = vi.fn(async () => deferredA.promise);
    const runB = vi.fn(async () => 'b');

    const first = scheduler.scheduleResult('a', runA);
    const second = scheduler.scheduleResult('b', runB);

    await vi.runAllTimersAsync();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(0);

    deferredA.resolve('a');
    await expect(first).resolves.toBe('a');
    await vi.runAllTimersAsync();

    await expect(second).resolves.toBe('b');
    expect(runB).toHaveBeenCalledTimes(1);
  });
});
