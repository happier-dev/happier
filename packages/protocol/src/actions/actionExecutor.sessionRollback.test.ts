import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    sessionSpawnPicker: vi.fn(async () => ({})),

    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    daemonMemorySearch: vi.fn(async (): Promise<any> => ({ v: 1, ok: true, hits: [] })),
    daemonMemoryGetWindow: vi.fn(async (): Promise<any> => ({ v: 1, snippets: [], citations: [] })),
    daemonMemoryEnsureUpToDate: vi.fn(async () => ({ ok: true })),

    resetGlobalVoiceAgent: vi.fn(),
    teleportVoiceAgentToSessionRoot: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as ActionExecutorDeps;
}

describe('createActionExecutor (session.rollback)', () => {
  it('delegates to sessionRollback with the resolved session and server ids', async () => {
    const sessionRollback = vi.fn(async () => ({ ok: true, rolledBack: true }));
    const deps = createDeps({
      sessionRollback: sessionRollback as any,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    } as any);
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.rollback' as any,
      { target: { type: 'latest_turn' } },
      { defaultSessionId: 'sess_1' },
    );

    expect(result.ok).toBe(true);
    expect(sessionRollback).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serverId: 'server_a',
      target: { type: 'latest_turn' },
    });
  });

  it('fails when no session can be resolved', async () => {
    const deps = createDeps({
      sessionRollback: vi.fn(async () => ({ ok: true, rolledBack: true })) as any,
    } as any);
    const executor = createActionExecutor(deps);

    const result = await executor.execute(
      'session.rollback' as any,
      { target: { type: 'latest_turn' } },
      {},
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_not_selected',
      error: 'session_not_selected',
    });
  });
});
