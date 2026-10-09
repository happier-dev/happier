import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
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
  it.each(['cli', 'mcp'] as const)('searches both corpora through the existing %s Action surface', async (surface) => {
    const deps = createDeps();
    const result = { v: 1, ok: true, hits: [{
      type: 'artifact', ref: { kind: 'doc', serverId: 'home-1', artifactId: 'doc-1' },
      revision: { headerVersion: 2, bodyVersion: 3 }, factId: 'fact-1', location: 'archive',
      summary: 'Remembered decision', score: 1,
    }], documents: { state: 'ready' } };
    deps.daemonMemorySearch = vi.fn(async () => result);
    const query = { v: 1, query: 'decision', scope: { type: 'global' }, mode: 'deep', corpora: ['sessions', 'documents'] };
    const res = await createActionExecutor(deps).execute('memory.search', { machineId: 'm1', query }, {
      surface, serverId: 'home-1',
    });
    expect(res).toEqual({ ok: true, result });
    expect(deps.daemonMemorySearch).toHaveBeenCalledWith({ machineId: 'm1', query, serverId: 'home-1' });
  });

  it('routes memory.search to deps.daemonMemorySearch', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'ui' });
    expect(res.ok).toBe(true);
    expect(deps.daemonMemorySearch).toHaveBeenCalledWith({
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
      serverId: null,
    });
  });

  it('threads Action cancellation into the authorized memory-search dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent', signal: controller.signal });

    expect(deps.daemonMemorySearch).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('threads Action cancellation into the authorized memory-window dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    await executor.execute('memory.get_window', {
      machineId: 'm1',
      sessionId: 'session-1',
      seqFrom: 1,
      seqTo: 2,
    }, { surface: 'agent', signal: controller.signal });

    expect(deps.daemonMemoryGetWindow).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
