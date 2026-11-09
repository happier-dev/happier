import axios from 'axios';
import childProcesses from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, V2SessionRecordSchema, type ActionExecutorContext } from '@happier-dev/protocol';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { PendingActivationFailureDetailsV1Schema, PendingActivationFailureRequestV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createSessionNotificationContextFixture, createSessionRecordFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { logger } from '@/ui/logger';
import * as cliProcess from '@/utils/spawnHappyCLI';
import { activatePendingInactiveSession } from '@/daemon/sessions/activatePendingInactiveSession';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { activateRequesterPendingSession } from '@/daemon/sessions/pendingSessionActivationRecovery';
import { releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { clearSessionMarkerConnectedServiceRestartIntent, hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { SessionTeamCredentialBindingIntentV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1 } from '@happier-dev/protocol/teams/credentials/actionsV1';
import { TeamsPageV1Schema, resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { projectAgentProviderBrokerApplications } from '@/providers/broker/applicationProjection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '@/daemon/processes/roots/listHappierProcessRoots';
import { createProcessActionExecutor } from '@/daemon/processes/actions/processActionExecutor';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createMachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { registerDaemonProcessesRpcHandlers } from '@/rpc/handlers/daemonProcesses';
import type { RpcHandlerMap } from '@/api/rpc/types';
import { processRef } from '@/daemon/processes/view/processRef';
import { resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { sessionStop as stopGuardSession } from '@/daemon/guard/actuators/sessionStop';
import { evaluateSessionEligibility } from '@/daemon/guard/sessionEligibility';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import { buildGuardStopWarningPushDataV1, readGuardStopWarningPushActionV1 } from '@happier-dev/protocol/activity/webhookPayload';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
vi.mock('@/utils/spawnHappyCLI', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/spawnHappyCLI')>();
  return { ...actual, spawnHappyCLI: vi.fn(() => { throw new Error('Fixture native launch'); }) };
});
// Only the OS listener is replaced; startup, exit supervision and requester custody remain real.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43127, stop: async () => {} };
  } };
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each([
  { route: 'owner', stop: 'persisted' }, { route: 'owner', stop: 'absent' },
  { route: 'requester', stop: 'persisted' }, { route: 'requester', stop: 'absent' },
  { route: 'owner', stop: 'during-preparation' }, { route: 'owner', stop: 'then-person-resume' },
  { route: 'owner', stop: 'guard' },
  { route: 'owner', stop: 'guard-background' },
  { route: 'public', stop: 'guard' },
  { route: 'public', stop: 'guard-notification' },
  { route: 'public-broker', stop: 'guard' },
  { route: 'public', stop: 'processes' },
  { route: 'public', stop: 'processes-legacy' },
  { route: 'public-broker', stop: 'processes' },
  { route: 'public', stop: 'processes-held' },
  { route: 'public', stop: 'widget' },
  { route: 'public', stop: 'kill' },
  { route: 'public', stop: 'cli-stop' },
  { route: 'public', stop: 'agent-session' },
  { route: 'public', stop: 'agent-resource' },
  { route: 'public', stop: 'info' },
  { route: 'public', stop: 'archived' },
  { route: 'public', stop: 'authority-unavailable' },
  { route: 'public', stop: 'missing-session' },
  { route: 'public', stop: 'transient-session-read' },
  { route: 'public', stop: 'transient-account-read' },
  { route: 'public-later-stop', stop: 'processes' },
  { route: 'public', stop: 'persisted' },
  { route: 'public', stop: 'during-preparation' },
  { route: 'public-later-stop', stop: 'guard' },
  { route: 'owner', stop: 'mismatched-context' },
] as const)('does not promote retained Pending input to person Resume ($route / $stop)', async scenario => withTempHappyCliEntrypoint(async runner => {
  const brokered = scenario.route === 'public-broker';
  const resourceStop = scenario.stop === 'processes' || scenario.stop === 'processes-held' || scenario.stop === 'processes-legacy'
    || scenario.stop === 'widget';
  const sessionActionStop = scenario.stop === 'info' || scenario.stop === 'agent-session' || scenario.stop === 'agent-resource'
    || scenario.stop === 'guard-notification';
  const personHold = scenario.stop === 'info' || scenario.stop === 'agent-session' || scenario.stop === 'cli-stop' || scenario.stop === 'kill';
  const usesEnvelope = brokered || resourceStop && scenario.stop !== 'processes-legacy' || sessionActionStop || personHold;
  const transientRead = scenario.stop === 'transient-session-read' || scenario.stop === 'transient-account-read';
  const agentId = brokered ? 'codex' : 'claude';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, agentId, false, undefined, pluginReloadController,
    { processEnv: { HAPPIER_CLAUDE_PATH: process.execPath, HAPPIER_CODEX_PATH: process.execPath } });
  const diagnostic = vi.spyOn(logger, 'infoFile');
  // The runner executable is an OS fixture, not a separately built CLI artifact.
  vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', runner);
  h.pidToTrackedSession.clear();
  const stopped = scenario.stop !== 'absent' && scenario.stop !== 'guard' && scenario.stop !== 'guard-background'
    && scenario.stop !== 'mismatched-context' && scenario.stop !== 'processes' && scenario.stop !== 'info'
    && scenario.stop !== 'archived' && scenario.stop !== 'authority-unavailable' && scenario.stop !== 'missing-session'
    && scenario.stop !== 'processes-legacy'
    && scenario.stop !== 'widget' && scenario.stop !== 'kill' && scenario.stop !== 'cli-stop'
    && scenario.stop !== 'guard-notification'
    && scenario.stop !== 'agent-session' && scenario.stop !== 'agent-resource' && !transientRead;
  const stop = { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 20 };
  const agentTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' });
  const metadata = { ...(brokered ? createSessionMetadata({ flavor: agentId, machineId: 'machine', directory: h.cwd,
    startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId, agent: { backendMode: 'appServer' } },
    launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
    modelSelectionIntent: { v: 1, updatedAt: 1, selection: { agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.6-luna' } },
  }).metadata : { machineId: 'machine', path: h.cwd, flavor: agentId }),
    ...(brokered ? { codexSessionId: 'original-conversation' } : { claudeSessionId: 'original-conversation' }),
    ...(stopped && scenario.stop !== 'during-preparation' ? { sessionExplicitStopV1: stop } : {}) };
  const requestId = 'discussion-follow-v1:retained-original';
  const raw = createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain', metadata: JSON.stringify(metadata),
    machineId: 'machine', path: h.cwd, pendingCount: 1, pendingVersion: 1,
    pendingActivationAuthorization: { requestId, requestedAt: 30, status: 'waiting', admittedTarget: {
      homeId: 'srv_requester_home', accountId: 'requester', sessionId: h.sessionId, machineId: 'machine',
      installationId: h.f.installation.installationId } } });
  if (scenario.stop.startsWith('agent-')) raw.manager = { sessionId: 'lead-session' };
  // Default enqueue under online_only does not arm unattended activation.
  // Its current, authenticated public request must not borrow a waiting tuple.
  if (scenario.route.startsWith('public')) delete raw.pendingActivationAuthorization;
  if (scenario.stop === 'archived') raw.archivedAt = 1;
  if (scenario.stop === 'authority-unavailable') raw.metadata = JSON.stringify({ ...metadata, sessionExplicitStopV1: {} });
  const updateEnvelopeMetadata = (current: Record<string, unknown>) => {
    const envelope = buildSessionMetadataEnvelopeFields({ credentials: h.requester.bootstrap.credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', metadata: current, agentState: null });
    raw.metadataLayoutVersion = envelope.metadataLayoutVersion;
    raw.metadata = envelope.sharedMetadata.ciphertext;
    raw.ownerMetadata = envelope.ownerMetadata;
    raw.share = null;
    V2SessionRecordSchema.parse(raw);
  };
  const brokerBinding = SessionTeamCredentialBindingIntentV1Schema.parse({ v: 1, slot: { kind: 'provider_model' },
    resourceId: 'pool', expectedResourceRevision: 2, deliveryMode: 'brokered', teamId: 'team' });
  const applications = brokered ? projectAgentProviderBrokerApplications({ registry: h.plugin.registry.contributes,
    agentTargetKey, acceptedProtocols: ['openai-responses'] }) : [];
  if (usesEnvelope) updateEnvelopeMetadata(metadata);
  if (brokered) {
    raw.acceptedTeamCredentialBinding = brokerBinding;
    if (!applications.length) throw new Error('Missing real Codex broker application');
  }
  let sessionReads = 0;
  // Public wake reaches the canonical pre-preparation admission after its
  // requester lookup; Pending first performs its own authorization read.
  const launchAdmissionRead = scenario.route === 'public' ? 2 : 3;
  let stopAdmissionCurrentnessReads = 0;
  const readStopSignalAuthorityPhase = () => {
    const phase = [...diagnostic.mock.calls].reverse().find(([message]) =>
      message === '[DAEMON STOP] Physical Stop phase started' || message === '[DAEMON STOP] Physical Stop phase settled');
    const detail = phase?.[1];
    return phase?.[0] === '[DAEMON STOP] Physical Stop phase started'
      && detail && typeof detail === 'object' && 'phase' in detail && detail.phase === 'signal_authority'
      ? phase : undefined;
  };
  const requesterCompatibilityHeaders = Object.keys(buildCurrentAccountStoredContentCompatibilityHttpHeaders());
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
    const path = new URL(String(url)).pathname;
    if (path === `/v2/sessions/${h.sessionId}`) {
      // Home commits Stop after Pending's final authorization read, before the
      // canonical launch owner revalidates persisted admission.
      if (++sessionReads === launchAdmissionRead && scenario.stop === 'during-preparation') {
        raw.metadata = JSON.stringify({ ...metadata, sessionExplicitStopV1: stop });
      }
      if (sessionReads === launchAdmissionRead && scenario.stop === 'transient-session-read') throw new Error('Transient Session read failure');
      if (sessionReads === launchAdmissionRead && scenario.stop === 'missing-session') return { status: 404, data: {} };
      return { status: 200, data: { session: raw } };
    }
    if (path === '/v1/account/encryption/currentness') {
      // The physical phase also checks requester custody before and after
      // metadata admission. Those ordinary Account observations carry the
      // canonical compatibility declaration; metadata admission supplies its
      // Action-authorized headers instead (including in the former writer).
      const headers = args[0]?.headers;
      const requesterObservation = headers && requesterCompatibilityHeaders.every(header => header in headers);
      if (readStopSignalAuthorityPhase() && !requesterObservation) {
        stopAdmissionCurrentnessReads++;
      }
      if (sessionReads === launchAdmissionRead && scenario.stop === 'transient-account-read') throw new Error('Transient Account read failure');
    }
    if (path === `/v2/sessions/${h.sessionId}/pending`) return { status: 200, data: { pending: [
      { localId: requestId, messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' }, deliveryStatus: { status: 'queued' } },
    ] } };
    if (path === `/v1/access-keys/${h.sessionId}/machine`) return { status: 200,
      data: { accessKey: { id: 'existing-session-machine-tuple' } } };
    return get(url, ...args);
  });
  const post = vi.mocked(axios.post).getMockImplementation()!;
  // Home PATCH is a system boundary. Persist the real Stop producer's output
  // so the later launch reads it through the canonical metadata/admission owners.
  vi.spyOn(axios, 'patch').mockImplementation(async (url, body: unknown) => {
    if (new URL(String(url)).pathname !== `/v2/sessions/${h.sessionId}`) throw new Error('Unexpected Session mutation');
    const tuple = SessionMetadataTuplePatchV1Schema.safeParse(body);
    if (tuple.success && tuple.data.mode === 'owner') {
      expect(tuple.data.expectedOwnerMetadata).toEqual(raw.ownerMetadata);
      expect(tuple.data.sharedMetadata.expectedVersion).toBe(raw.metadataVersion);
      expect(tuple.data.agentState.expectedVersion).toBe(raw.agentStateVersion);
      raw.metadata = tuple.data.sharedMetadata.ciphertext;
      raw.ownerMetadata = tuple.data.ownerMetadata;
      raw.agentState = tuple.data.agentState.ciphertext;
      raw.metadataVersion++;
      raw.agentStateVersion++;
      V2SessionRecordSchema.parse(raw);
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } }) };
    }
    throw new Error('Expected canonical owner metadata tuple patch');
  });
  const failureReports: unknown[] = [];
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/read-batch' && scenario.stop.startsWith('agent-')) return { status: 200, data: createSessionReadBatchResponseFixture({ request: args[0], sessions: [{ ...createSessionNotificationContextFixture(raw.id), ...raw }] }) };
    if (path === '/v2/sessions/query' && scenario.stop.startsWith('agent-')) {
      const query = SessionListQueryV1Schema.parse(args[0]);
      expect(query.underSessionId).toBe('lead-session');
      return { status: 200, data: createCompactSessionListQueryResponseFixture({
        sessions: query.storage === 'active' ? [{ ...createSessionNotificationContextFixture(raw.id), ...raw }] : [],
        nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false,
      }) };
    }
    if (brokered && path === '/v1/teams/list') return { status: 200, data: TeamsPageV1Schema.parse({
      items: [{ id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
        policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
          defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only',
          authenticationPolicy: null, authenticationPolicyStatus: 'available' }, viewerRole: 'member',
        capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, admission: resolveTeamAdmissionProjectionV1(), counts: null }],
      nextCursor: null }) };
    if (brokered && path === TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.entitled.list']) return { status: 200, data: {
      resources: [TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'pool', teamId: 'team', displayName: 'Pool', resourceRevision: 2,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
        providerModels: applications.map(application => ({ selection: { kind: 'team_credential_provider_model',
          resourceId: 'pool', teamId: 'team', expectedResourceRevision: 2, deliveryMode: 'brokered', agentTargetKey, modelId: 'gpt-5.6-luna' },
          descriptor: { id: 'gpt-5.6-luna', name: 'Luna' }, sourceRevision: 'source-2', availability: 'available', application })) })], nextCursor: null } };
    if (new URL(String(url)).pathname.endsWith('/pending/activation/fail')) {
      failureReports.push(PendingActivationFailureRequestV1Schema.parse(args[0]));
      return { status: 200, data: { ok: true, didFail: true } };
    }
    return post(url, ...args);
  });
  if (scenario.stop === 'guard' || scenario.stop === 'guard-background' || resourceStop || sessionActionStop || personHold) {
    const child = childProcesses.spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await once(child, 'message');
    const identity = await readProcessIdentityByPid(child.pid!);
    if (!identity) throw new Error('Missing owned runner identity');
    const tracked = { ...h.tracked, pid: child.pid!, sessionRunnerPid: child.pid!, childProcess: child,
      processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) };
    h.pidToTrackedSession.set(tracked.pid, tracked);
    raw.metadata = JSON.stringify({ ...metadata, hostPid: tracked.pid, hostProcessStartTimeMs: identity.processStartTimeMs });
    if (usesEnvelope) updateEnvelopeMetadata({ ...metadata, hostPid: tracked.pid, hostProcessStartTimeMs: identity.processStartTimeMs });
    await writeSessionMarker({ pid: tracked.pid, happySessionId: h.sessionId, startedBy: 'daemon',
      processStartTimeMs: identity.processStartTimeMs, processCommandHash: tracked.processCommandHash });
    const control = boundary.control;
    if (!control) throw new Error('Missing production control composition');
    const app = createDaemonControlApp({ ...control, controlToken: 'stop-journey-token' });
    onTestFinished(() => app.close());
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: resolveProcessOwnerScopeKey(h.f.directory),
      listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: h.pidToTrackedSession.values() }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    onTestFinished(() => leftBehind.dispose());
    const actions = createProcessActionExecutor({ ownership, leftBehind, allProcessesVisible: () => false,
      requesterForOwner: () => ({ accountId: 'requester' }), prepareKill: h.daemon.processActionLifecycle.prepareKill,
      stopOwner: (root, execution) => root.owner.kind === 'session'
        ? h.daemon.processActionLifecycle.stopExactSession({ sessionId: root.owner.sessionId,
          pid: root.pid, start: root.start, ...execution }) : Promise.resolve(false) });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
      historyStore: await createMinuteHistoryStore({ directory: join(h.f.directory, 'journey-vitals') }) });
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'requester' }) });
    onTestFinished(() => view.dispose());
    const handlers: RpcHandlerMap = new Map();
    registerDaemonProcessesRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      view, actions, target: () => ({ serverId: 'session-home', machineId: 'machine',
        installationId: h.f.installation.installationId, custodianAccountId: 'requester' }) });
    // Home's forwarding/authentication is the transport boundary. The actual
    // Socket.IO client, Action executor, receiving routes and process owners run.
    h.f.channel.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
      async (packet: { method: string; params: unknown }, ack: (value: unknown) => void) => {
        try {
          const handler = handlers.get(packet.method.replace(/^machine:/u, ''));
          if (!handler) throw new Error(`Missing production process route: ${packet.method}`);
          ack({ ok: true, result: await handler(packet.params, { signal: h.signal,
            callerAuthority: 'present_user', localActionContext: { surface: 'ui', authority: 'present_user' },
            machineAdmission: { machineId: 'machine', installationId: h.f.installation.installationId,
              custodianAccountId: 'requester', actorAccountId: 'requester', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => h.f.isHomeCurrent() }) });
        } catch (error) { ack({ ok: false, error: error instanceof Error ? error.message : 'fixture_transport_failure' }); }
      }));
    const stopReceiver = createMachineSessionStopLifecycleActionExecutor({ stopSession: h.daemon.stopSession });
    const executor = createActionExecutor(createCliActionDeps({ token: h.requester.bootstrap.credentials.token,
      credentials: h.requester.bootstrap.credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test', isCredentialCurrent: h.f.isHomeCurrent,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => {
        if (method === RPC_METHODS.STOP_SESSION) {
          if (!request || typeof request !== 'object' || !('sessionId' in request) || typeof request.sessionId !== 'string') {
            throw new Error('Invalid Session Stop request');
          }
          const result = await stopReceiver.execute('session.stop', request, { surface: 'rpc', signal: h.signal });
          if (!result.ok) return result;
          raw.active = false;
          return result.result;
        }
        throw new Error(`Unexpected direct Machine transport: ${method}`);
      } } }));
    const managerStartContext = scenario.stop.startsWith('agent-') ? resolveCliAgentStartContextV1({
      sessionId: 'lead-session', machineId: 'machine', directory: h.cwd,
      backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' }, metadata: {},
      starterDepth: 0, turnDepth: 1, callerPermissionMode: 'default', settings: accountSettingsParse({}), roles: {},
    }) : null;
    if (managerStartContext && 'ok' in managerStartContext) throw new Error('Expected admitted manager context');
    const managerCaller = managerStartContext?.caller.kind === 'session' ? managerStartContext.caller : null;
    if (scenario.stop.startsWith('agent-') && !managerCaller) throw new Error('Expected the admitted managing Session caller');
    const actionContext: ActionExecutorContext = { surface: managerStartContext ? 'agent' : 'ui',
      authority: managerStartContext ? 'account_automation' : 'present_user',
      actionCaller: managerCaller ?? { kind: 'host' }, actionRequestId: stop.requestId,
      ...(managerStartContext ? { agentStartContext: managerStartContext, defaultSessionId: 'lead-session',
        sessionListAccess: 'led_subtree', callerPermissionMode: 'default' } : {}),
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.processes.kill': ['ui'] } }) };
    const currentnessReadsBeforeStop = stopAdmissionCurrentnessReads;
    if (resourceStop || scenario.stop === 'kill') {
      const actionId = scenario.stop === 'kill' ? 'machines.processes.kill' : 'machines.processes.stop';
      expect(await executor.execute(actionId, { machineId: 'machine',
        ...(scenario.stop === 'kill' ? { tree: false } : {}), targets: [{
          ref: processRef(tracked.pid, { startTimeMs: tracked.processStartTimeMs }),
          expect: { level: 'proven', owner: { kind: 'session', sessionId: h.sessionId } } }] }, actionContext))
        .toMatchObject({ ok: true, result: { status: 'ended' } });
    } else if (sessionActionStop) {
      const warningAction = scenario.stop === 'guard-notification' ? readGuardStopWarningPushActionV1(
        buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'machine', sessionId: h.sessionId,
          rule: 'idle_sessions', stopAt: 300_000 }), 'stopNow', { serverId: 'session-home' }) : null;
      if (scenario.stop === 'guard-notification' && warningAction?.actionId !== 'session.stop') {
        throw new Error('Expected the canonical Guard Stop notification Action');
      }
      const stopActionResult = await executor.execute('session.stop', warningAction?.input ?? { sessionId: h.sessionId,
        stopIntent: scenario.stop === 'agent-resource' ? 'lifecycle_control' : 'explicit_stop' }, actionContext);
      expect(stopActionResult, JSON.stringify(stopActionResult))
        .toMatchObject({ ok: true, result: { stopped: true } });
    } else if (scenario.stop === 'cli-stop') {
      const response = await app.inject({ method: 'POST', url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'stop-journey-token' }, payload: { sessionId: h.sessionId } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'stopped' });
    } else {
      const root = { owner: { kind: 'session' as const, sessionId: h.sessionId }, pid: tracked.pid,
        start: { startTimeMs: tracked.processStartTimeMs }, live: true, ownerCreatedAtMs: 0 };
      const readEligibility = () => evaluateSessionEligibility({ tracked,
        inventory: { coverage: 'complete', items: [{ category: 'session', state: 'settled', ownerRef: tracked,
          attribution: { kind: 'unknown' }, settledAt: 1 }] },
        draft: { status: 'absent' }, resume: { sessionId: h.sessionId, rawSession: raw, metadata } });
      const eligibility = await readEligibility();
      expect(eligibility).toMatchObject({ eligible: true });
      expect(await stopGuardSession({ signal: h.signal, candidate: { kind: 'session', root, settledAt: 1,
        target: { kind: 'session', tracked, root, label: 'Session', eligibility } },
        readCurrentTracked: id => [...h.pidToTrackedSession.values()].find(row => row.happySessionId === id),
        readCurrentEligibility: readEligibility,
        stopSession: async id => (await h.daemon.stopSession(id, { expectedTrackedRunner: { tracked,
          sessionRunnerPid: tracked.sessionRunnerPid, processStartTimeMs: tracked.processStartTimeMs,
          processCommandHash: tracked.processCommandHash }, beforeSignalExactTrackedRunner: () => true })).status === 'stopped' }))
        .toEqual({ status: 'stopped' });
    }
    if (resourceStop) expect(stopAdmissionCurrentnessReads - currentnessReadsBeforeStop,
      'Lifecycle Stop metadata admission reads Account currentness only for owner-envelope authorization').toBe(usesEnvelope ? 1 : 0);
    await exited;
    const afterStop = tryDecryptSessionOwnerMetadataView({ credentials: h.requester.bootstrap.credentials,
      accountEncryptionMode: 'plain', rawSession: raw });
    expect.soft(resolveSessionAutoResumeAdmissionV1({ metadata: afterStop, machineAvailable: true, authorityAvailable: true }))
      .toBe(personHold || stopped ? 'held_by_person' : 'eligible');
  }
  // Physical process launch is the boundary; Pending, metadata, resume admission,
  // requester custody and installed Agent preparation remain production owners.
  const launches: unknown[] = [];
  const actualSpawn = childProcesses.spawn;
  vi.spyOn(childProcesses, 'spawn').mockImplementation((...args: Parameters<typeof childProcesses.spawn>) => {
    if (JSON.stringify(args[1] ?? []).includes('--started-by')) {
      launches.push(args);
      throw new Error('Fixture native launch');
    }
    return actualSpawn(...args);
  });
  syncBuiltinESMExports();
  vi.mocked(cliProcess.spawnHappyCLI).mockImplementation((...args) => {
    launches.push(args);
    throw new Error('Fixture native launch');
  });
  const resume = vi.spyOn(h.daemon, 'spawnSessionForInternalResume');
  if (scenario.stop === 'mismatched-context') {
    expect(await h.daemon.spawnSessionForInternalResume({ directory: h.cwd, existingSessionId: h.sessionId,
      executionAuthorization: { provenance: 'user_request', requestId, requestedAt: 30 } },
      { requestId: 'another-original', requestedAt: 30 })).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    return;
  }
  if (scenario.stop === 'guard-background') {
    // A background snapshot can retain the original tuple. Only the actual
    // Pending activation owner supplies current input demand as private context.
    expect(await h.daemon.spawnSessionForInternalResume({ directory: h.cwd, existingSessionId: h.sessionId,
      resume: 'original-conversation', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization: { provenance: 'user_request', requestId, requestedAt: 30 } }))
      .toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    expect(JSON.parse(raw.metadata!).sessionExplicitStopV1).toBeUndefined();
    return;
  }
  let result: Awaited<ReturnType<typeof activatePendingInactiveSession>> | undefined;
  let publicResult: SpawnSessionResult | undefined;
  let laterStops = 0;
  if (scenario.route.startsWith('public')) {
    // Ordinary UI wake uses the public spawn RPC without person Resume intent.
    // This is a new launch request, not a retained automatic recovery snapshot.
    publicResult = await h.daemon.spawnSession({ directory: h.cwd, existingSessionId: h.sessionId,
      resume: 'original-conversation', backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
      ...(scenario.route === 'public-later-stop' ? { beforeSessionRunnerLaunch: async () => {
        laterStops++;
        await h.daemon.stopSession(h.sessionId);
        return true;
      } } : {}) });
  } else if (scenario.route === 'owner') {
    result = await activatePendingInactiveSession({ ...h.daemon, credentials: h.requester.bootstrap.credentials,
      machineId: 'machine', sessionId: h.sessionId, requestId, pendingVersion: 1 });
  } else {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === 'https://session-home.test/v1/features'
      ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_requester_home' } } })) : originalFetch(input, init)));
    await activateRequesterPendingSession({ ...h.daemon, machineId: 'machine',
      binding: { sessionId: h.sessionId, attribution: h.requester.bootstrap.attribution },
      resolveRequesterSessionRuntimeContext: h.resolveRequesterRuntime,
      releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
        [...h.pidToTrackedSession.values()].map(tracked => tracked.requesterSessionRuntimeContext)),
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://session-home.test', resolveCurrentMachineId: () => 'machine' }) });
  }
  if (transientRead) {
    expect(publicResult).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    expect(raw.pendingCount).toBe(1);
  } else if (stopped || personHold || scenario.stop === 'archived' || scenario.stop === 'authority-unavailable'
    || scenario.stop === 'missing-session'
    || scenario.route === 'public-later-stop') {
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    if (scenario.route === 'public') {
      expect(publicResult).toMatchObject({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
        errorDetail: { kind: 'launch_error', code: scenario.stop === 'archived' ? 'archived'
          : scenario.stop === 'authority-unavailable' || scenario.stop === 'missing-session' ? 'authority_unavailable' : 'held_by_person' } });
      if (publicResult?.type !== 'error') throw new Error('Expected a refused launch');
      expect(normalizeSpawnSessionErrorDetail(publicResult.errorDetail)).toEqual(publicResult.errorDetail);
      expect(raw.pendingCount).toBe(1);
    }
    if (scenario.route === 'public-later-stop') {
      expect(laterStops).toBe(1);
      expect(publicResult).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    }
    if (scenario.route === 'owner') expect(result).toEqual({ status: 'not-needed', reason: 'spawn-retryable' });
  } else {
    if (brokered) expect(diagnostic).toHaveBeenCalledWith('[DAEMON RUN] Team credential launch binding', expect.objectContaining({
      code: 'accepted_brokered_provider_model', sessionId: h.sessionId, resourceId: 'pool' }));
    expect(launches, JSON.stringify({ sessionReads, publicResult, resume: await resume.mock.results[0]?.value,
      failureReports, requesterStage: h.readRequesterRecoveryStage() })).toHaveLength(1);
    if (scenario.route === 'owner') expect(failureReports)
      .toMatchObject([{ requestId, requestedAt: 30, failureCode: 'runtime_start_failed' }]);
  }
  if (!scenario.route.startsWith('public')) expect(resume).toHaveBeenCalledOnce();
  expect(result?.status).not.toBe('activated');
  const finalMetadata = tryDecryptSessionOwnerMetadataView({ credentials: h.requester.bootstrap.credentials,
    accountEncryptionMode: 'plain', rawSession: raw });
  expect(finalMetadata?.sessionExplicitStopV1)
    .toEqual(personHold ? expect.objectContaining({ cause: 'explicit_stop' })
      : scenario.stop === 'authority-unavailable' ? {} : stopped ? stop : undefined);
  if (scenario.stop === 'then-person-resume') {
    // Fresh person intent still uses the public port; a failed physical launch
    // must not clear the hold it observed.
    await h.daemon.spawnSession({ directory: h.cwd, existingSessionId: h.sessionId, resume: 'original-conversation',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization: { provenance: 'user_request', requestId: 'fresh-person-resume' } });
    expect(launches).toHaveLength(1);
    expect(JSON.parse(raw.metadata!).sessionExplicitStopV1).toEqual(stop);
  }
}), 120_000);

