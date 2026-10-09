import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { prepareActiveMcpServerCatalog, refreshActiveMcpServerCatalog, refreshActiveMcpServerCatalogAfterChange } from './hydrateMcpServerCatalog';
import { createCliMcpServerStore } from './mcpServerStore';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { McpServerCatalogRowMutationV1Schema, openMcpServerCatalogContentV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

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

  it('captures exact binding state: refuses a restore in another Home with the same binding and revision', async () => {
    const credentials = seedAccount();
    let revision = 10;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: false, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    mockAccountReads(async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain catalog');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    await refreshActiveMcpServerCatalog({ credentials });
    const otherHome = createCliMcpServerStore({ credentials, serverId: 'home-b' });
    const execute = createMcpServerActionExecuteV1({ readCatalog: () => otherHome.readCatalog(),
      mutate: (change, expectedRevision) => otherHome.mutate(change, expectedRevision),
      machine: async () => { throw new Error('Unexpected Machine effect'); } });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    await expect(execute({ actionId: 'mcp.bindings.enable', input: { bindingId: 'binding', expectedRevision: 10,
      expectedEnabled: false, expectedScope: { serverId: 'home-a', accountId: 'mcp-account' } }, context }))
      .rejects.toMatchObject({ code: 'server_scope_mismatch' });
    expect(revision).toBe(10);
    expect(catalog.bindings[0]?.enabled).toBe(false);
  });

  it('captures exact binding state through the public Action and conditionally restores at the durable row CAS', async () => {
    const credentials = seedAccount();
    let revision = 9;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' },
        overrides: { envPatch: { PRIVATE: { t: 'literal', v: 'private-config' } } }, createdAt: 1, updatedAt: 1 }] };
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
    expect(await execute({ actionId: 'mcp.bindings.disable', input: { bindingId: 'binding', expectedRevision: 9,
      captureBefore: true }, context })).toEqual({ ok: true, result: { status: 'updated', revision: 10, cursor: 10,
      reversal: { scope: { serverId: 'home-a', accountId: 'mcp-account' }, bindingId: 'binding', before: true,
        applied: false, revision: 10 } } });
    expect(catalog.bindings[0]?.enabled).toBe(false);
    expect(await execute({ actionId: 'mcp.bindings.disable', input: { bindingId: 'binding', expectedRevision: 10,
      captureBefore: true }, context })).toEqual({ ok: true, result: { status: 'updated', revision: 11, cursor: 11,
      reversal: { scope: { serverId: 'home-a', accountId: 'mcp-account' }, bindingId: 'binding', before: false,
        applied: false, revision: 11 } } });
    const otherHome = createCliMcpServerStore({ credentials, serverId: 'home-b' });
    const executeInOtherHome = createMcpServerActionExecuteV1({ readCatalog: () => otherHome.readCatalog(),
      mutate: (change, expectedRevision) => otherHome.mutate(change, expectedRevision),
      machine: async () => { throw new Error('Unexpected Machine effect'); } });
    await expect(executeInOtherHome({ actionId: 'mcp.bindings.enable', input: { bindingId: 'binding', expectedRevision: 11,
      expectedEnabled: false, expectedScope: { serverId: 'home-a', accountId: 'mcp-account' } }, context }))
      .rejects.toMatchObject({ code: 'server_scope_mismatch' });
    expect(catalog.bindings[0]?.enabled).toBe(false);
    expect(await execute({ actionId: 'mcp.bindings.enable', input: { bindingId: 'binding', expectedRevision: 11,
      expectedEnabled: true }, context })).toEqual({ ok: true, result: { status: 'conflict', revision: 11 } });
    expect(catalog.bindings[0]?.enabled).toBe(false);
    expect(await execute({ actionId: 'mcp.bindings.enable', input: { bindingId: 'binding', expectedRevision: 11,
      expectedEnabled: false, expectedScope: { serverId: 'home-a', accountId: 'mcp-account' } }, context }))
      .toEqual({ ok: true, result: { status: 'updated', revision: 12, cursor: 12 } });
    expect(catalog.bindings[0]?.enabled).toBe(true);
    expect(await execute({ actionId: 'mcp.bindings.disable', input: { bindingId: 'binding', expectedRevision: 11,
      expectedEnabled: true }, context })).toEqual({ ok: true, result: { status: 'conflict', revision: 12 } });
    raceAtWrite = true;
    expect(await execute({ actionId: 'mcp.bindings.disable', input: { bindingId: 'binding', expectedRevision: 12,
      captureBefore: true }, context })).toEqual({ ok: true, result: { status: 'conflict', revision: 13 } });
    expect(catalog.bindings[0]?.enabled).toBe(true);
    await refreshActiveMcpServerCatalog({ credentials });
    expect(await execute({ actionId: 'mcp.bindings.disable', input: { bindingId: 'binding', expectedRevision: 13 }, context }))
      .toEqual({ ok: true, result: { status: 'updated', revision: 14, cursor: 14 } });
    expect(catalog.bindings[0]?.enabled).toBe(false);
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
      entry: { ...captured.catalog.servers[0], title: 'Updated without a UI' }, bindings: [] }, captured.revision);
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
