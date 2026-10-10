import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRunStartResponseSchema, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, MACHINE_PLAIN_DATA_KEY_MARKER,
  SessionSpawnNewInputV2Schema, SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

const outgoing: SocketRpcRequestPayload[] = [];
let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed socket RPC request');
    }
    const request: SocketRpcRequestPayload = { method: payload.method, params: payload.params };
    outgoing.push(request);
    return { ok: true, result: daemonAnswer(request) };
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorModuleLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

function installSession(id: string, metadata: NonNullable<ReturnType<typeof createSessionFixture>['metadata']>) {
  const session = createSessionFixture({ id, serverId, active: true, metadata });
  storage.setState({ sessions: { ...storage.getState().sessions, [id]: session } });
  let row = SessionCurrentProjectionRecordV1Schema.parse({
    ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
    effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
    agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
  });
  const answer = { select: (input: unknown) => {
    if (input === undefined || input === null) return { body: { session: row } };
    const patch = SessionMetadataTuplePatchV1Schema.parse(input);
    if (patch.mode === 'shared_editor') throw new Error('Owner mode change used shared-editor metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    row = SessionCurrentProjectionRecordV1Schema.parse({ ...row,
      metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
      ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
      metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1,
    });
    return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
  } };
  homes.answer(serverId, `/v2/sessions/${id}`, answer);
  homes.answer(serverId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
  return () => row;
}

const modes = (agentId: string, currentModeId: string, ids: readonly string[]) => ({
  v: 1 as const, agentId, updatedAt: 1, currentModeId,
  availableModes: ids.map((id) => ({ id, name: id === 'default' ? 'Default' : id === 'build' ? 'Build' : 'Plan' })),
});
const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, serverId });

