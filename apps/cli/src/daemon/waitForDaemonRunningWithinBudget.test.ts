import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForDaemonRunningWithinBudget } from './waitForDaemonRunningWithinBudget';

describe('waitForDaemonRunningWithinBudget', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('charges slow readiness probes to the existing wait budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const timeoutMs = 1_000;
      const probeMs = 600;
      const startedAt = Date.now();
      await expect(waitForDaemonRunningWithinBudget({
        isRunning: async () => { vi.advanceTimersByTime(probeMs); return false; },
        timeoutMs,
        pollMs: 100,
        sleep: async (ms) => { vi.advanceTimersByTime(ms); },
      })).resolves.toBe(false);
      // An admitted probe may finish after expiry, but no further polling may start.
      expect(Date.now() - startedAt).toBeLessThanOrEqual(timeoutMs + probeMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs one final readiness check when the timeout budget is exhausted', async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const isRunning = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockImplementation(async (ms) => { elapsedMs += ms; });

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      timeoutMs: 200,
      pollMs: 100,
      sleep,
    })).resolves.toBe(true);

    expect(elapsedMs).toBe(200);
    expect(isRunning).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
