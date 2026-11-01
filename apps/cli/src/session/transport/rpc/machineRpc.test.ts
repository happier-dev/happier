import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, getActionSpec, ProjectWorkerActionInputSchemasV1,
  ARTIFACT_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1,
  encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, FeaturesResponseSchema } from '@happier-dev/protocol';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';

const socketHandlers = new Map<string, () => void>();
const socketListeners = new Map<string, Set<() => void>>();
const pendingAcks = new Set<(error: Error) => void>();
function rejectPendingAcks() {
  for (const reject of pendingAcks) reject(new Error('Machine RPC socket disconnected before acknowledgement'));
  pendingAcks.clear();
}
const socket = {
  io: createSocketIoManagerStub(),
  connected: false,
  connect: vi.fn(() => socketHandlers.get('connect')?.()),
  on: vi.fn((event: string, handler: () => void) => {
    const listeners = socketListeners.get(event) ?? new Set<() => void>();
    listeners.add(handler);
    socketListeners.set(event, listeners);
    socketHandlers.set(event, () => {
      if (event === 'connect') socket.connected = true;
      if (event === 'disconnect') { socket.connected = false; rejectPendingAcks(); }
      for (const listener of listeners) listener();
    });
  }),
  off: vi.fn((event: string, handler?: () => void) => {
    const listeners = socketListeners.get(event);
    if (handler) listeners?.delete(handler); else listeners?.clear();
    if (!listeners?.size) { socketListeners.delete(event); socketHandlers.delete(event); }
  }),
  removeAllListeners: vi.fn(() => { socketListeners.clear(); socketHandlers.clear(); }),
  disconnect: vi.fn(() => { socket.connected = false; rejectPendingAcks(); }),
  close: vi.fn(),
  emit: vi.fn(),
  // Mirror Socket.IO's promise acknowledgement and its disconnect rejection.
  emitWithAck: vi.fn((event: string, payload: unknown) => new Promise<unknown>((resolve, reject) => {
    pendingAcks.add(reject);
    try {
      socket.emit(event, payload, (value: unknown) => { pendingAcks.delete(reject); resolve(value); });
    } catch (error) { pendingAcks.delete(reject); reject(error); }
  })),
};
const axiosGet = vi.hoisted(() => vi.fn());
const axiosPost = vi.hoisted(() => vi.fn());
const axiosRequest = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    request: (...args: unknown[]) => axiosRequest(...args),
  },
}));
vi.mock('@/configuration', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { configuration: {
    serverUrl: 'https://api.example.test', apiServerUrl: 'https://api.example.test',
    activeServerId: 'home', activeServerDir: join(tmpdir(), 'happier-machine-rpc-test'),
    happyHomeDir: join(tmpdir(), 'happier-machine-rpc-test'),
  } };
});

import {
  TERMINAL_STREAM_MAX_ENCODED_BYTES,
  TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
  TerminalStreamReadRequestSchema,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  encodeTerminalStreamBytes,
  sealEncryptedDataKeyEnvelopeV1,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveBoxPublicKeyFromSeed,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  verifyExternalActionMachineRpcRequestV1,
  computeRunnerMachineContentKeyFingerprintV1,
  encodeBase64 as encodeProtocolBase64,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { callExactMachineRpc, callMachineRpc, readMachineRpcRequestDisposition } from './machineRpc';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { io } from 'socket.io-client';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { admitSessionHandoffExistingState, createSessionHandoffPreflightMachineRpc } from '@/session/handoff/sessionHandoffPreflightMachineRpc';
import { awaitSpawnedSessionId, abandonSpawnedSessionBestEffort } from '@/session/services/awaitSpawnedSessionId';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { openSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import * as persistence from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createManagedGuestActivityTransport } from '@/machines/managed/managedActivityTransport';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema, MachineStoragePileResultV1Schema, PileReviewV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ScmPullRequestOpenComposeResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { logger } from '@/ui/logger';

/** Account content material exactly as the CLI persists it: a box seed plus its own public key. */
function accountDataKeyCredentials(seedByte: number) {
  const machineKey = new Uint8Array(32).fill(seedByte);
  return {
    token: 'account-token',
    encryption: {
      type: 'dataKey' as const,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
      machineKey,
    },
  };
}

function legacyCredentials(seedByte: number) {
  return {
    token: 'account-token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(seedByte) },
  };
}

/** What a Machine actually publishes: its content key sealed to an Account content public key. */
function publishedMachineDataEncryptionKey(params: Readonly<{
  contentKey: Uint8Array;
  recipientPublicKey: Uint8Array;
}>): string {
  return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: params.contentKey,
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: getRandomBytes,
  }));
}

function rpcContent(key: Uint8Array, variant: 'dataKey' | 'legacy' = 'dataKey'): SocketRpcContent {
  return { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(key, variant, value)),
    decryptRaw: async value => decrypt(key, variant, decodeBase64(value)),
  } };
}
async function openedWith(key: Uint8Array, encoded: unknown, method: string, variant: 'dataKey' | 'legacy' = 'dataKey'): Promise<unknown> {
  try {
    return (await socketRpcCodec.decodeRequestParams(rpcContent(key, variant), encoded, method)).params;
  } catch {
    return null;
  }
}
async function responseForRequest(key: Uint8Array, request: { method: string; params: unknown }, result: unknown, variant: 'dataKey' | 'legacy' = 'dataKey') {
  const content = rpcContent(key, variant);
  const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
  return socketRpcCodec.encodeResponse(content, result, decoded.callId);
}

