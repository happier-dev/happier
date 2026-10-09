import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Server } from 'node:http';
import { accountSettingsParse, FeaturesResponseSchema, formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import * as persistence from '@/persistence';
import type { HappyMcpSessionClient } from '../startHappyServer';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';

// The daemon catalog is an IPC boundary. Runtime, bridge, selectors and
// materialization remain real, including the local HTTP listener lifecycle.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); });
const credentials = { token: 'runner-account', encryption: null };
function server(id: string): McpServerCatalogEntryV1 {
  return { id, name: id, transport: 'stdio', stdio: { command: 'echo', args: [id] }, env: {}, createdAt: 1, updatedAt: 1 };
}
function snapshot(servers: McpServerCatalogEntryV1[] = []): ActiveAccountSettingsSnapshot {
  return { source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: true }),
    rawSettings: {}, settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
    mcpServerCatalog: { status: 'ready', authority: 'active', revision: 2, diagnostics: [],
      catalog: { v: 1, servers, bindings: servers.map(entry => ({ id: `binding-${entry.id}`, serverId: entry.id,
        enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })) } } };
}
function session(): HappyMcpSessionClient {
  return { sessionId: 'session-1', getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' }),
    updateMetadata: () => undefined };
}
function resolve(input: Readonly<{ snapshot: ActiveAccountSettingsSnapshot | null; accountCredentials?: null }>) {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  return resolveRunnerMcpServers({ session: session(), credentials,
    ...(input.accountCredentials === null ? { accountCredentials: null } : {}),
    accountSettings: input.snapshot?.settings ?? accountSettingsParse({}), accountSettingsSnapshot: input.snapshot,
    machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null });
}

