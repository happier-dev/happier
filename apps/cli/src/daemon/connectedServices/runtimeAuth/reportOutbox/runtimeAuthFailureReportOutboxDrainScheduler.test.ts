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

  it('coalesces duplicate schedules into one outbox drain', async () => {
    const drain = vi.fn(async () => ({ delivered: 1, dropped: 0, retried: 0 }));

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

    expect(drain).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(drain).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledWith({
      outboxDir: '/tmp/outbox',
      limit: 8,
    });
  });

  it('backs off and retries when daemon intake keeps queued reports retryable', async () => {
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

  it('stops after three automatic attempts and allows a later trigger to retry the retained item', async () => {
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
});
