import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionCreationTagV1, SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import { decrypt, encrypt, encodeBase64 } from '@/api/encryption';
import { getDaemonMachineAdmissionTransport, installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials, type CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { registerSessionSpawnNewRpcHandlers } from './sessionLifecycle';
import { createMachineSessionDirectTargetTransport } from './sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { cmdSessionCreate } from '@/cli/commands/session/create';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { SIGNED_ROOT_ACTION_EXECUTE_PATH, SignedRootActionExecuteRequestSchema } from '@/daemon/externalActions/signedRootActionControl';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createCliActionDeps, type SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import { createSessionStartupReadinessHandler } from '@/daemon/startup/sessionStartupReadiness';
import { waitForSessionWebhook } from '@/daemon/spawn/waitForSessionWebhook';
import { hashProcessCommand, promoteSessionMarkerPid, readSessionMarker, writeSessionMarker } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '@/daemon/processSupervision/sessionRunnerRespawnDescriptor';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const boundary = vi.hoisted(() => ({ readCredentials: vi.fn(), readSettings: vi.fn(), readDaemonState: vi.fn(), fetchSession: vi.fn(), currentness: vi.fn() }));
// Filesystem credential/settings reads and HTTP requests are system boundaries.
// The RPC adapter, Action executor, creator, crypto and send admission stay real.
vi.mock('@/persistence', async (original) => ({
  ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: boundary.readCredentials,
  readSettings: boundary.readSettings,
  readDaemonState: boundary.readDaemonState,
}));
vi.mock('axios', async (original) => ({
  ...await original<typeof import('axios')>(),
  default: { ...(await original<typeof import('axios')>()).default, get: vi.fn(), post: vi.fn() },
}));
vi.mock('@/session/transport/http/sessionsHttp', async (original) => ({
  ...await original<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: boundary.fetchSession,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (original) => ({
  ...await original<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: boundary.currentness,
}));
vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: async () => ({ state: 'valid' }),
}));

const secret = new Uint8Array(32).fill(7);
const credentials = {
  token: `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'account-admission-test' })).toString('base64url')}.signature`,
  credentialProvenance: 'stored_session' as const,
  encryption: { type: 'legacy' as const, secret },
};
const sessionId = 'session-admission-composed';
const machineId = 'machine-admission-composed';
const agentContext = {
  surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
  callerPermissionMode: 'yolo',
  causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
  sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn-source', via: 'action' },
} as const satisfies ActionExecutorContext;

