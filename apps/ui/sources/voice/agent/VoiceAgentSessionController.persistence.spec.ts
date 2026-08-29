import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';

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
    backendTarget: { kind: 'backend', backendId: 'claude' },
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
      serverId: 'server-a',
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
      serverId: 'server-a',
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
      'server-a': [
        { type: 'session', sessionId: 'sys_voice', serverId: 'server-a', serverName: null },
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: null },
      ],
    },
    sessionListRenderables: {
      sys_voice: sessions.sys_voice,
      s1: sessions.s1,
    },
    sessions,
    machines: {},
    machineListByServerId: {},
    sessionMessages: {},
  };
};

let state: any = createVoiceAgentPersistenceTestState();

const applySettingsLocal = (delta: any) => {
  if (delta?.voice) {
    state = {
      ...state,
      settings: {
        ...state.settings,
        voice: delta.voice,
      },
    };
  }
};

installVoiceAgentCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: (title?: unknown, message?: unknown, options?: unknown) => modalConfirm(title, message, options),
        alert: modalAlert,
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

state.applySettingsLocal = applySettingsLocal;

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'http://localhost', generation: 1 }),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (opts: unknown) => spawnSession(opts),
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
  sessionExecutionRunGet,
  sessionExecutionRunList,
  sessionExecutionRunStop,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
  isRuntimeFeatureEnabled: async (args: any) => (await resolveRuntimeFeatureDecision(args)).state === 'enabled',
}));

const patchSessionMetadataWithRetry = vi.fn<(sessionId: string, updater: (m: any) => any) => Promise<void>>(async (sessionId: string, updater: (m: any) => any) => {
  const existing = state.sessions?.[sessionId];
  if (!existing) return;
  const nextMetadata = updater(existing.metadata);

  state = {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...existing,
        metadata: nextMetadata,
      },
    },
    sessionListRenderables: {
      ...(state.sessionListRenderables ?? {}),
      [sessionId]: {
        ...(state.sessionListRenderables?.[sessionId] ?? existing),
        metadata: nextMetadata,
      },
    },
  };
});
const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, _options?: { forceRefresh?: boolean }) => {});
const refreshSessionMessages = vi.fn(async (_sessionId: string) => {});
const onSessionVisible = vi.fn((_sessionId: string) => {});
const refreshMachinesThrottled = vi.fn(async (_params?: { staleMs?: number; force?: boolean }) => {});

// `persistVoiceAutoTargetMachineId` reaches the sync singleton through its own
// lazy accessor, a bundler-only `require` that never sees the `@/sync/sync`
// mock below. Mock the accessor that owns it, as `voiceCarrierSession.test.ts` does.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({
    applySettings: (delta: any) => applySettingsLocal(delta),
    refreshSessions: () => refreshSessions(),
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  }),
}));

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
  const [{ useVoiceTargetStore }, { VOICE_AGENT_GLOBAL_SESSION_ID }, { createVoiceExecutionTransport }, { voiceSessionBindingStore }] = await Promise.all([
    import('@/voice/runtime/voiceTargetStore'),
    import('@/voice/agent/voiceAgentGlobalSessionId'),
    import('@/voice/runtime/execution/VoiceExecutionTransport'),
    import('@/voice/binding/voiceConversationBindingStore'),
  ]);

  useVoiceTargetStore.setState({
    scope: 'global',
    primaryActionSessionId: 's1',
    trackedSessionIds: [],
    lastFocusedSessionId: null,
  } as any);

  return {
    VOICE_AGENT_GLOBAL_SESSION_ID,
    createVoiceExecutionTransport,
    voiceSessionBindingStore,
  };
}

