import { beforeEach, describe, expect, it, vi } from 'vitest';

const forkSessionOpMock = vi.hoisted(() => vi.fn());
const openSessionForVoiceToolMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessions', () => ({
  forkSession: forkSessionOpMock,
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
  openSessionForVoiceTool: openSessionForVoiceToolMock,
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

vi.mock('@/voice/tools/actionImpl/workspacesListRecent', () => ({
  listRecentWorkspacesForVoiceTool: vi.fn(),
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

const storageGetStateMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: storageGetStateMock,
  },
}));

describe('createDefaultActionExecutor (session.fork)', () => {
  beforeEach(() => {
    forkSessionOpMock.mockReset();
    openSessionForVoiceToolMock.mockReset();
    storageGetStateMock.mockReset();
  });

  it('passes replaySummaryRunner when session replay strategy is summary_plus_recent and a runner is configured', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });
    openSessionForVoiceToolMock.mockResolvedValueOnce({});

    const runner = { v: 1, backendId: 'claude', modelId: 'default', permissionMode: 'no_tools' } as const;
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

    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
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

    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
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
});
