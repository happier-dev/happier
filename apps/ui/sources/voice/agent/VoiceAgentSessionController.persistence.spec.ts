import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Install Metro's lazy-loader bridge before storage can import its consumers.
// The helper returns the actual Sync singleton, without replacing its methods.
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
  SessionCurrentProjectionRecordV1Schema,
  SessionMetadataTuplePatchV1Schema,
  SessionSpawnNewInputV2Schema,
  V2SessionListResponseSchema,
  type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

let homeId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let unsubscribeStorage: (() => void) | undefined;
const committedSessionRecords = new Map<string, ReturnType<typeof sessionWireRecord>>();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async (params?: any) => ({ voiceAgentId: params?.existingRunId ?? 'run_1' }));
const sendTurn = vi.fn(async () => ({ assistantText: 'ok', actions: [] }));
const commit = vi.fn(async () => ({ commitText: 'commit' }));
const welcome = vi.fn(async () => ({ assistantText: '' }));
const readSessions = vi.fn(async () => {});
const readMachines = vi.fn(async () => {});
const spawnSession = vi.fn<(opts: unknown) => Promise<{ type: 'success'; sessionId: string }>>(async (_opts: unknown) => ({
  type: 'success' as const,
  sessionId: 'sys_voice_new',
}));
const modalConfirm = vi.fn<(title?: unknown, message?: unknown, options?: unknown) => Promise<boolean>>(async (
  _title: unknown,
  _message?: unknown,
  _options?: unknown,
) => false);
const modalAlert = vi.fn((_: unknown, __: unknown, buttons?: unknown) => {
  if (!Array.isArray(buttons) || buttons.length === 0) return;
  const cancelButton = buttons.find((button) => button?.style === 'cancel') ?? buttons[buttons.length - 1];
  if (typeof cancelButton?.onPress === 'function') {
    cancelButton.onPress();
  }
});
const ensureVoiceAgentInstallablesBackground = vi.fn(async (_args: unknown) => {});
const resolveRuntimeFeatureDecision = vi.fn<(args: any) => Promise<any>>(async () => ({
  featureId: 'voice.agent',
  state: 'enabled',
  blockedBy: null,
  blockerCode: 'none',
  diagnostics: [],
  evaluatedAt: 1,
  scope: { scopeKind: 'runtime' },
}));

function buildExecutionRunPublicState(
  overrides: Partial<ExecutionRunPublicState> = {},
): ExecutionRunPublicState {
  return {
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
  };
}

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
  DaemonVoiceAgentClient: class {
    start = start;
    sendTurn = sendTurn;
    commit = commit;
    welcome = welcome;
    startTurnStream = vi.fn();
    readTurnStream = vi.fn();
    cancelTurnStream = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('@/voice/context/buildVoiceInitialContext', () => ({
  buildVoiceInitialContext: () => '',
}));

vi.mock('@/voice/agent/resolveDaemonVoiceAgentModels', () => ({
  resolveDaemonVoiceAgentModelIds: () => ({ chatModelId: 'chat', commitModelId: 'commit' }),
}));

vi.mock('@/voice/agent/ensureVoiceAgentInstallablesBackground', () => ({
  ensureVoiceAgentInstallablesBackground: (args: unknown) => ensureVoiceAgentInstallablesBackground(args),
}));

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
    settings: {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: { enabled: false },
            agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 1 } },
            networkTimeoutMs: 15_000,
          } },
        },
      },
    },
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
    machines: {},
    machineListByServerId: {},
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
  const path = new URL(String(input)).pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  if (path === '/health') return json({});
  if (path === '/v2/cursor') return json({ cursor: 0, changesFloor: 0 });
  if (path === '/v2/changes') return json({ changes: [], nextCursor: 0 });
  if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
  if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: state.settings }, version: 1 });
  if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
  if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path)) return json({ messages: [], hasMore: false });
  // Named list resources must precede the generic session-by-id route.
  if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v1/sessions') {
    if (spawnSession.mock.calls.length > 0) {
      await readSessions();
      for (const session of Object.values(state.sessions) as Array<ReturnType<typeof createSessionFixture>>) {
        if (!committedSessionRecords.has(session.id)) committedSessionRecords.set(session.id, sessionWireRecord(session));
      }
    }
    return json(V2SessionListResponseSchema.parse({ sessions: [...committedSessionRecords.values()], hasNext: false, nextCursor: null }));
  }
  const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    const current = committedSessionRecords.get(id);
    if (!current) return new Response('{}', { status: 404 });
    if (init?.method === 'PATCH') {
      const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
      if (patch.mode !== 'owner_migration' && patch.mode !== 'owner') throw new Error('Expected owner metadata mutation');
      const target = patch.mode === 'owner_migration' ? patch.target : patch;
      const committed = SessionCurrentProjectionRecordV1Schema.parse({
        ...current, metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
        metadataVersion: current.metadataVersion + 1, ownerMetadata: target.ownerMetadata,
        agentState: target.agentState.ciphertext, agentStateVersion: (current.agentStateVersion ?? 0) + 1,
      });
      committedSessionRecords.set(id, committed);
      return json({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: committed.metadataVersion }, agentState: { version: committed.agentStateVersion },
      });
    }
    return json({ session: current });
  }
  if (path === '/v1/machines') {
    await readMachines();
    return json(Object.values(state.machines).map((machine: any) => ({
      ...machine, metadata: machine.metadata ? encodePlainMachineStoredContent(machine.metadata) : null,
      daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })));
  }
  return new Response('{}', { status: 404 });
}

