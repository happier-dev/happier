import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { AgentSessionConfigurationUpdateV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentSessionConfigurationUpdate, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { ApiClient } from '@/api/api';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { McpServerCatalogRowMutationV1Schema, openMcpServerCatalogContentV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { runHostSessionRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it('a real tools.set row-only publication sends one native SDK update with unchanged mode', async () => {
  const agentId = 'com.acme.mcp-tools/agent';
  const runtimeFixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
    manifest: createPluginManifestV2Fixture({ id: 'com.acme.mcp-tools', contributes: {
      systemTools: [{ id: 'agent-cli', title: 'Agent CLI', executableNames: ['fixture-agent'] }],
      agents: [{ id: 'agent', title: 'MCP fixture', primary: 'sessions', runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'agent-cli' } } },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: false, configuration: true }, tools: { delivery: 'native_mcp', mcpToolControl: { off: 'blocked', approval: 'native' } } } }],
    } }), files: { 'daemon.mjs': 'export function activate(api) {}' },
  }] });
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-policy-account' })).toString('base64url')}.signature`, encryption: null };
  const server: McpServerCatalogEntryV1 = { id: 'docs-id', name: 'docs', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    tools: { default: 'allow_all', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'write', tokens: 1 }] } };
  let catalog: McpServerCatalogV1 = { v: 1, servers: [server], bindings: [{ id: 'rule', serverId: server.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
  let revision = 1;
  const settings = accountSettingsParse({ mcpServersStrictMode: true });
  const snapshot = { source: 'network' as const, settings, rawSettings: { mcpServersStrictMode: true }, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(credentials), mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision, diagnostics: [], catalog },
    promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
  setActiveAccountSettingsSnapshot(snapshot);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
  // Only Home HTTP and the Agent SDK implementation are replaced. Actual Action,
  // CAS, row admission, publication, host subscription and native config adapter run.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: catalog } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: snapshot.rawSettings }, version: 7 } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    if (path.startsWith('/v1/account/entity-rows/')) return { status: 404, data: {} };
    throw new Error(`Unexpected Account HTTP boundary ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
    expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/mcp');
    const mutation = McpServerCatalogRowMutationV1Schema.parse(value);
    const opened = openMcpServerCatalogContentV1({ content: mutation.content, mode: 'plain', material: null });
    if (opened.status !== 'opened') throw new Error('Expected a plain MCP row');
    catalog = opened.catalog; revision += 1;
    return { status: 200, data: { status: 'updated', revision, cursor: revision } };
  });
  const metadata = createTestMetadata({ path: '/tmp/mcp-policy-project', permissionMode: 'default' });
  const session = createMutableApiSessionClientFixture({ sessionId: 'mcp-policy-session', metadata, overrides: {
    claimCurrentSessionPublisherAuthorityForStartup: async () => ({ status: 'claimed' }), refreshSessionSnapshotFromServerRequired: async () => undefined,
    activateDurableMutationDelivery: async () => undefined, deactivateDurableMutationDelivery: () => undefined,
    enqueueSessionTurnMutation: async () => undefined, enqueueRegisteredSessionStateFieldMutation: async () => undefined,
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }), onUserMessage: () => undefined,
    hasPendingProviderInput: () => false, getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
    subscribeExecutionRunActivitySnapshots: () => () => undefined, setOwnerActivityDelivery: () => undefined, setSessionRuntimeControls: () => undefined,
    hasOwnerMetadataAuthority: () => true, readRolePromptOrganization: async () => ({}),
    updateMetadataAsCurrentPublisher: async update => { session.updateMetadata(current => current ? update(current) : current); },
  } });
  // ApiSessionClient publishes asynchronously; preserve the canonical fixture's
  // metadata projection and events while honoring that transport contract.
  const updateMetadata = session.updateMetadata.bind(session);
  session.updateMetadata = async update => { updateMetadata((current: Metadata | null) => current ? update(current) : current); };
  const received: AgentSessionConfigurationUpdate[] = [];
  const openedPolicy: unknown[] = [];
  const sdkSession: AgentSessionRuntime = { send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), dispose() {},
    updateConfiguration: async request => { received.push(AgentSessionConfigurationUpdateV1Schema.parse(request)); return { status: 'applied', changed: ['mcpToolPolicy'] }; } };
  const ended = new Error('Policy publication observed');
  const api = await ApiClient.create(credentials);
  try {
    const failure = await runHostSessionRuntime({ credentials, directory: metadata.path, accountSettingsContext: { ...snapshot, whenRefreshed: null } }, {
      flavor: agentId, policyAgentId: agentId, backendDisplayName: 'MCP fixture', providerName: 'MCP fixture', uiLogPrefix: '[MCP fixture]', waitingForCommandLabel: 'MCP fixture', agentMessageType: agentId,
      runtimeActivityApplicability: 'not_applicable', pluginRuntimeRegistryLease: runtimeFixture.lease,
      machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp', happyLibDir: '/tmp' },
      loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false, formatPromptErrorMessage: String,
      createSessionRuntime: params => {
        openedPolicy.push(params.mcpToolPolicy);
        const signal = new AbortController().signal;
        // The SDK context is an external boundary fixture; this test invokes no services.
        const context = { signal } as AgentSessionRuntimeContext;
        const operations = createNativeAgentSessionOperations(sdkSession, session.sessionId, undefined, undefined, undefined,
          { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} }, undefined,
          { context, cwd: metadata.path, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false, configuration: true }, cancellation: { declared: false }, compaction: { capability: null },
            configuration: { declared: true, updateConfiguration: request => sdkSession.updateConfiguration!(request) }, resolveMcpToolPolicy: params.resolveMcpToolPolicy });
        return { operations, nativeRuntime: operations };
      },
      lifecycleHooks: { onRuntimeCreated: async () => {
        const store = createCliMcpServerStore({ credentials });
        const execute = createMcpServerActionExecuteV1({ readCatalog: () => store.readCatalogForOperation(), mutate: (change, expected) => store.mutate(change, expected),
          machine: async () => { throw new Error('Unexpected machine Action'); } });
        const result = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: server.id, tools: { write: 'off' } }, context: { surface: 'ui' } });
        expect(result.ok).toBe(true);
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toMatchObject({ permissionIntent: { value: 'default', updatedAtMs: 1 }, mcpToolPolicy: { docs: { unlisted: 'allow', tools: { write: 'off' } } } });
        expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
        expect(openedPolicy).toEqual([{ docs: { unlisted: 'allow', tools: { write: 'allow' } } }]);
        throw ended;
      } },
    }, { initializeBackendApiContextFn: async () => ({ api, machineId: 'machine' }), initializeBackendRunSessionFn: async () => ({ session, reconnectionHandle: null, reportedSessionId: session.sessionId, attachedToExistingSession: false }) }).then(() => undefined, (error: unknown) => error);
    if (failure instanceof Error && failure !== ended) throw failure;
    expect(failure).toBe(ended);
  } finally { await runtimeFixture.dispose(); }
});
