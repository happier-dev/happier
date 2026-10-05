import 'fake-indexeddb/auto';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { MACHINE_PLAIN_DATA_KEY_MARKER, SessionSpawnNewInputV2Schema, createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1, type AccountEncryptionCurrentnessResponse, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';

/** No Saved Secret is bound in these daemon-availability cases, so every ref resolves as deleted. */
const resolveSavedSecretReference = (ref: string): SavedSecretReferenceResolution => ({
  ref,
  kind: 'personal',
  status: 'deleted',
  entry: null,
  secret: null,
  revision: null,
  fingerprint: null,
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const socketRpcBoundary = vi.hoisted(() => ({
  respond: null as ((method: string, input: unknown) => Promise<unknown>) | null,
}));
vi.mock('socket.io-client', () => ({ io: () => {
  const boundary = createSocketIoBoundaryStub();
  boundary.socket.emitWithAck.mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') throw new Error('Invalid test RPC payload');
    if (!socketRpcBoundary.respond) throw new Error('Test RPC boundary is not prepared');
    return { ok: true, result: await socketRpcBoundary.respond(payload.method.slice(payload.method.indexOf(':') + 1), 'params' in payload ? payload.params : undefined) };
  });
  return boundary.socket;
} }));

const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));

function spawnSuccess(sessionId: string): Extract<SessionSpawnNewResultV1, { type: 'success' }> {
  return {
    type: 'success',
    disposition: 'created',
    sessionId,
    executionTarget: { serverId: 'server-a', machineId: 'm1' },
    organizationPlacement: { folderId: null, tagIds: [] },
    initialInput: { status: 'accepted', localId: `input-${sessionId}` },
  };
}

