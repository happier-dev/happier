import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor';

describe('createActionExecutor (review.start)', () => {
  it('starts resumable review runs with ioMode=streaming so sidechain progress can stream', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      sessionSpawnPicker: async () => ({}),
      workspacesListRecent: async () => ({ items: [] }),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [] }),
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
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      sessionSpawnPicker: async () => ({}),
      workspacesListRecent: async () => ({ items: [] }),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [] }),
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
});
