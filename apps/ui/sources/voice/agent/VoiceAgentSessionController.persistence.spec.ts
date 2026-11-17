import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/runtime/reactNativeRuntime')).createReactNativeNativeRuntime(
    { platformOS: 'ios' }, { Alert: { alert: (...args: Parameters<typeof nativeAlert>) => nativeAlert(...args) } },
  ));
// Install Metro's lazy-loader bridge before storage can import its consumers.
// The helper returns the actual Sync singleton, without replacing its methods.
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import {
  FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent} from '@happier-dev/protocol/machines/machineStoredContent';
import {
  SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import {
  SessionSpawnNewInputV2Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  type ExecutionRunPublicState,
  ExecutionRunPublicStateSchema} from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
  ExecutionRunEnsureOrStartRequestSchema,
} from '@happier-dev/protocol/execution/runs/index';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AccessibleMachineAccessV1Schema, MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { parseToken } from '@/utils/auth/parseToken';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHydratedPlainMachineFixture, createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createRetainedVoiceAgentActionHttpBoundaries } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { VOICE_TRANSCRIPT_MEMORY_KEY } from '@/voice/persistence/voiceTranscriptMemory';

let homeId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let unsubscribeStorage: (() => void) | undefined;
const publishedSessionIds = new Set<string>();
let sessionMetadataHttp = createSessionMetadataHttpBoundary(() => ({}));
const purposes = createConnectedPurposeCatalogHttpBoundary();
const transcriptMemory = createAccountKvHttpFixture();
let runActionBoundaries: Awaited<ReturnType<typeof createRetainedVoiceAgentActionHttpBoundaries>> = [];

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let daemonStreamSequence = 0;
const daemonStart = vi.fn(async (params?: any) => ({ ok: true, runId: params?.runId ?? 'run_1', created: !params?.runId }));
const daemonTurn = vi.fn(async () => ({ assistantText: 'ok', actions: [] }));
const daemonCommit = vi.fn(async () => ({ commitText: 'commit' }));
const daemonWelcome = vi.fn(async () => ({ assistantText: '' }));
const readSessions = vi.fn(async () => {});
const readMachines = vi.fn(async () => {});
const spawnSession = vi.fn<(opts: unknown) => Promise<{ type: 'success'; sessionId: string }>>(async (_opts: unknown) => ({
  type: 'success' as const,
  sessionId: 'sys_voice_new',
}));
const nativeConfirmationChoices: boolean[] = [];
let nativeConfirmationCount = 0;
// OS presentation is the boundary. The actual Modal owner builds the buttons
// and settles its Promise after the simulated user presses a native control.
const nativeAlert = vi.fn<(title: string, message?: string,
  buttons?: ReadonlyArray<{ style?: string; onPress?: () => void }>, options?: { cancelable?: boolean }) => void>(
  (_title, _message, buttons, options) => {
    if (!buttons?.length) return;
    const isConfirmation = options?.cancelable === false && buttons.length === 2;
    if (isConfirmation) nativeConfirmationCount += 1;
    const button = isConfirmation
      ? buttons[nativeConfirmationChoices.shift() === true ? 1 : 0]
      : buttons.find(candidate => candidate.style === 'cancel') ?? buttons.at(-1);
    queueMicrotask(() => button?.onPress?.());
  },
);

function buildExecutionRunPublicState(
  overrides: Partial<ExecutionRunPublicState> = {},
): ExecutionRunPublicState {
  return ExecutionRunPublicStateSchema.parse({
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    intent: 'voice_agent',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'streaming',
    status: 'running',
    startedAtMs: 1,
    ...overrides,
  });
}



const createVoiceAgentPersistenceTestState = (): any => {
  const sessions = {
    sys_voice: {
      id: 'sys_voice',
      serverId: homeId,
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      },
    },
    s1: {
      id: 's1',
      serverId: homeId,
      updatedAt: 1,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      },
    },
  };

  return {
    settingsVersion: 1,
    settings: settingsParse({
      experiments: true,
      featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: { enabled: false },
            agent: { backend: 'daemon', agentSource: 'agent', agentId: 'claude', transcript: { persistenceMode: 'persistent', epoch: 1 } },
            networkTimeoutMs: 15_000,
          } },
        },
      },
    }),
    sessionListIndexByServerId: {
      [homeId]: [
        { type: 'session', sessionId: 'sys_voice', serverId: homeId, serverName: null },
        { type: 'session', sessionId: 's1', serverId: homeId, serverName: null },
      ],
    },
    sessionListRowsByServerId: {
      [homeId]: {
        sys_voice: sessions.sys_voice,
        s1: sessions.s1,
      },
    },
    ordinarySessionListMembershipByServerId: { [homeId]: ['sys_voice', 's1'] },
    sessions,
    machines: { 'voice-persistence-machine': createMachineFixture({ id: 'voice-persistence-machine', activeAt: Date.now() }) },
    machineListByServerId: { [homeId]: [createMachineFixture({ id: 'voice-persistence-machine', activeAt: Date.now() })] },
    sessionMessages: {},
  };
};

let state: any = createVoiceAgentPersistenceTestState();

function sessionWireRecord(session: ReturnType<typeof createSessionFixture>) {
  return SessionCurrentProjectionRecordV1Schema.parse({
    id: session.id, seq: session.seq ?? 1, createdAt: session.createdAt ?? 1,
    updatedAt: session.updatedAt, active: session.active,
    activeAt: session.presence === 'online' ? Date.now() : session.activeAt ?? 1,
    archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 0,
    metadata: JSON.stringify({ path: '/voice', host: 'voice.test', ...session.metadata }),
    metadataVersion: session.metadataVersion ?? 1,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionFixture().access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null,
    agentState: null, agentStateVersion: session.agentStateVersion ?? 0,
    pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
  });
}