async function createHarness() {
  const plainCurrentness = createPlainAccountEncryptionCurrentnessFixture();
  const todoKv = {
    currentness: plainCurrentness as AccountEncryptionCurrentnessResponse,
    items: new Map<string, { key: string; value: string; version: number }>(),
    failWrite: false,
    conflictOnce: false,
    writes: [] as Array<{ key: string; value: string | null; version: number }>,
  };
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const sessionSpawnNewActionBoundarySpy = vi.fn(async (_input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'error',
      code: 'machine_offline',
      retryable: true,
  }));
  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
          if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
          if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
          if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
          return key;
        },
      }),
    modal: async () => ({
      Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) },
    }),
  });
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  await selectNewSessionTestHome();
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
  vi.spyOn(storage.getState(), 'upsertPendingMessage');
  vi.spyOn(storage.getState(), 'markSessionOptimisticThinking');




  // Keep Action dispatch and local launch custody real; replace only daemon transport.
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  const respondMachineRpc = async (method: string, input: unknown) => {
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
      } } };
    }
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
      return { protocolVersion: 1, ok: true, result: { source: 'static', configOptions: [
        { id: 'codexBackendMode', name: 'Runtime', type: 'select', options: [{ name: 'App server', value: 'appServer' }] },
      ] } };
    }
    if (method !== RPC_METHODS.SESSION_SPAWN_NEW) return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    return await sessionSpawnNewActionBoundarySpy(SessionSpawnNewInputV2Schema.parse(input));
  };
  socketRpcBoundary.respond = respondMachineRpc;
  const machineRpcSpy = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, input) => await respondMachineRpc(method, input));
  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  let authProjection: Awaited<ReturnType<typeof renderScreen>> | null = null;
  const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  const fetchBoundary = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const memory = await authoringMemoryHttp.handle(input, init);
    if (memory) return memory;
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/v1/kv/')) {
      const key = decodeURIComponent(url.split('/v1/kv/')[1]!);
      const row = todoKv.items.get(key);
      return row ? Response.json(row) : Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (url.endsWith('/v1/kv') && init?.method === 'POST') {
      const { mutations } = JSON.parse(String(init.body)) as { mutations: typeof todoKv.writes };
      todoKv.writes.push(...mutations);
      if (todoKv.failWrite) return Response.json({ error: 'task link unavailable' }, { status: 400 });
      if (todoKv.conflictOnce) {
        todoKv.conflictOnce = false;
        const row = todoKv.items.get(mutations[0]!.key)!;
        const { decodeBase64StoredJsonContentEnvelope, encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
        const envelope = decodeBase64StoredJsonContentEnvelope(row.value);
        if (envelope?.t !== 'plain') throw new Error('Plain conflict fixture expected');
        const item = envelope.v as Record<string, unknown>;
        row.value = encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { ...item, linkedSessions: { ...(item.linkedSessions as object), concurrent: { title: 'Another session', linkedAt: 2 } } } });
        row.version += 1;
      }
      const errors = mutations.flatMap((mutation) => {
        const row = todoKv.items.get(mutation.key);
        return row?.version === mutation.version ? [] : [{ key: mutation.key, error: 'version-mismatch', version: row?.version ?? -1, value: row?.value ?? null }];
      });
      if (errors.length > 0) return Response.json({ success: false, errors }, { status: 409 });
      const results = mutations.map((mutation) => {
        const version = mutation.version + 1;
        if (mutation.value === null) todoKv.items.delete(mutation.key);
        else todoKv.items.set(mutation.key, { key: mutation.key, value: mutation.value, version });
        return { key: mutation.key, version };
      });
      return Response.json({ success: true, results });
    }
    if (url.endsWith('/v1/account/encryption/currentness')) return Response.json(todoKv.currentness);
    if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: todoKv.currentness.mode, updatedAt: 1 });
    if (url.endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
    if (url.endsWith('/v1/machines/m1')) return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
    if (/^\/v1\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname)) {
      return Response.json({ messages: [], hasMore: false });
    }
    const sessionId = new URL(url).pathname.match(/^\/v2\/sessions\/([^/]+)$/)?.[1];
    if (sessionId) {
      const session = storage.getState().sessions[decodeURIComponent(sessionId)];
      if (!session) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ session: {
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, encryptionMode: session.encryptionMode,
        dataEncryptionKey: null, metadataLayoutVersion: 0, metadataVersion: session.metadataVersion,
        metadata: JSON.stringify(session.metadata), agentStateVersion: session.agentStateVersion,
        agentState: session.agentState === null ? null : JSON.stringify(session.agentState), share: null,
      } });
    }
    if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
  vi.spyOn(sync, 'sendMessage');
  await import('@/sync/ops/actions/defaultActionExecutor');

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  return {
    async reset() {
      await authProjection?.unmount();
      authProjection = null;
      todoKv.currentness = plainCurrentness;
      todoKv.items.clear();
      todoKv.failWrite = false;
      todoKv.conflictOnce = false;
      todoKv.writes = [];
      modalAlertSpy.mockClear();
      machineRpcSpy.mockClear();
      sessionSpawnNewActionBoundarySpy.mockReset().mockResolvedValue({ type: 'error', code: 'machine_offline', retryable: true });
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      authoringMemoryHttp.reset();
      setRuntimeFetch(fetchBoundary);
      vi.stubGlobal('fetch', fetchBoundary);
      await selectNewSessionTestHome();
      await sync.switchServer({ token });
      // Sync credentials alone do not authenticate the rendered UI. Let the
      // real auth projection supply the Action owner's credential provenance.
      authProjection = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: { token }, children: null }));
      storage.getState().applySettings(storage.getState().settings, 1);
      storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
    },
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    todoKv,
    machineRpcSpy,
    async disposeAuth() { await authProjection?.unmount(); authProjection = null; },
    get storageState() { return storage.getState(); },
  };
}

// Load the real cold module graph during collection; setup's budget observes
// Account/HTTP/draft hydration, not compilation of the Action executor graph.
const harness = await createHarness();
let actionHomesBoundary: Awaited<ReturnType<typeof serveActionHomes>>;
async function setupHarness() {
  await harness.reset();
  return harness;
}

async function setupTaskHarness() {
  // The real cold connection owner awaits its initial-sync budget. Frozen timers
  // cannot settle that budget when unrelated bootstrap endpoints are unavailable.
  vi.useRealTimers();
  const result = await setupHarness();
  const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await switchConnectionToActiveServer();
  const { storage } = await import('@/sync/domains/state/storageStore');
  const scope = storage.getState().profileScope!;
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: scope.serverId });
  // Accepted creation also hydrates the destination through the real request
  // owner. Keep its propagation/recovery timers running through completion.
  return { ...result, scope, get storageState() { return storage.getState(); } };
}

type CreateSessionParams = Parameters<(typeof import('./useCreateNewSession'))['useCreateNewSession']>[0];

