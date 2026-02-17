import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from './bootstrapAccountSettingsContext';

function createCredentialsStub(): Credentials {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

describe('bootstrapAccountSettingsContext', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
  });

  it('does not reuse in-memory settings across servers (different cache paths)', async () => {
    const nowMs = 1_000_000;
    const res1 = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server-a/account.settings.cache.json',
        readCache: async (_path) => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-a',
          settingsVersion: 101,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });
    expect(res1.settingsVersion).toBe(101);

    const res2 = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs: nowMs + 1_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server-b/account.settings.cache.json',
        readCache: async (_path) => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-b',
          settingsVersion: 202,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res2.settingsVersion).toBe(202);
  });

  it('does not reuse in-memory settings across accounts on the same server', async () => {
    const nowMs = 1_000_000;
    const cachePath = '/tmp/server/account.settings.cache.json';

    const res1 = await bootstrapAccountSettingsContext({
      credentials: { ...createCredentialsStub(), token: 'token-a' },
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-a',
          settingsVersion: 101,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });
    expect(res1.settingsVersion).toBe(101);

    const res2 = await bootstrapAccountSettingsContext({
      credentials: { ...createCredentialsStub(), token: 'token-b' },
      mode: 'blocking',
      refresh: 'auto',
      nowMs: nowMs + 1_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-b',
          settingsVersion: 202,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res2.settingsVersion).toBe(202);
  });

  it('uses fresh cache and does not fetch when refresh=auto', async () => {
    const fetchFromServer = vi.fn(async () => ({ settingsCiphertext: null, settingsVersion: 10 }));
    const nowMs = 1_000_000;
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('cache');
    expect(fetchFromServer).not.toHaveBeenCalled();
  });

  it('fetches when cache is stale and refresh=auto (blocking)', async () => {
    const fetchFromServer = vi.fn(async () => ({ settingsCiphertext: 'cipher2', settingsVersion: 11 }));
    const nowMs = 1_000_000;
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 120_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({}),
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('network');
    expect(fetchFromServer).toHaveBeenCalledTimes(1);
  });

  it('fetches even when cache is fresh if refresh=force', async () => {
    const fetchFromServer = vi.fn(async () => ({ settingsCiphertext: null, settingsVersion: 12 }));
    const nowMs = 1_000_000;
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({}),
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('network');
    expect(fetchFromServer).toHaveBeenCalledTimes(1);
  });

  it('still applies network-fetched settings when cache write fails', async () => {
    const nowMs = 1_000_000;
    const applySideEffects = vi.fn();
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: false, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: 'cipher2', settingsVersion: 11 }),
        writeCache: async () => {
          throw new Error('disk full');
        },
        applySideEffects,
      },
    });

    expect(res.source).toBe('network');
    expect(res.settingsVersion).toBe(11);
    expect(res.settings.notificationsSettingsV1.ready).toBe(false);
    expect(applySideEffects).toHaveBeenCalledWith(expect.objectContaining({ source: 'network', settingsVersion: 11 }));
  });

  it('fast mode returns immediately and exposes whenRefreshed for stale cache', async () => {
    const fetchFromServer = vi.fn(async () => ({ settingsCiphertext: null, settingsVersion: 12 }));
    const nowMs = 1_000_000;
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'fast',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 120_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({}),
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('cache');
    expect(res.whenRefreshed).toBeTruthy();
    expect(fetchFromServer).toHaveBeenCalledTimes(1);
    await res.whenRefreshed;
  });
});
