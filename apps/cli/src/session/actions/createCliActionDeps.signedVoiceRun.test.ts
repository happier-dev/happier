import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor, FeaturesResponseSchema, readBackendTargetRefV2, verifyExternalActionMachineRpcRequestV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionMachineBootstrapV1Schema, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, projectAutomationActionTriggerStructuralV1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import * as sockets from '@/api/session/sockets';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { createCapabilitiesService } from '@/capabilities/service';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { reloadConfiguration } from '@/configuration';
import { createInstalledMachineRpcDatabaseBoundary } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { createExecutionRunRpcActionDeps, createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { registerExecutionRunActionRpcHandlers } from '@/rpc/handlers/executionRuns/actionRpcRegistration';
import { createCliActionDeps } from './createCliActionDeps';

// Socket.IO and HTTP are the genuine process boundaries; all Action, Session,
// encryption and execution-run transport owners beneath them remain real.
const listeners = new Map<string, Set<() => void>>();
const packets: SocketRpcRequestPayload[] = [];
let deliver: ((packet: SocketRpcRequestPayload) => Promise<unknown>) | undefined;
const socket = {
  io: createSocketIoManagerStub(),
  connected: false,
  connect: vi.fn(() => { socket.connected = true; for (const fn of listeners.get('connect') ?? []) fn(); }),
  on: vi.fn((event: string, fn: () => void) => {
    const current = listeners.get(event) ?? new Set<() => void>(); current.add(fn); listeners.set(event, current);
  }),
  off: vi.fn((event: string, fn?: () => void) => { if (fn) listeners.get(event)?.delete(fn); else listeners.delete(event); }),
  removeAllListeners: vi.fn(() => listeners.clear()),
  disconnect: vi.fn(() => { socket.connected = false; }),
  close: vi.fn(),
  emit: vi.fn((event: string, packet: SocketRpcRequestPayload, ack?: (value: unknown) => void) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return;
    packets.push(packet);
    if (deliver) void deliver(packet).then(ack, error => ack?.({ ok: false, error: String(error) }));
    else ack?.({ ok: true, result: { ok: true, runId: 'run-voice' } });
  }),
  emitWithAck: vi.fn((event: string, packet: SocketRpcRequestPayload) => new Promise<unknown>(resolve => socket.emit(event, packet, resolve))),
};
// The requester currentness harness is a real loopback Socket.IO server; every other socket is the stub.
const currentnessServer = vi.hoisted(() => ({ url: null as string | null }));
vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: vi.fn((...args: Parameters<typeof actual.io>) =>
    currentnessServer.url && typeof args[0] === 'string' && args[0].startsWith(currentnessServer.url)
      ? actual.io(...args) : socket) };
});
vi.mock('@/agent/runtime/bridges/executionRun/createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: async () => createTestExecutionRunHostRuntime(),
}));
vi.mock('@/daemon/controlHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlHttp')>();
  const { EXECUTION_RUN_ADMISSION_PATH } = await import('@/daemon/lifecycle/admissionDrain');
  return { ...actual, daemonPost: async (...args: Parameters<typeof actual.daemonPost>) =>
    args[0] === EXECUTION_RUN_ADMISSION_PATH ? { admitted: true } : actual.daemonPost(...args) };
});
const homeDb = vi.hoisted(() => ({
  current: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null,
}));
vi.mock('../../../../server/sources/storage/db', () => ({
  db: {
    machine: {
      findFirst: (...args: Parameters<NonNullable<typeof homeDb.current>['db']['machine']['findFirst']>) =>
        homeDb.current!.db.machine.findFirst(...args),
      findUnique: (...args: Parameters<NonNullable<typeof homeDb.current>['db']['machine']['findUnique']>) =>
        homeDb.current!.db.machine.findUnique(...args),
    },
    account: { findUnique: async () => ({ id: 'owner', status: 'active', encryptionMode: 'plain', tokenEpoch: 1 }) },
    simpleCache: { findUnique: async () => ({ value: 'srv_home' }) },
    $queryRawUnsafe: async () => [{ revision: null, values: null, encryptedSecrets: null, authenticationPolicy: null }],
  },
  getDbProviderFromEnv: () => 'postgres',
}));

const sessionId = 'cmwec73r300gamcvijq3b0p9z';
const target = { kind: 'machine' as const, machineId: 'machine-target' };
const installationId = 'target-installation';
const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
const start = {
  intent: 'voice_agent' as const,
  backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'codex' })!,
  permissionMode: 'default' as const,
  retentionPolicy: 'resumable' as const,
  runClass: 'long_lived' as const,
  ioMode: 'streaming' as const,
  bootstrapMode: 'none' as const,
};

