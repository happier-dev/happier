import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';

import {
  bootstrapAccountSettingsContext,
  resetAccountSettingsRefreshBackoff,
  resetInMemoryAccountSettingsContextForTests,
} from './bootstrapAccountSettingsContext';
import { setActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { resolveAccountSettingsCachePath, writeAccountSettingsCacheAtomic } from './accountSettingsCache';
import { normalizeSessionAgentSpawnActionRequest } from '@/session/services/spawn/normalizeSessionAgentSpawnActionRequest';

function createCredentialsStub(): Credentials {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

function createCredentialsWithToken(token: string): Credentials {
  return {
    ...createCredentialsStub(),
    token,
  };
}

function mutableConfigurationForTest(): {
  activeServerDir: string;
  serverUrl: string;
  apiServerUrl: string;
  publicServerUrl: string;
  webappUrl: string;
  clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
} {
  return configuration as unknown as {
    activeServerDir: string;
    serverUrl: string;
    apiServerUrl: string;
    publicServerUrl: string;
    webappUrl: string;
    clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
  };
}

describe('bootstrapAccountSettingsContext', () => {
  const originalActiveServerDir = configuration.activeServerDir;
  const originalServerUrl = configuration.serverUrl;
  const originalApiServerUrl = configuration.apiServerUrl;
  const originalPublicServerUrl = configuration.publicServerUrl;
  const originalWebappUrl = configuration.webappUrl;
  const originalClientEncryptionRequirement = configuration.clientEncryptionRequirement;

  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mutableConfigurationForTest(), {
      activeServerDir: originalActiveServerDir,
      serverUrl: originalServerUrl,
      apiServerUrl: originalApiServerUrl,
      publicServerUrl: originalPublicServerUrl,
      webappUrl: originalWebappUrl,
      clientEncryptionRequirement: originalClientEncryptionRequirement,
    });
  });

  const resolveOmittedAgySelection = () => normalizeSessionAgentSpawnActionRequest({
    credentials: createCredentialsStub(),
    surface: 'session_agent',
    input: { agentId: 'agy', initialMessage: 'Use my saved account' },
    parentMetadata: null,
    currentSession: { path: '/repo', host: 'machine', machineId: 'machine-1' },
  });
  const selectedAgyDefaults = { v: 1, bindingsByAgentId: {
    agy: { v: 1, bindingsByServiceId: {
      antigravity: { source: 'connected', selection: 'profile', profileId: 'saved-google' },
    } },
  } };

  it.each([{ withCache: false, encrypted: false }, { withCache: true, encrypted: false }, { withCache: false, encrypted: true }])('refuses fetched malformed additive defaults with omitted launch selection (cache=$withCache, encrypted=$encrypted)', async ({ withCache, encrypted }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-agy-default-bootstrap-'));
    Object.assign(mutableConfigurationForTest(), { activeServerDir: directory, clientEncryptionRequirement: 'follow_account' });
    try {
      if (withCache) await writeAccountSettingsCacheAtomic(resolveAccountSettingsCachePath(createCredentialsStub()), {
        version: 2, cachedAt: 0, settingsVersion: 1,
        settingsContent: { t: 'plain', v: { connectedServicesAdditionalDefaultAuthByAgentIdV1: selectedAgyDefaults } },
      });
      // HTTP is the system boundary; parsing, bootstrap, disk cache, and launch default resolution are real.
      const malformedSettings = {
        connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
          agy: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'profile' } } },
        } },
      };
      vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        version: 2, content: encrypted
          ? { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32).fill(1), 'legacy', malformedSettings)) }
          : { t: 'plain', v: malformedSettings },
      } });
      await expect(resolveOmittedAgySelection()).rejects.toThrow('connected_services_default_settings_invalid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['network', 'encrypted network', 'cache'] as const)('keeps valid omitted-selection defaults from %s', async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-agy-default-bootstrap-'));
    Object.assign(mutableConfigurationForTest(), { activeServerDir: directory, clientEncryptionRequirement: 'follow_account' });
    try {
      if (source === 'cache') {
        await writeAccountSettingsCacheAtomic(resolveAccountSettingsCachePath(createCredentialsStub()), {
          version: 2, cachedAt: 0, settingsVersion: 1,
          settingsContent: { t: 'plain', v: { connectedServicesAdditionalDefaultAuthByAgentIdV1: selectedAgyDefaults } },
        });
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
      } else {
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
          version: 2, content: source === 'encrypted network'
            ? { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32).fill(1), 'legacy', {
              connectedServicesAdditionalDefaultAuthByAgentIdV1: selectedAgyDefaults,
            })) }
            : { t: 'plain', v: { connectedServicesAdditionalDefaultAuthByAgentIdV1: selectedAgyDefaults } },
        } });
      }
      const result = await resolveOmittedAgySelection();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected selected saved account');
      expect(result.createParams.connectedServices).toEqual(selectedAgyDefaults.bindingsByAgentId.agy);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('resolves the disk cache path from the authenticated credentials', async () => {
    const nowMs = 1_000_000;
    const tokenA = 'token-account-a';
    const tokenB = 'token-account-b';
    const resolveCachePath = vi.fn((credentials: Credentials) => `/tmp/server/${credentials.token}/account.settings.cache.json`);

    const res1 = await bootstrapAccountSettingsContext({
      credentials: createCredentialsWithToken(tokenA),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath,
        readCache: async (path) => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: { t: 'plain', v: { schemaVersion: 6, accountMarker: path.includes(tokenA) ? 'a' : 'wrong' } },
          settingsVersion: path.includes(tokenA) ? 101 : 999,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    const res2 = await bootstrapAccountSettingsContext({
      credentials: createCredentialsWithToken(tokenB),
      mode: 'blocking',
      refresh: 'auto',
      nowMs: nowMs + 1_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath,
        readCache: async (path) => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: { t: 'plain', v: { schemaVersion: 6, accountMarker: path.includes(tokenB) ? 'b' : 'wrong' } },
          settingsVersion: path.includes(tokenB) ? 202 : 999,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: tokenA }));
    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: tokenB }));
    expect(res1.settingsVersion).toBe(101);
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

  it('bypasses a fresh in-memory context when it is below the required minimum version', async () => {
    const nowMs = 1_000_000;
    const fetchFromServer = vi.fn(async () => ({ settingsContent: null, settingsVersion: 7 }));

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: null,
          settingsVersion: 3,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 99 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      minSettingsVersion: 5,
      nowMs: nowMs + 10,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: null,
          settingsVersion: 3,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('network');
    expect(res.settingsVersion).toBe(7);
    expect(fetchFromServer).toHaveBeenCalledTimes(1);
  });

  it('bypasses a fresh disk cache when it is below the required minimum version', async () => {
    const nowMs = 1_000_000;
    const fetchFromServer = vi.fn(async () => ({ settingsContent: null, settingsVersion: 5 }));

    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      minSettingsVersion: 5,
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: null,
          settingsVersion: 4,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('network');
    expect(res.settingsVersion).toBe(5);
    expect(fetchFromServer).toHaveBeenCalledTimes(1);
  });

  it('accepts a fresh disk cache when it equals the required minimum version', async () => {
    const fetchFromServer = vi.fn(async () => ({ settingsContent: null, settingsVersion: 6 }));
    const nowMs = 1_000_000;

    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      minSettingsVersion: 5,
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: null,
          settingsVersion: 5,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(res.source).toBe('cache');
    expect(res.settingsVersion).toBe(5);
    expect(fetchFromServer).not.toHaveBeenCalled();
  });

  it('forces Codex appServer default for schemaVersion < 6', async () => {
    const nowMs = 1_000_000;
    const applySideEffects = vi.fn();

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      agentId: 'codex',
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: { t: 'plain', v: { schemaVersion: 5, codexBackendMode: 'mcp' } },
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => null,
        applySideEffects,
      },
    });

    expect(applySideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ schemaVersion: 6, codexBackendMode: 'mcp' }),
      }),
    );
  });

  it('normalizes legacy mcp_resume codex backend mode when migrating schemaVersion < 6', async () => {
    const nowMs = 1_000_000;
    const applySideEffects = vi.fn();

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      agentId: 'codex',
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: { t: 'plain', v: { schemaVersion: 5, codexBackendMode: '  mcp_resume  ' } },
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => null,
        applySideEffects,
      },
    });

    expect(applySideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ schemaVersion: 6, codexBackendMode: 'acp' }),
      }),
    );
  });

  it('rejects disabled configured ACP backend targets during bootstrap side effects', async () => {
    const nowMs = 1_000_000;

    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: {
            t: 'plain',
            v: {
              backendEnabledByTargetKey: {
                'acpBackend:review-bot': false,
              },
            },
          },
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => null,
      },
    })).rejects.toThrow(/review-bot/i);
  });

  it('re-applies side effects when returning a fresh in-memory context', async () => {
    const nowMs = 1_000_000;
    const applySideEffects = vi.fn();

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: {
            t: 'plain',
            v: {
              backendEnabledByTargetKey: {
                'acpBackend:review-bot': false,
              },
            },
          },
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => null,
        applySideEffects,
      },
    }).catch(() => undefined);

    const result = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'auto',
      nowMs: nowMs + 10,
      ttlMs: 60_000,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => {
          throw new Error('should not read cache when in-memory context is fresh');
        },
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => null,
        applySideEffects,
      },
    });

    expect(result.source).toBe('cache');
    expect(applySideEffects).toHaveBeenCalledTimes(2);
    expect(applySideEffects).toHaveBeenLastCalledWith(expect.objectContaining({
      source: 'cache',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      settings: expect.objectContaining({
        backendEnabledByTargetKey: {
          'acpBackend:review-bot': false,
        },
      }),
    }));
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

  it('persists a forced fetch when an equal-version live snapshot is already active', async () => {
    const credentials = createCredentialsStub();
    const cachePath = '/tmp/server/account.settings.cache.json';
    const scopeKey = createAccountSettingsScopeKey({ cachePath, token: credentials.token });
    const settingsContent = {
      t: 'plain' as const,
      v: { schemaVersion: 6, claudeUnifiedTerminalEnabled: true },
    };
    const writeCache = vi.fn(async () => {});
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse(settingsContent.v),
      settingsVersion: 3,
      loadedAtMs: 900,
      settingsSecretsReadKeys: [],
      scopeKey,
    });

    await bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      refresh: 'force',
      minSettingsVersion: 3,
      nowMs: 1_000,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => ({
          version: 2,
          cachedAt: 800,
          settingsContent: { t: 'plain', v: { schemaVersion: 6, claudeUnifiedTerminalEnabled: false } },
          settingsVersion: 2,
        }),
        fetchFromServer: async () => ({ settingsContent, settingsVersion: 3 }),
        writeCache,
        decryptCiphertext: async () => null,
        applySideEffects: () => {},
      },
    });

    expect(writeCache).toHaveBeenCalledExactlyOnceWith(cachePath, {
      version: 2,
      cachedAt: 1_000,
      settingsContent,
      settingsVersion: 3,
    });
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

  it('does not let a slow older network bootstrap overwrite or cache a newer live snapshot', async () => {
    const credentials = createCredentialsStub();
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    const decryptCiphertext = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      finishDecrypt = resolve;
    }));
    const writeCache = vi.fn(async () => {});
    const applySideEffects = vi.fn();

    const bootstrapping = bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => '/tmp/account-a.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({ settingsCiphertext: 'older-ciphertext', settingsVersion: 3 }),
        decryptCiphertext,
        writeCache,
        applySideEffects,
      },
    });
    await vi.waitFor(() => expect(decryptCiphertext).toHaveBeenCalled());

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 5,
      loadedAtMs: 200,
      settingsSecretsReadKeys: [],
      scopeKey: createAccountSettingsScopeKey({
        cachePath: '/tmp/account-a.settings.cache.json',
        token: credentials.token,
      }),
    });
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' });

    await expect(bootstrapping).resolves.toMatchObject({
      settingsVersion: 5,
      settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(applySideEffects).not.toHaveBeenCalledWith(expect.objectContaining({ settingsVersion: 3 }));
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

  it('fast mode with a required minimum version blocks and throws when the version cannot be reached', async () => {
    const nowMs = 1_000_000;
    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'fast',
      refresh: 'auto',
      minSettingsVersion: 10,
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: nowMs - 1_000,
          settingsContent: null,
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 9 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_STALE',
    });
  });

  it('supports plaintext settings content envelopes (v2) without decrypting', async () => {
    const nowMs = 1_000_000;
    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        decryptCiphertext: async () => {
          throw new Error('unexpected decryptCiphertext');
        },
        fetchFromServer: async () => ({
          settingsContent: { t: 'plain', v: { notificationsSettingsV1: { v: 1, pushEnabled: false, ready: true, permissionRequest: true } } },
          settingsVersion: 12,
        } as any),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });
    expect(res.settingsVersion).toBe(12);
    expect((res.settings as any).notificationsSettingsV1?.pushEnabled).toBe(false);
  });

  it('rejects plaintext settings before publishing when the environment requires E2EE', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'require_e2ee' });
    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'plain', v: {} },
          settingsVersion: 12,
        } as any),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
  });

  it('rejects plaintext settings that carry a synced E2EE requirement', async () => {
    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        decryptCiphertext: async () => null,
        fetchFromServer: async () => ({
          settingsContent: {
            t: 'plain',
            v: { clientEncryptionRequirementV1: 'require_e2ee' },
          },
          settingsVersion: 12,
        } as any),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
  });

  it('uses apiServerUrl for default v2 fetches when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        version: 12,
        content: {
          t: 'plain',
          v: {
            schemaVersion: 6,
            mcpServersSettingsV1: {
              v: 1,
              strictMode: true,
              servers: [{ id: 'server-1', name: 'qa_server', transport: 'stdio', stdio: { command: 'npx', args: ['-y', 'pkg'] }, env: {}, createdAt: 1, updatedAt: 1 }],
              bindings: [],
            },
          },
        },
      },
    } as any);

    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        writeCache: async () => {},
        decryptCiphertext: async () => {
          throw new Error('unexpected decryptCiphertext');
        },
        applySideEffects: () => {},
      },
    });

    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect((res.settings as any).mcpServersSettingsV1?.servers).toHaveLength(1);
  });

  it('uses apiServerUrl for v1 fallback fetches when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 404, data: {} } as any)
      .mockResolvedValueOnce({ status: 200, data: { settings: null, settingsVersion: 12 } } as any);

    const res = await bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        writeCache: async () => {},
        decryptCiphertext: async () => {
          throw new Error('unexpected decryptCiphertext');
        },
        applySideEffects: () => {},
      },
    });

    expect(res.settingsVersion).toBe(12);
    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3005/v2/account/settings',
      expect.any(Object),
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3005/v1/account/settings',
      expect.any(Object),
    );
  });
  describe('when the server keeps failing', () => {
    const cachePath = '/tmp/server/account.settings.cache.json';
    const ttlMs = 60_000;
    const t0 = 1_000_000;

    function createFailingServer() {
      let failing = false;
      const attemptsAtMs: number[] = [];
      let clock = t0;
      const fetchFromServer = vi.fn(async () => {
        attemptsAtMs.push(clock);
        if (failing) throw new Error('Failed to fetch /v2/account/settings (502)');
        return { settingsContent: { t: 'plain' as const, v: { schemaVersion: 6 } }, settingsVersion: 5 };
      });
      const read = (nowMs: number, refresh: 'auto' | 'force' = 'auto') => {
        clock = nowMs;
        return bootstrapAccountSettingsContext({
          credentials: createCredentialsStub(),
          mode: 'blocking',
          refresh,
          nowMs,
          ttlMs,
          deps: {
            resolveCachePath: () => cachePath,
            readCache: async () => ({ version: 2, cachedAt: t0, settingsContent: { t: 'plain', v: { schemaVersion: 6 } }, settingsVersion: 5 }),
            writeCache: async () => {},
            decryptCiphertext: async () => null,
            fetchFromServer,
            applySideEffects: () => {},
          },
        });
      };
      return { fetchFromServer, attemptsAtMs, read, fail: (value: boolean) => { failing = value; } };
    }

    it('backs off growing intervals instead of re-reading on every 1 s call, and resets on success', async () => {
      const server = createFailingServer();
      await server.read(t0);
      server.fail(true);
      const firstStaleMs = t0 + ttlMs + 1;
      for (let second = 0; second < 120; second++) {
        const result = await server.read(firstStaleMs + second * 1_000);
        expect(result.settingsVersion).toBe(5);
      }
      expect(server.attemptsAtMs[0]).toBe(firstStaleMs);
      const failedAttempts = [...server.attemptsAtMs];
      expect(failedAttempts.length).toBeGreaterThan(2);
      expect(failedAttempts.length).toBeLessThanOrEqual(8);
      const gaps = failedAttempts.slice(1).map((at, index) => at - failedAttempts[index]!);
      expect(gaps.at(-1)!).toBeGreaterThanOrEqual(16_000);

      server.fail(false);
      const recoveredAtMs = firstStaleMs + 400_000;
      const beforeRecovery = server.attemptsAtMs.length;
      expect((await server.read(recoveredAtMs)).settingsVersion).toBe(5);
      expect(server.attemptsAtMs.length).toBe(beforeRecovery + 1);
      server.fail(true);
      const before = server.attemptsAtMs.length;
      await server.read(recoveredAtMs + ttlMs + 1);
      await server.read(recoveredAtMs + ttlMs + 1 + 2_000);
      expect(server.attemptsAtMs.length - before).toBe(2);
    });

    it('does not re-read a healthy server on every call after an equal-version refresh', async () => {
      const server = createFailingServer();
      await server.read(t0);
      const staleMs = t0 + ttlMs + 1;
      for (let second = 0; second < 30; second++) await server.read(staleMs + second * 1_000);
      expect(server.attemptsAtMs).toEqual([staleMs]);
    });

    it('lets a forced refresh or a reconnect reset try the server at once during backoff', async () => {
      const server = createFailingServer();
      await server.read(t0);
      server.fail(true);
      const staleMs = t0 + ttlMs + 1;
      await server.read(staleMs);
      const backedOff = server.attemptsAtMs.length;
      await server.read(staleMs + 100);
      expect(server.attemptsAtMs.length).toBe(backedOff);
      const lastMs = staleMs;

      await server.read(lastMs + 200, 'force');
      expect(server.attemptsAtMs.length).toBe(backedOff + 1);

      resetAccountSettingsRefreshBackoff();
      await server.read(lastMs + 300);
      expect(server.attemptsAtMs.length).toBe(backedOff + 2);
    });
  });
});
