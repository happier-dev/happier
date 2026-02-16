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
  };
}

describe('createActionExecutor (inventory/discovery)', () => {
  it('forwards workspaceId to session.spawn_new', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', { workspaceId: 'ws_1', tag: 't' });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({ workspaceId: 'ws_1', tag: 't' });
  });

  it('forwards agentId + modelId to session.spawn_new', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', { agentId: 'codex', modelId: 'gpt-5' });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnNew).toHaveBeenCalledWith({ agentId: 'codex', modelId: 'gpt-5' });
  });

  it('routes workspaces.list_recent to deps.workspacesListRecent', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('workspaces.list_recent', { limit: 7 });
    expect(res.ok).toBe(true);
    expect(deps.workspacesListRecent).toHaveBeenCalledWith({ limit: 7 });
  });

  it('routes paths.list_recent to deps.pathsListRecent', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('paths.list_recent', { machineId: 'm1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(deps.pathsListRecent).toHaveBeenCalledWith({ machineId: 'm1', limit: 3 });
  });

  it('routes machines.list to deps.machinesList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('machines.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.machinesList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes servers.list to deps.serversList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('servers.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.serversList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes agents.backends.list to deps.agentsBackendsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.backends.list', { includeDisabled: false });
    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false });
  });

  it('routes agents.models.list to deps.agentsModelsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', { agentId: 'claude', machineId: 'm1' });
    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({ agentId: 'claude', machineId: 'm1' });
  });

  it('routes session.spawn_picker to deps.sessionSpawnPicker', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_picker', { tag: 'x', initialMessage: 'hello' });
    expect(res.ok).toBe(true);
    expect(deps.sessionSpawnPicker).toHaveBeenCalledWith({ tag: 'x', initialMessage: 'hello' });
  });
});
