import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultActionExecutor } from './defaultActionExecutor';

const forkSessionOpMock = vi.hoisted(() => vi.fn());
const rollbackSessionConversationOpMock = vi.hoisted(() => vi.fn());
const startSessionHandoffOpMock = vi.hoisted(() => vi.fn());
const openSessionForVoiceToolMock = vi.hoisted(() => vi.fn());
const spawnSessionForVoiceToolMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessions', () => ({
  forkSession: forkSessionOpMock,
  rollbackSessionConversation: rollbackSessionConversationOpMock,
  sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/ops/sessionHandoffs', () => ({
  completeSessionHandoff: startSessionHandoffOpMock,
}));

vi.mock('@/sync/ops/delegatedSessionHandoff', () => ({
  delegateSessionHandoffToSourceDaemon: startSessionHandoffOpMock,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: readMachineTargetForSessionMock,
  readMachineControlTargetForSession: readMachineTargetForSessionMock,
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
  openSessionForVoiceTool: openSessionForVoiceToolMock,
}));

vi.mock('@/voice/tools/actionImpl/spawnSession', () => ({
  spawnSessionForVoiceTool: spawnSessionForVoiceToolMock,
}));

vi.mock('@/voice/tools/actionImpl/spawnSessionPicker', () => ({
  spawnSessionWithPickerForVoiceTool: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
  sendSessionMessageWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
  computeSessionModePickerControl: vi.fn(() => null),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    serverID: 'account-1',
    patchSessionMetadataWithRetry: vi.fn(),
    acquireUserRequestLease: () => () => {},
  },
}));

vi.mock('@/sync/engine/overrides/acpSessionModeOverridePublish', () => ({
  publishAcpSessionModeOverrideToMetadata: vi.fn(),
}));

vi.mock('@/voice/activity/voiceActivityController', () => ({
  voiceActivityController: { clearSession: vi.fn() },
}));

vi.mock('@/voice/session/voiceSession', () => ({
  voiceSessionManager: { stop: vi.fn() },
}));

vi.mock('@/voice/agent/voiceAgentGlobalSessionId', () => ({
  VOICE_AGENT_GLOBAL_SESSION_ID: 'voice_global',
}));

vi.mock('@/voice/tools/actionImpl/sessionTargets', () => ({
  setPrimaryActionSessionId: vi.fn(),
  setTrackedSessionIds: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionList', () => ({
  listSessionsForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionActivity', () => ({
  getSessionActivityForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/sessionRecentMessages', () => ({
  getSessionRecentMessagesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/pathsListRecent', () => ({
  listRecentPathsForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/machinesList', () => ({
  listMachinesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/serversList', () => ({
  listServersForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/reviewEnginesList', () => ({
  listReviewEnginesForVoiceTool: vi.fn(),
}));

vi.mock('@/voice/tools/actionImpl/agentCatalogList', () => ({
  listAgentBackendsForVoiceTool: vi.fn(),
  listAgentModelsForVoiceTool: vi.fn(),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunStart: vi.fn(),
  sessionExecutionRunList: vi.fn(),
  sessionExecutionRunGet: vi.fn(),
  sessionExecutionRunSend: vi.fn(),
  sessionExecutionRunStop: vi.fn(),
  sessionExecutionRunAction: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    serverID: 'account-1',
    createArtifactWithHeader: vi.fn(),
    fetchArtifactWithBody: vi.fn(),
    updateArtifactWithHeader: vi.fn(),
    acquireUserRequestLease: () => () => {},
  },
}));

const storageGetStateMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: storageGetStateMock,
  },
});
});