describe('resolveRunnerMcpServers catalog admission', () => {
  it('refuses ordinary Account material after retirement while the real bridge listener is starting', async () => {
    // Credential disk I/O is the persistence boundary used by ordinary Home
    // admission; it supplies the same credentials as the real active owner.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const resourceId = 'ordinary-private';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
      v: 1, name: 'Ordinary private credential', kind: 'token', value: 'ordinary-private-value',
    } });
    const capturedSource = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([{ ...server('private-server'),
      env: { API_KEY: { t: 'savedSecret', secretId: ref } } }]));
    setActiveAccountSettingsSnapshot({ ...capturedSource, savedSecretCatalogState: 'ready', savedSecretResources: [{
      resourceId, ownerAccountId: 'ordinary-owner', displayName: 'Ordinary private credential', kind: 'token',
      encryptionMode: 'plain', revision: 1, materialStatus: 'ready', storedContent,
    }] });
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true,
      credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId,
      encryptionMode: 'plain', entry: { ref, source: 'shared_resource', relationship: 'owner',
        name: 'Ordinary private credential', kind: 'token', ownerAccountId: 'ordinary-owner', revision: 1,
        materialStatus: 'ready', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent, recipientEnvelope: null,
    }] });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      if (!String(input).endsWith('/v1/account/saved-secrets/resources/materials')) throw new Error('Unexpected Home request');
      return { status: 200, data: materials };
    });
    const captured = getActiveAccountSettingsSnapshot();
    if (!captured) throw new Error('Account fixture is unavailable');
    const listenerStarted = createDeferred<void>();
    const releaseListener = createDeferred<void>();
    let listener: Server | undefined;
    const emit = Server.prototype.emit;
    // The HTTP listener's OS completion is held; the real bridge, command
    // resolution, Account owner and SavedSecret materializer remain unmocked.
    vi.spyOn(Server.prototype, 'emit').mockImplementation(function (this: Server, event: string | symbol, ...args: unknown[]) {
      if (event !== 'listening') return emit.call(this, event, ...args);
      listener = this;
      listenerStarted.resolve();
      void releaseListener.promise.then(() => emit.call(this, event, ...args));
      return true;
    });
    const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolve({ snapshot: captured }));
    void pending.catch(() => undefined);
    try {
      await Promise.race([listenerStarted.promise, pending.then(() => { throw new Error('Bridge did not reach its listener boundary'); })]);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot(runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([server('replacement-server')])));
      releaseListener.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
    } finally {
      releaseListener.resolve();
      await pending.then(result => result.happierMcpServer.stop(), () => undefined);
      if (listener?.listening) await new Promise<void>((resolveClose, rejectClose) => listener!.close(error => error ? rejectClose(error) : resolveClose()));
    }
  });

  it('materializes the admitted row after the authored root has been removed', async () => {
    const result = await resolve({ snapshot: snapshot([server('row-server')]) });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { result.happierMcpServer.stop(); }
  });

  it('refuses unobserved and partial catalogs rather than silently dropping custom servers', async () => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    await expect(resolve({ snapshot: null })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const withoutPreferences = resolveRunnerMcpServers({ session: session(), credentials, accountSettings: null,
      machineId: 'machine-1', directory: '/tmp/repo' }).then(result => { result.happierMcpServer.stop(); return result; });
    await expect(withoutPreferences).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const opened = snapshot([server('valid-neighbor')]);
    if (opened.mcpServerCatalog?.status !== 'ready') throw new Error('Fixture is not ready');
    await expect(resolve({ snapshot: { ...opened, mcpServerCatalog: { ...opened.mcpServerCatalog, status: 'partial',
      diagnostics: [{ path: 'servers[1]', reason: 'invalid-stored-content' }] } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
  });

  it('does not admit an unavailable row even when non-strict policy is selected', async () => {
    await expect(resolve({ snapshot: { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable', reason: 'unreachable' } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
  });

  it('keeps restricted Session authority independent from Account catalog availability', async () => {
    const result = await resolve({ snapshot: { ...snapshot(), mcpServerCatalog: { status: 'unavailable', reason: 'forbidden' } }, accountCredentials: null });
    try { expect(Object.keys(result.mcpServers)).toEqual(['happier']); }
    finally { result.happierMcpServer.stop(); }
  });

  it('does not let retained root contents override a row-owned server set', async () => {
    const result = await resolve({ snapshot: { ...snapshot([server('row-server')]),
      rawSettings: { mcpServersSettingsV1: { v: 1, strictMode: false, servers: [server('retained-server')], bindings: [] } } } });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { result.happierMcpServer.stop(); }
  });

  it('admits selected SavedSecret references only through the captured foreign Home invocation', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const serverHttpBaseUrl = 'https://private-runner-home.test';
    const resourceId = 'private-runner-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const resource = { resourceId, ownerAccountId: 'private-owner', displayName: 'Private key', kind: 'apiKey' as const,
      encryptionMode: 'plain' as const, revision: 3, materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
        v: 1, name: 'Private key', kind: 'apiKey', value: 'stale-private-value',
      } }),
    };
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([
      { ...server('private-server'), env: { API_KEY: { t: 'savedSecret', secretId: ref } } },
    ]));
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials, serverHttpBaseUrl, snapshot: { ...captured, savedSecretCatalogState: 'ready', savedSecretResources: [resource] },
      isCurrent: async () => true,
    }));
    setActiveAccountSettingsSnapshot({ ...snapshot([server('unrelated-ambient-server')]),
      scopeKey: resolveAccountSettingsScopeKeyForToken('unrelated-ambient-account') });
    const ambient = getActiveAccountSettingsSnapshot();
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const fresh = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: 'plain',
      entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Private key', kind: 'apiKey', ownerAccountId: 'private-owner',
        revision: 4, materialStatus: 'ready', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
        v: 1, name: 'Private key', kind: 'apiKey', value: 'fresh-private-value',
      } }), recipientEnvelope: null,
    }] });
    let revoked = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      if (String(input) !== `${serverHttpBaseUrl}/v1/account/saved-secrets/resources/materials`) throw new Error('Wrong Home material request');
      return { status: 200, data: revoked ? { resources: [] } : fresh };
    });
    const privateSession: HappyMcpSessionClient = { ...session(), getServerBinding: () => ({ serverId: 'private-home', serverUrl: serverHttpBaseUrl }) };
    const input = { session: privateSession, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      savedSecretResources: [resource], operationContext, machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null };
    const result = await resolveRunnerMcpServers(input);
    try {
      expect(result.mcpServers['private-server']?.env?.API_KEY).toBe('fresh-private-value');
      expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    } finally { result.happierMcpServer.stop(); }
    revoked = true;
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden', reference: ref });
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
  });
});
