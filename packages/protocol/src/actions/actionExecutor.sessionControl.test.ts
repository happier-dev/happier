import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
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
    sessionList: async () => ({ sessions: [] }),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor (session control)', () => {
  it('executes session.title.set via deps.sessionTitleSet', async () => {
    const sessionTitleSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTitleSet });

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 's1', title: 'New title' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 's1', title: 'New title' });
  });

  it('executes session.stop via deps.sessionStop', async () => {
    const sessionStop = vi.fn(async () => ({ ok: true, stopped: true }));
    const executor = createExecutor({ sessionStop });

    const res = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true, stopped: true } });
    expect(sessionStop).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('executes session.permission_mode.set via deps.sessionPermissionModeSet', async () => {
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionPermissionModeSet });

    const res = await executor.execute(
      'session.permission_mode.set' as any,
      { sessionId: 's1', permissionMode: 'read_only' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionPermissionModeSet).toHaveBeenCalledWith({ sessionId: 's1', permissionMode: 'read_only' });
  });

  it('executes session.model.set via deps.sessionModelSet', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionModelSet });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: 'default' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({ sessionId: 's1', modelId: 'default' });
  });

  it('executes session.archive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionArchiveSet });

    const res = await executor.execute(
      'session.archive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: true });
  });

  it('executes session.unarchive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionArchiveSet });

    const res = await executor.execute(
      'session.unarchive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: false });
  });

  it('executes session.status.get via deps.sessionStatusGet', async () => {
    const sessionStatusGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionStatusGet });

    const res = await executor.execute(
      'session.status.get' as any,
      { sessionId: 's1', live: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionStatusGet).toHaveBeenCalledWith({ sessionId: 's1', live: true });
  });

  it('executes session.history.get via deps.sessionHistoryGet', async () => {
    const sessionHistoryGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionHistoryGet });

    const res = await executor.execute(
      'session.history.get' as any,
      { sessionId: 's1', limit: 25, format: 'compact', includeMeta: false, includeStructuredPayload: false },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionHistoryGet).toHaveBeenCalledWith({
      sessionId: 's1',
      limit: 25,
      format: 'compact',
      includeMeta: false,
      includeStructuredPayload: false,
    });
  });

  it('executes session.wait.idle via deps.sessionWaitIdle', async () => {
    const sessionWaitIdle = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionWaitIdle });

    const res = await executor.execute(
      'session.wait.idle' as any,
      { sessionId: 's1', timeoutSeconds: 42 },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionWaitIdle).toHaveBeenCalledWith({ sessionId: 's1', timeoutSeconds: 42 });
  });
});