it.each((['definite', 'transient', 'replaced', 'wrong-target', 'continuation', 'continuation-stale',
  'continuation-unavailable', 'continuation-replaced', 'continuation-wrong-target', 'continuation-stopped'] as const)
  .flatMap(disposition => (disposition.startsWith('continuation') ? [true, false] : [true])
    .map(respawnEnabled => ({ disposition, respawnEnabled }))))(
  'settles only the exact current pending activation after a post-webhook $disposition startup exit (respawn=$respawnEnabled)', async ({ disposition, respawnEnabled }) => {
    const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://session-home.test',
      resolveCurrentMachineId: () => 'machine' });
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
      resolveCurrentMachineExecutionOriginContext: resolveOrigin,
      processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: String(respawnEnabled) },
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === 'https://session-home.test/v1/features'
      ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_requester_home' } } }))
      : originalFetch(input, init)));
    const warnings = vi.spyOn(logger, 'warn');
    const diagnostics = vi.spyOn(logger, 'debug');
    // A retry may prepare normally, but this test never launches a physical child.
    const spawn = vi.spyOn(cliProcess, 'spawnHappyCLI').mockImplementation(() => { throw new Error('Native launch unavailable in fixture'); });
    const requestId = 'original-pending';
    const requestedAt = 10;
    h.tracked.spawnOptions!.executionAuthorization = { provenance: 'user_request', requestId, requestedAt };
    // This is the same producer used by host construction failure publication.
    const error = new PromptStackPreparationError('unavailable', { kind: 'doc', artifactId: 'private-reference' });
    if (disposition !== 'transient') Object.assign(error, { cause: new HomeTargetResolutionError('profile_missing', 'private-reference') });
    const continuation = disposition.startsWith('continuation');
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: continuation ? Object.assign(new Error('Agent session continuation is unreachable.'), {
        name: 'AgentSessionContinuationUnreachableError',
      }) : error, occurredAt: disposition === 'continuation-stale' ? 0 : 20 });
    const pendingActivationAuthorization = { requestId: disposition.endsWith('replaced') ? 'newer-pending' : requestId,
      requestedAt, status: 'waiting' as const, admittedTarget: { homeId: 'srv_requester_home',
        accountId: 'requester', sessionId: h.sessionId, machineId: 'machine',
        installationId: disposition.endsWith('wrong-target') ? 'replacement-installation' : h.f.installation.installationId } };
    const originalContent = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'original Pending input' } } } as const;
    const pending = [{ localId: requestId, messageRole: 'user', content: originalContent,
      requestedAction: { v: 1, kind: 'enqueue' }, deliveryStatus: { status: 'queued' } }];
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}/pending`) {
        return { status: 200, data: { pending } };
      }
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}`) {
        if (disposition === 'continuation-unavailable') throw Object.assign(new Error('private-response'), { code: 'ECONNREFUSED' });
        return { status: 200, data: {
        session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain', metadata: '{}',
          ownerAccountId: 'requester', origin: { kind: 'none' }, pendingCount: 1,
          pendingActivationAuthorization, latestTurnStatus: 'failed', lastRuntimeIssue: issue }) } };
      }
      return get(url, ...args);
    });
    const reports: unknown[] = [];
    const pendingWrites: string[] = [];
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, data, config) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith(`/v2/sessions/${h.sessionId}/pending`)) pendingWrites.push(path);
      if (path === `/v2/sessions/${h.sessionId}/pending/activation/fail`) {
        expect(new URL(String(url)).origin).toBe('https://session-home.test');
        expect(config?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
        reports.push({ body: PendingActivationFailureRequestV1Schema.parse(data),
          details: PendingActivationFailureDetailsV1Schema.parse(JSON.parse(String(config?.params?.failureDetails))) });
        return { status: 200, data: { ok: true, didFail: true } };
      }
      return post(url, data, config);
    });
    // The Home Machine terminal transport is unavailable; that does not invent a publisher or block supervision.
    vi.spyOn(h.machine, 'captureMachineSessionTerminal').mockRejectedValue(new Error('Home terminal transport unavailable'));
    if (disposition === 'continuation-stopped') {
      // These are the explicit process Stop owner's stamps before the OS exit.
      h.tracked.stopRequestedAtMs = Date.now();
      h.tracked.stopRequestedReason = 'user_process_kill';
    }
    await h.daemon.onChildExited(h.tracked.pid, { reason: 'process-exit', code: continuation ? 78 : 1, signal: null });
    if (disposition === 'definite' || disposition === 'continuation') {
      await expect.poll(() => reports, { timeout: 10_000 }).toEqual([{ body: { requestId, requestedAt,
        failureCode: 'runtime_start_failed' }, details: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' } }]);
    } else if (disposition === 'transient') {
      await expect.poll(() => diagnostics.mock.calls.some(([message]) => String(message)
        .startsWith(`[DAEMON RUN] Respawning runner for session ${h.sessionId}`)), { timeout: 10_000 }).toBe(true);
    }
    if (disposition !== 'transient' && disposition !== 'continuation-stopped') {
      await expect.poll(() => warnings.mock.calls.some(([message]) => String(message)
        .includes(`Respawn suppressed for session ${h.sessionId} (${continuation
          ? 'continuation unreachable' : 'startup dependency: profile_missing'})`)), { timeout: 10_000 }).toBe(true);
      // The terminal notification queues this same mutation without awaiting
      // it. Join the canonical PID queue before removing the fixture's Home.
      await clearSessionMarkerConnectedServiceRestartIntent(h.tracked.pid);
    }
    if (continuation) {
      // Repeated exit notification cannot settle the original activation twice.
      await h.daemon.onChildExited(h.tracked.pid, { reason: 'process-exit', code: 78, signal: null });
      expect(spawn).not.toHaveBeenCalled();
    }
    if (disposition !== 'definite' && disposition !== 'continuation') expect(reports).toEqual([]);
    const failsActivation = disposition === 'definite' || disposition === 'continuation';
    expect(pendingWrites).toEqual(failsActivation ? [`/v2/sessions/${h.sessionId}/pending/activation/fail`] : []);
    // Home keeps the original queue row: supervision may report failure, never
    // consume, rewrite or replace the input that a person can retry later.
    expect((await axios.get(`https://session-home.test/v2/sessions/${h.sessionId}/pending`)).data.pending)
      .toEqual([{ localId: requestId, messageRole: 'user', content: originalContent,
        requestedAction: { v: 1, kind: 'enqueue' }, deliveryStatus: { status: 'queued' } }]);
    if (disposition === 'continuation-unavailable') {
      expect(diagnostics).toHaveBeenCalledWith('[DAEMON RUN] Continuation failure observation unavailable',
        expect.objectContaining({ phase: 'pending_activation_failure', exitCode: 78,
          // The requester owner retires authority after the failed Home read;
          // its final currentness error has no allowlisted platform code.
          errorClass: 'Error', errorCode: null }));
      const projection = diagnostics.mock.calls.filter(([message]) => message === '[DAEMON RUN] Continuation failure observation unavailable');
      expect(JSON.stringify(projection)).not.toContain('private-response');
    }
    expect(JSON.stringify(reports)).not.toContain('private-reference');
  },
);
