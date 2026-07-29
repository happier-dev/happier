import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServicesProjectionRetryScheduler';

describe('connected-services projection retry scheduler', () => {
  it('runs one coalesced successor after the current work settles without overlapping it', async () => {
    const first = createDeferred<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = createConnectedServicesProjectionRetryScheduler();

    scheduler.schedule(async () => {
      calls.push('A:start');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await first.promise;
      active -= 1;
      calls.push('A:end');
    }, { runImmediately: true });
    await vi.waitFor(() => expect(calls).toEqual(['A:start']));

    scheduler.schedule(async () => {
      calls.push('B');
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    }, { runImmediately: true });
    scheduler.schedule(async () => {
      calls.push('B');
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    }, { runImmediately: true });

    first.resolve();
    await scheduler.waitForIdle();

    expect(calls).toEqual(['A:start', 'A:end', 'B']);
    expect(maxActive).toBe(1);
  });

  it('coalesces failures, backs off, retries until success, and resets after settlement', async () => {
    vi.useFakeTimers();
    try {
      const work = vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined);
      const scheduler = createConnectedServicesProjectionRetryScheduler({
        baseDelayMs: 100,
        maxDelayMs: 1_000,
      });

      scheduler.schedule(work);
      scheduler.schedule(work);
      await vi.advanceTimersByTimeAsync(99);
      expect(work).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(work).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(199);
      expect(work).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(work).toHaveBeenCalledTimes(2);
      expect(scheduler.hasPendingWork()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending retry and ignores late completion from the cancelled epoch', async () => {
    vi.useFakeTimers();
    try {
      const pendingWork = createDeferred<void>();
      const work = vi.fn(() => pendingWork.promise);
      const scheduler = createConnectedServicesProjectionRetryScheduler({ baseDelayMs: 10, maxDelayMs: 100 });
      scheduler.schedule(work);
      await vi.advanceTimersByTimeAsync(10);
      expect(work).toHaveBeenCalledOnce();

      scheduler.cancel();
      pendingWork.reject(new Error('late failure'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(work).toHaveBeenCalledOnce();
      expect(scheduler.hasPendingWork()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts current work and keeps cancellation non-quiescent until that work settles', async () => {
    const settled = createDeferred<void>();
    let observedSignal: AbortSignal | null = null;
    const scheduler = createConnectedServicesProjectionRetryScheduler();
    scheduler.schedule(async (signal) => {
      observedSignal = signal;
      await settled.promise;
    }, { runImmediately: true });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());

    scheduler.cancel();
    let idle = false;
    const quiescence = scheduler.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();

    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(idle).toBe(false);
    expect(scheduler.hasPendingWork()).toBe(true);

    settled.resolve();
    await quiescence;
    expect(scheduler.hasPendingWork()).toBe(false);
  });

  it('does not let a cancelled older failure re-arm after a newer successful request', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred<void>();
      const calls: string[] = [];
      const scheduler = createConnectedServicesProjectionRetryScheduler({ baseDelayMs: 10, maxDelayMs: 100 });
      scheduler.schedule(async () => {
        calls.push('A');
        await first.promise;
      }, { runImmediately: true });
      await vi.waitFor(() => expect(calls).toEqual(['A']));

      scheduler.cancel();
      scheduler.schedule(async () => {
        calls.push('B');
      }, { runImmediately: true });
      first.reject(new Error('cancelled A failed late'));
      await scheduler.waitForIdle();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(calls).toEqual(['A', 'B']);
      expect(scheduler.hasPendingWork()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes terminally, aborts current work, and ignores every later schedule', async () => {
    const current = createDeferred<void>();
    const calls: string[] = [];
    let signal: AbortSignal | null = null;
    const scheduler = createConnectedServicesProjectionRetryScheduler();
    scheduler.schedule(async (workSignal) => {
      calls.push('current');
      signal = workSignal;
      await current.promise;
    }, { runImmediately: true });
    await vi.waitFor(() => expect(calls).toEqual(['current']));

    scheduler.close();
    scheduler.schedule(async () => {
      calls.push('late');
    }, { runImmediately: true });
    let idle = false;
    const quiescence = scheduler.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();

    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(idle).toBe(false);
    current.resolve();
    await quiescence;
    scheduler.schedule(async () => {
      calls.push('after-idle');
    }, { runImmediately: true });
    await Promise.resolve();
    expect(calls).toEqual(['current']);
    expect(scheduler.hasPendingWork()).toBe(false);
  });
});