// Only the external Home responses are synthetic; metadata parsing, exact Account
// authority, retries and projection application run through the real Sync owner.
async function respondToServerRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  let boundaries: typeof runActionBoundaries = [];
  if (url.pathname.startsWith('/v1/actions/')) {
    const body = JSON.parse(String(init?.body));
    const signedTarget = new Headers(init?.headers).get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
    const target = signedTarget ? decodeExternalActionResolvedTargetV1(signedTarget) : body.envelope?.target ?? body.target;
    const machineId = body.machineId ?? (target?.kind === 'machine' ? target.machineId : undefined);
    boundaries = runActionBoundaries.filter(boundary => boundary.machine.id === machineId);
  }
  for (const boundary of boundaries) {
    const response = await boundary.handle(new URL(String(input)), init);
    if (response) return response;
  }
  const memoryResponse = await transcriptMemory.handleFetch(input, init);
  if (memoryResponse) return memoryResponse;
  const purposeResponse = await purposes.handle(input, init);
  if (purposeResponse) return purposeResponse;
  const path = new URL(String(input)).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  if (path === '/v1/features' || path === '/v1/features/authenticated') return json(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
  if (path === '/health') return json({});
  if (path === '/v2/cursor') return json({ cursor: 0, changesFloor: 0 });
  if (path === '/v2/changes') return json({ changes: [], nextCursor: 0 });
  if (path === '/v2/session-organization') return json({ snapshot: { schemaVersion: 1, version: 1,
    pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
  } });
  if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
  if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: 'account-a' }));
  if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: state.settings }, version: 1 });
  if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
  if (path === ACP_CATALOG_ROWS_ROUTE_V1) return json({ status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, definitions: [] } } });
  if (path === '/v1/account/authoring-memory') return json({ rows: [] });
  if (path === '/v1/account/project-rows/list') return json({ status: 'listed', rows: [], coverage: 'complete' });
  if (path === '/v1/artifacts') return json([]);
  const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
  if (machineAccess) {
    const id = decodeURIComponent(machineAccess[1]);
    const access = AccessibleMachineAccessV1Schema.parse(createPlainMachineRowFixture({ id, accountId: 'account-a' }).access);
    return json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: id,
      custodian: access.custodian, access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }));
  }
  if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path)) return json({ messages: [], hasMore: false });
  // Named list resources must precede the generic session-by-id route.
  if (path === '/v2/sessions' || path === '/v2/sessions/active') {
    if (spawnSession.mock.calls.length > 0) {
      await readSessions();
      for (const session of Object.values(state.sessions) as Array<ReturnType<typeof createSessionFixture>>) {
        if (!publishedSessionIds.has(session.id)) {
          sessionMetadataHttp.replaceSession(session.id, sessionWireRecord(session));
          publishedSessionIds.add(session.id);
        }
      }
    }
    return sessionMetadataHttp.handle(input, init)!;
  }
  const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
  if (detail) {
    return sessionMetadataHttp.handle(input, init)!;
  }
  const machineDetail = /^\/v1\/machines\/([^/]+)$/.exec(path);
  if (path === '/v1/machines' || path === '/v1/machines/read-batch' || machineDetail) {
    await readMachines();
    const rows = Object.values(state.machines as Record<string, Parameters<typeof createMachineFixture>[0]>).map(value => {
      const machine = createMachineFixture(value);
      const installation = runActionBoundaries.find(boundary => boundary.machine.id === machine.id)?.machine;
      return {
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        ...(installation ? { installationId: installation.installationId, installationPublicKey: installation.installationPublicKey } : {}),
        seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
        active: machine.active, activeAt: machine.activeAt, metadataVersion: machine.metadataVersion,
        daemonStateVersion: machine.daemonStateVersion,
        revokedAt: machine.revokedAt ?? null, replacedByMachineId: machine.replacedByMachineId ?? null,
        metadata: machine.metadata ? encodePlainMachineStoredContent({
          ...createMachineFixture().metadata, ...machine.metadata,
        }) : null,
        daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      };
    });
    if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
      id => rows.find(machine => machine.id === id) ?? null);
    return json(machineDetail ? { machine: rows.find(machine => machine.id === decodeURIComponent(machineDetail[1])) } : rows);
  }
  return createEmptyAccountBootstrapHttpResponse(path, init) ?? new Response('{}', { status: 404 });
}

installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    if (socket.connected) return socket;
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // The real scoped pool may retain this external Socket across Account
  // lifetimes; restoring per-test spies must not restore a live SDK transport.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event === 'rpc-call') {
      const request = payload as { method: string; params: unknown };
      const separator = request.method.indexOf(':');
      const targetId = request.method.slice(0, separator);
      const method = request.method.slice(separator + 1);
      const token = typeof socket.auth === 'object' ? socket.auth.token : null;
      if (typeof token !== 'string') throw new Error('Expected authenticated daemon ACK');
      const scope = { scope: { serverId: homeId, accountId: parseToken(token) } };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { ok: true, result: await daemonRunGet(targetId, request.params, scope) };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { ok: true, result: await daemonRunList(targetId, request.params, scope) };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true, result: await daemonRunStop(targetId, request.params, scope) };
      try {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
          const admission = ExecutionRunEnsureOrStartRequestSchema.parse(request.params);
          // Record the daemon's actual admitted envelope and start fields, not
          // a substituted client call. Session identity comes from Socket routing.
          return { ok: true, result: await daemonStart({ ...admission.start, sessionId: targetId,
            runId: admission.runId, resume: admission.resume }) };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
          return { ok: true, result: { streamId: `turn-${++daemonStreamSequence}` } };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
          const reply = await daemonTurn();
          const input = request.params as { streamId: string };
          return { ok: true, result: { streamId: input.streamId,
            events: [{ t: 'done', ...reply }], nextCursor: 1, done: true } };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return { ok: true, result: { ok: true } };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
          const input = request.params as { actionId: string };
          const result = input.actionId === 'voice_agent.welcome' ? await daemonWelcome() : await daemonCommit();
          return { ok: true, result: { ok: true, result } };
        }
      } catch (error) {
        // Server-side failures cross the genuine boundary as an ACK error,
        // leaving classification and recovery to the actual client/Run owner.
        const failure = error as Error & { rpcErrorCode?: string };
        return { ok: true, result: { ok: false, error: failure.message, errorCode: failure.rpcErrorCode } };
      }
      return { ok: true, result: await dispatchMachineRpc(method, request.params) };
    }
    if (event !== 'update-metadata') throw new Error(`Unexpected socket acknowledgement: ${event}`);
    return { result: 'success', version: payload.expectedVersion + 1, metadata: payload.metadata };
  });
});

