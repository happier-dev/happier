import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const start = vi.fn(async (params?: any) => ({ voiceAgentId: params?.existingRunId ?? 'run_1' }));
const sendTurn = vi.fn(async () => ({ assistantText: 'ok', actions: [] }));
const commit = vi.fn(async () => ({ commitText: 'commit' }));
const welcome = vi.fn(async () => ({ assistantText: '' }));
const refreshSessions = vi.fn(async () => {});
const spawnSession = vi.fn<(opts: unknown) => Promise<{ type: 'success'; sessionId: string }>>(async (_opts: unknown) => ({
  type: 'success' as const,
  sessionId: 'sys_voice_new',
}));
const modalConfirm = vi.fn<(title?: unknown, message?: unknown, options?: unknown) => Promise<boolean>>(async (
  _title: unknown,
  _message?: unknown,
  _options?: unknown,
) => false);
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

vi.mock('@/voice/agent/openaiCompatVoiceAgentClient', () => ({
  OpenAiCompatVoiceAgentClient: class {},
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

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          streaming: { enabled: false },
          agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 1 } },
          networkTimeoutMs: 15_000,
        },
      },
    },
  },
  sessions: {
    sys_voice: {
      id: 'sys_voice',
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    },
    s1: { id: 's1', updatedAt: 1, active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
  },
  machines: {},
  machineListByServerId: {},
  sessionMessages: {},
};

installVoiceAgentCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: (title?: unknown, message?: unknown, options?: unknown) => modalConfirm(title, message, options),
        alert: vi.fn(),
      },
    }).module;
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      },
    });
  },
});

state.applySettingsLocal = (delta: any) => {
  if (delta?.voice) {
    state.settings.voice = delta.voice;
  }
};

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (opts: unknown) => spawnSession(opts),
}));

// sessionExecutionRunGet is a protocol boundary; keep the mock flexible as the run schema evolves.
const sessionExecutionRunGet = vi.fn(async (..._args: any[]): Promise<any> => ({
  run: {
    runId: 'run_1',
    backendId: 'claude',
    transcript: { persistenceMode: 'persistent', epoch: 1 },
    resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
  },
}));
const sessionExecutionRunList = vi.fn(async (..._args: any[]): Promise<any> => ({
  runs: [],
}));
const sessionExecutionRunStop = vi.fn(async (..._args: any[]): Promise<any> => ({
  ok: true,
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunGet,
  sessionExecutionRunList,
  sessionExecutionRunStop,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
  isRuntimeFeatureEnabled: async (args: any) => (await resolveRuntimeFeatureDecision(args)).state === 'enabled',
}));

const patchSessionMetadataWithRetry = vi.fn<(sessionId: string, updater: (m: any) => any) => Promise<void>>(async (sessionId: string, updater: (m: any) => any) => {
  state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
});
const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: { forceRefresh?: boolean }) => {});
const refreshSessionMessages = vi.fn(async (_sessionId: string) => {});
const onSessionVisible = vi.fn((_sessionId: string) => {});
const refreshMachinesThrottled = vi.fn(async (_params?: { staleMs?: number; force?: boolean }) => {});

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
    ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { forceRefresh?: boolean }) =>
      ensureSessionVisibleForMessageRoute(sessionId, options),
    refreshSessionMessages: (sessionId: string) => refreshSessionMessages(sessionId),
    refreshSessions: () => refreshSessions(),
    refreshMachinesThrottled: (params?: { staleMs?: number; force?: boolean }) => refreshMachinesThrottled(params),
    onSessionVisible: (sessionId: string) => onSessionVisible(sessionId),
  },
}));

async function loadVoiceAgentPersistenceHarness() {
  const [{ useVoiceTargetStore }, { VOICE_AGENT_GLOBAL_SESSION_ID }, { createVoiceAgentSessionController }, { voiceSessionBindingStore }] = await Promise.all([
    import('@/voice/runtime/voiceTargetStore'),
    import('@/voice/agent/voiceAgentGlobalSessionId'),
    import('./VoiceAgentSessionController'),
    import('@/voice/sessionBinding/voiceSessionBindingStore'),
  ]);

  useVoiceTargetStore.setState({
    scope: 'global',
    primaryActionSessionId: 's1',
    trackedSessionIds: [],
    lastFocusedSessionId: null,
  } as any);

  return {
    VOICE_AGENT_GLOBAL_SESSION_ID,
    createVoiceAgentSessionController,
    voiceSessionBindingStore,
  };
}

