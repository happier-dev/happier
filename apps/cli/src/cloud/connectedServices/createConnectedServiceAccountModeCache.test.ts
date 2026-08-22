import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceAccountModeCache } from './createConnectedServiceAccountModeCache';

describe('createConnectedServiceAccountModeCache', () => {
  it('does not infer E2EE when the Account-mode API is unavailable', async () => {
    const cache = createConnectedServiceAccountModeCache();

    await expect(cache.resolve({})).resolves.toBe('unknown');
    await expect(cache.refresh({})).resolves.toBe('unknown');
  });

  it('forwards refresh to the underlying Account-mode owner instead of accepting its stale cache', async () => {
    const cache = createConnectedServiceAccountModeCache();
    const getAccountEncryptionMode = vi.fn(
      async (options?: Readonly<{ refresh?: boolean }>) =>
        options?.refresh ? 'plain' as const : 'e2ee' as const,
    );
    const api = { getAccountEncryptionMode };

    await expect(cache.resolve(api)).resolves.toBe('e2ee');
    await expect(cache.refresh(api)).resolves.toBe('plain');
    expect(getAccountEncryptionMode).toHaveBeenNthCalledWith(2, {
      refresh: true,
    });
  });

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
