import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import {
  bootstrapAccountSettingsContext,
  resetInMemoryAccountSettingsContextForTests,
} from './bootstrapAccountSettingsContext';
import {
  getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import type { AccountSettingsCache } from './accountSettingsCache';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';

function createCredentials(token: string, secretByte = 1): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(secretByte) },
  };
}

describe('bootstrapAccountSettingsContext active Account scope fence', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
  });

  afterEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    vi.restoreAllMocks();
  });

  it('does not let a late Account A bootstrap replace the active Account B snapshot', async () => {
    const credentialsA = createCredentials('account-a-token');
    const credentialsB = createCredentials('account-b-token');
    const cachePathA = '/tmp/server/account-a/settings.cache.json';
    const cachePathB = '/tmp/server/account-b/settings.cache.json';
    let releaseAccountA!: (raw: Record<string, unknown>) => void;
    const decryptAccountA = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseAccountA = resolve;
    }));
    const writeAccountACache = vi.fn(async () => {});
    const applyAccountASideEffects = vi.fn();

    const pendingAccountA = bootstrapAccountSettingsContext({
      credentials: credentialsA,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => cachePathA,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'account-a-ciphertext' },
          settingsVersion: 3,
        }),
        decryptCiphertext: decryptAccountA,
        writeCache: writeAccountACache,
        applySideEffects: applyAccountASideEffects,
      },
    });
    await vi.waitFor(() => expect(decryptAccountA).toHaveBeenCalledTimes(1));

    const accountB = await bootstrapAccountSettingsContext({
      credentials: credentialsB,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 200,
      deps: {
        resolveCachePath: () => cachePathB,
        readCache: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 5 }),
        decryptCiphertext: async () => ({}),
        writeCache: async () => {},
        applySideEffects: vi.fn(),
      },
    });
    expect(accountB.scopeKey).toBe(createAccountSettingsScopeKey({
      cachePath: cachePathB,
      token: credentialsB.token,
    }));

    releaseAccountA({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' });

    await expect(pendingAccountA).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_SCOPE_CHANGED',
    });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: accountB.scopeKey,
      settingsVersion: 5,
    });
    expect(writeAccountACache).not.toHaveBeenCalled();
    expect(applyAccountASideEffects).not.toHaveBeenCalled();
  });

  it('does not reuse or durably publish retired A settings after A -> B -> A with new encryption material', async () => {
    const accountAOld = createCredentials('account-a-token', 1);
    const accountANew = createCredentials('account-a-token', 2);
    const accountB = createCredentials('account-b-token', 3);
    const accountACachePath = '/tmp/server/account-a/settings.cache.json';
    const accountBCachePath = '/tmp/server/account-b/settings.cache.json';
    const appliedSettings: AccountSettings[] = [];
    const persistedCiphertexts: string[] = [];
    let releaseOldCacheWrite!: () => void;
    const writeCache = vi.fn(async (
      _path: string,
      cache: AccountSettingsCache,
      options?: Readonly<{ shouldCommit?: () => boolean }>,
    ) => {
      const ciphertext = cache.version === 2 && cache.settingsContent?.t === 'encrypted'
        ? cache.settingsContent.c
        : null;
      if (ciphertext === 'old-a') {
        await new Promise<void>((resolve) => {
          releaseOldCacheWrite = resolve;
        });
      }
      if (options?.shouldCommit?.() === false) return;
      if (ciphertext) persistedCiphertexts.push(ciphertext);
    });

    const oldBootstrap = bootstrapAccountSettingsContext({
      credentials: accountAOld,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => accountACachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'old-a' },
          settingsVersion: 3,
        }),
        decryptCiphertext: async () => ({
          sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        }),
        writeCache,
        applySideEffects: ({ settings }) => {
          appliedSettings.push(settings);
        },
      },
    });
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalledTimes(1));

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
      settingsVersion: 7,
      loadedAtMs: 101,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(accountB),
      scopeKey: createAccountSettingsScopeKey({
        cachePath: accountBCachePath,
        token: accountB.token,
      }),
    });

    const newContext = await bootstrapAccountSettingsContext({
      credentials: accountANew,
      mode: 'blocking',
      refresh: 'auto',
      nowMs: 102,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => accountACachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'new-a' },
          settingsVersion: 8,
        }),
        decryptCiphertext: async () => ({
          sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
        }),
        writeCache,
        applySideEffects: ({ settings }) => {
          appliedSettings.push(settings);
        },
      },
    });

    expect(newContext).toMatchObject({
      source: 'network',
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(newContext.settingsSecretsReadKeys).toEqual(
      deriveSettingsSecretsReadKeysForCredentials(accountANew),
    );
    expect(newContext.settingsSecretsReadKeys).not.toEqual(
      deriveSettingsSecretsReadKeysForCredentials(accountAOld),
    );
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: createAccountSettingsScopeKey({
        cachePath: accountACachePath,
        token: accountANew.token,
      }),
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(appliedSettings.at(-1)).toMatchObject({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    releaseOldCacheWrite();
    await expect(oldBootstrap).resolves.toMatchObject({
      settingsVersion: 8,
      settings: expect.objectContaining({
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      }),
    });
    expect(persistedCiphertexts).toEqual(['new-a']);
    expect(appliedSettings.at(-1)).toMatchObject({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    });
  });
});
