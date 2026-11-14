import { prepareStandaloneVoicePolicyHarness } from '../../../../../../../apps/ui/sources/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { accountSettingsParse, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { createOpenCodeAgentRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/nativeRuntime';
import { OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/purposes';
import { createUnboundConnectedAccountsFixture } from '@/agent/runtime/registry/engineRegistry/connectedAccounts.testkit';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { VoiceRunActionDispatchRequestV1Schema, voiceRunActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { toAgentSessionMcpLaunchConfigs } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture, createAccountEncryptionCurrentnessFixture, createSessionRecordFixture, createSessionReadBatchResponseFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { sessionMcpAgentTransport } from '@/mcp/runtime/sessionMcpClient.testkit';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createExecutionRunRpcActionDeps, createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { registerExecutionRunActionRpcHandlers } from '@/rpc/handlers/executionRuns/actionRpcRegistration';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import type { RpcHandler } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { createSessionRpcAuthorization } from '@/api/session/client/sessionRpcAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { reloadConfiguration } from '@/configuration';
import openCodeFrames from '@/agent/acp/testkit/opencode119.producerFrames.json';
import '@/mcp/startHappyServer';
import '@/agent/runtime/registry/engineRegistry/runtimeCore';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../../../apps/ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '../../../../../../../apps/ui/sources/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createRootLayoutFeaturesResponse } from '../../../../../../../apps/ui/sources/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture, createPlainV2SessionRecordFixture } from '../../../../../../../apps/ui/sources/dev/testkit/fixtures/sessionFixtures';
import { settingsDefaults } from '../../../../../../../apps/ui/sources/sync/domains/settings/settings';
import type { VoiceAgentHandle } from '../../../../../../../apps/ui/sources/voice/agent/types';
import { installLocalStorageMock, installWebLockManagerMock } from '../../../../../../../apps/ui/sources/auth/storage/tokenStorage.web.testHelpers';

const credentials = vi.hoisted(() => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`, encryption: null }));
// Credential storage, external Home HTTP, ACP and socket RPC are the boundaries.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => credentials }));
vi.mock('@/daemon/controlClient', async original => ({ ...await original<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }), requestDaemonPluginActionExecution: async () => ({ matched: false }) }));
const homes = createHomeGovernanceHarness();
const browserStorage = installLocalStorageMock();
const browserLocks = installWebLockManagerMock();
afterAll(() => { browserLocks.restore(); browserStorage.restore(); });
installHomeGovernanceBoundaries(homes);
await prepareStandaloneVoicePolicyHarness();
const { captureLazyActionAccountContext } = await import('../../../../../../../apps/ui/sources/sync/ops/actions/actionAccountContext');
const { createDefaultActionExecutor } = await import('../../../../../../../apps/ui/sources/sync/ops/actions/defaultActionExecutor');
const { DaemonVoiceAgentClient } = await import('../../../../../../../apps/ui/sources/voice/agent/daemonVoiceAgentClient');
const { createVoiceRunActionReverseHandler } = await import('../../../../../../../apps/ui/sources/voice/agent/voiceRunActionReverseHandler');
const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('../../../../../../../apps/ui/sources/voice/session/voiceSessionStore');
const { storage } = await import('../../../../../../../apps/ui/sources/sync/domains/state/storage');

/** Recorded OpenCode 1.19 vendor peer; the SDK ACP decoder and tool binding stay real. */
async function openCodePeer(prompt: (text: string) => Promise<string>) {
  const sockets = new Set<import('node:net').Socket>();
  const errors: unknown[] = [];
  let rejectPeer!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectPeer = reject; });
  void failure.catch(() => undefined);
  let mcpLaunch: Parameters<typeof sessionMcpAgentTransport>[0] | undefined;
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    void (async () => {
      for await (const line of createInterface({ input: socket })) {
        const request: { id?: number | string; method?: string; params?: { prompt?: Array<{ type: string; text?: string }>;
          mcpServers?: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> } } = JSON.parse(line);
        if (request.id === undefined) continue;
        let result: unknown = {};
        if (request.method === 'initialize') result = openCodeFrames.initialize;
        else if (request.method === 'session/new' || request.method === 'session/load') {
          const happier = request.params?.mcpServers?.find(server => server.name === 'happier');
          if (!happier) throw new Error('OpenCode did not receive the Happier MCP configuration');
          mcpLaunch = { command: happier.command, args: happier.args,
            env: Object.fromEntries(happier.env.map(entry => [entry.name, entry.value])) };
          result = openCodeFrames.newSession;
        }
        else if (request.method === 'session/prompt') {
          const text = request.params?.prompt?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? '';
          const reply = await prompt(text);
          socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: openCodeFrames.newSession.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } }) + '\n');
          result = { stopReason: 'end_turn' };
        }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    })().catch(error => { errors.push(error); rejectPeer(error); socket.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing ACP fixture endpoint');
  return { failure, options: { transport: { kind: 'tcp', host: '127.0.0.1', port: address.port } } satisfies AgentAcpRuntimeOptions,
    readMcpLaunch() { if (!mcpLaunch) throw new Error('Missing OpenCode MCP configuration'); return mcpLaunch; },
    async close() { for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (errors.length) throw errors[0]; } };
}

afterEach(async () => { resetVoiceSessionStoreForTests(); await homes.reset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  reloadConfiguration(); resetActiveAccountSettingsSnapshotForTests(); });

describe('OpenCode Voice authority through shared MCP', () => {
  it.skipIf(process.platform === 'win32').each([true, false])('retains signed Voice admission and settings approval policy (canApprove=%s)', async canApprove => {
    const home = await mkdtemp(join(tmpdir(), 'voice-acp-authority-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home); vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1'); reloadConfiguration();
    const serverIdentityId = `srv_voice_acp_authority_${canApprove}`;
    const serverId = await homes.addHome({ name: 'OpenCode Voice MCP', serverUrl: `https://voice-acp-authority-${canApprove}.test`,
      serverIdentityId, accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } });
    tryWriteServerEnabledBitInPlace(features, 'voice', true);
    homes.answer(serverId, '/v1/features', { body: features });
    let content: Extract<AccountSettingsStoredContentEnvelope, { t: 'plain' }> = { t: 'plain', v: { voice: { ...settingsDefaults.voice, canApproveRequests: canApprove } } };
    let version = 1;
    homes.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content, version } }) });
    homes.answer(serverId, 'POST /v2/account/settings', { select: raw => {
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw); expect(request.expectedVersion).toBe(version);
      if (request.content?.t !== 'plain') throw new Error('Expected plain settings'); content = request.content;
      return { body: { success: true, version: ++version } };
    } });
    const account = await captureLazyActionAccountContext(serverId);
    const rpcChannel = await createRequesterCurrentnessSocketHarness();
    const socketIo = await import('socket.io-client');
    const uiIo = socketIo.io;
    const nativeIo = (await vi.importActual<typeof import('socket.io-client')>('socket.io-client')).io;
    // Keep UI's disconnected SDK boundary while the CLI testkit dials real TCP.
    vi.spyOn(socketIo, 'io').mockImplementation((uri, options) => typeof uri === 'string' && uri === rpcChannel.serverUrl
      ? nativeIo(uri, options) : uiIo(uri, options));
    const controller = new AbortController();
    let bridge: ExecutionRunHostBridge | undefined;
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let daemon: Awaited<ReturnType<typeof createSessionDaemonAuthorityFixture>> | undefined;
    let execute: ReturnType<typeof createDaemonSessionAccountActionExecutor> | undefined;
    let handle: VoiceAgentHandle | undefined;
    let opened: AgentSessionOpenRequest | undefined;
    let executed: unknown;
    const actionInput = { anchor: 'voiceConversations.audibleWaitingCue', value: true };
    const readBacks: string[] = [];
    let noteApproval!: () => void;
    const approvalCreated = new Promise<void>(resolve => { noteApproval = resolve; });
    homes.artifacts(serverId).afterNextCreate(async () => { noteApproval(); });
    const peer = await openCodePeer(async text => {
      if (text.includes('Warm-up step: reply with exactly READY')) return 'READY';
      if (!opened) throw new Error('Missing admitted ACP request');
      // Launch the ACP-delivered native relay under the canonical Agent-tree
      // holder instead of connecting directly to the in-process MCP endpoint.
      const launch = peer.readMcpLaunch();
      const transport = sessionMcpAgentTransport({ ...launch,
        env: { ...opened.launchEnvironment?.values, ...launch.env } });
      const client = new Client({ name: 'recorded-opencode-acp', version: '1' });
      try {
        await client.connect(transport);
        const listing = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
        expect(listing.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_spec_search', 'action_spec_get', 'action_execute']));
        const search = await client.callTool({ name: 'action_spec_search', arguments: { query: 'settings' } });
        expect(search.isError, JSON.stringify(search)).not.toBe(true);
        expect(JSON.stringify(search)).toContain('settings.set');
        const discovery = await client.callTool({ name: 'action_spec_get', arguments: { id: 'settings.set' } });
        expect(discovery.isError, JSON.stringify(discovery)).not.toBe(true);
        const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'settings.set', input: actionInput } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const block = Array.isArray(result.content) ? result.content.find(item => item.type === 'text') : undefined;
        if (!block || block.type !== 'text') throw new Error('Missing Action result');
        executed = JSON.parse(block.text);
        if (canApprove) {
          expect(readBacks).toEqual([]);
        }
        return 'Setting updated.';
      } finally { await client.close(); }
    });
    const openAcp = async (request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext) => {
      expect(request.functionTools).toBeUndefined();
      const runtime = await createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' }, signal: context.signal });
      if (!runtime.sessions?.open) throw new Error('OpenCode Session factory unavailable');
      return await runtime.sessions.open({ ...request, launchEnvironment: { ...request.launchEnvironment,
        values: { ...request.launchEnvironment?.values, HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } } }, {
        ...context, protocols: { ...context.protocols, acp: { ...context.protocols.acp,
          open: async (launchRequest, options) => {
            opened = launchRequest;
            return await context.protocols.acp.open(launchRequest, { ...options, transport: peer.options.transport });
          } } },
      });
    };
    const plugin = definePlugin({ id: 'test.voice-acp-authority', version: '0.0.0', displayName: 'OpenCode ACP fixture',
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions', reason: 'Use current Session.', scope: { access: ['read', 'write', 'control'] } }], optional: [] },
      entrypoints: { daemon: './daemon.mjs' }, agents: { agent: { declaration: { title: 'Recorded OpenCode ACP', runtime: { kind: 'custom' }, primary: 'sessions',
        connectedAccounts: OPEN_CODE_CONNECTED_ACCOUNT_DECLARATIONS.map(row => ({ ...row,
          materializationKinds: [...row.materializationKinds], credentialKinds: [...row.credentialKinds] })),
        capabilities: { tools: { delivery: 'native_mcp' }, sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false } } },
        factory: () => ({ sessions: { open: openAcp } }),
        sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } } } });
    try { await Promise.race([peer.failure, (async () => {
      fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: home,
        runtimeOptions: { connectedAccounts: createUnboundConnectedAccountsFixture() },
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir,
          agentIdentity: { pluginId: plugin.manifest.id, localId: 'agent' } })),
        plugins: [{ manifest: plugin.manifest, files: {
          'agent.mjs': 'let open; export function configure(callback) { open = callback; } export function createRuntime() { return { sessions: { open: (request, context) => open(request, context) } }; }',
          'daemon.mjs': "import * as leaf from './agent.mjs'; export function activate(api) { api.agents.register('agent', leaf.createRuntime, { sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); } export function configureUnitLeaf(open) { leaf.configure(open); return { activate }; }",
        }, instantiateCommittedModule(module) { const configure = module.configureUnitLeaf;
          if (typeof configure !== 'function') throw new Error('Missing ACP fixture factory');
          return configure(openAcp) as PluginDaemonModuleNamespace;
        } }] });
      const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
      const agentId = `${agent.pluginId}/${agent.localId}`;
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      const settings = accountSettingsParse({});
      const snapshot = { source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) };
      const session = createMutableApiSessionClientFixture({ sessionId: canApprove ? 'cmwec73r300gamcvijq3b0p9z' : 'cmwec73r300gbmcvijq3b0p9z',
        serverBinding: { serverId, serverUrl: account.endpointUrl }, metadata: createTestMetadata({ path: home, machineId: 'voice-machine' }),
        overrides: { enqueueSessionEventCommitted: createApiSessionClientFixture().enqueueSessionEventCommitted } });
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness' || path === '/v1/account/encryption') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (path === '/v1/machines') return { status: 200, data: [startBoundary.machine] };
        if (path === '/v1/machines/voice-machine') return { status: 200, data: { machine: startBoundary.machine } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'alice' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content, version } };
        if (path === `/v2/sessions/${session.sessionId}`) return { status: 200, data: { session: {
          ...createSessionNotificationContextFixture(session.sessionId), active: true, machineId: 'voice-machine', encryptionMode: 'plain',
          metadata: JSON.stringify(session.getMetadataSnapshot()) } } };
        throw new Error(`Unexpected Home request ${path}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, request) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
        if (path === '/v1/plugins/availability/intents/list') {
          const { knownPluginIds: pluginIds = [] } = PluginAvailabilityIntentsListActionInputV1Schema.parse(request);
          return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
              availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
            } })) }) };
        }
        if (path === '/v2/sessions/read-batch') return { status: 200, data: createSessionReadBatchResponseFixture({ request,
          sessions: [createSessionRecordFixture({ id: session.sessionId, encryptionMode: 'plain',
            metadata: JSON.stringify(session.getMetadataSnapshot()) })] }) };
        throw new Error(`Unexpected Home request ${path}`);
      });
      const createBridge = () => new ExecutionRunHostBridge({ parentProvider: 'claude', cwd: home, happyHomeDir: home, sendAcp: async () => {},
        resolveRunReportPolicy: async () => ({ preset: 'important' }), resolveAccountSettingsSnapshot: async () => snapshot,
        sessionInteractionHost: { session, machineId: 'voice-machine', permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Voice ACP]' }),
          // The parent Session's applied provider selection is supplied by its
          // running process, outside this Run's deterministic selection owner.
          readAppliedChildSelection: async () => ({ status: 'applied', backendTarget: { kind: 'builtInAgent', agentId },
            modelId: 'ollama/qwen2.5:3b', connectedServices: null }),
          composeRunToolBinding: async request => {
            const binding = await resolveRunnerMcpServers({ session, credentials, readExecutionSource: async () => ({ kind: 'requester',
              identity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: account.serverIdentityId!, hostAccountAgent: {
                accountId: 'alice', custodianAccountId: 'alice', machineId: 'voice-machine', installationId: 'voice-installation' } }) }),
              isolationEnabled: false, accountSettings: settings, accountSettingsSnapshot: snapshot, machineId: 'voice-machine', directory: home,
              agentId: request.agentId, agentAcceptsUserMcp: true, includeHappierMcpServer: true,
              localTransport: { agentUid: process.getuid!() }, executionRun: { ...request, getPermissionMode: () => 'read-only' } });
            return { mcpServers: toAgentSessionMcpLaunchConfigs(binding.mcpServers), supportedSessionReadActions: [],
              get agentEnvironment() { return binding.agentEnvironment; }, get sessionMcpContext() { return binding.sessionMcpContext; },
              dispose: async () => { await binding.happierMcpServer.stop(); } };
          } },
        resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args, credentials, serverId,
          sessionMetadata: session.getMetadataSnapshot(), accountEntries: [], profileEntries: [], projectEntries: [], directory: home }),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
      bridge = createBridge();
      let admittedStartInput: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
      let producedStart: Awaited<ReturnType<ReturnType<typeof createActionExecutor>['execute']>> | undefined;
      const createDeps = (manager: ExecutionRunHostBridge) => createExecutionRunRpcActionDeps({ manager, context: { sessionId: session.sessionId, cwd: home,
        getServerFeaturesSnapshot: () => ({ status: 'ready', features }) },
        policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }), isExecutionRunsEnabled: () => true });
      let deps = createDeps(bridge);
      let cliDeps: ReturnType<typeof createCliActionDeps>;
      const prepareAccountContext = (input: Pick<Parameters<typeof prepareRequesterAccountActionContext>[0], 'authorization' | 'purpose' | 'signal'>) =>
        prepareRequesterAccountActionContext({ ...input, machineId: 'voice-machine', installationId: 'voice-installation',
          installationPrivateKey: startBoundary.installationPrivateKey, serverId, serverIdentityId,
          serverHttpBaseUrl: account.endpointUrl, ownCredentials: credentials, isCurrent: async () => !controller.signal.aborted,
          createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials, serverId,
            serverApiUrl: account.endpointUrl, serverIdentityId, machineId: 'voice-machine',
            externalActionMachineInstallationId: 'voice-installation', externalActionMachineRequestPrivateKey: startBoundary.installationPrivateKey }),
        });
      const startBoundary = await answerExternalActionAccountForHome(homes, serverId, { actionId: 'execution.run.start', machineId: 'voice-machine',
        installationId: 'voice-installation', tokenEpoch: 0, execute: async (raw, context) => {
          const request = ExecutionRunStartRequestSchema.parse(raw);
          expect(request).toMatchObject({ intent: 'voice_agent', modelId: 'ollama/qwen2.5:3b' });
          admittedStartInput = request;
          const prepared = await prepareAccountContext({ authorization: context.authorization,
            purpose: { kind: 'external_action' }, signal: controller.signal });
          if (!prepared?.invocation) throw new Error('Missing admitted requester projection');
          try {
          const result = await createActionExecutor(cliDeps).execute('execution.run.start', raw, {
            ...prepared.invocation, defaultSessionId: session.sessionId, serverId, runtimeAccountId: 'alice',
            actionCaller: prepared.invocation.caller, externalActionExecutionAuthorization: prepared.authorization,
            externalActionTarget: context.target });
          producedStart = result;
          expect(result).toMatchObject({ ok: true });
          return result.ok ? result.result : result;
          } finally { await prepared.dispose(); }
        } });
      cliDeps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId, serverIdentityId, serverHttpBaseUrl: account.endpointUrl, externalActionMachineInstallationId: 'voice-installation',
        externalActionMachineRequestPrivateKey: startBoundary.installationPrivateKey,
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
      const rpc = new RpcHandlerManager({ scopePrefix: session.sessionId, scopeKind: 'session', localMachineId: 'voice-machine',
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: createSessionRpcAuthorization({
          sessionId: session.sessionId, localMachineId: 'voice-machine', serverUrl: account.endpointUrl,
          isClosed: () => controller.signal.aborted, readHomeServerIdentityId: () => serverIdentityId,
          readOwnerCredentials: async () => credentials }),
        prepareRequesterAccountContext: input => prepareAccountContext({ authorization: input.authorization,
          purpose: input.purpose ?? { kind: 'external_action' }, ...(input.signal ? { signal: input.signal } : {}) }),
      });
      registerExecutionRunActionRpcHandlers(rpc, { defaultSessionId: session.sessionId, serverId, runtimeAccountId: 'alice',
        executor: createExecutionRunRpcActionExecutor({ manager: bridge, context: { sessionId: session.sessionId, cwd: home,
          getServerFeaturesSnapshot: () => ({ status: 'ready', features }) },
          policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }),
          isExecutionRunsEnabled: () => true }) });
      let deliveredStarts = 0;
      const machineHandlers = new Map<string, RpcHandler<unknown, unknown>>();
      registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) {
        machineHandlers.set(method, handler as RpcHandler<unknown, unknown>);
      } }, { resolveRuntimeRegistry: async () => fixture!.registry });
      rpcChannel.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        (packet: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
          void (async () => {
            const execution = packet.externalActionExecution;
            if (packet.method === `${session.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`) {
              deliveredStarts += 1;
              // Home is a genuine socket boundary: refuse a recursive duplicate
              // so this fixture exposes the wrong receiving executor immediately.
              if (deliveredStarts > 1) {
                acknowledge({ ok: false, error: 'Repeated signed Run Start delivery' });
                return;
              }
            }
            if (execution) expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
              requesterAccountContext: execution.authorization.requesterAccountContext,
              effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
              event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId, params: packet.params,
              signature: execution.machineSignature, publicKey: Buffer.from(startBoundary.machine.installationPublicKey, 'base64') })).toBe(true);
            if (packet.method === `voice-machine:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
              // This separate daemon process is represented at its genuine socket boundary.
              const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
              const describe = machineHandlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
              const result = await describe(decoded.params);
              acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) });
              return;
            }
            const result = await rpc.handleRequest({ method: packet.method, params: packet.params, requestId: packet.requestId,
              authorization: { kind: 'session.write', sessionId: session.sessionId },
              callerAuthority: execution ? resolveExternalActionRootInvocationAuthority(execution.authorization) : 'account_automation',
              ...(execution ? { callerInputAuthorization: execution.authorization } : {}) });
            acknowledge({ ok: true, result });
          })().catch(error => acknowledge({ ok: false, error: String(error) }));
        }));
      const uiSession = createSessionFixture({ id: session.sessionId, serverId, active: true, metadata: { machineId: 'voice-machine', path: home, flavor: 'opencode' } });
      storage.getState().applySessions([uiSession]);
      homes.answer(serverId, 'POST /v2/sessions/read-batch', { body: { results: [{ sessionId: uiSession.id, detail: { status: 200,
        body: { session: createPlainV2SessionRecordFixture({ id: uiSession.id, metadata: uiSession.metadata }) } } }] } });
      daemon = await createSessionDaemonAuthorityFixture({ sessionId: session.sessionId, lifecycleHookRegistry: fixture.registry, execute: async operation => {
        expect(operation.surface).toBe('agent');
        if (!operation.executionRun || !execute) throw new Error('Missing Run binding');
        if (!bridge) throw new Error('Missing live Run host');
        const current = bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: operation.executionRun.runId, expectedOccurrenceId: operation.executionRun.occurrenceId });
        expect(current).toMatchObject({ status: 'current', runtimeState: 'active_turn', activeTurnId: operation.witness.turnId });
        if (current.status !== 'current') throw new Error('Inactive Voice Run');
        return await execute(operation, { sessionId: session.sessionId, isCurrent: async () => true,
          actionInvocation: current.actionInvocation, signal: controller.signal });
      } });
      const client = new DaemonVoiceAgentClient(account.accountLifetime.scope, controller.signal);
      const started = await client.start({ sessionId: session.sessionId, agentId, chatModelId: 'ollama/qwen2.5:3b', commitModelId: 'ollama/qwen2.5:3b', connectedServices: { v: 2, bindingsByServiceId: {} },
        permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: '', retentionPolicy: 'resumable' }).catch(error => {
          if (deliveredStarts === 0 && producedStart === undefined) throw error;
          if (deliveredStarts === 0) expect(producedStart, 'the real CLI producer must issue its admitted Start').toMatchObject({ ok: true });
          expect(deliveredStarts, 'one admitted Start must reach the installed Run host without another Start RPC').toBe(1);
          throw error;
        });
      expect(deliveredStarts).toBe(1);
      expect(started.actionInvocation).toEqual({ caller: { kind: 'host' }, surface: 'voice', authority: canApprove ? 'present_user' : 'account_automation' });
      expect(bridge.get(started.voiceAgentId), JSON.stringify(bridge.get(started.voiceAgentId)?.error)).toMatchObject({ status: 'running', ioMode: 'streaming',
        voiceAgentConfig: expect.any(Object) });
      content = { t: 'plain', v: { voice: { ...settingsDefaults.voice, canApproveRequests: !canApprove } } };
      await answerExternalActionAccountForHome(homes, serverId, { actionId: 'execution.run.ensure', machineId: 'voice-machine',
        installationId: 'voice-installation', tokenEpoch: 0, execute: async (_raw, context) =>
          await deps.executionRunEnsure!(session.sessionId, { runId: started.voiceAgentId, resume: true }, {
            ...context.invocation, actionCaller: context.invocation.caller, externalActionExecutionAuthorization: context.authorization,
          }) });
      const ensured = await client.start({ sessionId: session.sessionId, existingRunId: started.voiceAgentId, agentId,
        chatModelId: 'ollama/qwen2.5:3b', commitModelId: 'ollama/qwen2.5:3b', connectedServices: { v: 2, bindingsByServiceId: {} }, permissionIntent: 'read-only', idleTtlSeconds: 300 });
      expect(ensured.actionInvocation).toEqual(started.actionInvocation);
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-call', status: 'connected', mode: 'listening', canStop: true });
      handle = { accountLifetime: account.accountLifetime, client, voiceAgentId: started.voiceAgentId, rpcSessionId: session.sessionId,
        transcriptEpoch: 0, metadataSessionId: null, backend: 'daemon', agentBackendId: agentId, signal: controller.signal,
        actionInvocation: started.actionInvocation, toolTurnContext: { current: { turnOrigin: 'person', playHostText: async ({ text }) => {
          readBacks.push(text); return { status: 'completed' as const };
        } } } };
      const receive = createVoiceRunActionReverseHandler(handle, 'voice-call');
      execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl: account.endpointUrl, token: credentials.token,
        createExecutor: () => { throw new Error('Voice must use its existing App Action front door'); }, getMachineClient: () => ({
          hasConnectedClientRpcHandler: () => true,
          callConnectedClientRpc: async (method, raw, options) => { expect(method).toBe(voiceRunActionClientRpcMethod(started.voiceAgentId));
            const request = VoiceRunActionDispatchRequestV1Schema.parse(raw); expect(request.voiceRun.runId).toBe(started.voiceAgentId);
            options.onIssued(); return { ok: true, result: await receive(request, { signal: controller.signal }) }; },
        }) });
      const turnBridge = bridge;
      const pending = (async () => {
        const stream = await turnBridge.startTurnStream(started.voiceAgentId, { message: 'Turn the waiting sound on.' });
        if (!stream.ok) throw new Error(`${stream.errorCode}: ${stream.error}`);
        let cursor = 0;
        let finalText: string | undefined;
        while (true) {
          const page = await turnBridge.readTurnStream(started.voiceAgentId, { streamId: stream.streamId, cursor,
            waitForEvents: true, signal: controller.signal });
          if (!page.ok) throw new Error(`${page.errorCode}: ${page.error}`);
          expect(page.events.filter(event => event.t === 'error' || event.t === 'cancelled')).toEqual([]);
          for (const event of page.events) {
            if (event.t === 'voice_output' && event.output.kind === 'turn_final') finalText = event.output.text;
          }
          cursor = page.nextCursor;
          if (page.done) {
            expect(finalText).toBe('Setting updated.');
            return;
          }
        }
      })();
      try {
        const first = await Promise.race([pending.then(value => ({ kind: 'settled', value })), approvalCreated.then(() => ({ kind: 'approval' }))]);
        if (canApprove) { expect(first).toMatchObject({ kind: 'settled' }); expect(homes.artifacts(serverId).list()).toEqual([]); }
        else { expect(first).toEqual({ kind: 'approval' }); expect(version).toBe(1);
          const asks = homes.artifacts(serverId).list(); expect(asks).toHaveLength(1);
          expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: asks[0]!.id, decision: 'approve' },
            { surface: 'ui', serverId, actionCaller: { kind: 'host' } })).toMatchObject({ ok: true }); }
        await pending; expect(version).toBe(2); expect(daemon.actionRequestCount).toBeGreaterThan(0);
        expect(executed).toMatchObject({ anchor: actionInput.anchor, value: actionInput.value });
        if (canApprove) {
          if (!admittedStartInput) throw new Error('Missing signed Start input');
          // Even an ordinary RPC caller naming the same host fields must not
          // receive the signed Account invocation retained by the real Start.
          const forged = await deps.executionRunStart!(session.sessionId, ExecutionRunStartRequestSchema.parse({
            ...admittedStartInput, actionInvocation: started.actionInvocation,
          }), { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' } });
          expect(forged).toMatchObject({ runId: expect.any(String) });
          expect(forged).not.toHaveProperty('actionInvocation');
        }
        // Retiring the host retains restart inputs, not its live Account
        // delegation. A cold signed Ensure admits the current host preference.
        await bridge.dispose();
        bridge = createBridge();
        await bridge.recoverRetainedRuns();
        expect(bridge.get(started.voiceAgentId)).not.toHaveProperty('actionInvocation');
        deps = createDeps(bridge);
        const recovered = await client.start({ sessionId: session.sessionId, existingRunId: started.voiceAgentId, agentId,
          chatModelId: 'ollama/qwen2.5:3b', commitModelId: 'ollama/qwen2.5:3b', connectedServices: { v: 2, bindingsByServiceId: {} },
          permissionIntent: 'read-only', idleTtlSeconds: 300 });
        expect(recovered.actionInvocation).toEqual({ caller: { kind: 'host' }, surface: 'voice',
          authority: canApprove ? 'account_automation' : 'present_user' });
      } finally { controller.abort(); await pending.catch(() => undefined); }
    })()]);
    } finally {
      controller.abort(); await bridge?.dispose(); await peer.close(); await daemon?.close(); await fixture?.dispose(); await rpcChannel.close(); account.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