describe('callMachineRpc', () => {
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('delivers only the signed approved storage subset to the real cleanup receiver', async () => {
    const [{ mkdtemp, realpath, mkdir, writeFile, lstat, rm }, { tmpdir }, { join, resolve }, { execFile }, { promisify },
      artifacts, { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers }, { createActivityLog },
      { createMachineVitalsSampler }, { createMinuteHistoryStore }, { createMachineResourceSummary }] = await Promise.all([
      import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process'), import('node:util'),
      import('@happier-dev/cli-common/componentArtifacts'), import('@/rpc/handlers/storage'), import('@/daemon/guard/activityLog'),
      import('@/daemon/vitals/createMachineVitalsSampler'), import('@/daemon/vitals/history/minuteHistoryStore'),
      import('@/daemon/resources/machineResourceSummary'),
    ]);
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'storage-signed-subset-')));
    const executable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const execute = promisify(execFile);
    let retire = async () => {};
    try {
      const payload = join(scratch, 'payload');
      await artifacts.stageProcessCustodyRuntime({ repoRoot: resolve('../..'), payloadDir: payload,
        target: artifacts.resolveCurrentBinaryTarget({ availableTargets: artifacts.CLI_BINARY_TARGETS }),
        runCommand: async (command, args, options) => { await execute(command, args, { cwd: options?.cwd, env: options?.env }); },
      });
      Object.defineProperty(process, 'execPath', { ...executable, value: join(payload, 'happier') });
      const home = join(scratch, 'home'); const server = join(home, 'server');
      const chosenPath = join(home, 'logs', 'chosen.log'); const retainedPath = join(home, 'logs', 'retained.log');
      await mkdir(join(home, 'logs'), { recursive: true }); await mkdir(server, { recursive: true });
      await writeFile(chosenPath, Buffer.alloc(4096, 1)); await writeFile(retainedPath, Buffer.alloc(4096, 2));
      const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
        historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
      const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
      const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
      const identity = { serverId: 'home', machineId: 'machine-target', installationId: 'target-installation', custodianAccountId: 'owner' };
      const { createManagedSessionDirectories } = await import('@/session/creation/managedSessionDirectories');
      const directories = createManagedSessionDirectories({ activeServerDir: server });
      const own = await directories.materializeForFreshSpawn({ sessionCreationTag: 'own' });
      const foreign = await directories.materializeForFreshSpawn({ sessionCreationTag: 'foreign' });
      await directories.bind({ allocationId: own.allocationId, sessionId: 'own-session' });
      await directories.bind({ allocationId: foreign.allocationId, sessionId: 'foreign-session' });
      await writeFile(join(own.directory, 'own.txt'), 'owned attachment');
      await writeFile(join(foreign.directory, 'foreign.txt'), 'foreign attachment');
      let ownSessionIds = new Set(['own-session']);
      let revokeDuringProtectionRead = false;
      const sessionStoppedAt = Date.now();
      const routes = createDaemonStorageRoutes({ target: () => identity,
        readOwnSessionIds: accountId => accountId === 'recipient' ? ownSessionIds : new Set<string>(), deps: () => ({
        serverId: identity.serverId, machineId: identity.machineId, custodianAccountId: identity.custodianAccountId, activityLog, homeDir: scratch,
        attributionFor: accountId => ({ serverId: identity.serverId, accountId, machineId: identity.machineId,
          installationId: identity.installationId }),
        readStorageProtectionFacts: async () => {
          return {};
        },
        catalog: { happyHomeDir: home, activeServerDir: server, tempRoot: join(scratch, 'absent-temp'),
          managedSessionDirectories: directories,
          readTrackedSessions: () => ['own-session', 'foreign-session'].map(sessionId => ({ sessionId, cwd: home,
            running: false, stoppedAt: sessionStoppedAt })),
          readProjects: () => ({ status: 'ready', projects: [] }), readInUsePaths: async () => {
            // OS liveness is an asynchronous boundary; Home custody may change
            // while an accepted daemon cleanup is waiting for those facts.
            if (revokeDuringProtectionRead) ownSessionIds = new Set();
            return { reliable: true, paths: [] };
          } },
        readVolumes: () => [{ id: 'fixture', label: 'Fixture', mount: scratch, totalBytes: 1_000_000, availableBytes: 500_000 }],
      }) });
      retire = async () => { routes.dispose(); resourceSummary.stop(); await sampler.stop(); };
      // Home admission and Socket.IO are network boundaries; strict receiver,
      // review, native sizing, pile, Trash and durable Activity owners stay real.
      const receiver = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
      registerDaemonStorageRpcHandlers(receiver, routes);
      const ingress = { machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: identity.machineId,
        installationId: identity.installationId, role: 'manage' as const, encryptionMode: 'plain' as const }, callerAuthority: 'account_automation' as const };
      const invoke = async (method: string, params: unknown) => receiver.handleRequest({ method: `${identity.machineId}:${method}`, params, ...ingress });
      const listed = MachineStorageCategoryListResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
        { machineId: identity.machineId, categoryId: 'logs' }));
      const refs = listed.items.map(({ itemId, path }) => ({ itemId, path }));
      const collected = MachineStoragePileResultV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_PILE_SET,
        { machineId: identity.machineId, add: refs }));
      expect(collected.items.every(ref => ref.collectedBy.accountId === 'owner' && ref.collectedBy.kind === 'agent')).toBe(true);
      expect(await invoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, { machineId: identity.machineId })).toMatchObject({ pile: { count: 2 } });
      const review = PileReviewV1Schema.parse(await invoke(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK,
        { machineId: identity.machineId, refs: collected.items.map(({ itemId, path }) => ({ itemId, path })) }));
      const original = { machineId: identity.machineId, serverId: identity.serverId, emptyAfter: true,
        items: review.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) };
      const selected = original.items.find(item => item.ref.path === chosenPath)!;
      const narrowed = { ...original, emptyAfter: false, items: [selected] };
      const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
      const target = { kind: 'machine' as const, machineId: identity.machineId };
      const authorization = { v: 1 as const, token: 'home-cleanup-proof', binding: { accountId: 'owner', custodianAccountId: 'owner',
        authentication: { kind: 'account' as const, tokenEpoch: 1 }, accountEncryptionMode: 'plain' as const,
        serverIdentityId: 'srv_home', machineId: identity.machineId, installationId: identity.installationId,
        actionId: 'machines.storage.trash.move', requestId: 'cleanup-request', requestEnvelopeDigest: 'a'.repeat(43), target } };
      axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: identity.machineId, installationId: identity.installationId,
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))) } } });
      let forwarded: unknown;
      socket.emit.mockImplementation(async (event, packet, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        forwarded = packet.params;
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: authorization.binding.actionId,
          target, installationId: identity.installationId, event, method: packet.method, requestId: packet.requestId,
          params: packet.params, signature: packet.externalActionExecution.machineSignature, publicKey: keys.publicKey })).toBe(true);
        ack({ ok: true, result: await receiver.handleRequest({ method: packet.method, params: packet.params, ...ingress }) });
      });
      let stored: ApprovalRequest | null = null;
      const executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { artifactId: 'cleanup-approval' }; },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; },
        isActionApprovalRequired: () => true,
        isApprovalExecutionOriginCurrent: async ({ origin, request }) => !!origin.target && verifyExternalActionApprovalInputV1({
          authorizationToken: origin.externalActionExecutionAuthorization?.token ?? '', actionId: request.actionId,
          target: origin.target, input: request.actionArgs, signature: origin.externalActionInputSignature ?? '', publicKey: keys.publicKey }),
        machineStorageAction: async ({ actionId, input, context }) => await callExactMachineRpc({
          credentials: { token: 'owner-token', encryption: null }, machineId: identity.machineId,
          method: getActionSpec(actionId).bindings!.rpcMethod!, request: input,
          externalAction: { context, effectActionId: actionId, installationId: identity.installationId, privateKey: keys.secretKey },
        }),
      } satisfies ActionExecutorDeps);
      const context: ActionExecutorContext = { surface: 'ui', authority: 'account_automation', serverId: identity.serverId,
        actionCaller: { kind: 'host' }, actionRequestId: authorization.binding.requestId, runtimeAccountId: 'owner',
        defaultSessionMachineId: identity.machineId, externalActionTarget: target, externalActionExecutionAuthorization: authorization,
        signExternalActionApprovalInput: input => signExternalActionApprovalInputV1({ authorizationToken: input.authorization.token,
          actionId: input.actionId, target: input.target, input: input.input, privateKey: keys.secretKey }) };
      const created = await executor.execute('machines.storage.trash.move', original, context);
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const approved = await executor.execute('approval.request.decide', { artifactId: 'cleanup-approval', decision: 'approve', narrowedInput: narrowed },
        { surface: 'ui', authority: 'present_user', serverId: identity.serverId });
      expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed',
        execution: { ok: true, result: { outcomes: [{ itemId: selected.ref.itemId, status: 'moved' }] } } } });
      expect(forwarded).toEqual(narrowed);
      await expect(lstat(chosenPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(retainedPath)).size).toBe(4096);
      expect(await invoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, { machineId: identity.machineId })).toMatchObject({ pile: { count: 1 } });
      expect((await activityLog.list({ range: 'today' })).entries.filter(entry => entry.kind === 'trash_moved')).toHaveLength(1);
      const recipientInvoke = async (method: string, params: unknown) => receiver.handleRequest({ method: `${identity.machineId}:${method}`, params,
        machineAdmission: { ...ingress.machineAdmission, actorAccountId: 'recipient', role: 'use' }, callerAuthority: 'present_user' });
      await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { machineId: identity.machineId, clear: true });
      // Withdrawal applies at the next request admission. Finite reads retain
      // their admitted Session set instead of re-reading it during projection.
      ownSessionIds = new Set();
      const revokedCategory = MachineStorageCategoryListResultV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
        { machineId: identity.machineId, categoryId: 'sessionFolders' }));
      expect(ownSessionIds.size).toBe(0);
      expect.soft(revokedCategory.items).toEqual([]);
      revokeDuringProtectionRead = false;
      ownSessionIds = new Set(['own-session']);
      const ownItems = MachineStorageCategoryListResultV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST,
        { machineId: identity.machineId, categoryId: 'sessionFolders' }));
      const ownItem = ownItems.items.find(item => item.path === own.directory)!;
      expect(ownItem).toBeDefined();
      await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { machineId: identity.machineId,
        add: [{ itemId: ownItem.itemId, path: ownItem.path }] });
      const ownSummary = await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, { machineId: identity.machineId });
      expect(ownSummary).toMatchObject({ pile: { count: 1 }, categories: [], suggestionsTop: [], trash: { count: 0, allocatedBytes: 0 } });
      expect.soft(HappierStorageSummaryV1Schema.parse(ownSummary).volumes[0]?.pileBytes).toBeGreaterThan(0);
      expect(JSON.stringify(ownSummary)).not.toContain(foreign.directory);
      const ownPile = MachineStoragePileResultV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET,
        { machineId: identity.machineId }));
      expect(ownPile).toMatchObject({ items: [{ path: own.directory, collectedBy: { accountId: 'recipient', kind: 'person' } }] });
      ownSessionIds = new Set();
      const revokedDuringRead = await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET, { machineId: identity.machineId });
      expect(ownSessionIds.size).toBe(0);
      expect(MachineStoragePileResultV1Schema.parse(revokedDuringRead)).toMatchObject({
        items: [], summary: { count: 0, droppedSinceLastView: [] },
      });
      expect(JSON.stringify(revokedDuringRead)).not.toContain(own.directory);
      ownSessionIds = new Set(['own-session']);
      const ownReview = PileReviewV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK,
        { machineId: identity.machineId, refs: ownPile.items.map(({ itemId, path }) => ({ itemId, path })) }));
      expect(ownReview.items).toHaveLength(1);
      revokeDuringProtectionRead = true;
      await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, { machineId: identity.machineId,
        items: ownReview.items.map(item => ({ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict })) });
      expect(ownSessionIds.size).toBe(0);
      expect((await lstat(own.directory)).isDirectory()).toBe(true);
      revokeDuringProtectionRead = false;
      const survivingRevokedPile = MachineStoragePileResultV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET,
        { machineId: identity.machineId }));
      expect(survivingRevokedPile).toMatchObject({ items: [], summary: { count: 0, droppedSinceLastView: [] } });
      // Scope can be revoked after collection. A missing ref no longer supplies
      // current Session custody proof, so neither read may reveal its old path.
      ownSessionIds = new Set();
      await rm(own.directory, { recursive: true, force: true });
      const revokedPile = MachineStoragePileResultV1Schema.parse(await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_PILE_GET,
        { machineId: identity.machineId }));
      expect(revokedPile).toMatchObject({ items: [], summary: { count: 0, droppedSinceLastView: [] } });
      expect(JSON.stringify(revokedPile)).not.toContain(own.directory);
      const revokedSummary = await recipientInvoke(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, { machineId: identity.machineId });
      expect(revokedSummary).toMatchObject({ pile: { count: 0, droppedSinceLastView: [] } });
      expect(JSON.stringify(revokedSummary)).not.toContain(own.directory);
    } finally { await retire(); Object.defineProperty(process, 'execPath', executable); await rm(scratch, { recursive: true, force: true }); }
  });
  it.each(['success', 'error', 'abandon'] as const)('recovers the original accepted spawn observation after disconnect (%s)', async (kind) => {
    if (kind === 'abandon') vi.stubEnv('HAPPIER_SPAWN_ABANDON_TIMEOUT_MS', '5000');
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const requests: { spawnNonce: string; timeoutMs: number }[] = [];
    let staleAck: ((value: unknown) => void) | undefined;
    const terminal = kind === 'error'
      ? { status: 'error' as const, errorCode: 'spawn_failed', errorMessage: 'Original startup failed' }
      : { status: 'success' as const, sessionId: 'original-session' };
    socket.emit.mockImplementation((event, payload, ack) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      expect(payload.method).toBe(`machine-session:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`);
      requests.push(payload.params);
      if (requests.length === 1) staleAck = ack;
      else ack({ ok: true, result: terminal });
    });
    // Socket and HTTP adapters are boundaries; the nonce waiter and transport
    // reconnect supervisor remain real, including their cancellation scope.
    const resolver = async (spawnNonce: string, timeoutMs?: number, observation?: Readonly<{
      signal: AbortSignal; readRemainingTimeoutMs: () => number;
    }>) => normalizeSpawnSessionNonceResolution(await callMachineRpc({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce, timeoutMs }, timeoutMs: null,
      ...(observation ? { signal: observation.signal, reattachOnReconnect: {
        readRequest: () => ({ spawnNonce, timeoutMs: observation.readRemainingTimeoutMs() }),
      } } : {}),
    }));
    const controller = new AbortController();
    const stopSession = vi.fn(async () => true);
    const archiveSession = vi.fn(async () => {});
    const wait = kind === 'abandon' ? null : awaitSpawnedSessionId({
      result: { type: 'success' }, spawnNonce: 'accepted-nonce', resolveSpawnSessionByNonce: resolver,
      timeoutMs: 5_000, signal: controller.signal,
    });
    if (kind === 'abandon') abandonSpawnedSessionBestEffort({
      spawnNonce: 'accepted-nonce', reason: 'caller cancelled', resolveSpawnSessionByNonce: resolver,
      stopSession, archiveSession,
    });
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socketHandlers.get('disconnect')?.();
      // An obsolete connection cannot settle success or failure for the waiter.
      staleAck?.({ ok: true, result: { status: 'success', sessionId: 'obsolete-session' } });
      socketHandlers.get('connect')?.();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests.map((request) => request.spawnNonce)).toEqual(['accepted-nonce', 'accepted-nonce']);
      expect(requests[1].timeoutMs).toBeLessThanOrEqual(requests[0].timeoutMs);
      if (kind === 'abandon') {
        await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith('original-session'));
        expect(stopSession).toHaveBeenCalledWith('original-session');
      } else {
        await expect(wait).resolves.toMatchObject(kind === 'success'
          ? { type: 'success', sessionId: 'original-session' }
          : { type: 'error', errorCode: 'SPAWN_FAILED' });
      }
      expect(socket.close).toHaveBeenCalled();
    } finally {
      controller.abort();
      await wait;
      vi.unstubAllEnvs();
    }
  });

  it('reattaches a read-only observation on reconnect with the same target and cursor', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const requests: unknown[] = [];
    socket.emit.mockImplementation((event, payload, ack) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      requests.push(payload.params);
      if (requests.length === 2) ack({ ok: true, result: { cursor: 81 } });
    });
    const controller = new AbortController();
    const observation = callExactMachineRpc({
      credentials: { token: 'token', encryption: null },
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
      request: { cursor: 42 },
      timeoutMs: null,
      reattachOnReconnect: true,
      signal: controller.signal,
    });
    // Attach rejection immediately so the defective one-shot path is observable.
    const outcome = observation.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socketHandlers.get('disconnect')?.();
      socketHandlers.get('connect')?.();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests).toEqual([{ cursor: 42 }, { cursor: 42 }]);
      await expect(outcome).resolves.toEqual({ value: { cursor: 81 } });
    } finally {
      controller.abort();
      await outcome;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    socket.connected = false;
    socketListeners.clear();
    socketHandlers.clear();
    pendingAcks.clear();
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          storageMode: 'e2ee', id: 'machine-session',
          dataEncryptionKey: undefined,
        },
      },
    });
  });

  it.each(['unavailable', 'denied', 'unsupported'] as const)('preserves V3 handoff preflight failure meaning through real machine RPC (%s)', async failure => {
    const credentials = { token: 'owner-token', encryption: null };
    axiosGet.mockImplementation(async (url: unknown) => {
      if (String(url).includes('includeRevoked=true')) return { data: [{ id: 'machine-source' }] };
      const machineId = String(url).slice(String(url).lastIndexOf('/') + 1);
      return { data: { machine: { id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    const receiver = new RpcHandlerManager({ scopePrefix: 'machine-source', localMachineId: 'machine-source',
      encryptionMode: 'plain', authorizeRequest: async () => ({ ok: true }), logger: () => {} });
    if (failure === 'denied') {
      receiver.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET,
        async () => ({ error: 'Target denied the handoff capability request', errorCode: RPC_ERROR_CODES.FORBIDDEN }));
    }
    socket.emit.mockImplementation(async (event, packet, ack) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      if (failure === 'unavailable') {
        ack({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        return;
      }
      // HTTP, Socket.IO and Home authorization are network boundaries; the
      // preflight, shared RPC codec, actual responder and error readers stay real.
      ack({ ok: true, result: await receiver.handleRequest({ ...packet,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-source',
          installationId: 'source-installation', role: 'manage', encryptionMode: 'plain' }, callerAuthority: 'account_automation' }) });
    });
    const outcome = await admitSessionHandoffExistingState({ credentials, request: {
      sessionId: 'session-1', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      targetPath: '/target', sourceSessionStorageMode: 'persisted',
    }, rpc: createSessionHandoffPreflightMachineRpc({}) }).catch((error: unknown) => error);
    if (failure === 'unsupported') {
      expect(outcome).toMatchObject({ ok: false, errorCode: 'handoff_existing_state_update_required' });
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect(readRpcErrorCode(outcome)).toBe(failure === 'unavailable' ? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE : RPC_ERROR_CODES.FORBIDDEN);
      if (failure === 'denied') expect(outcome).toMatchObject({ message: 'Target denied the handoff capability request' });
    }
    expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('keeps exact Machine projection requests on the captured Home', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, _payload, ack) => ack({ ok: true, result: { generation: 1 } }));
    await expect(callExactMachineRpc({ credentials: { token: 'account-token', encryption: null }, machineId: 'machine-session',
      serverUrl: 'https://captured.example.test', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId: 'machine-session' },
    })).resolves.toEqual({ generation: 1 });
    expect(axiosGet).toHaveBeenCalledWith('https://captured.example.test/v1/machines/machine-session', expect.any(Object));
    expect(io).toHaveBeenCalledWith('https://captured.example.test', expect.objectContaining({
      auth: expect.objectContaining({ token: 'account-token', clientType: 'user-scoped' }),
    }));
  });

  it.each(['unsigned', 'signed', 'replaced', 'tampered'] as const)('continues paired-terminal consent by replaying the committed Artifact at its exact daemon (%s)', async mode => {
    const home = 'https://consent-home.example.test';
    const machineId = 'machine-consent';
    const artifactId = 'consent-artifact';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-consent', tokenEpoch: 4,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const peerKeys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const actionArgs = { action: 'setEnabled', connectionId: 'pc_consent',
      scope: 'machine', machineId, enabled: true };
    const target = { kind: 'machine' as const, machineId };
    const authorization = { v: 1 as const, token: 'peer-signed-authorization', binding: {
      accountId: 'account-consent', custodianAccountId: 'account-consent',
      authentication: { kind: 'terminal' as const, tokenEpoch: 4 }, serverIdentityId: 'srv_consent',
      machineId, installationId: 'consent-installation', actionId: 'providers.connections.enabled.set' as const,
      requestId: 'original-consent', requestEnvelopeDigest: 'a'.repeat(43), target, accountEncryptionMode: 'plain' as const } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'creator-profile', serverIdentityId: 'srv_consent', accountId: 'account-consent', machineId,
        target: { kind: 'machine', machineId }, actionId: 'providers.connections.enabled.set', requestId: 'original-consent' },
      actionId: 'providers.connections.enabled.set', actionArgs, summary: 'Enable owned fixture' });
    if (mode !== 'unsigned') {
      request.executionOriginV1.externalActionExecutionAuthorization = authorization;
      request.executionOriginV1.externalActionInputSignature = signExternalActionApprovalInputV1({
        authorizationToken: authorization.token, actionId: request.actionId, input: request.actionArgs,
        target, privateKey: peerKeys.secretKey });
    }
    if (mode === 'tampered') request.actionArgs = { ...actionArgs, enabled: false };
    let row = { id: artifactId, ownerAccountId: 'account-consent', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const storedRequest = () => {
      const body = decodePlainArtifactStoredContent(row.body);
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Invalid Artifact body');
      return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
    };
    // HTTP and Socket.IO are system boundaries. The credential-backed factory,
    // approval executor, codecs, currentness checks and exact RPC transport stay real.
    axiosGet.mockImplementation(async (url: string) => {
      if (url === `${home}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url === `${home}/v1/account/profile`) return { status: 200, data: { id: 'account-consent' } };
      if (url === `${home}/v1/machines`) return { status: 200, data: [{ id: machineId, active: true, activeAt: Date.now(),
        kind: 'persistent', revokedAt: null, replacedByMachineId: null,
        access: { custodian: { accountId: 'account-consent', displayName: 'Owner' }, role: 'manage',
          resourceMode: 'plain', accessState: 'ready' } }] };
      if (url === `${home}/v1/artifacts/${artifactId}`) return { status: 200, data: row };
      if (url === `${home}/v1/machines/${machineId}`) return { status: 200, data: { machine: { id: machineId,
        active: true, kind: 'persistent', installationId: 'consent-installation', storageMode: 'plain',
        installationPublicKey: encodeBase64(mode === 'replaced'
          ? tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24)).publicKey : peerKeys.publicKey, 'base64'),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
      throw new Error(`Unexpected consent HTTP read: ${url}`);
    });
    axiosPost.mockImplementation(async (url: string, raw: Record<string, unknown>) => {
      if (url !== `${home}/v1/artifacts/${artifactId}`) return { status: 403, data: { error: 'credential_scope_denied' } };
      expect(raw.expectedHeaderVersion).toBe(row.headerVersion);
      expect(raw.expectedBodyVersion).toBe(row.bodyVersion);
      row = { ...row, header: String(raw.header), body: String(raw.body),
        headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_consent' } } }))));
    const result = { ok: true, result: { ok: true, status: 'executed' } };
    socket.emit.mockImplementation((event, packet, ack) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      expect(packet).toMatchObject({ method: `${machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId } });
      expect(storedRequest()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
      ack({ ok: true, result });
    });
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, machineId, serverId: 'deciding-profile',
        serverIdentityId: 'srv_consent', serverApiUrl: home, externalActionClient: true,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
          getAccountSettings: () => null } });
      const decision = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
        { surface: 'cli', authority: 'present_user', actionRequestId: 'decide-consent' });
      if (mode === 'replaced' || mode === 'tampered') {
        expect(decision).toMatchObject({ ok: true, result: { status: 'failed', execution: {
          ok: false, errorCode: 'approval_stale' } } });
        expect(socket.emit).not.toHaveBeenCalled();
        return;
      }
      expect(decision).toEqual(result);
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosPost.mock.calls.some(([url]) => String(url).includes('/v1/actions/approval.request.decide'))).toBe(false);
      expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
        { surface: 'cli', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('seals requester Account material to the current installation on a Plain Machine before socket emission', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const request = { kind: 'requester_session_bootstrap_v1',
      input: { executionTarget: { serverId: 'home', machineId: 'machine-session' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
      requesterBootstrap: { v: 1, disposition: 'ordinary_requester',
        credentials: { token: 'private-bob-token', secret: encodeBase64(new Uint8Array(32).fill(8)) } },
    } as const;
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      installationId: 'installed-current', installationPublicKey: encodeBase64(installation.publicKey),
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.method).toBe(`machine-session:${RPC_METHODS.SESSION_SPAWN_NEW}`);
      expect(JSON.stringify(payload)).not.toContain('private-bob-token');
      expect(JSON.stringify(payload)).not.toContain(request.requesterBootstrap.credentials.secret);
      expect(openSessionRequesterBootstrapRpcRequestV1({ request: payload.params,
        machineId: 'machine-session', installationId: 'installed-current',
        installationPrivateKey: installation.secretKey })).toEqual(request);
      ack({ ok: true, result: { sessionId: 'bob-session' } });
    });
    await expect(callExactMachineRpc({ credentials: { token: 'bob-token', encryption: null },
      machineId: 'machine-session', method: RPC_METHODS.SESSION_SPAWN_NEW, request,
      requireCurrentMachine: true })).resolves.toEqual({ sessionId: 'bob-session' });
  });

  it.each(['prepare', 'preflight'] as const)('keeps existing-Session handoff %s custody confidential on the same installed-key Machine carrier', async phase => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const secret = encodeBase64(new Uint8Array(32).fill(8));
    const request = { kind: phase === 'prepare' ? 'requester_session_handoff_bootstrap_v1' : 'requester_session_handoff_preflight_bootstrap_v1', input: {
      ...(phase === 'prepare' ? {
      handoffId: 'handoff-bob', operationId: 'prepare-bob', sessionId: 'bob-existing-session',
      negotiatedTransportStrategy: 'server_routed_stream',
      } : { sessionId: 'bob-existing-session' }),
      sourceMachineId: 'source', targetMachineId: 'machine-session', sourceSessionStorageMode: 'persisted',
      targetPath: '/workspace',
    }, requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'private-bob-token', secret } } } as const;
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      installationId: 'installed-current', installationPublicKey: encodeBase64(installation.publicKey),
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    let emitted: unknown;
    socket.emit.mockImplementation((_event, payload, ack) => {
      emitted = payload;
      ack({ ok: true, result: { handoffId: 'handoff-bob', status: { status: 'pending' } } });
    });
    const method = phase === 'prepare' ? RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3 : RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3;
    await callExactMachineRpc({ credentials: { token: 'bob-token', encryption: null }, machineId: 'machine-session',
      method, request, requireCurrentMachine: true });
    expect(emitted).toMatchObject({ method: `machine-session:${method}`,
      params: { kind: request.kind, input: request.input,
        requesterBootstrap: { kind: 'installation_sealed_v1', installationId: 'installed-current' } } });
    expect(JSON.stringify(emitted)).not.toContain('private-bob-token');
    expect(JSON.stringify(emitted)).not.toContain(secret);
  });

  it('refuses requester Account material before socket emission when a Plain target has no usable installed key', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      installationId: 'installed-current', installationPublicKey: encodeBase64(new Uint8Array(32)),
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const request = { kind: 'requester_session_bootstrap_v1',
      input: { executionTarget: { serverId: 'home', machineId: 'machine-session' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
      requesterBootstrap: { v: 1, disposition: 'ordinary_requester',
        credentials: { token: 'private-bob-token', secret: encodeBase64(new Uint8Array(32).fill(8)) } },
    } as const;
    await expect(callExactMachineRpc({ credentials: { token: 'bob-token', encryption: null },
      machineId: 'machine-session', method: RPC_METHODS.SESSION_SPAWN_NEW, request })).rejects.toThrow();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it.each(['human', 'nested-human', 'disabled', 'unbound-agent', 'declined', 'undisclosed', 'notification-only'] as const)('preserves public CLI requester spawn authority for %s', async (callerKind) => {
    const disclosures: unknown[] = [];
    const effects: string[] = [];
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const input = { executionTarget: { serverId: 'home', machineId: 'machine-session' },
      creationKey: 'caller-creation-key', directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } as const;
    const nestedInput = { discussionId: 'discussion', participant: { kind: 'model', participantSlotId: input.creationKey,
      launch: { executionTarget: input.executionTarget, directory: input.directory, agentTarget: input.agentTarget } } } as const;
    const expectedSpawnInput = callerKind === 'nested-human'
      ? { ...input, discussionParticipant: { discussionId: 'discussion', participantSlotId: input.creationKey }, initialTriggers: [] }
      : input;
    axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
      if (request.url.endsWith('/v1/discussions/discussion') && request.method === 'GET') return { status: 200, data: { discussion: {
        id: 'discussion', ownerAccountId: 'bob', encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true,
        dataEncryptionKey: null, creationLocalId: 'opinion', titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
        latestMessage: { id: 'message', localId: 'first', seq: 1, authorAccountId: 'bob',
          accountActor: { v: 1, accountId: 'bob', profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: ['bob'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
          sendToSession: true, manageAccess: true, leave: false },
      } } };
      if (request.url.endsWith('/participants/invite') && request.method === 'POST') return { status: 200, data: {
        discussionId: 'discussion', ownerAccountId: 'bob', access: 'owner', grants: [], changed: true,
        modelParticipant: { participant: { kind: 'model', participantSlotId: input.creationKey }, launch: nestedInput.participant.launch,
          sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
      } };
      throw new Error(`Unexpected Discussion HTTP request ${request.method} ${request.url}`);
    });
    axiosGet.mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [{ id: 'machine-session',
        kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }] };
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob',
        timestamp: 1, firstName: null, lastName: null, avatar: null, github: null } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      return { status: 200, data: { machine: { storageMode: 'plain', id: 'machine-session', kind: 'persistent',
        active: true, revokedAt: null, replacedByMachineId: null,
        installationId: 'installed-current', installationPublicKey: encodeBase64(installation.publicKey),
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } };
    });
    axiosPost.mockImplementation(async (url, body) => {
      const { ExternalActionExecutionAuthorizationRequestV1Schema, computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions');
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, custodianAccountId: 'alice',
        serverIdentityId: 'srv_home', machineId: 'machine-session', installationId: 'installed-current', accountEncryptionMode: 'plain',
        actionId: 'session.spawn_new', requestId: request.envelope.requestId, target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
      effects.push('action');
      expect(String(url)).toBe('https://api.example.test/v1/actions/session.spawn_new');
      expect(request.envelope).toMatchObject({ v: 1, input: expectedSpawnInput });
      const { openExternalActionRequesterAccountContextV1 } = await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
      expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization, purpose: { kind: 'external_action' },
        machineId: 'machine-session', installationId: 'installed-current', serverIdentityId: 'srv_home', installationPrivateKey: installation.secretKey })).toEqual({ token });
      expect(JSON.stringify(request)).not.toContain(token);
      return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
        execution: { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'bob-session',
          executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } } } };
    });
    socket.emit.mockImplementation(() => { throw new Error('Raw shared Machine spawn is forbidden'); });
    const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home', serverIdentityId: 'srv_home', serverApiUrl: 'https://api.example.test',
      ...(callerKind === 'undisclosed' ? {} : { onRequesterSessionCredentialDisclosure: (disclosure: unknown) => {
        disclosures.push(disclosure); effects.push('disclosure'); return callerKind === 'notification-only' ? undefined : callerKind !== 'declined';
      } }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
      }) }),
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
        actions: { 'session.spawn_new': { enabled: callerKind !== 'disabled' } },
        approvalWaivedSurfaces: { 'session.spawn_new': ['cli'], 'discussion.invite': ['cli'] },
      }) },
    });
    const result = await executor.execute(callerKind === 'nested-human' ? 'discussion.invite' : 'session.spawn_new',
      callerKind === 'nested-human' ? nestedInput : input, callerKind !== 'unbound-agent'
      ? { surface: 'cli', authority: 'present_user' } : { surface: 'agent', causalPermissionAuthority: null,
        actionCaller: { kind: 'host' } });
    if (callerKind === 'human' || callerKind === 'nested-human') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: callerKind === 'human'
        ? { type: 'success', disposition: 'created', sessionId: 'bob-session' }
        : { modelParticipant: { sessionId: 'bob-session' }, sessionStart: { type: 'success', disposition: 'created', sessionId: 'bob-session' } } });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(disclosures).toEqual([{ disposition: 'ordinary_requester', accountId: 'bob', machineId: 'machine-session',
        custodian: { accountId: 'alice', displayName: 'Alice' }, fullSignIn: true, selectedPurposeRuntimeAuth: true, hostCanInspectLocalProcess: true }]);
      expect(effects).toEqual(['disclosure', 'action']);
    } else if (callerKind === 'disabled') {
      expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(effects).toEqual([]);
      expect(socket.emit).not.toHaveBeenCalled();
    } else if (callerKind === 'unbound-agent') {
      expect(result).toMatchObject({ ok: false, errorCode: 'causal_permission_authority_invalid' });
      expect(socket.emit).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: false });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(effects).toEqual(callerKind === 'undisclosed' ? [] : ['disclosure']);
    }
  });

  it('keeps passive change reads on the exact Machine socket and advances the accepted snapshot', async () => {
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const accepted: number[] = [];
    let after = 0;
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.method).toBe('machine-session:execution.run.wait');
      ack({ ok: true, result: { revision: payload.params.after + 1 } });
    });
    const result = await callExactMachineRpc({ credentials: { token: 'account-token', encryption: null },
      machineId: 'machine-session', method: 'execution.run.wait', request: { after }, timeoutMs: null,
      reattachOnReconnect: { readRequest: () => ({ after }), onResult: async (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('revision' in raw) || typeof raw.revision !== 'number') throw new Error('invalid snapshot');
        after = raw.revision; accepted.push(after); return after === 2;
      } },
    });
    expect(result).toEqual({ revision: 2 });
    expect(accepted).toEqual([1, 2]);
  });

  it('keeps original Session Project authority through the actual CLI Project Open port and exact socket RPC', async () => {
    const source = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const target = { kind: 'machine' as const, machineId: 'machine-target' };
    const origin = { v: 1 as const, requestId: 'project-root', sourceTurnId: 'turn',
      caller: { kind: 'session' as const, sessionId: 'bob-session', starterDepth: 1, turnDepth: 2 },
      callerPermissionMode: 'read-only' as const, workspaceWrites: 'deny' as const };
    const authorization = { v: 1 as const, token: 'original-bob-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 7 }, serverIdentityId: 'srv_home',
      machineId: target.machineId, custodianAccountId: 'alice', installationId: 'target-installation',
      actionId: 'projects.open', requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target,
      sessionActionOrigin: origin, sessionActionSource: { machineId: 'machine-source', installationId: 'source-installation' },
    } };
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: target.machineId,
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))) } } });
    let emitted: unknown;
    socket.emit.mockImplementation((_event, payload, ack) => {
      emitted = payload;
      ack({ ok: true, result: { kind: 'refused', code: 'project_open_unavailable' } });
    });
    const deps = createCliActionDeps({ token: 'bob', credentials: { token: 'bob', encryption: null },
      sessionId: 'bob-session', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://api.example.test',
      externalActionMachineInstallationId: 'source-installation', externalActionMachineRequestPrivateKey: source.secretKey });
    await expect(deps.projectsOpen!({ serverId: 'home', machineId: target.machineId,
      source: { kind: 'folder', path: '/target' }, materialization: { kind: 'attach' } }, { surface: 'agent', authority: 'account_automation',
      actionCaller: origin.caller, actionRequestId: origin.requestId,
      externalActionExecutionAuthorization: authorization, externalActionTarget: target }))
      .resolves.toMatchObject({ kind: 'refused', code: 'project_open_unavailable' });
    expect(emitted).toMatchObject({ externalActionExecution: { authorization,
      effectActionId: 'projects.open', installationId: 'target-installation' } });
  });

  it('signs a managed selected-controller RPC with the originating installation key and the destination installation tuple', async () => {
    const source = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(28));
    const target = { kind: 'machine' as const, machineId: 'machine-target' };
    const actionId = 'machines.provisioners.check';
    const origin = { v: 1 as const, requestId: 'managed-root', sourceTurnId: 'turn',
      caller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 1, turnDepth: 2 },
      callerPermissionMode: 'read-only' as const };
    const authorization = { v: 1 as const, token: 'managed-home-proof', binding: {
      accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 }, serverIdentityId: 'srv_home',
      machineId: target.machineId, custodianAccountId: 'account', installationId: 'target-installation',
      actionId, requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target,
      sessionActionOrigin: origin, sessionActionSource: { machineId: 'machine-source', installationId: 'source-installation' },
    } };
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: target.machineId,
      installationId: 'target-installation', dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.externalActionExecution).toMatchObject({ installationId: 'target-installation', authorization });
      const signature = { authorizationToken: authorization.token, effectActionId: actionId, target,
        installationId: 'target-installation', event: SOCKET_RPC_EVENTS.CALL, method: payload.method,
        requestId: payload.requestId, params: payload.params, signature: payload.externalActionExecution.machineSignature };
      expect(verifyExternalActionMachineRpcRequestV1({ ...signature, publicKey: source.publicKey })).toBe(true);
      expect(verifyExternalActionMachineRpcRequestV1({ ...signature, publicKey: receiver.publicKey })).toBe(false);
      ack({ ok: true, result: { available: true } });
    });
    await expect(callExactMachineRpc({ credentials: { token: 'account-token', encryption: null }, machineId: target.machineId,
      method: actionId, request: { kind: 'targeted_action_rpc', v: 1, target,
        input: { homeId: 'srv_home', controller: { machineId: target.machineId, installationId: 'target-installation' },
          contribution: { pluginId: 'acme.compute', localId: 'vm' } } }, requestId: origin.requestId,
      externalAction: { context: { surface: 'agent', defaultSessionMachineId: 'machine-source',
        externalActionExecutionAuthorization: authorization, externalActionTarget: target }, effectActionId: actionId,
        installationId: 'source-installation', privateKey: source.secretKey },
    })).resolves.toEqual({ available: true });
    expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v1/machines/machine-target'),
      expect.objectContaining({ headers: expect.objectContaining({
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
      }) }));
    const headers = axiosGet.mock.calls.at(-1)?.[1]?.headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      target, installationId: 'target-installation', requestId: origin.requestId, method: 'GET',
      path: '/v1/machines/machine-target', signature: headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
      publicKey: source.publicKey })).toBe(true);
  });

  it('carries after-idle guest read and reversible drain through the original signed controller authority', async () => {
    const controllerKeys = tweetnacl.sign.keyPair();
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'owner', controller,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      enrolledMachineId: 'guest', desired: 'stop', desiredWhen: 'after-idle', intentRevision: 2,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const authorization = { v: 1 as const, token: 'home-original-control', binding: {
      accountId: 'requester', principalId: 'requester', credentialId: '11111111-1111-4111-8111-111111111111',
      grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: machine.homeId, custodianAccountId: 'owner', ...controller,
      actionId: 'machines.managed.power.set', requestId: 'original-control', requestEnvelopeDigest: 'a'.repeat(43), target } };
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'guest', installationId: 'guest-installation',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))) } } });
    const requests: { method: string; params: { action?: string } }[] = [];
    socket.emit.mockImplementation((_event, payload, ack) => {
      requests.push(payload);
      if (payload.params.action === 'resume') {
        expect(payload.externalActionExecution).toBeUndefined();
      } else {
        expect(payload.externalActionExecution).toMatchObject({ authorization, target, installationId: controller.installationId });
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
          effectActionId: authorization.binding.actionId, target, installationId: controller.installationId,
          event: SOCKET_RPC_EVENTS.CALL, method: payload.method, requestId: payload.requestId, params: payload.params,
          signature: payload.externalActionExecution.machineSignature, publicKey: controllerKeys.publicKey })).toBe(true);
      }
      ack({ ok: true, result: { kind: 'busy', reasons: ['finite'] } });
    });
    const bridge = createManagedGuestActivityTransport({ token: 'owner-daemon-token', serverUrl: 'https://api.example.test',
      credentials: { token: 'owner-daemon-token', encryption: null }, externalActionMachineRequestPrivateKey: controllerKeys.secretKey },
      { requestId: 'original-control', context: { surface: 'agent', externalActionExecutionAuthorization: authorization,
        externalActionTarget: target } }, machine);
    try {
      await expect(bridge.read(machine)).resolves.toMatchObject({ kind: 'busy' });
      await expect(bridge.confirmIdle(machine)).resolves.toMatchObject({ kind: 'busy' });
      await bridge.reopen(machine);
      expect(requests.map(request => [request.method, request.params.action])).toEqual([
        ['guest:managed.activity.read', undefined], ['guest:managed.admission.drain.confirm', 'begin'],
        ['guest:managed.admission.drain.confirm', 'resume'] ]);
      // These content-free reads and reversible cleanup reuse the admitted
      // Account socket; they need neither Machine content nor an HTTP lookup.
      expect(axiosGet).not.toHaveBeenCalled();
    } finally { await bridge.dispose?.(); }
  });

  it('retains the captured source signer for PAT handoff children without borrowing the target key', async () => {
    const source = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
    const target = { kind: 'machine' as const, machineId: 'machine-target' };
    const authorization = { v: 1 as const, token: 'home-pat-handoff-child', binding: { accountId: 'bob', principalId: 'bob',
      credentialId: '11111111-1111-4111-8111-111111111111', grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'srv_home',
      machineId: target.machineId, custodianAccountId: 'alice', installationId: 'target-installation',
      actionId: 'session.spawn_new', requestId: 'pat-handoff-root', requestEnvelopeDigest: 'a'.repeat(43), target,
      handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'machine-source', targetMachineId: target.machineId,
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      handoffContinuation: { rootRequestId: 'pat-handoff-root', rootRequestEnvelopeDigest: 'b'.repeat(43), handoffId: 'handoff' } } };
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: target.machineId,
      installationId: 'target-installation', dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))) } } });
    socket.emit.mockImplementation((_event, payload, ack) => {
      const execution = payload.externalActionExecution;
      expect(execution.installationId).toBe('target-installation');
      const signed = { authorizationToken: authorization.token, effectActionId: 'session.spawn_new', target,
        installationId: 'target-installation', event: SOCKET_RPC_EVENTS.CALL, method: payload.method,
        requestId: payload.requestId, params: payload.params, signature: execution.machineSignature };
      expect(verifyExternalActionMachineRpcRequestV1({ ...signed, publicKey: source.publicKey })).toBe(true);
      expect(verifyExternalActionMachineRpcRequestV1({ ...signed, publicKey: receiver.publicKey })).toBe(false);
      ack({ ok: true, result: { type: 'success' } });
    });
    await expect(callExactMachineRpc({ credentials: { token: 'bob-requester-content', encryption: null }, machineId: target.machineId,
      method: RPC_METHODS.SPAWN_HAPPY_SESSION, request: { type: 'resume-session', sessionId: 'same-session', directory: '/target', resume: 'native-original' },
      externalAction: { context: { surface: 'api', defaultSessionMachineId: 'machine-source', externalActionTarget: target,
        externalActionExecutionAuthorization: authorization }, effectActionId: 'session.spawn_new',
        installationId: 'source-installation', privateKey: source.secretKey } })).resolves.toMatchObject({ type: 'success' });
    const headers = axiosGet.mock.calls.at(-1)?.[1]?.headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'session.spawn_new',
      target, installationId: 'target-installation', requestId: authorization.binding.requestId, method: 'GET',
      path: '/v1/machines/machine-target', signature: headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: source.publicKey })).toBe(true);
  });

  it.each([
    'session.board.item.upsert',
    'follow.set',
  ] as const)('carries a fresh exact-request Machine signature for external %s socket RPC', async (effectActionId) => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-one' };
    const authorization = {
      v: 1 as const,
      token: 'home-invocation-proof',
      binding: {
        serverIdentityId: 'home-one', accountId: 'account-one', custodianAccountId: 'account-one', installationId: 'installation-one', principalId: 'account-one',
        credentialId: '11111111-1111-4111-8111-111111111111', machineId: 'machine-caller',
        grant: API_TOKEN_FULL_GRANT_V1,
        actionId: effectActionId, requestId: 'outer-request',
        requestEnvelopeDigest: 'A'.repeat(43), target,
      },
    };
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'machine-session',
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.requestId).toEqual(expect.any(String));
      expect(payload.externalActionExecution).toMatchObject({
        authorization,
        effectActionId,
        target,
        installationId: 'installation-one',
      });
      expect(verifyExternalActionMachineRpcRequestV1({
        authorizationToken: authorization.token,
        effectActionId,
        target,
        installationId: 'installation-one',
        event: SOCKET_RPC_EVENTS.CALL,
        method: payload.method,
        requestId: payload.requestId,
        params: payload.params,
        publicKey: keyPair.publicKey,
        signature: payload.externalActionExecution.machineSignature,
      })).toBe(true);
      ack({ ok: true, result: { generation: 1 } });
    });
    await expect(callExactMachineRpc({
      credentials: { token: 'daemon-token', encryption: null },
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId: 'machine-session' },
      externalAction: {
        context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
        effectActionId,
        installationId: 'installation-one',
        privateKey: keyPair.secretKey,
      },
    })).resolves.toEqual({ generation: 1 });
    const machineLookup = axiosGet.mock.calls.at(-1);
    expect(machineLookup?.[1]?.headers?.Authorization).toBeUndefined();
    expect(machineLookup?.[1]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    expect(verifyExternalActionMachineRequestV1({
      authorizationToken: authorization.token,
      effectActionId,
      target,
      installationId: 'installation-one',
      requestId: authorization.binding.requestId,
      method: 'GET',
      path: '/v1/machines/machine-session',
      publicKey: keyPair.publicKey,
      signature: machineLookup?.[1]?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
    })).toBe(true);
  });

  it('encrypts and sends one account-scoped call to only the requested machine', async () => {
    const credentials = accountDataKeyCredentials(3);
    const machineKey = credentials.encryption.machineKey;
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          storageMode: 'e2ee', id: 'machine-session',
          dataEncryptionKey: publishedMachineDataEncryptionKey({
            contentKey: machineKey,
            recipientPublicKey: credentials.encryption.publicKey,
          }),
        },
      },
    });
    socket.emit.mockImplementation(async (_event, payload, callback) => {
      expect(payload.method).toBe('machine-session:spawn-happy-session');
      expect(payload.authorization).toEqual({
        kind: 'session.write',
        sessionId: 'session-1',
      });
      expect(payload.requestId).toEqual(expect.any(String));
      expect(await openedWith(machineKey, payload.params, payload.method)).toEqual({ sessionId: 'session-1' });
      callback({
        ok: true,
        result: await responseForRequest(machineKey, payload, { type: 'success', sessionId: 'session-1' }),
      });
    });

    await expect(callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      authorization: {
        kind: 'session.write',
        sessionId: 'session-1',
      },
      timeoutMs: 100,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('round-trips a bounded terminal base64 frame byte-exactly through the encrypted JSON socket envelope', async () => {
    const credentials = accountDataKeyCredentials(7);
    const machineKey = credentials.encryption.machineKey;
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          storageMode: 'e2ee', id: 'machine-session',
          dataEncryptionKey: publishedMachineDataEncryptionKey({
            contentKey: machineKey,
            recipientPublicKey: credentials.encryption.publicKey,
          }),
        },
      },
    });
    const bytes = new Uint8Array(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }
    bytes.set([0x00, 0xc0, 0x80, 0x81, 0x9f, 0xff], 0);
    bytes.set([0xff, 0x9f, 0x81, 0x80, 0xc0, 0x00], bytes.length - 6);

    const request = TerminalStreamReadRequestSchema.parse({
      terminalId: 'term-byte-exact',
      byteOffset: 0,
      maxBytes: TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
      maxFrames: 1,
    });
    const response = TerminalStreamReadResponseSchema.parse({
      ok: true,
      terminalId: request.terminalId,
      frames: [{
        t: 'bytes',
        terminalId: request.terminalId,
        seq: 0,
        byteOffset: 0,
        byteLength: bytes.byteLength,
        encoding: 'base64',
        data: encodeTerminalStreamBytes(bytes),
      }],
      nextByteOffset: bytes.byteLength,
      availableByteOffset: bytes.byteLength,
      droppedBeforeByteOffset: 0,
      done: false,
    });

    socket.emit.mockImplementation(async (_event, payload, callback) => {
      const socketPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      expect(socketPayload.method).toBe(`machine-session:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`);
      expect(typeof socketPayload.params).toBe('string');
      if (typeof socketPayload.params !== 'string') {
        throw new Error('expected encrypted machine RPC params');
      }
      expect(TerminalStreamReadRequestSchema.parse(
        await openedWith(machineKey, socketPayload.params, String(socketPayload.method)),
      )).toEqual(request);

      callback(JSON.parse(JSON.stringify({
        ok: true,
        result: await responseForRequest(machineKey, payload, response),
      })));
    });

    const result = TerminalStreamReadResponseSchema.parse(await callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      request,
      timeoutMs: 100,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected terminal byte stream response');
    const frame = result.frames[0];
    expect(frame?.t).toBe('bytes');
    if (!frame || frame.t !== 'bytes') throw new Error('expected terminal bytes frame');
    expect(frame.data).toHaveLength(TERMINAL_STREAM_MAX_ENCODED_BYTES);
    expect(decodeTerminalStreamBytesFrame(frame)).toEqual(bytes);
  });

  /**
   * The published envelope names the Machine's own content key. An ordinary
   * Machine seals the Account-wide machine key into it, so both readings agree
   * there — a Machine published with its own scoped key is where deriving the
   * Account key instead would encrypt for the wrong reader.
   */
  describe('published machine content key', () => {
    it('opens the published envelope and uses that scoped key, not account-wide material', async () => {
      const credentials = accountDataKeyCredentials(11);
      const machineKey = credentials.encryption.machineKey;
      const scopedMachineKey = new Uint8Array(32).fill(29);
      axiosGet.mockResolvedValue({
        data: {
          machine: {
            storageMode: 'e2ee', id: 'machine-scoped',
            dataEncryptionKey: publishedMachineDataEncryptionKey({
              contentKey: scopedMachineKey,
              recipientPublicKey: credentials.encryption.publicKey,
            }),
          },
        },
      });
      const receiver = new RpcHandlerManager({
        scopePrefix: 'machine-scoped',
        encryptionMode: 'e2ee',
        encryptionKey: scopedMachineKey,
        encryptionVariant: 'dataKey',
        logger: () => {},
      });
      receiver.registerHandler('prepare-source-key', async (request) => {
        expect(request).toEqual({ sourceKey: 'source-dek' });
        return { ok: true };
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(scopedMachineKey, payload.params, payload.method)).toEqual({ sourceKey: 'source-dek' });
        // The Account-wide machine key must not open what the scoped key sealed.
        expect(await openedWith(machineKey, payload.params, payload.method)).toBeNull();
        callback({
          ok: true,
          result: await receiver.handleRequest(payload),
        });
      });

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'machine-scoped',
        expectedEncryptionMode: 'e2ee',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      })).resolves.toEqual({ ok: true });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('rejects a substituted plain marker before emitting an explicitly encrypted exact call', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        storageMode: 'e2ee', id: 'machine-scoped',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });
      socket.emit.mockImplementation((_event, _payload, callback) => callback({ ok: true, result: { ok: true } }));
      const error = await callExactMachineRpc({
        credentials: accountDataKeyCredentials(11), machineId: 'machine-scoped',
        expectedEncryptionMode: 'e2ee', method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.connect).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'revoked', currentness: { revokedAt: 1234 } },
      { name: 'replaced', currentness: { replacedByMachineId: 'runner-successor' } },
    ])('rejects a $name exact target before encrypting private material', async ({ currentness }) => {
      axiosGet.mockResolvedValue({ data: { machine: {
        storageMode: 'plain', id: 'runner-stale',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
        ...currentness,
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'runner-stale',
        requireCurrentMachine: true,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({ code: 'machine_target_not_current' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects a substituted exact Machine projection before private RPC emission', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        storageMode: 'plain', id: 'runner-substituted',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'runner-expected',
        requireCurrentMachine: true,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({
        message: expect.stringContaining('runner-expected was not returned'),
      });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects a persistent Machine before emitting a Runner-only private RPC', async () => {
      axiosGet.mockResolvedValue({ data: { machine: {
        storageMode: 'plain', id: 'machine-persistent',
        kind: 'persistent',
        dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
      } } });

      const error = await callExactMachineRpc({
        credentials: { token: 'plain-token', encryption: null },
        machineId: 'machine-persistent',
        requiredMachineKind: 'ephemeral_session_runner',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({ code: 'machine_kind_mismatch' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('requires the creator-signed exact Runner Machine tuple before emitting private RPC', async () => {
      const credentials = legacyCredentials(31);
      const scopedMachineKey = new Uint8Array(32).fill(37);
      const signing = tweetnacl.sign.keyPair.fromSeed(credentials.encryption.secret);
      const bindingPayload = {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: 'home-one',
        activationId: '11111111-1111-4111-8111-111111111111',
        creatorAccountId: 'account-one',
        machineId: 'runner-one',
        installationId: 'runner-installation',
        machineContentKeyFingerprint:
          computeRunnerMachineContentKeyFingerprintV1(scopedMachineKey),
      };
      const binding = {
        ...signRunnerMachineContentKeyBindingV1({
          payload: bindingPayload,
          activationSigningSecretKey: signing.secretKey,
        }),
        // The daemon holds no creator device custody, so the verifier identity
        // comes from the creator-sealed Account-scoped fact.
        creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
          payload: {
            v: 1,
            activationId: bindingPayload.activationId,
            machineId: bindingPayload.machineId,
            activationSigningPublicKey: encodeProtocolBase64(signing.publicKey, 'base64url'),
          },
          material: { type: 'legacy', secret: credentials.encryption.secret },
          randomBytes: (length: number) => new Uint8Array(length).fill(3),
        }),
      };
      const machine = {
        storageMode: 'e2ee', id: 'runner-one',
        kind: 'ephemeral_session_runner',
        installationId: 'runner-installation',
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: deriveBoxPublicKeyFromSeed(
            deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret),
          ),
        }),
        runnerContentKeyBinding: binding,
      };
      axiosGet.mockResolvedValue({ data: { machine } });
      socket.emit.mockImplementation(async (_event, payload, callback) =>
        callback({
          ok: true,
          result: await responseForRequest(scopedMachineKey, payload, { installed: true }),
        }));

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'runner-one',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      })).resolves.toEqual({ installed: true });
      expect(socket.emit).toHaveBeenCalledOnce();

      vi.clearAllMocks();
      axiosGet.mockResolvedValue({
        data: { machine: { ...machine, installationId: 'substituted-installation' } },
      });
      const error = await callExactMachineRpc({
        credentials,
        machineId: 'runner-one',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('does not accept a Home-supplied Runner signer for DataKey credentials', async () => {
      const credentials = accountDataKeyCredentials(31);
      const scopedMachineKey = new Uint8Array(32).fill(37);
      const untrustedSigning = tweetnacl.sign.keyPair();
      const bindingPayload = {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: 'home-one',
        activationId: '11111111-1111-4111-8111-111111111111',
        creatorAccountId: 'account-one',
        machineId: 'runner-one',
        installationId: 'runner-installation',
        machineContentKeyFingerprint:
          computeRunnerMachineContentKeyFingerprintV1(scopedMachineKey),
      };
      axiosGet.mockResolvedValue({ data: { machine: {
        id: bindingPayload.machineId,
        kind: 'ephemeral_session_runner',
        installationId: bindingPayload.installationId,
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: credentials.encryption.publicKey,
        }),
        runnerContentKeyBinding: signRunnerMachineContentKeyBindingV1({
          payload: bindingPayload,
          activationSigningSecretKey: untrustedSigning.secretKey,
        }),
      } } });

      const error = await callExactMachineRpc({
        credentials,
        machineId: bindingPayload.machineId,
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        expectedEncryptionMode: 'e2ee',
        expectedRunnerMachineContentKeyBinding: {
          homeServerIdentityId: bindingPayload.homeServerIdentityId,
          creatorAccountId: bindingPayload.creatorAccountId,
          machineId: bindingPayload.machineId,
        },
        timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('fails closed when a present envelope cannot be opened with account material', async () => {
      const credentials = accountDataKeyCredentials(11);
      const unrelatedAccount = accountDataKeyCredentials(23);
      axiosGet.mockResolvedValue({
        data: {
          machine: {
            id: 'machine-foreign',
            dataEncryptionKey: publishedMachineDataEncryptionKey({
              contentKey: new Uint8Array(32).fill(29),
              recipientPublicKey: unrelatedAccount.encryption.publicKey,
            }),
          },
        },
      });

      const error = await callMachineRpc({
        credentials,
        machineId: 'machine-foreign',
        method: 'prepare-source-key',
        request: { sourceKey: 'source-dek' },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(String((error as Error).message)).toContain('machine-foreign');
      // An unopenable present envelope is never downgraded to the absent case.
      expect(socket.emit).not.toHaveBeenCalled();
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
    });

    it.each(['', '   ', {}, 42])('rejects malformed-present envelope %j before sending', async (published) => {
      axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'e2ee', id: 'machine-scoped', dataEncryptionKey: published } } });
      const error = await callMachineRpc({
        credentials: accountDataKeyCredentials(11),
        machineId: 'machine-scoped', method: 'status', request: { secret: 'private' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('rejects noncanonical encoding of an otherwise valid scoped envelope before sending', async () => {
      const credentials = accountDataKeyCredentials(11);
      const envelope = publishedMachineDataEncryptionKey({
        contentKey: new Uint8Array(32).fill(29),
        recipientPublicKey: credentials.encryption.publicKey,
      });
      axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'e2ee', id: 'machine-scoped', dataEncryptionKey: `!${envelope}` } } });
      const error = await callExactMachineRpc({
        credentials,
        machineId: 'machine-scoped', method: 'status', request: { secret: 'private' }, timeoutMs: 100,
      }).catch((thrown) => thrown);
      expect(error).toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('opens a selected scoped envelope with recovery-secret credentials through the real receiver', async () => {
      const secret = new Uint8Array(32).fill(19);
      const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
      const scopedMachineKey = new Uint8Array(32).fill(29);
      axiosGet.mockResolvedValue({ data: { machine: {
        storageMode: 'e2ee', id: 'machine-scoped',
        dataEncryptionKey: publishedMachineDataEncryptionKey({
          contentKey: scopedMachineKey,
          recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        }),
      } } });
      const receiver = new RpcHandlerManager({
        scopePrefix: 'machine-scoped', encryptionMode: 'e2ee',
        encryptionKey: scopedMachineKey, encryptionVariant: 'dataKey', logger: () => {},
      });
      receiver.registerHandler('status', async (request) => ({ received: request }));
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        callback({ ok: true, result: await receiver.handleRequest(payload) });
      });
      await expect(callMachineRpc({
        credentials: { token: 'account-token', encryption: { type: 'legacy', secret } },
        machineId: 'machine-scoped', method: 'status', request: { ping: true }, timeoutMs: 100,
      })).resolves.toEqual({ received: { ping: true } });
    });

    it('keeps released account-key behavior for a machine that published no envelope', async () => {
      const credentials = accountDataKeyCredentials(5);
      const machineKey = credentials.encryption.machineKey;
      axiosGet.mockResolvedValue({
        data: { machine: { storageMode: 'e2ee', id: 'machine-historical' } },
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(machineKey, payload.params, payload.method)).toEqual({ ping: true });
        callback({
          ok: true,
          result: await responseForRequest(machineKey, payload, { status: 'running' }),
        });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-historical',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });
    });

    it('keeps released legacy-secret behavior', async () => {
      const secret = new Uint8Array(32).fill(9);
      const credentials = {
        token: 'account-token',
        encryption: { type: 'legacy' as const, secret },
      };
      axiosGet.mockResolvedValue({
        data: { machine: { storageMode: 'e2ee', id: 'machine-legacy' } },
      });
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        expect(await openedWith(secret, payload.params, payload.method, 'legacy'))
          .toEqual({ ping: true });
        callback({
          ok: true,
          result: await responseForRequest(secret, payload, { status: 'running' }, 'legacy'),
        });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-legacy',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });
    });
  });

  it('returns the replace Action receipt after cooperative cancellation without closing its socket early', async () => {
    const controller = new AbortController();
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: 'replace-machine',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    } } });
    const result = { ok: true, results: [{ path: 'a.txt', status: 'replaced', hash: 'b'.repeat(64), matchCount: 1,
      edits: [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }] }], cancelled: ['b.txt'] };
    let acknowledge!: (value: unknown) => void;
    let issuedRequestId: string | undefined;
    socket.emit.mockImplementation((event, payload, callback) => {
      if (event === SOCKET_RPC_EVENTS.CALL) {
        expect(payload.waitForResultOnCancel).toBe(true);
        issuedRequestId = payload.requestId;
        acknowledge = callback;
        controller.abort();
      } else if (event === SOCKET_RPC_EVENTS.CANCEL) {
        expect(payload.requestId).toBe(issuedRequestId);
        expect(socket.close).not.toHaveBeenCalled();
        acknowledge({ ok: true, result });
      }
    });
    const credentials = { token: 'replace-token', encryption: null };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://api.example.test', mode: 'plain', ctx: null }));
    await expect(executor.execute('workspace.files.replace', { machineId: 'replace-machine', rootPath: '/workspace',
      operation: { kind: 'replace', matcher: { query: 'old', replacement: 'new', matchCase: true, regex: false },
        files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: 'a'.repeat(64) })) },
    }, { surface: 'ui', authority: 'present_user', serverId: 'home', signal: controller.signal })).resolves.toEqual({ ok: true, result });
    expect(socket.close).toHaveBeenCalled();
  });

  it('preserves a confirmed retirement acknowledgement when cancellation arrives during response consumption', async () => {
    const controller = new AbortController();
    const request = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: request.machineId,
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const receipt = { status: 'retired' };
    socket.emit.mockImplementation((event, payload, acknowledge) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      expect(payload.method).toBe(`${request.machineId}:projects.worker.copy.retire`);
      // A network-response accessor injects cancellation only after the real codec
      // consumes an accepted ACK, without replacing codec or cancellation logic.
      acknowledge({ ok: true, get result() { controller.abort(); return receipt; } });
    });
    await expect(callExactMachineRpc({ credentials: { token: 'plain-token', encryption: null },
      machineId: request.machineId, method: 'projects.worker.copy.retire', request,
      timeoutMs: null, signal: controller.signal,
    })).resolves.toEqual(receipt);
    expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    expect(socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)).toBe(false);
  });

  it.each(['acknowledged', 'cancelled'] as const)('keeps SCM compose evidence within its Action lifetime (%s)', async outcome => {
    const credentials = { token: 'compose-lifetime', encryption: null };
    axiosGet.mockResolvedValue({ data: { machine: {
      id: 'compose-machine', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    } } });
    const controller = new AbortController();
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://api.example.test', mode: 'plain', ctx: null }));
    const compose = ScmPullRequestOpenComposeResponseSchema.parse({
      success: true, composeUrl: 'https://forge.example.test/group/repo/compare/base...head',
      template: { kind: 'ready' },
      nextAction: { kind: 'openUrl', purpose: 'compose',
        url: 'https://forge.example.test/group/repo/compare/base...head',
        allowedBaseUrl: 'https://forge.example.test/group/repo', urlSafety: { allowedSchemes: ['https:'] } },
    });
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.emit.mockImplementation((event, _payload, ack) => {
      if (event === SOCKET_RPC_EVENTS.CALL) acknowledge = ack;
    });
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    const pending = executor.execute('scm.pullRequest.openCompose', {
      cwd: '/repo', base: 'base', head: 'head', includeTemplate: true,
    }, { surface: 'cli', authority: 'present_user', serverId: 'home', signal: controller.signal,
      externalActionTarget: { kind: 'machine', machineId: 'compose-machine' },
    }).then(value => { result = value; });
    try {
      // Action families load on first use; settle that real module boundary before the fake clock owns time.
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(20_001);
      expect(acknowledge).toBeTypeOf('function');
      expect(result).toBeUndefined();
      if (outcome === 'cancelled') controller.abort();
      else acknowledge!({ ok: true, result: compose });
      await pending;
      if (outcome === 'acknowledged') expect(result).toEqual({ ok: true, result: compose });
      else {
        expect(result).toMatchObject({ ok: false, errorCode: 'SOCKET_RPC_ABORTED' });
        const call = socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)![1];
        expect(socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)?.[1])
          .toEqual({ requestId: call.requestId });
      }
    } finally {
      controller.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it.each(['acknowledged', 'cancelled'] as const)('delegates delayed worker status to its Action lifetime (%s)', async outcome => {
    const [{ withTempDir }, { createProjectWorkerAction }, { createProjectWorkerAdmission }, { createDaemonAdmissionDrain }] = await Promise.all([
      import('@/testkit/fs/tempDir'), import('@/workspaces/execution/projectWorkerAction'),
      import('@/workspaces/execution/projectWorkerAdmission'), import('@/daemon/lifecycle/admissionDrain'),
    ]);
    await withTempDir('worker-status-lifetime-', async rootPath => {
      const credentials = { token: 'worker-status-lifetime', encryption: null };
      const request = { workspace: { serverId: 'home', refId: 'worker-ref' },
        destination: { kind: 'machine' as const, machineId: 'worker' }, purpose: 'service-start' as const };
      const workspace = { id: request.workspace.refId, serverId: 'home', machineId: 'worker', rootPath, createdAtMs: 1 };
      const key = { kind: 'workspace-ref', serverId: 'home', id: workspace.id };
      axiosGet.mockImplementation(async (url: string) => ({ status: 200, data: url.includes('/v1/machines/')
        ? { machine: { id: 'worker', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } }
        : { mode: 'plain', updatedAt: 1 } }));
      axiosPost.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key, revision: 0, content: { t: 'plain', v: { key, value: workspace } } },
      ] } });
      const producer = createProjectWorkerAction({ machineId: 'worker', serverId: 'home',
        serverHttpBaseUrl: 'https://api.example.test', credentials, isFiniteExecutionLive: () => true, isServiceExecutionLive: () => true,
        admission: createProjectWorkerAdmission({ machineId: 'worker', admissionDrain: createDaemonAdmissionDrain(),
          readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }) });
      // Produce the response with real filesystem, rows, placement and admission owners.
      // Only HTTP, Socket.IO delivery and the clock are substituted boundaries.
      const status = await producer({ actionId: 'projects.worker.status', input: request, context: { serverId: 'home' } });
      expect(status).toMatchObject({ eligible: true, candidate: { serverId: 'home', machineId: 'worker' } });
      const controller = new AbortController();
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'https://api.example.test', mode: 'plain', ctx: null }));
      vi.useFakeTimers();
      let acknowledge: ((value: unknown) => void) | undefined;
      socket.emit.mockImplementation((event, _payload, ack) => {
        if (event === SOCKET_RPC_EVENTS.CALL) acknowledge = ack;
      });
      let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
      const pending = executor.execute('projects.worker.status', request, { surface: 'agent', authority: 'account_automation',
        serverId: 'home', signal: controller.signal }).then(value => { result = value; });
      try {
        await vi.advanceTimersByTimeAsync(20_001);
        expect(acknowledge).toBeTypeOf('function');
        expect(result).toBeUndefined();
        if (outcome === 'cancelled') controller.abort();
        else acknowledge!({ ok: true, result: status });
        await pending;
        if (outcome === 'acknowledged') expect(result).toEqual({ ok: true, result: status });
        else {
          expect(result).toMatchObject({ ok: false, errorCode: 'SOCKET_RPC_ABORTED' });
          const call = socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)![1];
          expect(socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)?.[1])
            .toEqual({ requestId: call.requestId });
        }
      } finally {
        controller.abort();
        await pending;
        vi.useRealTimers();
      }
    });
  });

  it('withdraws a cancelled passive status observation even when its acknowledgement was accepted', async () => {
    const controller = new AbortController();
    const request = ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse(
      JSON.parse(getActionSpec('projects.worker.status').examples!.voice!.argsExample!),
    );
    axiosGet.mockResolvedValue({ data: { machine: { storageMode: 'plain', id: request.destination.machineId,
      dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }))),
    } } });
    const result = { eligible: true, candidate: { serverId: request.workspace.serverId, machineId: request.destination.machineId },
      load: { kind: 'unknown' }, explanation: 'load_unknown' };
    socket.emit.mockImplementation((event, _payload, acknowledge) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      acknowledge({ ok: true, get result() { controller.abort(); return result; } });
    });
    await expect(callExactMachineRpc({ credentials: { token: 'plain-token', encryption: null },
      machineId: request.destination.machineId, method: 'projects.worker.status', request,
      reattachOnReconnect: {}, timeoutMs: null, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    expect(socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)).toBe(false);
  });

  it('sends plaintext RPC for a marker-backed machine with token-only credentials', async () => {
    const semanticallyEquivalentPlainMarker = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null }, null, 2)),
      'base64',
    );
    axiosGet.mockResolvedValue({
      data: {
        machine: {
          storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: semanticallyEquivalentPlainMarker,
        },
      },
    });
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload.method).toBe('machine-plain:status');
      expect(payload.params).toEqual({ ping: true });
      callback({
        ok: true,
        result: { status: 'running' },
      });
    });

    await expect(callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 100,
    })).resolves.toEqual({ status: 'running' });

    expect(String(axiosGet.mock.calls[0]?.[0])).toMatch(
      /\/v1\/machines\/machine-plain$/,
    );
    expect(axiosGet.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer plain-token',
      }),
    }));
    // A reached machine never pays for the replacement chain: the only server
    // read is the per-machine codec lookup this call already needed.
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('distinguishes failures before RPC emission from ambiguous failures after emission', async () => {
    axiosGet.mockRejectedValueOnce(new Error('machine lookup failed'));
    const credentials = { token: 'plain-token', encryption: null };

    const beforeEmission = await callMachineRpc({
      credentials,
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 10,
    }).catch((error) => error);
    expect(readMachineRpcRequestDisposition(beforeEmission)).toBe('notSent');

    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    socket.emit.mockImplementationOnce(() => undefined);
    const afterEmission = await callMachineRpc({
      credentials,
      machineId: 'machine-plain',
      method: 'status',
      request: { ping: true },
      timeoutMs: 10,
    }).catch((error) => error);
    expect(readMachineRpcRequestDisposition(afterEmission)).toBe('outcomeUnknown');
  });

  it('spends one machine RPC budget across the Machine read and acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      axiosGet.mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return { data: { machine: { storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })), 'base64') } } };
      });
      socket.emit.mockImplementationOnce(() => undefined);
      let error: unknown;
      const pending = callExactMachineRpc({ credentials: { token: 'plain-token', encryption: null },
        machineId: 'machine-plain', method: 'status', request: {}, timeoutMs: 100,
      }).catch(value => { error = value; });
      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(21);
      expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
      expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
    } finally { vi.useRealTimers(); }
  });

  it.each(['success', 'cancelled', 'deadline'] as const)('binds a stopped Session resume to its startup lifetime without replay (%s)', async (outcome) => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    axiosGet.mockResolvedValueOnce({ data: { machine: { storageMode: 'plain', id: 'machine-plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } });
    let replied = false;
    socket.emit.mockImplementationOnce((event, _payload, ack) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      setTimeout(() => { replied = true; ack({ ok: true, result: { type: 'success', sessionId: 'stopped-session' } }); }, 28_120);
    });
    let result: Awaited<ReturnType<typeof requestInactiveSessionResume>> | undefined;
    const cancellation = new AbortController();
    const pending = requestInactiveSessionResume({ credentials: { token: 'plain-token', encryption: null },
      sessionId: 'stopped-session', requestId: 'workflow:own-run:own-child:session-ready', waitForReady: true,
      signal: cancellation.signal,
      ...(outcome === 'deadline' ? { timeoutMs: 28_000 } : {}),
      rawSession: createSessionRecordFixture({ id: 'stopped-session', active: false, machineId: 'machine-plain', path: '/repo' }),
      metadata: { machineId: 'machine-plain', path: '/repo', claudeSessionId: 'native-session',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } },
    }).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(19_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeUndefined();
      expect(replied).toBe(false);
      const emitted = socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)?.[1];
      expect(emitted).toMatchObject({ method: `machine-plain:${RPC_METHODS.SPAWN_HAPPY_SESSION}` });
      if (outcome === 'cancelled') cancellation.abort();
      await vi.advanceTimersByTimeAsync(8_120);
      await pending;
      expect(replied).toBe(true);
      if (outcome === 'success') {
        expect(result).toEqual({ ok: true });
        expect(diagnostic).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: false, code: outcome === 'deadline' ? 'timeout' : 'resume_failed' });
        expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
          requestId: 'workflow:own-run:own-child:session-ready', spawnRpcRequestId: emitted.requestId,
          phase: 'spawn_rpc', cancelled: outcome === 'cancelled',
          ...(outcome === 'deadline' ? { cause: 'MACHINE_RPC_TIMEOUT', elapsedMs: 28_000 } : {}),
        }));
      }
      expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    } finally {
      cancellation.abort();
      await pending;
      diagnostic.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['replay', 'memory', 'memory search', 'memory status'] as const)('keeps the containing %s operation open beyond the generic RPC cutoff', async (operation) => {
    const settings = await persistence.readSettings();
    const settingsRead = vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, machineId: 'machine-plain' });
    vi.useFakeTimers();
    const credentials = { token: 'plain-token', encryption: null };
    axiosGet.mockResolvedValueOnce({ data: { machine: { storageMode: 'plain', id: 'machine-plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } });
    const receipt = operation === 'replay' ? { type: 'success', sessionId: 'continued-session' }
      : operation === 'memory search' ? { v: 1, ok: true, hits: [] }
      : operation === 'memory status' ? MemoryStatusV1Schema.parse({
        v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
        deepIndexReady: true, activeIndexReady: true, embeddingsEnabled: false,
        embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
        embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
        tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
      }) : { ok: true };
    socket.emit.mockImplementationOnce((_event, _payload, ack) => {
      setTimeout(() => ack({ ok: true, result: receipt }), 28_120);
    });
    const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: '', mode: 'plain', ctx: null });
    const pending = (operation === 'replay'
      ? deps.sessionContinueWithReplay!({ directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          replay: { previousSessionId: 'stopped-session' } })
      : operation === 'memory search'
        ? deps.daemonMemorySearch({ machineId: 'machine-plain', query: {
          v: 1, query: 'release', scope: { type: 'global' }, mode: 'auto',
        } })
        : operation === 'memory status'
          ? deps.daemonMemoryStatus!({ machineId: 'machine-plain', context: { surface: 'cli' } })
          : deps.daemonMemoryEnsureUpToDate({ machineId: 'machine-plain', sessionId: 'stopped-session' })
    ).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    try {
      // Action families load on first use; settle that real module boundary before the fake clock owns time.
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(28_120);
      expect(await pending).toEqual({ ok: true, value: receipt });
      const calls = socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({ method: `machine-plain:${operation === 'replay'
        ? RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY : operation === 'memory search' ? RPC_METHODS.DAEMON_MEMORY_SEARCH
          : operation === 'memory status' ? RPC_METHODS.DAEMON_MEMORY_STATUS : RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE}` });
    } finally {
      await pending;
      settingsRead.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['memory.status', 'search.settings.get'] as const)(
    'preserves a missing local handler refusal through the real %s Action', async actionId => {
      const machineId = 'missing-memory-machine';
      const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger() {} });
      const credentials = { token: 'plain-token', encryption: null };
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
          machineId, invoke: (method, request, options) => manager.invokeLocal(method, request, options),
        } }));
      expect(await executor.execute(actionId, { machineId }, { surface: 'cli', authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    },
  );

  it('keeps caller-lifecycle machine RPC acknowledgement open until cancellation', async () => {
    vi.useFakeTimers();
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    socket.emit.mockImplementationOnce(() => undefined);
    const abort = new AbortController();
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: abort.signal,
    });
    const errorPromise = promise.catch((error) => error);

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.disconnect).not.toHaveBeenCalled();
      const callPayload = socket.emit.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)?.[1];
      expect(callPayload).toHaveProperty('timeoutMs', null);

      abort.abort();
      const error = await errorPromise;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
      expect(socket.disconnect).toHaveBeenCalledOnce();
      expect(socket.close).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      await errorPromise;
      vi.useRealTimers();
    }
  });

  it('settles an emitted machine RPC when its socket disconnects before acknowledgement', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    let resolveEmitted = () => {};
    const emitted = new Promise<void>((resolve) => {
      resolveEmitted = resolve;
    });
    socket.emit.mockImplementationOnce(() => {
      resolveEmitted();
      return undefined;
    });
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
    });

    await emitted;
    socketHandlers.get('disconnect')?.();
    const error = await promise.catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Machine RPC socket disconnected before acknowledgement' });
    expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('settles a connect-then-disconnect race before emission even with no acknowledgement timeout', async () => {
    axiosGet.mockResolvedValueOnce({
      data: {
        machine: {
          storageMode: 'plain', id: 'machine-plain',
          dataEncryptionKey: encodeBase64(
            new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
            'base64',
          ),
        },
      },
    });
    let resolveConnected = () => {};
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    socket.connect.mockImplementationOnce(() => {
      socketHandlers.get('connect')?.();
      socketHandlers.get('disconnect')?.();
      resolveConnected();
    });
    const observationFallback = new AbortController();
    const promise = callMachineRpc({
      credentials: { token: 'plain-token', encryption: null },
      machineId: 'machine-plain',
      method: 'execution.run.wait',
      request: { runId: 'run_1' },
      timeoutMs: null,
      signal: observationFallback.signal,
    });

    await connected;
    observationFallback.abort(new Error('test observation fallback'));
    const error = await promise.catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Machine RPC socket disconnected before acknowledgement' });
    expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  /**
   * A user who replaces a machine keeps the Sessions the previous one hosted.
   * Nothing re-homes those rows, so a CLI/MCP send or resume still addresses the
   * PREDECESSOR; reaching the successor is what makes the replacement usable.
   */
  describe('exact session creation target', () => {
    const credentials = { token: 'plain-token', encryption: null };
    const creationOutcome = { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } as const;

    beforeEach(() => {
      // Fetch, HTTP and Socket.IO are the boundaries; creation, target selection,
      // request codecs and nonce settlement all run their production logic.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'account' }), { status: 200 })));
      axiosGet.mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines') return { status: 200, data: [
          { id: 'remote', replacedByMachineId: 'replacement' },
          { id: 'replacement', replacedByMachineId: null },
        ] };
        if (path.startsWith('/v1/machines/')) return { status: 200, data: { machine: {
          id: path.slice('/v1/machines/'.length), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } };
        if (path.startsWith('/v2/sessions/')) return { status: 200, data: { session: createSessionRecordFixture({
          id: 'remote-session', encryptionMode: 'plain', machineId: 'remote',
          metadata: JSON.stringify({ path: '/remote-only/project', machineId: 'remote' }),
        }) } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1 } };
        throw new Error(`Unexpected creation HTTP read: ${path}`);
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    it.each([false, true])('settles a remote-only path on the selected machine (provider-bound: %s)', async providerBound => {
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (payload.method === `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`) {
          expect(payload.params).toMatchObject({ spawnNonce: 'remote-launch' });
          ack({ ok: true, result: { status: 'success', sessionId: 'remote-session', sessionCreationOutcome: creationOutcome } });
          return;
        }
        expect(payload.method).toBe(`remote:${providerBound ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE : RPC_METHODS.SPAWN_HAPPY_SESSION}`);
        expect(payload.params).toMatchObject({ machineId: 'remote', directory: '/remote-only/project', spawnNonce: 'remote-launch' });
        ack({ ok: true, result: { success: true, status: 'pending', spawnNonce: 'remote-launch' } });
      });
      await expect(createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, spawnNonce: 'remote-launch',
        ...(providerBound ? { modelSelection: SessionModelSelectionV1Schema.parse({ v: 1, ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'model' }, updatedAt: 1 }) } : {}),
      })).resolves.toMatchObject({ sessionId: 'remote-session', disposition: 'created' });
      expect(methods).toEqual([
        `remote:${providerBound ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE : RPC_METHODS.SPAWN_HAPPY_SESSION}`,
        `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`,
      ]);
    });

    it.each([false, true])('fails an unreachable explicit target without spawning on its replacement or locally (provider-bound: %s)', async providerBound => {
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (payload.method.startsWith('remote:')) ack({ ok: false,
          error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else ack({ ok: true, result: { type: 'success', sessionId: 'remote-session', sessionCreationOutcome: creationOutcome } });
      });
      await expect(createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        ...(providerBound ? { modelSelection: SessionModelSelectionV1Schema.parse({ v: 1, ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'model' }, updatedAt: 1 }) } : {}),
      })).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
      expect(methods).toEqual([`remote:${providerBound ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE : RPC_METHODS.SPAWN_HAPPY_SESSION}`]);
    });

    it('preserves a missing explicit target HTTP refusal before any spawn emission', async () => {
      // Axios supplies a typed HTTP failure when GET /v1/machines/:id is 404.
      const missingTarget = Object.assign(new Error('Request failed with status code 404'), {
        code: 'ERR_BAD_REQUEST', response: { status: 404 },
      });
      axiosGet.mockRejectedValueOnce(missingTarget);
      await expect(createSpawnedSession({ credentials, machineId: 'missing', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      })).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST', response: { status: 404 } });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(axiosGet.mock.calls.map(call => String(call[0]))).toEqual(['https://api.example.test/v1/machines/missing']);
    });

    it('keeps directory approval preparation on the selected machine when it has a replacement', async () => {
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (payload.method.startsWith('remote:')) ack({ ok: false,
          error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else ack({ ok: true, result: { ok: true, directory: '/remote-only/project', directoryKind: 'path',
          directoryCreationRequired: false, checkout: null } });
      });
      const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: '', mode: 'plain', ctx: null });
      await expect(deps.sessionSpawnNewDirectoryApprovalPreflight!({ input: {
        executionTarget: { serverId: 'home', machineId: 'remote' }, directory: { kind: 'path', path: '/remote-only/project' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      } })).resolves.toMatchObject({ type: 'error', result: { type: 'error', code: 'incompatible_target', retryable: false } });
      expect(methods).toEqual([`remote:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`]);
    });

    it('does not recover an accepted nonce on another machine after the selected target becomes unreachable', async () => {
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (payload.method === `remote:${RPC_METHODS.SPAWN_HAPPY_SESSION}`) ack({ ok: true,
          result: { success: true, status: 'pending', spawnNonce: 'remote-launch' } });
        else if (payload.method.startsWith('remote:')) ack({ ok: false,
          error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        else ack({ ok: true, result: { status: 'success', sessionId: 'remote-session', sessionCreationOutcome: creationOutcome } });
      });
      await expect(createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, spawnNonce: 'remote-launch',
      })).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.UNEXPECTED });
      expect(methods).toEqual([`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION}`, `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`]);
    });

    it.each(['disconnect', 'relay_timeout'] as const)('retains the submitted nonce after %s and resumes observation on that machine without redispatch', async failure => {
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (failure === 'disconnect') socketHandlers.get('disconnect')?.();
        else ack({ ok: false, error: 'Machine RPC forwarding timeout' });
      });
      const attempt = { credentials, machineId: 'remote', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const, spawnNonce: 'remote-launch' };
      const disconnected = await createSpawnedSession(attempt).catch(error => error);
      expect(readMachineRpcRequestDisposition(disconnected)).toBe('outcomeUnknown');
      expect(disconnected).toMatchObject({ details: { spawnNonce: 'remote-launch' } });
      socket.emit.mockImplementation((event, payload, ack) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        expect(payload.params).toMatchObject({ spawnNonce: 'remote-launch' });
        ack({ ok: true, result: { status: 'success', sessionId: 'remote-session', sessionCreationOutcome: creationOutcome } });
      });
      await expect(createSpawnedSession({ ...attempt, resumeOnly: true })).resolves.toMatchObject({ sessionId: 'remote-session' });
      expect(methods).toEqual([`remote:${RPC_METHODS.SPAWN_HAPPY_SESSION}`, `remote:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`]);
    });

    it('does not claim an accepted spawn when disconnected before sending', async () => {
      socket.connect.mockImplementationOnce(() => {
        socketHandlers.get('connect')?.();
        socketHandlers.get('disconnect')?.();
      });
      const disconnected = await createSpawnedSession({ credentials, machineId: 'remote', directory: '/remote-only/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, spawnNonce: 'remote-launch',
      }).catch(error => error);
      expect(readMachineRpcRequestDisposition(disconnected)).toBe('notSent');
      expect(disconnected).not.toHaveProperty('details.spawnNonce');
      expect(socket.emit).not.toHaveBeenCalled();
    });
  });

  describe('replaced machine', () => {
    const PLAIN_MARKER = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
      'base64',
    );

    function mockServerReads(machines: ReadonlyArray<Record<string, unknown>>): void {
      axiosGet.mockImplementation(async (url: unknown) => {
        const href = String(url);
        if (/\/v1\/machines\?includeRevoked=true$/.test(href)) return { data: machines };
        const machineId = href.slice(href.lastIndexOf('/') + 1);
        return { data: { machine: { storageMode: 'plain', id: machineId, dataEncryptionKey: PLAIN_MARKER } } };
      });
    }

    function unreachable() {
      return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const credentials = { token: 'plain-token', encryption: null };

    it.each([false, true])('keeps explicit creation and recovery on the selected machine (resumeOnly=%s)', async resumeOnly => {
      // HTTP and Socket.IO are the boundaries; the creator, codecs, replacement
      // lookup and nonce settlement remain real.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'account-one' }), { status: 200 })));
      mockServerReads([{ id: 'machine-old', replacedByMachineId: 'machine-new' }, { id: 'machine-new' }]);
      const methods: string[] = [];
      socket.emit.mockImplementation((event, payload, callback) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        methods.push(payload.method);
        if (payload.method.startsWith('machine-old:')) return callback(unreachable());
        callback({ ok: true, result: {
          ...(resumeOnly ? { status: 'error' } : { type: 'error' }),
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: 'An unselected successor received the attempt',
        } });
      });
      try {
        await expect(createSpawnedSession({
          credentials, directory: '/remote-only/repo', machineId: 'machine-old',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          spawnNonce: 'selected-machine-attempt', resumeOnly,
        })).rejects.toMatchObject({
          code: resumeOnly ? SPAWN_SESSION_ERROR_CODES.UNEXPECTED : SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        });
        expect(methods).toEqual([`machine-old:${resumeOnly
          ? RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE : RPC_METHODS.SPAWN_HAPPY_SESSION}`]);
      } finally { vi.unstubAllGlobals(); }
    });

    it('reaches the successor when the addressed machine was replaced', async () => {
      mockServerReads([
        { storageMode: 'plain', id: 'machine-old', replacedByMachineId: 'machine-mid' },
        { id: 'machine-mid', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, payload, callback) => {
        if (payload.method !== 'machine-new:status') {
          callback(unreachable());
          return;
        }
        callback({ ok: true, result: { status: 'running' } });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });

      // Exactly one retry, addressed to the end of the replacement chain, and
      // encoded with the SUCCESSOR's own codec rather than the predecessor's.
      expect(socket.emit).toHaveBeenCalledTimes(2);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      expect(socket.emit.mock.calls[1]?.[1]?.method).toBe('machine-new:status');
      expect(axiosGet.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringMatching(/\/v1\/machines\/machine-old$/),
        expect.stringMatching(/\/v1\/machines\?includeRevoked=true$/),
        expect.stringMatching(/\/v1\/machines\/machine-new$/),
      ]);
    });

    /**
     * Delivering source key material is addressed to ONE verified machine. A
     * replacement is a different machine with different authority, so silently
     * re-addressing the delivery would hand the material to a target the caller
     * never authorized.
     */
    it('never redirects an exact-machine call to a replacement', async () => {
      mockServerReads([
        { storageMode: 'plain', id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callExactMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });

      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      // The replacement chain is never even read for an exact-machine call.
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error unchanged when the machine has no successor', async () => {
      mockServerReads([{ storageMode: 'plain', id: 'machine-old', replacedByMachineId: null }]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      const error = await callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      }).catch((thrown) => thrown);

      expect(error).toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(readMachineRpcRequestDisposition(error)).toBe('notSent');
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error when the replacement chain cannot be read', async () => {
      axiosGet.mockImplementation(async (url: unknown) => {
        const href = String(url);
        if (/\/v1\/machines$/.test(href)) throw new Error('chain lookup failed');
        return { data: { machine: { storageMode: 'plain', id: 'machine-old', dataEncryptionKey: PLAIN_MARKER } } };
      });
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('never re-addresses an error the machine itself answered with', async () => {
      mockServerReads([
        { storageMode: 'plain', id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback({
        ok: false,
        error: 'Session is already running',
      }));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toThrow('Session is already running');

      // A successor EXISTS and is still not used: re-running an application
      // error against another machine would be a correctness bug.
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('never re-addresses a call whose outcome is unknown', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      mockServerReads([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation(() => undefined);
      const outcome = callMachineRpc({
        credentials, machineId: 'machine-old', method: 'status', request: { ping: true },
        timeoutMs: 10, signal: controller.signal,
      }).catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const calls = socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10);
        const error = await outcome;
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        expect(readMachineRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(calls[0][1].method).toBe('machine-old:status');
        // Ack expiry and caller cancellation can settle in either order. Any
        // cancellation addresses the original request; neither path replays it.
        for (const [, cancellation] of socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)) {
          expect(cancellation).toEqual({ requestId: calls[0][1].requestId });
        }
        expect(socket.emit.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
        expect(axiosGet).toHaveBeenCalledTimes(1);
      } finally {
        controller.abort();
        await outcome;
        vi.useRealTimers();
      }
    });
  });
});
