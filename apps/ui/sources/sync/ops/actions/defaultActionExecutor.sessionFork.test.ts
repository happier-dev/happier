import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultActionExecutor } from './defaultActionExecutor';

const forkSessionOpMock = vi.hoisted(() => vi.fn());
const rollbackSessionConversationOpMock = vi.hoisted(() => vi.fn());
const startSessionHandoffOpMock = vi.hoisted(() => vi.fn());
const openSessionForVoiceToolMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessions', () => ({
  forkSession: forkSessionOpMock,
  rollbackSessionConversation: rollbackSessionConversationOpMock,
}));

vi.mock('@/sync/ops/sessionHandoffs', () => ({
  completeSessionHandoff: startSessionHandoffOpMock,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: readMachineTargetForSessionMock,
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
  openSessionForVoiceTool: openSessionForVoiceToolMock,
}));

vi.mock('@/voice/tools/actionImpl/spawnSession', () => ({
  spawnSessionForVoiceTool: vi.fn(),
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

vi.mock('@/sync/acp/sessionModeControl', () => ({
  computeSessionModePickerControl: vi.fn(() => null),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: vi.fn(),
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
    createArtifactWithHeader: vi.fn(),
    fetchArtifactWithBody: vi.fn(),
    updateArtifactWithHeader: vi.fn(),
  },
}));

const storageGetStateMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: storageGetStateMock,
  },
}));

describe('createDefaultActionExecutor (session.fork)', () => {
  beforeEach(() => {
    forkSessionOpMock.mockReset();
    rollbackSessionConversationOpMock.mockReset();
    startSessionHandoffOpMock.mockReset();
    openSessionForVoiceToolMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    storageGetStateMock.mockReset();
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
      settings: {},
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
        sessionReplayStrategy: 'summary_plus_recent',
        sessionReplaySummaryRunnerV1: runner,
        sessionReplayMaxSeedChars: 54_321,
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
      settings: {},
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
      settings: {},
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

  it('delegates session handoff to the session handoff op with the current machine id', async () => {
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
      settings: {},
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.handoff' as any,
      { sessionId: 'sess_parent', targetMachineId: 'machine_2' },
      { surface: 'ui_button', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(startSessionHandoffOpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_parent',
      sourceMachineId: 'machine_1',
      targetMachineId: 'machine_2',
      sessionStorageMode: 'persisted',
      sourceMetadata: {
        machineId: 'machine_1',
      },
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
      settings: {},
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
      sourceMetadata: {
        machineId: 'machine_stale',
      },
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
      settings: {},
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
      settings: {},
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
      settings: {},
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
