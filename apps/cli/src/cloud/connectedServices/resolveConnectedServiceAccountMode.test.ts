import { describe, expect, it, vi } from 'vitest';

describe('resolveConnectedServiceAccountMode', () => {
  it('dedupes concurrent account mode probes and supports invalidation', async () => {
    const mod = await import('./resolveConnectedServiceAccountMode');
    expect(mod.invalidateConnectedServiceAccountMode).toBeTypeOf('function');

    const getAccountEncryptionMode = vi
      .fn<() => Promise<'plain' | 'e2ee' | 'unknown'>>()
      .mockResolvedValueOnce('plain')
      .mockResolvedValueOnce('e2ee');
    const api = { getAccountEncryptionMode };

    const [first, second] = await Promise.all([
      mod.resolveConnectedServiceAccountMode(api),
      mod.resolveConnectedServiceAccountMode(api),
    ]);
    expect([first, second]).toEqual(['plain', 'plain']);
    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);

    mod.invalidateConnectedServiceAccountMode(api);
    await expect(mod.resolveConnectedServiceAccountMode(api)).resolves.toBe('e2ee');
    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(2);
  });

  it('preserves unknown mode briefly when the server probe fails', async () => {
    const mod = await import('./resolveConnectedServiceAccountMode');
    const getAccountEncryptionMode = vi.fn(async () => 'unknown' as const);
    const api = { getAccountEncryptionMode };

    await expect(mod.resolveConnectedServiceAccountMode(api)).resolves.toBe('unknown');
    await expect(mod.resolveConnectedServiceAccountMode(api)).resolves.toBe('unknown');

    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    mod.invalidateConnectedServiceAccountMode(api);
  });

  it('does not force-refresh account mode immediately after a recent failure', async () => {
    vi.resetModules();
    const mod = await import('./resolveConnectedServiceAccountMode');
    const getAccountEncryptionMode = vi
      .fn<() => Promise<'plain' | 'e2ee' | 'unknown'>>()
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce('plain');
    const api = { getAccountEncryptionMode };

    await expect(mod.resolveConnectedServiceAccountMode(api, { refresh: true })).resolves.toBe('unknown');
    await expect(mod.resolveConnectedServiceAccountMode(api, { refresh: true })).resolves.toBe('unknown');

    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    mod.invalidateConnectedServiceAccountMode(api);
  });
});