installDisconnectedServerSocketBoundary((socket) => {
  socket.connected = true;
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'update-metadata') throw new Error(`Unexpected socket acknowledgement: ${event}`);
    return { result: 'success', version: payload.expectedVersion + 1, metadata: payload.metadata };
  });
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: {
      confirm: (title?: unknown, message?: unknown, options?: unknown) => modalConfirm(title, message, options),
      alert: (...args: Parameters<typeof modalAlert>) => modalAlert(...args),
    },
  }).module;
});

// Native daemon RPC is the genuine boundary for current Session creation;
// the retired flat machine-spawn adapter must not replace Action execution.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: async (request: {
    method: string;
    payload: unknown;
    onIssued?: () => void;
  }) => {
    if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) throw new Error(`Unexpected machine RPC: ${request.method}`);
    const input = SessionSpawnNewInputV2Schema.parse(request.payload);
    request.onIssued?.();
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
  },
}));

// sessionExecutionRunGet is a protocol boundary; keep the mock flexible as the run schema evolves.
const sessionExecutionRunGet = vi.fn(async (..._args: any[]): Promise<any> => ({
  run: buildExecutionRunPublicState({
    transcript: { persistenceMode: 'persistent', epoch: 1 },
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      providerSessionId: 'vs_1',
    },
  }),
}));
const sessionExecutionRunList = vi.fn(async (..._args: any[]): Promise<any> => ({
  runs: [],
}));
const sessionExecutionRunStop = vi.fn(async (..._args: any[]): Promise<any> => ({
  ok: true,
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunGet: (...args: unknown[]) => sessionExecutionRunGet(...args),
  sessionExecutionRunList: (...args: unknown[]) => sessionExecutionRunList(...args),
  sessionExecutionRunStop: (...args: unknown[]) => sessionExecutionRunStop(...args),
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
  isRuntimeFeatureEnabled: async (args: any) => (await resolveRuntimeFeatureDecision(args)).state === 'enabled',
}));

const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(() => restoreActionExecutorModuleLoader());

