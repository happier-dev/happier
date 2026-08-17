import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultActionExecutor } from './defaultActionExecutor';

const forkSessionOpMock = vi.hoisted(() => vi.fn());
const rollbackSessionConversationOpMock = vi.hoisted(() => vi.fn());
const rollbackSessionCheckpointCodeOpMock = vi.hoisted(() => vi.fn());
const startSessionHandoffOpMock = vi.hoisted(() => vi.fn());
const openSessionForVoiceToolMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const completeSessionForkNavigationMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessions', () => ({
  forkSession: forkSessionOpMock,
  rollbackSessionConversation: rollbackSessionConversationOpMock,
  rollbackSessionCheckpointCode: rollbackSessionCheckpointCodeOpMock,
  sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/ops/sessionHandoffs', () => ({
  completeSessionHandoff: startSessionHandoffOpMock,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: readMachineTargetForSessionMock,
  readMachineControlTargetForSession: readMachineTargetForSessionMock,
}));

vi.mock('@/voice/tools/actionImpl/openSession', () => ({
  openSessionForVoiceTool: openSessionForVoiceToolMock,
}));

vi.mock('@/sync/domains/sessionFork/completeSessionForkNavigation', () => ({
  completeSessionForkNavigation: (params: unknown) => completeSessionForkNavigationMock(params),
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
    patchSessionMetadataWithRetry: vi.fn(),
  },
}));