// Fake the external daemon ACK, preserving real scoped RPC/Account routing.
async function dispatchMachineRpc(method: string, payload: unknown) {
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
      return createExistingSessionDirectoryPreflightResult(payload);
    }
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
    }
    if (method !== RPC_METHODS.SESSION_SPAWN_NEW) throw new Error(`Unexpected machine RPC: ${method}`);
    const input = SessionSpawnNewInputV2Schema.parse(payload);
    const spawned = await spawnSession({
      ...input,
      machineId: input.executionTarget.machineId,
      directory: input.directory.kind === 'path' ? input.directory.path : input.directory,
    });
    return {
      ...spawned,
      disposition: 'created',
      executionTarget: input.executionTarget,
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' },
    };
}

// Synthetic Run responses are emitted by the external daemon Socket ACK only.
// Account scoping, access admission, response validation and activity publication stay real.
const daemonRunGet = vi.fn(async (..._args: any[]): Promise<any> => ({
  run: buildExecutionRunPublicState({
    transcript: { persistenceMode: 'persistent', epoch: 1 },
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      providerSessionId: 'vs_1',
    },
  }),
}));
const daemonRunList = vi.fn(async (..._args: any[]): Promise<any> => ({
  runs: [],
}));
const daemonRunStop = vi.fn(async (..._args: any[]): Promise<any> => ({
  ok: true,
}));


const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(() => restoreActionExecutorModuleLoader());

async function loadVoiceAgentPersistenceHarness() {
  // Durable Session reads carry no reachability observation. The test Home's
  // live daemon independently publishes activity through the real receiver.
  const onlineSessionIds = new Set(Object.entries(state.sessions)
    .filter(([, session]) => (session as ReturnType<typeof createSessionFixture>).presence === 'online')
    .map(([id]) => id));
  // These client rows are projections of the plain Home census, including its
  // access authority; an ad-hoc id/metadata object is not a spawn target.
  for (const [id, value] of Object.entries(state.machines) as Array<[string, Record<string, unknown>]>) {
    state.machines[id] = createHydratedPlainMachineFixture({ id, accountId: 'account-a', machine: { ...value,
      metadata: value.metadata ? { ...createMachineFixture().metadata!, ...value.metadata as Record<string, unknown> } : null,
    } });
  }
  for (const [serverId, rows] of Object.entries(state.machineListByServerId) as Array<[string, Array<{ id: string }>]>) {
    state.machineListByServerId[serverId] = rows.map(row => state.machines[row.id] ?? row);
  }
  const fixtureHomeId = homeId;
  const fixtureStickyMachineId = useVoiceTargetStore.getState().autoTargetMachineByScope[
    accountSettingsScopeKeySuffix({ serverId: fixtureHomeId, accountId: 'account-a' })];
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://voice-persistence.example.test',
    serverIdentityId: 'srv_voice-persistence-home',
    credentialScope: 'restored-home',
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    request: createSessionReadBatchFetchBoundary(respondToServerRequest),
  });
  homeId = connection.serverId;
  if (fixtureStickyMachineId) useVoiceTargetStore.getState().rememberAutoTargetMachine(
    { serverId: homeId, accountId: 'account-a' }, fixtureStickyMachineId);
  if (fixtureHomeId !== homeId) {
    for (const field of ['machineListByServerId', 'sessionListRowsByServerId',
      'ordinarySessionListMembershipByServerId', 'sessionListIndexByServerId'] as const) {
      if (state[field]?.[fixtureHomeId]) {
        state[field][homeId] = state[field][fixtureHomeId];
        delete state[field][fixtureHomeId];
      }
    }
    state.sessionListIndexByServerId[homeId] = state.sessionListIndexByServerId[homeId]?.map(
      (row: { type: string }) => row.type === 'session' ? { ...row, serverId: homeId } : row);
  }
  const normalize = (id: string, session: Parameters<typeof createSessionFixture>[0]) =>
    createSessionFixture({ ...session, id, serverId: homeId,
      metadata: { path: '/voice', host: 'voice.test',
        machineId: 'voice-persistence-machine',
        ...(session?.metadata?.flavor === 'claude' ? { agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } : {}),
        ...session?.metadata },
    });
  for (const [id, value] of Object.entries(state.sessions)) {
    state.sessions[id] = normalize(id, value as Parameters<typeof createSessionFixture>[0]);
  }
  for (const [id, value] of Object.entries(state.sessionListRowsByServerId?.[homeId] ?? {})) {
    state.sessionListRowsByServerId[homeId][id] = normalize(id, value as Parameters<typeof createSessionFixture>[0]);
  }
  // The synthetic Home retains full wire records, never reserializes reduced UI list projections.
  for (const [id, session] of Object.entries(state.sessions)) {
    sessionMetadataHttp.replaceSession(id, sessionWireRecord(state.sessionListRowsByServerId?.[homeId]?.[id] ?? session));
    publishedSessionIds.add(id);
  }
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(homeId);
  try {
    const serverIdentityId = account.serverIdentityId;
    if (!serverIdentityId) throw new Error('Expected Voice persistence Home identity');
    runActionBoundaries = (await Promise.all(Object.keys(state.machines).map(async machineId => [
      ...await createRetainedVoiceAgentActionHttpBoundaries({ serverUrl: account.endpointUrl,
        serverIdentityId, accountId: account.accountId, machineId,
        dispatch: async (method, input, context) => {
          if (method !== SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START) throw new Error(`Unexpected admitted Voice method: ${method}`);
          const admission = ExecutionRunEnsureOrStartRequestSchema.parse(input);
          try {
            return await daemonStart({ ...admission.start, sessionId: context.sessionId,
              runId: admission.runId, resume: admission.resume });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { ok: false, error: error.message,
              errorCode: 'rpcErrorCode' in error ? error.rpcErrorCode : 'action_failed',
              details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
          }
        },
      }),
      await createExternalActionAccountHttpBoundary({ serverUrl: account.endpointUrl,
        serverIdentityId, accountId: account.accountId, machineId, actionId: 'session.spawn_new',
        tokenEpoch: 0, requesterInvocation: 'optional', execute: async input => projectSessionSpawnNewActionResultV1(
          SessionSpawnNewResultV1Schema.parse(await dispatchMachineRpc(RPC_METHODS.SESSION_SPAWN_NEW, input))) }),
    ]))).flat();
  } finally { account.dispose(); }
  storage.setState({ ...state, profileScope: { serverId: homeId, accountId: 'account-a' },
    settingsScope: { serverId: homeId, accountId: 'account-a' } });
  await publishMachineInventoryForTest({ serverId: homeId, accountId: 'account-a' }, Object.values(storage.getState().machines));
  state = storage.getState();
  const { flushActivityUpdates } = await import('@/sync/engine/socket/socket');
  unsubscribeStorage = storage.subscribe((current) => {
    state = current;
    const updates = new Map([...onlineSessionIds].flatMap(id => {
      const session = current.sessions[id];
      const renderable = current.sessionListRowsByServerId[homeId]?.[id];
      const observedAt = Math.max(Date.now(), (session?.activeAt ?? 0) + 1, (renderable?.activeAt ?? 0) + 1);
      return session?.active === true && (session.presence !== 'online' || renderable?.presence !== 'online')
        ? [[id, { type: 'activity' as const, id, active: true, activeAt: observedAt, thinking: false }] as const]
        : [];
    }));
    if (updates.size) flushActivityUpdates({ updates, applySessions: current.applySessions, sourceServerId: homeId });
  });
  const [{ VOICE_AGENT_GLOBAL_SESSION_ID }, { createVoiceExecutionTransport }, { voiceSessionBindingStore }] = await Promise.all([
    import('@/voice/agent/voiceAgentGlobalSessionId'),
    import('@/voice/runtime/execution/VoiceExecutionTransport'),
    import('@/voice/binding/voiceConversationBindingStore'),
  ]);

  useVoiceTargetStore.setState({
    scope: 'global',
    primaryActionSessionAddress: { serverId: homeId, sessionId: 's1' },
    voiceLiveContextSessionAddresses: [],
    lastFocusedSessionAddress: null,
  } as any);

  return {
    VOICE_AGENT_GLOBAL_SESSION_ID,
    createVoiceExecutionTransport,
    voiceSessionBindingStore,
  };
}

