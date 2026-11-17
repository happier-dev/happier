import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntime, AgentSessionOpenRequest, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { externalShellBridgeAgentDeclaration } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/agent-runtime-source';
import { accountSettingsParse } from '@happier-dev/protocol';
import { PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { listVoiceActionBlockSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createAccountEncryptionCurrentnessFixture, createMutableApiSessionClientFixture, createSessionNotificationContextFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpRequestAuthPort } from '@/mcp/runtime/mcpRequestAuth';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { sessionMcpAgentTransport } from '@/mcp/runtime/sessionMcpClient.testkit';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { SESSION_MCP_CONTEXT_FILE_ENV } from '@/mcp/runtime/sessionMcpLocalTransport';
import { readSessionMcpContextFromEnvironment } from '@/mcp/runtime/sessionMcpLocalClient';
// The source harness transforms this lazily imported server graph on its first
// use. Load its definitions with the fixture; every server still starts through
// the real Run binding below, inside the test's unchanged lifecycle deadline.
import '@/mcp/startHappyServer';
import { toAgentSessionMcpLaunchConfigs } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createDeferred } from '@/testkit/async/deferred';
import { reloadConfiguration } from '@/configuration';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { logger } from '@/ui/logger';
import { ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import '@/agent/runtime/registry/engineRegistry/runtimeCore';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';

const fixtureCredentials = vi.hoisted(() => ({
  token: `header.${Buffer.from(JSON.stringify({ sub: 'voice-mcp-account' })).toString('base64url')}.signature`,
  encryption: null,
}));

// Credential persistence and Home HTTP are external boundaries. Never read a
// developer's credentials or contact a real Account from the authored Agent.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => fixtureCredentials,
}));
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); resetActiveAccountSettingsSnapshotForTests(); });


/** The native Agent's MCP client: the Session relay launched inside the Agent tree. */
async function connectAgentRelay(config: Readonly<{ command?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }> | undefined) {
  if (!config?.command) throw new Error('Missing Session MCP relay config');
  const client = new Client({ name: 'voice-native-agent', version: '1' });
  await client.connect(sessionMcpAgentTransport({ command: config.command, args: config.args, env: config.env }));
  return { client, close: async () => { await client.close(); } };
}

