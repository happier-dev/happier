import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor';

function createExecutor(overrides: Partial<Parameters<typeof createActionExecutor>[0]> = {}) {
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
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

describe('createActionExecutor (session control plane)', () => {
  it('routes session.title.set to deps.sessionTitleSet', async () => {
    const sessionTitleSet = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ sessionTitleSet });

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 'sess_1', title: 'Hello' },
      { surface: 'cli' },
    );

    expect(res).toEqual({ ok: true, result: { ok: true } });
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 'sess_1', title: 'Hello' });
  });

  it('routes session.stop to deps.sessionStop', async () => {
    const sessionStop = vi.fn(async () => ({ ok: true, stopped: true }));
    const executor = createExecutor({ sessionStop });

    const res = await executor.execute(
      'session.stop' as any,
      { sessionId: 'sess_1' },
      { surface: 'cli' },
    );

    expect(res).toEqual({ ok: true, result: { ok: true, stopped: true } });
    expect(sessionStop).toHaveBeenCalledWith({ sessionId: 'sess_1' });
  });
});
