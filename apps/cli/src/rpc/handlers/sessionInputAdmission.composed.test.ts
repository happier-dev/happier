import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionCreationTagV1, FeaturesResponseSchema, SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { configuration, reloadConfiguration } from '@/configuration';
import { decrypt, encrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { getDaemonMachineAdmissionTransport, installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials, type CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1, sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot, createSessionCreationTargetPreparationRpcResult, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { CapabilitiesDetectResponse } from '@/capabilities/types';
import { TeamSummaryV1Schema, resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { registerSessionSpawnNewRpcHandlers } from './sessionLifecycle';
import { createMachineSessionDirectTargetTransport } from './sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { cmdSessionCreate } from '@/cli/commands/session/create';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, projectExternalActionProjectSessionDefaultsEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { projectAdmittedExternalActionMachineContext } from '@/daemon/externalActions/execution';
import { createCliActionDeps, type SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
import { clearDaemonStateForTestTeardown, writeDaemonState, type StoredCredentials } from '@/persistence';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';

const boundary = vi.hoisted(() => ({ readCredentials: vi.fn(), readDaemonState: vi.fn(), createSocket: vi.fn() }));
// Filesystem credential/settings reads and HTTP requests are system boundaries.
// The RPC adapter, Action executor, creator, crypto and send admission stay real.
vi.mock('@/persistence', async (original) => ({
  ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: boundary.readCredentials,
  readDaemonState: boundary.readDaemonState,
}));
vi.mock('axios', async (original) => ({
  ...await original<typeof import('axios')>(),
  default: { ...(await original<typeof import('axios')>()).default, get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));
vi.mock('socket.io-client', async original => ({ ...await original<typeof import('socket.io-client')>(), io: boundary.createSocket }));

const secret = new Uint8Array(32).fill(7);
const accountCrypto = createAccountScopedCryptoMaterialSnapshotV1({
  accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret },
});
const credentials = {
  token: `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'account-admission-test', tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
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
  let accountMode: 'plain' | 'e2ee';
  let sessionRecord: ReturnType<typeof createSessionRecordFixture>;
  let fixtureHome: string;
  let envScope: ReturnType<typeof createEnvKeyScope>;
  let installation: Awaited<ReturnType<typeof readOrCreateInstallationIdentity>>;
  const readAccountHttp = (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/v1/features' || path === '/v1/features/authenticated') return FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_session_admission' } },
    });
    if (path === '/v1/account/profile') return { id: 'account-admission-test' };
    if (path === '/v1/account/encryption/currentness') return createAccountEncryptionCurrentnessFixture({
      mode: accountMode,
      contentKeyFingerprint: accountMode === 'e2ee'
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(accountCrypto.contentPublicKeyFingerprint) : null,
    });
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return ConnectedAccountCatalogRowReadResponseV1Schema.parse({
      status: 'present', revision: 0, content: sealConnectedAccountCatalogContentV1({
        mode: accountMode, material: accountMode === 'plain' ? null : accountCrypto.material,
        record: emptyConnectedAccountCatalogRecordV1('purposes'),
      }),
    });
    if (path === '/v1/account/encryption') return { mode: accountMode, updatedAt: 0 };
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] });
    if (path === `/v1/machines/${machineId}`) {
      const metadata = MachinePublishedMetadataV1Schema.parse({
        host: 'fixture', platform: process.platform, happyCliVersion: '0.0.0-test',
        homeDir: fixtureHome, happyHomeDir: fixtureHome,
        installationPublicKey: installation.publicKey,
      });
      return { machine: {
        ...createAvailableSessionSpawnMachineSnapshot(machineId), kind: 'persistent', active: true,
        installationId: installation.installationId, installationPublicKey: Buffer.from(installation.publicKey, 'base64url').toString('base64'),
        runnerContentKeyBinding: null,
        managedMachineRef: null, storageMode: accountMode,
        dataEncryptionKey: accountMode === 'e2ee' ? null : createAvailableSessionSpawnMachineSnapshot(machineId).dataEncryptionKey,
        metadata: accountMode === 'e2ee' ? encodeBase64(encrypt(secret, 'legacy', metadata)) : encodePlainMachineStoredContent(metadata), metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'account-admission-test', displayName: 'Test Account' },
          role: 'manage', resourceMode: accountMode, accessState: 'ready' },
      } };
    }
    if (path === '/v2/account/settings') return { version: 0, content: sealAccountSettingsV2RawContent({
      credentials: accountMode === 'plain' ? { ...credentials, encryption: null } : credentials,
      raw: {}, envelopeKind: accountMode === 'plain' ? 'plain' : 'encrypted',
      randomBytes,
    }) };
    if (path === `/v2/sessions/${sessionId}`) return { session: { ...createSessionNotificationContextFixture(sessionId), ...sessionRecord } };
    return undefined;
  };
  const fetchAccountHttp = async (input: string | URL | Request) => {
    const data = readAccountHttp(input instanceof Request ? input.url : String(input));
    return data === undefined ? new Response('', { status: 404 }) : Response.json(data);
  };
  const admitted: Parameters<CliActionMachineAdmissionTransport>[0][] = [];
  const transport: CliActionMachineAdmissionTransport = async (request) => {
    admitted.push(request);
    return { status: 'accepted', localId: request.localId };
  };
  function createMachineTransport() {
    const local = createLocalMachineActionTransportFixture(machineId);
    return { ...local, invoke: async (...args: Parameters<typeof local.invoke>) => {
      const [method, request] = args;
      if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
        || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) {
        return createSessionCreationTargetPreparationRpcResult(SessionCreationTargetPreparationRequestV1Schema.parse(request));
      }
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
          projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
            codex: { id: 'codex', title: 'Codex', capabilities: { sessions: {
              open: ['create'], delivery: ['newTurn'], cancel: true,
            } } },
          } } });
      }
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return {
        protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.2.3', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } },
      } satisfies CapabilitiesDetectResponse;
      return local.invoke(...args);
    } };
  }
  beforeEach(async () => {
    fixtureHome = await mkdtemp(join(tmpdir(), 'happier-input-admission-'));
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: fixtureHome });
    reloadConfiguration();
    installation = await readOrCreateInstallationIdentity();
    vi.clearAllMocks();
    admitted.length = 0;
    boundary.readCredentials.mockResolvedValue(credentials);
    await updateMachineRegistration(() => ({ machineId }));
    accountMode = 'e2ee';
    boundary.createSocket.mockImplementation(() => {
      return createApiSessionSocketStub({
      emitWithAck: async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return resolveApiSessionSocketDefaultAck(event, payload);
        const call = payload as SocketRpcRequestPayload;
        const content = accountMode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, cipher: {
          encryptRaw: async (value: unknown) => encodeBase64(encrypt(secret, 'legacy', value)),
          decryptRaw: async (value: string) => decrypt(secret, 'legacy', decodeBase64(value)),
        } };
        const decoded = await socketRpcCodec.decodeRequestParams(content, call.params, call.method);
        const method = call.method.startsWith(`${machineId}:`) ? call.method.slice(machineId.length + 1) : call.method;
        const result = await createMachineTransport().invoke(method, decoded.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
      },
      });
    });
    sessionRecord = createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'e2ee',
      metadata: encodeBase64(encrypt(secret, 'legacy', { machineId, permissionMode: 'yolo' })),
    });
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const data = readAccountHttp(String(url));
      if (data !== undefined) return { status: 200, data };
      throw new Error(`Unexpected HTTP GET: ${String(url)}`);
    });
    vi.mocked(axios.request).mockImplementation(async (request) => {
      if (!request.url) throw new Error('Expected fixture HTTP URL');
      if ((request.method ?? 'get').toLowerCase() === 'get') return axios.get(request.url, request);
      if (request.method?.toLowerCase() === 'post') return axios.post(request.url, request.data, request);
      throw new Error(`Unexpected HTTP method: ${request.method}`);
    });
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
      const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
      if (availability) return availability;
      if (String(url).endsWith('/v1/home/governance/get')) return { status: 200, data: { homeDefaults: null } };
      if (String(url).endsWith('/v1/teams/get')) return { status: 200, data: TeamSummaryV1Schema.parse({
        id: 'team-admission-test', name: 'Test Team', description: null, logo: null, archivedAt: null, recovery: null,
        policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed', defaultSessionHistoryAccess: 'from_membership',
          admissionMode: 'invite_only', authenticationPolicy: null, managedDefaults: null, homeDefaults: null },
        managedDefaultsGroupIds: [], viewerRole: 'owner', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
        admission: resolveTeamAdmissionProjectionV1(), counts: null,
      }) };
      if (String(url).endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (accountMode === 'plain' && String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) return { status: 200, data: { didWrite: true } };
      throw new Error(`Unexpected HTTP POST: ${String(url)}`);
    });
    // Fetch-based Account clients share the same HTTP fixture as Axios.
    vi.stubGlobal('fetch', fetchAccountHttp);
  });
  afterEach(async () => {
    release?.(); release = undefined;
    await clearDaemonStateForTestTeardown({ includeLockFile: false });
    vi.unstubAllGlobals();
    envScope.restore();
    reloadConfiguration();
    await rm(fixtureHome, { recursive: true, force: true });
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
            sessionRecord = createSessionRecordFixture({
              id: sessionId, active: true, encryptionMode: mode,
              metadata: mode === 'e2ee' ? encodeBase64(encrypt(secret, 'legacy', {
                machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
              })) : JSON.stringify({ machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence }),
            });
            if (launch) return await launch(request);
            return { type: 'success', sessionId, sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
          },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        },
      };
    registerSessionSpawnNewRpcHandlers({ rpcHandlerManager, sessionSpawnDirectTargetTransport,
      machineActionDirectTargetTransport: createMachineTransport() });
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
          sessionRecord = createSessionRecordFixture({
            id: sessionId, active: true, encryptionMode: 'e2ee',
            metadata: encodeBase64(encrypt(secret, 'legacy', {
              machineId, permissionMode: 'yolo', sessionCreationCorrespondenceV1: options.sessionCreationCorrespondence,
            })),
          });
          return { type: 'success', sessionId,
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        },
      });
      registerSessionSpawnNewRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
        machineActionDirectTargetTransport: createMachineTransport(),
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
      if (currentness === 'withdrawn') {
        // The real lifecycle owns the admission refusal; the registered RPC
        // returns the strict creation DTO consumed by the public Machine caller.
        expect(SessionSpawnNewResultV1Schema.parse(response)).toEqual({
          type: 'error', code: 'spawn_failed', retryable: true,
          launchError: { kind: 'launch_error', code: 'requester_machine_admission_unavailable',
            message: 'Requester Machine admission unavailable' },
        });
        expect(launched).toEqual([]);
        expect(admitted).toEqual([]);
        return;
      }
      const result = SessionSpawnNewResultV1Schema.parse(response);
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
    accountMode = 'plain';
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
    accountMode = 'plain';
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
    expect(vi.mocked(axios.post).mock.calls.filter(([url]) => String(url).includes('/sessions/'))).toEqual([]);
  }, 120_000);

  it.each(['plain', 'e2ee'] as const)('routes CLI create --prompt for a %s Account through Home-admitted daemon Actions', async (mode) => {
    const accountCredentials = mode === 'plain' ? { ...credentials, encryption: null } : credentials;
    boundary.readCredentials.mockResolvedValue(accountCredentials);
    accountMode = mode;
    const daemonState = { pid: process.pid, httpPort: 12345, controlToken: 'synthetic-control-token',
      startedAt: Date.now(), startedWithCliVersion: '0.0.0-test', machineId, accountId: 'account-admission-test' };
    // Explicit-Home daemon discovery reads this publication from disk before
    // dispatching the original Action through Home admission.
    writeDaemonState(daemonState);
    boundary.readDaemonState.mockResolvedValue(daemonState);
    const { sessionSpawnDirectTargetTransport } = registerSpawnBoundary(mode);
    const admittedRequests: unknown[] = [];
    let boundaryFailure: unknown;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:12345/ping') return Response.json({ status: 'ok' });
      return fetchAccountHttp(input);
    });
    const defaultPost = vi.mocked(axios.post).getMockImplementation();
    if (!defaultPost) throw new Error('Expected Account HTTP boundary');
    const createExecutor = (executorCredentials: StoredCredentials) => {
      const executor = createCliActionExecutorFromCredentials({
        credentials: executorCredentials, sessionSpawnDirectTargetTransport,
        machineActionDirectTargetTransport: createMachineTransport(),
        externalActionMachineInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: installation.privateKey,
      });
      // Mirror the installed HTTP executor's ingress through the canonical
      // projection of Home-admitted facts, including local directory preflight.
      return { ...executor, execute: (actionId: Parameters<typeof executor.execute>[0],
        input: unknown, context?: Parameters<typeof executor.execute>[2]) => executor.execute(actionId, input,
          projectAdmittedExternalActionMachineContext(context, machineId, mode)) };
    };
    vi.mocked(axios.post).mockImplementation(async (url, raw, config) => {
      try {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/actions/session.spawn_new/execution-authorization/verify') return { status: 200, data: { ok: true } };
      if (path !== '/v1/actions/session.spawn_new/execution-authorization' && path !== '/v1/actions/session.spawn_new') {
        return defaultPost(url, raw, config);
      }
      expect(config?.headers?.Authorization).toBe(`Bearer ${accountCredentials.token}`);
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
       const projectSessionDefaultsAdmission = projectExternalActionProjectSessionDefaultsEnvelopeAdmissionV1({
         actionId: 'session.spawn_new', envelope: request.envelope,
       });
      if (path.endsWith('/execution-authorization')) return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'home-session-spawn-proof', binding: {
          accountId: 'account-admission-test', authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: 'srv_session_admission', machineId, custodianAccountId: 'account-admission-test',
          installationId: installation.installationId, actionId: 'session.spawn_new',
          requestId: request.envelope.requestId, target: request.envelope.target,
          accountEncryptionMode: mode, admittedMachineRole: 'manage',
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
           ...(projectSessionDefaultsAdmission === undefined ? {} : { projectSessionDefaultsAdmission }),
           ...(request.envelope.v === 2 && request.envelope.machineRuntimeDemand !== undefined
             ? { machineRuntimeDemand: request.envelope.machineRuntimeDemand } : {}),
        },
      }) };
      admittedRequests.push(request);
      release = installDaemonMachineAdmissionTransport({ serverId: configuration.activeServerId, transport });
      const execution = await executeExternalAction({
        actionId: 'session.spawn_new', envelope: request.envelope, executionAuthorization: request.executionAuthorization,
        principal: { accountId: 'account-admission-test', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
        currentMachineId: machineId, currentServerId: configuration.activeServerId,
        currentAccountId: 'account-admission-test', currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: installation.privateKey,
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId: installation.installationId, privateKey: installation.privateKey,
          serverHttpBaseUrl: configuration.serverUrl }),
        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({
          ...input, purpose: { kind: 'external_action' }, machineId, installationId: installation.installationId,
          installationPrivateKey: decodeBase64(installation.privateKey, 'base64url'),
          serverId: configuration.activeServerId, serverIdentityId: 'srv_session_admission', serverHttpBaseUrl: configuration.serverUrl,
          ownCredentials: accountCredentials, isCurrent: async () => true,
          createExecutor: context => createExecutor(context.credentials),
        }),
        resolveTarget: async ({ target }) => target ?? null,
        executor: createExecutor(accountCredentials),
      });
      if (execution.kind === 'invalid_request') throw new Error(`Home-admitted Action refused: ${execution.errorCode}`);
      return { status: 200, data: execution.response };
      } catch (error) { boundaryFailure = error; throw error; }
    });
    const output = captureStdoutJsonOutput<unknown>();
    try {
      await cmdSessionCreate(['create', '--machine-id', machineId, '--agent', 'codex', '--connected-services-json', '{"v":2,"bindingsByServiceId":{}}', '--prompt', 'CLI first prompt', '--spawn-attempt-id', 'r9-cli-spawn', '--json'], {
        readCredentialsFn: async () => accountCredentials,
      });
      if (boundaryFailure) throw boundaryFailure;
      const envelope = output.json();
      expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true, kind: 'session_create', data: { session: { id: sessionId } } });
      expect(admittedRequests).toEqual([expect.objectContaining({
        executionAuthorization: expect.objectContaining({ binding: expect.objectContaining({ actionId: 'session.spawn_new', requestId: 'r9-cli-spawn' }) }),
        envelope: expect.objectContaining({ requestId: 'r9-cli-spawn', target: { kind: 'machine', machineId } }),
      })]);
      expect(admitted).toHaveLength(mode === 'e2ee' ? 1 : 0);
      if (mode === 'e2ee') {
        const content = admitted[0]?.content;
        expect(content?.t).toBe('encrypted');
        if (content?.t !== 'encrypted') throw new Error('Expected protected CLI initial input');
        expect(decrypt(secret, 'legacy', decodeBase64(content.c))).toMatchObject({ content: { text: 'CLI first prompt' } });
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

  it('preserves a typed Home admission outage from the native runner SessionHandle.send entry point', async () => {
    const defaultPost = vi.mocked(axios.post).getMockImplementation();
    if (!defaultPost) throw new Error('Expected Account HTTP boundary');
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/actions/session.message.send/execution-authorization') {
        return { status: 503, data: { error: 'server_unavailable' } };
      }
      return defaultPost(url, body, config);
    });
    const { createNativeAgentSessionServices } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions');
    const services = createNativeAgentSessionServices({
      credentials, permissionHandler: null, pluginId: 'acme.agent', contributionId: 'runtime',
      runtimeId: 'acme.agent/runtime', sessionId, occurrenceId: 'occurrence-current',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-current', installSource: 'npm' },
      isCurrent: () => true, signal: new AbortController().signal,
    });
    if (!services.sessions.current) throw new Error('Expected the native runner Session handle');
    await expect(services.sessions.current.send({ kind: 'userText', text: 'runner protected input', idempotencyKey: 'runner-input' }))
      .resolves.toEqual({ status: 'rejected', code: 'session_input_target_unavailable',
        failureCause: { phase: 'session.message.requester_dispatch', errorClass: 'UnknownThrownValue',
          errorCode: 'server_unavailable', httpStatus: null } });
    expect(admitted).toEqual([]);
  });
});
