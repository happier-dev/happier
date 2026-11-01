import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import fastify from 'fastify';
import Ajv from 'ajv';
import { z } from 'zod/mini';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse, deriveSessionCreationTagV1, FeaturesResponseSchema, normalizeActionsSettingsV1, projectSessionAccessCapabilitiesV1, SessionCreationCorrespondenceV1Schema, SessionInputRequestSchema, V2SessionByIdResponseSchema, type AccountSettings } from '@happier-dev/protocol';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encrypt, decrypt, encodeBase64 } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { createCommittedContributedActionDefinitionLister } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import * as daemonControlClient from '@/daemon/controlClient';
import { restartSessionRunnerOnCurrentRuntime } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import type { TrackedSession } from '@/daemon/types';
import { ActionDiscoveryDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { HappyMcpSessionClient } from './startHappyServer';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { deriveSessionMessageReplyReturnLocalIdV1, SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { forEachJsonSchemaChild, type JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { AgentModelsProbeObservationSchema, AgentConfigOptionsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { compileActionCliFields, findCompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import { parseActionCliInput, composeActionCliInput } from '@/cli/actions/parseCommandInput';

const env = process.env;

const getTestServerBinding = () => ({
  serverId: 'test-home',
  serverUrl: 'https://test-home.example.test',
} as const);

async function installAccountCatalogDaemonTransport(params: Readonly<{
  sessionId: string;
  readMetadata: () => Readonly<Record<string, unknown>> | null;
  mode?: 'plain' | 'e2ee';
  serveAccountCatalog?: boolean;
  machineActionDirectTargetTransport?: Parameters<typeof createCliActionExecutorFromCredentials>[0]['machineActionDirectTargetTransport'];
}>) {
  const mode = params.mode ?? 'plain';
  const secret = new Uint8Array(32).fill(17);
  const credentials = { token: 'catalog-test-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
  const app = fastify();
  const restore = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
  let sessionReads = 0;
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
  if (params.serveAccountCatalog) {
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/artifacts', async request => artifactListResponse(`http://localhost${request.url}`, []));
    app.get(ACP_CATALOG_ROWS_ROUTE_V1, async () => ({ status: 'absent' }));
  }
  app.get('/v2/sessions/:sessionId', async (_request, reply) => {
    sessionReads += 1;
    const metadata = params.readMetadata();
    if (!metadata) return reply.code(404).send({ error: 'not_found' });
    return { session: createSessionRecordFixture({ id: params.sessionId, encryptionMode: mode,
      share: null,
      metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata)),
    }) };
  });
  const executor = createCliActionExecutorFromCredentials({
    credentials, serverId: getTestServerBinding().serverId, serverApiUrl: getTestServerBinding().serverUrl,
    pluginActionExecutionOwner: 'current_process',
    listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
    ...(params.machineActionDirectTargetTransport ? { machineActionDirectTargetTransport: params.machineActionDirectTargetTransport } : {}),
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
  });
  const registryLease = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: () =>
    resolveExecutablePluginRuntimeRegistry({ contributes: params.machineActionDirectTargetTransport
      ? getResolvedContributionRegistry() : createResolvedContributionRegistry({}), pluginIds: [] }) });
  await registryLease.release();
  const control = createDaemonControlApp({
    getChildren: () => [], machineId: 'machine-1', controlToken: 'catalog-control-token',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
    requestShutdown: () => {}, onHappySessionWebhook: () => {},
    externalActionApi: {
      currentServerId: getTestServerBinding().serverId, executor,
      verifyPat: async () => { throw new Error('Catalog transport does not verify PATs'); },
      resolveTarget: async () => ({ kind: 'machine' as const, machineId: 'machine-1' }),
    },
    pluginChangeService: {
      requestPluginChange: vi.fn(), decidePluginChange: vi.fn(),
      statusPluginChange: async () => ({ kind: 'expired' as const }),
      listPendingPluginChanges: async () => ({ changes: [] }), shutdown: async () => {},
    },
  });
  // Only daemon IPC and Home HTTP are substituted. Keep the actual control
  // route's result projection as well as the credentialed Action executor.
  vi.spyOn(daemonControlClient, 'requestDaemonPluginActionExecution').mockImplementation(async (request) => {
    const response = await control.inject({
      method: 'POST', url: '/plugins/actions/execute',
      headers: { 'x-happier-daemon-token': 'catalog-control-token' }, payload: request,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  });
  return { executor, getSessionReads: () => sessionReads, close: async () => {
    restore(); await control.close(); await app.close();
  } };
}

const catalogHostTurn = {
  getWorkDepth: () => 0,
  getHostTurnWorkDepth: (turnId: string) => turnId === 'catalog-turn' ? 0 : undefined,
  getActiveTurnPermissionWitness: () => ({ turnId: 'catalog-turn',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
};

function createProductionSessionDaemonExecutor(credentials: Parameters<typeof createCliActionExecutorFromCredentials>[0]['credentials']) {
  return createDaemonSessionAccountActionExecutor({
    serverId: getTestServerBinding().serverId, serverHttpBaseUrl: getTestServerBinding().serverUrl,
    token: credentials.token, credentials, machineId: 'machine-1',
    // Home authorization issuance is the remote boundary. The production daemon
    // and credentialed executor consume its strict, request-bound result.
    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin }) => {
      const target = { kind: 'machine' as const, machineId: 'machine-1' };
      return { target, authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-authorization', binding: {
        accountId: 'account-1', authentication: { kind: 'account', tokenEpoch: 0 },
        serverIdentityId: 'srv_test-home', machineId: target.machineId, custodianAccountId: 'account-1', installationId: 'fixture-installation',
        actionId: operation.actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: operation.requestId, target, input: operation.input })),
        sessionActionOrigin, sessionActionSource: { machineId: target.machineId, installationId: 'fixture-installation' },
      } }) };
    },
    createExecutor: (getCurrentTurnWorkDepth, isCallerCurrent) => createCliActionExecutorFromCredentials({
      credentials, serverId: getTestServerBinding().serverId, serverApiUrl: getTestServerBinding().serverUrl,
      getCurrentTurnWorkDepth, readCredentials: async () => await isCallerCurrent() ? credentials : null,
    }),
  });
}

afterAll(async () => { await pluginReloadController.shutdown(); });

function hostClient(sessionId: string, overrides: Partial<HappyMcpSessionClient> = {}): HappyMcpSessionClient {
  return {
    sessionId,
    getServerBinding: getTestServerBinding,
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {},
    getMetadataSnapshot: () => createTestMetadata(),
    ...catalogHostTurn,
    ...overrides,
  };
}

async function withMcpClient(runtime: ReturnType<typeof createHappierMcpServer>, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'session-mcp-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await runtime.mcp.close();
  }
}

