import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi, onTestFinished } from 'vitest';
import { FeaturesResponseSchema, SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ConnectedAccountSessionModelRefV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionAutoFollowPreferencesResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import * as daemonControlHttp from '@/daemon/controlHttp';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { resolveDaemonExecutionRunBrokerAuthority } from '@/daemon/executionRunBrokerAuthority';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createNativeAgentRuntimeSessionPlanFixture, createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.composed.testkit';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSnapshotSessionPendingTransport } from '@/rpc/handlers/executionRuns/sessionRunnerSnapshot.fixture';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import type { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import * as sessionRpcTransport from '@/session/transport/rpc/sessionRpc';
import { logger } from '@/ui/logger';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const boundary = vi.hoisted(() => ({ control: null as unknown }));
// Capture the fixture's installed control services and start the real loopback router.
vi.mock('@/daemon/controlServer', async original => {
  const actual = await original<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: (input: Parameters<typeof actual.startDaemonControlServer>[0]) => {
    boundary.control = input;
    return actual.startDaemonControlServer(input);
  } };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('answers an omitted-selection Run from a foreign recipient’s applied Team binding using live requester authority', async () => {
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  vi.stubEnv('HAPPIER_FEATURE_PROVIDERS__ENABLED', '1');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs,providers');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
  const agentId = 'acme.project-launch/agent';
  const target = { kind: 'builtInAgent' as const, agentId };
  const teamSelection = { kind: 'team_credential_provider_model' as const, teamId: 'shared-team', resourceId: 'shared-resource',
    expectedResourceRevision: 3, deliveryMode: 'brokered' as const, agentTargetKey: `agent:${agentId}`, modelId: 'shared-model' };
  const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({ features: { providers: { enabled: true } }, capabilities: {} }) };
  const runAuthority: unknown[] = [];
  const opens: unknown[] = [];
  const daemonFailures: unknown[] = [];
  const authorityDiagnostics = vi.spyOn(logger, 'infoFile');
  let fixture: Awaited<ReturnType<typeof createInstalledProjectAgentDaemonFixture>>;
  const openTeamCredentialProviderBinding: NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']> = async input => {
    if (input.consumer?.kind === 'execution_run') {
      const authority = await resolveDaemonExecutionRunBrokerAuthority({ v: 1, requestNonce: '11111111-1111-4111-8111-111111111111',
        serverIdentityId: 'session-home', requestingAccountId: 'requester', workerMachineId: 'machine',
        executionRunId: input.consumer.executionRunId, expectedOccurrenceId: null }, {
        currentIdentity: { serverIdentityId: 'session-home', accountId: 'custodian', machineId: 'machine' },
        listMarkers: listExecutionRunMarkers, isPidAlive: pid => pid === process.pid,
        resolveLiveAuthority: async request => {
          if (request.sessionId === null) return { status: 'not_current', reason: 'detached' };
          return await fixture.daemon.resolveExecutionRunLiveBrokerAuthority({ ...request, sessionId: request.sessionId });
        },
      });
      runAuthority.push(authority);
      if (authority.status !== 'current') throw Object.assign(new Error('execution_run_authority_unavailable'), { code: 'execution_run_authority_unavailable' });
      expect(authority).toMatchObject({ requestingAccountId: 'requester', parentSessionId: fixture.sessionId,
        teamCredentialProviderModel: { resourceId: teamSelection.resourceId, deliveryMode: 'brokered' } });
    }
    opens.push(input);
    return { providerBinding: {
      source: { kind: 'team_resource' as const, resourceId: 'shared-resource', resourceRevision: 3 },
      model: { id: input.modelId, name: input.modelId },
      upstream: { protocol: 'openai-responses' as const, normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' as const },
      materialization: { v: 1 as const, kind: 'spawnEnv' as const },
    }, environmentOverlay: [{ name: 'FOREIGN_TEAM_MODEL', value: input.modelId, source: 'provider' as const }],
      additionalRedactionValues: [], cleanup: async () => {} };
  };
  fixture = await createInstalledProjectAgentDaemonFixture(() => boundary.control as Parameters<typeof startDaemonControlServer>[0],
    undefined, true, { manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{
      id: 'agent', title: 'Foreign Team native Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      providerRequirements: { acceptsProtocols: ['openai-responses'], required: { streaming: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['FOREIGN_TEAM_MODEL'] },
        materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true },
    }] } }), files: {
      'agent.mjs': `import { appendFile } from 'node:fs/promises'; import { join } from 'node:path';
        export function factory() { return { sessions: { async open(request) {
          let emit; let sequence = 0;
          await appendFile(join(request.cwd, 'foreign-native-opens.jsonl'), JSON.stringify({ model: request.launchEnvironment?.values?.FOREIGN_TEAM_MODEL }) + '\\n');
          return { async send(input) {
            const event = body => emit({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...body });
            event({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            event({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            event({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant',
              text: JSON.stringify({ summary: 'FOREIGN_TEAM_NATIVE_CHILD_ANSWER', deliverables: [{ id: 'answer', title: 'Inherited Team child answer' }] }) });
            event({ kind: 'turn-complete', turnId: input.delivery.turnId });
            return { status: 'admitted' };
          }, async cancel(request) { return { status: 'requested', turnId: request.turnId }; },
            watch(listener) { emit = listener; return { dispose() {} }; }, async dispose() {} };
        } } }; }`,
      'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) {
        api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 },
          providerBinding: { v: 1, adapterVersion: 1, prepare() { return { v: 1, materialization: 'spawnEnv' }; },
            materialize(input) { return { v: 1, kind: 'spawnEnv', env: [{ name: 'FOREIGN_TEAM_MODEL', value: input.binding.selection.model.id, source: 'provider' }] }; } } }); }`,
    } }, undefined, { openTeamCredentialProviderBinding, machineAccess: { custodianAccountId: 'custodian', role: 'use' },
      resolveServerFeaturesSnapshot: () => features });
  const { f, daemon, sessionId, requester, tracked, retainedAgent, cwd } = fixture;
  const homeGet = vi.mocked(axios.get).getMockImplementation();
  if (!homeGet) throw new Error('Missing installed Home HTTP boundary');
  const providerModelSelection = { agentTargetKey: teamSelection.agentTargetKey, modelId: teamSelection.modelId };
  const acceptedTeamCredentialBinding = { v: 1 as const, slot: { kind: 'provider_model' as const },
    resourceId: teamSelection.resourceId, expectedResourceRevision: teamSelection.expectedResourceRevision,
    deliveryMode: teamSelection.deliveryMode, teamId: teamSelection.teamId, providerModelSelection };
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === SESSION_FOLLOW_HTTP_PATHS_V1.preferences) return { status: 200,
      data: SessionAutoFollowPreferencesResponseSchema.parse({
        ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1,
      }) };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200,
      data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }) };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'absent' } };
    const response = await homeGet(url, options);
    if (path !== `/v2/sessions/${sessionId}` || response.status !== 200) return response;
    const { session } = V2SessionByIdResponseSchema.parse(response.data);
    return { ...response, data: { ...response.data,
      session: { ...session, acceptedTeamCredentialBinding } } };
  });
  const originalTitle = process.title;
  process.title = join(f.directory, 'src', 'index.ts');
  onTestFinished(() => { process.title = originalTitle; });
  const identity = await readProcessIdentityByPid(process.pid);
  if (!identity?.processStartTimeMs) throw new Error('Missing runner OS identity');
  const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(identity.command);
  if (entrypoint.status !== 'known') throw new Error('Missing runner entrypoint');
  Object.assign(fixture.runner, { processStartTimeMs: identity.processStartTimeMs,
    processCommandHash: hashProcessCommand(identity.command), snapshotIdentity: entrypoint.comparableId });
  Object.assign(tracked, { processStartTimeMs: fixture.runner.processStartTimeMs, processCommandHash: fixture.runner.processCommandHash,
    spawnOptions: { directory: cwd, backendTarget: target,
      modelSelection: { v: 1, updatedAt: 1, ref: { ...providerModelSelection, providerConnectionId: null } },
      teamCredentialBindings: [acceptedTeamCredentialBinding] } });
  const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: f.directory, publicReleaseRing: configuration.publicReleaseRing });
  tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityPath;
  await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId, startedBy: 'daemon',
    processStartTimeMs: fixture.runner.processStartTimeMs, processCommandHash: fixture.runner.processCommandHash,
    requesterWorkAttributionV1: tracked.requesterWorkAttributionV1,
    runnerAgentSourceCustodyV1: retainedAgent.sourceCustody, agentRuntimeDaemonServiceAuthorityFilePath: authorityPath });
  const issued = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path: authorityPath, sessionId, runner: fixture.runner, retainedAgent, httpPort: daemon.controlPort });
  tracked.agentRuntimeDaemonServiceCapabilityHash = issued.capabilityDigest;
  writeDaemonState({ pid: process.pid, httpPort: daemon.controlPort, controlToken: daemon.controlToken,
    startedAt: Date.now(), startedWithCliVersion: '0.0.0' });
  vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, authorityPath);
  const readControlHttp = daemonControlHttp.readDaemonControlHttpResponse;
  vi.spyOn(daemonControlHttp, 'readDaemonControlHttpResponse').mockImplementation(async input => {
    const response = await readControlHttp(input);
    if (input.httpPort === daemon.controlPort && input.path === '/agent-runtime/session/services/v1') {
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(input.body);
      const body = JSON.parse(response.body);
      if (!body.ok) daemonFailures.push({ operation: request.operation.kind, response: body });
    }
    return response;
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: f.directory, publicReleaseRing: configuration.publicReleaseRing,
    authorityFilePath: authorityPath, expectedSessionId: sessionId });
  if (!source) throw new Error('Missing retained native source');
  onTestFinished(() => source.retire?.());
  const metadata = createTestMetadata({ path: cwd, machineId: 'machine', runtimeDescriptorV1: { v: 1, agentId, agent: {} },
    mcpSelectionV1: { v: 1, managedServersEnabled: false, happierToolsEnabled: false,
      forceIncludeServerIds: [], forceExcludeServerIds: [] } });
  let manager: ExecutionRunHostBridgeContract | undefined;
  const session = createMutableApiSessionClientFixture({ sessionId, metadata, overrides: {
    ...createSnapshotSessionPendingTransport('requester'),
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
    setExecutionRunWorkerUpdateSource: value => { manager = value; },
  } });
  const agent = fixture.plugin.registry.contributes.agentDefinitionsById.get(agentId);
  if (!agent) throw new Error('Missing admitted Agent declaration');
  const permissions = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Foreign Team]' });
  const plan = await createNativeAgentRuntimeSessionPlanFixture({ createRuntime: source.createRuntime, identity: source.identity,
    backend: projectEngineRuntimeContributionFromAgent(agent, agentId), agent,
    createSessionHostServiceOwners,
    prepareTeamCredentialProviderBinding: source.prepareTeamCredentialProviderBinding,
    createInvocationServices: input => source.createInvocationServices({ pluginId: source.identity.pluginId,
      pluginVersion: source.identity.pluginVersion, agentId, occurrenceId: source.identity.occurrenceId,
      ...input, isOccurrenceCurrent: source.identity.isCurrent }),
    authorizeNewTurn: source.authorizeNewTurn, attestSessionOpen: source.attestSessionOpen, retireRuntimeSource: source.retire,
    sessionInput: buildPluginSessionBindingInput({ ...tracked.spawnOptions, credentials: f.bootstrap.credentials, directory: cwd, backendTarget: target }),
  });
  const parent = await plan.config.createSessionRuntime({ directory: cwd, metadata, machineId: 'machine', session, transcriptSession: session,
    messageBuffer: {}, messageQueue: new MessageQueue2<{ permissionMode: string }, { text: string }>(mode => mode.permissionMode),
    mcpServers: {}, permissionHandler: permissions,
    getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false } as never).catch(error => {
      throw new Error(JSON.stringify({ daemonFailures,
        authority: authorityDiagnostics.mock.calls.filter(([message]) => String(message).includes('Daemon service authority refused')),
        cause: error instanceof Error ? error.message : String(error) }));
    });
  onTestFinished(async () => { await (parent.operations as unknown as { resetOrDisposeRuntime(): Promise<void> }).resetOrDisposeRuntime(); });
  const { nativeRuntime } = resolveHostSessionRuntimeFactoryResult(parent);
  const nativeParent = nativeRuntime as { prepareRunTeamCredentialProviderBinding: NonNullable<SessionRuntimeControls['prepareRunTeamCredentialProviderBinding']>;
    readAppliedTeamCredentialModel(): typeof teamSelection | null };
  expect(nativeParent.readAppliedTeamCredentialModel()).toEqual(teamSelection);
  const connectedAccountSelection = ConnectedAccountSessionModelRefV2Schema.parse({
    source: 'connected_account', agentTargetKey: teamSelection.agentTargetKey, modelId: teamSelection.modelId,
    purpose: { consumer: { pluginId: 'acme.project-launch', localId: 'provider' }, purpose: 'model-inference' },
    endpointTemplateId: 'responses',
  });
  let parentUsesConnectedAccount = false;
  const controls: Partial<SessionRuntimeControls> = {};
  applySessionRuntimeControls(controls, {
    prepareRunTeamCredentialProviderBinding: nativeParent.prepareRunTeamCredentialProviderBinding.bind(nativeParent),
    readPermissionHandler: () => permissions,
    resolveAccountSettingsSnapshot: async () => requester.readAccountSettingsSnapshot(),
    readAppliedChildSelection: async () => {
      if (parentUsesConnectedAccount) return {
        status: 'applied', backendTarget: target, modelId: connectedAccountSelection.modelId,
        modelSelection: connectedAccountSelection, connectedServices: null,
      };
      const applied = nativeParent.readAppliedTeamCredentialModel();
      return applied ? { status: 'applied', backendTarget: target, modelId: applied.modelId,
        teamCredentialModel: applied, connectedServices: null } : { status: 'unavailable' };
    },
  });
  const registration = registerSessionClientRuntimeHandlers({ serverId: 'session-home', serverUrl: 'https://session-home.test',
    rpcHandlerManager: session.rpcHandlerManager, token: f.bootstrap.credentials.token, readOwnerAccountCredentials: async () => f.bootstrap.credentials,
    metadataPath: cwd, metadata, sessionId, session, getSessionMetadata: () => session.getMetadataSnapshot(), sessionRuntimeControls: controls,
    getServerFeaturesSnapshot: () => features,
    enqueueSessionUserMessage: () => {}, enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
    sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }), getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
    persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
  });
  onTestFinished(async () => { await manager?.dispose?.(); await registration.dispose(); });
  const sessionRpc = vi.spyOn(sessionRpcTransport, 'callSessionRpc').mockImplementation(async request => {
    expect(request.token).toBe(requester.bootstrap.credentials.token);
    return await session.rpcHandlerManager.handleRequest({ method: request.method, params: request.request, callerAuthority: 'present_user' });
  });
  const startInherited = (instructions: string) => session.rpcHandlerManager.handleRequest({ method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
    callerAuthority: 'present_user', params: { intent: 'delegate', backendTarget: target, instructions,
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } });

  // Supply a qualified readback through the same parent boundary. The requester
  // runner must refuse a Connected Account route for which it has no launch service.
  const nativeOpensBeforeRefusal = await readFile(join(cwd, 'foreign-native-opens.jsonl'), 'utf8');
  parentUsesConnectedAccount = true;
  const refused = ExecutionRunStartResponseSchema.parse(
    await startInherited('Answer using the inherited Connected Account model.'),
  );
  await vi.waitFor(() => expect(manager?.getPublic(refused.runId)).toMatchObject({
    status: 'failed',
    resolvedSelection: { source: 'inherited', modelSelection: connectedAccountSelection },
    error: { code: 'provider_authorization_changed' },
  }));
  expect(await readFile(join(cwd, 'foreign-native-opens.jsonl'), 'utf8')).toBe(nativeOpensBeforeRefusal);
  parentUsesConnectedAccount = false;

  const started = await startInherited('Answer using the inherited Team model.');
  expect(started, JSON.stringify({ started, daemonFailures })).toMatchObject({ runId: expect.any(String) });
  const run = ExecutionRunStartResponseSchema.parse(started);
  await vi.waitFor(() => expect(manager?.getPublic(run.runId), JSON.stringify(manager?.getPublic(run.runId))).toMatchObject({ status: 'succeeded' }), { timeout: 10_000 });
  expect(manager?.get(run.runId)).toMatchObject({ summary: 'FOREIGN_TEAM_NATIVE_CHILD_ANSWER',
    launch: { selectionSource: 'inherited', teamCredentialModel: teamSelection } });
  expect(runAuthority).toEqual([expect.objectContaining({ status: 'current', requestingAccountId: 'requester' })]);
  expect(opens).toHaveLength(2);
  const nativeOpens = (await readFile(join(cwd, 'foreign-native-opens.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  expect(nativeOpens).toEqual([{ model: teamSelection.modelId }, { model: teamSelection.modelId }]);
  const countTransportReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) => {
    const path = new URL(String(url)).pathname;
    return path === '/v1/account/encryption/currentness' || path === `/v2/sessions/${sessionId}`;
  }).length;
  const transportReadsBeforeAuthority = countTransportReads();
  const rpcReadsBeforeAuthority = sessionRpc.mock.calls.length;
  for (let observation = 0; observation < 2; observation += 1) {
    const terminal = await daemon.resolveExecutionRunLiveBrokerAuthority({ sessionId, requestingAccountId: 'requester',
      executionRunId: run.runId, expectedOccurrenceId: null });
    // The launch-time current answer must not survive the native Run's completion.
    expect(terminal).toMatchObject({ status: 'not_current' });
  }
  expect(sessionRpc.mock.calls).toHaveLength(rpcReadsBeforeAuthority + 2);
  // Broker observations need fresh Run authority, not a fresh Session record or
  // encryption witness after the tracked runner's RPC context was admitted.
  expect(countTransportReads()).toBe(transportReadsBeforeAuthority);
  const readsBeforeRefusal = sessionRpc.mock.calls.length;
  const wrongRecipient = await daemon.resolveExecutionRunLiveBrokerAuthority({ sessionId, requestingAccountId: 'another-account',
    executionRunId: run.runId, expectedOccurrenceId: null });
  expect(SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(wrongRecipient)).toEqual({ status: 'not_current', reason: 'identity_mismatch' });
  expect(sessionRpc.mock.calls).toHaveLength(readsBeforeRefusal);
}, 180_000);
