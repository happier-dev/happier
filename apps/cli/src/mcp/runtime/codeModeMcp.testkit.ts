import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse, FeaturesResponseSchema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import { vi } from 'vitest';

// The daemon is a process boundary. This fixture has no contributed plugin tools.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

const sessionId = 'code-mode-session';
const getActiveTurnAdmissionWitness: NonNullable<HappyMcpSessionClient['getActiveTurnAdmissionWitness']> = () => ({
  inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 1, userMessageSeqs: [1],
  causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
  agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
});

export function createCodeModePermissionFixture() {
  const permissionSession = createMutableApiSessionClientFixture({ sessionId });
  const permissionRpc = new ServerBoundPermissionRpcHandlerManager(sessionId);
  const permission = new ProviderEnforcedPermissionHandler({
    ...permissionSession, rpcHandlerManager: permissionRpc,
  } as unknown as ApiSessionClient, { logPrefix: '[Session tools fixture]', getWorkspaceWrites: () => 'allow' });
  return { permission, permissionSession, permissionRpc, getActiveTurnAdmissionWitness };
}

export function codeModeStdioServer(source: string, toolNames: readonly string[], spawnLog?: string): McpServerCatalogEntryV1 {
  return {
    id: source, name: source, transport: 'stdio', env: {}, createdAt: 1, updatedAt: 1,
    stdio: { command: process.execPath, args: ['-e', `
      const tools = JSON.parse(process.argv[1]);
      if (process.argv[2]) require('node:fs').appendFileSync(process.argv[2], 'spawn\\n');
      let calls = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { method, id, params } = JSON.parse(line);
        if (id === undefined) return;
        const result = method === 'initialize'
          ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: String(++calls) }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      });
    `, JSON.stringify(toolNames.map(name => ({
      name,
      description: `Read or write a row in the ${name} collection of the workspace datastore. Select the namespace and provide the record key before supplying filter values.`,
      inputSchema: {
        type: 'object',
        required: ['namespace', 'key'],
        properties: {
          namespace: { type: 'string', description: 'Logical namespace for the selected workspace records.' },
          key: { type: 'string', description: 'The primary record key in this workspace namespace.' },
          filter: { type: 'object', properties: { archived: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } } },
        },
      },
    }))), ...(spawnLog ? [spawnLog] : [])] },
  };
}

export async function openCodeModeMcpFixture(input: Readonly<{
  servers: readonly McpServerCatalogEntryV1[];
  featureEnabled?: boolean;
  profile?: Partial<Parameters<typeof resolveRunnerMcpServers>[0]>;
  session?: Partial<HappyMcpSessionClient>;
}>) {
  const credentials = { token: 'code-mode-fixture', encryption: null, credentialProvenance: 'stored_session' as const };
  const serverUrl = 'https://code-mode.example.test';
  const features = FeaturesResponseSchema.parse({ features: { sessions: {
    enabled: true,
    ...(input.featureEnabled === undefined ? {} : { codeMode: { enabled: input.featureEnabled } }),
  } }, capabilities: {} });
  const session: HappyMcpSessionClient & Required<Pick<HappyMcpSessionClient, 'enqueueSessionEventCommitted'>> = {
    sessionId,
    getActiveTurnAdmissionWitness,
    getServerBinding: () => ({ serverId: 'code-mode-home', serverUrl }),
    getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
    getMetadataSnapshot: () => ({ path: process.cwd(), host: 'fixture-host', machineId: 'fixture-machine' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'code-mode-session', encryptionMode: 'plain' }),
    updateMetadata: () => undefined,
    ...input.session,
    enqueueSessionEventCommitted: input.session?.enqueueSessionEventCommitted
      ?? (async () => ({ persisted: true, delivered: true })),
  };
  const profile = await runWithServerHttpBaseUrl(serverUrl, async () => {
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: {
        v: 1, servers: [...input.servers],
        bindings: input.servers.map(server => ({ id: `binding-${server.id}`, serverId: server.id,
          enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })),
      } },
    };
    setActiveAccountSettingsSnapshot(snapshot);
    try {
      return await resolveRunnerMcpServers({
        credentials, accountSettings: snapshot.settings, accountSettingsSnapshot: snapshot, session,
        machineId: 'fixture-machine', directory: process.cwd(), localWorkflow: true,
        ...(process.getuid ? { localTransport: { agentUid: process.getuid() } } : {}),
        ...input.profile,
      });
    } catch (error) {
      clearActiveAccountSettingsSnapshot();
      throw error;
    }
  });
  return { profile, close: async () => {
    try { await profile.happierMcpServer.stop(); } finally { clearActiveAccountSettingsSnapshot(); }
  } };
}