beforeEach(async () => {
  packets.length = 0; listeners.clear(); socket.connected = false;
  const session = createSessionRecordFixture({ id: sessionId, active: true, machineId: target.machineId,
    encryptionMode: 'plain', metadata: JSON.stringify(await createTestMetadata({ machineId: target.machineId, path: '/workspace' })) });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
    if (path === `/v1/machines/${target.machineId}`) return { status: 200, data: {
      machine: ExternalActionMachineBootstrapV1Schema.parse({
        id: target.machineId, installationId, managedMachineRef: null, kind: 'persistent',
        active: true, revokedAt: null, replacedByMachineId: null,
      }),
    } };
    throw new Error(`Unexpected HTTP read: ${path}`);
  });
});
afterEach(() => {
  deliver = undefined;
  homeDb.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('attached Voice Run signed Session transport', () => {
  it.each(['start', 'ensure', 'ensure_or_start'] as const)('preserves admitted Account authorization through %s to the runner', async operation => {
    const actionId = operation === 'start' ? 'execution.run.start' : operation === 'ensure' ? 'execution.run.ensure' : 'execution.run.ensure_or_start';
    const method = operation === 'start' ? SESSION_RPC_METHODS.EXECUTION_RUN_START : operation === 'ensure' ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE : SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START;
    const request = operation === 'start' ? start : operation === 'ensure' ? { runId: 'run-voice' } : { runId: 'run-voice', start };
    const invocation = { surface: 'voice', authority: 'present_user', caller: { kind: 'host' } } as const;
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1 as const, token: 'home-voice-proof', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      accountEncryptionMode: 'plain' as const, serverIdentityId: 'srv_home', machineId: target.machineId,
      installationId, actionId, requestId: 'voice-start-request', requestEnvelopeDigest: 'a'.repeat(43), target,
    } }, credentials: { token: 'account-token' }, invocation,
      purpose: { kind: 'machine_rpc', method, params: request }, installationPublicKey: keys.publicKey, randomBytes });
    const context = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: target, externalActionExecutionAuthorization: authorization } satisfies ActionExecutorContext;
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    const result = operation === 'start' ? await deps.executionRunStart(sessionId, start, context)
      : operation === 'ensure' ? await deps.executionRunEnsure!(sessionId, { runId: 'run-voice' }, context)
      : await deps.executionRunEnsureOrStart!(sessionId, { runId: 'run-voice', start }, context);
    expect(result).toMatchObject({ ok: true });
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.externalActionExecution, 'runner must receive the existing signed Account authorization').toBeDefined();
    const execution = packet.externalActionExecution!;
    expect(execution.authorization).toEqual(authorization);
    if (!packet.requestId) throw new Error('Signed Machine RPC must carry its request id');
    expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      requesterAccountContext: execution.authorization.requesterAccountContext,
      target, installationId, event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId,
      params: packet.params, signature: execution.machineSignature, publicKey: keys.publicKey })).toBe(true);
    expect(openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
      purpose: { kind: 'machine_rpc', method, params: request }, machineId: target.machineId,
      installationId, serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey, includeInvocation: true }))
      .toEqual({ credentials: { token: 'account-token' }, invocation });
  });

  it('refuses signed Account Start without the installation signer before issuing an unsigned RPC', async () => {
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    const context = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' }, externalActionTarget: target,
      externalActionExecutionAuthorization: { v: 1, token: 'home-voice-proof', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId, installationId,
        actionId: 'execution.run.start', requestId: 'voice-start-request', requestEnvelopeDigest: 'a'.repeat(43), target,
      } } } satisfies ActionExecutorContext;
    let outcome: unknown;
    try { outcome = await deps.executionRunStart(sessionId, start, context); }
    catch (error) { outcome = error; }
    expect(packets, 'missing signing custody must never fall back to unsigned Account dispatch').toEqual([]);
    expect(outcome).not.toMatchObject({ ok: true });
  });

  it('keeps ordinary MCP Voice intent unsigned and under the automation ceiling', async () => {
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    expect(await deps.executionRunStart(sessionId, start, { surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
    expect(packets).toHaveLength(1);
    expect(packets[0]!.externalActionExecution).toBeUndefined();
  });
});

describe('Account Run Start Automation admission', () => {
  it.each([
    { transport: 'signed', refuse: false },
    { transport: 'direct', refuse: false },
    { transport: 'signed', refuse: true },
    { transport: 'direct', refuse: true },
  ] as const)('uses one root admission for $transport Start (Before refusal: $refuse)', async ({ transport, refuse }) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-signed-run-admission-'));
    vi.stubEnv('HAPPIER_HOME_DIR', stateDir);
    vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
    reloadConfiguration();
    onTestFinished(async () => {
      reloadConfiguration();
      await rm(stateDir, { recursive: true, force: true });
    });
    const direct = transport === 'direct';
    const scope = direct ? null : sessionId;
    const actionId = 'execution.run.start';
    const method = SESSION_RPC_METHODS.EXECUTION_RUN_START;
    const requestId = `start-${transport}-${refuse}`;
    // Detached (direct) Starts need an intent that supports a Machine scope.
    // An attached child names its model and native route, since no live parent Session applies one here.
    const input = { ...start, sessionId: scope, intent: direct ? 'task' : 'delegate', instructions: 'Summarize the fixture.',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      ...(direct ? {} : { modelId: 'fixture-model', connectedServices: null }) } as const;
    const serverId = 'srv_home';
    const serverHttpBaseUrl = `https://${requestId}.example.test`;
    const features = FeaturesResponseSchema.parse({
      features: { workflows: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId: serverId } },
    });
    vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0]) => {
      if (String(url) === `${serverHttpBaseUrl}/v1/features` || String(url) === `${serverHttpBaseUrl}/v1/features/authenticated`) {
        return Response.json(features);
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1 })).toString('base64url')}.test`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    vi.stubEnv('HANDY_MASTER_SECRET', 'signed-run-admission-test');
    vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', undefined);
    vi.stubEnv('HAPPIER_STACK_SHARED_DB_SOURCE_STACK', undefined);
    homeDb.current = createInstalledMachineRpcDatabaseBoundary({ machineId: target.machineId, ownerAccountId: 'owner',
      installation: { installationId, createdAt: 1, publicKey: encodeBase64(keys.publicKey, 'base64url'),
        privateKey: encodeBase64(keys.secretKey, 'base64url'), version: 1 } });
    const authPath = '../../../../server/sources/app/auth/auth';
    const verifierPath = '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
    const { auth }: { auth: {
      init(): Promise<void>;
      mintExternalActionExecutionAuthorization(binding: ExternalActionExecutionAuthorizationBindingV1,
        context: { input: unknown }): Promise<ExternalActionExecutionAuthorizationV1>;
    } } = await import(authPath);
    const { verifyExternalActionMachineRpcExecution }: {
      verifyExternalActionMachineRpcExecution(execution: NonNullable<SocketRpcRequestPayload['externalActionExecution']>,
        request: Pick<SocketRpcRequestPayload, 'method' | 'params' | 'requestId'>): Promise<{
          effectiveAuthority: 'present_user'; sessionRpcTarget?: { sessionId: string; machineId: string };
        } | null>;
    } = await import(verifierPath);
    await auth.init();
    const authorization = await auth.mintExternalActionExecutionAuthorization({
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: serverId, machineId: target.machineId, installationId,
      actionId, requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
    }, { input });
    // The owning Session host supplies its Account's Run report choice (a Home read in production).
    const manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: stateDir, sendAcp: async () => {},
      resolveRunReportPolicy: async () => ({ preset: 'important' }) });
    onTestFinished(() => manager.dispose());
    const receiverParams = {
      manager, context: { sessionId: scope, cwd: stateDir },
      policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }),
      isExecutionRunsEnabled: () => true,
    };
    const receiver = createExecutionRunRpcActionExecutor(receiverParams);
    const rpc = new RpcHandlerManager({
      scopePrefix: scope ?? target.machineId, localMachineId: target.machineId, encryptionMode: 'plain',
      prepareRequesterAccountContext: args => prepareRequesterAccountActionContext({
        ...args, machineId: target.machineId, installationId, installationPrivateKey: keys.secretKey,
        serverId, serverIdentityId: serverId, serverHttpBaseUrl, ownCredentials: credentials,
        isCurrent: async () => true, createExecutor: () => receiver,
      }),
    });
    registerExecutionRunActionRpcHandlers(rpc, { executor: receiver, defaultSessionId: scope, machineId: target.machineId, serverId });
    if (direct) {
      const capabilities = createCapabilitiesService({ capabilities: [executionRunsCapability],
        checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
        buildContext: async () => { throw new Error('Start needs only the passive Run capability description'); } });
      rpc.registerHandler(RPC_METHODS.CAPABILITIES_DESCRIBE, async () => capabilities.describe());
    }
    // The receiver opens the requester's live Account currentness channel before admitting its custody.
    // Only that channel reaches the loopback harness; Machine RPC sockets keep the Home relay stub.
    const connectStub = sockets.createUserScopedSocketConnection;
    const currentnessChannel = await createRequesterCurrentnessSocketHarness();
    const connectCurrentness = vi.mocked(sockets.createUserScopedSocketConnection).getMockImplementation()!;
    vi.mocked(sockets.createUserScopedSocketConnection).mockImplementation(options =>
      options.clientPurpose === 'scoped-rpc' ? connectStub(options) : connectCurrentness(options));
    currentnessServer.url = currentnessChannel.serverUrl;
    onTestFinished(() => { currentnessServer.url = null; return currentnessChannel.close(); });
    const phases: string[] = [];
    const relay = async (packet: SocketRpcRequestPayload) => {
      const execution = packet.externalActionExecution;
      const verified = execution && await verifyExternalActionMachineRpcExecution(execution, packet);
      if (!verified) return { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN };
      if (packet.method.endsWith(`:${method}`)) phases.push('receiver');
      // Home forwards the signed root and its effective authority only for a
      // Session RPC target (registerSocketRpcHandlers); a Machine-scope passive
      // read such as the detached describe preflight arrives without them.
      const result: unknown = await rpc.handleRequest({ method: packet.method, params: packet.params,
        requestId: packet.requestId,
        ...(scope ? { authorization: { kind: 'session.write', sessionId: scope, authority: 'sessionOwner' } } : {}),
        ...(verified.sessionRpcTarget ? { callerAuthority: verified.effectiveAuthority,
          callerInputAuthorization: execution.authorization } : {}) }, undefined, 'authenticated_home_socket');
      return { ok: true, result };
    };
    deliver = relay;
    const trigger = {
      kind: 'action', phase: 'before', actionIds: [actionId],
      ...(refuse ? { mode: 'wait', onFailure: 'refuse' } : { mode: 'notify' }),
    } as const;
    const fixtureTrigger = { ...trigger, actionIds: [...trigger.actionIds] };
    const { kind: _kind, ...indexTrigger } = projectAutomationActionTriggerStructuralV1(fixtureTrigger);
    const definition = AutomationDefinitionDetailSchema.parse({
      id: 'before-start', name: 'Before Start', description: null, enabled: true, targetType: null,
      existingSessionId: null, templateVersion: 1, templateCiphertext: 'retained-workflow-template',
      lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
      triggers: [{ id: 'before', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
        kind: 'action', ...indexTrigger,
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, automationId: 'before-start', triggerId: 'before', triggerRevision: 1, triggerKind: 'action' },
          definition: fixtureTrigger })) }],
    });
    vi.spyOn(axios, 'request').mockImplementation(async ({ url }) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v3/automations/before-start') return { status: 200, data: definition };
      if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
        phases.push('index');
        return { status: 200, data: { v: 1, rows: [{
          automationId: 'before-start', triggerId: 'before', triggerRevision: 1,
          workflowId: 'workflow-before', workflowRevision: 1, ownerAccountId: 'owner',
          ...indexTrigger,
        }] } };
      }
      if (path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1) {
        phases.push('admit');
        return { status: 200, data: { results: [
          { kind: 'admitted', automationId: 'before-start', triggerId: 'before', runId: 'before-run' },
        ] } };
      }
      throw new Error(`Unexpected Automation HTTP request: ${path}`);
    });
    const getHome = vi.mocked(axios.get).getMockImplementation()!;
    const artifacts = createPlainAccountArtifactHttpBoundary();
    const getArtifact = vi.mocked(axios.get).getMockImplementation()!;
    const writeArtifact = artifacts.writes.getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation((url, config) => {
      const path = new URL(String(url)).pathname;
      return path.startsWith('/v1/artifacts') || path === '/v1/account/encryption'
        ? getArtifact(url, config) : getHome(url, config);
    });
    artifacts.writes.mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      if (path.startsWith('/v1/artifacts')) return writeArtifact(url, body, config);
      if (path === WORKFLOW_RUN_STORAGE_HTTP_PATH) {
        expect(body).toMatchObject({ operation: 'wait', runId: 'before-run', conditions: ['terminal'] });
        phases.push('wait');
        const time = '2026-01-01T00:00:00.000Z';
        const run = WorkflowRunSummaryV1Schema.parse({ id: 'before-run', sourceArtifactId: null,
          ownerAccountId: 'owner', visibleTeamId: null, attentionRequired: false, failureUnseen: false,
          invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: time,
          origin: { kind: 'automation', automationId: 'before-start' }, state: 'failed', revision: 1,
          machineId: target.machineId, workflowCustodyState: 'settled', originDeliveryAckRevision: null,
          availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false,
            inspectExecution: false, disabledReasons: [] },
          createdAt: time, updatedAt: time, errorCode: 'fixture_before_refused' });
        return { status: 200, data: { observation: 'terminal', run } };
      }
      throw new Error(`Unexpected Home HTTP write: ${path}`);
    });
    const root = createActionExecutor(createCliActionDeps({ token, credentials, serverId, serverHttpBaseUrl,
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverIdentityId: serverId, admittedAccountEncryptionMode: 'plain',
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      ...(direct ? { machineActionDirectTargetTransport: { machineId: target.machineId, invoke: async (rpcMethod, params, options) => {
        if (rpcMethod === method) phases.push('receiver');
        return rpc.invokeLocal(rpcMethod, params, options);
      } } } : {}),
    }));
    const invocation = { surface: 'voice', authority: 'present_user', caller: { kind: 'host' } } as const;
    const requesterAccountProjection: NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']> = {
      accountId: 'owner', serverId, accountEncryptionMode: 'plain',
      projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes }),
      isCurrent: async () => true,
      readArtifact: async () => null,
      sealRequesterAccountContext: async ({ authorization, purpose, installationPublicKey }) =>
        sealExternalActionRequesterAccountContextV1({ authorization, credentials: { token, encryption: null }, invocation,
          purpose, installationPublicKey, randomBytes }),
    };
    // Root ingress attaches the private projection non-enumerably, outside the strict wire schema.
    const rootRequesterAuthorization: ExternalActionExecutionAuthorizationV1 = direct ? authorization
      : Object.defineProperty({ ...authorization }, 'requesterAccountProjection', { value: requesterAccountProjection, enumerable: false });
    const rootAuthorization = await projectExternalActionRequesterHttpAuthorization({
      authorization: rootRequesterAuthorization, serverId, serverIdentityId: serverId, serverHttpBaseUrl,
      target, installationId, privateKey: keys.secretKey, rootAdmitted: true,
    });
    if (!rootAuthorization) throw new Error('Expected the admitted requester HTTP projection');
    const rootContext = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: requestId,
      bypassApprovals: true, runtimeAccountId: 'owner', serverId, serverIdentityId: serverId, externalActionTarget: target,
      executionRunTargetMachineId: target.machineId, externalActionExecutionAuthorization: rootAuthorization,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ ...args,
        authorizationToken: authorization.token, privateKey: keys.secretKey }),
    } satisfies ActionExecutorContext;
    const result = await root.execute(actionId, input, rootContext);
    expect(phases, JSON.stringify(result)).toEqual(refuse ? ['index', 'admit', 'wait'] : ['index', 'admit', 'receiver']);
    if (refuse) {
      expect(result).toMatchObject({ ok: false, errorCode: 'action_interception_rejected', effectAttempted: false,
        details: { message: 'fixture_before_refused' } });
      expect(manager.listPublic()).toEqual([]);
      expect(packets).toEqual([]);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
    expect(manager.listPublic()).toHaveLength(1);
    if (direct) {
      // Only the passive describe preflight crosses Home; the Start stays in process.
      expect(packets.filter(packet => packet.method.endsWith(`:${method}`))).toEqual([]);
      return;
    }
    const startPackets = packets.filter(packet => packet.method === `${sessionId}:${method}`);
    expect(startPackets).toHaveLength(1);
    const packet = startPackets[0]!;
    expect(packet.externalActionExecution?.authorization.binding.actionId).toBe(actionId);
    const execution = packet.externalActionExecution!;
    await expect(relay({ ...packet, externalActionExecution: { ...execution,
      authorization: { ...execution.authorization, token: 'corrupted-run-proof' } } }))
      .resolves.toEqual({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(manager.listPublic()).toHaveLength(1);

    const runId = manager.listPublic()[0]!.runId;
    const runActions = createExecutionRunRpcActionDeps(receiverParams);
    await expect(runActions.executionRunAction!(sessionId, { runId, actionId: 'browser.navigate',
      input: { kind: 'navigate', commandId: 'navigate', browserSessionId: 'browser', viewId: 'run-view', url: 'https://example.test/' } },
    { ...rootContext, externalActionContinuation: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });
});
