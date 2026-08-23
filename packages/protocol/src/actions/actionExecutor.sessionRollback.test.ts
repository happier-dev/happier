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

    const signal = new AbortController().signal;
    const result = await executor.execute(
      'session.rollback' as any,
      { target: { type: 'latest_turn' } },
      { defaultSessionId: 'sess_1', signal },
    );

    expect(result.ok).toBe(true);
    expect(sessionRollback).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serverId: 'server_a',
      target: { type: 'latest_turn' },
      signal,
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

describe('createActionExecutor (session.checkpoint_code_rollback)', () => {
  const checkpointRollbackRequest = {
    v: 1,
    sessionId: 'sess_1',
    turnId: 'turn_1',
    cwd: '/repo',
    codeMode: 'code_only_without_stash',
    backupMode: 'happier_checkpoint_only',
    expectedStartRef: 'refs/happier/checkpoints/c2Vzc18x/turn-start/turn_1',
    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc18x/turn-final/turn_1',
    codeOnlyTranscriptDivergenceConfirmed: true,
  } as const;

  it('delegates checkpoint code rollback with request and resolved server id', async () => {
    const checkpointCodeRollback: NonNullable<ActionExecutorDeps['checkpointCodeRollback']> = vi.fn(async () => ({
      status: 'applied',
      changedPaths: [],
      skippedPaths: [],
      receipts: [],
      diagnostics: [],
    }));
    const deps = createDeps({
      checkpointCodeRollback,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    });
    const executor = createActionExecutor(deps);

    const signal = new AbortController().signal;
    const result = await executor.execute(
      'session.checkpoint_code_rollback',
      checkpointRollbackRequest,
      { defaultSessionId: 'sess_1', signal },
    );

    expect(result.ok).toBe(true);
    expect(checkpointCodeRollback).toHaveBeenCalledWith({
      request: checkpointRollbackRequest,
      serverId: 'server_a',
      signal,
    });
  });

  it('fails closed when checkpoint code rollback dependency is unavailable', async () => {
    const executor = createActionExecutor(createDeps());

    const result = await executor.execute(
      'session.checkpoint_code_rollback',
      checkpointRollbackRequest,
      { defaultSessionId: 'sess_1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.checkpoint_code_rollback',
    });
  });
});

describe('createActionExecutor (session.checkpoint / session.restore)', () => {
  it('delegates session.checkpoint with request and resolved server id', async () => {
    const sessionCheckpoint = vi.fn(async () => ({
      ok: true,
      status: 'succeeded',
      source: 'happier_scm',
      receipts: [],
    }));
    const deps = createDeps({
      sessionCheckpoint,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    } as Partial<ActionExecutorDeps>);
    const executor = createActionExecutor(deps);
    const request = {
      v: 1,
      sessionId: 'sess_1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
      },
      timing: 'idle',
    } as const;

    const signal = new AbortController().signal;
    const result = await executor.execute('session.checkpoint' as any, request, { defaultSessionId: 'ignored', signal });

    expect(result.ok).toBe(true);
    expect(sessionCheckpoint).toHaveBeenCalledWith({
      request,
      serverId: 'server_a',
      signal,
    });
  });

  it('delegates session.restore with request and resolved server id', async () => {
    const sessionRestore = vi.fn(async () => ({
      ok: true,
      status: 'succeeded',
      source: 'happier_scm',
      restoredScopes: ['workspace'],
      receipts: [],
    }));
    const deps = createDeps({
      sessionRestore,
      resolveServerIdForSessionId: vi.fn(() => 'server_a'),
    } as Partial<ActionExecutorDeps>);
    const executor = createActionExecutor(deps);
    const request = {
      v: 1,
      sessionId: 'sess_1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    } as const;

    const signal = new AbortController().signal;
    const result = await executor.execute('session.restore' as any, request, { signal });

    expect(result.ok).toBe(true);
    expect(sessionRestore).toHaveBeenCalledWith({
      request,
      serverId: 'server_a',
      signal,
    });
  });

  it('fails closed when session.restore dependency is unavailable', async () => {
    const executor = createActionExecutor(createDeps());

    const result = await executor.execute('session.restore' as any, {
      v: 1,
      sessionId: 'sess_1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    }, {});

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.restore',
    });
  });
});