describe('createDefaultActionExecutor (session.fork)', () => {
  beforeEach(() => {
    forkSessionOpMock.mockReset();
    rollbackSessionConversationOpMock.mockReset();
    startSessionHandoffOpMock.mockReset();
    openSessionForVoiceToolMock.mockReset();
    spawnSessionForVoiceToolMock.mockReset();
    spawnSessionForVoiceToolMock.mockResolvedValue({ type: 'success', sessionId: 'sess_child' });
    readMachineTargetForSessionMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    storageGetStateMock.mockReset();
  });

  it('forwards prepared Action admission without executing before the invocation runs', async () => {
    const executor = createDefaultActionExecutor();

    const prepared = await executor.prepare(
      'session.spawn_new' as any,
      { agentId: 'claude', directory: '/repo' },
      { surface: 'ui_button' } as any,
    );

    expect(prepared.kind).toBe('ready');
    expect(spawnSessionForVoiceToolMock).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected prepared invocation');
    await prepared.invocation.run();
    expect(spawnSessionForVoiceToolMock).toHaveBeenCalledTimes(1);
  });

  it('calls the provided openSession callback after a successful fork', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    const openSession = vi.fn().mockResolvedValueOnce(undefined);

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor({ openSession });

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith('sess_child');
  }, 10_000);

  it('forwards the complete source-context action request to the canonical spawn bridge', async () => {
    const executor = createDefaultActionExecutor();
    const sourceContext = {
      v: 1,
      kind: 'session_replay',
      sourceSessionId: 'sess_source',
      forkPoint: { type: 'latest' },
    } as const;

    const result = await executor.execute(
      'session.spawn_new' as any,
      {
        agentId: 'claude',
        directory: '/repo',
        sourceContext,
      },
      { surface: 'voice_tool', actionRequestId: 'action-attempt-1' } as any,
    );

    expect(result.ok).toBe(true);
    expect(spawnSessionForVoiceToolMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      directory: '/repo',
      sourceContext,
      actionRequestId: 'action-attempt-1',
      surface: 'voice_tool',
    }));
  });

  it('passes replaySummaryRunner when session replay strategy is summary_plus_recent and a runner is configured', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    const runner = {
      v: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'default',
      permissionMode: 'no_tools',
    } as const;
    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
          },
        },
      },
      settings: {
        sessionReplayEnabled: true,
        sessionReplayStrategy: 'summary_plus_recent',
        sessionReplaySummaryRunnerV1: runner,
        sessionReplayMaxSeedChars: 54_321,
        // The summary runner is an LLM task and follows the execution-runs
        // feature, which is experimental and off by default.
        experiments: true,
        featureToggles: { 'execution.runs': true },
      },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      replaySummaryRunner: runner,
      replayMaxSeedChars: 54_321,
    }));
  }, 60_000);

  it('requests a native fork instead of falling back to Replay when the account disabled Replay', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          presence: 0,
          metadata: { machineId: 'machine_1', flavor: 'codex', codexBackendMode: 'appServer' },
        },
      },
      settings: { sessionReplayEnabled: false },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    // `auto` is what lets the daemon settle on Replay; the account turned Replay off.
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      strategy: 'native',
    }));
  }, 60_000);

  it('refuses the fork when Replay is off and this Agent has no native fork route', async () => {
    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          presence: 0,
          metadata: { machineId: 'machine_1', flavor: 'claude' },
        },
      },
      settings: { sessionReplayEnabled: false },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    // This executor envelope reports the action's own refusal in `result`.
    expect((res as any).result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(forkSessionOpMock).not.toHaveBeenCalled();
  }, 60_000);

  it('clamps an out-of-range replay seed budget to what the fork wire accepts', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          presence: 0,
          metadata: { machineId: 'machine_1' },
        },
      },
      // The stored account setting permits a wider range than the fork wire schema, so an
      // unclamped forward would be rejected as invalid rather than bounded.
      settings: { sessionReplayEnabled: true, sessionReplayMaxSeedChars: 500_000 },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      replayMaxSeedChars: 200_000,
    }));
  }, 60_000);

  it('omits the replay summary runner when the execution-runs feature is off', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          presence: 0,
          metadata: { machineId: 'machine_1' },
        },
      },
      settings: {
        sessionReplayEnabled: true,
        sessionReplayStrategy: 'summary_plus_recent',
        sessionReplaySummaryRunnerV1: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
        featureToggles: { 'execution.runs': false },
      },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    // The summary runner is an LLM task; it follows the execution-runs feature
    // exactly as it does on every other fork entry point.
    expect(forkSessionOpMock.mock.calls[0]?.[0]).not.toHaveProperty('replaySummaryRunner');
  }, 60_000);

  it('delegates session fork even when session metadata machineId is missing', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {},
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    const forkArgs = forkSessionOpMock.mock.calls[0]?.[0] as any;
    expect(forkArgs?.machineId).toBeUndefined();
    expect(forkArgs).toMatchObject({
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
    });
  });

  it('prefers the reachable machine target over stale session metadata for session fork', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_stale',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('sess_parent');
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      machineId: 'machine_rebound',
    }));
  });

  it('delegates session handoff to the source daemon with current scope and correlation', async () => {
    startSessionHandoffOpMock.mockResolvedValueOnce({
      ok: true,
      handoffId: 'handoff_1',
      status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
      endpointCandidates: [],
    });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.handoff' as any,
      {
        sessionId: 'sess_parent',
        targetMachineId: 'machine_2',
        targetPath: '/home/guest/workspace',
      },
      { surface: 'ui_button', placement: 'session_action_menu', actionRequestId: 'request-handoff-1' } as any,
    );

    expect(res.ok).toBe(true);
    expect(startSessionHandoffOpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_parent',
      accountId: 'account-1',
      sourceMachineId: 'machine_1',
      targetMachineId: 'machine_2',
      targetPath: '/home/guest/workspace',
      sessionStorageMode: 'persisted',
      requestId: 'request-handoff-1',
    }));
  });

  it('prefers the reachable machine target over stale session metadata for session handoff', async () => {
    startSessionHandoffOpMock.mockResolvedValueOnce({
      ok: true,
      handoffId: 'handoff_1',
      status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
      endpointCandidates: [],
    });
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_stale',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.handoff' as any,
      { sessionId: 'sess_parent', targetMachineId: 'machine_2' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('sess_parent');
    expect(startSessionHandoffOpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_parent',
      sourceMachineId: 'machine_rebound',
      targetMachineId: 'machine_2',
    }));
  });

  it('passes direct-to-persisted handoff options through to the handoff op', async () => {
    startSessionHandoffOpMock.mockResolvedValueOnce({
      ok: true,
      handoffId: 'handoff_2',
      status: { handoffId: 'handoff_2', status: 'completed', phase: 'finalizing', recoveryActions: [] },
    });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: false,
          activeAt: 0,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
            directSessionV1: { v: 1 },
            flavor: 'claude',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.handoff' as any,
      {
        sessionId: 'sess_parent',
        targetMachineId: 'machine_2',
        targetSessionStorageMode: 'persisted',
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(startSessionHandoffOpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_parent',
      sourceMachineId: 'machine_1',
      targetMachineId: 'machine_2',
      sessionStorageMode: 'direct',
      targetSessionStorageMode: 'persisted',
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    }));
  });

  it('delegates session rollback to the session rollback op for app-server Codex sessions', async () => {
    rollbackSessionConversationOpMock.mockResolvedValueOnce({ ok: true, rolledBack: true, target: { type: 'latest_turn' } });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
            flavor: 'codex',
            codexBackendMode: 'appServer',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const result = await executor.execute(
      'session.rollback' as any,
      { sessionId: 'sess_parent' },
      { defaultSessionId: 'sess_parent', surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(result.ok).toBe(true);
    expect(rollbackSessionConversationOpMock).toHaveBeenCalledWith({
      sessionId: 'sess_parent',
      target: { type: 'latest_turn' },
    });
  });

  it.each(['openai', 'gpt'])('enables session rollback for legacy Codex flavor aliases on app-server sessions (%s)', async (flavor) => {
    rollbackSessionConversationOpMock.mockResolvedValueOnce({ ok: true, rolledBack: true, target: { type: 'latest_turn' } });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          metadata: {
            machineId: 'machine_1',
            flavor,
            codexBackendMode: 'appServer',
          },
        },
      },
      settings: { sessionReplayEnabled: true },
    });

    const executor = createDefaultActionExecutor();

    const result = await executor.execute(
      'session.rollback' as any,
      { sessionId: 'sess_parent' },
      { defaultSessionId: 'sess_parent', surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(result.ok).toBe(true);
    expect(rollbackSessionConversationOpMock).toHaveBeenCalledWith({
      sessionId: 'sess_parent',
      target: { type: 'latest_turn' },
    });
  });
});