describe('default Action executor mode and catalog contracts', () => {
  it('preserves definitive API-token send outcomes at the transcript boundary', async () => {
    const read = installSession('external-send', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    if (!connection) throw new Error('Missing connected Home fixture');
    const { sync } = await import('@/sync/sync');
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const http = await import('@/sync/http/client');
    const previousAuth = getCurrentAuth();
    let outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
    // The endpoint HTTP adapter is the genuine boundary. Scope lifetime,
    // bootstrap, public Action transport, output parsing and the source stay real.
    vi.spyOn(http, 'createServerFetchAtEndpoint').mockImplementation(({ endpointUrl }) => async (path) => {
      const url = new URL(path, endpointUrl);
      if (url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      if (url.pathname === '/v2/sessions/external-send') return Response.json({ session: read() });
      if (url.pathname === '/v1/sessions/external-send/turns') return Response.json({ v: 1, sessionId: 'external-send', updatedAt: 1, turns: [] });
      if (url.pathname === '/v1/sessions/external-send/messages') return Response.json({ messages: [], hasMore: false });
      if (url.pathname === '/v2/sessions/external-send/pending') return Response.json({ pending: [], count: 0, version: 0 });
      if (url.pathname === '/v1/actions/session.message.send') return Response.json({ v: 1, actionId: 'session.message.send', execution: { ok: true, result: outcome } });
      throw new Error(`Unexpected embed HTTP request: ${url.pathname}`);
    });
    const refuseCredentialMutation = async (): Promise<never> => { throw new Error('Injected credential'); };
    setCurrentAuth({ isAuthenticated: true, credentials: connection.credentials, credentialAuthorityKind: 'api_token',
      login: refuseCredentialMutation, loginWithCredentials: refuseCredentialMutation, logout: refuseCredentialMutation,
      refreshFromActiveServer: async () => {} });
    try {
      await sync.create(connection.credentials, null, undefined, { scope: { kind: 'embedSession', sessionId: 'external-send' },
        accountId: 'alice', endpointUrl: 'https://mode-actions.test', accountMode: 'plain', isCurrent: () => true });
      const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
      const actions = createAppSessionTranscriptActions('external-send', serverId);
      for (const result of [
        { status: 'rejected', code: 'session_input_unauthorized' },
        { status: 'failed', localId: 'real-input', code: 'session_input_turn_failed' },
        { status: 'cancelled', localId: 'real-input', code: 'session_input_turn_cancelled' },
      ]) {
        outcome = SessionMessageSendResultV1Schema.parse(result);
        await expect(actions.submitMessage('Message')).rejects.toMatchObject({ code: result.code, details: outcome });
      }
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
      await expect(actions.submitMessage('Message')).resolves.toBeUndefined();
    } finally {
      sync.disposeEmbedSession();
      setCurrentAuth(previousAuth);
    }
  });
  it('refuses a disabled stop through the shared lifecycle adapter used by single and bulk commands', async () => {
    installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: { v: 1,
      actions: { 'session.stop': { disabledSurfaces: ['ui'] } } } } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .toMatchObject({ success: false });
    expect(outgoing).toEqual([]);
  });
  it('applies permission-mode selection through the Action while retaining next-prompt timing', async () => {
    const { applyPermissionModeSelection } = await import('@/sync/domains/permissions/permissionModeApply');
    const read = installSession('mode-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'safe-yolo', applyTiming: 'next_prompt',
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).toBe('safe-yolo');
    expect(read().metadataVersion).toBe(1);
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'read-only', applyTiming: 'immediate',
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).toBe('read-only');
    expect(read().metadataVersion).toBeGreaterThan(1);
  });

  it('refuses disabled transcript permission and answer Actions before reaching the daemon', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: {
      'session.permission.respond': { disabledSurfaces: ['ui'] },
      'session.user_action.answer': { disabledSurfaces: ['ui'] },
      'session.message.send': { disabledSurfaces: ['ui'] },
    } } } });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await expect(actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' })).rejects.toThrow();
    await expect(actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } })).rejects.toThrow();
    await expect(actions.submitMessage('Selected option', { callerSurface: 'message_option' })).rejects.toThrow();
    expect(storage.getState().sessions['prompt-session']?.permissionMode).not.toBe('acceptEdits');
    expect(outgoing).toEqual([]);
  });
  it('preserves permission decisions, client evidence and multi-select answers through transcript Actions', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' });
    expect(storage.getState().sessions['prompt-session']?.permissionMode).toBe('acceptEdits');
    await actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
      params: expect.objectContaining({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits',
        answeringClientCategory: expect.any(String) }) }));
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: expect.objectContaining({ id: 'q1', approved: true, answers: { Question: ['One', 'Two'] },
        answeringClientCategory: expect.any(String) }) }));
  });
  it('keeps permission feedback and title state unchanged while explicit UI approval is pending', async () => {
    const read = installSession('approval-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: {
      'session.permission.respond': { approvalRequiredSurfaces: ['ui'] },
      'session.title.set': { approvalRequiredSurfaces: ['ui'] },
    } } } });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    await expect(createAppSessionTranscriptActions('approval-session', serverId).respondToPermission({
      id: 'p1', approved: true, mode: 'acceptEdits',
    })).rejects.toMatchObject({ code: 'approval_request_created' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.title.set', 'approval-session', { serverId }, 'Pending title'))
      .toMatchObject({ success: false, code: 'approval_request_created' });
    expect(storage.getState().sessions['approval-session']?.permissionMode).not.toBe('acceptEdits');
    expect(read().metadataVersion).toBe(1);
    expect(outgoing).toEqual([]);
  });

  it('refuses disabled session-delete before reaching its HTTP transport', async () => {
    const session = createSessionFixture({ id: 'delete-session', serverId, active: false });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session }, settings: {
      ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: { 'session.delete': { disabledSurfaces: ['ui'] } } },
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    let deleted = false;
    homes.answer(serverId, `/v1/sessions/${session.id}`, { select: () => { deleted = true; return { body: { success: true } }; } });
    await expect(executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session, serverId,
      currentUserId: 'alice', isConnected: true, isPinned: false }) })).rejects.toThrow();
    expect(deleted).toBe(false);
  });
  it('retains the Home delete conflict payload at the UI error boundary', async () => {
    const session = createSessionFixture({ id: 'conflict-session', serverId, active: false });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    const details = { error: 'Session delete condition was lost' };
    homes.answer(serverId, `/v1/sessions/${session.id}`, { status: 409, body: details });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session,
      serverId, currentUserId: 'alice', isConnected: true, isPinned: false }) }))
      .rejects.toMatchObject({ code: 'session_delete_conflict', details, message: details.error });
  });
  it.each(['ui.session.archive', 'ui.session.unarchive', 'ui.session.rename'] as const)(
    'refuses disabled sibling %s before mutating the selected Session', async (actionId) => {
      const read = installSession('sibling-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
      const disabled = actionId === 'ui.session.rename' ? 'session.title.set'
        : actionId === 'ui.session.archive' ? 'session.archive' : 'session.unarchive';
      storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: {
        [disabled]: { disabledSurfaces: ['ui'] },
      } } } });
      let wroteArchive = false;
      homes.answer(serverId, '/v2/sessions/sibling-session/archive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: 10 } };
      } });
      homes.answer(serverId, '/v2/sessions/sibling-session/unarchive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: null } };
      } });
      const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
      const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
      const session = { ...storage.getState().sessions['sibling-session']!, active: false };
      await expect(executeSessionAction({ actionId, input: { title: 'Refused title' }, target: createSessionActionTarget({
        session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
      }) })).rejects.toThrow();
      expect(wroteArchive).toBe(false);
      expect(read().metadataVersion).toBe(1);
    },
  );
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    storage.setState(originalState, true);
    await homes.reset();
    resetDynamicModelProbeCacheForTests();
    serverId = await homes.addHome({ name: 'Mode Home', serverUrl: 'https://mode-actions.test', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://mode-actions.test', accountId: 'alice',
      request: async (url, init) => {
        const endpoint = new URL(String(url));
        const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
        return createServerFetchAtEndpoint({ endpointUrl: endpoint.origin, ...(token ? { credentials: { token } } : {}) })(`${endpoint.pathname}${endpoint.search}`, init);
      } });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const machine = createMachineFixture({ id: 'machine-a' });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: { id: 'machine-a', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } });
    outgoing.length = 0;
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    storage.setState(originalState, true);
    webLocks?.restore();
    webLocks = undefined;
    vi.restoreAllMocks();
  });

  it('limits the real backend catalog instead of dropping the requested limit', async () => {
    const execute = createDefaultActionExecutor().execute;
    const full = await execute('agents.backends.list', { includeDisabled: true }, context());
    const limited = await execute('agents.backends.list', { includeDisabled: true, limit: 2 }, context());
    expect(full.ok).toBe(true);
    expect(limited.ok).toBe(true);
    if (!full.ok || !limited.ok) throw new Error('Catalog action failed');
    const parse = (value: unknown) => import('@happier-dev/protocol').then(({ AgentsBackendsListOutputSchema }) => AgentsBackendsListOutputSchema.parse(value));
    expect((await parse(full.result)).items.length).toBeGreaterThan(2);
    expect((await parse(limited.result)).items).toEqual((await parse(full.result)).items.slice(0, 2));
  });

  it.each([
    { agentId: 'claude', machineId: 'machine-a', limit: 3 },
    { backendTargetKey: 'acpBackend:review-bot', machineId: 'machine-a', limit: 2 },
  ])('limits model results from the requested daemon target: $agentId $backendTargetKey', async (input) => {
    daemonAnswer = () => ({ ok: true, result: {
      availableModels: ['one', 'two', 'three', 'four'].map((id) => ({ id, name: id })), supportsFreeform: false,
    } });
    const result = await createDefaultActionExecutor().execute('agents.models.list', input, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toMatchObject({ source: 'preflight', items: [
      { modelId: 'default', label: 'Default' },
      ...['one', 'two'].slice(0, input.limit - 1).map((modelId) => ({ modelId, label: modelId })),
    ] });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: expect.stringContaining('machine-a:'),
      params: expect.objectContaining({ method: 'probeModels' }) }));
    if (input.backendTargetKey) expect(outgoing).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
      params: expect.objectContaining({ backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } }),
    }) }));
  });

  it('sends the strict V2 spawn input as the daemon wire request', async () => {
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'manual:voice-v2-contract',
      executionTarget: { serverId, machineId: 'machine-a' }, directory: { kind: 'path', path: '/tmp/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialInput: { text: 'Inspect this project.' } });
    const spawnResult = { type: 'success', disposition: 'created', sessionId: 'session-new', executionTarget: input.executionTarget,
      organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'message-new' } };
    daemonAnswer = () => spawnResult;
    const result = await createDefaultActionExecutor().execute('session.spawn_new', input, { ...context(), signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, result: spawnResult });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`, params: input }));
  });

  it('clears the terminal composer with the expected state at the Session RPC boundary', async () => {
    installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true, status: 'cleared', sessionId: 's1' });
    expect(await createDefaultActionExecutor().execute('session.terminalComposer.clear',
      { sessionId: 's1', expectedStateAtMs: 1234 }, context())).toMatchObject({ ok: true, result: { status: 'cleared', sessionId: 's1' } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `s1:${SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR}`,
      params: { sessionId: 's1', expectedStateAtMs: 1234 } }));
  });

  it('starts a planner run without changing the parent Session mode', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    const accepted = ExecutionRunStartResponseSchema.parse({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' });
    daemonAnswer = () => accepted;
    const result = await createDefaultActionExecutor().execute('subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan the changes.' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { intent: 'plan', results: [{ ok: true, result: accepted }] } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: expect.stringContaining('execution.run.start') }));
    expect(read().metadataLayoutVersion).toBe(0);
    expect(homes.requestsFor('/v2/sessions/s1').filter((request) => request.input != null)).toEqual([]);
  });

  it.each([
    ['claude', { flavor: 'claude' }, 'plan', 'plan'],
    ['opencode', { flavor: 'opencode', acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']), acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', null],
    ['codex', { flavor: 'codex', sessionModesV1: modes('codex', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', 'default'],
    ['codebuddy', { flavor: 'codebuddy', sessionModesV1: modes('codebuddy', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, '', null],
  ] as const)('publishes %s mode intent through the real owner metadata tuple', async (_agent, metadata, modeId, expectedModeId) => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', ...metadata });
    const result = await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(read().metadataLayoutVersion).toBe(1);
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpSessionModeOverrideV1 ?? flat.sessionModeOverrideV1).toMatchObject({ v: 1, modeId: expectedModeId });
  });

  it('rejects an unavailable mode without writing metadata', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    expect(await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId: 'not-a-real-mode' }, context()))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataLayoutVersion).toBe(0);
    expect(homes.requestsFor('/v2/sessions/s1').filter((request) => request.input != null)).toEqual([]);
  });

  it.each([
    { runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
    { agentRuntimeDescriptorV1: { v: 1, agentId: 'opencode', provider: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
  ] as const)('resolves ACP modes and default from the canonical or supported deployed runtime carrier', async (descriptor) => {
    installSession('s1', { path: '/tmp/project', host: 'localhost',
      ...descriptor,
      acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']) });
    const result = await createDefaultActionExecutor().execute('action.options.resolve',
      { actionId: 'session.mode.set', fieldPath: 'modeId', sessionId: 's1' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
      expect.objectContaining({ value: 'default' }), expect.objectContaining({ value: 'build' }), expect.objectContaining({ value: 'plan' }),
    ]) } });
  });
});
