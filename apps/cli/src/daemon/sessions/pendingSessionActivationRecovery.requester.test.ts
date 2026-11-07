import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterSessionCredentialCustody, createRequesterSessionRuntimeContextResolver, resolveRequesterSessionBootstrap,
  resolveRequesterSessionBootstrapFromCustody,
  listRequesterSessionCredentialBindings, type RequesterSessionMachineAdmissionBoundary } from '../sessionEncryption/requesterSessionCredentials';
import { activateRequesterPendingSession, readRequesterPendingSessionActivation } from './pendingSessionActivationRecovery';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from '../machine/bootstrapMachineSyncRuntime';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createDeferred } from '@/testkit/async/deferred';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';

const attribution = { serverId: 'local-bob-home-profile', accountId: 'bob', machineId: 'alice-machine', installationId: 'alice-installation' };
const target = { homeId: 'srv_requester_home', accountId: attribution.accountId, machineId: attribution.machineId,
  installationId: attribution.installationId, sessionId: 'bob-session' };
const origin = 'http://bob-home.test';
let app: FastifyInstance | undefined;
let directory: string | undefined;
let restore: (() => void) | undefined;
let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
let requesterBootstrap: Awaited<ReturnType<typeof resolveRequesterSessionBootstrap>>;
afterEach(async () => {
  await requesterBootstrap?.dispose(); requesterBootstrap = null;
  await currentnessChannel?.close(); currentnessChannel = undefined;
  vi.restoreAllMocks();
  restore?.(); restore = undefined;
  await app?.close(); app = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('requester pending reconnect through protected custody and the Home network boundary', () => {
  it('recovers an exact retained requester target and settles cold refusals without re-admitting an existing lifetime', async () => {
    directory = await mkdtemp(join(tmpdir(), 'requester-pending-reconnect-'));
    const credentials = { token: 'bob-private', encryption: null } as const;
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: target.sessionId, attribution, credentials,
      homeServerIdentityId: target.homeId });
    const discovery = await listRequesterSessionCredentialBindings({ happyHomeDir: directory,
      serverId: attribution.serverId, machineId: attribution.machineId, installationId: attribution.installationId });
    expect(discovery).toEqual({ status: 'ready', bindings: [{ sessionId: target.sessionId, attribution }] });
    app = fastify();
    const keyPair = tweetnacl.sign.keyPair();
    let grant = true;
    let receiptTarget = target;
    let observedHomeId = target.homeId;
    let sessionStatus = 200;
    let invalidSessionResponse = false;
    let nextSessionRead: (() => void) | undefined;
    let acceptFailureReport = false;
    const reports: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toBe(`${origin}/v1/features`);
      return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: observedHomeId } } })), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
    });
    const reads: Array<{ path: string; bearer: string | undefined }> = [];
    app.addHook('onRequest', async request => { reads.push({ path: request.url, bearer: request.headers.authorization }); });
    app.get('/v1/account/profile', async () => ({ id: 'bob' }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v2/sessions', async () => ({ sessions: [], hasNext: false, nextCursor: null }));
    app.get('/v1/machines/alice-machine', async (_request, reply) => grant ? { machine: {
      id: attribution.machineId, installationId: attribution.installationId,
      metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 1,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
    } } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
    app.post('/v1/machines/alice-machine/admission/verify', async (request, reply) => {
      const body = request.body as { context: SocketRpcMachineAdmissionContextV1;
        purpose: { kind: 'requester_session_currentness'; sessionId: string };
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const valid = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === target.sessionId
        && verifyMachineInstallationProof({ publicKey: keyPair.publicKey, proof: body.proof,
        payload: { version: 1, accountId: 'alice', machineId: attribution.machineId,
          installationId: attribution.installationId, rpcAdmission: { context: body.context, purpose: body.purpose } } });
      return valid && grant ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
    });
    app.get('/v1/access-keys/bob-session/alice-machine', async () => ({ accessKey: { id: 'exact-existing-tuple' } }));
    app.get('/v2/sessions/bob-session/pending', async () => ({ pending: [{ localId: 'input-1', messageRole: 'user',
      status: 'queued', deliveryState: null, requestedAction: { v: 1, kind: 'send_now' } }] }));
    app.post('/v2/sessions/bob-session/pending/activation/fail', async request => {
      reports.push(request.body);
      const stamp = request.body as { requestId: string; requestedAt: number };
      return { ok: true, didFail: acceptFailureReport && stamp.requestId === 'input-1' && stamp.requestedAt === 12 };
    });
    app.get('/v2/sessions/bob-session', async (_request, reply) => {
      const status = sessionStatus;
      const invalid = invalidSessionResponse;
      const afterRead = nextSessionRead; nextSessionRead = undefined; afterRead?.();
      return status !== 200 ? reply.code(status).send({ error: 'private-Session-refusal' })
        : invalid ? { session: { id: target.sessionId } } : ({ session: createSessionRecordFixture({ id: target.sessionId,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: attribution.machineId, path: '/workspace',
        flavor: 'codex', codexSessionId: 'native-bob-session', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }),
      dataEncryptionKey: null, share: null, pendingCount: 1, pendingVersion: 9,
      pendingActivationAuthorization: { status: 'waiting', requestId: 'input-1', requestedAt: 12, admittedTarget: receiptTarget },
    }) }); });
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin });
    currentnessChannel = await createRequesterCurrentnessSocketHarness();
    const boundary: RequesterSessionMachineAdmissionBoundary = { machineId: attribution.machineId, daemonToken: 'alice-daemon',
      isHomeCurrent: () => true, readInstallation: () => ({ installationId: attribution.installationId, privateKey: keyPair.secretKey }) };
    const bootstrap = await resolveRequesterSessionBootstrap({ happyHomeDir: directory, sessionId: target.sessionId,
      attribution, serverHttpBaseUrl: origin, machineAdmissionBoundary: boundary });
    requesterBootstrap = bootstrap;
    expect(bootstrap).not.toBeNull();
    if (!bootstrap) throw new Error('Missing real requester bootstrap');
    const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({ serverUrl: origin,
      resolveCurrentMachineId: () => boundary.machineId });
    const recovery = { sessionId: target.sessionId, bootstrap, resolveCurrentMachineExecutionOriginContext };
    expect(await readRequesterPendingSessionActivation(recovery)).toEqual({
      sessionId: target.sessionId, target, requestId: 'input-1', requestedAt: 12, pendingVersion: 9, source: 'scan',
    });
    const spawned: SpawnSessionOptions[] = [];
    // The process launch is the boundary; private reads, metadata decoding and target admission stay real.
    const activation = { credentials, requester: bootstrap, expectedTarget: target, machineId: attribution.machineId,
      resolveCurrentMachineExecutionOriginContext,
      sessionId: target.sessionId, requestId: 'input-1', pendingVersion: 9,
      spawnSessionForInternalResume: async (options: SpawnSessionOptions) => { spawned.push(options); return { type: 'success' as const, sessionId: target.sessionId }; } };
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'activated' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ existingSessionId: target.sessionId, machineId: attribution.machineId,
      requesterWorkAttributionV1: attribution, executionAuthorization: { requestId: 'input-1', requestedAt: 12 } });
    const createResolveRuntime = (machineAdmissionBoundary = boundary) => createRequesterSessionRuntimeContextResolver({ trackedSessions: new Map(),
      // A refused cold preparation must never reach runtime/process construction.
      getCreateRuntime: () => async () => { throw new Error('Refused preparation must not construct a runtime'); },
      recoverBootstrap: input => resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
        sessionId: input.sessionId, expectedAttribution: input.attribution, serverId: attribution.serverId,
        serverHttpBaseUrl: origin, machineAdmissionBoundary, signal: input.signal,
        onRecoveryRefused: input.onRecoveryRefused }),
    });
    const resolveRuntime = createResolveRuntime();
    // A reconnect must reach retained requester Pending custody while an
    // unrelated Machine endpoint acknowledgement is still outstanding.
    // Socket acknowledgements are held at the transport boundary; discovery,
    // requester recovery, refusal settlement and HTTP parsing remain real.
    const endpointAck = createDeferred<void>();
    const endpointEntered = createDeferred<void>();
    let onConnect: (() => void | Promise<void>) | undefined;
    type MachineClient = NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>;
    const machineTransport = {
      ...createApiMachineTransportFixture(),
      connect: (options: { onConnect?: () => void | Promise<void> }) => { onConnect = options.onConnect; },
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: () => {},
      updateDaemonState: async () => { endpointEntered.resolve(); await endpointAck.promise; return 'published' as const; },
      updateMachineMetadata: async () => 'published' as const,
      requestSessionMessageReplyRecoveryForSession: async () => {},
      emitExternalSessionTranscriptUpdate: () => {}, sendMachineTransferEnvelope: () => {},
      sendTransferRelayV2Envelope: () => {}, sendMachineLiveStreamRelayEnvelope: () => {},
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    const machineRuntime = await runWithServerHttpBaseUrl(origin, () => bootstrapMachineSyncRuntime({
      cliVersion: 'test', machineId: attribution.machineId,
      machine: { id: attribution.machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
      credentials, preferredHost: 'host',
      happyHomeDir: directory, happyLibDir: directory, filesystemAccessPolicy: { kind: 'osUser' },
      takeoverRequested: false, isShuttingDown: () => false,
      createConnectedApiMachine: () => machineTransport as unknown as MachineClient,
      attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
      startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
      spawnSessionForInternalResume: activation.spawnSessionForInternalResume,
      spawnSession: async () => { throw new Error('Pending must use internal resume'); },
      stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
      requesterServerId: attribution.serverId, resolveCurrentMachineExecutionOriginContext,
      readRequesterSessionCredentialBindings: () => listRequesterSessionCredentialBindings({ happyHomeDir: directory!,
        serverId: attribution.serverId, machineId: attribution.machineId, installationId: attribution.installationId }),
      resolveRequesterSessionRuntimeContext: resolveRuntime,
      releaseRequesterSessionRuntimeContext: async context => { await context.dispose(); },
      loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
      directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
      connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
      daemonServerWorkScheduler: createDaemonServerWorkScheduler({
        budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      }),
    }));
    let reconnect: Promise<void> | undefined;
    try {
      grant = false;
      if (!onConnect) throw new Error('Machine reconnect callback missing');
      reconnect = runWithServerHttpBaseUrl(origin, async () => { await onConnect!(); });
      await endpointEntered.promise;
      // A typed cold refusal proves the exact Pending owner ran; just listing
      // bindings or calling a mocked recovery function would not prove this.
      await vi.waitFor(() => expect(reports).toEqual([
        { requestId: 'input-1', requestedAt: 12, failureCode: 'runtime_start_failed' },
      ]));
      expect(spawned).toHaveLength(1);
    } finally {
      endpointAck.resolve();
      await reconnect;
      await retireMachineSyncRuntimeAttempt(machineRuntime);
      grant = true;
      reports.length = 0;
    }
    let hint = { sessionId: target.sessionId, requestId: 'input-1', requestedAt: 12, pendingVersion: 9, source: 'live' as const };
    const rejected: unknown[] = [];
    const settle = () => activateRequesterPendingSession({ machineId: attribution.machineId, binding: { sessionId: target.sessionId, attribution },
      hint, resolveRequesterSessionRuntimeContext: resolveRuntime,
      releaseRequesterSessionRuntimeContext: async context => { await context.dispose(); },
      resolveCurrentMachineExecutionOriginContext, spawnSessionForInternalResume: activation.spawnSessionForInternalResume,
      onActivationRejected: async event => { rejected.push(event); } });
    const refuseOnce = () => { sessionStatus = 403; nextSessionRead = () => { sessionStatus = 200; }; };
    refuseOnce();
    await settle();
    expect(reports).toEqual([{ requestId: 'input-1', requestedAt: 12, failureCode: 'runtime_start_failed' }]);
    expect(spawned).toHaveLength(1);
    expect(rejected).toEqual([]);
    reports.length = 0; acceptFailureReport = true;
    refuseOnce();
    await settle();
    expect(reports).toHaveLength(1);
    expect(rejected).toEqual([{ sessionId: target.sessionId, reason: 'identity-unavailable', requester: attribution }]);
    expect(spawned).toHaveLength(1);
    reports.length = 0;
    invalidSessionResponse = true;
    nextSessionRead = () => { invalidSessionResponse = false; };
    await settle();
    expect(reports).toEqual([]);
    expect(spawned).toHaveLength(1);
    // Unavailable evidence and cancellation retain waiting custody. Definite
    // refusals report through the owner bearer, even when recovery stays refused.
    reports.length = 0;
    sessionStatus = 503;
    await expect(settle()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    sessionStatus = 403;
    await settle();
    expect(reports).toHaveLength(1);
    reports.length = 0;
    sessionStatus = 200;
    invalidSessionResponse = true;
    await settle();
    invalidSessionResponse = false;
    expect(reports).toEqual([]);
    expect(await resolveRuntime(target.sessionId, attribution, AbortSignal.abort(), async () => {
      throw new Error('Cancellation must not settle');
    })).toBeNull();
    const cancelled = new AbortController();
    sessionStatus = 403;
    nextSessionRead = () => { sessionStatus = 200; cancelled.abort(); };
    expect(await resolveRuntime(target.sessionId, attribution, cancelled.signal, async () => {
      throw new Error('In-flight cancellation must not settle');
    })).toBeNull();
    const reconnectCancelled = new AbortController();
    sessionStatus = 403;
    nextSessionRead = () => {
      sessionStatus = 200;
      // The first read refuses cold recovery. Cancellation happens during the
      // subsequent real HTTP read which obtains the reconnect failure stamp.
      nextSessionRead = () => { reconnectCancelled.abort(); };
    };
    await activateRequesterPendingSession({ machineId: attribution.machineId,
      binding: { sessionId: target.sessionId, attribution },
      resolveRequesterSessionRuntimeContext: createResolveRuntime({ ...boundary, signal: reconnectCancelled.signal }),
      releaseRequesterSessionRuntimeContext: async context => { await context.dispose(); },
      resolveCurrentMachineExecutionOriginContext,
      spawnSessionForInternalResume: activation.spawnSessionForInternalResume });
    expect(reconnectCancelled.signal.aborted).toBe(true);
    expect(reports).toEqual([]);
    receiptTarget = { ...target, installationId: 'stale-installation' };
    refuseOnce(); await settle();
    expect(reports).toHaveLength(1);
    reports.length = 0;
    receiptTarget = target;
    sessionStatus = 403; nextSessionRead = () => { sessionStatus = 200; grant = false; };
    await settle();
    expect(reports).toHaveLength(1);
    reports.length = 0;
    grant = true;
    hint = { ...hint, requestedAt: 11 };
    const rejectionCount = rejected.length;
    refuseOnce(); await settle();
    hint = { ...hint, requestedAt: 12 };
    expect(reports).toEqual([{ requestId: 'input-1', requestedAt: 11, failureCode: 'runtime_start_failed' }]);
    expect(rejected).toHaveLength(rejectionCount);
    observedHomeId = 'srv_replacement_home';
    expect(await readRequesterPendingSessionActivation(recovery)).toBeNull();
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    observedHomeId = target.homeId;
    receiptTarget = { ...target, installationId: 'replacement' };
    expect(await readRequesterPendingSessionActivation(recovery)).toBeNull();
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    receiptTarget = target;
    grant = false;
    expect(await readRequesterPendingSessionActivation(recovery)).toMatchObject({ sessionId: target.sessionId, target });
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'activated' });
    expect(spawned).toHaveLength(2);
    expect(reads.filter(read => !read.path.endsWith('/admission/verify')).every(read => read.bearer === 'Bearer bob-private')).toBe(true);
    expect(reads.filter(read => read.path.endsWith('/admission/verify')).every(read => read.bearer === 'Bearer alice-daemon')).toBe(true);
  });
});
