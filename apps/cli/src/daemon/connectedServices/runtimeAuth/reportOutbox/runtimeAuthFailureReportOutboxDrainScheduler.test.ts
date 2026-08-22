import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests,
  scheduleRuntimeAuthFailureReportOutboxDrainToDaemon,
} from './runtimeAuthFailureReportOutboxDrainScheduler';

describe('runtimeAuthFailureReportOutboxDrainScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
  });

  afterEach(() => {
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
    vi.useRealTimers();
  });

  it('coalesces duplicate schedules into one outbox drain while active', async () => {
    let resolveDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<{ delivered: number; dropped: number; retried: number }>((resolve) => {
      resolveDrain = () => resolve({ delivered: 1, dropped: 0, retried: 0 });
    }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledOnce();

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(drain).toHaveBeenCalledOnce();

    expect(resolveDrain).toBeTypeOf('function');
    resolveDrain?.();
    await vi.runAllTimersAsync();

    expect(drain).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledWith({
      outboxDir: '/tmp/outbox',
      limit: 8,
    });
  });

  it('backs off and retries when the drain leaves retryable items queued', async () => {
    const drain = vi
      .fn()
      .mockResolvedValueOnce({ delivered: 0, dropped: 0, retried: 1 })
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('reschedules after a failed drain attempt', async () => {
    const drain = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon unavailable'))
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
      logger: { debug: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stops automatic retry at the existing bound while leaving the outbox item for a later trigger', async () => {
    const drain = vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 1 }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      maxAutomaticAttempts: 3,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(200);
    expect(drain).toHaveBeenCalledTimes(3);

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      maxAutomaticAttempts: 3,
      drain,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(4);
  });

  it('keeps retrying within the bounded daemon-replacement horizon', async () => {
    const drain = vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 1 }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await vi.advanceTimersByTimeAsync(20 * (2 ** (attempt - 1)));
    }

    expect(drain).toHaveBeenCalledTimes(8);
  });

  it('unrefs scheduled timers when the timer handle supports it', () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    // Test-only timer shim: enough surface for the scheduler to call `unref`.
    const setTimeoutFn = vi.fn((
      _callback: Parameters<typeof setTimeout>[0],
      _delayMs?: number,
      ..._args: unknown[]
    ) => timer) as unknown as typeof setTimeout;

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
      drain: vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 0 })),
    });

    expect(unref).toHaveBeenCalledOnce();
  });
});