async function withTitleHost(
  sessionId: string,
  getAccountSettings: () => AccountSettings,
  run: (fixture: Readonly<{
    runtime: ReturnType<typeof createHappierMcpServer>;
    readSharedMetadata: () => unknown;
    persistedWrites: () => number;
    localWrites: () => number;
  }>) => Promise<void>,
) {
  const credentials = { token: 'title-daemon-account', encryption: null };
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: createTestMetadata(), agentState: null });
  let metadata = fields.sharedMetadata.ciphertext;
  let ownerMetadata = fields.ownerMetadata;
  let metadataVersion = 1;
  let agentStateVersion = 0;
  let writes = 0;
  let localWrites = 0;
  const app = fastify();
  const restore = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
  app.get('/v2/sessions/:sessionId', async () => V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({ id: sessionId,
    encryptionMode: 'plain', metadataLayoutVersion: 1, metadata, ownerMetadata, metadataVersion, agentStateVersion, share: null,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  }) }));
  app.patch('/v2/sessions/:sessionId', async request => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(request.body);
    if (patch.mode !== 'owner') throw new Error('Expected an owner metadata tuple');
    expect(patch.sharedMetadata.expectedVersion).toBe(metadataVersion);
    expect(patch.expectedOwnerMetadata).toEqual(ownerMetadata);
    metadata = patch.sharedMetadata.ciphertext;
    ownerMetadata = patch.ownerMetadata;
    writes += 1;
    return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: ++metadataVersion }, agentState: { version: ++agentStateVersion } });
  });
  // Home persistence and the daemon are external boundaries. The actual Action
  // policy, title mutation, envelope projection and HTTP CAS remain real.
  // Imported after the describe's module reset so the harness, Home base-URL scope and Session HTTP owner share one module graph.
  const { createCliActionExecutorHarness } = await import('@/session/actions/createCliActionExecutorHarness');
  const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId,
    mode: 'plain', ctx: null, serverId: getTestServerBinding().serverId, serverHttpBaseUrl: getTestServerBinding().serverUrl,
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(getAccountSettings().actionsSettingsV1) },
  });
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
    execute: operation => executor.execute(ActionIdSchema.parse(operation.actionId), operation.input,
      { surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: sessionId }),
  });
  const runtime = createHappierMcpServer(hostClient(sessionId, {
    updateMetadata: () => { localWrites += 1; },
    getActiveTurnAdmissionWitness: () => ({ turnId: 'title-turn', inputId: 'title-input', userMessageSeq: 1, userMessageSeqs: [1],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
  }), { credentials: null, getAccountSettings });
  try {
    await run({ runtime, readSharedMetadata: () => JSON.parse(metadata), persistedWrites: () => writes, localWrites: () => localWrites });
  } finally {
    try {
      await runtime.mcp.close();
      await daemon.close();
    } finally { restore(); await app.close(); }
  }
}

function resetEnvironment() {
  process.env = { ...env };
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  resetActiveAccountSettingsSnapshotForTests();
}

function unmockCaseModules() {
  vi.doUnmock('@/session/actions/createCliActionExecutorHarness');
  vi.doUnmock('@/mcp/server/registerHappierMcpBuiltInTools');
  vi.doUnmock('@/discussions/discussionActionDeps');
  vi.doUnmock('@/api/accountServerActionDeps');
  vi.doUnmock('@/api/sessionFollowActionDeps');
}

describe('createHappierMcpServer real host admission', () => {
  // These cases create fresh clients/transports and restore their HTTP adapter.
  // No module mocks change between them. Load the real graph during collection,
  // so compilation cannot outlive a test and overlap its HTTP adapter lifetime.
  beforeEach(resetEnvironment);
  afterEach(unmockCaseModules);
  afterEach(() => vi.restoreAllMocks());

  it.each(['ready', 'missing_identity'] as const)('prepares an explicit addressed reply through the daemon async Home snapshot and original custody (%s)', async snapshotKind => {
    const sessionId = 'c777777777777777777777777';
    const serverIdentityId = 'srv_explicit_reply_home';
    const binding = { serverId: `reply-profile-${snapshotKind}`, serverUrl: `https://explicit-reply-${snapshotKind.replace('_', '-')}.test` };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 14, participantSessionId: sessionId };
    const witness = { turnId: 'native-turn', inputId: 'original-input', userMessageSeq: 3, userMessageSeqs: [3],
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 }, discussionAddressing: addressing };
    const features = FeaturesResponseSchema.parse({ features: {
      sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } },
    }, capabilities: snapshotKind === 'ready' ? { serverIdentity: { serverIdentityId } } : {} });
    const app = fastify();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: binding.serverUrl });
    app.get('/v1/features', async () => features);
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain' }) }));
    app.get('/v1/discussions/discussion/participants', async () => ({ discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner', grants: [],
      participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 }] }));
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/original-input/reply`, async () => SessionMessageReplyReadResultV1Schema.parse({
      v: 1, status: 'available', progress: { v: 1, mode: 'return', disposition: 'observing', acceptedTurnId: witness.turnId, discussion: addressing },
    }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v1/artifacts', async request => artifactListResponse(`http://localhost${request.url}`, []));
    app.get('/v1/artifacts/:artifactId', async (_request, reply) => reply.code(404).send({ error: 'Artifact not found' }));
    const captured: ReturnType<typeof ApprovalRequestV2Schema.parse>[] = [];
    app.post('/v1/artifacts', async request => {
      const body = z.object({ id: z.string(), body: z.string() }).parse(request.body);
      const content = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(body.body));
      captured.push(ApprovalRequestV2Schema.parse(JSON.parse(content.body)));
      return { id: body.id, headerVersion: 1, bodyVersion: 1 };
    });
    const originalFetch = globalThis.fetch;
    // Home HTTP is the boundary. Daemon capability TCP and all MCP/Action,
    // feature-store, original-custody and approval-codec logic remain real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (new URL(String(url)).origin !== binding.serverUrl) return originalFetch(url, init);
      const response = await app.inject({ method: 'GET', url: new URL(String(url)).pathname });
      return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    });
    const store = createServerUrlServerFeaturesSnapshotStore({ serverUrl: binding.serverUrl, token });
    const settings = createActionSettingsProvider({ accountSettings: accountSettingsParse({}) });
    let publications = 0;
    const execute = createDaemonSessionAccountActionExecutor({ serverId: binding.serverId, serverHttpBaseUrl: binding.serverUrl,
      token, credentials, machineId: 'machine-1', resolveServerFeaturesSnapshot: () => store.refresh(),
      createExecutor: (_depth, _current, postAgentDiscussionMessage) => createCliActionExecutor({ token, credentials,
        sessionId, mode: 'plain', ctx: null, serverId: binding.serverId, serverIdentityId, serverHttpBaseUrl: binding.serverUrl,
        resolveServerFeaturesSnapshot: () => store.refresh(), actionsSettingsProvider: settings, postAgentDiscussionMessage,
        pluginActionExecutionOwner: 'current_process' }),
      postAgentDiscussionMessage: async () => { publications += 1; return { v: 1, ok: false, error: 'discussion_post_denied' }; },
    });
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: operation => execute(operation,
      { sessionId, isCurrent: async () => true }) });
    await store.refresh();
    const runtime = createHappierMcpServer(hostClient(sessionId, { getServerBinding: () => binding, getActiveTurnAdmissionWitness: () => witness,
      getServerFeaturesSnapshot: () => store.getSnapshot() }), { credentials: null, sessionCredentials: credentials,
      requiredDirectActionIds: ['discussion.reply'], actionsSettingsProvider: settings });
    try {
      expect(await store.refresh()).toMatchObject({ status: 'ready', features });
      expect(runtime.toolNames).toContain('discussion_reply');
      await withMcpClient(runtime, async client => {
        const result = await client.callTool({ name: 'discussion_reply', arguments: { discussionId: addressing.discussionId,
          replyTarget: { kind: 'message', messageId: addressing.messageId },
          content: { v: 1, parts: [{ t: 'text', text: 'The explicit requested answer' }] } } });
        if (snapshotKind === 'missing_identity') expect(result).toMatchObject({ isError: true,
          content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('discussion_content_unavailable') })]) });
        else expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
      });
      if (snapshotKind === 'missing_identity') {
        expect(captured).toHaveLength(0);
        expect(publications).toBe(0);
        return;
      }
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ actionId: 'discussion.reply', actionArgs: {
        localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId: witness.inputId, acceptedTurnId: witness.turnId }),
        replyTarget: { kind: 'message', messageId: addressing.messageId },
        content: { v: 1, parts: [{ t: 'text', text: 'The explicit requested answer' }] },
      }, executionOriginV1: { serverId: binding.serverId, serverIdentityId,
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: witness.turnId, sourceInputId: witness.inputId, discussionAddressing: addressing },
        discussionReplyReturn: { serverId: serverIdentityId, requestLocalId: witness.inputId, acceptedTurnId: witness.turnId } } });
      expect(publications).toBe(0);
    } finally {
      await runtime.mcp.close();
      await daemon.close();
      restoreHttp();
      await app.close();
    }
  });

  it('retains content-free discovery and execution repair details over native MCP', async () => {
    const sessionId = 'c666666666666666666666667';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const sessionAuthority = await createSessionDaemonAuthorityFixture({ sessionId, agentStartPolicy: accountSettingsParse({}),
      execute: operation => daemon.executor.execute(ActionIdSchema.parse(operation.actionId), operation.input, {
        surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
      }) });
    const bridge = await createHappierMcpBridge(hostClient(sessionId, {
      getActiveTurnAdmissionWitness: () => ({ turnId: 'catalog-turn', inputId: 'catalog-input', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
    }));
    const client = new Client({ name: 'native-discovery-contract-test', version: '1' });
    try {
      const config = bridge.mcpServers.happier;
      await client.connect(new StdioClientTransport({ command: config.command,
        args: [...(config.args ?? [])], env: config.env ? { ...config.env } : undefined }));
      const cases = [
        { name: 'action_spec_get', arguments: { id: 'definitely.invalid.action' }, path: ['id'], code: 'unknown_action' },
        { name: 'action_spec_get', arguments: { id: 'acme.external/actions/private-unknown-action' }, path: ['id'], code: 'unknown_action' },
        { name: 'action_spec_get', arguments: { id: 'session.spawn_new', schemaPath: '/inputSchema/definitions/not-a-section' },
          path: ['schemaPath'], code: 'invalid_schema_path' },
        { name: 'action_options_resolve', arguments: { actionId: 'definitely.invalid.action', fieldPath: 'bogus' }, path: ['actionId'], code: 'unknown_action' },
        { name: 'action_options_resolve', arguments: { actionId: 'session.spawn_new', fieldPath: 'bogus' }, path: ['fieldPath'], code: 'unknown_field' },
        { name: 'action_options_resolve', arguments: { actionId: 'session.spawn_new', fieldPath: 'configuration', draftInput: {} },
          path: ['draftInput', 'agentTarget'], code: 'invalid_selection' },
        { name: 'action_execute', arguments: { actionId: 'agents.config_options.list', input: {
          backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6-luna', machineId: 'machine', serverId: 'private-home-value', limit: 50,
        } }, path: ['serverId'], code: 'invalid_type' },
        { name: 'action_execute', arguments: { actionId: 'agents.config_options.list', input: {
          backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 123,
        } }, path: ['modelId'], code: 'invalid_type' },
      ];
      for (const testCase of cases) {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: testCase.name, arguments: testCase.arguments }));
        expect(reply.isError).toBe(true);
        const content = reply.content.find(item => item.type === 'text');
        if (content?.type !== 'text') throw new Error('Missing refusal payload');
        const payload = JSON.parse(content.text);
        expect(payload, testCase.name).toMatchObject({ errorCode: 'invalid_parameters',
          details: { issues: expect.arrayContaining([expect.objectContaining({ code: testCase.code, path: testCase.path })]) } });
        expect(content.text).not.toContain('private-home-value');
        expect(content.text).not.toContain('private-unknown-action');
      }
    } finally { await client.close(); bridge.happierMcpServer.stop(); await sessionAuthority.close(); await daemon.close(); }
  }, 30_000);

  it('retains canonical Run start issues and certainty for all three cont24 native payloads', async () => {
    const sessionId = 'c666666666666666666666670';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const sessionAuthority = await createSessionDaemonAuthorityFixture({ sessionId, agentStartPolicy: accountSettingsParse({}),
      execute: operation => daemon.executor.execute(ActionIdSchema.parse(operation.actionId), operation.input, {
        surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
      }) });
    const bridge = await createHappierMcpBridge(hostClient(sessionId, {
      getActiveTurnAdmissionWitness: () => ({ turnId: 'catalog-turn', inputId: 'catalog-input', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
    }));
    const client = new Client({ name: 'native-run-start-repair-test', version: '1' });
    const base = { intent: 'agent', backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      instructions: 'Reply with exactly: Run ORC_C2_CONT24_OK. Do not use tools, files, shell, or delegate.',
      display: { title: 'C2-cont24 F1 Execution Run 20261022' }, permissionMode: 'read_only', retentionPolicy: 'persistent',
      runClass: 'bounded', ioMode: 'request_response', cwd: '/tmp', configOptions: { reasoning_effort: 'low' },
      waitForCompletion: true, waitTimeoutSeconds: 45 };
    const selections = [
      { modelId: 'gpt-6-luna', connectedServices: ['happier.agent.codex/openai-codex:profile:705530f2-81e8-4ba2-bc7b-7929a4b95b5a'] },
      { modelId: 'gpt-6-luna', connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: '705530f2-81e8-4ba2-bc7b-7929a4b95b5a' },
      } } },
      { modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' } },
    ];
    try {
      const config = bridge.mcpServers.happier;
      await client.connect(new StdioClientTransport({ command: config.command,
        args: [...(config.args ?? [])], env: config.env ? { ...config.env } : undefined }));
      for (const selection of selections) {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
          arguments: { actionId: 'execution.run.start', input: { ...base, ...selection } } }));
        expect(reply.isError).toBe(true);
        const content = reply.content.find(item => item.type === 'text');
        if (content?.type !== 'text') throw new Error('Missing Run refusal');
        expect(JSON.parse(content.text)).toMatchObject({ errorCode: 'invalid_parameters', details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
          issues: [{ code: 'invalid_value', path: ['retentionPolicy'], acceptedValues: ['ephemeral', 'resumable'] }],
        } });
        expect(content.text).not.toContain(base.instructions);
        expect(content.text).not.toContain('705530f2');
        // Changing only the refused field admits each discovered selection
        // through the real input contract, without starting a native process.
        expect(getActionSpec('execution.run.start').inputSchema.safeParse({
          ...base, ...selection, retentionPolicy: 'resumable',
        }).success).toBe(true);
      }
    } finally { await client.close(); bridge.happierMcpServer.stop(); await sessionAuthority.close(); await daemon.close(); }
  }, 30_000);

  it.each(['account', 'session'] as const)('retains intent-dependent policy repair and no-creation evidence through native MCP (%s)', async authorityScope => {
    const sessionId = 'c666666666666666666666671';
    const catalogs = await installAccountCatalogDaemonTransport({ sessionId, serveAccountCatalog: true,
      readMetadata: () => createTestMetadata({ machineId: 'machine-1', path: configuration.happyHomeDir }) });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.fixture`, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(getTestServerBinding().serverUrl, () => resolveAccountSettingsScopeKey(credentials)),
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
    });
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const features = () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
      features: { voice: { enabled: true } }, capabilities: {},
    }) });
    const readRoleSources = createRoleSourceReader({});
    const sessionRoles = createSessionRoleContext({ readMetadata: () => createTestMetadata(),
      readOrganization: async () => ({}), readRoleSources,
      // The Session-scoped host consumes only its admitted Role projection.
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    });
    const host = hostClient(sessionId, {
      getBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: configuration.happyHomeDir }),
      getServerFeaturesSnapshot: features,
      ...(authorityScope === 'session' ? { getSessionRoleContext: () => sessionRoles, readRoleSources } : {}),
      getActiveTurnAdmissionWitness: () => ({ turnId: 'catalog-turn', inputId: 'catalog-input', userMessageSeq: 1, userMessageSeqs: [1],
        agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'yolo',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
    });
    let manager: ExecutionRunHostBridge | undefined;
    const registration = registerExecutionRunHandlers(host.rpcHandlerManager, {
      sessionId, cwd: configuration.happyHomeDir, parentProvider: 'codex', sendAcp: async () => {},
      getServerFeaturesSnapshot: features, onManagerCreated: created => { manager = created; },
    });
    const daemonExecute = createProductionSessionDaemonExecutor(credentials);
    const authority = authorityScope === 'session' ? await createSessionDaemonAuthorityFixture({ sessionId, agentStartPolicy: accountSettingsParse({}),
      execute: operation => daemonExecute(operation, { sessionId, isCurrent: async () => true }),
    }) : null;
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    const bridge = await createHappierMcpBridge(host, { authorityScope, sessionCredentials: credentials,
      ...(authorityScope === 'account' ? { credentials } : {
        actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({})),
      }),
    });
    const client = new Client({ name: 'native-run-policy-test', version: '1' });
    const request = { intent: 'voice_agent', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Private reply-only instructions', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', modelId: 'gpt-6-luna', configOptions: { reasoning_effort: 'low' } };
    try {
      const config = bridge.mcpServers.happier;
      await client.connect(new StdioClientTransport({ command: config.command,
        args: [...(config.args ?? [])], env: config.env ? { ...config.env } : undefined }));
      const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'execution.run.start', input: request } }));
      expect(reply.isError).toBe(true);
      const content = reply.content.find(item => item.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing policy refusal');
      const failure = JSON.parse(content.text);
      expect(failure, JSON.stringify(failure)).toMatchObject({ errorCode: 'execution_run_not_allowed', details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
      } });
      expect(failure.details.issues).toEqual([
        { code: 'invalid_value', path: ['retentionPolicy'], acceptedValues: ['resumable'] },
        { code: 'invalid_value', path: ['runClass'], acceptedValues: ['long_lived'] },
        { code: 'invalid_value', path: ['ioMode'], acceptedValues: ['streaming'] },
      ]);
      expect(content.text).not.toContain(request.instructions);
      expect(manager?.listPublicForRequest({}, sessionId)).toEqual([]);
      const discovery = CallToolResultSchema.parse(await client.callTool({ name: 'action_options_resolve',
        arguments: { actionId: 'execution.run.start', fieldPath: 'intent' } }));
      expect(discovery.isError ?? false, JSON.stringify(discovery)).toBe(false);
      const optionContent = discovery.content.find(item => item.type === 'text');
      if (optionContent?.type !== 'text') throw new Error('Missing intent discovery');
      const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(JSON.parse(optionContent.text)).options;
      expect(options.find(option => option.value === 'voice_agent')?.description)
        .toMatch(/retentionPolicy: resumable.*runClass: long_lived.*ioMode: streaming/u);
      expect(options.find(option => option.value === 'delegate')?.description).toMatch(/ordinary bounded child work/u);
    } finally { await client.close(); bridge.happierMcpServer.stop();
      await authority?.close(); registration.dispose(); await manager?.dispose(); await catalogs.close(); }
  }, 30_000);


  it.each([
    { name: 'action_spec_get', arguments: { id: 'workflow.run.start', schemaPath: 'private-malformed-pointer' },
      issue: { code: 'invalid_format', path: ['schemaPath'], expected: 'starts_with "/"' } },
    { name: 'session_title_set', arguments: { title: { privateRejectedValue: 'private-malformed-title' } },
      issue: { code: 'invalid_type', path: ['title'], expected: 'string' } },
    { name: 'change_title', arguments: { title: { privateRejectedValue: 'private-malformed-title' } },
      issue: { code: 'invalid_type', path: ['title'], expected: 'string' } },
    { name: 'action_execute', arguments: { actionId: { privateRejectedValue: 'private-malformed-action' } },
      issue: { code: 'invalid_type', path: ['actionId'], expected: 'string' } },
    { name: 'qa_input_read', arguments: { scope: { privateRejectedValue: 'private-malformed-scope' } },
      issue: { code: 'type', path: ['scope'], expected: 'string' } },
    { name: 'qa_input_ref_read', arguments: { scope: { privateRejectedValue: 'private-malformed-scope' } },
      issue: { code: 'type', path: ['scope'], expected: 'string' } },
    { name: 'qa_input_tool_only_read', arguments: { scope: { privateRejectedValue: 'private-malformed-scope' } },
      issue: { code: 'type', path: ['scope'], expected: 'string' } },
  ])('retains content-free MCP input repair details for $name over the native daemon bridge', async testCase => {
    const sessionId = 'c666666666666666666666669';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    const pluginInputSchema = testCase.name === 'qa_input_ref_read'
      ? { type: 'object', definitions: { scope: { type: 'string' } }, properties: { scope: { $ref: '#/definitions/scope' } },
        required: ['scope'], additionalProperties: false }
      : { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false };
    const plugin = testCase.name.startsWith('qa_input_') ? await createAuthoredAdmittedPluginRuntimeFixture({
      controller: pluginReloadController, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: 'acme.mcp-input', contributes: {
          actions: [{ id: 'read', title: 'Read scope', scopes: ['global'], surfaces: ['agent', 'mcp'],
            execution: { target: 'daemon' }, dangerLevel: 'safe',
            inputSchema: testCase.name === 'qa_input_tool_only_read' ? { type: 'object' } : pluginInputSchema }],
          tools: [{ id: 'read-tool', name: testCase.name, title: 'Read scope', action: 'read', surfaces: ['agent', 'mcp'],
            inputSchema: pluginInputSchema }],
        } }),
        files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("read", async input => input); }' },
      }],
    }) : null;
    if (plugin) await plugin.registry.activateContributionsOnDemand([{ pluginId: 'acme.mcp-input', family: 'actions', localId: 'read' }]);
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [],
      tools: plugin ? projectExecutablePluginToolCatalog(plugin.registry) : [] });
    const sessionAuthority = await createSessionDaemonAuthorityFixture({ sessionId,
      execute: operation => daemon.executor.execute(ActionIdSchema.parse(operation.actionId), operation.input, {
        surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
      }) });
    const bridge = await createHappierMcpBridge(hostClient(sessionId, {
      getActiveTurnAdmissionWitness: () => ({ turnId: 'catalog-turn', inputId: 'catalog-input', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
    }), { requiredDirectActionIds: ['session.title.set'] });
    const client = new Client({ name: 'native-input-repair-test', version: '1' });
    try {
      const config = bridge.mcpServers.happier;
      await client.connect(new StdioClientTransport({ command: config.command,
        args: [...(config.args ?? [])], env: config.env ? { ...config.env } : undefined }));
      const reply = CallToolResultSchema.parse(await client.callTool({ name: testCase.name, arguments: testCase.arguments }));
      expect(reply.isError, JSON.stringify(reply)).toBe(true);
      const content = reply.content.find(item => item.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing refusal payload');
      expect(content.text, content.text).toMatch(/^\{/u);
      expect(JSON.parse(content.text), content.text).toMatchObject({
        errorCode: plugin ? 'plugin_action_input_schema_invalid' : 'invalid_parameters',
        details: { issues: [testCase.issue] } });
      expect(content.text).not.toContain('private-malformed');
      expect(content.text).not.toContain('privateRejectedValue');
    } finally { await client.close(); bridge.happierMcpServer.stop(); await sessionAuthority.close(); await plugin?.dispose(); await daemon.close(); }
  }, 30_000);

  it('enforces the narrower declared Tool contract on the Agent bridge with confidential repair facts and contextual defaults', async () => {
    const sessionId = 'c666666666666666666666669';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const plugin = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: 'acme.agent-tool-input', contributes: {
        actions: [{ id: 'read', title: 'Read scope', scopes: ['global'], surfaces: ['agent', 'mcp'],
          execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object', properties: {
            scope: { type: 'string' }, secretText: { type: 'string' }, bundle: { type: 'string' }, machineId: { type: 'string' },
          } },
          contextualDefaults: { machineId: 'current_session_machine' },
          inputHints: { fields: [{ path: 'bundle', title: 'Bundle', widget: 'secret' },
            { path: 'secretText', title: 'Secret text', widget: 'secret' }] } }],
        tools: [{ id: 'read-tool', name: 'qa_agent_input_read', title: 'Read scope', action: 'read', surfaces: ['agent', 'mcp'],
          inputSchema: { type: 'object', properties: {
            scope: { type: 'string', enum: ['declared-private-secret', 'read'] }, secretText: { type: 'string' },
            bundle: { type: 'array', items: { type: 'string' } }, machineId: { type: 'string' },
          }, required: ['scope', 'machineId'], additionalProperties: false } }],
      } }),
      files: { 'daemon.mjs': 'let calls = 0; export function activate(api) { api.actions.register("read", async input => ({ input, calls: ++calls })); }' },
    }] });
    try {
      await plugin.registry.activateContributionsOnDemand([{ pluginId: 'acme.agent-tool-input', family: 'actions', localId: 'read' }]);
      const bridge = createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: 'worker',
        pluginToolCatalog: projectExecutablePluginToolCatalog(plugin.registry), executor: createDaemonPluginActionExecutor({ base: daemon.executor }) });
      const invalid = await bridge.executeActionByToolName('qa_agent_input_read', {
        scope: 'bad', secretText: 'declared-private-secret', bundle: [42],
      }, sessionId);
      expect(invalid).toMatchObject({ ok: false, errorCode: 'plugin_action_input_schema_invalid', details: { issues: [
        { code: 'enum', path: ['scope'], acceptedValues: ['[REDACTED]', 'read'] },
        { code: 'invalid_value', path: ['bundle'] },
      ] } });
      expect(JSON.stringify(invalid)).not.toContain('declared-private-secret');
      expect(await bridge.executeActionByToolName('qa_agent_input_read', {
        scope: 'bad', secretText: '',
      }, sessionId)).toMatchObject({ ok: false, errorCode: 'plugin_action_input_schema_invalid', details: { issues: [
        { code: 'enum', path: ['scope'], acceptedValues: ['declared-private-secret', 'read'] },
      ] } });
      const validInput = { scope: 'read', secretText: 'another-secret' };
      expect(await bridge.executeActionByToolName('qa_agent_input_read', validInput, sessionId)).toEqual({
        ok: true, result: { input: { ...validInput, machineId: 'worker' }, calls: 1 },
      });
    } finally { await plugin.dispose(); await daemon.close(); }
  });

  it('exposes retained remembered-setup consent through native MCP discovery and the declared CLI command', async () => {
    const sessionId = 'c666666666666666666666670';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const runtime = createHappierMcpServer(hostClient(sessionId));
    try {
      await withMcpClient(runtime, async client => {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id: 'projects.prepare' } }));
        expect(reply.isError).not.toBe(true);
        const content = reply.content.find(item => item.type === 'text');
        if (content?.type !== 'text') throw new Error('Missing discovery payload');
        const discovered = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(JSON.parse(content.text)).actionSpec;
        expect(discovered).toMatchObject({ id: 'projects.prepare', surfaces: { agent: true, mcp: true, cli: true } });
        const spec = getActionSpec('projects.prepare');
        const command = findCompiledActionCliCommand(['project', 'prepare']);
        expect(command?.actionId).toBe(spec.id);
        const fields = compileActionCliFields(spec);
        const input = { workspace: { serverId: 'test-home', workspaceId: 'source-workspace', machineId: 'source', rootPath: '/source' },
          phase: 'setup', heldOperationId: 'retained-setup', expectedEffectDigest: 'reviewed', consentScope: 'untilChanged' };
        const parsed = parseActionCliInput({ ...fields, positionals: [] }, ['--input-json', JSON.stringify(input)]);
        expect(parsed).toMatchObject({ ok: true, canonicalBase: input });
        if (!parsed.ok) throw new Error(parsed.message);
        expect(composeActionCliInput({ ...fields, parsed, canonicalSchema: spec.inputSchema,
          context: { actionId: spec.id, invocationId: 'setup-consent', commandPath: ['project', 'prepare'] } }))
          .toMatchObject({ ok: true, input });
      });
    } finally { await daemon.close(); }
  });

  it('discovers the callable Workflow validator named by start guidance over native MCP', async () => {
    const sessionId = 'c666666666666666666666668';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const runtime = createHappierMcpServer(hostClient(sessionId));
    try {
      await withMcpClient(runtime, async client => {
        const readSpec = async (id: string) => {
          const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id } }));
          expect(reply.isError, id).not.toBe(true);
          const content = reply.content.find(item => item.type === 'text');
          if (content?.type !== 'text') throw new Error('Missing discovery payload');
          return PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(JSON.parse(content.text)).actionSpec;
        };
        const start = ActionDiscoveryDefinitionV1Schema.parse(await readSpec('workflow.run.start'));
        const validatorId = start.description?.match(/Validate the definition with ([\w.]+)/u)?.[1];
        if (!validatorId) throw new Error('Start must identify its definition validator');
        const validator = ActionDiscoveryDefinitionV1Schema.parse(await readSpec(validatorId));
        expect(validator.id).toBe('workflow.validate');
      });
    } finally { await daemon.close(); }
  });

  it.each([
    { agentId: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    { agentId: 'acme.discovery/assistant', identity: { pluginId: 'acme.discovery', localId: 'assistant' } },
  ])('discovers one exact-Machine model and config inventory without probe opt-in for $agentId over native MCP', async ({ agentId, identity }) => {
    const sessionId = 'c666666666666666666666669';
    const backendTargetKey = `agent:${identity.pluginId}/${identity.localId}`;
    if (!agentId.includes('/')) await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry: await resolveExecutablePluginRuntimeRegistry({ contributes: getResolvedContributionRegistry(), pluginIds: [] }),
      changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
    });
    const plugin = agentId.includes('/') ? await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: identity.pluginId, contributes: { agents: [{ id: identity.localId,
        title: 'Discovery Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] } }), files: {
        'runtime.mjs': 'export async function createRuntime() { return { sessions: { open: async () => ({ send: async () => ({ status: "admitted" }), cancel: async () => ({ status: "requested" }), watch: () => ({ dispose() {} }), dispose() {} }) } }; }',
        'daemon.mjs': 'import { createRuntime } from "./runtime.mjs"; export function activate(api) { api.agents.register("assistant", createRuntime, { sessionRunnerFactory: { module: "./runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
      } }],
    }) : null;
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata(),
      // Machine capability transport is the system boundary. Native observations
      // follow the producer schema; inventory selection and projection stay real.
      machineActionDirectTargetTransport: { machineId: 'worker', invoke: async (method, request) => {
        if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return { status: 'unavailable' };
        expect(method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
        const probe = z.object({ id: z.string(), method: z.string(), params: z.unknown() }).parse(request);
        expect(probe.id).toBe(`cli.${agentId}`);
        if (probe.method === 'probeModels') return { ok: true, result: AgentModelsProbeObservationSchema.parse({ agentId,
          availableModels: [{ id: 'small', name: 'Small', modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select',
            currentValue: 'private-current', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] },
            { id: 'large', name: 'Large' }], supportsFreeform: false, source: 'dynamic' }) };
        expect(probe.method).toBe('probeConfigOptions');
        return { ok: true, result: AgentConfigOptionsProbeObservationSchema.parse({ agentId, configOptions: [], source: 'dynamic' }) };
      } },
    });
    const authority = await createSessionDaemonAuthorityFixture({ sessionId,
      execute: operation => daemon.executor.execute(ActionIdSchema.parse(operation.actionId), operation.input, {
        surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' },
        defaultSessionId: sessionId, defaultSessionMachineId: 'worker', serverId: 'test-home',
      }) });
    const runtime = createHappierMcpServer(hostClient(sessionId, {
      getCurrentSessionLocation: () => ({ machineId: 'worker', path: configuration.happyHomeDir }),
      getActiveTurnAdmissionWitness: () => ({ turnId: 'catalog-turn', inputId: 'catalog-input', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
    }));
    try {
      await withMcpClient(runtime, async client => {
        const read = async (name: string, args: Record<string, unknown>) => {
          const reply = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
          const content = reply.content.find(item => item.type === 'text');
          if (content?.type !== 'text') throw new Error('Missing discovery payload');
          expect(reply.isError, content.text).not.toBe(true);
          return JSON.parse(content.text);
        };
        const selection = { agentId, backendTargetKey, machineId: 'worker' };
        const models = await read('action_execute', { actionId: 'agents.models.list', input: selection });
        expect(models).toMatchObject({ items: [{ id: 'small' }, { id: 'large' }], source: 'dynamic' });
        const modelOptions = await read('action_options_resolve', { actionId: 'session.spawn_new', fieldPath: 'modelSelection',
          draftInput: { agentTarget: { kind: 'agent', identity }, executionTarget: { serverId: 'test-home', machineId: 'worker' } } });
        expect(modelOptions.options.map((option: { value: string }) => option.value)).toEqual(models.items.map((item: { id: string }) => item.id));
        const config = await read('action_execute', { actionId: 'agents.config_options.list', input: { ...selection, modelId: 'small' } });
        expect(config).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'low' }, { value: 'high' }] }], source: 'dynamic' });
        expect(JSON.stringify(config)).not.toContain('private-current');
        for (const [actionId, fieldPath, draftInput] of [
          ['session.spawn_new', 'configuration', { agentTarget: { kind: 'agent', identity },
            executionTarget: { serverId: 'test-home', machineId: 'worker' }, modelSelection: { v: 1,
              ref: { agentTargetKey: backendTargetKey, modelId: 'small', providerConnectionId: null }, updatedAt: 1 } }],
          ['execution.run.start', 'configOptions', { ...selection, modelId: 'small' }],
          ['execution.run.start', 'configOptions', { agentId, backendTargetKey, modelId: 'small' }],
        ] as const) {
          const options = await read('action_options_resolve', { actionId, fieldPath, draftInput });
          expect(options.options.map((option: { value: string }) => option.value)).toEqual(config.items.map((item: { id: string }) => item.id));
        }
      });
    } finally { await authority.close(); await daemon.close(); await plugin?.dispose(); }
  });

  it.each(['workflow.run.start', 'workflow.validate'] as const)('discovers recursive Workflow block shapes for %s over native MCP', async id => {
    const sessionId = 'c666666666666666666666670';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const runtime = createHappierMcpServer(hostClient(sessionId));
    try {
      await withMcpClient(runtime, async client => {
        const read = async (schemaPath?: string) => {
          const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id,
            ...(schemaPath ? { schemaPath } : {}) } }));
          const content = reply.content.find(item => item.type === 'text');
          if (content?.type !== 'text') throw new Error('Missing discovery payload');
          expect(reply.isError, content.text).not.toBe(true);
          return PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(JSON.parse(content.text));
        };
        const root = (await readCompleteActionSpecV1({ actionId: id, read: input => read(input.schemaPath) })).inputSchema;
        const definitions = root.definitions as Record<string, JsonSchemaObject>;
        const candidates: unknown[] = [root];
        const visited = new Set<unknown>();
        let fragment: JsonSchemaObject | undefined;
        while (candidates.length && !fragment) {
          const node = candidates.pop();
          if (!node || typeof node !== 'object' || Array.isArray(node) || visited.has(node)) continue;
          visited.add(node);
          const schema = node as JsonSchemaObject;
          const properties = schema.properties as Record<string, JsonSchemaObject> | undefined;
          if (properties?.definition) { fragment = properties.definition; break; }
          if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/definitions/')) {
            candidates.push(definitions[schema.$ref.slice('#/definitions/'.length)]);
          }
          forEachJsonSchemaChild(schema, child => candidates.push(child));
        }
        expect(fragment, 'actual Workflow definition property').toBeDefined();
        const pending: unknown[] = [fragment];
        const needed: Record<string, unknown> = {};
        while (pending.length) {
          const node = pending.pop();
          if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
          const schema = node as JsonSchemaObject;
          if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/definitions/')) {
            const name = schema.$ref.slice('#/definitions/'.length);
            if (!(name in needed)) {
              needed[name] = definitions[name];
              pending.push(definitions[name]);
            }
          }
          forEachJsonSchemaChild(schema, child => pending.push(child));
        }
        const validate = new Ajv({ strict: false, validateFormats: false }).compile({ ...fragment, definitions: needed });
        const step = { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] } };
        const definition = { version: 1, blocks: [{ kind: 'loop', id: 'loop', body: [step],
          repetition: { kind: 'count', count: { kind: 'literal', value: 1 } } }] };
        expect(validate(definition), JSON.stringify(validate.errors)).toBe(true);
        for (const block of [{}, { ...step, unknown: true }, { ...definition.blocks[0], body: [{}] }]) {
          const invalid = { ...definition, blocks: [block] };
          expect(validate(invalid), JSON.stringify(block)).toBe(false);
        }
      });
    } finally { await daemon.close(); }
  });

  it('discovers complete widget and Board inputs over MCP and reads output schemas explicitly', async () => {
    const sessionId = 'c666666666666666666666666';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const runtime = createHappierMcpServer({
      sessionId, getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata(), ...catalogHostTurn,
    });
    const client = new Client({ name: 'widget-spec-discovery', version: '1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find(tool => tool.name === 'action_spec_get')?.inputSchema.properties)
        .toHaveProperty('includeOutputSchema');
      expect(tools.tools.find(tool => tool.name === 'action_spec_get')?.inputSchema.properties)
        .toHaveProperty('schemaPath');
      const readDefinition = async (id: string, includeOutputSchema = false) => {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id, includeOutputSchema } }));
        expect(reply.isError, id).not.toBe(true);
        const text = reply.content.find(content => content.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing discovery result');
        expect(text.text.length, id).toBeLessThan(50000);
        const payload: unknown = JSON.parse(text.text);
        const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(payload);
        const definition = ActionDiscoveryDefinitionV1Schema.parse(result.actionSpec);
        for (const entry of result.schemaSections ?? []) {
          const part = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id, schemaPath: entry.path } }));
          const partText = part.content.find(content => content.type === 'text');
          if (!partText || partText.type !== 'text') throw new Error('Missing schema section');
          expect(partText.text.length, entry.path).toBeLessThan(50000);
          const section = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(JSON.parse(partText.text)).schemaSection;
          if (!section) throw new Error('Missing schema section');
          const [root, , name] = entry.path.slice(1).split('/');
          const schema = root === 'inputSchema' ? definition.inputSchema : definition.outputSchema;
          if (!schema || !name) throw new Error('Unknown schema root');
          const definitions = schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};
          schema.definitions = { ...definitions, [name.replace(/~1/g, '/').replace(/~0/g, '~')]: section.schema };
        }
        return definition;
      };
      for (const id of ['widgets.catalog.list', 'boards.apply', 'home.hub.layout.update', 'session.board.item.upsert'] as const) {
        const definition = await readDefinition(id);
        expect(definition.id).toBe(id);
        expect(definition.outputSchema).toBeUndefined();
        const validate = new Ajv({ strict: false }).compile(definition.inputSchema);
        expect(validate({}), id).toBe(false);
        if (id === 'boards.apply') {
          const input = { boardId: 'board-1', intent: { kind: 'update', boardId: 'board-1', patch: { name: 'Renamed' } } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ ...input, intent: { ...input.intent, kind: 'unknown' } })).toBe(false);
        }
        if (id === 'home.hub.layout.update') {
          const input = { intent: { kind: 'visibility', sectionId: 'machines', hidden: false } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ intent: { ...input.intent, hidden: 'false' } })).toBe(false);
        }
        if (id === 'session.board.item.upsert') {
          const input = { sessionId, itemId: 'discovered-note', expectedItemRevision: null, item: { v: 1, title: 'Note', frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: {
              version: 1, root: { kind: 'stack', children: [{ kind: 'text', text: 'Complete schema' }] },
            } } } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ ...input, item: { ...input.item, title: 42 } })).toBe(false);
          expect(validate({ ...input, item: { ...input.item, source: { ...input.item.source,
            document: { version: 1, root: { kind: 'unknown' } },
          } } })).toBe(false);
        }
      }
      const full = await readDefinition('widgets.catalog.list', true);
      expect(full.outputSchema).toBeDefined();
      expect(new Ajv({ strict: false }).compile(full.outputSchema!)({})).toBe(false);
    } finally { await client.close(); await runtime.mcp.close(); await daemon.close(); }
  });

  it('publishes client-compilable tools before the successor runner has a turn witness', async () => {
    const sessionId = 'c444444444444444444444444';
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => createTestMetadata(),
    });
    const client = new Client({ name: 'successor-runner-discovery', version: '1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      // The SDK compiles every advertised output schema, as the stdio bridge does.
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('action_spec_get');
      await expect(runtime.executeTool({ toolName: 'action_spec_get', args: { id: 'session.board.get' } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    } finally {
      await client.close();
      await runtime.mcp.close();
    }
  });

  it('re-attaches discoverable Happier MCP through the real planned runner restart and bridge factory', async () => {
    // Daemon IPC and process signalling are genuine external boundaries. All
    // restart guards, bridge resolution, MCP factories and SDK discovery stay real.
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const sessionId = 'c555555555555555555555555';
    const app = fastify();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
    const metadata = createTestMetadata({ machineId: 'machine-1', path: '/repo' });
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'successor-input-account', encryption: { type: 'legacy' as const, secret } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'e2ee', metadata: encodeBase64(encrypt(secret, 'legacy', metadata)),
    }) }));
    const admitted: Parameters<NonNullable<import('@/api/session/sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const machineAdmissionTransport = async (request: typeof admitted[number]) => {
      admitted.push(request);
      return { status: 'accepted' as const, localId: request.localId };
    };
    const session = {
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      getMetadataSnapshot: () => metadata,
      getPermissionMode: () => 'yolo' as const,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getServerFeaturesSnapshot: () => ({ status: 'ready' as const, provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {} }) }),
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: 4242, happySessionId: sessionId,
      processCommandHash: 'predecessor-command', processStartTimeMs: 12345,
      processCommand: 'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      vendorResumeId: 'claude-thread-1',
      spawnOptions: { directory: '/repo', resume: 'claude-thread-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } },
    };
    const launch = () => resolveRunnerMcpServers({
      session, credentials,
      accountCredentials: null, accountSettings: null, machineId: 'machine-1', directory: '/repo',
    });
    let bridge = await launch();
    const discover = async () => {
      const client = new Client({ name: 'restart-discovery', version: '1' }, { capabilities: {} });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(bridge.happierMcpServer.url)));
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_spec_get', 'session_board_item_upsert']));
        const refused = await client.callTool({ name: 'session_board_get', arguments: {} });
        expect(refused).toMatchObject({ isError: true });
        expect(refused.content).toContainEqual({ type: 'text', text: expect.stringContaining('target_unavailable') });
        // CLI is an independent Account producer, not the Session runner's
        // authority. Exercise its actual executor and E2EE Machine admission.
        const cli = createCliActionExecutorFromCredentials({ credentials, ...getTestServerBinding(),
          serverApiUrl: getTestServerBinding().serverUrl, machineAdmissionTransport,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
          resolveServerFeaturesSnapshot: session.getServerFeaturesSnapshot,
        });
        const sent = await cli.execute('session.message.send',
          { sessionId, message: 'successor input', localId: 'successor-input' },
          { surface: 'cli', actionCaller: { kind: 'host' } });
        expect(sent).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'successor-input' } });
        expect(admitted).toEqual([expect.objectContaining({ sessionId, targetMachineId: 'machine-1', localId: 'successor-input' })]);
        const content = admitted[0]?.content;
        if (content?.t !== 'encrypted') throw new Error('Expected protected E2EE input');
        expect(decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(content.c, 'base64')))).toMatchObject({
          content: { type: 'text', text: 'successor input' },
          meta: { happierProvenanceV1: { kind: 'cli' } },
        });
      } finally { await client.close(); }
    };
    try {
      const previousUrl = bridge.happierMcpServer.url;
      const result = await restartSessionRunnerOnCurrentRuntime({
        request: { sessionId, mode: 'if_stale', reason: 'daemon_restart_session_runners_command' },
        tracked,
        currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.2.11', entrypointVersion: '0.2.11' },
        requestRestart: input => requestPlannedRunnerRestart({
          ...input, deferral: { kind: 'none' }, restartRequestedPids: new Set(),
          pidToTrackedSession: new Map([[tracked.pid, tracked]]),
          isProcessSafeToSignal: async () => true,
          requestSignal: async request => {
            if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
            bridge.happierMcpServer.stop();
            bridge = await launch();
            return { status: 'requested' };
          },
        }),
      });
      expect(result).toMatchObject({ ok: true, status: 'restarted', sessionId });
      expect(bridge.happierMcpServer.url).not.toBe(previousUrl);
      expect(bridge.mcpServers.happier.args).toContain(bridge.happierMcpServer.url);
      await discover();
    } finally { bridge.happierMcpServer.stop(); restoreHttp(); await app.close(); }
  });

  it('keeps descriptive catalog reads at the bound Session host policy owner', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'c111111111111111111111111';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
    });
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
      ...catalogHostTurn,
    });
    try {
      await expect(runtime.executeTool({ toolName: 'action_spec_get', args: { id: 'memory.search' } }))
        .resolves.toEqual(expect.objectContaining({ ok: true,
          result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.search' }) }),
        }));
      const search = await runtime.executeTool({ toolName: 'action_spec_search', args: { query: 'memory', limit: 100 } });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        expect(result.actionSpecs.map((spec) => spec.id)).toContain('memory.search');
      }
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('discovers and posts a Session update through the Session agent MCP Action without a manager', async () => {
    const sessionId = 'c111111111111111111111119';
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const committed: unknown[] = [];
    // Home HTTP and the durable transcript append are the system boundaries.
    // MCP registration, discovery, Action policy and the publication owner stay real.
    const runtime = createHappierMcpServer(hostClient(sessionId, {
      getPermissionMode: () => 'default',
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } }, capabilities: {} }) }),
      enqueueSessionEventCommitted: async event => {
        committed.push(event);
        return { persisted: true, delivered: true, localId: 'session-update-original' };
      },
    }), {
      authorityScope: 'session', sessionCredentials: { token: 'session-token', encryption: null },
      actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
        accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
          approvalWaivedSurfaces: { 'session.update.post': ['agent'] } } }),
      }),
    });
    try {
      await withMcpClient(runtime, async client => {
        const read = async (name: string, args: Record<string, unknown>) => {
          const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
          const text = response.content.find(item => item.type === 'text');
          if (text?.type !== 'text') throw new Error('Missing MCP Action result');
          expect(response.isError, text.text).toBe(false);
          return JSON.parse(text.text);
        };
        const discovery = await read('action_spec_search', { query: 'session.update.post', limit: 10 });
        expect(discovery.actionSpecs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'session.update.post' })]));
        const result = await read('action_execute', { actionId: 'session.update.post', input: { summary: 'Ready for review' } });
        expect(result).toEqual({ sessionId, localId: 'session-update-original', persisted: true });
        expect(committed).toEqual([{ type: 'worker-report', summary: 'Ready for review' }]);
      });
    } finally {
      await daemon.close();
    }
  });

  it.each(['plain', 'e2ee'] as const)('uses live Session memory choice for direct tools, discovery and generic write admission (%s)', async (mode) => {
    let memoryEnabled = true;
    const actionsSettingsV1 = { v: 1, actions: {
      'memory.remember': { toolExposureModes: { agent: 'direct' } },
      'memory.update': { toolExposureModes: { agent: 'direct' } },
      'memory.forget': { toolExposureModes: { agent: 'direct' } },
    } };
    const sessionId = 'c222222222222222222222222';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, mode,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
    });
    const client = {
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
      ...catalogHostTurn,
    };
    const runtime = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
    const execute = (toolName: string, args: unknown) => runtime.executeTool({ toolName, args });
    try {
      expect(runtime.toolNames).toEqual(expect.arrayContaining(['memory_remember', 'memory_update', 'memory_forget']));
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toEqual(expect.objectContaining({
        ok: true, result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.remember' }) }),
      }));
      memoryEnabled = false;
      for (const id of ['memory.remember', 'memory.update', 'memory.forget'] as const) {
        await expect(execute('action_spec_get', { id })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute('action_execute', { actionId: id, input: {} })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute(id.replace('.', '_'), {})).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
      }
      const search = await execute('action_spec_search', { query: 'memory', limit: 100 });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        const ids = result.actionSpecs.map((spec) => spec.id);
        for (const id of ['memory.remember', 'memory.update', 'memory.forget']) expect(ids).not.toContain(id);
      }
      const refreshed = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
      try {
        for (const name of ['memory_remember', 'memory_update', 'memory_forget']) expect(refreshed.toolNames).not.toContain(name);
        expect(refreshed.toolNames).toContain('change_title');
      } finally { await refreshed.mcp.close(); }
      memoryEnabled = true;
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toMatchObject({
        ok: true, result: { actionSpec: { id: 'memory.remember' } },
      });
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('refuses catalog disclosure when bound Session metadata is unavailable without restricting unbound Account discovery', async () => {
    const sessionId = 'c333333333333333333333333';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => null });
    try {
      await expect(daemon.executor.execute('action.spec.get', { id: 'memory.remember' }, { surface: 'mcp' }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(daemon.getSessionReads()).toBe(0);
      for (const actionId of ['action.spec.get', 'action.spec.search'] as const) {
        await expect(daemon.executor.execute(actionId, actionId === 'action.spec.get' ? { id: 'memory.remember' } : { query: 'memory' },
          { surface: 'agent', defaultSessionId: sessionId, actionCaller: { kind: 'host' } }))
          .resolves.toEqual(expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }));
      }
    } finally { await daemon.close(); }
  });

  it('refuses native memory windows on credentialless Session-bound MCP before transport', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const requests: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async request => {
      requests.push(request);
      return { v: 1, snippets: [], citations: [], externalSnippets: [] };
    });
    const runtime = createHappierMcpServer({ sessionId: 'bound-session', rpcHandlerManager: manager,
      updateMetadata() {}, getServerBinding: getTestServerBinding,
      ...catalogHostTurn,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.get_window': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      expect(await runtime.executeTool({ toolName: 'memory_get_window', args: {
        machineId: 'machine-1', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
        sourceItemId: 'message',
      } })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(requests).toEqual([]);
    } finally { await runtime.mcp.close(); }
  });

  it.each(['mixed-corpus', 'documents-only', 'project'] as const)('keeps credentialless %s searches within the MCP-bound Session', async (selection) => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const queries: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (query: unknown) => {
      queries.push(query);
      return { v: 1, ok: true, documents: { state: 'ready' }, hits: [
        { sessionId: 'bound-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 },
        { sessionId: 'foreign-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'private transcript', score: 1 },
        { type: 'artifact', ref: { kind: 'doc', serverId: 'test-home', artifactId: 'doc-1' },
          revision: { headerVersion: 1, bodyVersion: 1 }, location: 'document', summary: 'private document', score: 1 },
      ] };
    });
    const runtime = createHappierMcpServer({
      sessionId: 'bound-session', rpcHandlerManager: manager, updateMetadata() {},
      getServerBinding: getTestServerBinding,
      ...catalogHostTurn,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.search': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      const result = await runtime.executeTool({ toolName: 'memory_search', args: {
        query: { v: 1, query: 'private', scope: selection === 'project'
          ? { type: 'project', projectRef: { serverId: 'test-home', projectKey: 'payments' } } : { type: 'global' }, mode: 'deep',
          corpora: selection === 'mixed-corpus' ? ['sessions', 'documents'] : ['documents'] },
      } });
      if (selection === 'project') {
        expect(result).toMatchObject({ ok: false, errorCode: 'memory_project_scope_unsupported' });
      } else expect(result).toEqual({ ok: true, result: {
        v: 1, ok: true, hits: selection === 'mixed-corpus' ? [{ sessionId: 'bound-session', seqFrom: 1, seqTo: 1,
          createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 }] : [], documents: { state: 'unavailable' },
      } });
      expect(queries).toHaveLength(selection === 'mixed-corpus' ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain('private transcript');
      expect(JSON.stringify(result)).not.toContain('private document');
    } finally { await runtime.mcp.close(); }
  });

  it('returns the daemon authority refusal for an advertised Account Action from a session-scoped runtime', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'session-account-authority';
    const runtime = createHappierMcpServer({
      sessionId,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getServerBinding: getTestServerBinding,
      getServerFeaturesSnapshot: () => ({
        status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-account', inputId: 'input-account', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
    }, {
      authorityScope: 'session',
      sessionCredentials: { token: 'restricted-session-token', encryption: null },
    });
    const result = await runtime.executeTool({ toolName: 'action_execute', args: {
      actionId: 'notifications.notify_me', input: { message: 'Session notification' },
    } });
    expect(JSON.stringify(result)).toContain('target_unavailable');
    expect(JSON.stringify(result)).not.toContain('action_disabled');
    expect(JSON.stringify(result)).not.toContain('content_unavailable');
  });

  it.each([
    ['plain', false, 1, 2], ['e2ee', false, 1, 2], ['plain', true, 1, 2], ['e2ee', true, 1, 2],
    ['plain', false, 3, 0],
  ] as const)('admits a %s cross-session send from the real MCP host (background run: %s; starter depth: %s; turn depth: %s)', async (mode, backgroundRun, starterDepth, turnDepth) => {
    // Daemon IPC is a genuine external boundary: the daemon contributes no plugin tools here.
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const origin = 'http://cross-session-home.test';
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'cross-session-account' })).toString('base64url')}.fixture`,
      encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(origin, () => resolveAccountSettingsScopeKey(credentials)),
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
    });
    const targetId = 'target-session-b';
    const targetMetadata = {
      sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag: deriveSessionCreationTagV1({
          callerCreationNamespace: 'mcp-host-admission-test', creationKey: targetId,
        }),
        recipe: {
          execution: { machineId: 'target-machine', directory: { kind: 'path', path: '/repo' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null,
          agentModeId: null, configuration: null, connectedServices: null,
          capabilitySelection: null, transcriptStorage: null, terminal: null,
          agentSessionStartupInstructionsMarkerV1: null, checkout: null,
        },
      }),
    };
    const admitted: Parameters<NonNullable<import('@/api/session/sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const features = { status: 'ready' as const, provenance: 'authenticated' as const, features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
    app.get('/v1/account/settings', async () => ({ settings: null, settingsVersion: 0 }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: targetId, active: true, encryptionMode: mode,
      metadata: mode === 'plain' ? JSON.stringify(targetMetadata) : encodeBase64(encrypt(secret, 'legacy', targetMetadata)),
    }) }));
    app.get('/v1/projects', async () => ({ projects: [] }));
    app.get(ACP_CATALOG_ROWS_ROUTE_V1, async () => ({ status: 'absent' }));
    const readRoleSources = createRoleSourceReader({});
    const sessionRoles = createSessionRoleContext({ readMetadata: () => createTestMetadata(), readRoleSources,
      readOrganization: async () => ({}),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    });
    // Like ApiSessionClient, this carrier owns the transport on its prototype.
    // Only HTTP and authenticated Machine admission are substituted boundaries.
    class SessionCarrier {
      sessionId = 'source-session-a';
      rpcHandlerManager = new RpcHandlerManager({ scopePrefix: this.sessionId, encryptionMode: 'plain' });
      updateMetadata() {}
      async enqueueSessionEventCommitted() { return { persisted: true, delivered: true }; }
      getServerBinding() { return { serverId: 'cross-session-home', serverUrl: origin }; }
      getServerFeaturesSnapshot() { return features; }
      getPermissionMode() { return 'yolo' as const; }
      getWorkDepth() { return starterDepth; }
      getHostTurnWorkDepth(turnId: string) { return turnId === 'source-turn-a' ? turnDepth : undefined; }
      getBackendTarget() { return { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const; }
      getSessionRoleContext() { return sessionRoles; }
      readRoleSources() { return readRoleSources(); }
      getCurrentSessionLocation() { return { machineId: 'source-machine', path: '/repo' }; }
      getActiveTurnPermissionWitness() { return { turnId: 'source-turn-a', causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }; }
      getMachineAdmissionTransport() {
        return async (request: typeof admitted[number]) => {
          admitted.push(request);
          return { status: 'accepted' as const, localId: request.localId };
        };
      }
    }
    const source = new SessionCarrier();
    let stop: (() => void) | undefined;
    const client = new Client({ name: 'cross-session-test', version: '1' }, { capabilities: {} });
    // The real daemon has one active Home. Session reads resolve that process
    // endpoint; the fixture must initialize it as well as the Session binding.
    const releaseHome = publishServerHttpRuntimeOrigin(origin, 'https');
    try {
      const runtime = backgroundRun ? null : createHappierMcpServer(source, { credentials });
      if (backgroundRun) {
        const signal = new AbortController().signal;
        const readRunWitness = (): import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness => ({
          inputId: 'run-input', turnId: 'run-turn', userMessageSeq: 1, userMessageSeqs: [1],
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
        });
        const binding = await resolveRunnerMcpServers({
          session: source, credentials, accountSettings: accountSettingsParse({}),
          machineId: 'source-machine', directory: '/repo', resolvedMcpServers: {},
          executionRun: {
            runId: 'background-run-a', workDepth: 4, cwd: '/repo', signal, isCurrent: () => true,
            readActiveTurnAdmissionWitness: readRunWitness,
            // Provider/runtime boundary: the Run owns its live occurrence and turn.
            readCurrentRunOccurrence: () => ({
              runId: 'background-run-a', sidechainId: 'run-sidechain', occurrenceId: 'run-occurrence',
              runtimeLifetimeSignal: signal, isCurrent: () => true, readActiveTurnAdmissionWitness: readRunWitness,
            }),
          },
        });
        stop = binding.happierMcpServer.stop;
        await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      }
      const args = { actionId: 'session.message.send', input: { sessionId: targetId, message: 'Hello from A', localId: 'u1-send' } };
      const result = runtime
        ? await runtime.executeTool({ toolName: 'action_execute', args })
        : await client.callTool({ name: 'action_execute', arguments: args });
      expect(JSON.stringify(result)).toContain('accepted');
      expect(admitted).toHaveLength(1);
      const request = admitted[0]!;
      expect(request.targetMachineId).toBe('target-machine');
      const content = request.content.t === 'plain' ? request.content.v : decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(request.content.c, 'base64')));
      // Protected admission facts travel inside the sealed record, not as a
      // caller-controlled field on the Machine transport envelope.
      const record = z.object({ meta: z.object({ happierInputRequestV1: SessionInputRequestSchema }) }).parse(content);
      expect(record.meta.happierInputRequestV1.sourceSession).toMatchObject({
        sourceSessionId: source.sessionId, sourceTurnId: backgroundRun ? 'run-turn' : 'source-turn-a',
      });
      expect(content).toMatchObject({
        content: { type: 'text', text: 'Hello from A' },
        meta: { happierProvenanceV1: {
          v: 1, kind: 'happierSession', sourceSessionId: source.sessionId, via: 'mcp',
          callerDepth: backgroundRun ? 4 : Math.max(starterDepth, turnDepth),
        } },
      });
      if (backgroundRun) {
        const start = await client.callTool({ name: 'action_execute', arguments: { actionId: 'execution.run.start', input: {
          sessionId: source.sessionId, intent: 'review', backendTarget: source.getBackendTarget(), instructions: 'Review the change',
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        } } });
        // Parent depth is 1, but this Run is at the limit (4): the real MCP ->
        // Action -> admission path must not start a child at the parent's depth.
        expect(JSON.stringify(start)).toContain('work_depth_exceeded');
      }
    } finally {
      await client.close();
      stop?.();
      releaseHome();
      restore();
      await app.close();
    }
  });

});