function createRetryParams(settings: Settings, overrides: Partial<CreateSessionParams> = {}): CreateSessionParams {
  return {
    launchIntentSignature: 'test-launch-intent',
    router: { push: vi.fn(), replace: vi.fn() },
    selectedMachineId: 'm1',
    selectedMachine: createMachineFixture({ id: 'm1' }),
    selectedPath: '/tmp',
    draftScope: { serverId: 'server-a', accountId: 'account-a' },
    targetServerId: 'server-a',
    allowedTargetServerIds: ['server-a'],
    setIsCreating: vi.fn(),
    setIsResumeSupportChecking: vi.fn(),
    settings,
    useProfiles: false,
    selectedProfileId: null,
    profileMap: new Map(),
    recentMachinePaths: [],
    agentType: 'codex',
    permissionMode: 'default',
    modelMode: 'default',
    promptStore: createNewSessionPromptStore(''),
    resumeSessionId: '',
    agentNewSessionOptions: null,
    machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
    secrets: [],
    secretBindingsByProfileId: {},
    selectedSecretIdByProfileIdByEnvVarName: {},
    resolveSavedSecretReference,
    sessionOnlySecretValueByProfileIdByEnvVarName: {},
    selectedMachineCapabilities: {},
    ...overrides,
  };
}

function alertRetry(modalAlertSpy: Awaited<ReturnType<typeof setupHarness>>['modalAlertSpy']): () => void {
  const buttons = modalAlertSpy.mock.calls.at(-1)?.[2] as ReadonlyArray<{ text: string; onPress?: () => void }> | undefined;
  const retry = buttons?.find((button) => button.text === 'common.retry')?.onPress;
  expect(retry).toBeTypeOf('function');
  return retry!;
}