describe('VoiceExecutionTransport (persistence)', () => {
  beforeEach(() => {
    vi.useRealTimers();
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

    state = createVoiceAgentPersistenceTestState();
    state.applySettingsLocal = applySettingsLocal;

    state.settings.voice.providers.local_conversation.config.agent.resumabilityMode = 'replay';
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: null };
  });

  it('persists runId and resumeHandle into carrier session metadata when transcript persistence is enabled', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: expect.objectContaining({ kind: 'provider_session.v1', providerSessionId: 'vs_1' }),
      transcriptContractVersion: 2,
    });
  });

  it('prefers an active hidden voice conversation session over a newer inactive one for the global daemon anchor', async () => {
    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
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

    expect(sessionExecutionRunGet).toHaveBeenCalledWith('sys_voice', expect.objectContaining({ runId: 'run_1' }));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
    sessionExecutionRunList.mockResolvedValueOnce({
      runs: [
        buildExecutionRunPublicState({
          runId: 'run_legacy',
          startedAtMs: 1,
        }),
      ],
    });
    sessionExecutionRunGet.mockResolvedValueOnce({
      run: buildExecutionRunPublicState({
        runId: 'run_legacy',
        transcript: { persistenceMode: 'ephemeral', epoch: 1 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'vs_legacy',
        },
      }),
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(sessionExecutionRunStop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        existingRunId: 'run_legacy',
      }),
    );
  });

  it('persists session-scoped daemon run metadata so the run can be reattached after controller recreation', async () => {
    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await firstController.sendTurn('s1', 'hello');

    expect(state.sessions.s1.metadata.voiceAgentRunV1).toMatchObject({
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
    await secondController.sendTurn('s1', 'hello again');

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        existingRunId: 'run_1',
      }),
    );
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toMatchObject({
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

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' });
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toBeNull();
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
          backendTarget: { kind: 'backend', backendId: 'codex' },
          startedAtMs: 30,
        }),
      ],
    });

    const { createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.stop('s1');

    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_prev' });
    expect(sessionExecutionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_stale' });
    expect(sessionExecutionRunStop).not.toHaveBeenCalledWith('s1', { runId: 'run_other_backend' });
    expect(state.sessions.s1.metadata.voiceAgentRunV1).toBeNull();
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
      resumeHandle: expect.objectContaining({ providerSessionId: 'vs_new' }),
    });
  });

  it('reuses persisted runId for ephemeral global voice sessions after controller recreation', async () => {
    state.settings.voice.providers.local_conversation.config.agent.transcript = { persistenceMode: 'ephemeral', epoch: 1 };

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();

    const firstController = createVoiceExecutionTransport();
    await firstController.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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

    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      transcriptContractVersion: 2,
      welcomedEpoch: 1,
    });
    expect(welcome).toHaveBeenCalledTimes(1);

    const secondController = createVoiceExecutionTransport();
    await expect(secondController.ensureRunningAndMaybeWelcome(VOICE_AGENT_GLOBAL_SESSION_ID)).resolves.toBeNull();

    expect(welcome).toHaveBeenCalledTimes(1);
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1?.resumeHandle?.kind).toBe('provider_session.v1');

    await controller.commit(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(sessionExecutionRunGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
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
      transcriptMode: 'native_session',
      targetSessionId: 's_inactive',
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
      transcriptMode: 'native_session',
      targetSessionId: 's_offline',
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
      transcriptMode: 'native_session',
      targetSessionId: 's_machine_offline',
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
      transcriptMode: 'native_session',
      targetSessionId: 's_kimi',
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
      presence: 'offline',
      modelMode: 'default',
      metadata: {
        flavor: 'kimi',
        machineId: 'm_raw',
      },
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-a': [
        ...(state.sessionListIndexByServerId?.['server-a'] ?? []),
        { type: 'session', sessionId: 's_cached_target', serverId: 'server-a', serverName: null },
      ],
    };
    state.sessionListRenderables = {
      ...(state.sessionListRenderables ?? {}),
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
      transcriptMode: 'native_session',
      targetSessionId: 's_cached_target',
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
      serverId: 'server-a',
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
      sessionListRenderables: {
        ...(state.sessionListRenderables ?? {}),
        sys_voice: nextSysVoice,
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
	    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_old' };
	    start.mockResolvedValueOnce({ voiceAgentId: 'run_new' });
		    modalConfirm
		      .mockResolvedValueOnce(true)
		      .mockResolvedValueOnce(true);
    refreshSessions.mockImplementation(async () => {
      const sysVoiceNew = {
        id: 'sys_voice_new',
        serverId: 'server-a',
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
          'server-a': [
            ...(state.sessionListIndexByServerId?.['server-a'] ?? []),
            { type: 'session', sessionId: 'sys_voice_new', serverId: 'server-a', serverName: null },
          ],
        },
        sessionListRenderables: {
          ...(state.sessionListRenderables ?? {}),
          sys_voice_new: sysVoiceNew,
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
      serverId: 'server-a',
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
      sessionListRenderables: {
        ...(state.sessionListRenderables ?? {}),
        sys_voice: nextSysVoice,
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
      'server-a': [state.machines.m_old],
      'active-server': [state.machines.m_old],
    };
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'm_old' };
    start
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }))
      .mockResolvedValueOnce({ voiceAgentId: 'run_new' });
    modalConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    refreshMachinesThrottled.mockImplementation(async () => {
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
          'server-a': [nextMachines.m_old, nextMachines.m_new],
          'active-server': [nextMachines.m_old, nextMachines.m_new],
        },
      };
    });
    refreshSessions.mockImplementation(async () => {
      const sysVoiceNew = {
        id: 'sys_voice_new',
        serverId: 'server-a',
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
          'server-a': [
            ...(state.sessionListIndexByServerId?.['server-a'] ?? []),
            { type: 'session', sessionId: 'sys_voice_new', serverId: 'server-a', serverName: null },
          ],
        },
        sessionListRenderables: {
          ...(state.sessionListRenderables ?? {}),
          sys_voice_new: sysVoiceNew,
        },
      };
    });

    const { VOICE_AGENT_GLOBAL_SESSION_ID, createVoiceExecutionTransport } = await loadVoiceAgentPersistenceHarness();
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello after refresh');

    expect(refreshMachinesThrottled).toHaveBeenCalledWith({ force: true });
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_new',
      directory: '/new/.happier/voice-agent',
    }));
    expect(state.settings.voice.executionMachine.autoMachineId).toBe('m_new');
  });

});
