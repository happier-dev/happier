import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import * as persistence from '@/persistence';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { prepareActiveMcpServerCatalog, projectMcpServerCatalogRefreshFailure, refreshActiveMcpServerCatalog, refreshActiveMcpServerCatalogAfterChange, refreshDemandedActiveMcpServerCatalog } from './hydrateMcpServerCatalog';
import { createCliMcpServerStore, createCliMcpServerStoreForOperation } from './mcpServerStore';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { prepareRequesterSessionBootstrap } from "@/daemon/sessionEncryption/requesterSessionCredentials";

import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { McpRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';
import { reachRulesToDraftsV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { McpServerCatalogRowMutationV1Schema, openMcpServerCatalogContentV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { readMcpServersSettingsForStartup } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

function seedAccount(raw: Readonly<Record<string, unknown>> = { mcpServersStrictMode: true }) {
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-account' })).toString('base64url')}.signature`, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw),
    rawSettings: raw, settingsVersion: 7, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  return credentials;
}

function present(revision: number) {
  return { status: 'present', revision, content: { t: 'plain', v: { v: 1,
    servers: [{ id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'echo', args: [`revision-${revision}`] },
      env: {}, createdAt: 1, updatedAt: revision }], bindings: [],
  } } };
}

function mockAccountReads(readRow: () => Promise<unknown>, readHistory: () => Promise<unknown> = async () => ({ snapshots: [] })) {
  // Home HTTP is the only replaced boundary; schema, mode admission, lifecycle,
  // source cleanup and catalog publication remain real.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: await readRow() };
    if (path === '/v2/account/settings') return { status: 200, data: {
      content: { t: 'plain', v: { mcpServersStrictMode: true } }, version: 7 } };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    if (['/v1/account/entity-rows/provider-connections', '/v1/account/entity-rows/acp',
      '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes',
      '/v1/account/entity-rows/connected-metadata/presentation', '/v1/account/entity-rows/connected-metadata/acknowledgements',
      '/v1/account/entity-rows/notification-channels', '/v1/account/entity-rows/remote-hosts',
      '/v1/account/entity-rows/prompt-library'].includes(path)) return { status: 404, data: {} };
    if (path === '/v2/account/settings/history') return { status: 200, data: await readHistory() };
    throw new Error(`Unexpected MCP Account boundary: ${path}`);
  });
}

