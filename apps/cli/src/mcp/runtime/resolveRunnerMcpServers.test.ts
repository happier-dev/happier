import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { createServer, request as httpRequest, Server, type IncomingMessage, type RequestOptions } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { accountSettingsParse, FeaturesResponseSchema, formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import * as persistence from '@/persistence';
import type { HappyMcpSessionClient } from '../startHappyServer';
import { resolveRunnerMcpServers as resolveRunnerMcpServersFromHost } from './resolveRunnerMcpServers';
import type { McpRequestAuthPort } from './mcpRequestAuth';
import { McpServerCatalogV1Schema, projectStoredMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { diffMcpServerConfigOverride } from '../../../../ui/sources/components/settings/mcpServers/detail/mcpMachineOverride';
import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { resolveRunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { materializeRunnerMcpMaterial } from '../servers/materializeRunnerMcpMaterial';
import { connectSessionMcpClient } from './sessionMcpLocalTransport';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { readClaudeMcpConfigServers } from '../../../../../packages/plugins/claude/src/agent/mcp/configServers';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const packageDownloadNetwork = vi.hoisted(() => ({ origin: '', requests: [] as string[] }));

// Redirect only the external package-download network boundary. Selection,
// acquisition, materialization and the Session notice projection remain real.
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>();
  return { ...original, request: (url: string | URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (!packageDownloadNetwork.origin) return original.request(url, options, callback);
    packageDownloadNetwork.requests.push(new URL(String(url)).pathname);
    return httpRequest(packageDownloadNetwork.origin, options, callback);
  } };
});

// The daemon catalog is an IPC boundary. Runtime, bridge, selectors and
// materialization remain real, including the local HTTP listener lifecycle.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot(); });
const credentials = { token: 'runner-account', encryption: null, credentialProvenance: 'stored_session' as const };
// These fixtures model direct local CLI composition unless private requester
// custody is explicitly supplied. The real resolver never infers that origin.
const resolveRunnerMcpServers = ((params: Parameters<typeof resolveRunnerMcpServersFromHost>[0]) => {
  return resolveRunnerMcpServersFromHost({ localWorkflow: true, ...params });
}) as typeof resolveRunnerMcpServersFromHost;
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
function session(): HappyMcpSessionClient & Required<Pick<HappyMcpSessionClient, 'enqueueSessionEventCommitted'>> {
  return { sessionId: 'session-1', getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' }),
    updateMetadata: () => undefined,
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }) };
}
function holdExactHomeProfileAtStorageBoundary(profileId = 'test-home', homeId = 'srv_test-home') {
  vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true,
    servers: { [profileId]: { id: profileId, name: 'Test', serverUrl: 'https://test-home.example.test',
      webappUrl: 'https://test-home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://test-home.example.test',
        revision: 1, endpoints: [{ kind: 'https', url: 'https://test-home.example.test' }] },
    } } });
}
function resolve(input: Readonly<{ snapshot: ActiveAccountSettingsSnapshot | null; accountSettings?: ActiveAccountSettingsSnapshot['settings']; accountCredentials?: null; includeHappierMcpServer?: boolean }>) {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  return resolveRunnerMcpServers({ session: session(), credentials,
    ...(input.accountCredentials === null ? { accountCredentials: null } : {}),
    accountSettings: input.accountSettings ?? input.snapshot?.settings ?? accountSettingsParse({}), accountSettingsSnapshot: input.snapshot,
    machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null,
    includeHappierMcpServer: input.includeHappierMcpServer });
}