describe('VoiceAgentSessionController (persistence)', () => {
  beforeEach(() => {
    vi.resetModules();
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
    patchSessionMetadataWithRetry.mockClear();
    ensureSessionVisibleForMessageRoute.mockReset();
    refreshSessionMessages.mockReset();
    refreshSessions.mockReset();
    refreshMachinesThrottled.mockReset();
    refreshMachinesThrottled.mockImplementation(async () => {});
    spawnSession.mockReset();
    spawnSession.mockImplementation(async () => ({ type: 'success', sessionId: 'sys_voice_new' }));
    modalConfirm.mockReset();
    modalConfirm.mockImplementation(async () => false);
    ensureVoiceAgentInstallablesBackground.mockReset();
    ensureVoiceAgentInstallablesBackground.mockImplementation(async () => {});
    onSessionVisible.mockReset();
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

    state.sessions.sys_voice.active = true;
    state.sessions.sys_voice.presence = 'online';
    state.sessions.sys_voice.metadata = { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } };
    state.settings.voice.adapters.local_conversation.streaming.enabled = false;
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };
    state.settings.voice.adapters.local_conversation.agent.resumabilityMode = 'replay';
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = 'auto';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = null;
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = null;
    delete state.sessions.s2;
    delete state.sessions.active_voice;
    delete state.sessions.sys_voice_new;
    state.machines = {};
    state.machineListByServerId = {};
    state.sessionMessages = {};
  });

  it('persists runId and resumeHandle into carrier session metadata when transcript persistence is enabled', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_1' }),
    });
  });

  it('prefers an active hidden voice conversation session over a newer inactive one for the global daemon anchor', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
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

    const controller = createVoiceAgentSessionController();

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

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_1' }),
    });
  });

  it('restarts a legacy global daemon voice run when persisted metadata predates the hidden transcript contract', async () => {
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_legacy',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_legacy' },
      updatedAtMs: 1,
    };
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run_legacy',
          intent: 'voice_agent',
          status: 'running',
          backendId: 'claude',
          startedAtMs: 1,
        },
      ],
    });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: {
        runId: 'run_legacy',
        backendId: 'claude',
        transcript: { persistenceMode: 'ephemeral', epoch: 1 },
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_legacy' },
      },
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('sys_voice', { runId: 'run_legacy' });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
      }),
    );
  });

  it('persists session-scoped daemon run metadata so the run can be reattached after controller recreation', async () => {
    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceAgentSessionController();
    await firstController.sendTurn('s1', 'hello');

    expect(state.sessions.s1.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_1' }),
    });

    start.mockClear();
    sendTurn.mockClear();
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run_1',
          intent: 'voice_agent',
          status: 'running',
          backendId: 'claude',
          startedAtMs: 10,
        },
      ],
    });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: {
        runId: 'run_1',
        backendId: 'claude',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
      },
    });

    const secondController = createVoiceAgentSessionController();
    await secondController.sendTurn('s1', 'hello again');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        existingRunId: 'run_1',
      }),
    );
  });

  it('stops and clears a persisted session-scoped daemon run even after controller recreation', async () => {
    state.sessions.s1.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.stop('s1');

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' });
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toBeNull();
  });

  it('stops all matching persisted daemon voice runs for a session so stale running runs are not reattached on restart', async () => {
    state.sessions.s1.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
    };
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run_prev',
          intent: 'voice_agent',
          status: 'running',
          backendId: 'claude',
          startedAtMs: 20,
        },
        {
          runId: 'run_stale',
          intent: 'voice_agent',
          status: 'running',
          backendId: 'claude',
          startedAtMs: 10,
        },
        {
          runId: 'run_other_backend',
          intent: 'voice_agent',
          status: 'running',
          backendId: 'codex',
          startedAtMs: 30,
        },
      ],
    });

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.stop('s1');

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' });
    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_stale' });
    expect(sessionExecutionRunStop).not.toHaveBeenCalledWith('s1', { runId: 'run_other_backend' });
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toBeNull();
  });

  it('reconciles duplicate running session-scoped voice runs by reattaching the newest match and stopping the extras', async () => {
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run_old',
          callId: 'call_old',
          sidechainId: 'side_old',
          intent: 'voice_agent',
          backendId: 'claude',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'streaming',
          status: 'running',
          startedAtMs: 10,
        },
        {
          runId: 'run_new',
          callId: 'call_new',
          sidechainId: 'side_new',
          intent: 'voice_agent',
          backendId: 'claude',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'streaming',
          status: 'running',
          startedAtMs: 20,
        },
      ],
    });
    sessionExecutionRunGet
      .mockResolvedValueOnce({
        run: {
          runId: 'run_new',
          backendId: 'claude',
          resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_new' },
        },
      })
      .mockResolvedValueOnce({
        run: {
          runId: 'run_new',
          backendId: 'claude',
          resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_new' },
        },
      });

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn('s1', 'hello');

    expect(sessionExecutionRunList).toHaveBeenCalledWith('s1', {});
    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_old' });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        existingRunId: 'run_new',
      }),
    );
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_new',
      resumeHandle: expect.objectContaining({ vendorSessionId: 'vs_new' }),
    });
  });

  it('reuses persisted runId for ephemeral global voice sessions after controller recreation', async () => {
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceAgentSessionController();
    await firstController.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    start.mockClear();
    sendTurn.mockClear();

    const secondController = createVoiceAgentSessionController();
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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    start.mockRejectedValueOnce(Object.assign(new Error('Not running'), { rpcErrorCode: 'execution_run_not_allowed' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sessionExecutionRunGet
      .mockResolvedValueOnce({
        run: {
          runId: 'run_prev',
          backendId: 'claude',
          transcript: { persistenceMode: 'persistent', epoch: 1 },
          resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
        },
      })
      .mockResolvedValueOnce({
        run: {
          runId: 'run_2',
          backendId: 'claude',
          transcript: { persistenceMode: 'persistent', epoch: 1 },
          resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_2' },
        },
      });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    start.mockResolvedValueOnce({ voiceAgentId: 'run_2' });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: {
        runId: 'run_2',
        backendId: 'claude',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_2' },
      },
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_2',
    });
  });

  it('provider-resume mode starts a new run with resumeHandle when the previous runId is not found', async () => {
    state.settings.voice.adapters.local_conversation.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    start.mockRejectedValueOnce(Object.assign(new Error('Not found'), { rpcErrorCode: 'execution_run_not_found' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_3' });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: null,
        resumeWhenInactive: true,
        resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_prev' }),
      }),
    );
  });

  it('retries when daemon sendTurn fails with the plain Voice agent not found message', async () => {
    sendTurn
      .mockRejectedValueOnce(new Error('Voice agent not found'))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it('clears a stale cached handle when immediate welcome fails with the plain Voice agent not found message', async () => {
    state.settings.voice.adapters.local_conversation.agent.welcome = {
      enabled: true,
      mode: 'immediate',
      templateId: null,
    };
    welcome.mockRejectedValueOnce(new Error('Voice agent not found'));
    sendTurn.mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await expect(controller.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();
    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
      actions: [],
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(welcome).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it('treats the hidden global voice conversation session as resumable and retries it with resumeHandle when the persisted run is not resumable anymore', async () => {
    state.settings.voice.adapters.local_conversation.agent.resumabilityMode = 'provider_resume';
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_prev' },
      updatedAtMs: 1,
      transcriptContractVersion: 2,
    };

    start.mockRejectedValueOnce(Object.assign(new Error('Not resumable'), { rpcErrorCode: 'execution_run_not_allowed' }));
    start.mockResolvedValueOnce({ voiceAgentId: 'run_4' });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: {
        runId: 'run_4',
        backendId: 'claude',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_4' },
      },
    });

    const { createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
        resumeHandle: expect.objectContaining({ kind: 'vendor_session.v1', vendorSessionId: 'vs_prev' }),
      }),
    );
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_4',
      resumeHandle: expect.objectContaining({ vendorSessionId: 'vs_4' }),
    });
  });

  it('persists an updated resumeHandle into carrier metadata after commit (e.g. commit session ids)', async () => {
    sessionExecutionRunGet.mockImplementation(async () => ({
      run: commit.mock.calls.length === 0
        ? {
            runId: 'run_1',
            backendId: 'claude',
            resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
          }
        : {
            runId: 'run_1',
            backendId: 'claude',
            resumeHandle: {
              kind: 'voice_agent_sessions.v1',
              backendId: 'claude',
              chatVendorSessionId: 'vs_1',
              commitVendorSessionId: 'vs_commit',
            },
          },
    }));

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1?.resumeHandle?.kind).toBe('vendor_session.v1');

    await controller.commit(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(sessionExecutionRunGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({
        kind: 'voice_agent_sessions.v1',
        commitVendorSessionId: 'vs_commit',
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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

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
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_stale' },
      updatedAtMs: 1,
    };
    start.mockImplementation(async (params?: any) => ({ voiceAgentId: params?.existingRunId ?? 'run_fresh' }));
    sendTurn
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ assistantText: 'recovered', actions: [] });
    sessionExecutionRunGet.mockImplementation(async (_sessionId: string, params: { runId: string }) => ({
      run: {
        runId: params.runId,
        backendId: 'claude',
        transcript: { persistenceMode: 'persistent', epoch: 1 },
        resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: `vs_${params.runId}` },
      },
    }));

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).resolves.toMatchObject({
      assistantText: 'recovered',
    });

    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({ existingRunId: null }));
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({ existingRunId: null, resumeHandle: null }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_fresh',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ vendorSessionId: 'vs_run_fresh' }),
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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's_inactive',
      updatedAt: 1,
    });
    const controller = createVoiceAgentSessionController();

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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's_offline',
      updatedAt: 1,
    });
    const controller = createVoiceAgentSessionController();

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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's_machine_offline',
      updatedAt: 1,
    });
    const controller = createVoiceAgentSessionController();

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

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController, voiceSessionBindingStore } =
      await loadVoiceAgentPersistenceHarness();
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's_kimi',
      updatedAt: 1,
    });
    const controller = createVoiceAgentSessionController();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      message: 'Target session provider does not support local voice control.',
      code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED',
    });

    expect(start).not.toHaveBeenCalled();
  });

  it('switches away from a sticky global voice machine when the reused hidden voice session returns daemon RPC unavailable', async () => {
    state.sessions.sys_voice = {
      id: 'sys_voice',
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        machineId: 'm_old',
        path: '/old/.happier/voice-agent',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
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
      'server-a': Object.values(state.machines),
    };
    state.settings.recentMachinePaths = [];
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = 'auto';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = null;
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'm_old';
    start
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ voiceAgentId: 'run_new' });
    modalConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_new = {
        id: 'sys_voice_new',
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
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello after switch');

    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sys_voice',
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: '/new/.happier/voice-agent',
    }));
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sys_voice_new',
      replay: expect.objectContaining({
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
      }),
    }));
    expect(state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId).toBe('m_new');
  });

  it('refreshes machines before prompting to switch away from a stale sticky global voice machine', async () => {
    state.sessions.sys_voice = {
      id: 'sys_voice',
      updatedAt: 10,
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: {
        flavor: 'claude',
        machineId: 'm_old',
        path: '/old/.happier/voice-agent',
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
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
        active: false,
        activeAt: 0,
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
      'server-a': [state.machines.m_old],
    };
    state.settings.voice.adapters.local_conversation.agent.machineTargetMode = 'auto';
    state.settings.voice.adapters.local_conversation.agent.machineTargetId = null;
    state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId = 'm_old';
    modalConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    refreshMachinesThrottled.mockImplementation(async () => {
      state.machineListByServerId['server-a'] = [state.machines.m_old, state.machines.m_new];
    });
    refreshSessions.mockImplementation(async () => {
      state.sessions.sys_voice_new = {
        id: 'sys_voice_new',
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
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceAgentSessionController } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceAgentSessionController();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello after refresh');

    expect(refreshMachinesThrottled).toHaveBeenCalledWith({ force: true });
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: '/new/.happier/voice-agent',
    }));
    expect(state.settings.voice.adapters.local_conversation.agent.autoTargetMachineId).toBe('m_new');
  });

});