describe('CLI MCP catalog Account publication', () => {
  it('refreshes a demanded destination without starting source or historical maintenance', async () => {
    const credentials = seedAccount();
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    let revision = 1;
    mockAccountReads(async () => present(revision));
    await refreshActiveMcpServerCatalog({ credentials, maintainSource: false });
    vi.mocked(axios.get).mockClear();
    revision = 2;
    await refreshDemandedActiveMcpServerCatalog({ token: credentials.token });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 2 });
    expect(vi.mocked(axios.get).mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(expect.arrayContaining(['/v1/account/entity-rows/mcp', '/v1/account/encryption/currentness']));
    expect(vi.mocked(axios.get).mock.calls.map(([url]) => new URL(String(url)).pathname)
      .filter(path => path !== '/v1/account/entity-rows/mcp' && path !== '/v1/account/encryption/currentness')).toEqual([]);
  });
  it.each(['server_error', 'network'] as const)('preserves a transient Account currentness %s for startup recovery without reading private rows', async failure => {
    const credentials = seedAccount();
    let recovered = false;
    let privateReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        if (!recovered) {
          if (failure === 'network') throw new axios.AxiosError('private transport detail', 'ECONNRESET');
          return { status: 503, data: { private: 'private response body' } };
        }
        return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 7,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      privateReads++;
      if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: present(4) };
      throw new Error(`Unexpected private read: ${path}`);
    });
    const demand = () => prepareActiveMcpServerCatalog({ credentials, scopeKey: resolveAccountSettingsScopeKey(credentials),
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), maintainSource: false });
    await expect(demand()).resolves.toEqual({ status: 'unavailable', reason: 'unreachable' });
    expect(privateReads).toBe(0);
    expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status).not.toBe('ready');
    const unavailable = getActiveAccountSettingsSnapshot()!;
    expect(() => readMcpServersSettingsForStartup({ snapshot: unavailable })).toThrowError(
      expect.objectContaining({ code: 'mcp_catalog_unavailable', reason: 'unreachable' }));
    expect(readMcpServersSettingsForStartup({ snapshot: { ...unavailable,
      settings: accountSettingsParse({ mcpServersStrictMode: false }) } })).toMatchObject({ status: 'unavailable' });
    recovered = true;
    await expect(demand()).resolves.toMatchObject({ status: 'ready', revision: 4 });
  });

  it.each(['missing', 'mismatched'] as const)('keeps actual %s E2EE material closed rather than requesting transient recovery', async material => {
    const seeded = seedAccount();
    const credentials = material === 'missing' ? seeded : { ...seeded,
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    let privateReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'e2ee', version: 1, settingsVersion: 7, signingKeyFingerprint: null,
        contentKeyFingerprint: 'a'.repeat(64), updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } };
      privateReads++;
      throw new Error('Private rows must remain unreadable');
    });
    await expect(prepareActiveMcpServerCatalog({ credentials, scopeKey: resolveAccountSettingsScopeKey(credentials),
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() })).resolves.toEqual({
      status: 'unavailable', reason: 'encryption-material-unavailable' });
    expect(privateReads).toBe(0);
  });

  it('retains confirmed database rollback through MCP catalog hydration', async () => {
    const credentials = seedAccount();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
    });
    expect(await refreshActiveMcpServerCatalog({ credentials })).toMatchObject({
      status: 'unavailable', reason: 'database_transaction_conflict_exhausted' });
  });
  it.each([
    { status: 503, body: { error: 'database_transaction_conflict_exhausted', statusCode: 503 }, code: 'database_transaction_conflict_exhausted' },
    { status: 503, body: { error: 'database_transaction_conflict_exhausted' }, code: 'outcome_unknown' },
    { status: 500, body: { error: 'database_transaction_conflict_exhausted' }, code: 'outcome_unknown' },
  ])('preserves MCP mutation disposition for HTTP $status / $code', async ({ status, body, code }) => {
    const credentials = seedAccount();
    mockAccountReads(async () => present(4));
    vi.spyOn(axios, 'post').mockImplementation(async (url, mutation) => {
      expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/mcp');
      expect(McpServerCatalogRowMutationV1Schema.parse(mutation)).toMatchObject({ expectedRevision: 4 });
      return { status, data: body };
    });
    await expect(createCliMcpServerStore({ credentials }).writeCatalog({ expectedRevision: 4,
      catalog: { v: 1, servers: [], bindings: [] } })).rejects.toMatchObject({ code });
  });
  it.each([false, true])('keeps legacy activation behind fresh requester authority within a preparation checkpoint (revoked=%s)', async revoked => {
    const catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
    const raw = { mcpServersStrictMode: true, mcpServersSettingsV1: { ...catalog, strictMode: true } };
    const f = await createProjectSessionRuntimeFixture({ accountSettings: raw });
    // Legacy activation needs a real Account identity, not an opaque fixture
    // bearer: keep its actual source read, strict mutation and row writer live.
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', fixture: f.directory })).toString('base64url')}.signature`, encryption: null };
    const prepared = await prepareRequesterSessionBootstrap({ credentials, attribution: f.bootstrap.attribution,
      boundary: { serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test', happyHomeDir: f.directory },
      verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() });
    if (!prepared) throw new Error('Missing admitted requester');
    onTestFinished(prepared.cleanupOnFailure);
    const get = vi.mocked(axios.get).getMockImplementation()!;
    let sourceRead = false;
    let catalogRowObserved = false;
    let row: unknown = { status: 'absent' };
    let writes = 0;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/entity-rows/mcp') {
        catalogRowObserved = true;
        return { status: 200, data: row };
      }
      if (path === '/v2/account/settings' && catalogRowObserved) {
        sourceRead = true;
        if (revoked) f.retire();
      }
      return get(url, options);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected MCP effect');
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      writes++;
      row = { status: 'present', revision: 1, content: mutation.content };
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    });
    const operationContext = prepared.admitted.savedSecretOperationContext;
    const result = await (async () => {
      expect(await prepared.admitted.isCurrent()).toBe(true);
      try { return await createCliMcpServerStoreForOperation({ operationContext }).readCatalogForOperation(); }
      catch { return null; }
    })();
    expect(sourceRead).toBe(true);
    if (revoked) {
      expect(writes).toBe(0);
      expect(result).not.toMatchObject({ status: 'ready' });
    } else {
      expect(result).toMatchObject({ status: 'ready', catalog });
      expect(writes).toBe(1);
    }
  });

  it('classifies a Mini schema failure as invalid stored content', () => {
    const parsed = McpServerCatalogRowMutationV1Schema.safeParse(null);
    if (parsed.success) throw new Error('Expected the canonical MCP row mutation to reject null');
    expect(projectMcpServerCatalogRefreshFailure({ error: parsed.error, current: true })).toEqual({
      status: 'unavailable', reason: 'invalid-stored-content',
    });
  });

  it('promotes a retained personal MCP reference before first activation at the fresh Settings baseline', async () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
    const credentials: StoredCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-import-account' })).toString('base64url')}.signature`,
      encryption: material };
    const keys = deriveSettingsSecretsKeySetV1(material);
    const randomBytes = (length: number) => new Uint8Array(length).fill(11);
    const legacy = { id: 'old-mcp-key', name: 'Legacy MCP key', kind: 'token' as const,
      encryptedValue: { _isSecretValue: true as const, encryptedValue: encryptSecretStringV1('mcp-private-value', keys.writeKey, randomBytes) },
      createdAt: 1, updatedAt: 2 };
    let raw: Readonly<Record<string, unknown>> = { preferredLanguage: 'fr', secrets: [legacy], mcpServersStrictMode: true,
      mcpServersSettingsV1: { v: 1, strictMode: true, servers: [{ id: 'local', name: 'local', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, env: { API_KEY: { t: 'savedSecret', secretId: legacy.id } },
        createdAt: 1, updatedAt: 1 }], bindings: [] } };
    let version = 7;
    let row: unknown = { status: 'absent' };
    const resources: unknown[] = [];
    const effects: string[] = [];
    let promotedRef: string | undefined;
    let promotedResourceId: string | undefined;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
      settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: keys.readKeys,
      scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true,
      credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
    // This is the same real Home promotion/material wire used by the Secret
    // importer suite; all source capture, rewrites and reference proofs are real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        settingsVersion: version, signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'available' } } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version, content: { t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: raw, randomBytes }) } } };
      if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: row };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [],
        nextCursor: null, complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] } };
      if (path === '/v1/account/entity-rows/profiles/reference-guard') return { status: 200, data: { status: 'ready', revision: 3 } };
      if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      throw new Error(`Unexpected personal MCP Home read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/saved-secrets/resources/promote') {
        const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
        expect(mutation.expectedSettingsVersion).toBe(version);
        expect(mutation.referenceCensus).toMatchObject({ catalogs: { mcp: 'absent' } });
        expect(mutation.catalogMutations?.mcp).toBeUndefined();
        if (mutation.nextSettings?.t !== 'encrypted') throw new Error('Promotion did not preserve Account encryption');
        raw = AccountSettingsPersistedObjectSchema.parse(openAccountScopedBlobCiphertext({ kind: 'account_settings',
          material, ciphertext: mutation.nextSettings.c })?.value);
        promotedRef = `happier:shared-secret:v1:${mutation.resourceId}`;
        promotedResourceId = mutation.resourceId;
        const envelope = mutation.keyEnvelopes?.[0];
        resources.push({ resourceId: mutation.resourceId, encryptionMode: 'e2ee', storedContent: mutation.storedContent,
          recipientEnvelope: envelope ? { encryptedDataKey: envelope.encryptedDataKey,
            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } : null,
          entry: { ref: promotedRef, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'mcp-import-account',
            name: mutation.displayName, kind: mutation.kind, revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
        effects.push('promote');
        return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion: ++version } };
      }
      if (path !== '/v1/account/entity-rows/mcp') throw new Error(`Unexpected personal MCP Home write: ${path}`);
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      expect(effects).toEqual(['promote']);
      expect(mutation.expectedRevision).toBe('absent');
      expect(mutation.sourceSettingsVersion).toBe(8);
      expect(mutation.sourceSettingsVersion).toBe(version);
      const opened = openMcpServerCatalogContentV1({ mode: 'e2ee', material, content: mutation.content });
      expect(opened).toMatchObject({ status: 'opened', catalog: { servers: [{ env: {
        API_KEY: { t: 'savedSecret', secretId: promotedRef } } }] } });
      expect(mutation.referencedSavedSecretIds).toEqual([promotedRef]);
      expect(mutation.savedSecretRevisions).toEqual([{ resourceId: promotedResourceId, expectedRevision: 1 }]);
      row = { status: 'present', revision: 1, content: mutation.content };
      effects.push('mcp');
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    });
    const admitted = await createCliMcpServerStore({ credentials, hasPendingCleanup: () => true }).readCatalogForOperation();
    expect(admitted).toMatchObject({ status: 'ready', authority: 'active', revision: 1,
      catalog: { servers: [{ env: { API_KEY: { t: 'savedSecret', secretId: promotedRef } } }] } });
    expect(effects).toEqual(['promote', 'mcp']);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(8);
    expect(raw.preferredLanguage).toBe('fr');
  });

  it.each(['empty', 'nonsecret'] as const)('admits an absent MCP row without importing unrelated locked sources (%s)', async kind => {
    const catalog: McpServerCatalogV1 = kind === 'empty' ? { v: 1, servers: [], bindings: [] }
      : { v: 1, servers: [{ id: 'local', name: 'local', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, env: { PUBLIC: { t: 'literal', v: 'public-value' } },
        createdAt: 1, updatedAt: 1 }], bindings: [] };
    const raw = { mcpServersStrictMode: true, mcpServersSettingsV1: { ...catalog, strictMode: true },
      secrets: [{ id: 'unrelated', name: 'Unrelated retained credential', kind: 'token',
        encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('unrelated-private-value',
          new Uint8Array(32).fill(7), length => new Uint8Array(length).fill(8)) }, createdAt: 1, updatedAt: 1 }] };
    const credentials = seedAccount(raw);
    expect(getActiveAccountSettingsSnapshot()?.settings.secrets).toHaveLength(1);
    const unrelatedReads: string[] = [];
    const writes: string[] = [];
    let row: unknown = { status: 'absent' };
    // Only Home HTTP is replaced. Locked ACP/Provider rows must not become
    // admission prerequisites for an MCP source with no personal references.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: raw }, version: 7 } };
      if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: row };
      unrelatedReads.push(path);
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: {
        status: 'listed', rows: [], nextCursor: null, complete: true, referenceGuardRevision: -1,
        transferControl: { status: 'absent' }, diagnostics: [] } };
      if (path === '/v1/account/entity-rows/profiles/reference-guard') return { status: 200, data: { status: 'ready', revision: -1 } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      return { status: 403, data: { status: 'forbidden' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      writes.push(path);
      if (path !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected unrelated mutation');
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe('absent');
      expect(mutation.sourceSettingsVersion).toBe(7);
      expect(mutation.content).toEqual({ t: 'plain', v: catalog });
      row = { status: 'present', revision: 1, content: mutation.content };
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    });
    const admitted = await createCliMcpServerStore({ credentials, hasPendingCleanup: () => true }).readCatalogForOperation();
    expect(admitted).toMatchObject({ status: 'ready', authority: 'active', revision: 1, catalog });
    expect(writes).toEqual(['/v1/account/entity-rows/mcp']);
    expect(unrelatedReads).toEqual([]);
    expect(getActiveAccountSettingsSnapshot()?.rawSettings).toEqual(raw);
  });

  it('returns committed rules for Undo and refuses a lost catalog CAS without changing configuration', async () => {
    const credentials = seedAccount();
    let revision = 9;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
      configOverrides: [{ target: { t: 'machine', machineId: 'm' }, envPatch: { PRIVATE: { t: 'literal', v: 'private-config' } } }] }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    const originalServers = catalog.servers;
    mockAccountReads(async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
    let raceAtWrite = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected effect');
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      if (raceAtWrite) { revision += 1; raceAtWrite = false; }
      if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain catalog');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    await refreshActiveMcpServerCatalog({ credentials });
    const store = createCliMcpServerStore({ credentials, serverId: 'home-a' });
    const execute = createMcpServerActionExecuteV1({ readCatalog: () => store.readCatalog(),
      mutate: (change, expectedRevision) => store.mutate(change, expectedRevision),
      machine: async () => { throw new Error('Unexpected machine effect'); } });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const changed = await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, context });
    expect(changed).toMatchObject({ ok: true, result: { ok: true, revision: 10,
      items: [{ serverId: 'server', rules: [{ id: 'binding', enabled: false }], previous: [{ id: 'binding', enabled: true }] }] } });
    expect(catalog.servers).toEqual(originalServers);
    expect(catalog.bindings[0]?.enabled).toBe(false);
    const receipt = McpRulesSetOutputV1Schema.parse(changed.ok ? changed.result : null);
    if (!receipt.ok) throw new Error('Expected committed rule receipt');
    const restored = await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
      change: { kind: 'replace', rules: reachRulesToDraftsV1(receipt.items[0]!.previous) } }, context });
    expect(restored).toMatchObject({ ok: true, result: { ok: true, revision: 11 } });
    expect(catalog.bindings[0]?.enabled).toBe(true);
    raceAtWrite = true;
    expect(await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, context }))
      .toEqual({ ok: true, result: { ok: false, code: 'conflict' } });
    expect(catalog.bindings[0]?.enabled).toBe(true);
    expect(catalog.servers).toEqual(originalServers);
  });

  it.each([false, true])('reconciles concurrent tool snapshots only while the tested configuration is unchanged (changed=%s)', async configurationChanged => {
    const credentials = seedAccount();
    let revision = 3;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] };
    mockAccountReads(async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
    const writes: number[] = [];
    const bothCaptured = createDeferred();
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected effect');
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      if (typeof mutation.expectedRevision !== 'number') throw new Error('Expected active catalog');
      writes.push(mutation.expectedRevision);
      if (writes.length === 2) bothCaptured.resolve();
      await bothCaptured.promise;
      if (configurationChanged && revision === 3) {
        catalog = { ...catalog, servers: catalog.servers.map(server => ({ ...server,
          stdio: { command: 'changed-command', args: [] }, updatedAt: 2 })) };
        revision += 1;
      }
      if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
      const opened = openMcpServerCatalogContentV1({ content: mutation.content, mode: 'plain', material: null });
      if (opened.status !== 'opened') throw new Error('Expected readable current write');
      catalog = opened.catalog;
      return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    const stores = ['first-machine', 'second-machine'].map(machineId => ({ machineId,
      store: createCliMcpServerStoreForOperation({ operationContext: createInvocationSavedSecretOperationContextV1({
        credentials, serverHttpBaseUrl: 'https://home.example.test', snapshot: getActiveAccountSettingsSnapshot()!,
        isCurrent: async () => true,
      }) }),
    }));
    const captured = await Promise.all(stores.map(({ store }) => store.readCatalogForOperation()));
    const results = await Promise.all(stores.map(({ store, machineId }, index) => store.mutate({
      kind: 'tools-snapshot', serverId: 'server', snapshot: { checkedAt: index + 1, machineId,
        tools: [{ name: 'echo', tokens: 1 }] },
    }, 3, captured[index])));
    expect(results.map(result => result.status)).toEqual(configurationChanged ? ['conflict', 'conflict'] : ['updated', 'updated']);
    expect(writes).toEqual(configurationChanged ? [3, 3] : [3, 3, 4]);
    if (configurationChanged) {
      expect(catalog.servers[0]?.stdio?.command).toBe('changed-command');
      expect(catalog.servers[0]?.toolsSnapshot).toBeUndefined();
    } else {
      expect(catalog.servers[0]?.toolsSnapshot).toMatchObject({ tools: [{ name: 'echo' }] });
    }
  });

  it.each([false, true])('refuses a snapshot conflict without revision advancement even if a later read is newer (alreadyRebased=%s)', async alreadyRebased => {
    const credentials = seedAccount();
    let revision = 3;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] };
    mockAccountReads(async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
    const writes: number[] = [];
    let refused = false;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      if (typeof mutation.expectedRevision !== 'number') throw new Error('Expected active catalog');
      writes.push(mutation.expectedRevision);
      if (alreadyRebased && writes.length === 1) {
        revision += 1;
        return { status: 409, data: { status: 'conflict', revision } };
      }
      if (!refused) {
        refused = true;
        const conflictRevision = revision;
        // A different write commits only after this non-advancing conflict.
        // Its later visibility must not authorize replaying the refused write.
        revision += 1;
        catalog = { ...catalog, bindings: [{ id: 'peer-rule', serverId: 'server', enabled: true,
          target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
        return { status: 409, data: { status: 'conflict', revision: conflictRevision } };
      }
      const opened = openMcpServerCatalogContentV1({ content: mutation.content, mode: 'plain', material: null });
      if (opened.status !== 'opened') throw new Error('Expected readable current write');
      catalog = opened.catalog;
      return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    const store = createCliMcpServerStoreForOperation({ operationContext: createInvocationSavedSecretOperationContextV1({
      credentials, serverHttpBaseUrl: 'https://home.example.test', snapshot: getActiveAccountSettingsSnapshot()!,
      isCurrent: async () => true,
    }) });
    const captured = await store.readCatalogForOperation();
    expect(await store.mutate({ kind: 'tools-snapshot', serverId: 'server', snapshot: {
      checkedAt: 1, machineId: 'machine', tools: [{ name: 'echo', tokens: 1 }],
    } }, 3, captured)).toEqual({ status: 'conflict', revision: alreadyRebased ? 4 : 3 });
    expect(writes).toEqual(alreadyRebased ? [3, 4] : [3]);
    expect(catalog.servers[0]?.toolsSnapshot).toBeUndefined();
  });

  it('publishes row-only changes without advancing preference revision or rewriting the retained root', async () => {
    const credentials = seedAccount();
    const preferences = getActiveAccountSettingsSnapshot()!.settings;
    let revision = 1;
    mockAccountReads(async () => present(revision));
    const post = vi.spyOn(axios, 'post');
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);
    try {
      await refreshActiveMcpServerCatalog({ credentials });
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 7,
        mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1 } });
      expect(getActiveAccountSettingsSnapshot()!.settings).toBe(preferences);
      revision = 2;
      await refreshActiveMcpServerCatalogAfterChange({ credentials,
        scopeKey: resolveAccountSettingsScopeKey(credentials), lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 7,
        mcpServerCatalog: { status: 'ready', revision: 2, catalog: { servers: [{ updatedAt: 2 }] } } });
      expect(getActiveAccountSettingsSnapshot()!.settings).toBe(preferences);
      expect(post).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('rejects a late row response from a retired Account lifetime even after selecting the same Account again', async () => {
    const credentials = seedAccount();
    const deferred = createDeferred<ReturnType<typeof present>>();
    const issued = createDeferred<void>();
    mockAccountReads(async () => { issued.resolve(); return deferred.promise; });
    const refresh = refreshActiveMcpServerCatalog({ credentials });
    await issued.promise;
    clearActiveAccountSettingsSnapshot();
    seedAccount();
    const replacement = getActiveAccountSettingsSnapshot();
    deferred.resolve(present(9));
    expect(await refresh).toMatchObject({ status: 'unavailable', reason: 'scope-retired' });
    expect(getActiveAccountSettingsSnapshot()).toBe(replacement);
  });

  it('keeps an absent row distinct from a deleted row without initializing or removing source data', async () => {
    const credentials = seedAccount();
    let row: unknown = { status: 'absent' };
    mockAccountReads(async () => row);
    const post = vi.spyOn(axios, 'post');
    const store = createCliMcpServerStore({ credentials });
    expect(await store.readRow()).toEqual({ status: 'absent' });
    row = { status: 'deleted', revision: 4 };
    expect(await store.readRow()).toEqual({ status: 'deleted', revision: 4 });
    expect(post).not.toHaveBeenCalled();
  });

  it('starts a fresh row read after the write boundary while previous history maintenance remains pending', async () => {
    const credentials = seedAccount();
    const history = createDeferred<{ snapshots: [] }>();
    const historyIssued = createDeferred<void>();
    let revision = 1;
    mockAccountReads(async () => present(revision), async () => { historyIssued.resolve(); return history.promise; });
    try {
      await refreshActiveMcpServerCatalog({ credentials });
      await historyIssued.promise;
      revision = 2;
      expect(await prepareActiveMcpServerCatalog({ credentials, scopeKey: resolveAccountSettingsScopeKey(credentials),
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), refresh: true })).toMatchObject({ status: 'ready', revision: 2 });
      expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 2 });
    } finally { history.resolve({ snapshots: [] }); }
  });

  it('issues a nonvisual row mutation from its admitted snapshot without joining optional history maintenance', async () => {
    const credentials = seedAccount();
    const history = createDeferred<{ snapshots: [] }>();
    const firstHistory = createDeferred<void>();
    const repeatedHistory = createDeferred<void>();
    const rowMutationIssued = createDeferred<void>();
    let historyReads = 0;
    let revision = 1;
    mockAccountReads(async () => present(revision), async () => {
      historyReads += 1;
      if (historyReads === 1) firstHistory.resolve();
      else repeatedHistory.resolve();
      return history.promise;
    });
    vi.spyOn(axios, 'post').mockImplementation(async input => {
      if (new URL(String(input)).pathname !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected mutation');
      revision = 2;
      rowMutationIssued.resolve();
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    await refreshActiveMcpServerCatalog({ credentials });
    await firstHistory.promise;
    const captured = getActiveAccountSettingsSnapshot()?.mcpServerCatalog;
    if (captured?.status !== 'ready' || !captured.catalog.servers[0]) throw new Error('Fixture is not admitted');
    const mutation = createCliMcpServerStore({ credentials }).mutate({ kind: 'server-update',
      entry: { ...captured.catalog.servers[0], title: 'Updated without a UI' } }, captured.revision);
    try {
      expect(await Promise.race([rowMutationIssued.promise.then(() => 'mutation'),
        repeatedHistory.promise.then(() => 'maintenance')])).toBe('mutation');
      expect(await mutation).toMatchObject({ status: 'updated', revision: 2 });
      expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 2 });
    } finally {
      history.resolve({ snapshots: [] });
      await mutation.catch(() => undefined);
    }
  });
});
