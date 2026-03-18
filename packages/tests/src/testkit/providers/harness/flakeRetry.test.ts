import { describe, expect, it, vi } from 'vitest';

import { runWithFlakeRetry } from './flakeRetry';

describe('runWithFlakeRetry', () => {
  it('runs once when disabled', async () => {
    const runOnce = vi.fn(async (_attempt: 1 | 2) => {});
    await runWithFlakeRetry({
      enabled: false,
      runOnce,
      flakyErrorMessage: 'FLAKY',
    });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(1);
  });

  it('runs once when enabled and first attempt passes', async () => {
    const runOnce = vi.fn(async (_attempt: 1 | 2) => {});
    await runWithFlakeRetry({
      enabled: true,
      runOnce,
      flakyErrorMessage: 'FLAKY',
    });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(1);
  });

  it('throws a flake error when second attempt passes', async () => {
    const firstError = new Error('first failed');
    const runOnce = vi.fn(async (attempt: 1 | 2) => {
      if (attempt === 1) throw firstError;
    });
    await expect(
      runWithFlakeRetry({
        enabled: true,
        runOnce,
        flakyErrorMessage: 'FLAKY: scenario passed on retry',
      }),
    ).rejects.toThrow('FLAKY: scenario passed on retry');
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenNthCalledWith(1, 1);
    expect(runOnce).toHaveBeenNthCalledWith(2, 2);
  });

  it('rethrows the first error when both attempts fail', async () => {
    const firstError = new Error('first failed');
    const secondError = new Error('second failed');
    const runOnce = vi.fn(async (attempt: 1 | 2) => {
      if (attempt === 1) throw firstError;
      throw secondError;
    });
    await expect(
      runWithFlakeRetry({
        enabled: true,
        runOnce,
        flakyErrorMessage: 'FLAKY',
      }),
    ).rejects.toBe(firstError);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});