vi.mock('@/sync/state/acpSessionModeOverridePublish', () => ({
  publishAcpSessionModeOverrideToMetadata: vi.fn(),
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
  getSessionTranscriptForVoiceTool: vi.fn(),
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
    rollbackSessionCheckpointCodeOpMock.mockReset();
    startSessionHandoffOpMock.mockReset();
    openSessionForVoiceToolMock.mockReset();
    completeSessionForkNavigationMock.mockReset();
    completeSessionForkNavigationMock.mockImplementation(async (params: any) => {
      await params.navigate(
        params.childSessionId,
        params.serverId ? { serverId: params.serverId } : undefined,
      );
    });
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(completeSessionForkNavigationMock).toHaveBeenCalledWith({
      childSessionId: 'sess_child',
      parentSessionId: 'sess_parent',
      navigate: expect.any(Function),
    });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith('sess_child');
  }, 10_000);

  it('resolves the parent session server scope for fork execution and child opening', async () => {
    forkSessionOpMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess_child' });

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

    const resolveServerIdForSessionId = vi.fn((sessionId: string) => sessionId === 'sess_parent' ? 'server-b' : null);
    const executor = createDefaultActionExecutor({
      openSession,
      resolveServerIdForSessionId,
    });

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(resolveServerIdForSessionId).toHaveBeenCalledWith('sess_parent');
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      serverId: 'server-b',
    }));
    expect(completeSessionForkNavigationMock).toHaveBeenCalledWith({
      childSessionId: 'sess_child',
      parentSessionId: 'sess_parent',
      serverId: 'server-b',
      navigate: expect.any(Function),
    });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith('sess_child', { serverId: 'server-b' });
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
        sessionReplayStrategy: 'summary_plus_recent',
        sessionReplaySummaryRunnerV1: runner,
        sessionReplayMaxSeedChars: 54_321,
      },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      replaySummaryRunner: runner,
      replayMaxSeedChars: 54_321,
    }));
    expect(completeSessionForkNavigationMock).toHaveBeenCalledWith({
      childSessionId: 'sess_child',
      parentSessionId: 'sess_parent',
      navigate: expect.any(Function),
    });
    expect(openSessionForVoiceToolMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_child',
    }));
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
      settings: { sessionReplayMaxSeedChars: 500_000 },
    });

    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'session.fork' as any,
      { sessionId: 'sess_parent' },
      { surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(res.ok).toBe(true);
    expect(forkSessionOpMock).toHaveBeenCalledWith(expect.objectContaining({
      replayMaxSeedChars: 200_000,
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
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
            directSessionV1: {
              v: 1,
              providerId: 'claude',
              machineId: 'machine_1',
              remoteSessionId: 'claude_session_1',
              source: {
                kind: 'claudeConfig',
                configDir: '/Users/tester/.claude',
              },
            },
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
      { surface: 'ui', placement: 'session_action_menu' } as any,
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
      { defaultSessionId: 'sess_parent', surface: 'ui', placement: 'session_action_menu' } as any,
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
      { defaultSessionId: 'sess_parent', surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(result.ok).toBe(true);
    expect(rollbackSessionConversationOpMock).toHaveBeenCalledWith({
      sessionId: 'sess_parent',
      target: { type: 'latest_turn' },
    });
  });

  it.each([
    ['Codex app-server', { flavor: 'codex', codexBackendMode: 'appServer' }],
    ['Grok', { flavor: 'grok' }],
  ])('delegates inactive %s rollback to a trusted completed turn start', async (_provider, metadata) => {
    rollbackSessionConversationOpMock.mockResolvedValueOnce({
      ok: true,
      rolledBack: true,
      target: { type: 'before_user_message', userMessageSeq: 3 },
    });

    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 4,
          createdAt: 1,
          updatedAt: 4,
          active: false,
          activeAt: 4,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          rollbackEligibleTurnStarts: [3],
          sessionTurns: {
            v: 1,
            sessionId: 'sess_parent',
            latestTurnId: 'turn_2',
            updatedAt: 4,
            turns: [{
              turnId: 'turn_2',
              status: 'completed',
              startedAt: 3,
              updatedAt: 4,
              terminalAt: 4,
              transcriptAnchors: {
                startUserMessageSeq: 3,
                userMessageSeqs: [3],
                startSeqInclusive: 3,
                endSeqInclusive: 4,
              },
              rollback: { state: 'eligible', updatedAt: 4 },
            }],
          },
          metadata: {
            machineId: 'machine_1',
            ...metadata,
          },
        },
      },
      settings: {},
    });

    const executor = createDefaultActionExecutor();

    const result = await executor.execute(
      'session.rollback' as any,
      {
        sessionId: 'sess_parent',
        target: { type: 'before_user_message', userMessageSeq: 3 },
      },
      { defaultSessionId: 'sess_parent', surface: 'ui' } as any,
    );

    expect(result.ok).toBe(true);
    expect(rollbackSessionConversationOpMock).toHaveBeenCalledWith({
      sessionId: 'sess_parent',
      target: { type: 'before_user_message', userMessageSeq: 3 },
    });
  });

  it.each([
    [
      'inactive latest-turn rollback',
      { active: false, metadata: { flavor: 'codex', codexBackendMode: 'appServer' }, rollbackEligibleTurnStarts: [3] },
      { type: 'latest_turn' },
    ],
    [
      'an untrusted pending turn start',
      { active: false, metadata: { flavor: 'grok' }, rollbackEligibleTurnStarts: [3] },
      { type: 'before_user_message', userMessageSeq: 5 },
    ],
    [
      'a view-only trusted turn start',
      { active: false, accessLevel: 'view', metadata: { flavor: 'grok' }, rollbackEligibleTurnStarts: [3] },
      { type: 'before_user_message', userMessageSeq: 3 },
    ],
    [
      'an unsupported provider trusted turn start',
      { active: false, metadata: { flavor: 'claude' }, rollbackEligibleTurnStarts: [3] },
      { type: 'before_user_message', userMessageSeq: 3 },
    ],
  ])('rejects %s before invoking the rollback RPC', async (_scenario, sessionOverrides, target) => {
    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          seq: 5,
          createdAt: 1,
          updatedAt: 5,
          activeAt: 5,
          metadataVersion: 0,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 0,
          ...sessionOverrides,
        },
      },
      settings: {},
    });

    const executor = createDefaultActionExecutor();
    const result = await executor.execute(
      'session.rollback' as any,
      { sessionId: 'sess_parent', target },
      { defaultSessionId: 'sess_parent', surface: 'ui' } as any,
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
    expect(rollbackSessionConversationOpMock).not.toHaveBeenCalled();
  });

  it('delegates checkpoint code rollback through the production action executor dependency', async () => {
    rollbackSessionCheckpointCodeOpMock.mockResolvedValueOnce({
      status: 'applied',
      changedPaths: ['tracked.txt'],
      skippedPaths: [],
      receipts: ['checkpoint.rollback_applied'],
      diagnostics: [],
    });
    storageGetStateMock.mockReturnValue({
      sessions: {
        sess_parent: {
          id: 'sess_parent',
          active: true,
          metadata: {
            machineId: 'machine_1',
            flavor: 'codex',
            codexBackendMode: 'appServer',
          },
        },
      },
      settings: {},
    });
    const request = {
      v: 1,
      sessionId: 'sess_parent',
      turnId: 'turn-1',
      cwd: '/repo',
      codeMode: 'code_only_without_stash',
      backupMode: 'happier_checkpoint_only',
      expectedStartRef: 'refs/happier/checkpoints/c2Vzc19wYXJlbnQ/turn-start/turn-1',
      expectedFinalRef: 'refs/happier/checkpoints/c2Vzc19wYXJlbnQ/turn-final/turn-1',
      codeOnlyTranscriptDivergenceConfirmed: true,
    } as const;

    const executor = createDefaultActionExecutor({
      resolveServerIdForSessionId: () => 'server-b',
    });

    const result = await executor.execute(
      'session.checkpoint_code_rollback' as any,
      request,
      { defaultSessionId: 'sess_parent', surface: 'ui', placement: 'session_action_menu' } as any,
    );

    expect(result.ok).toBe(true);
    expect(rollbackSessionCheckpointCodeOpMock).toHaveBeenCalledWith({
      request,
      serverId: 'server-b',
    });
  });
});
