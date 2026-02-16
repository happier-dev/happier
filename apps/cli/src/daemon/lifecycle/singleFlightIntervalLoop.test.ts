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
});
