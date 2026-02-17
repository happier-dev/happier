import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    sessionSpawnPicker: vi.fn(async () => ({})),

    workspacesListRecent: vi.fn(async () => ({ items: [] })),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    resetGlobalVoiceAgent: vi.fn(),

    daemonMemorySearch: vi.fn(async () => ({ v: 1, ok: true, hits: [] })),
    daemonMemoryGetWindow: vi.fn(async () => ({ v: 1, snippets: [], citations: [] })),
    daemonMemoryEnsureUpToDate: vi.fn(async () => ({ ok: true })),
  };
}

describe('createActionExecutor (memory)', () => {
  it('routes memory.search to deps.daemonMemorySearch', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    });
    expect(res.ok).toBe(true);
    expect(deps.daemonMemorySearch).toHaveBeenCalledWith({
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
      serverId: null,
    });
  });
});