describe('resolveRunnerMcpServers catalog admission', () => {
  it.each([false, true])('keeps a birth-unavailable resume MCP-free only for a canonically empty explicit selection (forced include: %s)', async forced => {
    let catalogReads = 0;
    const captured = { ...snapshot([server('selected')]), get mcpServerCatalog(): ActiveAccountSettingsSnapshot['mcpServerCatalog'] {
      catalogReads += 1;
      throw new Error('Explicitly disabled MCP must not inspect the Account catalog');
    } };
    const ids = ['selected', 'plugin:fixture/tools'];
    const pending = resolveRunnerMcpServersFromHost({ session: session(), credentials, accountSettings: captured.settings,
      accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer: false,
      sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: false,
        forceIncludeServerIds: ids, forceExcludeServerIds: forced ? [] : ids } },
    });
    if (forced) await expect(pending).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
    else {
      const profile = await pending;
      try {
        expect(Object.keys(profile.mcpServers)).toEqual([]);
        expect(profile.happierMcpServer.supportedSessionReadActions).toEqual([]);
      }
      finally { await profile.happierMcpServer.stop(); }
    }
    expect(catalogReads).toBe(0);
  });
  it.each([false, true])('refuses requester pre-resolved extras even when the catalog selects no servers (restricted: %s)', async restricted => {
    const owner = session();
    holdExactHomeProfileAtStorageBoundary();
    const scoped = persistence.bindRequesterSessionCredentialScope({ ...credentials }, {
      serverId: 'test-home', serverHttpBaseUrl: owner.getServerBinding().serverUrl,
      requesterSession: { sessionId: owner.sessionId, homeServerIdentityId: 'srv_test-home', attribution: {
        serverId: 'test-home', accountId: 'member', machineId: 'machine-1', installationId: 'installation-1',
      } },
    });
    await expect(resolveRunnerMcpServersFromHost({ session: owner, credentials: scoped,
      ...(restricted ? { accountCredentials: null } : {}),
      accountSettings: null, accountSettingsSnapshot: null, machineId: 'machine-1', directory: '/tmp/repo',
      includeHappierMcpServer: false, resolvedMcpServers: { resolved: { command: process.execPath, args: [] } },
    })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
  });
  it.each(['member', 'empty', 'owner'])('reads native config only for admitted selected extras (%s)', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-mcp-admission-'));
    await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { selected: { command: 'native-fixture', args: [] } } }));
    let nativeReads = 0;
    // Plugin discovery is the integration boundary. The actual first-party
    // native config reader, catalog selection and materializer stay real.
    const registry = { contributes: { mcpDiscoverySources: [{ pluginId: 'claude', definition: {
      id: 'native-config', title: 'Native config', loadedInHappierSessions: true, metadata: { agentId: 'claude' },
    } }] }, discoverMcpServersForDetection: async () => {
      nativeReads += 1;
      const detected = await readClaudeMcpConfigServers({ directory: root, env: { HOME: root } });
      return { endpoints: [], detectedServers: detected.servers, warnings: detected.warnings };
    } } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const owner = session();
    if (kind === 'member') holdExactHomeProfileAtStorageBoundary();
    const scopedCredentials = kind === 'member' ? persistence.bindRequesterSessionCredentialScope({ ...credentials }, {
      serverId: 'test-home', serverHttpBaseUrl: owner.getServerBinding().serverUrl,
      requesterSession: { sessionId: owner.sessionId, homeServerIdentityId: 'srv_test-home', attribution: {
        serverId: 'test-home', accountId: 'member', machineId: 'machine-1', installationId: 'installation-1',
      } },
    }) : credentials;
    const selected = runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => snapshot(kind === 'empty' ? [] : [server('selected')]));
    setActiveAccountSettingsSnapshot(selected);
    let profile: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    try {
      const pending = runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => resolveRunnerMcpServers({
        session: owner, credentials: scopedCredentials, accountSettingsSnapshot: selected, machineId: 'machine-1',
        directory: root, agentId: 'claude', agentAcceptsUserMcp: true, pluginMcpRuntimeRegistry: registry,
        includeHappierMcpServer: false, localWorkflow: kind !== 'member', isolationEnabled: kind === 'member', env: { HOME: root },
      }));
      if (kind === 'member') await expect(pending).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
      else profile = await pending;
      expect(nativeReads).toBe(kind === 'owner' ? 1 : 0);
      if (profile) expect(Object.keys(profile.mcpServers)).toEqual(kind === 'empty' ? [] : ['selected_2']);
    } finally { await profile?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['missing-local-proof', 'server-only-scope'])('refuses absent Session requester custody before catalog reads (%s)', async kind => {
    const unbound = kind === 'server-only-scope'
      ? persistence.bindRequesterSessionCredentialScope({ ...credentials }, {
        serverId: 'test-home', serverHttpBaseUrl: 'https://test-home.example.test' })
      : credentials;
    await expect(resolveRunnerMcpServersFromHost({ session: session(), credentials: unbound,
      localWorkflow: kind === 'server-only-scope', machineId: 'machine-1', directory: '/tmp/repo',
      includeHappierMcpServer: false })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
  });
  it.each(['member', 'owner'])('admits only the owner stdio profile despite an unrelated Account publication (%s)', async accountId => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const homeId = 'srv_test-home';
    const profileId = 'test-home';
    const requesterSession = { ...session(), getServerBinding: () => ({ serverId: profileId, serverUrl: 'https://test-home.example.test' }) };
    const requesterCredentials = persistence.bindRequesterSessionCredentialScope({ token: 'member-account', encryption: null }, {
      serverId: profileId, serverHttpBaseUrl: 'https://test-home.example.test',
      requesterSession: { sessionId: 'session-1', homeServerIdentityId: homeId, attribution: {
        serverId: profileId, accountId, machineId: 'machine-1', installationId: 'installation-1',
      } },
    });
    // Persisted profile I/O is the boundary; the exact Home resolver stays real.
    holdExactHomeProfileAtStorageBoundary(profileId, homeId);
    let materialReads = 0;
    const configured = { ...server('requester-tools'), env: { FIXTURE_VALUE: { t: 'literal' as const, v: '${PROTECTED_MATERIAL}' } } };
    const selected = { ...snapshot([configured]), scopeKey:
      runWithServerHttpBaseUrl('https://test-home.example.test', () => resolveAccountSettingsScopeKeyForToken(requesterCredentials.token)) };
    setActiveAccountSettingsSnapshot(selected);
    const processEnv: NodeJS.ProcessEnv = {};
    Object.defineProperty(processEnv, 'PROTECTED_MATERIAL', { enumerable: true, get() { materialReads += 1; return 'fixture-value'; } });
    let machineReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url) !== 'https://test-home.example.test/v1/machines/machine-1') throw new Error('Unexpected requester Home read');
      machineReads += 1;
      setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settingsVersion: selected.settingsVersion + 1,
        settings: accountSettingsParse({ ...selected.settings, preferredLanguage: 'fr' }) });
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: { machine: {
        id: 'machine-1', installationId: 'installation-1', metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
      } } };
    });
    const profile = resolveRunnerMcpServers({ session: requesterSession, credentials: requesterCredentials,
      accountCredentials: requesterCredentials, accountSettings: null, accountSettingsSnapshot: selected,
      machineId: 'machine-1', directory: process.cwd(), env: processEnv, isolationEnabled: false, includeHappierMcpServer: false });
    if (accountId === 'member') {
      await expect(profile).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
      expect(materialReads).toBe(0);
    } else {
      const admitted = await profile;
      try { expect(Object.keys(admitted.mcpServers)).toEqual(['requester-tools']); expect(materialReads).toBeGreaterThan(0); }
      finally { await admitted.happierMcpServer.stop(); }
    }
    expect(machineReads).toBe(1);
  });

  it.runIf(process.platform === 'linux')('joins an in-flight custom list and its child before retiring the Session endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-custom-retirement-'));
    const startedPath = join(root, 'started');
    const closedPath = join(root, 'closed');
    const started = createDeferred<void>();
    const watcher = watch(root, (_event, name) => { if (String(name) === 'started') started.resolve(); });
    const selected = { ...server('selected'), stdio: { command: process.execPath, args: ['-e', `
      const recordClosed=()=>require('node:fs').writeFileSync(${JSON.stringify(closedPath)},'closed');
      process.on('exit',recordClosed);
      process.on('SIGTERM',()=>{recordClosed();process.exit(0)});
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line); if(request.id===undefined) return;
        if(request.method==='tools/list') { require('node:fs').writeFileSync(${JSON.stringify(startedPath)},'started'); return; }
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{
          protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'selected',version:'1'}
        }})+'\\n');
      });
    `] } };
    const owner = session();
    const captured = runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => snapshot([selected]));
    setActiveAccountSettingsSnapshot(captured);
    const profile = await runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => resolveRunnerMcpServers({
      session: owner, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: root, includeHappierMcpServer: false, agentAcceptsUserMcp: false,
      // The cancellation boundary is the real external child, not a second
      // source CLI bootstrap inside its launcher. Catalog/currentness stay real.
      resolvedMcpServers: { selected: selected.stdio },
      localTransport: { agentUid: process.getuid!() },
    }));
    if (!profile.sessionMcpContext) throw new Error('Missing Session MCP context');
    const retiredContext = profile.sessionMcpContext;
    const connection = await connectSessionMcpClient(retiredContext);
    try {
      const listed = connection.client.listTools({ _meta: { 'happier/tool-sources': true } })
        .then(() => ({ ok: true }), () => ({ ok: false }));
      await started.promise;
      await profile.happierMcpServer.stop();
      expect(await readFile(closedPath, 'utf8')).toBe('closed');
      expect(profile.sessionMcpContext).toBeUndefined();
      expect(profile.agentEnvironment).toBeUndefined();
      await expect(connectSessionMcpClient(retiredContext)).rejects.toMatchObject({ code: 'mcp_socket_access_unavailable' });
      // The test owns its SDK client. Endpoint retirement joins host resources;
      // it does not introduce another response/reconnect deadline in the SDK.
      await connection.close();
      expect(await listed).toEqual({ ok: false });
    } finally { watcher.close(); await connection.close(); await profile.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'linux')('refuses a retired custom profile before another daemon preparation', async () => {
    let preparations = 0;
    // Daemon IPC is the external boundary; currentness and resolver stay real.
    const owner = { ...session(), getPluginMcpPort: () => ({ prepare: async () => {
      preparations += 1;
      return { items: [], discoverNativeServers: async () => [], materialize: async (servers: readonly import('../runtimeTypes').ResolvedSessionMcpServer[]) => servers,
        dispose: async () => undefined };
    } }) };
    const captured = runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => snapshot());
    setActiveAccountSettingsSnapshot(captured);
    const profile = await runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => resolveRunnerMcpServers({
      session: owner, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer: false, agentAcceptsUserMcp: false,
      localTransport: { agentUid: process.getuid!() },
    }));
    if (!profile.sessionMcpContext) throw new Error('Missing Session MCP context');
    const connection = await connectSessionMcpClient(profile.sessionMcpContext);
    try {
      const admittedPreparations = preparations;
      clearActiveAccountSettingsSnapshot();
      await expect(connection.client.listTools({ _meta: { 'happier/tool-sources': true } }))
        .rejects.toMatchObject({ data: { errorCode: 'mcp_catalog_unavailable' } });
      expect(preparations).toBe(admittedPreparations);
    } finally { await connection.close(); await profile.happierMcpServer.stop(); }
  });

  describe('selected custom source delivery', () => {
    beforeAll(async () => {
      // Prepare the real source module before timing MCP behavior; no CLI dist build is needed.
      await import('@/mcp/startHappyServer');
    });

    const exerciseCustomSource = async (delivery: 'default' | 'disabled' | 'native') => {
      vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
      const root = await mkdtemp(join(tmpdir(), 'happier-custom-permission-'));
      const calledPath = join(root, 'called');
      const selected = { ...server('selected'), tools: { default: 'ask' as const,
        overrides: delivery === 'native' ? {} : { echo: 'off' as const } },
        stdio: { command: process.execPath, args: ['-e', `
          require('node:readline').createInterface({input:process.stdin}).on('line', line => {
            const request=JSON.parse(line);
            if(request.id===undefined) return;
            if(request.method==='tools/call') require('node:fs').writeFileSync(${JSON.stringify(calledPath)},'called');
            const result=request.method==='initialize'
              ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'selected',version:'1'}}
              : request.method==='tools/list' ? {tools:[{name:'echo',inputSchema:{type:'object'}}]}
              : {content:[{type:'text',text:'called'}]};
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
          });
        `] } };
      const metadata = delivery === 'disabled' ? createTestMetadata({ mcpSelectionV1: {
        v: 1, managedServersEnabled: true, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [],
      } }) : undefined;
      const owner = { ...session(), ...(metadata ? { getMetadataSnapshot: () => metadata } : {}),
        ...(delivery === 'native' ? { getActiveTurnAdmissionWitness: () => ({
          inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 1, userMessageSeqs: [1],
          causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
        }) } : {}),
      };
      const captured = runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => snapshot([selected]));
      setActiveAccountSettingsSnapshot(captured);
      const permissionSession = createMutableApiSessionClientFixture({ sessionId: owner.sessionId });
      const permissionRpc = new ServerBoundPermissionRpcHandlerManager(owner.sessionId);
      // Session persistence and authenticated RPC attribution are process boundaries.
      const permission = new ProviderEnforcedPermissionHandler({ ...permissionSession,
        rpcHandlerManager: permissionRpc } as unknown as ApiSessionClient, {
          logPrefix: '[Session custom MCP]',
          ...(delivery === 'native' ? { getWorkspaceWrites: () => 'allow' as const } : {}),
        });
      const profile = await runWithServerHttpBaseUrl(owner.getServerBinding().serverUrl, () => resolveRunnerMcpServers({
        session: owner, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
        machineId: 'machine-1', directory: root, includeHappierMcpServer: false, agentAcceptsUserMcp: false,
        ...(metadata ? { sessionMetadata: metadata } : {}),
        mcpPermissionHandler: permission, localTransport: { agentUid: process.getuid!() },
      }));
      if (!profile.sessionMcpContext) throw new Error('Missing Session MCP context');
      const connection = await connectSessionMcpClient(profile.sessionMcpContext);
      try {
        const native = await connection.client.listTools();
        const nativeNames = native.tools.map(tool => tool.name);
        if (delivery === 'disabled') expect(nativeNames).toEqual([]);
        else {
          expect(nativeNames).toContain('change_title');
          expect(nativeNames).not.toContain('echo');
        }
        await expect(stat(calledPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const calling = connection.client.callTool({ name: 'echo', arguments: {},
          _meta: { 'happier/tool-source': 'selected', 'happier/tool-call-id': 'custom-native' } });
        let returned: Awaited<typeof calling> | undefined;
        void calling.then(value => { returned = value; }, () => undefined);
        if (delivery === 'native') {
          await vi.waitFor(() => expect(returned ?? { pendingIds: Object.keys(permissionSession.__getAgentState().requests ?? {}) })
            .toMatchObject({ pendingIds: [expect.any(String)] }));
          const [requestId, pendingRequest] = Object.entries(permissionSession.__getAgentState().requests ?? {})[0]!;
          const offer = pendingRequest.nativeChoices;
          expect(offer).toMatchObject({ source: 'mcp.tool', choices: expect.arrayContaining([
            { id: 'approved', label: 'Allow once', scope: 'once', decision: 'approved',
              response: { approved: true, decision: 'approved' } },
          ]) });
          expect(offer?.choices).toEqual(expect.arrayContaining([expect.objectContaining({
            id: 'mcp_always_allow', scope: 'localPersistent', decision: 'approved_for_session',
            response: { approved: true, decision: 'approved_for_session' },
            followUp: { actionId: 'mcp.servers.tools.set', input: { serverId: 'selected', tools: { echo: 'allow' } } },
          })]));
          await expect(stat(calledPath)).rejects.toMatchObject({ code: 'ENOENT' });
          const respond = permissionRpc.handlers.get('session.permission.respond')!;
          await expect(respond({ id: requestId, approved: true })).resolves.toMatchObject({
            ok: false, errorCode: 'permission_response_invalid',
          });
          await expect(stat(calledPath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(respond({ id: requestId, turnId: pendingRequest.turnId, nativeChoice: { requirementId: offer!.requirementId, choiceId: 'approved' },
            approved: false, decision: 'denied' })).resolves.toBeUndefined();
          expect(permissionSession.__getAgentState().completedRequests?.[requestId]).toMatchObject({ decision: 'approved' });
          expect((await calling).structuredContent).toMatchObject({ ok: true });
          expect(await readFile(calledPath, 'utf8')).toBe('called');
          expect(permissionSession.__getAgentState().completedRequests?.[requestId]).toMatchObject({
            decision: 'approved', nativeChoice: { requirementId: offer!.requirementId, choiceId: 'approved' },
          });
          return;
        } else {
          expect((await calling).structuredContent).toMatchObject({ ok: false, errorCode: 'permission_denied' });
          await expect(stat(calledPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        const listed = await connection.client.listTools({ _meta: { 'happier/tool-sources': true } });
        expect(listed.tools.filter(tool => tool._meta?.['happier/tool-source'] === 'selected').map(tool => tool.name)).toEqual(['echo']);
        clearActiveAccountSettingsSnapshot();
        await expect(connection.client.listTools({ _meta: { 'happier/tool-sources': true } }))
          .rejects.toMatchObject({ data: { errorCode: 'mcp_catalog_unavailable' } });
        await expect(stat(calledPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await permission.reset();
        await connection.close();
        await profile.happierMcpServer.stop();
        await rm(root, { recursive: true, force: true });
      }
    };

    it.runIf(process.platform === 'linux').each(['default', 'disabled'] as const)(
      'keeps custom source permission and Account currentness with %s built-in delivery', exerciseCustomSource);
    it.runIf(process.platform === 'linux')('requires the stored native choice before a custom MCP tool effect',
      () => exerciseCustomSource('native'));

  });

  it.runIf(process.platform === 'linux')('creates the owning authenticated Session bridge for extension delivery without advertising a duplicate native MCP server', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const captured = snapshot();
    const result = await resolveRunnerMcpServers({ session: session(), credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
      includeHappierMcpServer: false,
      localTransport: { agentUid: process.getuid!() },
    });
    try {
      expect(result.mcpServers).not.toHaveProperty('happier');
      expect(Reflect.get(result, 'sessionMcpContext')).toMatchObject({ v: 1,
        socketPath: expect.any(String), bearerToken: expect.any(String) });
    } finally { await result.happierMcpServer.stop(); }
    expect(result.sessionMcpContext).toBeUndefined();
  });

  it.each(['optional', 'strict', 'reviewed'] as const)('reports a missing configured runner without acquiring replacement tooling (scope=%s)', async scope => {
    const strictMode = scope === 'strict';
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-download-refusal-'));
    const fixture = createServer((_request, response) => { response.writeHead(403).end(); });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Expected fixture listener');
    packageDownloadNetwork.origin = `http://127.0.0.1:${address.port}`;
    packageDownloadNetwork.requests = [];
    const captured = { ...snapshot([{ ...server('unavailable-id'), name: 'package-tools',
      stdio: { command: 'npx', args: ['fixture-package'] } }, server('available')]),
      settings: accountSettingsParse({ mcpServersStrictMode: strictMode }) };
    const notices: unknown[] = [];
    const env = { HOME: root, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: '', PATH: '' };
    try {
      if (scope === 'reviewed') {
        if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
        const prepared = resolveRunnerMcpMaterialV1({
          settings: { ...captured.mcpServerCatalog.catalog, strictMode: false }, agentId: 'codex',
          agentAcceptsUserMcp: true, resolveSavedSecret: () => null,
        });
        if (!prepared.ok) throw new Error('Expected reviewed MCP material');
        await expect(materializeRunnerMcpMaterial({ material: prepared.material, directory: root,
          processEnv: env, tmpDir: root })).rejects.toThrow(/Failed to materialize MCP server package-tools: Configured MCP command npx was not found/);
      } else {
        const resolution = resolveRunnerMcpServers({ session: { ...session(),
          enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; } },
          credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
          machineId: 'machine-1', directory: root, tmpDir: root, includeHappierMcpServer: false, env });
        if (strictMode) {
          await expect(resolution).rejects.toThrow(/Failed to materialize MCP server package-tools: Configured MCP command npx was not found/);
          expect(notices).toEqual([]);
        } else {
          const result = await resolution;
          try {
            expect(Object.keys(result.mcpServers)).toEqual(['available']);
            expect(notices.map(readSessionCapabilityNoticeV1).filter(Boolean)).toEqual([{ v: 1, items: [{
              kind: 'mcp_server', name: 'package-tools', itemId: 'unavailable-id', code: 'invalid_server',
              detail: expect.stringContaining('Configured MCP command npx was not found'),
            }] }]);
          } finally { await result.happierMcpServer.stop(); }
        }
      }
      // Missing user tooling is a prerequisite failure, never an implicit download.
      expect(packageDownloadNetwork.requests).toEqual([]);
    } finally {
      packageDownloadNetwork.origin = '';
      packageDownloadNetwork.requests = [];
      await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it('applies the editor session-folder difference after catalog storage on only the selected machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-session-folder-'));
    const base = { ...server('local'), stdio: { command: 'echo', args: ['base'], cwd: { t: 'path' as const, path: '/base-folder' } } };
    const edited = { ...base, stdio: { ...base.stdio, cwd: { t: 'session' as const } } };
    const difference = diffMcpServerConfigOverride(base, edited);
    const captured = snapshot([{ ...base, configOverrides: [{ ...difference, target: { t: 'machine', machineId: 'machine-1' } }] }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    const written = McpServerCatalogV1Schema.parse(captured.mcpServerCatalog.catalog);
    // The stored reader remains tolerant; current writes above use the strict schema.
    const stored = projectStoredMcpServerCatalogV1(JSON.parse(JSON.stringify({ ...written, futureField: true,
      servers: written.servers.map(entry => ({ ...entry, futureField: true })),
    })));
    expect(stored.status).toBe('opened');
    if (stored.status !== 'opened') throw new Error('Expected stored catalog');
    const restored: ActiveAccountSettingsSnapshot = { ...captured,
      mcpServerCatalog: { ...captured.mcpServerCatalog, catalog: stored.catalog } };
    try {
      for (const machineId of ['machine-1', 'machine-2']) {
        const result = await resolveRunnerMcpServers({ session: session(), credentials,
          accountSettings: restored.settings, accountSettingsSnapshot: restored, machineId, directory: '/session-folder',
          env: {}, tmpDir: root, includeHappierMcpServer: false,
        });
        try {
          const configPath = result.mcpServers.local?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
          expect(configPath).toBeDefined();
          expect(JSON.parse(await readFile(configPath!, 'utf8'))).toMatchObject({
            command: 'echo', args: ['base'], cwd: machineId === 'machine-1' ? '/session-folder' : '/base-folder',
          });
        } finally { await result.happierMcpServer.stop(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['zero-rules', 'another-machine', 'another-agent'] as const)('materializes a Session include with %s while keeping unsupported Agent refusal', async scenario => {
    const captured = snapshot([server('included')]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Missing catalog');
    captured.mcpServerCatalog.catalog.bindings = scenario === 'zero-rules' ? [] : [{
      ...captured.mcpServerCatalog.catalog.bindings[0]!,
      ...(scenario === 'another-machine' ? { target: { t: 'machine', machineId: 'other' } as const } : { agentId: 'gemini' }),
    }];
    const input = { session: session(), credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['included'], forceExcludeServerIds: [] } },
      includeHappierMcpServer: false as const };
    const result = await resolveRunnerMcpServers(input);
    try { expect(Object.keys(result.mcpServers)).toEqual(['included']); }
    finally { await result.happierMcpServer.stop(); }
    const unsupported = await resolveRunnerMcpServers({ ...input, agentAcceptsUserMcp: false });
    try { expect(unsupported.mcpServers).toEqual({}); }
    finally { await unsupported.happierMcpServer.stop(); }
  });
  it.each([false, true])('keeps reach independent from machine cwd/env overrides (Everywhere On=%s)', async enabled => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-machine-config-'));
    const captured = snapshot([{ ...server('local'), stdio: { command: 'echo', args: ['base'], cwd: { t: 'session' } },
      env: { REGION: { t: 'literal', v: 'base' } }, configOverrides: [{
        target: { t: 'machine', machineId: 'machine-1' }, stdio: { cwd: { t: 'path', path: '~\\custom\\mcp' } },
        envPatch: { REGION: { t: 'literal', v: 'machine' } },
      }],
    }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    captured.mcpServerCatalog.catalog.bindings[0]!.enabled = enabled;
    const result = await resolveRunnerMcpServers({ session: session(), credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo',
      env: { HOME: root, USERPROFILE: root }, tmpDir: root, includeHappierMcpServer: false,
    });
    try {
      if (!enabled) expect(result.mcpServers).toEqual({});
      else {
        expect(result.mcpServers.local?.env).not.toHaveProperty('REGION');
        const path = result.mcpServers.local?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
        expect(path).toBeDefined();
        expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({
          command: 'echo', args: ['base'], cwd: join(root, 'custom', 'mcp'), env: { REGION: 'machine' },
        });
      }
    } finally { await result.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('resolves Project rules once before materializing and refuses an unreadable association', async () => {
    const base = snapshot([server('tools')]);
    if (base.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    const projectCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'mcp-project-account' })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' as const };
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = { ...base, mcpServerCatalog: { ...base.mcpServerCatalog, catalog: { ...base.mcpServerCatalog.catalog,
      bindings: base.mcpServerCatalog.catalog.bindings.map(rule => ({ ...rule, target: { t: 'project' as const, projectKey: 'project' } })),
    } }, scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(projectCredentials.token)) };
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: projectCredentials, snapshot: captured, serverHttpBaseUrl, isCurrent: async () => true,
    }));
    const serverId = session().getServerBinding().serverId;
    const key = { kind: 'workspace-ref', serverId, id: 'checkout' };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
    const request = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine-1',
        rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
    ] } });
    const input = { session: session(), credentials: projectCredentials, accountSettings: captured.settings, accountSettingsSnapshot: captured, operationContext,
      machineId: 'machine-1', directory: '/repo', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, includeHappierMcpServer: false as const };
    const result = await resolveRunnerMcpServers(input);
    try {
      expect(Object.keys(result.mcpServers)).toEqual(['tools']);
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    } finally { await result.happierMcpServer.stop(); }
    expect(request.mock.calls.filter(call => call[0].endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`))).toHaveLength(1);
    request.mockRejectedValue(new Error('network_unavailable'));
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
    request.mockClear();
    const unsupported = await resolveRunnerMcpServers({ ...input, agentAcceptsUserMcp: false });
    try { expect(Object.keys(unsupported.mcpServers)).toEqual([]); } finally { await unsupported.happierMcpServer.stop(); }
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['mcp_catalog_unavailable', 'mcp_catalog_unavailable', 'mcp_catalog_unavailable'],
    ['mcp_resource_mismatch', 'mcp_resource_mismatch', 'mcp_resource_mismatch'],
    ['native_agent_privileged_effect_authority_unavailable', 'mcp_request_auth_unavailable', 'native_agent_privileged_effect_authority_unavailable'],
    ['native_agent_privileged_effect_outcome_unknown', 'mcp_request_auth_unavailable', 'native_agent_privileged_effect_outcome_unknown'],
    ['native_agent_privileged_effect_authority_unavailable', 'mcp_request_auth_unavailable', 'agent_runtime_daemon_service_forbidden', 'daemon_service_dispatch', 'agent_runtime_daemon_service_forbidden'],
    ['untrusted exception with private connection details', 'mcp_request_auth_unavailable', 'mcp_request_auth_unavailable'],
  ])('keeps other servers available and reports a safe refusal when OAuth admission fails (%s)', async (failure, detail, failureCode, failureCheckpoint = 'request_auth_open', causeCode?: string) => {
    const warnings = vi.spyOn(logger, 'debug');
    const notices: unknown[] = [];
    const captured = snapshot([server('static'), { id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const nonStrict = { ...captured, settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const result = await resolveRunnerMcpServers({ session: { ...session(),
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
      getMcpRequestAuthPort: () => ({
      open: async () => { throw new Error(failure, causeCode ? { cause: { code: causeCode, stage: 'dispatch' } } : undefined); }, close: async () => undefined,
    }) }, credentials, accountSettings: nonStrict.settings, accountSettingsSnapshot: nonStrict,
    machineId: 'machine-1', directory: '/repo', tmpDir: null, includeHappierMcpServer: false });
    try {
      expect(Object.keys(result.mcpServers)).toEqual(['static']);
      expect(warnings.mock.calls).toContainEqual(['[mcp] Materialization warnings', {
        warningCount: 1, warnings: [{ serverName: 'oauth', code: 'invalid_server', detail,
          failureCode, failureCheckpoint }],
      }]);
      expect(JSON.stringify(notices)).not.toContain('failureCheckpoint');
      expect(JSON.stringify(notices)).not.toContain('native_agent_privileged_effect');
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('private connection details');
    } finally { await result.happierMcpServer.stop(); }
  });
  it('uses the materializer refusal for strict OAuth admission without exposing the port exception', async () => {
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
      url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' },
    }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const notices: unknown[] = [];
    await expect(resolveRunnerMcpServers({ session: { ...session(),
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
      getMcpRequestAuthPort: () => ({
        open: async () => { throw Object.assign(new Error('private credential transport response'), { code: 'mcp_request_auth_unavailable' }); },
        close: async () => {},
      }),
    }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
    machineId: 'machine-1', directory: '/repo', includeHappierMcpServer: false })).rejects.toThrow(/^mcp_request_auth_unavailable$/);
    expect(notices).toEqual([]);
  });
  it('opens a per-server OAuth capability through the admitted Session port and closes it with the MCP profile', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const resource = 'https://mcp.example.test/path';
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: { url: resource, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-runner-auth-'));
    const opened: Array<Parameters<import('./mcpRequestAuth').McpRequestAuthPort['open']>[0]> = [];
    const closed: string[] = [];
    // The authenticated daemon channel is the system boundary; runner selection and materialization stay real.
    const port: import('./mcpRequestAuth').McpRequestAuthPort = {
      async open(input) { opened.push(input); elapsedMs += 700; return { capabilityFile: join(root, 'capability.json'), resource }; },
      async close(input) { closed.push(input.materializationId); },
    };
    let resolved: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    try {
      resolved = await resolveRunnerMcpServers({
        session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
        accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
        includeHappierMcpServer: false,
      });
      expect(opened).toHaveLength(1);
      const phases = diagnostics.mock.calls.flatMap(([message, fields]) => message === '[mcp] Startup phase'
        && fields && typeof fields === 'object' ? [fields as Record<string, unknown>] : []);
      expect(phases).toContainEqual(expect.objectContaining({ sessionId: 'session-1', phase: 'request_auth', durationMs: 700, elapsedMs: 700 }));
      expect(phases).toContainEqual(expect.objectContaining({ phase: 'config_materialization', durationMs: 0, elapsedMs: 700 }));
      expect(JSON.stringify(phases)).not.toContain(resource);
      expect(JSON.stringify(phases)).not.toContain(root);
      expect(opened[0]).toMatchObject({ serverId: 'oauth', resource });
      const config = JSON.parse(await readFile(resolved.mcpServers.oauth!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
      expect(config.auth).toEqual({ capabilityFile: join(root, 'capability.json'), resource });
      await resolved.happierMcpServer.stop();
      expect(closed).toEqual([opened[0]!.materializationId]);
    } finally { await resolved?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('refuses unregistered Run OAuth occurrences before capability open even in non-strict mode', async () => {
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
      url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' },
    }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const open = vi.fn<McpRequestAuthPort['open']>();
    await expect(resolveRunnerMcpServers({
      session: { ...session(), getMcpRequestAuthPort: () => ({ open, close: async () => {} }) }, credentials,
      accountSettings: accountSettingsParse({ mcpServersStrictMode: false }), accountSettingsSnapshot: {
        ...captured, settings: accountSettingsParse({ mcpServersStrictMode: false }),
      }, machineId: 'machine-1', directory: '/repo', includeHappierMcpServer: false,
      executionRun: { runId: 'unregistered-run', workDepth: 0, cwd: '/repo', signal: new AbortController().signal,
        isCurrent: () => true, readActiveTurnAdmissionWitness: () => null, readCurrentRunOccurrence: () => null },
    })).rejects.toThrow('mcp_request_auth_not_active');
    expect(open).not.toHaveBeenCalled();
  });
  it.each([false, true])('joins independent OAuth issuances before materialization or strict failure (refused=%s)', async refused => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-parallel-auth-'));
    const captured = snapshot(['first', 'second', 'third'].map(id => ({ id, name: id, transport: 'http',
      remote: { url: `https://${id}.example.test/mcp`, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 })));
    const started: string[] = [];
    const closed: string[] = [];
    const pending = new Map<string, ReturnType<typeof createDeferred<void>>>();
    let released = false;
    let settled = false;
    let resolved: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    const port: McpRequestAuthPort = {
      async open(input) {
        started.push(input.serverId);
        const gate = createDeferred<void>();
        pending.set(input.serverId, gate);
        if (!released) await gate.promise;
        if (refused && input.serverId === 'first') throw new Error('mcp_resource_mismatch');
        return { capabilityFile: join(root, `${input.serverId}.json`), resource: input.resource };
      },
      async close(input) { closed.push(input.materializationId); },
    };
    const work = resolveRunnerMcpServers({ session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
      includeHappierMcpServer: false }).then(value => { resolved = value; settled = true; return value; }, error => { settled = true; throw error; });
    // Retain the failure until all independently issued capabilities settle.
    const outcome = work.then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(started).toEqual(['first', 'second', 'third']);
      pending.get('first')!.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      pending.get('third')!.resolve();
      pending.get('second')!.resolve();
      if (refused) {
        await expect(outcome).resolves.toMatchObject({ message: 'mcp_resource_mismatch' });
        expect(closed).toHaveLength(2);
      } else {
        expect(await outcome).toBeNull();
        for (const id of started) {
          const config = JSON.parse(await readFile(resolved!.mcpServers[id]!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
          expect(config.auth).toEqual({ capabilityFile: join(root, `${id}.json`), resource: `https://${id}.example.test/mcp` });
        }
        await resolved!.happierMcpServer.stop();
        expect(closed).toHaveLength(3);
      }
    } finally {
      released = true;
      for (const gate of pending.values()) gate.resolve();
      await outcome;
      await resolved?.happierMcpServer.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('measures OAuth preparation through the real materializer with independent daemon latency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-timing-'));
    const captured = snapshot(['first', 'second', 'third'].map(id => ({ id, name: id, transport: 'http',
      remote: { url: `https://${id}.example.test/mcp`, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 })));
    let active = 0;
    let peak = 0;
    const port: McpRequestAuthPort = { async open(input) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 40));
      active -= 1;
      return { capabilityFile: join(root, `${input.serverId}.json`), resource: input.resource };
    }, close: async () => {} };
    let result: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    const startedAt = performance.now();
    try {
      result = await resolveRunnerMcpServers({ session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
        accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
        includeHappierMcpServer: false });
      console.info('PERF4 OAuth preparation measurement', { durationMs: Math.round(performance.now() - startedAt), peak, servers: Object.keys(result.mcpServers).length });
      expect(Object.keys(result.mcpServers)).toEqual(['first', 'second', 'third']);
      expect(peak).toBe(3);
    } finally { await result?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('materializes selected user servers without a built-in bridge for extension delivery and releases their files', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const captured = snapshot([
      { ...server('selected'), env: { USER_VALUE: { t: 'literal', v: 'materialized-value' } } },
      server('excluded'),
      { id: 'remote', name: 'remote', transport: 'http',
        remote: { url: 'https://remote.example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 },
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'happier-extension-runner-'));
    // An OS listener spy distinguishes user-only resolution from starting a bridge.
    const listen = vi.spyOn(Server.prototype, 'listen');
    const resolved = await resolveRunnerMcpServers({
      session: session(), credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', env: {}, tmpDir: dir,
      sessionMetadata: { mcpSelectionV1: { v: 1, forceExcludeServerIds: ['excluded'] } },
      includeHappierMcpServer: false,
    });
    const configPath = resolved.mcpServers.remote?.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
    try {
      expect(Object.keys(resolved.mcpServers).sort()).toEqual(['remote', 'selected']);
      expect(JSON.stringify(resolved.mcpServers.selected)).not.toContain('materialized-value');
      const selectedPath = resolved.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(selectedPath).toBeDefined();
      expect(JSON.parse(await readFile(selectedPath!, 'utf8')).env).toEqual({ USER_VALUE: 'materialized-value' });
      expect(listen).not.toHaveBeenCalled();
      expect(configPath).toBeDefined();
      expect(JSON.parse(await readFile(configPath!, 'utf8')).url).toBe('https://remote.example.test/mcp');
    } finally {
      await resolved.happierMcpServer.stop();
      if (configPath) await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('publishes skipped-server notices with built-in bridge delivery %s', async (includeHappierMcpServer) => {
    const captured = { ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
      server('docs'),
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Missing catalog');
    captured.mcpServerCatalog.catalog.bindings = captured.mcpServerCatalog.catalog.bindings.filter(rule => rule.serverId !== 'linear');
    const enqueueSessionEventCommitted = vi.fn<NonNullable<HappyMcpSessionClient['enqueueSessionEventCommitted']>>(async () => ({ persisted: true, delivered: true }));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
      agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['linear'], forceExcludeServerIds: [] } },
      includeHappierMcpServer,
    });
    try {
      expect(resolved.mcpServers.linear).toBeUndefined();
      expect(resolved.mcpServers.docs).toBeDefined();
      expect(readSessionCapabilityNoticeV1(enqueueSessionEventCommitted.mock.calls[0]?.[0])).toMatchObject({
        items: [{ kind: 'mcp_server', itemId: 'linear', code: 'missing_value_ref' }],
      });
      expect(enqueueSessionEventCommitted.mock.calls).toEqual([[expect.objectContaining({
        type: 'message', message: expect.stringContaining('linear'),
        capabilityNoticeV1: { v: 1, items: [{
          kind: 'mcp_server', name: 'linear', itemId: 'linear', code: 'missing_value_ref', detail: 'env:LINEAR_API_KEY',
        }] },
      }), expect.stringMatching(/^capability-notice:/), { awaitDelivery: false }]]);
    } finally { await resolved.happierMcpServer.stop(); }
  });
  it('publishes MCP failure changes once across turns and resumed preparations, including recurrence after recovery', async () => {
    const broken = (key: string) => ({ ...server('linear'), env: { [key]: { t: 'literal' as const, v: `\${${key}}` } } });
    const captured = { ...snapshot([broken('LINEAR_API_KEY'), {
      ...server('docs'), env: { TOKEN: { t: 'literal' as const, v: '${DOCS_API_KEY}' } },
    }]), settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const events: Parameters<NonNullable<HappyMcpSessionClient['enqueueSessionEventCommitted']>>[0][] = [];
    let metadata = createTestMetadata();
    let metadataWrites = 0;
    // Metadata persistence is the boundary; run the actual private owner codec
    // so a resumed preparation consumes the same facts the Session retained.
    const persistedSession = () => ({ ...session(), getMetadataSnapshot: () => metadata,
      updateMetadata: (update: (value: typeof metadata) => typeof metadata) => {
        metadataWrites += 1;
        const next = update(metadata);
        const owner = createSessionOwnerMetadataV1({ metadata: next });
        if (!owner.ok) throw new Error(`Rejected metadata fields: ${owner.unsupportedFields.join(', ')}`);
        metadata = { ...createTestMetadata(), ...projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: projectSessionSharedMetadataV1({ metadata: next }), ownerMetadata: owner.ownerMetadata,
        }) };
      },
      enqueueSessionEventCommitted: async (event: typeof events[number]) => {
        events.push(event);
        return { persisted: true, delivered: true };
      },
    });
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const prepare = async () => {
      const resolved = await resolveRunnerMcpServers({ session: persistedSession(), credentials,
        accountSettings: captured.settings, accountSettingsSnapshot: captured,
        machineId: 'machine-1', directory: '/tmp/repo', env: {},
        agentId: 'codex', agentAcceptsUserMcp: true, includeHappierMcpServer: false });
      await resolved.happierMcpServer.stop();
    };
    for (let turn = 0; turn < 3; turn += 1) await prepare();
    expect(events.map(readSessionCapabilityNoticeV1)).toHaveLength(1);
    expect(metadataWrites).toBe(1);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Missing catalog');
    captured.mcpServerCatalog.catalog.servers.reverse();
    await prepare();
    expect(events).toHaveLength(1);
    expect(metadataWrites).toBe(1);
    captured.mcpServerCatalog.catalog.servers = [broken('ANOTHER_KEY'), captured.mcpServerCatalog.catalog.servers[0]];
    await prepare();
    expect(events.map(readSessionCapabilityNoticeV1)).toHaveLength(2);
    captured.mcpServerCatalog.catalog.servers = [broken('LINEAR_API_KEY'), captured.mcpServerCatalog.catalog.servers[1]];
    await prepare();
    expect(events).toHaveLength(3);
    captured.mcpServerCatalog.catalog.servers = [server('linear'), server('docs')];
    await prepare();
    expect(events).toHaveLength(3); // No existing recovery-message contract.
    captured.mcpServerCatalog.catalog.servers = [broken('LINEAR_API_KEY')];
    await prepare();
    expect(events.map(readSessionCapabilityNoticeV1)).toHaveLength(4);
  });

  it('does not claim a supplied runtime server was skipped because its Account config could not materialize', async () => {
    const captured = { ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const supplied = { command: 'echo', args: ['supplied'] };
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {}, resolvedMcpServers: { linear: supplied },
    });
    try {
      expect(resolved.mcpServers.linear).toEqual(supplied);
      expect(enqueueSessionEventCommitted.mock.calls).toEqual([]);
    } finally { await resolved.happierMcpServer.stop(); }
  });
  it('refuses materialized Account config if its scope retires while publishing a notice', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ({ ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
      server('docs'),
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) }));
    setActiveAccountSettingsSnapshot(captured);
    const admittedSnapshot = getActiveAccountSettingsSnapshot();
    if (!admittedSnapshot) throw new Error('Expected admitted Account snapshot');
    const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted: async () => {
        clearActiveAccountSettingsSnapshot();
        return { persisted: true, delivered: true };
      } }, credentials, accountSettings: admittedSnapshot.settings, accountSettingsSnapshot: admittedSnapshot,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
    })).then(async result => { await result.happierMcpServer.stop(); return result; });
    await expect(pending).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
  });
  it('uses the Session owner snapshot for attested headers, never launch hints or environment', async () => {
    const captured = snapshot([{ id: 'wilson', name: 'wilson', transport: 'http',
      remote: { url: 'https://wilson.example.test/mcp', headers: {
        'X-Wilson-On-Behalf-Of': { t: 'sessionAttested', field: 'externalPrincipalId' },
        'X-Wilson-Source-Message': { t: 'sessionAttested', field: 'sourceMessageId' },
        'X-Happier-Session': { t: 'sessionAttested', field: 'sessionId' },
      } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const dir = await mkdtemp(join(tmpdir(), 'happier-attested-runner-'));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), getMetadataSnapshot: () => createTestMetadata({ attestedContext: {
        externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>',
      } }) }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', env: { externalPrincipalId: 'forged-env' }, tmpDir: dir,
      sessionMetadata: { attestedContext: { externalPrincipalId: 'forged-hint', sourceMessageId: 'forged' } },
    });
    try {
      const configPath = resolved.mcpServers.wilson.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
      const config = JSON.parse(await readFile(configPath!, 'utf8'));
      expect(config.headers).toEqual({ 'X-Wilson-On-Behalf-Of': 'sales@batiplus.ch',
        'X-Wilson-Source-Message': '<lead@example.test>', 'X-Happier-Session': 'session-1' });
    } finally { await resolved.happierMcpServer.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it('returns identities from the actual selected and materialized catalog entries', async () => {
    const captured = snapshot([{ ...server('docs'), updatedAt: 10 }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready fixture');
    captured.mcpServerCatalog.catalog.bindings[0]!.updatedAt = 20;
    const resolved = await resolve({ snapshot: captured });
    try {
      expect(resolved.mcpServerIdentities).toEqual({ docs: {
        serverId: 'docs', serverTitle: 'docs', usage: { serverId: 'docs', bindingId: 'binding-docs', serverRevision: 10, bindingRevision: 20, catalogRevision: 2 },
      } });
      expect(resolved.mcpServers.docs).toBeDefined();
    } finally { await resolved.happierMcpServer.stop(); }
  });
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
    const emit = Server.prototype.emit as (this: Server, event: string | symbol, ...args: unknown[]) => boolean;
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
      await pending.then(async result => await result.happierMcpServer.stop(), () => undefined);
      if (listener?.listening) await new Promise<void>((resolveClose, rejectClose) => listener!.close(error => error ? rejectClose(error) : resolveClose()));
    }
  });

  it('materializes the admitted row after the authored root has been removed', async () => {
    const result = await resolve({ snapshot: snapshot([server('row-server')]) });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { await result.happierMcpServer.stop(); }
  });

  it('refuses unobserved and partial catalogs when strict MCP policy requires them', async () => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    await expect(resolve({ snapshot: null, accountSettings: accountSettingsParse({ mcpServersStrictMode: true }) }))
      .rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const opened = snapshot([server('valid-neighbor')]);
    if (opened.mcpServerCatalog?.status !== 'ready') throw new Error('Fixture is not ready');
    await expect(resolve({ snapshot: { ...opened, mcpServerCatalog: { ...opened.mcpServerCatalog, status: 'partial',
      diagnostics: [{ path: 'servers[1]', reason: 'invalid-stored-content' }] } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
  });

  it.each([true, false])('publishes optional catalog unavailability without borrowing ambient servers (built-in bridge: %s)', async includeHappierMcpServer => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    const captured = { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      rawSettings: { mcpServersSettingsV1: { v: 1, servers: [server('retained-server')], bindings: [] } },
      mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const } };
    const events: unknown[] = [];
    const result = await resolveRunnerMcpServers({ session: { ...session(), enqueueSessionEventCommitted: async event => {
      events.push(event); return { persisted: true, delivered: true };
    } }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer, env: {},
    });
    try {
      expect(Object.keys(result.mcpServers)).toEqual(includeHappierMcpServer ? ['happier'] : []);
      expect(events).toHaveLength(1);
      expect(readSessionCapabilityNoticeV1(events[0])).toEqual({ v: 1, items: [{
        kind: 'mcp_server', name: 'MCP servers', code: 'mcp_catalog_unavailable', detail: 'unreachable',
      }] });
    } finally { await result.happierMcpServer.stop(); }
  });

  it('keeps built-in tools callable with an unobserved optional catalog and no Account preferences', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const events: unknown[] = [];
    const result = await resolveRunnerMcpServers({ session: { ...session(), getWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'optional-startup-turn', workDepth: 0,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
      enqueueSessionEventCommitted: async event => {
      events.push(event); return { persisted: true, delivered: true };
    } }, credentials, accountSettings: null, accountSettingsSnapshot: null,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
    });
    let connection: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;
    const httpClient = new Client({ name: 'optional-mcp-startup', version: '1' });
    try {
      expect(readSessionCapabilityNoticeV1(events[0])?.items[0]).toMatchObject({ code: 'mcp_catalog_unavailable', detail: 'catalog-unobserved' });
      if (result.sessionMcpContext) connection = await connectSessionMcpClient(result.sessionMcpContext);
      else await httpClient.connect(new StreamableHTTPClientTransport(new URL(result.happierMcpServer.url)));
      const client = connection?.client ?? httpClient;
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_execute', 'action_spec_get']));
      const reply = await client.callTool({ name: 'action_spec_get', arguments: { id: 'session.title.set' } });
      expect(reply, JSON.stringify(reply)).toMatchObject({ isError: false });
    } finally { await connection?.close(); await httpClient.close(); await result.happierMcpServer.stop(); }
  });

  it.each(['scope-retired', 'account-mode-mismatch'] as const)('refuses optional MCP catalog authority failure %s', async reason => {
    await expect(resolve({ snapshot: { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable', reason } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason });
  });

  it('refuses optional MCP startup when its captured Account retires during notice publication', async () => {
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ({ ...snapshot(),
      settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const },
    }));
    let current = true;
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials, snapshot: captured, serverHttpBaseUrl, isCurrent: async () => current,
    }));
    await expect(resolveRunnerMcpServers({ session: { ...session(), enqueueSessionEventCommitted: async () => {
      current = false; return { persisted: true, delivered: true };
    } }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured, operationContext,
      machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer: false,
    })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
  });

  it.each([true, false])('keeps restricted Session authority independent from Account catalog availability (built-in bridge: %s)', async includeHappierMcpServer => {
    const result = await resolve({ snapshot: { ...snapshot(), mcpServerCatalog: { status: 'unavailable', reason: 'forbidden' } }, accountCredentials: null, includeHappierMcpServer });
    try { expect(Object.keys(result.mcpServers)).toEqual(includeHappierMcpServer ? ['happier'] : []); }
    finally { await result.happierMcpServer.stop(); }
  });

  it('does not let retained root contents override a row-owned server set', async () => {
    const result = await resolve({ snapshot: { ...snapshot([server('row-server')]),
      rawSettings: { mcpServersSettingsV1: { v: 1, strictMode: false, servers: [server('retained-server')], bindings: [] } } } });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { await result.happierMcpServer.stop(); }
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
    const privateSession = { ...session(), getServerBinding: () => ({ serverId: 'private-home', serverUrl: serverHttpBaseUrl }) };
    const input = { session: privateSession, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      savedSecretResources: [resource], operationContext, machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null };
    const result = await resolveRunnerMcpServers(input);
    try {
      const launch = result.mcpServers['private-server'];
      expect(JSON.stringify(launch)).not.toContain('fresh-private-value');
      const configPath = launch?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(configPath).toBeDefined();
      expect(JSON.parse(await readFile(configPath!, 'utf8')).env.API_KEY).toBe('fresh-private-value');
      expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    } finally { await result.happierMcpServer.stop(); }
    revoked = true;
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden', reference: ref });
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
  });
});
