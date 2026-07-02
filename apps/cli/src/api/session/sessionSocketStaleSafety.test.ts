import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionSocketStaleSafetyScheduler } from './sessionSocketStaleSafety';

describe('createSessionSocketStaleSafetyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one safety tick after the configured stale interval', async () => {
    vi.useFakeTimers();
    const runSafetyTick = vi.fn(async () => {});
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => true,
      runSafetyTick,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(99);
    expect(runSafetyTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSafetyTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('does not let inbound updates postpone the bounded stale-safety tick', async () => {
    vi.useFakeTimers();
    const runSafetyTick = vi.fn(async () => {});
    const scheduler = createSessionSocketStaleSafetyScheduler({
      intervalMs: 100,
      random: () => 0,
      isOnline: () => true,
      runSafetyTick,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(80);
    scheduler.recordInboundUpdate();
    await vi.advanceTimersByTimeAsync(19);
    scheduler.recordInboundUpdate();
    expect(runSafetyTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runSafetyTick).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });
});
