import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, QualifiedConnectedAccountPurposeBindingsV1Schema } from '@happier-dev/protocol';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { resolveSessionSpawnConnectedServicesDefaultsPayload, agentSupportsSpawnConnectedServicesDefaults } from '@/session/services/spawnConnectedServicesDefaults';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { Credentials, StoredCredentials, TokenOnlyCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from './bootstrapAccountSettingsContext';
import { beginActivePromptLibraryCatalogRefresh, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, setActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { resolveAccountSettingsCachePath, writeAccountSettingsCacheAtomic } from './accountSettingsCache';
import { createDeferred } from '@/testkit/async/deferred';

function createCredentialsStub(): Credentials {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

function createCredentialsStubWithToken(token: string): Credentials {
  return {
    ...createCredentialsStub(),
    token,
  };
}

function createTokenOnlyCredentialsStub(token = 'token-only'): TokenOnlyCredentials {
  return {
    token,
    encryption: null,
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

  it('shares requester reads across different version floors but checks each publication and cancellation independently', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'follow_account' });
    const response = createDeferred<{ status: number; data: { version: number; content: { t: 'plain'; v: object } } }>();
    const get = vi.spyOn(axios, 'get').mockImplementation(() => response.promise);
    const logs = vi.spyOn(logger, 'infoFile');
    const cancelled = new AbortController();
    let current = true;
    const options = { credentials: createTokenOnlyCredentialsStub(), refresh: 'force' as const,
      publication: 'invocation' as const, allowCacheFallback: false,
      deps: { resolveCachePath: () => '/tmp/happier-requester-shared', readCache: async () => null } };
    const outcomes = Promise.allSettled([
      bootstrapAccountSettingsContext({ ...options, signal: cancelled.signal }),
      bootstrapAccountSettingsContext({ ...options, minSettingsVersion: 2 }),
      bootstrapAccountSettingsContext({ ...options, minSettingsVersion: 3 }),
      bootstrapAccountSettingsContext({ ...options, shouldCommit: () => current }),
    ]);
    await expect.poll(() => logs.mock.calls.filter(([label, fact]) => label === '[accountSettings] Bootstrap phase'
      && fact?.phase === 'cache_read' && fact?.status === 'completed').length).toBe(4);
    cancelled.abort();
    current = false;
    response.resolve({ status: 200, data: { version: 2, content: { t: 'plain', v: {} } } });
    const results = await outcomes;
    expect(get).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { source: 'network', settingsVersion: 2 } });
    expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'ACCOUNT_SETTINGS_STALE' } });
    expect(results[3]).toMatchObject({ status: 'rejected', reason: { code: 'ACCOUNT_SETTINGS_SOURCE_STALE' } });
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
  });

  it('isolates requester Homes and discards cancelled or failed flights before a later read', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'follow_account' });
    const held = createDeferred<{ status: number; data: { version: number; content: null } }>();
    const get = vi.spyOn(axios, 'get').mockImplementation(() => held.promise);
    const options = { credentials: createTokenOnlyCredentialsStub(), refresh: 'force' as const,
      publication: 'invocation' as const, allowCacheFallback: false,
      deps: { resolveCachePath: () => '/tmp/happier-requester-home', readCache: async () => null } };
    const cancelled = new AbortController();
    const first = runWithServerHttpBaseUrl('http://home-a.test', () => bootstrapAccountSettingsContext({ ...options, signal: cancelled.signal }))
      .catch((error: unknown) => error);
    await expect.poll(() => get.mock.calls.length).toBe(1);
    const other = runWithServerHttpBaseUrl('http://home-b.test', () => bootstrapAccountSettingsContext(options));
    await expect.poll(() => get.mock.calls.length).toBe(2);
    cancelled.abort();
    await expect(first).resolves.toMatchObject({ name: 'AbortError' });
    const replacement = runWithServerHttpBaseUrl('http://home-a.test', () => bootstrapAccountSettingsContext(options));
    await expect.poll(() => get.mock.calls.length).toBe(3);
    held.resolve({ status: 200, data: { version: 1, content: null } });
    await Promise.all([other, replacement]);
    get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(runWithServerHttpBaseUrl('http://home-a.test', () => bootstrapAccountSettingsContext(options)))
      .rejects.toThrow('unavailable');
    get.mockResolvedValue({ status: 200, data: { version: 2, content: null } });
    await expect(runWithServerHttpBaseUrl('http://home-a.test', () => bootstrapAccountSettingsContext(options)))
      .resolves.toMatchObject({ settingsVersion: 2 });
    expect(get).toHaveBeenCalledTimes(5);
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
  });

  it.each(['plain', 'e2ee'] as const)('parses unchanged %s refresh content once while retaining fresh reads and changed-content admission', async mode => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'follow_account' });
    const credentials = mode === 'plain' ? createTokenOnlyCredentialsStub() : createCredentialsStub();
    const contents = [
      { schemaVersion: 2, themePreference: 'dark' },
      { schemaVersion: 2, themePreference: 'dark' },
      { schemaVersion: 2, themePreference: 'light' },
    ];
    let revision = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      const raw = contents[revision++]!;
      const content = mode === 'plain' ? { t: 'plain' as const, v: raw }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(1) }, payload: raw,
          randomBytes: length => new Uint8Array(length).fill(revision) }) };
      return { status: 200, data: { version: revision, content } };
    });
    // Transparent instrumentation: the canonical parser and decryptor execute unchanged.
    const parses = vi.spyOn(AccountSettingsSchema, 'parse');
    const options = { credentials, refresh: 'force' as const,
      deps: { resolveCachePath: () => '/tmp/happier-settings-parse-reuse', readCache: async () => null,
        writeCache: async () => {}, applySideEffects: () => {} } };
    const first = await bootstrapAccountSettingsContext(options);
    expect(parses).toHaveBeenCalledTimes(1);
    const same = await bootstrapAccountSettingsContext(options);
    expect(get).toHaveBeenCalledTimes(2);
    expect(parses).toHaveBeenCalledTimes(1);
    expect(same.settings).toBe(first.settings);
    const changed = await bootstrapAccountSettingsContext(options);
    expect(get).toHaveBeenCalledTimes(3);
    expect(parses).toHaveBeenCalledTimes(2);
    expect(changed.settings.themePreference).toBe('light');
    expect(changed.settings).not.toBe(first.settings);
  });

  it('identifies a failed network refresh without recording Account content or the transport error', async () => {
    const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const failure = new Error('private-transport-content');
    vi.spyOn(axios, 'get').mockRejectedValue(failure);
    await expect(bootstrapAccountSettingsContext({ credentials: createTokenOnlyCredentialsStub(),
      refresh: 'force', minSettingsVersion: 1,
      deps: { resolveCachePath: () => '/tmp/happier-settings-phase', readCache: async () => null },
    })).rejects.toBe(failure);
    expect(logs.mock.calls).toContainEqual(['[accountSettings] Bootstrap phase', expect.objectContaining({
      phase: 'network_read', status: 'failed', durationMs: expect.any(Number),
    })]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-transport-content');
  });

  it('renews freshness after an unchanged authoritative refresh without republishing Settings', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'follow_account' });
    const credentials = createTokenOnlyCredentialsStub();
    // HTTP, persistent cache and process-environment writes are system boundaries.
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { version: 1, content: { t: 'plain', v: {} } } });
    const options = { credentials, ttlMs: 1_000,
      deps: { resolveCachePath: () => '/tmp/happier-settings-freshness', readCache: async () => null,
        writeCache: async () => {}, applySideEffects: () => {} } };
    const initial = await bootstrapAccountSettingsContext({ ...options, nowMs: 1_000 });
    const snapshot = getActiveAccountSettingsSnapshot();
    const refreshed = await bootstrapAccountSettingsContext({ ...options, nowMs: 2_000 });
    expect(getActiveAccountSettingsSnapshot()).toBe(snapshot);
    if (!snapshot?.scopeKey) throw new Error('Expected the published Account scope');
    beginActivePromptLibraryCatalogRefresh({ scopeKey: snapshot.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    const catalogSnapshot = getActiveAccountSettingsSnapshot();
    await bootstrapAccountSettingsContext({ ...options, nowMs: 2_100 });
    const warm = await bootstrapAccountSettingsContext({ ...options, nowMs: 2_200 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(warm.promptLibraryCatalog).toEqual({ status: 'loading' });
    expect(refreshed.settings).toBe(initial.settings);
    expect(getActiveAccountSettingsSnapshot()).toBe(catalogSnapshot);
    // The same existing TTL still expires; force and revision demands bypass freshness.
    await bootstrapAccountSettingsContext({ ...options, nowMs: 3_000 });
    expect(get).toHaveBeenCalledTimes(3);
    await bootstrapAccountSettingsContext({ ...options, nowMs: 3_001, refresh: 'force' });
    expect(get).toHaveBeenCalledTimes(4);
    await expect(bootstrapAccountSettingsContext({ ...options, nowMs: 3_002,
      minSettingsVersion: 2 })).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_STALE' });
    get.mockRejectedValue(new Error('Settings service unavailable'));
    await bootstrapAccountSettingsContext({ ...options, nowMs: 4_001 });
    await bootstrapAccountSettingsContext({ ...options, nowMs: 4_100 });
    expect(get).toHaveBeenCalledTimes(7);
    expect(getActiveAccountSettingsSnapshot()).toBe(catalogSnapshot);
  });

  it('preserves a required network failure without a Settings floor while ordinary bootstrap retains cache fallback', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'follow_account' });
    const failure = Object.assign(new Error('Settings Home unavailable'), { response: { status: 503 } });
    vi.spyOn(axios, 'get').mockRejectedValue(failure);
    const options = { credentials: createTokenOnlyCredentialsStub(), refresh: 'force' as const,
      deps: { resolveCachePath: () => '/tmp/happier-settings-network-required',
        readCache: async () => ({ version: 2 as const, cachedAt: 0, settingsVersion: 7,
          settingsContent: null }),
        writeCache: async () => {}, applySideEffects: () => {} } };
    await expect(bootstrapAccountSettingsContext({ ...options, allowCacheFallback: false })).rejects.toBe(failure);
    expect(await bootstrapAccountSettingsContext(options)).toMatchObject({ source: 'cache', settingsVersion: 7 });
  });

  it.each([{ mode: 'plain' as const, custodian: true }, { mode: 'e2ee' as const, custodian: true },
    { mode: 'plain' as const, custodian: false }])('loads invocation-bound requester $mode policy without replacing custodian state or process defaults (custodian=$custodian)', async ({ mode, custodian }) => {
    const alice = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'alice' };
    if (custodian) setActiveAccountSettingsSnapshot(alice);
    const applySideEffects = vi.fn();
    const writeCache = vi.fn(async () => {});
    const credentials = mode === 'plain' ? createTokenOnlyCredentialsStub('bob') : createCredentialsStubWithToken('bob');
    const raw = { actionsSettingsV1: {} };
    const content = mode === 'plain' ? { t: 'plain' as const, v: raw }
      : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(1) }, payload: raw,
        randomBytes: length => new Uint8Array(length).fill(7) }) };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { content, version: 9 } });
    const bob = await runWithServerHttpBaseUrl('https://requester-home.example', () => bootstrapAccountSettingsContext({ credentials,
      publication: 'invocation', mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false,
      deps: {
        // Persistent cache, HTTP, and process environment are genuine boundaries.
        resolveCachePath: () => '/tmp/happier-requester-bob-policy', readCache: async () => null,
        writeCache, applySideEffects,
      },
    }));
    expect(bob.settingsVersion).toBe(9);
    expect(bob.rawSettings).toEqual(raw);
    expect(bob.scopeKey).toBe(createAccountSettingsScopeKey({ cachePath: '/tmp/happier-requester-bob-policy', token: credentials.token }));
    expect(getActiveAccountSettingsSnapshot()).toBe(custodian ? alice : null);
    expect(writeCache).not.toHaveBeenCalled();
    expect(applySideEffects).not.toHaveBeenCalled();
    expect(get.mock.calls[0]?.[0]).toBe('https://requester-home.example/v2/account/settings');
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

  const codexScope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
    agentId: 'codex', contributions: readCurrentContributionRegistry(),
  })?.authorizedPurposes.find((scope) => scope.serviceRefs[0]?.localId === 'openai-codex');
  const sealSettings = (raw: unknown) => sealAccountScopedBlobCiphertext({
    kind: 'account_settings', material: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    payload: raw, randomBytes: length => new Uint8Array(length).fill(7),
  });
  const resolveOmittedSelection = () => resolveSessionSpawnConnectedServicesDefaultsPayload({
    agentId: 'codex', credentials: createCredentialsStub(),
  });
  const validQualifiedDefaults = () => {
    if (!codexScope || !agentSupportsSpawnConnectedServicesDefaults('codex')) {
      throw new Error('The real bundled Codex purpose must be available for the composed defaults test');
    }
    return { connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [{
      purpose: codexScope.purpose, target: { kind: 'account', account: {
        service: codexScope.serviceRefs[0], accountId: 'saved-codex',
      } },
    }] }) };
  };

  it.each([{ withCache: false, encrypted: false }, { withCache: true, encrypted: false },
    { withCache: false, encrypted: true }])('refuses malformed fetched defaults for omitted qualified selection (cache=$withCache, encrypted=$encrypted)', async ({ withCache, encrypted }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-qualified-default-bootstrap-'));
    Object.assign(mutableConfigurationForTest(), { activeServerDir: directory, clientEncryptionRequirement: 'follow_account' });
    try {
      const valid = validQualifiedDefaults();
      if (withCache) await writeAccountSettingsCacheAtomic(resolveAccountSettingsCachePath(createCredentialsStub()), {
        version: 2, cachedAt: 0, settingsVersion: 1,
        settingsContent: { t: 'encrypted', c: sealSettings(valid) },
      });
      // HTTP and persistent storage are genuine boundaries; the qualified catalog/default owner and bootstrap are real.
      const malformed = { connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
        antigravity: { v: 1, bindingsByServiceId: {
          'happier.agent.antigravity/antigravity-account': { source: 'connected', selection: 'profile' },
        } },
      } } };
      vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { version: 2,
        content: encrypted ? { t: 'encrypted', c: sealSettings(malformed) } : { t: 'plain', v: malformed },
      } });
      await expect(resolveOmittedSelection()).rejects.toMatchObject({
        code: 'connected_services_default_unavailable', reason: 'connected_services_default_settings_invalid',
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['network', 'encrypted network', 'cache'] as const)('keeps valid omitted qualified defaults from %s', async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-qualified-default-bootstrap-'));
    Object.assign(mutableConfigurationForTest(), { activeServerDir: directory, clientEncryptionRequirement: 'follow_account' });
    try {
      const valid = validQualifiedDefaults();
      const credentials = createCredentialsStub();
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) };
      const crypto = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material });
      const purposeContent = sealConnectedAccountCatalogContentV1({ mode: 'e2ee', material,
        record: { key: 'purposes', value: valid.connectedAccountPurposeBindingsV1 } });
      if (source === 'cache') {
        await writeAccountSettingsCacheAtomic(resolveAccountSettingsCachePath(createCredentialsStub()), {
          version: 2, cachedAt: 0, settingsVersion: 1,
          settingsContent: { t: 'encrypted', c: sealSettings({}) },
        });
      }
      // Settings and its independent purpose row share real admission/crypto;
      // only Home HTTP and the stored bearer are substituted.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'e2ee', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(crypto.contentPublicKeyFingerprint), updatedAt: 1,
        } };
        if (path === '/v1/account/entity-rows/connected-accounts/purposes') return {
          status: 200, data: { status: 'present', revision: 1, content: purposeContent },
        };
        if (path === '/v2/account/settings') {
          if (source === 'cache') throw new Error('offline');
          return { status: 200, data: { version: 2, content: source === 'encrypted network'
            ? { t: 'encrypted', c: sealSettings({}) } : { t: 'plain', v: {} } } };
        }
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        throw new Error(`Unexpected defaults Home read: ${path}`);
      });
      await expect(resolveOmittedSelection()).resolves.toMatchObject({
        connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'saved-codex' },
        } },
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
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
          settingsContent: { t: 'plain', v: { clientEncryptionRequirementV1: 'require_e2ee' } },
          settingsVersion: 12,
        } as any),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
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

  it('resolves the disk cache path from the authenticated credentials', async () => {
    const nowMs = 1_000_000;
    const tokenA = 'token-account-a';
    const tokenB = 'token-account-b';
    const resolveCachePath = vi.fn((credentials?: StoredCredentials) => `/tmp/server/${credentials?.token ?? 'missing'}/account.settings.cache.json`);

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStubWithToken(tokenA),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath,
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-a',
          settingsVersion: 9,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    await bootstrapAccountSettingsContext({
      credentials: createCredentialsStubWithToken(tokenB),
      mode: 'blocking',
      refresh: 'auto',
      nowMs,
      ttlMs: 60_000,
      deps: {
        resolveCachePath,
        readCache: async () => ({
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher-b',
          settingsVersion: 10,
        }),
        decryptCiphertext: async () => ({ notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true } }),
        fetchFromServer: async () => ({ settingsCiphertext: null, settingsVersion: 999 }),
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: tokenA }));
    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: tokenB }));
  });

  it('does not synthesize a generic Codex setting or schema-v6 migration during bootstrap', async () => {
    const nowMs = 1_000_000;
    const applySideEffects = vi.fn();

    await bootstrapAccountSettingsContext({
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
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => ({ schemaVersion: 5 }),
        applySideEffects,
      },
    });

    expect(applySideEffects).toHaveBeenCalledOnce();
    const appliedSettings = applySideEffects.mock.calls[0]?.[0].settings;
    expect(appliedSettings?.schemaVersion).toBe(5);
    expect(appliedSettings).not.toHaveProperty('codexBackendMode');
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
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => ({
          backendEnabledByTargetKey: {
            'acpBackend:review-bot': false,
          },
        }),
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
          version: 1,
          cachedAt: nowMs - 1_000,
          settingsCiphertext: 'cipher',
          settingsVersion: 123,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => ({ settingsContent: null, settingsVersion: 999 }),
        decryptCiphertext: async () => ({
          backendEnabledByTargetKey: {
            'acpBackend:review-bot': false,
          },
        }),
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
        // The canonical Account Settings catalog rewrites the legacy
        // `acpBackend:<id>` spelling to the V2 target key on parse, so the
        // published context carries that spelling.
        backendEnabledByTargetKey: {
          'agent:happier.agent.custom-acp/custom-acp:definition:review-bot': false,
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

  it('does not let a delayed older fetch publish its values while reapplying the accepted winner for the caller', async () => {
    const credentials = createCredentialsStub();
    const cachePath = '/tmp/server/account.settings.cache.json';
    let finishDecrypt: (value: Record<string, unknown>) => void = () => {};
    const decryptCiphertext = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      finishDecrypt = resolve;
    }));
    const writeCache = vi.fn(async () => {});
    const applySideEffects = vi.fn();

    const pending = bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({ settingsCiphertext: 'older', settingsVersion: 3 }),
        decryptCiphertext,
        writeCache,
        applySideEffects,
      },
    });
    await vi.waitFor(() => expect(decryptCiphertext).toHaveBeenCalled());

    const winner = {
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 5,
      loadedAtMs: 200,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
      scopeKey: createAccountSettingsScopeKey({ cachePath, token: credentials.token }),
    };
    setActiveAccountSettingsSnapshot(winner);
    finishDecrypt({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' });

    await expect(pending).resolves.toMatchObject({
      settingsVersion: 5,
      settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
    });
    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(writeCache).not.toHaveBeenCalled();
    expect(applySideEffects).toHaveBeenCalledTimes(1);
    expect(applySideEffects).toHaveBeenCalledWith(expect.objectContaining({
      settingsVersion: 5,
      settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
    }));

    const reused = await bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      refresh: 'auto',
      nowMs: 201,
      ttlMs: 60_000,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => { throw new Error('winner should be reused from memory'); },
        fetchFromServer: async () => { throw new Error('winner should not refetch'); },
        decryptCiphertext: async () => ({}),
        writeCache: async () => {},
        applySideEffects: vi.fn(),
      },
    });
    expect(reused.settingsVersion).toBe(5);
  });

  it('returns a newer same-scope winner that arrives while the accepted candidate cache write is in flight', async () => {
    const credentials = createCredentialsStub();
    const cachePath = '/tmp/server/account.settings.cache.json';
    let finishWrite: () => void = () => {};
    const writeCache = vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));

    const pending = bootstrapAccountSettingsContext({
      credentials,
      mode: 'blocking',
      refresh: 'force',
      nowMs: 100,
      deps: {
        resolveCachePath: () => cachePath,
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'older' },
          settingsVersion: 3,
        }),
        decryptCiphertext: async () => ({
          sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        }),
        writeCache,
        applySideEffects: vi.fn(),
      },
    });
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalled());

    const newer = {
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 4,
      loadedAtMs: 200,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
      scopeKey: createAccountSettingsScopeKey({ cachePath, token: credentials.token }),
    };
    setActiveAccountSettingsSnapshot(newer);
    const acceptedWinner = getActiveAccountSettingsSnapshot();
    finishWrite();

    await expect(pending).resolves.toMatchObject({ settingsVersion: 4 });
    expect(getActiveAccountSettingsSnapshot()).toBe(acceptedWinner);
    expect(acceptedWinner?.settings).toEqual(newer.settings);
  });

  it('persists a forced encrypted fetch when an equal-version live snapshot is already active', async () => {
    const credentials = createCredentialsStub();
    const cachePath = '/tmp/server/account.settings.cache.json';
    const scopeKey = createAccountSettingsScopeKey({ cachePath, token: credentials.token });
    const writeCache = vi.fn(async () => {});
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      settingsVersion: 3,
      loadedAtMs: 900,
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
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
          settingsContent: { t: 'encrypted', c: 'older-ciphertext' },
          settingsVersion: 2,
        }),
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'equal-version-current-ciphertext' },
          settingsVersion: 3,
        }),
        decryptCiphertext: async ({ ciphertext }) => ({
          sessionPendingQueueDeliveryTiming: ciphertext === 'equal-version-current-ciphertext'
            ? 'after_runtime_idle'
            : 'after_foreground_ready',
        }),
        writeCache,
        applySideEffects: () => {},
      },
    });

    expect(writeCache).toHaveBeenCalledExactlyOnceWith(cachePath, {
      version: 2,
      cachedAt: 1_000,
      settingsContent: { t: 'encrypted', c: 'equal-version-current-ciphertext' },
      settingsVersion: 3,
    }, expect.objectContaining({ shouldCommit: expect.any(Function) }));
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

  it('loads plain v2 settings with token-only credentials without writing a raw durable cache', async () => {
    const writeCache = vi.fn(async () => {});
    const decryptCiphertext = vi.fn(async () => {
      throw new Error('unexpected decryptCiphertext');
    });

    const result = await bootstrapAccountSettingsContext({
      credentials: createTokenOnlyCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: {
            t: 'plain',
            v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' },
          },
          settingsVersion: 13,
        }),
        decryptCiphertext,
        writeCache,
        applySideEffects: () => {},
      },
    });

    expect(result).toMatchObject({
      source: 'network',
      settingsVersion: 13,
      settingsSecretsReadKeys: [],
    });
    expect(result.settings.sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle');
    expect(decryptCiphertext).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('reports retained encrypted settings as unavailable for token-only credentials', async () => {
    await expect(bootstrapAccountSettingsContext({
      credentials: createTokenOnlyCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'retained-e2ee-settings' },
          settingsVersion: 14,
        }),
        decryptCiphertext: async () => {
          throw new Error('token-only credentials must not enter account-cipher code');
        },
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE',
    });
  });

  it('keeps a fast token-only refresh explicitly unavailable for retained encrypted settings', async () => {
    const result = await bootstrapAccountSettingsContext({
      credentials: createTokenOnlyCredentialsStub(),
      mode: 'fast',
      refresh: 'force',
      nowMs: 1_000_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'retained-e2ee-settings' },
          settingsVersion: 14,
        }),
        decryptCiphertext: async () => {
          throw new Error('token-only credentials must not enter account-cipher code');
        },
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    });

    expect(result.source).toBe('none');
    await expect(result.whenRefreshed).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE',
    });
  });

  it('does not replace unopenable encrypted settings with defaults', async () => {
    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: 'corrupt-e2ee-settings' },
          settingsVersion: 15,
        }),
        decryptCiphertext: async () => null,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_DECRYPT_FAILED',
    });
  });

  it('does not replace an empty encrypted envelope with defaults', async () => {
    await expect(bootstrapAccountSettingsContext({
      credentials: createCredentialsStub(),
      mode: 'blocking',
      refresh: 'force',
      nowMs: 1_000_000,
      deps: {
        resolveCachePath: () => '/tmp/server/account.settings.cache.json',
        readCache: async () => null,
        fetchFromServer: async () => ({
          settingsContent: { t: 'encrypted', c: '' },
          settingsVersion: 16,
        }),
        decryptCiphertext: async () => null,
        writeCache: async () => {},
        applySideEffects: () => {},
      },
    })).rejects.toMatchObject({
      code: 'ACCOUNT_SETTINGS_DECRYPT_FAILED',
    });
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
            mcpServersStrictMode: true,
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
    expect(res.settings.mcpServersStrictMode).toBe(true);
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
});