async function loadVoiceAgentPersistenceHarness() {
  const normalize = (id: string, session: Parameters<typeof createSessionFixture>[0]) =>
    createSessionFixture({ ...session, id, serverId: homeId,
      metadata: { path: '/voice', host: 'voice.test',
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
    committedSessionRecords.set(id, sessionWireRecord(state.sessionListRowsByServerId?.[homeId]?.[id] ?? session));
  }
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://voice-persistence.example.test',
    request: respondToServerRequest,
  });
  storage.setState({ ...state, profileScope: { serverId: homeId, accountId: 'account-a' } });
  state = storage.getState();
  unsubscribeStorage = storage.subscribe((current) => { state = current; });
  const [{ useVoiceTargetStore }, { VOICE_AGENT_GLOBAL_SESSION_ID }, { createVoiceExecutionTransport }, { voiceSessionBindingStore }] = await Promise.all([
    import('@/voice/runtime/voiceTargetStore'),
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
    vi.useRealTimers();
    await loadSyncSingletonForTests();
    committedSessionRecords.clear();
    start.mockReset();
    start.mockImplementation(async (params?: any) => ({ voiceAgentId: params?.existingRunId ?? 'run_1' }));
    sendTurn.mockReset();
    sendTurn.mockImplementation(async () => ({ assistantText: 'ok', actions: [] }));
    commit.mockReset();
    commit.mockImplementation(async () => ({ commitText: 'commit' }));
    welcome.mockReset();
    welcome.mockImplementation(async () => ({ assistantText: '' }));
    sessionExecutionRunGet.mockClear();
    sessionExecutionRunList.mockClear();
    sessionExecutionRunStop.mockClear();
    readSessions.mockReset();
    readMachines.mockReset();
    spawnSession.mockReset();
    spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'sys_voice_new' }));
    modalConfirm.mockReset();
    modalConfirm.mockImplementation(async () => false);
    ensureVoiceAgentInstallablesBackground.mockReset();
    ensureVoiceAgentInstallablesBackground.mockImplementation(async () => {});
    resolveRuntimeFeatureDecision.mockReset();
    resolveRuntimeFeatureDecision.mockResolvedValue({
      featureId: 'voice.agent',
      state: 'enabled',
      blockedBy: null,
      blockerCode: 'none',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime' },
    });

    homeId = (await upsertAndActivateServer({ serverUrl: 'https://voice-persistence.example.test', name: 'Test Home' })).id;
    state = createVoiceAgentPersistenceTestState();
    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'replay';
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: null };
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.setState({
      runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {}, bindingsByConversationSessionId: {},
    });
  });

  it('persists runId and resumeHandle into carrier session metadata when transcript persistence is enabled', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }), { scope: { serverId: homeId, accountId: 'account-a' } });
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

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'active_voice' }));
    expect(start).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('fails fast with a clear error when daemon voice agent runtime support is disabled', async () => {
    resolveRuntimeFeatureDecision.mockResolvedValueOnce({
      featureId: 'voice.agent',
      state: 'disabled',
      blockedBy: 'local_policy',
      blockerCode: 'flag_disabled',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime' },
    });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).rejects.toMatchObject({
      message: expect.stringContaining('Experimental Features > Voice Agent'),
      code: 'VOICE_AGENT_RUNTIME_UNAVAILABLE',
      featureDecision: expect.objectContaining({
        featureId: 'voice.agent',
        blockedBy: 'local_policy',
        blockerCode: 'flag_disabled',
      }),
    });

    expect(resolveRuntimeFeatureDecision).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'voice.agent' }));
    expect(start).not.toHaveBeenCalled();
  });

  it('persists run metadata even when transcript persistence is ephemeral so active runs can be reattached after reload', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }), { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });
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

    start.mockClear();
    sendTurn.mockClear();
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_1',
          startedAtMs: 10,
        }),
      ],
    });
    sessionExecutionRunGet.mockResolvedValueOnce({
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

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        existingRunId: 'run_1',
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

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' }, { scope: { serverId: homeId, accountId: 'account-a' } });
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
    sessionExecutionRunList.mockResolvedValueOnce({
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

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_stale' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(sessionExecutionRunStop).not.toHaveBeenCalledWith('s1', { runId: 'run_other_backend' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(readSessionOwnerMetadataView(state.sessions.s1)?.voiceAgentRunV1).toBeUndefined();
  });

  it('reconciles duplicate running session-scoped voice runs by reattaching the newest match and stopping the extras', async () => {
    sessionExecutionRunList.mockResolvedValueOnce({
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
    sessionExecutionRunGet
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

    expect(sessionExecutionRunList).toHaveBeenCalledWith('s1', {}, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_old' }, { scope: { serverId: homeId, accountId: 'account-a' } });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        existingRunId: 'run_new',
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

    start.mockClear();
    sendTurn.mockClear();

    const secondController = createVoiceExecutionTransport();
    await secondController.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello again');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_1',
      }),
    );
  });

  it('uses the hidden voice conversation session as the only global daemon RPC anchor', async () => {
    state.sessions.s2 = { id: 's2', updatedAt: 2, modelMode: 'default', metadata: { flavor: 'claude' } };

    start
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ voiceAgentId: 'run_2' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'ok',
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
      }),
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
      }),
    );
  });

  it('retries session-scoped daemon start when the first attempt returns RPC method not available', async () => {
    start
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ voiceAgentId: 'run_2' });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({
      assistantText: 'ok',
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 's1',
      }),
    );
    expect(start).toHaveBeenNthCalledWith(
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

    start.mockRejectedValueOnce(Object.assign(new Error('Not running'), { rpcErrorCode: 'execution_run_not_allowed' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sessionExecutionRunGet
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

    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_prev',
      }),
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
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

    start.mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sessionExecutionRunGet.mockResolvedValueOnce({
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

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: false,
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

    start.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_3' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: true,
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

    start.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_fresh' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();
    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: true,
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

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: false,
        resumeHandle: null,
      }),
    );
  });

  it('retries when daemon sendTurn fails with the plain Voice agent not found message', async () => {
    sendTurn
      .mockRejectedValueOnce(new Error('Voice agent not found'))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it('clears a stale cached handle when immediate welcome fails with the plain Voice agent not found message', async () => {
    state.settings.voice.welcome = {
      enabled: true,
      mode: 'immediate',
      templateId: null,
    };
    welcome.mockRejectedValueOnce(new Error('Voice agent not found'));
    sendTurn.mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();
    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(welcome).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it('persists welcomedEpoch after an immediate welcome and suppresses duplicate welcome after controller recreation', async () => {
    state.settings.voice.welcome = {
      enabled: true,
      mode: 'immediate',
      templateId: null,
    };
    welcome.mockResolvedValue({ assistantText: 'Welcome!' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await expect(firstController.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBe('Welcome!');

    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      transcriptContractVersion: 2,
      welcomedEpoch: 1,
    });
    expect(welcome).toHaveBeenCalledTimes(1);

    const secondController = createVoiceExecutionTransport();
    await expect(secondController.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();

    expect(welcome).toHaveBeenCalledTimes(1);
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

    start.mockRejectedValueOnce(Object.assign(new Error('Not resumable'), { rpcErrorCode: 'execution_run_not_allowed' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_4' });
    sessionExecutionRunGet.mockResolvedValueOnce({
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

    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_prev',
        resumeWhenInactive: true,
      }),
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: true,
        resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_prev' }),
      }),
    );
    expect(readSessionOwnerMetadataView(state.sessions.sys_voice)?.voiceAgentRunV1).toMatchObject({
      runId: 'run_4',
      resumeHandle: expect.objectContaining({ providerSessionId: 'vs_4' }),
    });
  });

  it('persists an updated resumeHandle into carrier metadata after commit (e.g. commit session ids)', async () => {
    sessionExecutionRunGet.mockImplementation(async () => ({
      run: commit.mock.calls.length === 0
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

    expect(commit).toHaveBeenCalledTimes(1);
    expect(sessionExecutionRunGet.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    start
      .mockResolvedValueOnce({ voiceAgentId: 'run_1' })
      .mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sendTurn
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it('clears stale persisted daemon run metadata before retrying after RPC method not available', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_stale',
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_stale' },
      updatedAtMs: 1,
    };
    start.mockImplementation(async (params?: any) => ({ voiceAgentId: params?.existingRunId ?? 'run_fresh' }));
    sendTurn
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });
    sessionExecutionRunGet.mockImplementation(async (_sessionId: string, params: { runId: string }) => ({
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

    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({ existingRunId: null }));
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({ existingRunId: null, resumeHandle: null }));
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
      code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE',
    });

    expect(start).not.toHaveBeenCalled();
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
      code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE',
    });

    expect(start).not.toHaveBeenCalled();
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
      message: 'Target machine daemon is offline. Start or reconnect the daemon before starting local voice.',
      code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    });

    expect(start).not.toHaveBeenCalled();
  });

  it('fails fast when a global hidden voice binding points at a target flavor without local control support', async () => {
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

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      message: 'Target session provider does not support local voice control.',
      code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
    });

    expect(start).not.toHaveBeenCalled();
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

    expect(start).toHaveBeenCalled();
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
	    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_old' };
	    start.mockResolvedValueOnce({ voiceAgentId: 'run_new' });
		    modalConfirm
		      .mockResolvedValueOnce(true)
		      .mockResolvedValueOnce(true);
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

    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: '/new/.happier/voice-agent',
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice_new',
      replay: expect.objectContaining({
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
      }),
    }));
    expect(state.settings.voice.executionMachine.autoMachineId).toBe('m_new');
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
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_old' };
    start
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ voiceAgentId: 'run_new' });
    modalConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
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
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: '/new/.happier/voice-agent',
    }));
    expect(state.settings.voice.executionMachine.autoMachineId).toBe('m_new');
  });

});

