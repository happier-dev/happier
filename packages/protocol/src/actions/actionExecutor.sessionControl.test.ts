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
    executionRunWait: async () => ({}),
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
  it('executes session.message.send via deps.sessionSendMessage (including optional overrides)', async () => {
    const sessionSendMessage = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSendMessage });

    const res = await executor.execute(
      'session.message.send' as any,
      {
        sessionId: 's1',
        message: 'Hello',
        permissionModeOverride: 'read_only',
        modelOverride: 'gpt-4o',
        wait: true,
        timeoutSeconds: 42,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'Hello',
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
      wait: true,
      timeoutSeconds: 42,
    }));
  });

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
    const executor = createExecutor({
      sessionStop,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.stop' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true, stopped: true } });
    expect(sessionStop).toHaveBeenCalledWith({ sessionId: 's1', serverId: 'server-a' });
  });

  it('executes session.permission_mode.set via deps.sessionPermissionModeSet', async () => {
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionPermissionModeSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.permission_mode.set' as any,
      { sessionId: 's1', permissionMode: 'read_only' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionPermissionModeSet).toHaveBeenCalledWith({
      sessionId: 's1',
      permissionMode: 'read_only',
      serverId: 'server-a',
    });
  });

  it('executes session.model.set via deps.sessionModelSet', async () => {
    const sessionModelSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionModelSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.model.set' as any,
      { sessionId: 's1', modelId: 'default' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionModelSet).toHaveBeenCalledWith({ sessionId: 's1', modelId: 'default', serverId: 'server-a' });
  });

  it('executes session.archive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionArchiveSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.archive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: true, serverId: 'server-a' });
  });

  it('executes session.unarchive via deps.sessionArchiveSet', async () => {
    const sessionArchiveSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionArchiveSet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.unarchive' as any,
      { sessionId: 's1' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionArchiveSet).toHaveBeenCalledWith({ sessionId: 's1', archived: false, serverId: 'server-a' });
  });

  it('executes session.status.get via deps.sessionStatusGet', async () => {
    const sessionStatusGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionStatusGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.status.get' as any,
      { sessionId: 's1', live: true },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionStatusGet).toHaveBeenCalledWith({ sessionId: 's1', live: true, serverId: 'server-a' });
  });

  it('executes session.history.get via deps.sessionHistoryGet', async () => {
    const sessionHistoryGet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionHistoryGet,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

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
      serverId: 'server-a',
    });
  });

  it('executes session.wait.idle via deps.sessionWaitIdle', async () => {
    const sessionWaitIdle = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      sessionWaitIdle,
      resolveServerIdForSessionId: (sessionId) => sessionId === 's1' ? 'server-a' : null,
    });

    const res = await executor.execute(
      'session.wait.idle' as any,
      { sessionId: 's1', timeoutSeconds: 42 },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionWaitIdle).toHaveBeenCalledWith({ sessionId: 's1', timeoutSeconds: 42, serverId: 'server-a' });
  });

  it('executes session.spawn_new via deps.sessionSpawnNew (including backendTargetKey/title)', async () => {
    const sessionSpawnNew = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionSpawnNew });

    const res = await executor.execute(
      'session.spawn_new' as any,
      {
        path: '/repo',
        backendTargetKey: 'agent:claude',
        title: 'My title',
        tag: 'tag-1',
        initialMessage: 'Hello',
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo',
      backendTargetKey: 'agent:claude',
      title: 'My title',
      tag: 'tag-1',
      initialMessage: 'Hello',
    }));
  });

  it('executes session.list via deps.sessionList (including cli filter flags)', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const executor = createExecutor({ sessionList });

    const res = await executor.execute(
      'session.list' as any,
      {
        limit: 10,
        cursor: 'cursor-1',
        activeOnly: true,
        includeSystem: true,
        resumableOnly: true,
      },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: true, result: { sessions: [] } });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10,
      cursor: 'cursor-1',
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
    }));
  });

  it('returns unsupported_action when session.permission.respond is not implemented by deps', async () => {
    const executor = createExecutor({ sessionPermissionRespond: undefined as any });

    const res = await executor.execute(
      'session.permission.respond' as any,
      { sessionId: 's1', decision: 'allow' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.permission.respond' });
  });

  it('returns unsupported_action when session.user_action.answer is not implemented by deps', async () => {
    const executor = createExecutor({ sessionUserActionAnswer: undefined as any });

    const res = await executor.execute(
      'session.user_action.answer' as any,
      { sessionId: 's1', decision: 'approve' },
      { surface: 'cli', defaultSessionId: null },
    );

    expect(res).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.user_action.answer' });
  });
});