describe('useCreateNewSession (daemon unavailable UX)', () => {
  beforeAll(async () => {
    actionHomesBoundary = await serveActionHomes({ homes: [{ key: 'task', serverUrl: 'https://server-a', accountId: 'account-a' }], route: () => undefined });
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
  });
  afterAll(() => {
    actionHomesBoundary?.dispose();
    syncSingletonBridge.current = null;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(async () => {
    await harness?.disposeAuth();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('links a reloaded Zen draft after accepted creation, preserves conflicting links and retries the same Session', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState, todoKv, scope, machineRpcSpy } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope, decodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const source = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1, linkedSessions: { existing: { title: 'Existing', linkedAt: 1 } } };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: { 'todo.task-1': 4 } });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 4 });
    const draftId = seedNewSessionDraftV1({ scope, seed: { prompt: { text: 'Fix task', mode: 'replace' }, zenTaskSource: source, placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'm1', directory: '/tmp' } }, createDraftId: () => 'linked-task-draft' })!;
    const reloaded = readNewSessionDraftFromRepository({ scope, draftId });
    storage.setState({ sessions: { ...storage.getState().sessions, 'task-session': createSessionFixture({ id: 'task-session', serverId: scope.serverId }) } });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ ...spawnSuccess('task-session'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    todoKv.failWrite = true;
    const params = createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore(reloaded!.input),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      zenTaskSource: reloaded?.zenTaskSource, targetAccountScope: scope,
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    let createPromise: Promise<void> | void = undefined;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls.length, JSON.stringify({ alerts: modalAlertSpy.mock.calls, rpc: machineRpcSpy.mock.calls })).toBe(1);
    expect(todoKv.writes.length).toBeGreaterThan(0);
    expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toBeNull();
    expect(Object.keys(storage.getState().todoState!.todos['task-1']!.linkedSessions!)).toEqual(['existing']);
    const retry = alertRetry(modalAlertSpy);
    todoKv.failWrite = false;
    todoKv.conflictOnce = true;
    await act(async () => { retry(); await createPromise; });
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const envelope = decodeBase64StoredJsonContentEnvelope(todoKv.items.get('todo.task-1')!.value);
    expect(envelope).toMatchObject({ t: 'plain', v: { done: false, linkedSessions: { existing: { title: 'Existing' }, concurrent: { title: 'Another session' } } } });
    const { getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    expect(getSessionsForTask('task-1')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'task-session', ...scope })]));
    const { prepareSessionListAccountScope } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
    prepareSessionListAccountScope(scope);
    const ready = createSessionListRenderableSessionFixture({ id: 'task-session', active: true, activeAt: Date.now(), latestTurnStatus: 'completed' });
    storage.setState({ sessionListRowsByServerId: { [scope.serverId]: { 'task-session': ready } } });
    const { TaskStatusPill } = await import('@/components/zen/views/TaskSessionStatusPill');
    const statusView = await renderScreen(React.createElement(TaskStatusPill, { taskId: 'task-1' }));
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(statusView.findHostByTestId('zen-task-session-status')?.props.accessibilityLabel).toBe('inbox.readySessions');
    expect(storage.getState().todoState!.todos['task-1']!.done).toBe(false);
    await act(async () => {
      storage.setState({ sessionListRowsByServerId: { [scope.serverId]: { 'task-session': { ...ready, latestTurnStatus: 'in_progress', thinking: true, thinkingAt: Date.now() } } } });
    });
    expect(statusView.findHostByTestId('zen-task-session-status')?.props.accessibilityLabel).toBe('workStatus.buckets.working');
    await statusView.unmount();
    await hook.unmount();
  });

  it('refuses a deleted task or a foreign Account/Home instead of recreating or retargeting it', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { linkTaskToSession } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { kind: 'zen_task', taskId: 'deleted', scope, title: 'Deleted task' } as const;
    const link = { source, session: { scope, sessionId: 'accepted-session' } };
    // The new link contract is an intent, not a replacement map.
    const linkIntent = linkTaskToSession;
    await expect(linkIntent(link)).rejects.toMatchObject({ code: 'task_deleted' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, accountId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, serverId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    expect(todoKv.writes).toEqual([]);
  });

  it('links a materialized Temporary-computer Session through the same completion and retries without another activation', async () => {
    const { useCreateNewSession, todoKv, scope, storageState, sessionSpawnNewActionBoundarySpy } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { kind: 'zen_task', taskId: 'temporary-task', title: 'Temporary task', scope } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set(`todo.${todo.id}`, { key: `todo.${todo.id}`, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const draftId = seedNewSessionDraftV1({ scope, seed: { prompt: { text: todo.title, mode: 'replace' }, zenTaskSource: source }, createDraftId: () => 'temporary-task-draft' })!;
    storage.setState({ sessions: { ...storage.getState().sessions, 'temporary-session': createSessionFixture({ id: 'temporary-session', serverId: scope.serverId }) } });
    const settlements: Array<import('./useCreateNewSession').TemporaryComputerCreatorSettlement> = [];
    const params = createRetryParams(storageState.settings, {
      draftScope: scope, draftId, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      temporaryComputerTargetScope: scope,
      zenTaskSource: source, targetAccountScope: scope,
      authoringDraft: buildNewSessionAuthoringDraftFromResolvedInputs({
        executionTarget: { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } },
        directory: '', prompt: todo.title, connectedServices: null,
      }),
      // Remote activation settles later. Exercise the actual accepted-Session
      // settlement port rather than substituting completion or task logic.
      temporaryComputerLaunch: async (_submission, settlement) => { settlements.push(settlement); },
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const afterCreated = vi.fn(async () => {});
    await act(async () => {
      await hook.getCurrent().handleCreateSession({
        afterCreated,
        temporaryComputerSubmission: {
          composer: {
            revision: 1, ref: { kind: 'newSession', instanceId: draftId }, text: todo.title,
            references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
          },
          reviewComments: null, attachmentDrafts: [],
          attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
          maxFileBytes: 1024,
        },
      });
    });
    expect(settlements).toHaveLength(1);
    todoKv.failWrite = true;
    await act(async () => {
      await expect(settlements[0]!.complete('temporary-session', [])).rejects.toMatchObject({ stage: 'follow_up' });
    });
    expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toBeNull();
    expect(getSessionsForTask(todo.id)).toEqual([]);
    expect(afterCreated).not.toHaveBeenCalled();
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe(todo.title);
    todoKv.failWrite = false;
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(getSessionsForTask(todo.id)).toEqual([expect.objectContaining({ ...scope, sessionId: 'temporary-session' })]);
    const writes = todoKv.writes.length;
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(todoKv.writes).toHaveLength(writes);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(settlements).toHaveLength(1);
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    // The canonical revision-safe clear empties submitted fields; it does not
    // delete the document (later edits may still belong to this draft).
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('');
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.launchUserAttemptId).toBeUndefined();
    await hook.unmount();
  });

  it('keeps same-id Sessions on different Homes distinct and makes repeated link acceptance a no-op', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const input = { source, session: { scope, sessionId: 'same-id' } };
    const linkIntent = linkTaskToSession;
    await linkIntent(input);
    await linkIntent({ ...input, session: { scope: { serverId: 'server-b', accountId: 'account-b' }, sessionId: 'same-id' } });
    const before = todoKv.items.get('todo.task-1');
    const writeCount = todoKv.writes.length;
    await linkIntent(input);
    expect(todoKv.items.get('todo.task-1')).toEqual(before);
    expect(todoKv.writes).toHaveLength(writeCount);
    expect(getSessionsForTask('task-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...scope, sessionId: 'same-id' }),
      expect.objectContaining({ serverId: 'server-b', accountId: 'account-b', sessionId: 'same-id' }),
    ]));
  });

  it('links E2EE tasks with real Account crypto and rejects mode mismatches before writing', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { sync } = await import('@/sync/syncEngine');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const credentials = { token: sync.getCredentials()!.token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
    todoKv.currentness = { mode: 'e2ee', version: 2, signingKeyFingerprint: 'signing-2', contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint), updatedAt: 2 };
    await sync.switchServer(credentials);
    const source = { kind: 'zen_task', taskId: 'e2ee-task', scope, title: 'Private task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    // Raw ciphertext is the pinned 0.2-produced reader input; the real codec owns new writes.
    todoKv.items.set('todo.e2ee-task', { key: 'todo.e2ee-task', value: await sync.encryption!.encryptRaw(todo), version: 1 });
    await linkTaskToSession({ source, session: { scope, sessionId: 'private-session' } });
    const row = todoKv.items.get('todo.e2ee-task')!;
    expect(row.value).not.toContain(source.title);
    expect(await sync.encryption!.decryptRaw(row.value)).toMatchObject({ done: false });
    expect(getSessionsForTask(todo.id)).toEqual([expect.objectContaining({ ...scope, sessionId: 'private-session' })]);
    const writes = todoKv.writes.length;
    todoKv.items.set(row.key, { ...row, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }) });
    await expect(linkTaskToSession({ source, session: { scope, sessionId: 'another' } })).rejects.toMatchObject({ code: 'task_link_failed', cause: { code: 'todo_stored_content_unavailable', reason: 'account_mode_mismatch' } });
    expect(todoKv.writes).toHaveLength(writes);
  });

  it('retries the same creation identity from the daemon-unavailable Retry action', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const params = createRetryParams(storageState.settings);
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    const retry = alertRetry(modalAlertSpy);
    // The daemon rejects a reused Action request id whose input differs, so a
    // later retry of the same attempt must replay byte-identical input.
    vi.setSystemTime(new Date('2026-02-05T00:05:00.000Z'));
    await act(async () => { retry(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
    await hook.unmount();
  });

  it('creates a no-folder session: managed directory, no checkout, no recent folder written', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      // Accepted creation exposes the destination before the real route handoff.
      storage.getState().applySessions([
        createSessionFixture({ id: 'session-managed', serverId: 'server-a' }),
      ]);
      return spawnSuccess('session-managed');
    });
    const recentBefore = storageState.authoringMemory.recentMachinePaths;
    const params = createRetryParams(storageState.settings, {
      // The remembered folder and its checkout draft stay in the draft; neither reaches the spawn.
      selectedPath: '/tmp/remembered',
      directoryKind: 'managed',
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-x', baseRef: null },
      promptStore: createNewSessionPromptStore('Write a haiku'),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(modalAlertSpy.mock.calls.map((call) => call[1])).not.toContain('newSession.noPathSelected');
    const request = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(request?.directory).toEqual({ kind: 'managed' });
    expect(request?.checkoutCreationDraft ?? null).toBeNull();
    expect(storage.getState().authoringMemory.recentMachinePaths).toEqual(recentBefore);
    await hook.unmount();
  });

  it('replays the exact persisted attempt input after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'reload-retry-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Reload retry' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
    const paramsFor = (launchUserAttemptId: string | null) => createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Reload retry'),
      launchUserAttemptId,
    });

    const firstHook = await renderHook(() => useCreateNewSession(paramsFor(null)));
    await act(async () => { await firstHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await firstHook.unmount();

    vi.setSystemTime(new Date('2026-02-05T00:10:00.000Z'));
    const persistedAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    expect(persistedAttemptId).toBeTruthy();
    const reloadedHook = await renderHook(() => useCreateNewSession(paramsFor(persistedAttemptId)));
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
  });

  it('preserves the draft and gives host setup recovery for a non-retryable terminal-host failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-host-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Keep this draft' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'incompatible_target', retryable: false,
      terminalHostError: { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' } });
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore('Keep this draft'),
      spawnBackendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'newSession.terminalHostUnavailableTitle', 'newSession.terminalHostUnavailableBody',
    ]);
    expect(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })?.document.composer.text?.value).toBe('Keep this draft');
    await hook.unmount();
  });

  it('mints a fresh attempt after a terminal spawn failure, in place and after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-failure-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Terminal failure' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'spawn_failed', retryable: false });
    let durableUserAttemptId: string | null = null;
    const createHook = () => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Terminal failure'),
      launchUserAttemptId: durableUserAttemptId,
      onLaunchUserAttemptIdChange: (next) => { durableUserAttemptId = next; },
    }));
    const creationKeyAt = (index: number) => sessionSpawnNewActionBoundarySpy.mock.calls[index]?.[0].creationKey;

    const hook = await renderHook(createHook);
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.rerender();
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.unmount();

    durableUserAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    const reloadedHook = await renderHook(createHook);
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(3);
    expect(new Set([creationKeyAt(0), creationKeyAt(1), creationKeyAt(2)]).size).toBe(3);
  });

  it('invalidates daemon-unavailable Retry after Home, Account, Machine, path, or launch intent changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const changes = [
      ['Home', { targetServerId: 'server-b', draftScope: { serverId: 'server-b', accountId: 'account-a' } }],
      ['Account', { draftScope: { serverId: 'server-a', accountId: 'account-b' } }],
      ['Machine', { selectedMachineId: 'm2', selectedMachine: createMachineFixture({ id: 'm2' }) }],
      ['path', { selectedPath: '/other' }],
      ['launch intent', { launchIntentSignature: 'changed-intent' }],
    ] satisfies ReadonlyArray<readonly [string, Partial<CreateSessionParams>]>;
    for (const [name, overrides] of changes) {
      sessionSpawnNewActionBoundarySpy.mockClear();
      modalAlertSpy.mockClear();
      const initial = createRetryParams(storageState.settings);
      const hook = await renderHook((params: CreateSessionParams) => useCreateNewSession(params), { initialProps: initial });
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      const retry = alertRetry(modalAlertSpy);
      await hook.rerender({ ...initial, ...overrides });
      await act(async () => { retry(); });
      await flushHookEffects({ cycles: 8, turns: 4 });
      expect(sessionSpawnNewActionBoundarySpy, name).toHaveBeenCalledTimes(1);
      await hook.unmount();
    }
  });

  it('offers manual Retry for a typed daemon-unavailable Action without automatically retrying', async () => {
    const { useCreateNewSession, modalAlertSpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(modalAlertSpy).toHaveBeenCalled();
    const args = modalAlertSpy.mock.calls[0] ?? [];
    expect(args).toEqual([
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    ]);
    await hook.unmount();
  });

  it('does not keep the single-flight guard latched after a local validation failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedMachineId }: { selectedMachineId: string | null }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId,
          selectedPath: '/tmp',
          selectedMachine: selectedMachineId
            ? { id: selectedMachineId, active: true, activeAt: Date.now(), metadata: { host: 'devbox' } }
            : null,
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedMachineId: null as string | null } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

    await hook.rerender({ selectedMachineId: 'm1' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('uses the latest selectedPath immediately after a rerender (no stale ref window)', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    let createPromise: Promise<void> | void | null = null;

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedPath, triggerCreate }: { selectedPath: string; triggerCreate: boolean }) => {
        const createHook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        });

        // Simulate the user clicking "Start New Session" immediately after the path
        // rerender commits, before passive effects flush.
        React.useLayoutEffect(() => {
          if (!triggerCreate) return;
          createPromise = createHook.handleCreateSession();
        }, [triggerCreate, createHook.handleCreateSession]);

        return createHook;
      },
      { initialProps: { selectedPath: '', triggerCreate: false } },
    );

    await hook.rerender({ selectedPath: '/tmp', triggerCreate: true });

    if (!createPromise) throw new Error('expected createPromise to be assigned');
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/tmp' });

    await hook.unmount();
  });

  it('uses the latest requested path getter even before the committed selectedPath rerenders', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const requestedPathRef = { current: '/home/happier/projects/subdir' };
    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/home/happier',
        getRequestedPath: () => requestedPathRef.current,
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise!;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/home/happier/projects/subdir' });

    await hook.unmount();
  });

  it('does not automatically retry a typed Action rejection while offering explicit recovery', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();

    expect(modalAlertSpy).toHaveBeenCalledWith(
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    );

    await hook.unmount();
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry in the hook before showing the daemon-unavailable alert', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'error',
      code: 'machine_offline',
      retryable: true,
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });

  it('admits and projects the accepted first prompt before opening the created session route', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    const router = {
      push: vi.fn(),
      replace: vi.fn(() => {
        expect(storage.getState().sessionPending['session-created']?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ localId: 'input-session-created', text: 'Start here', deliveryStatus: 'accepted' }),
        ]));
      }),
    };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      router, promptStore: createNewSessionPromptStore('Start here'),
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).toMatchObject({
      creationKey: expect.stringMatching(/^manual:/), initialInput: { text: 'Start here' },
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('publishes the first prompt as a launch attempt while spawn is unresolved', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const spawnDeferred = createDeferred<SessionSpawnNewResultV1>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => spawnDeferred.promise);
    const onLaunchAttemptChange = vi.fn();

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: 'server-a',
        allowedTargetServerIds: ['server-a'],
        onLaunchAttemptChange,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ turns: 2 });
      });

      expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
      const publishedAttempts = onLaunchAttemptChange.mock.calls
        .map((call) => call[0])
        .filter(Boolean);
      expect(publishedAttempts[publishedAttempts.length - 1]).toEqual(expect.objectContaining({
        status: 'spawning',
        createdSessionId: null,
        prompt: expect.objectContaining({
          prompt: 'Start here',
          displayText: 'Start here',
        }),
      }));
      expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
    } finally {
      harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
      spawnDeferred.resolve(spawnSuccess('session-created'));
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it('keeps a pending Action unresolved without duplicating creation', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const creationKey = (sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as any)?.creationKey;
    expect(creationKey).toEqual(expect.stringMatching(/^manual:new-session-attempt-/));
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      expect.stringContaining('newSession.launchStillPendingBody'),
    );

    await hook.unmount();
  });

  it('preserves a first prompt not accepted by the created Session without sending it twice', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      ...spawnSuccess('session-created'),
      type: 'success', disposition: 'created', sessionId: 'session-created',
      executionTarget: { serverId: 'server-a', machineId: 'm1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'outcomeUnknown', localId: 'input-session-created', code: 'transport_unavailable' },
    });
    const router = { push: vi.fn(), replace: vi.fn() };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      promptStore: createNewSessionPromptStore('Keep this first prompt'), router,
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].initialInput).toEqual({ text: 'Keep this first prompt' });
    expect(getSessionDraftSnapshot({ serverId: 'server-a', accountId: 'account-a' }, { kind: 'session', sessionId: 'session-created' })?.document.composer.text?.value).toBe('Keep this first prompt');
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('retries an outcome-unknown Action with the same creation identity', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-after-retry', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-after-retry'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry same nonce'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).not.toHaveBeenCalled();
    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    expect(firstSpawnOptions).not.toHaveProperty('initialPrompt');
    await act(async () => { await hook.getCurrent().handleCreateSession(); });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      creationKey: firstSpawnOptions.creationKey,
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-after-retry?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('retains the real custody creation identity across remount after an unknown outcome', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({
      id: 'session-from-operation-settlement',
      serverId: 'server-a',
      encryptionMode: 'plain',
    })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-from-operation-settlement'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    let durableUserAttemptId: string | null = null;
    const createHook = () =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry after route stall'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
        launchUserAttemptId: durableUserAttemptId,
        onLaunchUserAttemptIdChange: (next) => {
          durableUserAttemptId = next;
        },
      });

    const firstHook = await renderHook(createHook);
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const secondHook = await renderHook(createHook);
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(secondSpawnOptions.creationKey).toBe(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].creationKey);
    expect(secondSpawnOptions.creationKey).toMatch(/^manual:.+/);
  });

  it('keeps the unresolved launch barrier after remounting with a changed prompt on the same launch scope', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const createHook = (sessionPrompt: string) =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm-remount-prompt',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm-remount-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(sessionPrompt),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      });

    const firstHook = await renderHook(() => createHook('First timed-out prompt'));
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    const secondHook = await renderHook(() => createHook('Changed prompt after timeout'));
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);
  });

  it('rotates the action identity when the canonical launch intent changes on the same mounted screen', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ launchIntentSignature }: { launchIntentSignature: string }) =>
        useCreateNewSession({
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm-mounted-prompt',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm-mounted-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore('Unchanged prompt'),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
          launchUserAttemptId: 'persisted-attempt-a',
          launchIntentSignature,
        }),
      { initialProps: { launchIntentSignature: 'intent-a' } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    await hook.rerender({ launchIntentSignature: 'intent-b' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);

    await hook.unmount();
  });

  it('offers Retry for daemon-unavailable post-create follow-up failures without creating another session', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    let retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    for (let attempts = 0; attempts < 5 && !retryAlertCall; attempts += 1) {
      await flushHookEffects({ runOnlyPendingTimers: true });
      retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
        const buttons = call[2];
        return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
      });
    }
    expect(retryAlertCall).toBeTruthy();
    expect(modalAlertSpy.mock.calls.some((call) => call[0] === 'common.error')).toBe(false);
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      effectiveSpawnServerId: 'server-a',
      launchAttempt: expect.objectContaining({
        attachmentMessageLocalId: expect.stringMatching(/^plugin-input-v1:/),
      }),
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('drops duplicate create requests while a launch is already in flight', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValue(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let firstCreate: Promise<void> | void | null = null;
    let secondCreate: Promise<void> | void | null = null;
    await act(async () => {
      firstCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
      secondCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);

    resolveAfterCreated();
    await firstCreate;
    await secondCreate;

    await hook.unmount();
  });

  it('does not navigate when launch scope changes before completion', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();

    const hook = await renderHook(
      ({ targetServerId }: { targetServerId: string | null }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId,
          allowedTargetServerIds: ['server-a', 'server-b'],
        }),
      { initialProps: { targetServerId: 'server-a' as string | null } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ targetServerId: 'server-b' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(router.replace).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenLastCalledWith(false);

    await hook.unmount();
  });

  it('keeps routing when macOS resolves a /tmp launch path to its /private/tmp canonical path', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ selectedPath }: { selectedPath: string }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: {
            id: 'm1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'devbox', platform: 'darwin', homeDir: '/Users/leeroy' },
          },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedPath: '/tmp/happier-ruqa-late-opencode-hqzCRl' } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ selectedPath: '/private/tmp/happier-ruqa-late-opencode-hqzCRl' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('keeps launch pending and routes when the created session hydrates after an initial route-readiness miss', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    expect(router.replace).not.toHaveBeenCalled();
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenCalledWith(true);
    expect(setIsCreating).not.toHaveBeenCalledWith(false);

    await hook.unmount();
  });

  it('treats profile-mode changes as launch scope changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ useProfiles }: { useProfiles: boolean }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          settings,
          useProfiles,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { useProfiles: false } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await hook.rerender({ useProfiles: true });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('retries post-create follow-up failures against the created session without respawning', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    const retryPresented = createDeferred<void>();
    modalAlertSpy.mockImplementationOnce(() => retryPresented.resolve(undefined));
    const spawnDispatch = createDeferred<SessionSpawnNewInputV2>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async (input) => {
      spawnDispatch.resolve(input);
      return spawnSuccess('session-created');
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(new Error('Created session is not available locally yet'))
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
      await spawnDispatch.promise;
      await retryPresented.promise;
      await flushHookEffects({ runOnlyPendingTimers: true });
    });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as Array<{ text?: string; onPress?: () => void }>)
      .find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runOnlyPendingTimers: true });
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      launchAttempt: expect.objectContaining({
        createdSessionId: 'session-created',
      }),
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('shows the generic follow-up error when retry fails for a non-daemon reason', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockRejectedValueOnce(new Error('Attachment validation failed'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(modalAlertSpy.mock.calls).toContainEqual([
      'common.error',
      'Attachment validation failed',
    ]);

    await hook.unmount();
  });


});
