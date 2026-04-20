import { describe, expect, it, vi } from 'vitest';

import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';

describe('runPreflightSessionControlsProbe', () => {
  it('retries once for authoritative adapters and reports retryable failure when the probe still fails', async () => {
    const probeOnce = vi
      .fn(async (): Promise<ReadonlyArray<string> | null> => null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(runPreflightSessionControlsProbe({
      adapter: { failureCacheStrategy: 'retry' },
      probeOnce,
    })).resolves.toEqual({ kind: 'retryable_failure' });
    expect(probeOnce).toHaveBeenCalledTimes(2);
  });

  it('returns a dynamic success value without retrying when the first probe succeeds', async () => {
    const probeOnce = vi.fn(async (): Promise<readonly string[] | null> => ['default']);

    await expect(runPreflightSessionControlsProbe({
      adapter: { failureCacheStrategy: 'retry' },
      probeOnce,
    })).resolves.toEqual({ kind: 'success', value: ['default'] });
    expect(probeOnce).toHaveBeenCalledTimes(1);
  });
});