describe('createHappierMcpServer', () => {
  // These existing fixtures replace imported collaborators with per-case mocks.
  // Keep their module isolation; unmocking alone cannot change cached imports.
  beforeEach(() => {
    vi.resetModules();
    resetEnvironment();
  });
  afterEach(unmockCaseModules);

  it('wires Account-server, Pool, and Follow owners into the authenticated in-session Agent host', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown> } = {};
    const accountInputs: Array<Record<string, unknown>> = [];
    const followInputs: Array<Record<string, unknown>> = [];
    const machinePoolAction = vi.fn();
    const homeDomainAction = vi.fn();
    const sessionFollowGet = vi.fn();
    const resolveServerFeaturesSnapshot = vi.fn(() => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_stable-home-identity' } },
      },
    }));

    vi.doMock('@/api/accountServerActionDeps', () => ({
      createAccountServerActionDeps: (input: Record<string, unknown>) => {
        accountInputs.push(input);
        return { machinePoolAction, homeDomainAction };
      },
    }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({
      createSessionFollowActionDeps: (input: Record<string, unknown>) => {
        followInputs.push(input);
        return { sessionFollowGet };
      },
    }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'sess_account_actions_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerBinding: () => ({
        serverId: 'session-home-b',
        serverUrl: 'https://session-home-b.example.test',
      }),
      getServerFeaturesSnapshot: resolveServerFeaturesSnapshot,
    } as any, { credentials });

    expect(accountInputs).toHaveLength(1);
    expect(followInputs).toHaveLength(1);
    expect(accountInputs[0]).toMatchObject({ token: credentials.token, credentials });
    expect(accountInputs[0]).toMatchObject({
      serverId: 'session-home-b',
      serverHttpBaseUrl: 'https://session-home-b.example.test',
    });
    expect((accountInputs[0]?.resolveServerFeaturesSnapshot as (() => unknown))()).toEqual(
      resolveServerFeaturesSnapshot.mock.results[0]?.value,
    );
    expect(followInputs[0]).toMatchObject({
      token: credentials.token,
      prepareSourceKeyAfterSet: expect.any(Function),
    });
    expect(accountInputs[0]?.serverId).toEqual(followInputs[0]?.serverId);
    expect(accountInputs[0]?.serverHttpBaseUrl).toEqual(followInputs[0]?.serverHttpBaseUrl);
    expect(captured.params).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(captured.params?.resolveServerFeaturesSnapshot).toBeTypeOf('function');
    expect(accountInputs[0]).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(followInputs[0]).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(captured.overrides).toMatchObject({
      machinePoolAction,
      homeDomainAction,
      sessionFollowGet,
    });
  });

  it('keeps restricted runtime credentials Session-scoped while advertising daemon-owned Account Actions', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown>; enabled?: (id: string) => boolean } = {};
    const accountOwner = vi.fn(() => ({}));
    const followOwner = vi.fn(() => ({}));
    const sessionList = vi.fn();
    vi.doMock('@/api/accountServerActionDeps', () => ({ createAccountServerActionDeps: accountOwner }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({ createSessionFollowActionDeps: followOwner }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: {} })) } };
      },
    }));
    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        captured.enabled = params.deps.isActionEnabled;
        return { toolNames: [] };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const sessionCredentials = { token: 'restricted-session-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'restricted-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      sessionCredentials,
      credentials: null,
      authorityScope: 'session',
      sessionList,
    });

    expect(accountOwner).not.toHaveBeenCalled();
    expect(followOwner).not.toHaveBeenCalled();
    expect(captured.params).toMatchObject({ token: sessionCredentials.token });
    expect(captured.params).not.toHaveProperty('credentials');
    expect(captured.overrides?.sessionList).toBe(sessionList);
    expect(captured.enabled?.('session.title.set')).toBe(true);
    // Tool visibility is shared policy, while the daemon capability owns
    // Account authorization (the real refusal is exercised above).
    expect(captured.enabled?.('account.apiTokens.list')).toBe(true);
    expect(captured.enabled?.('machines.list')).toBe(true);
  });

  it('opens a Session-scoped runtime\'s own E2EE Board with its Session material and no Account credentials', async () => {
    const { default: fastify } = await import('fastify');
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    const { FeaturesResponseSchema, projectSessionAccessCapabilitiesV1 } = await import('@happier-dev/protocol');
    const { sealSessionStoredContent } = await import('@/session/transport/encryption/sessionStoredContentCodec');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    // The only boundary replaced is the Home's HTTP transport.
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://runner-home.test' });
    const sessionKey = new Uint8Array(32).fill(41);
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' as const } };
    const rawSession = (id: string) => ({
      id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'e2ee', metadata: 'opaque', metadataVersion: 1, dataEncryptionKey: null,
      agentState: null, agentStateVersion: 0,
      effectiveAccess: {
        v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
      },
      responsibleAccountId: null, responsibleAccount: null,
    });
    const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
    app.get('/v2/sessions/:sessionId', async (request) => ({
      session: rawSession((request.params as { sessionId: string }).sessionId),
    }));
    app.get('/v2/sessions/:sessionId/system-records/record', async () => ({
      record: {
        id: 'layout.v1:layout',
        address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
        content: sealSessionStoredContent({ ...crypto, payload: layout }),
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    }));
    app.get('/v2/sessions/:sessionId/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));

    const runtime = createHappierMcpServer({
      sessionId: 'runner-session',
      getServerBinding: () => ({ serverId: 'runner-home', serverUrl: 'http://runner-home.test' }),
      ...catalogHostTurn,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      // The live Session client already holds this Session's key.
      getStoredContentEncryptionContext: () => crypto,
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            // Conversations depend on Session sharing.
            sessions: { enabled: true, board: { enabled: true }, conversations: { enabled: true } },
            sharing: { session: { enabled: true } },
          },
          capabilities: {},
        }),
      }),
    } as any, {
      sessionCredentials: { token: 'runner-session-token', encryption: null },
      credentials: null,
      authorityScope: 'session',
    });

    try {
      const board = await runtime.executeTool({ toolName: 'session_board_get', args: {} });
      expect(JSON.stringify(board)).toContain('"title":"Overview"');
      expect(JSON.stringify(board)).not.toContain('not_authenticated');

      // The material answers only for the bound Session: another E2EE Session
      // stays closed instead of borrowing it or degrading to Plain.
      const foreign = await runtime.executeTool({
        toolName: 'session_board_get',
        args: { sessionId: 'other-session' },
      });
      expect(JSON.stringify(foreign)).not.toContain('"title":"Overview"');
    } finally {
      restore();
      await app.close();
    }
  });

  it('returns toolNames aligned with current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).not.toContain('review_start');
    expect(toolNames).not.toContain('subagents_plan_start');
    expect(toolNames).toContain('action_spec_search');
  });

  it('advertises server-backed Session Actions only when the exact Home enables them and the runtime is authenticated', async () => {
    const capturedEnablement: Array<(id: string) => boolean> = [];

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        capturedEnablement.push(params.deps.isActionEnabled);
        return { toolNames: [] };
      },
    }));

    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    const createClient = (boardEnabled: boolean, conversationsEnabled: boolean) => ({
      sessionId: `sess_server_backed_action_availability_${boardEnabled}_${conversationsEnabled}`,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: {
              enabled: true,
              board: { enabled: boardEnabled },
              conversations: { enabled: conversationsEnabled },
            },
            sharing: { enabled: true, session: { enabled: true } },
          },
          capabilities: {},
        }),
      }),
    });

    createHappierMcpServer(createClient(false, false) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials: null });

    expect(capturedEnablement).toHaveLength(3);
    expect(capturedEnablement[0]?.('session.board.layout.update')).toBe(false);
    expect(capturedEnablement[1]?.('session.board.layout.update')).toBe(true);
    expect(capturedEnablement[2]?.('session.board.layout.update')).toBe(false);
    expect(capturedEnablement[0]?.('discussion.list')).toBe(false);
    expect(capturedEnablement[1]?.('discussion.list')).toBe(true);
    expect(capturedEnablement[2]?.('discussion.list')).toBe(false);
    expect(capturedEnablement[0]?.('session.list')).toBe(true);
  });

  it('uses account action settings for the in-session MCP tool registry when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_account_settings_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient, {
      sessionCredentials: { token: 'reviewed-session-policy', encryption: null },
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: {
                agent: 'direct',
              },
            },
          },
        },
      },
    } as any);

    expect(toolNames).toContain('session_list');
  });

  it('reads current account action settings when registered session-agent MCP tools run', async () => {
    let settings = accountSettingsParse({});
    await withTitleHost('c111111111111111111111112', () => settings, async fixture => withMcpClient(fixture.runtime, async client => {
      settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
        'session.title.set': { enabled: false },
      } } });
      const denied = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Denied' } }));
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('action_disabled');
      expect(fixture.persistedWrites()).toBe(0);
      settings = accountSettingsParse({});
      const accepted = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Allowed' } }));
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'Allowed' } });
    }));
  });

  it('uses account action settings for in-session MCP approval policy when provided', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { approvalRequiredSurfaces: ['agent'] },
    } } });
    await withTitleHost('c111111111111111111111113', () => settings, async fixture => {
      const result = await fixture.runtime.executeTool({ toolName: 'change_title', args: { title: 'Unapproved title' } });
      expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(fixture.persistedWrites()).toBe(0);
    });
  });

  it('executes native Agent tool calls through the live Session authority and policy owner', async () => {
    const sessionId = 'sess_native_agent_tool_1';
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
    } as const;
    const operations: Array<Parameters<Parameters<typeof createSessionDaemonAuthorityFixture>[0]['execute']>[0]> = [];
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId, agentStartPolicy: accountSettingsParse({}), execute: async operation => {
      operations.push(operation);
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    } });
    const runtime = createHappierMcpServer(hostClient(sessionId, {
      getPermissionMode: () => 'yolo',
      getActiveTurnPermissionWitness: () => ({ turnId: 'native-turn', causalPermissionAuthority }),
      getActiveTurnAdmissionWitness: () => ({
        turnId: 'native-turn', inputId: 'native-input', userMessageSeq: 1, userMessageSeqs: [1],
        callerPermissionMode: 'yolo', causalPermissionAuthority,
        agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      }),
    }), { requiredDirectActionIds: ['session.transcript.get'], sessionInputVia: 'action' });
    try {
      await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'session.spawn_new', input: { prompt: 'Spawn a helper' },
      }, toolCallId: 'native_tool_call_1' });
      await runtime.executeTool({ toolName: 'session_transcript_get', args: { limit: 10 },
        toolCallId: 'native_tool_call_2' });
      expect(operations).toMatchObject([
        { kind: 'action.execute', actionId: 'session.spawn_new', input: { prompt: 'Spawn a helper' },
          toolCallId: 'native_tool_call_1', surface: 'agent', witness: { turnId: 'native-turn',
            callerPermissionMode: 'yolo', causalPermissionAuthority,
            agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } },
        { kind: 'action.execute', actionId: 'session.transcript.get',
          input: { sessionId, limit: 10 }, toolCallId: 'native_tool_call_2', surface: 'agent' },
      ]);
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('passes the live session backend target into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_backend_target_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ path: '/repo/current' }),
      getBackendTarget: () => ({
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.getCurrentSessionBackendTarget()).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
    });
  });

  it('suppresses retained memory hits outside the session bound to an unauthenticated MCP client', async () => {
    const captured: { overrides?: any } = {};
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: async () => ({
          v: 1,
          ok: true,
          hits: [
            {
              sessionId: 'bound-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'readable',
              score: 1,
            },
            {
              sessionId: 'revoked-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'retained after revocation',
              score: 0.5,
            },
          ],
        }),
      },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemorySearch({
      query: { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'hints' },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      hits: [expect.objectContaining({ sessionId: 'bound-session' })],
    }));
  });

  it('rejects an unauthenticated memory window outside the MCP-bound Session before daemon RPC', async () => {
    const captured: { overrides?: any } = {};
    const invokeLocal = vi.fn(async () => ({ v: 1, snippets: [], citations: [] }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemoryGetWindow({
      sessionId: 'other-session',
      seqFrom: 1,
      seqTo: 2,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('passes live session location into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_location_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      }),
      getCurrentSessionLocation: () => ({
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.rawSession).toEqual({
      metadata: {
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      },
      path: '/repo/current',
      host: 'leeroy-mbp',
      machineId: 'machine-1',
    });
  });





  it('dispatches registered tools using the agent surface (internal MCP)', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { disabledSurfaces: ['mcp'] },
    } } });
    await withTitleHost('c111111111111111111111114', () => settings, async fixture => withMcpClient(fixture.runtime, async client => {
      const accepted = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Agent title' } }));
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'Agent title' } });
    }));
  });

  it('routes change_title through the action executor (so approvals/enablement apply)', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { enabled: false },
    } } });
    await withTitleHost('c111111111111111111111115', () => settings, async fixture => {
      const result = await fixture.runtime.executeTool({ toolName: 'change_title', args: { title: 'Must not commit' } });
      expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(fixture.persistedWrites()).toBe(0);
    });
  });

  it('commits a credentialless Session title through its daemon once without a redundant local write', async () => {
    await withTitleHost('c111111111111111111111116', () => accountSettingsParse({}), async fixture => {
      const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      if (!path) throw new Error('Expected the Session daemon authority path');
      const authority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: 'c111111111111111111111116',
      });
      if (!authority) throw new Error('Expected current Session daemon authority');
      const probe = await fetch(`http://127.0.0.1:${authority.httpPort}/`, { method: 'HEAD' });
      expect(probe.status).toBe(404);
      await withMcpClient(fixture.runtime, async client => {
        const result = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'New title' } }));
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const text = result.content.find(block => block.type === 'text');
        expect(text?.type === 'text' ? JSON.parse(text.text) : null).toMatchObject({ success: true, title: 'New title' });
      });
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'New title' } });
      expect(fixture.persistedWrites()).toBe(1);
      expect(fixture.localWrites()).toBe(0);
    });
  });

});
