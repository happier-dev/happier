import { describe, expect, it, vi } from 'vitest';

import { startSingleFlightIntervalLoop } from './singleFlightIntervalLoop';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((res) => {
    resolve = () => res();
  });
  if (!resolve) {
    throw new Error('Failed to create deferred');
  }
  return { promise, resolve };
}

describe('startSingleFlightIntervalLoop', () => {
  it('never overlaps task executions (single-flight)', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const second = createDeferred();
      let callCount = 0;
      const task = vi.fn(
        () => {
          callCount += 1;
          return callCount === 1 ? first.promise : second.promise;
        },
      );

      startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      first.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling new ticks after stop()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be triggered manually without waiting for the interval', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses interval scheduling until resume()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      loop.pause();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).not.toHaveBeenCalled();

      loop.resume();
      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unrefs the interval handle when requested', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
      unref,
    } as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    try {
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task: async () => {},
        unref: true,
      });

      expect(unref).toHaveBeenCalledTimes(1);
      loop.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('backs off automatic retries after failures and resets after success', async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = true;
      const task = vi.fn(async () => {
        if (shouldFail) {
          throw new Error('temporary outage');
        }
      });

      const loop = startSingleFlightIntervalLoop({
        intervalMs: 50,
        failureBackoffMs: 100,
        maxFailureBackoffMs: 100,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90);
      expect(task).toHaveBeenCalledTimes(1);

      shouldFail = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(3);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual trigger bypasses failure backoff', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {
        throw new Error('temporary outage');
      });
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        failureBackoffMs: 60_000,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(2);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
