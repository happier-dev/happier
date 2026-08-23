import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';

describe('createActionExecutor (review.start)', () => {
  it('settles a direct successful branch through the declared output schema', async () => {
    const executor = createActionExecutor({
      reviewStartInline: async () => new Map([['unexpected', true]]),
    } as ActionExecutorDeps);

    await expect(executor.execute(
      'review.start',
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
      },
      { defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });

  it('routes current-session single-engine reviews to the inline review dependency', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1' }));
    const reviewStartInline = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      reviewStartInline,
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    await expect(executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      { defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    });

    expect(reviewStartInline).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      engineId: 'codex',
      instructions: 'Review this.',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }));
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('passes the clamped agent permission mode to inline review dependencies', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1' }));
    const reviewStartInline = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      reviewStartInline,
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['codex'],
        instructions: 'Review this.',
        runLocation: 'current_session',
        permissionMode: 'safe-yolo',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        callerPermissionMode: 'safe-yolo',
      },
    );

    expect(res.ok).toBe(true);
    expect(reviewStartInline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        permissionMode: 'workspace_write',
      }),
    }));
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('starts resumable review runs with ioMode=streaming so sidechain progress can stream', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'claude', label: 'Claude' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['claude'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
        profileId: 'review.coderabbit/review',
        profileGenerationId: 'generation-4',
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        retentionPolicy: 'resumable',
        ioMode: 'streaming',
        profileId: 'review.coderabbit/review',
        profileGenerationId: 'generation-4',
      }),
      undefined,
    );
  });

  it('marks malformed execution-run start payloads as failed fanout items', async () => {
    const executionRunStart = vi.fn(async () => ({ error: 'Unable to resolve a default base branch for CodeRabbit review.' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'coderabbit', label: 'CodeRabbit' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['coderabbit'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            error: 'Unable to resolve a default base branch for CodeRabbit review.',
          },
        ],
      },
    });
  });

  it('does not launch review runs for unavailable engines', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'claude', label: 'Claude' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['coderabbit'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { defaultSessionId: 's1' },
    );

    expect(executionRunStart).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            errorCode: 'review_engine_unavailable',
            error: 'review_engine_unavailable',
          },
        ],
      },
    });
  });
});