describe('Voice Run MCP provisioning occurrence', () => {
  it.each(([
    { mode: 'global', delivery: 'native_mcp' },
    { mode: 'bound', delivery: 'native_mcp' },
    { mode: 'global', delivery: 'native_extension' },
    { mode: 'global', delivery: 'shell_bridge' },
  ] as const).filter(row => row.delivery === 'native_mcp' || process.platform !== 'win32'))('keeps $mode $delivery Voice carriers and prompt aligned with Agent policy', async ({ mode, delivery }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-voice-mcp-occurrence-'));
    const diagnostics = vi.spyOn(logger, 'infoFile');
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    reloadConfiguration();
    if (mode === 'bound') {
      await seedTestServerProfile({ id: 'receipt', homeId: 'srv_receipt_home', serverUrl: 'https://receipt.example.test' });
    }
    const actualFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).hostname === '127.0.0.1') return actualFetch(input, init);
      throw new Error(`Unexpected fixture Home request: ${new URL(input instanceof Request ? input.url : String(input)).pathname}`);
    }));
    const homeGet = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
    const homePost = vi.spyOn(axios, 'post').mockImplementation(async url => {
      throw new Error(`Unexpected fixture Home request: ${new URL(String(url)).pathname}`);
    });
    const resource = 'https://mcp.example.test/voice';
    // Both carriers consume this Account's explicit Agent tool policy.
    const settings = accountSettingsParse({
      mcpServersStrictMode: true,
      actionsSettingsV1: { v: 1, actions: {
        'approval.request.decide': { disabledSurfaces: ['agent'] },
        'settings.list': { toolExposureModes: { agent: 'direct' } },
        'settings.get': { toolExposureModes: { agent: 'direct' } },
        'settings.set': { toolExposureModes: { agent: 'direct' } },
        'settings.reset': { toolExposureModes: { agent: 'direct' } },
        'settings.invoke': { toolExposureModes: { agent: 'direct' } },
      } },
    });
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(fixtureCredentials.token),
      mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [], catalog: { v: 1 as const,
        servers: [{ id: 'voice-oauth', name: 'voice-oauth', transport: 'http' as const,
          remote: { url: resource, headers: {}, auth: { kind: 'oauth' as const } }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'voice-rule', serverId: 'voice-oauth', enabled: true, target: { t: 'allMachines' as const }, createdAt: 1, updatedAt: 1 }],
      } } };
    let bridge: ExecutionRunHostBridge | undefined;
    const proofs: Array<{ runId: string; occurrenceId: string }> = [];
    const opened: AgentSessionOpenRequest[] = [];
    let openFailure: unknown = null;
    let providerFailure: unknown = null;
    const contextFiles: string[] = [];
    const prompts: string[] = [];
    const voiceClientToolNames = listVoiceActionBlockSpecs().flatMap(spec =>
      spec.bindings?.voiceClientToolName ? [spec.bindings.voiceClientToolName] : []);
    const deliveredToolNames = new Set<string>();
    const closed: string[] = [];
    let holdProvider = false;
    let holdCleanup = false;
    const cleanupEntered = createDeferred<void>();
    const releaseCleanup = createDeferred<void>();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const port: McpRequestAuthPort = {
      async open(input) {
        if (!bridge || !input.executionRun) throw new Error('Missing exact Run proof');
        // The authenticated daemon RPC is the boundary. Feed the real host
        // producer through its strict consumer; no synthetic current reply.
        const proof = SessionExecutionRunBrokerAuthorityRequestV1Schema.parse({ v: 1,
          executionRunId: input.executionRun.runId, expectedOccurrenceId: input.executionRun.occurrenceId });
        const current = SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(bridge.resolveLiveBrokerAuthority(proof));
        if (current.status !== 'current' || current.executionRunId !== input.executionRun.runId
          || current.occurrenceId !== input.executionRun.occurrenceId || current.parentSessionId !== 'voice-parent') {
          throw new Error('mcp_request_auth_not_active');
        }
        expect(current).toMatchObject({ intent: 'voice_agent', runtimeState: 'idle', activeTurnId: null });
        // A raw intent alone does not promote a Session caller to Account Voice.
        expect(current).not.toHaveProperty('actionInvocation');
        proofs.push(input.executionRun);
        return { capabilityFile: join(home, `capability-${input.materializationId}.json`), resource };
      },
      async close(input) { closed.push(input.materializationId); },
    };
    const openSession = async (request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext): Promise<AgentSessionRuntime> => {
      opened.push(request);
      // Shared Actions retain the Run's ordinary permission intent. Native
      // extension and shell carriers still need their provider tool surface.
      expect(request.configuration?.permissionIntent.value).toBe('read-only');
      expect(request.configuration?.allowedTools).toBeUndefined();
      expect(request.configuration?.unlistedTools).toBeUndefined();
      if (process.platform !== 'win32') {
        const environment = request.launchEnvironment?.values ?? {};
        expect(environment[SESSION_MCP_CONTEXT_FILE_ENV]).toEqual(expect.any(String));
        expect(request.launchEnvironment?.unset).not.toContain(SESSION_MCP_CONTEXT_FILE_ENV);
        // The Agent-visible context names the socket only; the Agent tree is admitted by peer proof.
        expect(await readSessionMcpContextFromEnvironment(environment)).not.toHaveProperty('bearerToken');
        contextFiles.push(environment[SESSION_MCP_CONTEXT_FILE_ENV]!);
        // Native MCP consumes this catalog; extension/shell delivery consumes
        // the native bridge below. Resume separately proves its new context
        // and occurrence custody without listing an unchanged catalog again.
        if (delivery === 'native_mcp' && opened.length === 1) {
          const { client, close } = await connectAgentRelay(request.mcpServers?.happier);
          try {
            const catalog = await client.listTools();
            for (const tool of catalog.tools) deliveredToolNames.add(tool.name);
            expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
              'settings_list', 'settings_get', 'settings_set', 'settings_reset', 'settings_invoke',
            ]));
            expect(catalog.tools.map(tool => tool.name)).not.toContain('approval_request_decide');
          } finally { await close(); }
        }
      }
      const nativeBridge = delivery !== 'native_mcp'
        ? await context.session.services.happierTools!.resolveNativeBridge({}, { signal: context.signal })
        : null;
      if (delivery !== 'native_mcp') expect(request.mcpServers ?? {}).not.toHaveProperty('happier');
      if (nativeBridge) {
        for (const tool of nativeBridge.tools) deliveredToolNames.add(tool.name);
        if (process.platform !== 'win32') {
          expect(nativeBridge.launch.env?.[SESSION_MCP_CONTEXT_FILE_ENV])
            .toBe(request.launchEnvironment?.values[SESSION_MCP_CONTEXT_FILE_ENV]);
        }
        expect(nativeBridge.launch.env ?? {}).not.toHaveProperty('HAPPIER_SESSION_MCP_SOCKET');
        expect(nativeBridge.launch.env ?? {}).not.toHaveProperty('HAPPIER_SESSION_MCP_BEARER');
        expect(nativeBridge.sessionId).toBe('voice-parent');
        expect(nativeBridge.tools.map(tool => tool.name)).toContain('settings_list');
        expect(nativeBridge.launch.env ?? {}).not.toHaveProperty('HAPPIER_HOME_DIR');
      }
      if (delivery === 'native_mcp' && process.platform === 'win32' && opened.length === 1) {
        const happier = request.mcpServers?.happier;
        const urlIndex = happier?.args?.indexOf('--url') ?? -1;
        const url = happier?.args?.[urlIndex + 1];
        if (urlIndex < 0 || !url) throw new Error('Missing real Happier MCP bridge');
        const client = new Client({ name: 'voice-settings-exposure', version: '1' });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url)));
          const catalog = await client.listTools();
          for (const tool of catalog.tools) deliveredToolNames.add(tool.name);
          expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
            'settings_list', 'settings_get', 'settings_set', 'settings_reset', 'settings_invoke',
          ]));
          expect(catalog.tools.map(tool => tool.name)).not.toContain('approval_request_decide');
        } finally { await client.close(); }
      }
      // The shared carrier retains the Account's selected MCP catalog whenever
      // this Agent's declared delivery accepts user MCP servers.
      if (delivery === 'shell_bridge') expect(request.mcpServers?.['voice-oauth']).toBeUndefined();
      else expect(request.mcpServers?.['voice-oauth']).toBeDefined();
      if (holdProvider) { entered.resolve(); await release.promise; }
      let sequence = 0;
      const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
      expect(request.functionTools).toBeUndefined();
      return { watch(listener) {
        listeners.add(listener);
        listener({ kind: 'provider-session-id', sessionId: request.sessionId, providerSessionId: 'voice-native-thread', sequence: ++sequence, emittedAtMs: sequence });
        return { dispose() { listeners.delete(listener); } };
      }, async send(input) {
        try {
        prompts.push(input.input.text);
        for (const event of [
          { kind: 'input-accepted' as const, inputIds: input.inputIds, delivery: input.delivery },
          { kind: 'turn-start' as const, turnId: input.delivery.turnId, startedBy: 'host' as const },
        ]) for (const listener of listeners) listener({ ...event, sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
        if (delivery === 'native_mcp') {
          const connected = process.platform === 'win32'
            ? await (async () => {
              const happier = request.mcpServers?.happier;
              const urlIndex = happier?.args?.indexOf('--url') ?? -1;
              const url = happier?.args?.[urlIndex + 1];
              if (urlIndex < 0 || !url) throw new Error('Missing real Happier MCP bridge');
              const client = new Client({ name: 'voice-action-turn', version: '1' });
              await client.connect(new StreamableHTTPClientTransport(new URL(url)));
              return { client, close: async () => { await client.close(); } };
            })()
            : await connectAgentRelay(request.mcpServers?.happier);
          try {
            for (const tool of [
              { name: 'action_spec_search', arguments: { query: 'settings.list' } },
              { name: 'action_spec_get', arguments: { id: 'settings.list' } },
            ]) {
              const result = await connected.client.callTool(tool);
              expect(result.isError, JSON.stringify(result)).not.toBe(true);
              const text = Array.isArray(result.content)
                ? result.content.find(item => item.type === 'text')?.text : undefined;
              expect(text).toEqual(expect.any(String));
            }
          } finally { await connected.close(); }
        }
        for (const event of [
          { kind: 'message-delta' as const, turnId: input.delivery.turnId, channel: 'assistant' as const, text: 'READY' },
          { kind: 'turn-complete' as const, turnId: input.delivery.turnId },
        ]) for (const listener of listeners) listener({ ...event, sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
        return { status: 'admitted' };
        } catch (error) { providerFailure = error; throw error; }
      }, async dispose() { listeners.clear(); } };
    };
    const observeOpenSession: typeof openSession = async (request, context) => {
      try { return await openSession(request, context); }
      catch (error) { openFailure = error; throw error; }
    };
    const plugin = definePlugin({ id: 'test.voice-mcp-occurrence', version: '0.0.0', displayName: 'Voice MCP fixture',
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions', reason: 'Use the current Session.',
        scope: { access: ['read', 'write', 'control'] } }], optional: [] },
      entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
        declaration: delivery === 'shell_bridge' ? externalShellBridgeAgentDeclaration : { title: 'Voice MCP Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { tools: { delivery }, sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false } } },
        factory: () => ({ sessions: { open: observeOpenSession } }),
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      } } });
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    try {
      fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: home,
        // This scenario consumes only its authored Agent. Keep admission and
        // retirement scoped to that committed declaration, not bundled peers.
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({
          happyHomeDir, agentIdentity: { pluginId: plugin.manifest.id, localId: 'agent' },
        })),
        plugins: [{ manifest: plugin.manifest, files: {
          'agent-runtime.mjs': 'let open; export function configure(callback) { open = callback; } export function createRuntime() { return { sessions: { open: (request, context) => open(request, context) } }; }',
          'daemon.mjs': "import * as leaf from './agent-runtime.mjs'; export function activate(api) { api.agents.register('agent', leaf.createRuntime, { sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); } export function configureUnitLeaf(open) { leaf.configure(open); return { activate }; }",
        }, instantiateCommittedModule(module) {
          const configure = module.configureUnitLeaf;
          if (typeof configure !== 'function') throw new Error('Missing provider fixture');
          return configure(observeOpenSession) as PluginDaemonModuleNamespace;
        } }] });
      const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
      const agentId = `${agent.pluginId}/${agent.localId}`;
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      const parent = createMutableApiSessionClientFixture({ sessionId: 'voice-parent', metadata: createTestMetadata({ path: home,
        ...(mode === 'bound' ? { work: { promptStack: [{ id: 'session.instructions', enabled: true, required: true,
          placement: 'system_append', ref: { kind: 'doc', artifactId: 'instructions' } }] } } : {
        systemSessionV1: { v: 1, key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        voiceConversationBindingV1: { v: 1, adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
          transcriptMode: 'native_session', targetSessionId: null, updatedAt: 1 },
        }),
      }),
        overrides: { getMcpRequestAuthPort: () => port } });
      // Hidden carriers are re-read at the Home boundary before prompt admission.
      // Keep that target/currentness logic real, using the canonical wire fixtures.
      homeGet.mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') {
          return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        }
        if (path === `/v2/sessions/${parent.sessionId}`) {
          return { status: 200, data: { session: { ...createSessionNotificationContextFixture(parent.sessionId),
            encryptionMode: 'plain', metadata: JSON.stringify(parent.getMetadataSnapshot()) } } };
        }
        throw new Error(`Unexpected fixture Home request: ${path}`);
      });
      homePost.mockImplementation(async (url, request) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/plugins/availability/intents/list') {
          const pluginIds = readRequestedIntentPluginIds(request);
          return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
              availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
            } })) }) };
        }
        if (path === '/v2/sessions/read-batch') return { status: 200, data: createSessionReadBatchResponseFixture({ request,
          sessions: [{ ...createSessionNotificationContextFixture(parent.sessionId),
            encryptionMode: 'plain', metadata: JSON.stringify(parent.getMetadataSnapshot()) }] }) };
        throw new Error(`Unexpected fixture Home request: ${path}`);
      });
      bridge = new ExecutionRunHostBridge({ parentProvider: 'claude', cwd: home, happyHomeDir: home, sendAcp: async () => {},
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        getNowMs: () => 1_700_000_000_000, resolveAccountSettingsSnapshot: async () => snapshot,
        sessionInteractionHost: { session: parent, machineId: 'voice-machine', permissionHandler: new ProviderEnforcedPermissionHandler(parent, { logPrefix: '[Voice MCP]' }),
          // Compose the native host's tool-binding port with its real MCP owner,
          // as registerSessionClientRuntimeHandlers does. No internal stand-in.
          composeRunToolBinding: async request => {
            const resolved = await resolveRunnerMcpServers({ session: parent, credentials: fixtureCredentials,
              // Production supplies the Session's private requester context;
              // an Account bearer alone cannot stand in for that custody.
              readExecutionSource: async signal => {
                signal?.throwIfAborted();
                return { kind: 'requester', identity: selectHostRequesterExecutionIdentity({
                  hostHomeServerIdentityId: 'srv_voice_mcp_home',
                  hostAccountAgent: { accountId: 'voice-mcp-account', custodianAccountId: 'voice-mcp-account',
                    machineId: 'voice-machine', installationId: 'voice-installation' },
                }) };
              },
              isolationEnabled: false,
              accountSettings: settings, accountSettingsSnapshot: snapshot, machineId: 'voice-machine', directory: home,
              agentId: request.agentId, agentAcceptsUserMcp: delivery !== 'shell_bridge',
              includeHappierMcpServer: delivery === 'native_mcp',
              ...(process.platform !== 'win32'
                ? { localTransport: { agentUid: process.getuid!() } } : {}),
              executionRun: { ...request, getPermissionMode: () => 'read-only' },
            });
            expect(resolved.agentEnvironment ?? {}).not.toHaveProperty('HAPPIER_HOME_DIR');
            return { mcpServers: toAgentSessionMcpLaunchConfigs(resolved.mcpServers), supportedSessionReadActions: [],
              get agentEnvironment() { return resolved.agentEnvironment; },
              get sessionMcpContext() { return resolved.sessionMcpContext; },
              async dispose() {
                await resolved.happierMcpServer.stop();
                if (holdCleanup) { cleanupEntered.resolve(); await releaseCleanup.promise; }
              } };
          },
        },
        resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args,
          credentials: fixtureCredentials,
          // This authored fixture has no Project prompt sources; the bound
          // persona comes from its reserved Session instruction entry.
          serverId: 'receipt', sessionMetadata: parent.getMetadataSnapshot(), accountEntries: [], profileEntries: [], projectEntries: [], directory: home,
          readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
          readArtifact: async () => ({ id: 'instructions', header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
            revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, markdown: 'VOICE_RECEIPT_PERSONA', createdAtMs: 1, updatedAtMs: 1 }) }),
        }),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
      const started = await bridge.start({ sessionId: parent.sessionId, intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId },
        accountSettings: settings,
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        chatModelId: 'voice-model', commitModelId: 'default', bootstrapMode: 'ready_handshake', initialContextMode: 'first_turn', connectedServices: null });
      expect(started).not.toHaveProperty('actionInvocation');
      if (openFailure) throw openFailure;
      if (providerFailure) throw providerFailure;
      expect(proofs, JSON.stringify({ started, run: bridge.get(started.runId),
        preparation: diagnostics.mock.calls.filter(([message]) => message.includes('Prompt')) }))
        .toHaveLength(delivery === 'shell_bridge' ? 0 : 1);
      expect(opened).toHaveLength(1);
      if (process.platform !== 'win32') {
        expect(opened[0]?.launchEnvironment?.values[SESSION_MCP_CONTEXT_FILE_ENV]).toEqual(expect.any(String));
      }
      // MCP instructions may only name tools actually delivered to this Agent;
      // Voice client aliases do not become callable Agent tools.
      expect(prompts).toHaveLength(1);
      for (const name of voiceClientToolNames) {
        if (!deliveredToolNames.has(name)) expect(prompts[0]).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`));
      }
      // Inspect the instructions actually delivered to the retained native
      // Agent, so a correct shared helper omitted by composition cannot pass.
      expect(prompts[0]).toContain('action_execute');
      expect(prompts[0]).not.toContain('Trigger Actions with the native happier_voice_action function');
      expect(prompts[0]).not.toContain('<voice_actions>');
      expect(prompts[0]).toContain("The person's explicit spoken request is the confirmation");
      expect(prompts[0]).toContain('do not ask for confirmation again');
      expect(prompts[0]).toContain('When Voice agent can approve requests is off');
      expect(prompts[0]).toContain('a tap in the request UI is required');
      expect(prompts[0]).toContain('Only report the permission as approved, denied, or settled after canonical request state shows that outcome');
      expect(prompts[0]).not.toContain('Read the specific request aloud within the sharing policy, ask the person, and follow their answer before deciding');
      if (mode === 'bound') {
        const receipt = { serverId: 'srv_receipt_home', sessionId: 'voice-parent' };
        expect(prompts[0]).toContain('VOICE_RECEIPT_PERSONA');
        expect.soft(started).toHaveProperty('preparedInstructionsFor', receipt);
        const welcomed = await bridge.applyAction(started.runId, { actionId: 'voice_agent.welcome' });
        expect(prompts.at(-1)).toContain('VOICE_RECEIPT_PERSONA');
        expect.soft(welcomed).toHaveProperty('result.preparedInstructionsFor', receipt);
        const deps = createExecutionRunRpcActionDeps({ manager: bridge, context: { sessionId: parent.sessionId, cwd: home },
          policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null, maxTurns: null } }), isExecutionRunsEnabled: () => true });
        const stream = ExecutionRunTurnStreamStartResponseSchema.parse(await deps.executionRunStreamStart!(parent.sessionId,
          { runId: started.runId, message: 'hello' }, { authority: 'present_user' }));
        let read = ExecutionRunTurnStreamReadResponseSchema.parse(await deps.executionRunStreamRead!(parent.sessionId,
          { runId: started.runId, streamId: stream.streamId, cursor: 0, waitForEvents: true }));
        while (!read.done) read = ExecutionRunTurnStreamReadResponseSchema.parse(await deps.executionRunStreamRead!(parent.sessionId,
          { runId: started.runId, streamId: stream.streamId, cursor: read.nextCursor, waitForEvents: true }));
        expect.soft(read).toHaveProperty('preparedInstructionsFor', receipt);
      } else expect(started).not.toHaveProperty('preparedInstructionsFor');
      const first = bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)!;
      expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)?.occurrenceId).toBe(first.occurrenceId);
      expect(bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: randomUUID() }))
        .toEqual({ status: 'not_current', reason: 'occurrence_mismatch' });
      holdCleanup = true;
      let stopped = false;
      const stoppingFirst = bridge.stop(started.runId).then(() => { stopped = true; });
      try {
        await cleanupEntered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stopped).toBe(false);
      } finally { holdCleanup = false; releaseCleanup.resolve(); await stoppingFirst; }
      await bridge.waitForTerminal(started.runId);
      if (process.platform !== 'win32') {
        expect(contextFiles).toHaveLength(1);
        await expect(readFile(contextFiles[0]!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)).toBeNull();
      expect(closed).toHaveLength(delivery === 'shell_bridge' ? 0 : 1);
      holdProvider = true;
      const resuming = bridge.ensure(started.runId, { resume: true });
      try {
        await Promise.race([entered.promise, resuming.then(result => { throw new Error(`Resume settled before provider open: ${JSON.stringify(result)}`); })]);
        expect(proofs).toHaveLength(delivery === 'shell_bridge' ? 0 : 2);
        if (process.platform !== 'win32') {
          expect(contextFiles).toHaveLength(2);
          expect(contextFiles[1]).not.toBe(contextFiles[0]);
        }
        if (delivery !== 'shell_bridge') expect(proofs[1]?.occurrenceId).not.toBe(first.occurrenceId);
        expect(bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: first.occurrenceId }))
          .toEqual({ status: 'not_current', reason: 'occurrence_mismatch' });
        const stopping = bridge.stop(started.runId);
        await vi.waitFor(() => expect(bridge!.get(started.runId)?.status).toBe('cancelled'));
        expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)).toBeNull();
        release.resolve();
        await stopping;
      } finally { release.resolve(); await resuming; }
    } finally {
      release.resolve();
      releaseCleanup.resolve();
      await bridge?.dispose();
      await fixture?.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
