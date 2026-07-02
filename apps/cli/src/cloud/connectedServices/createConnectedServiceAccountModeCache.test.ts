import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceAccountModeCache } from './createConnectedServiceAccountModeCache';

describe('createConnectedServiceAccountModeCache', () => {
  it('backs off refresh reads while a recent account mode failure is fresh', async () => {
    let nowMs = 1_000;
    const cache = createConnectedServiceAccountModeCache({
      errorTtlMs: 30_000,
      nowMs: () => nowMs,
    });
    const getAccountEncryptionMode = vi
      .fn<() => Promise<'plain' | 'e2ee' | 'unknown'>>()
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce('plain');
    const api = { getAccountEncryptionMode };

    await expect(cache.refresh(api)).resolves.toBe('unknown');
    await expect(cache.refresh(api)).resolves.toBe('unknown');
    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);

    nowMs += 30_001;
    await expect(cache.refresh(api)).resolves.toBe('plain');
    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(2);
  });
});
