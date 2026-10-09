import { mkdtemp, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol/sessions/fork';
import { SessionContinueWithReplayRpcParamsSchema } from '@happier-dev/protocol/sessions/continueWithReplay';
import { createContinueWithReplayLifecycleActionHandler } from '@/session/actions/lifecycle/createContinueWithReplayLifecycleActionHandler';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/lifecycle/createStopSessionLifecycleActionExecutor';
import { loadSessionHandoffRemoteMetadata, registerMachineSessionHandoffRpcHandlers } from '@/api/machine/sessionHandoff/handlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { probeAlreadyRunningExistingSessionServiceability } from '@/daemon/startup/pendingQueueNudge';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';
import { createForkSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createForkSessionLifecycleActionHandler';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { decodeStoredCredentials, encodeStoredCredentials, type Credentials } from '@/persistence';
import { createTrackedSessionHandoffCoordinator } from '@/daemon/actionOperations/createTrackedSessionHandoffCoordinator';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { replacePrivateBearerFile, writePrivateOwnerFile } from '../privateBearerFile';
import { deriveSettingsSecretsKeyForCredentials, deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { encryptSecretStringV1, decryptSecretStringWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import * as requesterCredentialOwner from './requesterSessionCredentials';
import {
  admitRequesterSessionBootstrap, prepareRequesterSessionBootstrap, createRequesterSessionCredentialCustody,
  resolveRequesterSessionBootstrap, verifyRequesterSessionMachineAdmissionCurrent,
  resolveRequesterSessionCredentials, readRequesterSessionCredentialsForChild,
  listRequesterSessionCredentialBindings, requesterSessionCredentialPath, REQUESTER_SESSION_ID_ENV,
  type RequesterSessionMachineAdmissionBoundary,
} from './requesterSessionCredentials';

// Genuine socket boundary: these custody tests do not establish runner availability.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Runner socket unavailable'); } }));

const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
const credentials = { token: 'bob-ordinary', encryption: null } as const;
const origin = 'http://requester-home.test';
let app: FastifyInstance | undefined;
let restore: (() => void) | undefined;
let directory: string | undefined;
let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
afterAll(async () => { await runtimeFixture?.dispose(); runtimeFixture = undefined; });
afterEach(async () => {
  restore?.(); restore = undefined;
  await app?.close(); app = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function home(options: Readonly<{ sessionId?: string; creationMachineId?: string; bot?: boolean }> = {}) {
  const sessionId = options.sessionId ?? 'session';
  directory = await mkdtemp(join(tmpdir(), 'requester-custody-'));
  app = fastify();
  const keyPair = tweetnacl.sign.keyPair();
  let installationId = 'installation';
  let accountId = 'bob';
  let access = true;
  let accountMode: 'plain' | 'e2ee' = 'plain';
  let sessionRole: 'owner' | 'view' = 'owner';
  let loseDuringVerification = false;
  const requests: Array<{ path: string; bearer: string | undefined }> = [];
  app.addHook('onRequest', async request => { requests.push({ path: request.url, bearer: request.headers.authorization }); });
  app.get('/v1/account/profile', async () => ({ id: accountId }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: accountMode, version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v1/machines/machine/access', async (_request, reply) => access ? {
    machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
    access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
    canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
  } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
  app.post('/v1/machines/machine/admission/verify', async (request, reply) => {
    // The network adapter is the external Home boundary; the real signer and verifier remain in-process.
    const body = request.body as { context: SocketRpcMachineAdmissionContextV1; method?: string;
      purpose?: { kind: 'requester_session_currentness'; sessionId: string };
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    if (!body?.context || !body.method && !body.purpose) throw new Error('Missing fresh C41 request');
    if (body.method !== undefined || body.purpose?.kind !== 'requester_session_currentness'
      || body.purpose.sessionId !== sessionId) return reply.code(403).send({ error: 'wrong_currentness_purpose' });
    const valid = verifyMachineInstallationProof({ publicKey: keyPair.publicKey, proof: body.proof,
      payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId: 'installation',
        rpcAdmission: { context: body.context, purpose: body.purpose } } });
    expect(body.context.actorAccountId).toBe('bob');
    if (loseDuringVerification) installationId = 'replacement';
    return valid && access ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
  });
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`,
    recipe: { execution: { machineId: options.creationMachineId ?? 'machine', directory: { kind: 'path', path: '/workspace' } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
      ...(options.bot ? { identity: { bot: { kind: 'bot' }, createdAsBot: true } } : {}),
      configuration: null, connectedServices: null, mcpSelection: null, transcriptStorage: null,
      terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
  app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({ id: sessionId,
    encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/workspace', codexSessionId: 'same-native-session',
      ...(options.bot ? { bot: { kind: 'bot' }, createdAsBot: true } : {}),
      sessionCreationCorrespondenceV1: correspondence }), dataEncryptionKey: null,
    share: sessionRole === 'owner' ? null : { accessLevel: 'view', canApprovePermissions: false },
  }) }));
  app.get(`/v1/access-keys/${sessionId}/machine`, async () => ({ accessKey: { id: 'existing' } }));
  await app.ready();
  restore = installAxiosFastifyAdapter({ app, origin });
  const boundary: RequesterSessionMachineAdmissionBoundary = { machineId: 'machine', daemonToken: 'alice-daemon',
    isHomeCurrent: () => true, readInstallation: () => ({ installationId, privateKey: keyPair.secretKey }) };
  return { boundary, requests, correspondence, setAccess: (value: boolean) => { access = value; },
    setAccountId: (value: string) => { accountId = value; }, setAccountMode: (value: 'plain' | 'e2ee') => { accountMode = value; },
    setSessionRole: (value: 'owner' | 'view') => { sessionRole = value; },
    replaceDuringVerification: () => { loseDuringVerification = true; } };
}

describe('requester Session lifecycle custody', () => {
  it('signs the exact requester Session currentness purpose without pretending to spawn a Session', async () => {
    const host = await home();
    expect(await verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary })).toBe(true);
  });
  it('admits the handoff private carrier before the existing target workflow without borrowing destination Account credentials', async () => {
    const host = await home({ creationMachineId: 'source-machine' });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => undefined,
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
        resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: current }) });
    const registration = { rpcHandlerManager: rpc, runtimeConfig: { activeServerDir: directory! },
      requesterBootstrapBoundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_requester_home' } };
    registerMachineSessionHandoffRpcHandlers(registration);
    const before = host.requests.length;
    const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`,
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      params: { kind: 'requester_session_handoff_bootstrap_v1', input: { handoffId: 'handoff', operationId: 'prepare',
        sessionId: 'session', sourceMachineId: 'source-machine', targetMachineId: 'machine',
        negotiatedTransportStrategy: 'direct_peer', sourceSessionStorageMode: 'persisted', targetPath: '/destination',
        handoffMetadataV2: { agentBundleTransferPublication: { transferId: 'session-handoff:handoff:agent-bundle-file',
          sizeBytes: 0, manifestHash: `sha256:${'0'.repeat(64)}` } } },
      requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials({ ...credentials }) } } });
    // The existing workflow owns the transport refusal; admission must not replace it with ambient auth failure.
    expect(result).toMatchObject({ ok: false, errorCode: 'direct_peer_transfer_unavailable' });
    const reads = host.requests.slice(before).filter(request => request.path !== '/v1/machines/machine/admission/verify');
    expect(reads.some(request => request.path.startsWith('/v2/sessions/session'))).toBe(true);
    expect(reads.every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
  });
  it('uses admitted requester credentials at the source handoff coordinator instead of the daemon sign-in', async () => {
    const sessionId = `c${'b'.repeat(24)}`;
    const host = await home({ sessionId });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId,
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: sessionId, preparedSessionId: sessionId });
    if (!custody) throw new Error('Missing requester bootstrap');
    const daemonFile = join(directory!, 'daemon-access.key');
    await writePrivateOwnerFile({ path: daemonFile,
      contents: JSON.stringify(encodeStoredCredentials({ token: 'alice-daemon', encryption: null })) });
    const controller = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
        // Genuine engine transport; this handoff does not request workspace synchronization.
        send: async () => { throw new Error('Unexpected Mutagen request'); } }),
      lifecycle: { start: async () => { throw new Error('Unexpected sidecar spawn'); }, stop: async () => undefined },
      localServerId: attribution.serverId, localMachineId: 'machine', resolveWorkspaceRef: () => null,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(directory!, 'workspace-locks') }),
    });
    const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: attribution.serverId,
      readCredentials: async () => decodeStoredCredentials(JSON.parse(await readFile(daemonFile, 'utf8'))),
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: controller,
        bootstrap: async () => { throw new Error('Unexpected workspace materialization'); } }),
      // Genuine target RPC boundary: source admission is observed before any target attempt.
      callMachine: async () => { throw new Error('Unexpected target RPC'); },
    });
    const before = host.requests.length;
    const input = { operationId: 'handoff-operation', actionInput: { sessionId, targetMachineId: 'destination', targetPath: '/target' },
      context: { surface: 'rpc' as const, requesterSessionBootstrap: custody.admitted }, signal: new AbortController().signal,
      start: async () => ({ ok: false as const, errorCode: 'source_export_refused', error: 'source_export_refused' }),
      publishOwnerUpdate: () => undefined };
    const result = await runWithServerHttpBaseUrl(origin, () => coordinate(input));
    expect(result).toMatchObject({ ok: false, errorCode: 'source_export_refused' });
    const reads = host.requests.slice(before).filter(request => request.path !== '/v1/machines/machine/admission/verify');
    expect(reads.some(request => request.path.startsWith(`/v2/sessions/${sessionId}`)), JSON.stringify(reads.map(request => request.path))).toBe(true);
    expect(reads.every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
  });
  it('adopts the exact existing requester Session on the destination without rewriting its source creation recipe', async () => {
    const host = await home({ creationMachineId: 'source-machine' });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    // New creation still requires a recipe bound to this Machine, unlike existing-Session handoff adoption.
    expect(await custody.admitted.bindSession('session', host.correspondence.sessionCreationTag)).toBeNull();
    const bindExisting = Reflect.get(custody.admitted, 'bindExistingSession');
    expect(typeof bindExisting).toBe('function');
    if (typeof bindExisting !== 'function') throw new Error('Missing existing Session custody adoption');
    expect(await bindExisting('different-session')).toBeNull();
    const bound = await bindExisting('session');
    expect(bound).not.toBeNull();
    expect(JSON.parse(await readFile(bound.path, 'utf8'))).toMatchObject({ sessionId: 'session', attribution,
      credentials: { token: credentials.token } });
    expect(custody.admitted.getBoundSessionId()).toBe('session');
    expect(await custody.admitted.isCurrent()).toBe(true);
    expect(host.correspondence.recipe.execution.machineId).toBe('source-machine');
    host.setAccess(false);
    expect(await bindExisting('session')).toBeNull();
  });
  it.each(['revoked', 'different-parent', 'admitted'] as const)('keeps %s stop on the exact admitted requester Session before the process boundary', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const stopped: string[] = [];
    // This callback is the genuine process-stop boundary; all custody/admission remains real.
    const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: async sessionId => {
      stopped.push(sessionId); return { status: 'requested' }; } });
    if (state === 'revoked') host.setAccess(false);
    const result = await executor.execute('session.stop', { sessionId: state === 'different-parent' ? 'different-session' : 'session' }, {
      surface: 'rpc', signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current });
    if (state === 'admitted') {
      expect(result).toMatchObject({ ok: true, result: { status: 'requested' } }); expect(stopped).toEqual(['session']);
    } else { expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' }); expect(stopped).toEqual([]); }
  });
  it.each(['revoked', 'different-parent', 'admitted'] as const)('keeps %s handoff metadata reads in the exact requester custody', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    if (state === 'revoked') host.setAccess(false);
    const before = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).length;
    const metadata = await runWithServerHttpBaseUrl(origin, () => loadSessionHandoffRemoteMetadata(
      state === 'different-parent' ? 'different-session' : 'session', {
        signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current,
      }));
    const reads = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).slice(before);
    if (state === 'admitted') {
      expect(metadata).toMatchObject({ path: '/workspace', codexSessionId: 'same-native-session' });
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
    } else { expect(metadata).toBeNull(); expect(reads).toEqual([]); }
  });
  it.each(['revoked', 'different-parent'] as const)('refuses %s continue before requester or custodian Account effects', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const input = SessionContinueWithReplayRpcParamsSchema.parse({ directory: '/workspace',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      replay: { previousSessionId: state === 'different-parent' ? 'different-session' : 'session' } });
    runtimeFixture ??= await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const bridge = getSessionHostBridge();
    expect(bridge.resolveContinueWithReplayBackendTarget({ backendTarget: input.backendTarget })).toMatchObject({ ok: true });
    const handler = createContinueWithReplayLifecycleActionHandler({ sessionHostBridge: bridge,
      spawnSession: async () => { throw new Error('Unexpected physical launch'); } });
    const executor = createSessionLifecycleRpcActionExecutor({ 'session.continue_with_replay': handler });
    if (state === 'revoked') host.setAccess(false);
    const before = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).length;
    const result = await executor.execute('session.continue_with_replay', input, { surface: 'rpc',
      signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE } });
    expect(host.requests.filter(request => request.path.startsWith('/v2/sessions/'))).toHaveLength(before);
  });
  it.each(['revoked', 'different-parent', 'admitted'] as const)('keeps %s fork preflight bound to the original requester Session through the lifecycle Action adapter', async (state) => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const effects: string[] = [];
    const fork = createForkSessionLifecycleActionHandler({ sessionHostBridge: getSessionHostBridge(), handlers: {
      spawnSession: async () => { effects.push('spawn'); return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Unexpected spawn' }; },
      stopSession: async () => { effects.push('stop'); return false; },
    } });
    const executor = createSessionLifecycleRpcActionExecutor({ 'session.fork': fork });
    const context = { surface: 'rpc' as const, signal: new AbortController().signal,
      requesterSessionBootstrap: custody.admitted, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: current };
    if (state === 'revoked') host.setAccess(false);
    const before = host.requests.filter(request => request.path === '/v2/sessions/session').length;
    const input = SessionForkRpcParamsSchema.parse({ v: 1,
      parentSessionId: state === 'different-parent' ? 'different-session' : 'session',
      forkPoint: { type: 'latest' }, strategy: 'replay' });
    if (state === 'admitted') runtimeFixture ??= await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const result = await executor.execute('session.fork', input, context);
    expect(effects).toEqual([]);
    if (state === 'admitted') {
      // This fixture deliberately has no executable backend. It establishes
      // the real Account preflight, not native fork or physical launch evidence.
      const reads = host.requests.filter(request => request.path === '/v2/sessions/session').slice(before);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE } });
      expect(host.requests.filter(request => request.path === '/v2/sessions/session')).toHaveLength(before);
    }
    await custody.cleanupOnFailure();
  });

  it('projects full-sign-in and host visibility before requester approval without retaining credential material', async () => {
    const host = await home();
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
        serverHttpBaseUrl: origin, boundary: host.boundary }) });
    if (!custody) throw new Error('Missing requester bootstrap');
    const input = { executionTarget: { serverId: attribution.serverId, machineId: attribution.machineId },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '',
      requesterSessionBootstrap: custody.admitted });
    const preview = await deps.buildApprovalPreview?.({ actionId: 'session.spawn_new', input,
      context: { surface: 'mcp' }, defaultPreview: { actionId: 'session.spawn_new', actionArgs: input } });
    expect(preview).toMatchObject({ requesterCredentialDisclosure: {
      disposition: 'ordinary_requester', accountId: attribution.accountId, machineId: attribution.machineId,
      fullSignIn: true, selectedPurposeRuntimeAuth: true, hostCanInspectLocalProcess: true,
    } });
    expect(JSON.stringify(preview)).not.toContain(credentials.token);
    expect(JSON.stringify(preview)).not.toContain('requesterSessionBootstrap');
    await custody.cleanupOnFailure();
  });

  it('uses exact admitted Session credentials for serviceability and performs no read after admission loss', async () => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      boundSessionId: 'session', preparedSessionId: 'session', verifyMachineAdmissionCurrent: current });
    if (!custody) throw new Error('Missing requester bootstrap');
    const options = { sessionId: 'session', credentials: { token: 'alice-daemon', encryption: null },
      requesterSessionBootstrap: custody.admitted };
    // HTTP is the genuine boundary. An unavailable socket is not evidence of
    // serviceability, but the reader must never use Alice's Account authority.
    await runWithServerHttpBaseUrl(origin, () => probeAlreadyRunningExistingSessionServiceability(options));
    const reads = host.requests.filter(request => request.path === '/v2/sessions/session');
    expect(reads).not.toHaveLength(0);
    expect(reads.every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
    host.setAccess(false);
    const before = reads.length;
    await runWithServerHttpBaseUrl(origin, () => probeAlreadyRunningExistingSessionServiceability(options));
    expect(host.requests.filter(request => request.path === '/v2/sessions/session')).toHaveLength(before);
    await custody.cleanupOnFailure();
  });

  it.each(['rpc', 'trusted-child'] as const)('launches the same ordinary lifecycle with actual %s requester custody and refuses it after access loss', async (originKind) => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current });
    expect(custody).not.toBeNull();
    if (!custody) throw new Error('Missing requester bootstrap');
    const launched: SpawnSessionOptions[] = [];
    const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: attribution.serverId,
      // Physical process launch is the boundary, not Session admission or custody.
      spawnSession: async options => { launched.push(options); return { type: 'success', sessionId: 'bob-child' }; } });
    const input = { directory: '/workspace', machineId: attribution.machineId,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag: host.correspondence.sessionCreationTag, sessionCreationCorrespondence: host.correspondence };
    const context = { requesterSessionBootstrap: custody.admitted,
      ...(originKind === 'rpc' ? { machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const } } : {}),
      verifyMachineAdmissionCurrent: current };
    expect(await handler(input, context)).toMatchObject({ type: 'success', sessionId: 'bob-child' });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.requesterSessionBootstrap).toBe(custody.admitted);
    expect(launched[0]?.requesterWorkAttributionV1).toEqual(attribution);
    host.setAccess(false);
    expect(await handler(input, context)).toMatchObject({ type: 'error' });
    expect(launched).toHaveLength(1);
    await custody.cleanupOnFailure();
  });

  it('retires only an unadopted bootstrap Saved Secret catalog on launch failure', async () => {
    const host = await home();
    const active = getActiveAccountSettingsSnapshot();
    const result = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
        serverHttpBaseUrl: origin, boundary: host.boundary }) });
    expect(result).not.toBeNull();
    if (!result) throw new Error('Missing requester bootstrap');
    const context = result.admitted.savedSecretOperationContext;
    expect(context.commitCatalog({ state: 'ready', resources: [{ resourceId: 'unadopted-secret',
      ownerAccountId: 'bob', displayName: 'Bob token', kind: 'token', encryptionMode: 'plain',
      revision: 1, materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'unadopted-secret', mode: 'plain',
        content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' },
      }) }] })).toBe(true);
    expect(context.readSnapshot()?.savedSecretResources?.[0]?.storedContent).not.toBeNull();

    await result.cleanupOnFailure();

    expect(context.readSnapshot()?.savedSecretCatalogState).toBe('temporarily_unavailable');
    expect(context.readSnapshot()?.savedSecretResources?.[0]?.storedContent).toBeNull();
    expect(getActiveAccountSettingsSnapshot()).toBe(active);
  });

  it('retires a bound but unadopted launch catalog and protected custody on launch failure', async () => {
    const host = await home();
    const active = getActiveAccountSettingsSnapshot();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const result = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current });
    expect(result).not.toBeNull();
    if (!result) throw new Error('Missing requester bootstrap');
    result.admitted.bindRuntimeMachineAdmissionCurrentness(current);
    const bound = await result.admitted.bindSession('session', host.correspondence.sessionCreationTag);
    expect(bound).not.toBeNull();
    if (!bound) throw new Error('Missing bound requester custody');
    expect(await readFile(bound.path, 'utf8')).toContain('bob-ordinary');
    const context = result.admitted.savedSecretOperationContext;
    expect(context.commitCatalog({ state: 'ready', resources: [{ resourceId: 'failed-bound-secret',
      ownerAccountId: 'bob', displayName: 'Bob token', kind: 'token', encryptionMode: 'plain',
      revision: 1, materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'failed-bound-secret', mode: 'plain',
        content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' },
      }) }] })).toBe(true);
    expect(context.readSnapshot()?.savedSecretResources?.[0]?.storedContent).not.toBeNull();

    await result.cleanupOnFailure();

    expect(context.readSnapshot()?.savedSecretCatalogState).toBe('temporarily_unavailable');
    expect(context.readSnapshot()?.savedSecretResources?.[0]?.storedContent).toBeNull();
    await expect(readFile(bound.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getActiveAccountSettingsSnapshot()).toBe(active);
    expect(result.admitted.getBoundSessionId()).toBe('session');
  });

  it('reads additive custody fields without dropping exact bounds or private decryption material, but rejects malformed required fields', async () => {
    const host = await home();
    const childAttribution = { ...attribution, serverId: configuration.activeServerId };
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution: childAttribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
    const stored = { v: 1, sessionId: 'session', futureOuter: 'ignored',
      attribution: { ...childAttribution, futureAttribution: 'ignored' },
      credentials: { ...encodeStoredCredentials(credentials), futureCredential: 'ignored' } };
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify(stored) });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution: childAttribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
      verifyMachineAdmissionCurrent: current })).toMatchObject({ ...credentials, credentialProvenance: 'stored_session' });
    const e2ee: Credentials = { token: 'bob-ordinary', encryption: { type: 'dataKey',
      publicKey: new Uint8Array(32).fill(8), machineKey: new Uint8Array(32).fill(7) } };
    const encoded = encodeStoredCredentials(e2ee);
    const encrypted = encryptSecretStringV1('bob-private-secret', deriveSettingsSecretsKeyForCredentials(e2ee),
      length => new Uint8Array(length).fill(1));
    const e2eeStored = { ...stored, credentials: { ...encoded, futureCredential: 'ignored',
      encryption: { ...encoded.encryption, futureEncryption: 'ignored' } } };
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify(e2eeStored) });
    const previousSessionId = process.env[REQUESTER_SESSION_ID_ENV];
    process.env[REQUESTER_SESSION_ID_ENV] = 'session';
    try {
      const child = await readRequesterSessionCredentialsForChild(custody.path);
      expect(child).toMatchObject({ ...e2ee, credentialProvenance: 'stored_session' });
      if (!child) throw new Error('Missing protected child credentials');
      expect(child.encryption).toEqual(e2ee.encryption);
      expect(child.requesterSessionCredentialScope).toEqual({ serverId: childAttribution.serverId,
        serverHttpBaseUrl: normalizeServerHttpBaseUrl(configuration.apiServerUrl),
        requesterSession: { sessionId: binding.sessionId, attribution: childAttribution } });
      expect(JSON.stringify(child)).not.toContain('requesterSessionCredentialScope');
      expect(decryptSecretStringWithKeysV1(encrypted, deriveSettingsSecretsReadKeysForCredentials(child))).toBe('bob-private-secret');
      await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ ...e2eeStored,
        credentials: { ...e2eeStored.credentials, token: 7 } }) });
      expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
      expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: current })).toBeNull();
      await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ ...stored,
        attribution: { ...stored.attribution, installationId: 7 } }) });
      expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
      expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: current })).toBeNull();
    } finally {
      if (previousSessionId === undefined) delete process.env[REQUESTER_SESSION_ID_ENV];
      else process.env[REQUESTER_SESSION_ID_ENV] = previousSessionId;
    }
  });

  it('recovers only the exact cold handoff Session from existing protected custody with current Home admission', async () => {
    const host = await home();
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution, credentials });
    const recover = Reflect.get(requesterCredentialOwner, 'resolveRequesterSessionBootstrapFromCustody') as
      (input: unknown) => Promise<import('./requesterSessionCredentials').AdmittedRequesterSessionBootstrap | null>;
    expect(typeof recover).toBe('function');
    const input = { happyHomeDir: directory!, serverId: attribution.serverId, sessionId: 'session',
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary };
    const recovered = await recover(input);
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(recovered?.credentials.token).toBe(credentials.token);
    expect(await recover({ ...input, sessionId: 'another-session' })).toBeNull();
    host.setAccess(false);
    expect(await recover(input)).toBeNull();
    recovered?.savedSecretOperationContext.withdrawCatalog();
  });

  it('discovers only this Home and installed Machine from existing protected custody, and reports malformed or unsafe state unavailable', async () => {
    await home();
    const input = { happyHomeDir: directory!, serverId: attribution.serverId, machineId: attribution.machineId,
      installationId: attribution.installationId };
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'ready', bindings: [] });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'other-home',
      attribution: { ...attribution, serverId: 'other-home' }, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'old-installation',
      attribution: { ...attribution, installationId: 'old-installation' }, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'other-machine',
      attribution: { ...attribution, machineId: 'other-machine' }, credentials });
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ v: 1, sessionId: 'session',
      futureOuter: true, attribution: { ...attribution, futureAttribution: true },
      credentials: { ...encodeStoredCredentials(credentials), futureCredential: true } }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'ready', bindings: [{ sessionId: 'session', attribution }] });
    if (process.platform !== 'win32') {
      await chmod(custody.path, 0o644);
      expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
      await chmod(custody.path, 0o600);
    }
    const malformedPath = requesterSessionCredentialPath({ ...binding, sessionId: 'malformed' });
    await writePrivateOwnerFile({ path: malformedPath, contents: JSON.stringify({ v: 1, sessionId: 'session',
      attribution, credentials: encodeStoredCredentials(credentials) }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
    await replacePrivateBearerFile({ path: malformedPath, contents: JSON.stringify({ v: 1, sessionId: 'malformed',
      attribution: { ...attribution, serverId: 'another-home' }, credentials: encodeStoredCredentials(credentials) }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
  });

  it('recovers a Bot with exact protected requester custody and removes access after final revoke', async () => {
    const host = await home({ bot: true });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
    const alice = getActiveAccountSettingsSnapshot();
    const recovered = await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(recovered?.credentials).toMatchObject({ ...credentials, credentialProvenance: 'stored_session' });
    expect(recovered?.credentials.requesterSessionCredentialScope).toEqual({ serverId: attribution.serverId, serverHttpBaseUrl: origin });
    expect(JSON.stringify(recovered?.credentials)).not.toContain('requesterSessionCredentialScope');
    expect(recovered?.accountSettingsContext.source).toBe('network');
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    expect(await recovered?.isCurrent()).toBe(true);
    expect(host.requests.filter(request => !request.path.endsWith('/admission/verify'))
      .every(request => request.bearer === 'Bearer bob-ordinary')).toBe(true);
    expect(host.requests.filter(request => request.path.endsWith('/admission/verify'))
      .every(request => request.bearer === 'Bearer alice-daemon')).toBe(true);
    expect(await resolveRequesterSessionBootstrap({ ...binding, attribution: { ...attribution, accountId: 'eve' },
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toBeNull();
    host.setSessionRole('view');
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    host.setSessionRole('owner'); host.setAccountMode('e2ee');
    expect(await recovered?.isCurrent()).toBe(false);
    host.setAccountMode('plain'); host.setAccess(false);
    expect(await recovered?.savedSecretOperationContext.isCurrent()).toBe(false);
    expect(await readFile(custody.path, 'utf8')).toContain('bob-ordinary');
    host.setAccess(true);
    const reconnected = await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });
    expect(await reconnected?.savedSecretOperationContext.isCurrent()).toBe(true);
    expect(reconnected?.getBoundSessionId()).toBe('session');
    expect(recovered?.savedSecretOperationContext.readSnapshot()).toBeNull();
    expect(host.correspondence.recipe.identity).toEqual({ bot: { kind: 'bot' }, createdAsBot: true });
    host.setAccess(false);
    expect(await reconnected?.isCurrent()).toBe(false);
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
  });

  it('binds runtime currentness to the actual Session after custody binding', async () => {
    const host = await home();
    const rpc = new AbortController();
    const result = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester',
      credentials: { token: 'bob-ordinary' }, sessionId: 'session', sessionCreationDisposition: 'rejoined' },
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      context: { signal: rpc.signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => !rpc.signal.aborted } });
    expect(result).not.toBeNull();
    const admitted = result!.admitted;
    expect(admitted.preparedSessionId).toBe('session');
    expect(admitted.getBoundSessionId()).toBeNull();
    const bindRuntimeCurrentness = Reflect.get(requesterCredentialOwner,
      'bindRequesterSessionRuntimeMachineAdmissionCurrentness') as
      (input: Readonly<{ bootstrap: typeof admitted; boundary: RequesterSessionMachineAdmissionBoundary }>) => void;
    expect(typeof bindRuntimeCurrentness).toBe('function');
    bindRuntimeCurrentness({ bootstrap: admitted, boundary: host.boundary });
    expect(await admitted.isCurrent()).toBe(true);
    expect(host.requests.some(request => request.path.endsWith('/admission/verify'))).toBe(false);
    const bound = await result!.admitted.bindSession('session', host.correspondence.sessionCreationTag);
    expect(bound).not.toBeNull();
    expect(admitted.getBoundSessionId()).toBe('session');
    rpc.abort();
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(true);
    host.setAccess(false);
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(false);
    expect(admitted.savedSecretOperationContext.readSnapshot()).toBeNull();
    expect(await readFile(bound!.path, 'utf8')).toContain('bob-ordinary');
  });

  it('refuses wrong authenticated requester and an installation replaced during fresh verification', async () => {
    const host = await home();
    const input = { credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary };
    host.setAccountId('alice');
    expect(await verifyRequesterSessionMachineAdmissionCurrent(input)).toBe(false);
    host.setAccountId('bob'); host.replaceDuringVerification();
    expect(await verifyRequesterSessionMachineAdmissionCurrent(input)).toBe(false);
  });
});