describe('daemon RPC to protected Session input admission composition', () => {
  let release: (() => void) | undefined;
  const admitted: Parameters<CliActionMachineAdmissionTransport>[0][] = [];
  const transport: CliActionMachineAdmissionTransport = async (request) => {
    admitted.push(request);
    return { status: 'accepted', localId: request.localId };
  };
  beforeEach(() => {
    vi.clearAllMocks();
    admitted.length = 0;
    boundary.readCredentials.mockResolvedValue(credentials);
    boundary.readSettings.mockResolvedValue({ machineId });
    boundary.currentness.mockResolvedValue(createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    boundary.fetchSession.mockResolvedValue(createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'e2ee',
      metadata: encodeBase64(encrypt(secret, 'legacy', { machineId, permissionMode: 'yolo' })),
    }));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/settings')) return { status: 200, data: { settings: null, settingsVersion: 0 } };
      throw new Error(`Unexpected HTTP GET: ${String(url)}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (String(url).endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      throw new Error(`Unexpected HTTP POST: ${String(url)}`);
    });
    // Feature fetch is the other network boundary. No server is contacted.
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  });
  afterEach(async () => {
    release?.(); release = undefined;
    await clearDaemonStateForTestTeardown({ includeLockFile: false });
    vi.unstubAllGlobals();
  });

  function registerSpawnBoundary(mode: 'plain' | 'e2ee' = 'e2ee', launch?: SessionSpawnDirectTargetTransport['spawnedSession']['spawn']) {
    const handlers = new Map<string, RpcHandler>();
    let spawned = false;
    const rpcHandlerManager: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    // Exact daemon spawn/OS boundary; preparation and row settlement below
    // exercise the real creator and first-turn sender.
    const sessionSpawnDirectTargetTransport: SessionSpawnDirectTargetTransport = {
        machineId,
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: {
          spawn: async (request) => {
            spawned = true;
            boundary.fetchSession.mockResolvedValue(createSessionRecordFixture({
              id: sessionId, active: true, encryptionMode: mode,
              metadata: mode === 'e2ee' ? encodeBase64(encrypt(secret, 'legacy', {
                machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
              })) : JSON.stringify({ machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence }),
            }));
            if (launch) return await launch(request);
            return { type: 'success', sessionId, sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
          },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        },
      };
    registerSessionSpawnNewRpcHandlers({ rpcHandlerManager, sessionSpawnDirectTargetTransport });
    const spawn = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
    expect(spawn).toBeDefined();
    // The authenticated human RPC ingress stamps this authority; an unstamped
    // automation RPC cannot claim the human creation namespace.
    const spawnHumanInput: RpcHandler = (input) => spawn!(input, {
      signal: new AbortController().signal,
      callerAuthority: 'present_user',
    });
    return { spawn: spawnHumanInput, sessionSpawnDirectTargetTransport, wasSpawned: () => spawned };
  }

  function spawnInput() {
    return SessionSpawnNewInputV2Schema.parse({
      creationKey: 'composed-spawn', executionTarget: { serverId: configuration.activeServerId, machineId },
      directory: { kind: 'path', path: '/repo' }, organizationPlacement: { folderId: null, tagIds: [] },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: 'first protected prompt' },
    });
  }

  it.each([
    { requester: 'owner', currentness: 'current' },
    { requester: 'owner', currentness: 'withdrawn' },
    { requester: 'member', currentness: 'current' },
  ] as const)('retains original $requester Machine admission through public Team Session creation ($currentness at launch)', async ({ requester, currentness }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-spawn-requester-seam-'));
    const launched: SpawnSessionOptions[] = [];
    let admissionCurrent = true;
    try {
      release = installDaemonMachineAdmissionTransport({ serverId: configuration.activeServerId, transport });
      const handlers = new Map<string, RpcHandler>();
      const lifecycle = createSpawnNewSessionLifecycleActionHandler({
        serverId: configuration.activeServerId,
        // OS launch is the boundary. RPC admission, Action execution, creation,
        // direct transport and lifecycle attribution all use their real owners.
        spawnSession: async options => {
          launched.push(options);
          boundary.fetchSession.mockResolvedValue(createSessionRecordFixture({
            id: sessionId, active: true, encryptionMode: 'e2ee',
            metadata: encodeBase64(encrypt(secret, 'legacy', {
              machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: options.sessionCreationCorrespondence,
            })),
          }));
          return { type: 'success', sessionId,
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        },
      });
      registerSessionSpawnNewRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
        sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId,
          spawnLifecycleHandler: async (request, context) => {
            // Withdraw after real target/creation preparation, immediately before
            // lifecycle admission: the original verifier must still govern launch.
            admissionCurrent = currentness === 'current';
            return await lifecycle(request, context);
          },
        }),
      });
      const spawn = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
      if (!spawn) throw new Error('Expected public Session creation RPC');
      const machineAdmission = {
        actorAccountId: requester === 'owner' ? 'account-admission-test' : 'member-admission-test',
        custodianAccountId: 'account-admission-test',
        machineId, installationId: 'installation-admission-test', role: 'manage', encryptionMode: 'e2ee',
      } as const;
      const response = await spawn({
        ...spawnInput(), directory: { kind: 'path', path: directory },
        primaryTeamId: 'team-admission-test',
        teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
          resourceId: '11111111-1111-4111-8111-111111111111', expectedResourceRevision: 0,
          deliveryMode: 'brokered', teamId: 'team-admission-test' }],
      }, {
        signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission, verifyMachineAdmissionCurrent: async () => admissionCurrent,
      });
      if (requester === 'member') {
        expect(response).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(launched).toEqual([]);
        expect(admitted).toEqual([]);
        return;
      }
      const result = SessionSpawnNewResultV1Schema.parse(response);
      if (currentness === 'withdrawn') {
        expect(result).toMatchObject({ type: 'error', code: 'incompatible_target',
          incompatibleTarget: { reason: 'daemon_rpc_unavailable' }, retryable: false });
        expect(launched).toEqual([]);
        expect(admitted).toEqual([]);
        return;
      }
      expect(result).toMatchObject({ type: 'success', sessionId, initialInput: { status: 'accepted' } });
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({ requesterWorkAttributionV1: {
        serverId: configuration.activeServerId, accountId: machineAdmission.actorAccountId,
        machineId, installationId: machineAdmission.installationId,
      }, verifyRequesterMachineAdmissionCurrent: expect.any(Function) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('settles wrapper startup through canonical readiness, then produces strict success with admitted input', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-spawn-readiness-seam-'));
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    Object.defineProperty(configuration, 'happyHomeDir', { ...originalHome, value: home });
    const wrapperPid = 649131;
    const runnerPid = 649132;
    const readIdentity = async (pid: number) => ({
      pid, processStartTimeMs: pid === wrapperPid ? 12_345 : 23_456,
      command: pid === wrapperPid ? '/runtime/scope-exit' : `/runtime/versions/1.2.3/bin/happier codex --existing-session ${sessionId}`,
    });
    try {
      release = installDaemonMachineAdmissionTransport({ serverId: configuration.activeServerId, transport });
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing });
      const binding = createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'happier.agent.codex', pluginVersion: '1.2.3', agentId: 'codex', localAgentId: 'codex',
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: '1.2.3' } },
        locator: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 }, normalizedModulePath: 'agent.mjs', loadMode: 'immutable-js',
      });
      const { spawn } = registerSpawnBoundary('e2ee', async (request) => {
        const tracked: TrackedSession = {
          trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: `PID-${wrapperPid}`,
          processStartTimeMs: 12_345, processCommandHash: hashProcessCommand((await readIdentity(wrapperPid)).command),
          agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
          runnerAgentBootstrapIdentity: { agentId: binding.agentId, backendId: binding.agentId },
          acceptedSpawnMarkerGate: Promise.resolve(true),
          spawnOptions: request,
        };
        const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(tracked.spawnOptions!);
        if (!respawn) throw new Error('Expected canonical fixture respawn descriptor');
        await writeSessionMarker({
          trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, happySessionId: tracked.happySessionId!, startedBy: 'daemon', cwd: '/repo',
          processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash, respawn,
        });
        const sessions = new Map([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
        const awaiters = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
        const completed = waitForSessionWebhook({
          trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters,
          spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(), timeoutErrorMessage: 'Fixture startup did not settle',
        });
        const report = createSessionStartupReadinessHandler({
          onHappySessionWebhook: createOnHappySessionWebhook({
            trackedSessionsByKey: sessions, spawnAwaiterByKey: awaiters, getParentPidFn: () => wrapperPid,
            readProcessIdentityByPidFn: readIdentity, readCredentialsFn: async () => null,
            promoteSessionMarkerFn: (params) => promoteSessionMarkerPid(params, { readProcessIdentityByPidFn: readIdentity }),
          }),
          reconcileCanonicalReadiness: async (candidate) => {
            // The catalog fixture comes from its canonical binding producer; authority,
            // generation fences and persisted marker attachment execute their real owners.
            await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
              happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing, httpPort: 3210,
              sessionId, tracked: candidate, resolveCurrentRetainedAgent: async () => binding, readProcessIdentityByPidFn: readIdentity,
            });
          },
          reconcileFollowUp: async () => {}, onFollowUpError: error => { throw error; },
        });
        const reporting = report(sessionId, {
          path: '/repo', host: 'fixture', homeDir: home, happyHomeDir: home, happyLibDir: home, happyToolsDir: home,
          hostPid: runnerPid, startedBy: 'daemon', machineId,
        }, undefined, { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } });
        // Failure still settles the real waiter; observe it before reporting the error.
        const outcomes = await Promise.allSettled([reporting, completed]);
        if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
        if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
        expect(await readSessionMarker(tracked.trackingKey)).toMatchObject({
          pid: runnerPid,
          happySessionId: sessionId, processStartTimeMs: 23_456, runnerAgentSourceCustodyV1: binding.sourceCustody,
        });
        expect(tracked.processStartTimeMs).toBe(12_345);
        return outcomes[1].value;
      });
      // This is the production RPC producer's output parsed by the exact UI consumer.
      const result = SessionSpawnNewResultV1Schema.parse(await spawn(spawnInput()));
      expect(result).toMatchObject({ type: 'success', sessionId, disposition: 'created', initialInput: { status: 'accepted' } });
      expect(admitted).toHaveLength(1);
      expect(admitted[0].sessionId).toBe(sessionId);
    } finally {
      Object.defineProperty(configuration, 'happyHomeDir', originalHome);
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it('admits RPC spawn initialInput, causal follow-up and execution-run recipient through the process-owned socket', async () => {
    release = installDaemonMachineAdmissionTransport({ serverId: configuration.activeServerId, transport });
    const { spawn } = registerSpawnBoundary();
    const result = await spawn(spawnInput());
    expect(result).toMatchObject({ type: 'success', sessionId, initialInput: { status: 'accepted', localId: expect.any(String) } });
    const machineAdmissionTransport = getDaemonMachineAdmissionTransport(configuration.activeServerId);
    if (!machineAdmissionTransport) throw new Error('Expected the process-owned Machine transport');
    // Causal sends belong to a Session host with its current admitted work
    // facts, not a standalone credential-only CLI executor.
    const executor = createCliActionExecutor({
      credentials, token: credentials.token, sessionId, mode: 'e2ee',
      ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
      getCurrentSessionWorkDepth: () => 0,
      getCurrentTurnWorkDepth: (turnId) => turnId === agentContext.sessionInputSource.sourceTurnId ? 0 : undefined,
      machineAdmissionTransport,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(undefined) },
    });
    for (const recipient of [undefined, { kind: 'execution_run' as const, runId: 'run-nested' }]) {
      const localId = recipient ? 'nested-input' : 'follow-up-input';
      await expect(executor.execute('session.message.send', {
        sessionId, message: localId, localId, ...(recipient ? { recipient } : {}),
      }, agentContext)).resolves.toMatchObject({ ok: true, result: { status: 'accepted', localId } });
    }
    expect(admitted).toHaveLength(3);
    expect(admitted.map((request) => request.targetMachineId)).toEqual([machineId, machineId, machineId]);
    expect(admitted[2]).toMatchObject({ v: 2, recipient: { kind: 'execution_run', runId: 'run-nested' } });
    const opened = admitted.map((request) => {
      expect(request.content.t).toBe('encrypted');
      if (request.content.t !== 'encrypted') throw new Error('Expected protected ciphertext');
      return decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(request.content.c, 'base64')));
    });
    expect(opened).toEqual([
      expect.objectContaining({ content: { type: 'text', text: 'first protected prompt' } }),
      expect.objectContaining({ content: { type: 'text', text: 'follow-up-input' } }),
      expect.objectContaining({ content: { type: 'text', text: 'nested-input' } }),
    ]);
    expect(vi.mocked(axios.post).mock.calls.every(([url]) => !String(url).includes('/pending'))).toBe(true);
  }, 120_000);

  it('rejects RPC spawn with protected initialInput before launching when the admission transport is absent', async () => {
    const { spawn, wasSpawned } = registerSpawnBoundary();
    await expect(spawn(spawnInput())).resolves.toMatchObject({
      ok: false, errorCode: 'DAEMON_RPC_UNAVAILABLE', error: expect.stringContaining('daemon public Action'),
    });
    expect(wasSpawned()).toBe(false);
    expect(admitted).toEqual([]);
  }, 120_000);

  it('admits a plain Account human initial prompt without a Machine transport', async () => {
    boundary.readCredentials.mockResolvedValue({ ...credentials, encryption: null });
    boundary.currentness.mockResolvedValue(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (String(url).endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) return { status: 200, data: { didWrite: true } };
      throw new Error(`Unexpected HTTP POST: ${String(url)}`);
    });
    const { spawn, wasSpawned } = registerSpawnBoundary('plain');
    await expect(spawn(spawnInput())).resolves.toMatchObject({
      type: 'success', sessionId, initialInput: { status: 'accepted' },
    });
    expect(wasSpawned()).toBe(true);
    expect(admitted).toEqual([]);
    const pendingBody = vi.mocked(axios.post).mock.calls.find(([url]) => String(url).endsWith('/pending'))?.[1];
    expect(pendingBody).toMatchObject({ content: { t: 'plain', v: { content: { text: 'first protected prompt' } } } });
  }, 120_000);

  it('still refuses a plain Account plugin initial prompt before creation without Machine admission', async () => {
    const plainCredentials = { ...credentials, encryption: null };
    boundary.currentness.mockResolvedValue(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    const deps = createCliActionDeps({ token: credentials.token, credentials: plainCredentials, sessionId, mode: 'plain', ctx: null });
    const input = spawnInput();
    if (!input.creationKey) throw new Error('Expected fixture creation key');
    await expect(deps.sessionSpawnNew({
      ...input,
      creationKey: input.creationKey,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'plugin:acme.agent', creationKey: 'plugin-plain-test' }),
      actionCaller: { kind: 'plugin', pluginId: 'acme.agent', contributionLocalId: 'spawn' },
      callerSurface: 'plugin',
    })).rejects.toMatchObject({ code: 'DAEMON_RPC_UNAVAILABLE' });
    expect(admitted).toEqual([]);
    expect(vi.mocked(axios.post).mock.calls).toEqual([]);
  }, 120_000);

  it.each(['plain', 'e2ee'] as const)('routes CLI create --prompt for a %s Account through signed daemon Actions', async (mode) => {
    const accountCredentials = mode === 'plain' ? { ...credentials, encryption: null } : credentials;
    boundary.readCredentials.mockResolvedValue(accountCredentials);
    boundary.currentness.mockResolvedValue(createAccountEncryptionCurrentnessFixture({ mode }));
    const daemonState = { pid: process.pid, httpPort: 12345, controlToken: 'synthetic-control-token',
      startedAt: Date.now(), startedWithCliVersion: '0.0.0-test', machineId, accountId: 'account-admission-test' };
    // Explicit-Home daemon discovery reads the publication from disk; the control
    // HTTP boundary below consumes the same state through its credential port.
    writeDaemonState(daemonState);
    boundary.readDaemonState.mockResolvedValue(daemonState);
    const { sessionSpawnDirectTargetTransport } = registerSpawnBoundary(mode);
    const signedRequests: unknown[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith(SIGNED_ROOT_ACTION_EXECUTE_PATH)) return new Response('', { status: 404 });
      const request = SignedRootActionExecuteRequestSchema.parse(JSON.parse(String(init?.body)));
      signedRequests.push(request);
      expect(new Headers(init?.headers).get('x-happier-daemon-token')).toBe('synthetic-control-token');
      // The authenticated daemon owns its Machine socket, after CLI dispatch.
      release = installDaemonMachineAdmissionTransport({ serverId: configuration.activeServerId, transport });
      // Signed root control invokes the Action owner directly. RPC's stricter
      // creation-key envelope is a different ingress and cannot stand in for it.
      const executor = createCliActionExecutorFromCredentials({
        credentials: accountCredentials, sessionSpawnDirectTargetTransport,
      });
      const execution = await executeExternalAction({
        actionId: request.actionId,
        envelope: {
          v: 1, input: request.input,
          ...(request.target ? { target: request.target } : {}),
          ...(request.actionRequestId ? { requestId: request.actionRequestId } : {}),
        },
        principal: { authority: 'present_user' }, surface: 'cli',
        currentMachineId: machineId, currentServerId: configuration.activeServerId,
        resolveTarget: async ({ target }) => target ?? null,
        executor,
      });
      if (execution.kind === 'invalid_request' || execution.response.v !== 1) {
        throw new Error('Expected a valid signed root Action response');
      }
      return Response.json(execution.response.execution);
    });
    vi.mocked(axios.post).mockImplementation(async (url) => {
      if (String(url).endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (mode === 'plain' && String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) return { status: 200, data: { didWrite: true } };
      throw new Error(`Unexpected HTTP POST: ${String(url)}`);
    });
    const output = captureStdoutJsonOutput<unknown>();
    try {
      await cmdSessionCreate(['create', '--machine-id', machineId, '--agent', 'codex', '--connected-services-json', '{"v":2,"bindingsByServiceId":{}}', '--prompt', 'CLI first prompt', '--spawn-attempt-id', 'r9-cli-spawn', '--json'], {
        readCredentialsFn: async () => accountCredentials,
      });
      const envelope = output.json();
      expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true, kind: 'session_create', data: { session: { id: sessionId } } });
      expect(signedRequests).toEqual([expect.objectContaining({
        actionId: 'session.spawn_new', actionRequestId: 'r9-cli-spawn',
        target: { kind: 'machine', machineId }, input: expect.objectContaining({ initialInput: { text: 'CLI first prompt' } }),
      })]);
      expect(admitted).toHaveLength(mode === 'e2ee' ? 1 : 0);
      if (mode === 'e2ee') {
        expect(admitted[0]?.content.t).toBe('encrypted');
      } else {
        const pendingBody = vi.mocked(axios.post).mock.calls.find(([url]) => String(url).endsWith('/pending'))?.[1];
        expect(pendingBody).toMatchObject({ content: { t: 'plain', v: { content: { text: 'CLI first prompt' } } } });
      }
    } finally {
      output.restore();
    }
  }, 120_000);

  it('refuses a standalone causal executor without the Session host admission witnesses', async () => {
    const executor = createCliActionExecutorFromCredentials({
      credentials, actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(undefined) },
    });
    await expect(executor.execute('session.message.send', { sessionId, message: 'protected child input', localId: 'child-input' }, agentContext))
      .resolves.toMatchObject({ ok: true, result: { status: 'rejected', code: 'session_input_untrusted_assertion' } });
    expect(admitted).toEqual([]);
    expect(vi.mocked(axios.post).mock.calls.every(([url]) => !String(url).includes('/pending'))).toBe(true);
  });

  it('refuses construction of a daemon-hosted executor without its process transport', () => {
    const previousArgv = process.argv;
    try {
      process.argv = [previousArgv[0]!, previousArgv[1]!, 'daemon', 'start-sync'];
      reloadConfiguration();
      expect(configuration.isDaemonProcess).toBe(true);
      expect(() => createCliActionExecutorFromCredentials({ credentials }))
        .toThrow(expect.objectContaining({ code: 'machine_admission_transport_unavailable' }));
      expect(() => createCliActionExecutorFromCredentials({ credentials, machineAdmissionTransport: transport }))
        .toThrow(expect.objectContaining({ code: 'machine_admission_transport_unavailable' }));
    } finally {
      process.argv = previousArgv;
      reloadConfiguration();
    }
  });

  it('surfaces a definite actionable PluginError from the native runner SessionHandle.send entry point', async () => {
    const { createNativeAgentSessionServices } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions');
    const services = createNativeAgentSessionServices({
      credentials, permissionHandler: null, pluginId: 'acme.agent', contributionId: 'runtime',
      runtimeId: 'acme.agent/runtime', sessionId, occurrenceId: 'occurrence-current',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-current', installSource: 'npm' },
      isCurrent: () => true, signal: new AbortController().signal,
    });
    if (!services.sessions.current) throw new Error('Expected the native runner Session handle');
    await expect(services.sessions.current.send({ kind: 'userText', text: 'runner protected input', idempotencyKey: 'runner-input' }))
      .rejects.toMatchObject({ code: 'machine_admission_transport_unavailable', message: expect.stringContaining('daemon'), retryable: true });
    expect(admitted).toEqual([]);
  });
});