describe('VoiceExecutionTransport (persistence)', () => {
  afterEach(async () => {
    unsubscribeStorage?.();
    await connection?.dispose();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    transcriptMemory.reset();
    await transcriptMemory.handleFetch('https://voice-persistence.example.test/v1/kv', { method: 'POST',
      body: JSON.stringify({ mutations: [{ key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 1 } }),
      }] }),
    });
    vi.useRealTimers();
    await loadSyncSingletonForTests();
    publishedSessionIds.clear();
    sessionMetadataHttp = createSessionMetadataHttpBoundary(() => ({}));
    runActionBoundaries = [];
    daemonStreamSequence = 0;
    daemonStart.mockReset();
    daemonStart.mockImplementation(async (params?: any) => ({ ok: true, runId: params?.runId ?? 'run_1', created: !params?.runId }));
    daemonTurn.mockReset();
    daemonTurn.mockImplementation(async () => ({ assistantText: 'ok', actions: [] }));
    daemonCommit.mockReset();
    daemonCommit.mockImplementation(async () => ({ commitText: 'commit' }));
    daemonWelcome.mockReset();
    daemonWelcome.mockImplementation(async () => ({ assistantText: '' }));
    daemonRunGet.mockClear();
    daemonRunList.mockClear();
    daemonRunStop.mockClear();
    readSessions.mockReset();
    readMachines.mockReset();
    spawnSession.mockReset();
    spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'sys_voice_new' }));
    nativeAlert.mockClear();
    nativeConfirmationChoices.length = 0;
    nativeConfirmationCount = 0;

    homeId = (await upsertAndActivateServer({ serverUrl: 'https://voice-persistence.example.test', name: 'Test Home' })).id;
    state = createVoiceAgentPersistenceTestState();
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'replay';
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null };
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.setState({
      runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {}, bindingsByConversationSessionId: {},
    });
  });

  it('persists runId and resumeHandle into carrier session metadata when transcript persistence is enabled', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }), { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toBeUndefined();
  });

  it('prefers an active hidden voice conversation session over a newer inactive one for the global daemon anchor', async () => {
    state.sessions.sys_voice.updatedAt = 20;
    state.sessions.sys_voice.active = false;
    state.sessions.sys_voice.presence = 'offline';
    state.sessions.active_voice = {
      id: 'active_voice',
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'active_voice' }));
    expect(daemonStart).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('fails fast with a clear error when daemon voice agent runtime support is disabled', async () => {
    state.settings.featureToggles['voice.agent'] = false;

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).rejects.toMatchObject({
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
      cause: expect.objectContaining({
        code: 'VOICE_AGENT_RUNTIME_UNAVAILABLE',
        featureDecision: expect.objectContaining({
          featureId: 'voice.agent',
          blockedBy: 'local_policy',
          blockerCode: 'flag_disabled',
        }),
      }),
    });

    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('persists run metadata even when transcript persistence is ephemeral so active runs can be reattached after reload', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }), { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });
  });

  it('does not migrate or stop a legacy global daemon run during startup when persisted metadata predates the hidden transcript contract', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_legacy',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_legacy' },
      updatedAtMs: 1,
    };
    daemonRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_legacy',
          startedAtMs: 1,
        }),
      ],
    });
    const retainedRun = buildExecutionRunPublicState({
      runId: 'run_legacy',
      transcript: { persistenceMode: 'ephemeral', epoch: 1 },
      voicePolicy: { assistantLanguage: 'fr-FR', welcome: { enabled: false, mode: 'immediate' } },
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        providerSessionId: 'vs_legacy',
      },
    });
    // Both reconciliation and the post-start read address the same retained Run.
    daemonRunGet
      .mockResolvedValueOnce({ run: retainedRun })
      .mockResolvedValueOnce({ run: retainedRun });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonRunStop).not.toHaveBeenCalled();
    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: 'run_legacy',
      }),
    );
  });
  it('persists session-scoped daemon run metadata so the run can be reattached after controller recreation', async () => {
    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await firstController.sendTurn('s1', 'hello');

    expect(state.sessions.s1.presence).toBe('online');
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });

    daemonStart.mockClear();
    daemonTurn.mockClear();
    daemonRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_1',
          startedAtMs: 10,
        }),
      ],
    });
    daemonRunGet.mockResolvedValueOnce({
      run: buildExecutionRunPublicState({
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'vs_1',
        },
      }),
    });

    const secondController = createVoiceExecutionTransport();
    // Real tuple migration leaves execution facts in the hydrated owner view,
    // not in the reduced list row used for presence and presentation.
    expect(state.sessions.s1.metadataLayoutVersion).toBe(1);
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.flavor).toBe('claude');
    await secondController.sendTurn('s1', 'hello again');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        runId: 'run_1',
      }),
    );
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });
  });

  it('stops and clears a persisted session-scoped daemon run even after controller recreation', async () => {
    state.sessions.s1.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.stop('s1');

    expect(daemonRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toBeUndefined();
  });

  it('stops all matching persisted daemon voice runs for a session so stale running runs are not reattached on restart', async () => {
    state.sessions.s1.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };
    daemonRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_prev',
          startedAtMs: 20,
        }),
        buildExecutionRunPublicState({
          runId: 'run_stale',
          startedAtMs: 10,
        }),
        buildExecutionRunPublicState({
          runId: 'run_other_backend',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          startedAtMs: 30,
        }),
      ],
    });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.stop('s1');

    expect(daemonRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(daemonRunStop).toHaveBeenCalledWith('s1', { runId: 'run_stale' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(daemonRunStop).not.toHaveBeenCalledWith('s1', { runId: 'run_other_backend' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toBeUndefined();
  });

  it('reconciles duplicate running session-scoped voice runs by reattaching the newest match and stopping the extras', async () => {
    daemonRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_old',
          callId: 'call_old',
          sidechainId: 'side_old',
          retentionPolicy: 'ephemeral',
          startedAtMs: 10,
        }),
        buildExecutionRunPublicState({
          runId: 'run_new',
          callId: 'call_new',
          sidechainId: 'side_new',
          retentionPolicy: 'ephemeral',
          startedAtMs: 20,
        }),
      ],
    });
    daemonRunGet
      .mockResolvedValueOnce({
        run: buildExecutionRunPublicState({
          runId: 'run_new',
          resumeHandle: {
            kind: 'provider_session.v1',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            providerSessionId: 'vs_new',
          },
        }),
      })
      .mockResolvedValueOnce({
        run: buildExecutionRunPublicState({
          runId: 'run_new',
          resumeHandle: {
            kind: 'provider_session.v1',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            providerSessionId: 'vs_new',
          },
        }),
      });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn('s1', 'hello');

    expect(daemonRunList).toHaveBeenCalledWith('s1', {}, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(daemonRunStop).toHaveBeenCalledWith('s1', { runId: 'run_old' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        runId: 'run_new',
      }),
    );
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_new',
      resumeHandle: expect.objectContaining({ providerSessionId: 'vs_new' }),
    });
  });

  it('reuses persisted runId for ephemeral global voice sessions after controller recreation', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await firstController.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
    });

    daemonStart.mockClear();
    daemonTurn.mockClear();

    const secondController = createVoiceExecutionTransport();
    await secondController.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello again');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: 'run_1',
      }),
    );
  });

  it('uses the hidden voice conversation session as the only global daemon RPC anchor', async () => {
    state.sessions.s2 = { id: 's2', updatedAt: 2, modelMode: 'default', metadata: { flavor: 'claude' } };

    daemonStart
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ ok: true, runId: 'run_2', created: true });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'ok',
    });

    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(daemonStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
      }),
    );
    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
      }),
    );
  });

  it('retries session-scoped daemon start when the first attempt returns RPC method not available', async () => {
    daemonStart
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ ok: true, runId: 'run_2', created: true });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({
      assistantText: 'ok',
    });

    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(daemonStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 's1',
      }),
    );
    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 's1',
      }),
    );
  });

  it('starts a fresh run when an ephemeral persisted runId can no longer be reattached', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    daemonStart.mockRejectedValueOnce(Object.assign(new Error('Not running'), { rpcErrorCode: 'execution_run_not_allowed' }));
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_2', created: true });
    daemonRunGet
      .mockResolvedValueOnce({
        run: buildExecutionRunPublicState({
          runId: 'run_prev',
          transcript: { persistenceMode: 'persistent', epoch: 1 },
          resumeHandle: {
            kind: 'provider_session.v1',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            providerSessionId: 'vs_prev',
          },
        }),
      })
      .mockResolvedValueOnce({
        run: buildExecutionRunPublicState({
          runId: 'run_2',
          transcript: { persistenceMode: 'persistent', epoch: 1 },
          resumeHandle: {
            kind: 'provider_session.v1',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            providerSessionId: 'vs_2',
          },
        }),
      });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: 'run_prev',
      }),
    );
    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: undefined,
      }),
    );
  });

  it('starts a fresh run when replay mode cannot reattach to an inactive run', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_2', created: true });
    daemonRunGet.mockResolvedValueOnce({
      run: buildExecutionRunPublicState({
        runId: 'run_2',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'vs_2',
        },
      }),
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: undefined,
        resume: undefined,
      }),
    );
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_2',
    });
  });

  it('provider-resume mode starts a new run with resumeHandle when the previous runId is not found', async () => {
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    daemonStart.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_3', created: true });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: undefined,
        resume: undefined,
        resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_prev' }),
      }),
    );
  });

  it('forwards the remote-dev dual Voice resume handle only after canonical Provider-field normalization', async () => {
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_predecessor',
      backendId: 'claude',
      resumeHandle: {
        kind: 'voice_agent_sessions.v1',
        backendId: 'claude',
        chatVendorSessionId: 'chat-predecessor',
        commitVendorSessionId: 'commit-predecessor',
      },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    daemonStart.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_fresh', created: true });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();
    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: undefined,
        resume: undefined,
        resumeHandle: {
          kind: 'voice_agent_sessions.v1',
          backendId: 'claude',
          backendTarget: {
            kind: 'backend',
            backendId: 'claude',
            sourceKind: 'built_in',
          },
          chatProviderSessionId: 'chat-predecessor',
          commitProviderSessionId: 'commit-predecessor',
        },
      }),
    );
  });

  it('fails closed to a fresh start when provider-resume is configured but runtime publication does not expose transcriptSource', async () => {
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'provider_resume';
    delete state.sessions.sys_voice.metadata.agentRuntimeFacetsV1;
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sys_voice', runId: undefined, resume: undefined }),
    );
    expect(daemonStart.mock.calls[0]?.[0]).not.toHaveProperty('resumeHandle');
  });

  it('retries when daemon sendTurn fails with the plain Voice agent not found message', async () => {
    daemonTurn
      .mockRejectedValueOnce(new Error('Voice agent not found'))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(daemonTurn).toHaveBeenCalledTimes(2);
  });

  it('clears a stale cached handle when immediate welcome fails with the plain Voice agent not found message', async () => {
    state.settings.voice.welcome = {
      enabled: true,
      mode: 'immediate',
      templateId: null,
    };
    daemonWelcome.mockRejectedValueOnce(new Error('Voice agent not found'));
    daemonTurn.mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();
    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(daemonWelcome).toHaveBeenCalledTimes(1);
    expect(daemonTurn).toHaveBeenCalledTimes(1);
  });

  it('persists welcomedEpoch after an immediate welcome and suppresses duplicate welcome after controller recreation', async () => {
    state.settings.voice.welcome = {
      enabled: true,
      mode: 'immediate',
      templateId: null,
    };
    daemonWelcome.mockResolvedValue({ assistantText: 'Welcome!' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await expect(firstController.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBe('Welcome!');

    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      transcriptContractVersion: 2,
      welcomedEpoch: 1,
    });
    expect(daemonWelcome).toHaveBeenCalledTimes(1);

    const secondController = createVoiceExecutionTransport();
    await expect(secondController.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();

    expect(daemonWelcome).toHaveBeenCalledTimes(1);
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      transcriptContractVersion: 2,
      welcomedEpoch: 1,
    });
  });

  it('treats the hidden global voice conversation session as resumable and retries it with resumeHandle when the persisted run is not resumable anymore', async () => {
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    daemonStart.mockRejectedValueOnce(Object.assign(new Error('Not resumable'), { rpcErrorCode: 'execution_run_not_allowed' }));
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_4', created: true });
    daemonRunGet.mockResolvedValueOnce({
      run: buildExecutionRunPublicState({
        runId: 'run_4',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'vs_4',
        },
      }),
    });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.ensureRunning('sys_voice');

    expect(daemonStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: 'run_prev',
        resume: true,
      }),
    );
    expect(daemonStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: undefined,
        resume: undefined,
        resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_prev' }),
      }),
    );
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_4',
      resumeHandle: expect.objectContaining({ providerSessionId: 'vs_4' }),
    });
  });

  it('persists an updated resumeHandle into carrier metadata after commit (e.g. commit session ids)', async () => {
    daemonRunGet.mockImplementation(async () => ({
      run: daemonCommit.mock.calls.length === 0
        ? buildExecutionRunPublicState({
            resumeHandle: {
              kind: 'provider_session.v1',
              backendTarget: { kind: 'backend', backendId: 'claude' },
              providerSessionId: 'vs_1',
            },
          })
        : buildExecutionRunPublicState({
            resumeHandle: {
              kind: 'voice_agent_sessions.v1',
              backendTarget: { kind: 'backend', backendId: 'claude' },
              chatProviderSessionId: 'vs_1',
              commitProviderSessionId: 'vs_commit',
            },
          }),
    }));

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)).toMatchObject({
      voiceAgentRunV1: { resumeHandle: { kind: 'provider_session.v1' } },
    });

    await controller.commit(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(daemonCommit).toHaveBeenCalledTimes(1);
    expect(daemonRunGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({
        kind: 'voice_agent_sessions.v1',
        commitProviderSessionId: 'vs_commit',
      }),
    });
  });

  it('drops a stale cached handle and retries when daemon send returns RPC method not available', async () => {
    daemonStart
      .mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true })
      .mockResolvedValueOnce({ ok: true, runId: 'run_2', created: true });
    daemonTurn
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
    });

    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(daemonTurn).toHaveBeenCalledTimes(2);
  });

  it('clears stale persisted daemon run metadata before retrying after RPC method not available', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_stale',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_stale' },
      updatedAtMs: 1,
    };
    daemonStart.mockImplementation(async (params?: any) => ({ ok: true, runId: params?.runId ?? 'run_fresh', created: !params?.runId }));
    daemonTurn
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });
    daemonRunGet.mockImplementation(async (_sessionId: string, params: { runId: string }) => ({
      run: buildExecutionRunPublicState({
        runId: params.runId,
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: `vs_${params.runId}`,
        },
      }),
    }));

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
    });

    expect(daemonStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ runId: undefined }));
    expect(daemonStart).toHaveBeenNthCalledWith(2, expect.objectContaining({ runId: undefined }));
    expect(daemonStart.mock.calls[1]?.[0]).not.toHaveProperty('resumeHandle');
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_fresh',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ providerSessionId: 'vs_run_fresh' }),
    });
  });

  it('fails fast when a global hidden voice binding points at an inactive target session', async () => {
    state.sessions.s_inactive = {
      id: 's_inactive',
      updatedAt: 1,
      active: false,
      modelMode: 'default',
      metadata: { flavor: 'claude' },
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: homeId, sessionId: 's_inactive' },
      updatedAt: 1,
    });
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      message: 'Target session is inactive. Resume it before starting local voice.',
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
    });

    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('fails fast when a global hidden voice binding points at an offline target session', async () => {
    state.sessions.s_offline = {
      id: 's_offline',
      updatedAt: 1,
      active: true,
      presence: 'offline',
      modelMode: 'default',
      metadata: { flavor: 'claude' },
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: homeId, sessionId: 's_offline' },
      updatedAt: 1,
    });
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      message: 'Target session is offline. Reconnect it before starting local voice.',
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
    });

    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('fails fast when a global hidden voice binding points at a target whose machine daemon is offline', async () => {
    state.sessions.s_machine_offline = {
      id: 's_machine_offline',
      updatedAt: 1,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'claude', machineId: 'm1' },
    };
    state.machines.m1 = {
      id: 'm1',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      active: false,
      activeAt: 0,
      revokedAt: null,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    state.machineListByServerId = { [homeId]: [state.machines.m1] };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: homeId, sessionId: 's_machine_offline' },
      updatedAt: 1,
    });
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
      cause: expect.objectContaining({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' }),
    });

    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('admits an independent global Voice run when the bound target lacks terminal control support', async () => {
    state.sessions.s_kimi = {
      id: 's_kimi',
      updatedAt: 1,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'kimi' },
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: homeId, sessionId: 's_kimi' },
      updatedAt: 1,
    });
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toEqual({
      assistantText: 'ok', actions: [],
    });
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('prefers visible lookup target session metadata when raw target metadata is stale', async () => {
    state.sessions.s_cached_target = {
      id: 's_cached_target',
      updatedAt: 1,
      active: false,
      // Presence is one device observation; only durable metadata/lifecycle is stale here.
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'kimi',
        machineId: 'm_raw',
      },
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      [homeId]: [
        ...(state.sessionListIndexByServerId?.[homeId] ?? []),
        { type: 'session', sessionId: 's_cached_target', serverId: homeId, serverName: null },
      ],
    };
    state.sessionListRowsByServerId = {
      ...(state.sessionListRowsByServerId ?? {}),
      [homeId]: {
        ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
        s_cached_target: {
          id: 's_cached_target',
          updatedAt: 1,
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            machineId: 'm_live',
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      [homeId]: [...(state.ordinarySessionListMembershipByServerId?.[homeId] ?? []), 's_cached_target'],
    };
    state.machines.m_live = {
      id: 'm_live',
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      active: true,
      activeAt: 0,
      revokedAt: null,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: homeId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: homeId, sessionId: 's_cached_target' },
      updatedAt: 1,
    });
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'ok',
    });

    expect(daemonStart).toHaveBeenCalled();
  });

  it('switches away from a sticky global voice machine before starting when its daemon is unavailable', async () => {
    const nextSysVoice = {
      id: 'sys_voice',
      serverId: homeId,
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        machineId: 'm_old',
        path: '/old/.happier/voice-agent',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      },
    };
    state = {
      ...state,
      sessions: {
        ...state.sessions,
        sys_voice: nextSysVoice,
      },
      sessionListRowsByServerId: {
        ...(state.sessionListRowsByServerId ?? {}),
        [homeId]: {
          ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
          sys_voice: nextSysVoice,
        },
      },
    };
    state.sessionMessages.sys_voice = {
      isLoaded: true,
      messages: [
        {
          id: 'm-user-1',
          text: 'Previous user request',
          createdAt: 1,
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 1, role: 'user', voiceAgentId: 'run_old', ts: 1 } } },
        },
        {
          id: 'm-assistant-1',
          text: 'Previous assistant reply',
          createdAt: 2,
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 1, role: 'assistant', voiceAgentId: 'run_old', ts: 2 } } },
        },
      ],
    };
    state.machines = {
      m_old: {
        id: 'm_old',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 1,
        revokedAt: null,
        metadata: { host: 'old-box', happyHomeDir: '/old/.happier', homeDir: '/Users/old' },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      },
      m_new: {
        id: 'm_new',
        seq: 2,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: Date.now(),
        revokedAt: null,
        metadata: { host: 'new-box', happyHomeDir: '/new/.happier', homeDir: '/Users/new' },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      },
    };
    state.machineListByServerId = {
      [homeId]: Object.values(state.machines),
    };
    state.settings.recentMachinePaths = [];
    useVoiceTargetStore.getState().rememberAutoTargetMachine({ serverId: homeId, accountId: 'account-a' }, 'm_old');
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'run_new', created: true });
    nativeConfirmationChoices.push(true, true);
    readSessions.mockImplementation(async () => {
      const sysVoiceNew = {
        id: 'sys_voice_new',
        serverId: homeId,
        updatedAt: 11,
        active: true,
        presence: 'online',
        modelMode: 'default',
        metadata: {
          flavor: 'claude',
          machineId: 'm_new',
          path: '/new/.happier/voice-agent',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          sys_voice_new: sysVoiceNew,
        },
        sessionListIndexByServerId: {
          ...(state.sessionListIndexByServerId ?? {}),
          [homeId]: [
            ...(state.sessionListIndexByServerId?.[homeId] ?? []),
            { type: 'session', sessionId: 'sys_voice_new', serverId: homeId, serverName: null },
          ],
        },
        sessionListRowsByServerId: {
          ...(state.sessionListRowsByServerId ?? {}),
          [homeId]: {
            ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
            sys_voice_new: sysVoiceNew,
          },
        },
        ordinarySessionListMembershipByServerId: {
          ...(state.ordinarySessionListMembershipByServerId ?? {}),
          [homeId]: [...(state.ordinarySessionListMembershipByServerId?.[homeId] ?? []), 'sys_voice_new'],
        },
      };
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello after switch');

    expect(nativeConfirmationCount).toBe(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: { kind: 'managed' },
    }));
    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice_new',
      replay: expect.objectContaining({
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
      }),
    }));
    expect(useVoiceTargetStore.getState().autoTargetMachineByScope[accountSettingsScopeKeySuffix(state.settingsScope)]).toBe('m_new');
  });

  it('refreshes machines before prompting to switch away from a stale sticky global voice machine', async () => {
    const nextSysVoice = {
      id: 'sys_voice',
      serverId: homeId,
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        machineId: 'm_old',
        path: '/old/.happier/voice-agent',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      },
    };
    state = {
      ...state,
      sessions: {
        ...state.sessions,
        sys_voice: nextSysVoice,
      },
      sessionListRowsByServerId: {
        ...(state.sessionListRowsByServerId ?? {}),
        [homeId]: {
          ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
          sys_voice: nextSysVoice,
        },
      },
    };
    state.sessionMessages.sys_voice = {
      isLoaded: true,
      messages: [
        {
          id: 'm-assistant-1',
          text: 'Previous assistant reply',
          createdAt: 2,
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 1, role: 'assistant', voiceAgentId: 'run_old', ts: 2 } } },
        },
      ],
    };
    state.machines = {
      m_old: {
        id: 'm_old',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: Date.now(),
        revokedAt: null,
        metadata: { host: 'old-box', happyHomeDir: '/old/.happier', homeDir: '/Users/old' },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      },
      m_new: {
        id: 'm_new',
        seq: 2,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: Date.now() - 120_000,
        revokedAt: null,
        metadata: { host: 'new-box', happyHomeDir: '/new/.happier', homeDir: '/Users/new' },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
      },
    };
    state.machineListByServerId = {
      [homeId]: [state.machines.m_old],
      'active-server': [state.machines.m_old],
    };
    useVoiceTargetStore.getState().rememberAutoTargetMachine({ serverId: homeId, accountId: 'account-a' }, 'm_old');
    daemonStart
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ ok: true, runId: 'run_new', created: true });
    nativeConfirmationChoices.push(true, true);
    readMachines.mockImplementation(async () => {
      const nextMachines = {
        ...(state.machines ?? {}),
        m_new: {
          id: 'm_new',
          seq: 2,
          createdAt: 0,
          updatedAt: 0,
          active: true,
          activeAt: Date.now(),
          revokedAt: null,
          metadata: { host: 'new-box', happyHomeDir: '/new/.happier', homeDir: '/Users/new' },
          metadataVersion: 0,
          daemonState: null,
          daemonStateVersion: 0,
        },
      };
      state = {
        ...state,
        machines: nextMachines,
        machineListByServerId: {
          ...(state.machineListByServerId ?? {}),
          [homeId]: [nextMachines.m_old, nextMachines.m_new],
          'active-server': [nextMachines.m_old, nextMachines.m_new],
        },
      };
    });
    readSessions.mockImplementation(async () => {
      const sysVoiceNew = {
        id: 'sys_voice_new',
        serverId: homeId,
        updatedAt: 11,
        active: true,
        presence: 'online',
        modelMode: 'default',
        metadata: {
          flavor: 'claude',
          machineId: 'm_new',
          path: '/new/.happier/voice-agent',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          sys_voice_new: sysVoiceNew,
        },
        sessionListIndexByServerId: {
          ...(state.sessionListIndexByServerId ?? {}),
          [homeId]: [
            ...(state.sessionListIndexByServerId?.[homeId] ?? []),
            { type: 'session', sessionId: 'sys_voice_new', serverId: homeId, serverName: null },
          ],
        },
        sessionListRowsByServerId: {
          ...(state.sessionListRowsByServerId ?? {}),
          [homeId]: {
            ...(state.sessionListRowsByServerId?.[homeId] ?? {}),
            sys_voice_new: sysVoiceNew,
          },
        },
        ordinarySessionListMembershipByServerId: {
          ...(state.ordinarySessionListMembershipByServerId ?? {}),
          [homeId]: [...(state.ordinarySessionListMembershipByServerId?.[homeId] ?? []), 'sys_voice_new'],
        },
      };
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello after refresh');

    expect(readMachines).toHaveBeenCalled();
    expect(nativeConfirmationCount).toBe(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: { kind: 'managed' },
    }));
    expect(useVoiceTargetStore.getState().autoTargetMachineByScope[accountSettingsScopeKeySuffix(state.settingsScope)]).toBe('m_new');
  });

});