describe('retained global Voice Run authority', () => {
  it('reattaches the retained global Run without stopping it and reads its policy through real RPC', async () => {
    // This changed authority case uses real owners; untouched family mocks remain P2.
    const internalModules = [
      '@/voice/agent/daemonVoiceAgentClient', '@/voice/context/buildVoiceInitialContext',
      '@/voice/agent/resolveDaemonVoiceAgentModels', '@/voice/agent/ensureVoiceAgentInstallablesBackground',
      '@/sync/ops/sessionExecutionRuns', '@/sync/domains/features/featureDecisionInputs',
      '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', '@/modal',
    ] as const;
    const incumbentMocks = await Promise.all(internalModules.map(async (id) => [id, await vi.importMock(id)] as const));
    for (const id of internalModules) vi.doUnmock(id);
    vi.resetModules();
    let harness: Awaited<ReturnType<typeof import('@/dev/testkit/harness/standaloneVoicePolicyHarness')['createStandaloneVoicePolicyHarness']>> | undefined;
    try {
      const { ExecutionRunPublicStateSchema, buildVoiceAgentRunMetadataV1, parseVoiceAgentRunMetadataV1 } = await import('@happier-dev/protocol');
      const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
      const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
      const { createStandaloneVoicePolicyHarness } = await import('@/dev/testkit/harness/standaloneVoicePolicyHarness');
      const retainedPolicy = { assistantLanguage: 'de-DE', welcome: { enabled: true, mode: 'on_first_turn' as const } };
      const retainedRun = ExecutionRunPublicStateSchema.parse(buildExecutionRunPublicState({ runId: 'run_legacy',
        transcript: { persistenceMode: 'persistent', epoch: 1 }, voicePolicy: retainedPolicy,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, providerSessionId: 'vs_legacy' },
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
        existingSession: { id: 'sys_voice', active: true, metadata: { path: '/voice', host: 'voice.test', flavor: 'claude',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true }, voiceAgentRunV1: metadata,
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
      for (const [id, module] of incumbentMocks) vi.doMock(id, () => module);
      vi.resetModules();
    }
  });
});
