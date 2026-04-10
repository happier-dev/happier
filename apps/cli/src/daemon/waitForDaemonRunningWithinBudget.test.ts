import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForDaemonRunningWithinBudget } from './waitForDaemonRunningWithinBudget';

describe('waitForDaemonRunningWithinBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks once more after the final sleep before giving up on the budget', async () => {
    const isRunning = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => undefined);

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      timeoutMs: 200,
      pollMs: 100,
      sleep,
    })).resolves.toBe(true);

    expect(isRunning).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });
});