describe('retained global Voice Run authority', () => {
  it('reattaches the retained global Run without stopping it and reads its policy through real RPC', async () => {
    let harness: Awaited<ReturnType<typeof import('@/dev/testkit/harness/standaloneVoicePolicyHarness')['createStandaloneVoicePolicyHarness']>> | undefined;
    try {
      const [{ ExecutionRunPublicStateSchema}, { buildVoiceAgentRunMetadataV1, parseVoiceAgentRunMetadataV1}] = await Promise.all([import('@happier-dev/protocol/execution/runs/responseSchemas'), import('@happier-dev/protocol/voice/voiceAgentRunMetadataV1')]);
      const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
      const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
      const { createStandaloneVoicePolicyHarness } = await import('@/dev/testkit/harness/standaloneVoicePolicyHarness');
      const retainedPolicy = { assistantLanguage: 'de-DE', welcome: { enabled: true, mode: 'on_first_turn' as const } };
      const retainedRun = ExecutionRunPublicStateSchema.parse(buildExecutionRunPublicState({ runId: 'run_legacy',
        transcript: { persistenceMode: 'persistent', epoch: 1 }, voicePolicy: retainedPolicy,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, providerSessionId: 'vs_legacy' },
      }));
      const metadata = parseVoiceAgentRunMetadataV1(buildVoiceAgentRunMetadataV1({ runId: 'run_legacy',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resumeHandle: retainedRun.resumeHandle ?? null, updatedAtMs: 1 }));
      if (!metadata) throw new Error('Canonical retained Run metadata was rejected');
      const dispatch = vi.fn(async (method: string, _input: unknown): Promise<unknown> => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [retainedRun] };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: retainedRun };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START) return { ok: true, runId: retainedRun.runId, created: false };
        throw new Error(`Unexpected retained Run RPC: ${method}`);
      });
      harness = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch, initializeSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        machines: [createHydratedPlainMachineFixture({ id: 'voice-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })],
        settings: { voice: { providers: { local_conversation: { schemaVersion: 1, config: { agent: { rootSessionPolicy: 'continue' } } } } } },
        handleRequest: async (path, init) => path === '/v1/machines'
          ? Response.json([createPlainMachineRowFixture({ id: 'voice-machine', accountId: 'account-a' })])
          : createPlainMachineReadHttpResponseFixture(path, init, 'account-a') ?? createEmptyAccountBootstrapHttpResponse(path, init),
        existingSession: { id: 'sys_voice', active: true, metadata: { path: '/voice', host: 'voice.test', flavor: 'claude', machineId: 'voice-machine',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, voiceAgentRunV1: metadata,
          voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
          agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
          agentRuntimeFacetsV1: { v: 1, transcriptSource: { supported: true, followLeaseSupported: true } },
        } },
      });
      expect(harness.handle.voiceAgentId).toBe('run_legacy');
      expect(harness.handle.voicePolicy).toEqual(retainedPolicy);
      const admitted = dispatch.mock.calls.findIndex(([method]) => method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START);
      expect(dispatch.mock.calls[admitted]?.[1]).toMatchObject({ runId: 'run_legacy' });
      expect(dispatch.mock.calls.slice(0, admitted).some(([method]) => method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toBe(true);
      expect(dispatch.mock.calls.slice(admitted + 1).some(([method]) => method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toBe(true);
      expect(dispatch.mock.calls.some(([method]) => method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toBe(false);
    } finally {
      await harness?.dispose();
    }
  });
});
