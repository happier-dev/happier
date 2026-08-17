import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps() {
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
    pluginSessionHookManagementAction: vi.fn(async () => ({ ok: true, rows: [], nextCursor: null, diagnostics: [] })),
  };
}

describe('createActionExecutor (plugin session hooks)', () => {
  it('binds the caller plugin identity and routes through the canonical management dependency', async () => {
    const deps = createDeps();
    const signal = new AbortController().signal;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);

    const result = await executor.execute('plugins.sessionHooks.status.get', {
      intent: 'install_preview',
      agent: { localId: 'codex' },
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'author.example' },
      signal,
      bypassApprovals: true,
    });

    expect(result.ok).toBe(true);
    expect(deps.pluginSessionHookManagementAction).toHaveBeenCalledWith({
      actionId: 'plugins.sessionHooks.status.get',
      input: {
        intent: 'install_preview',
        agent: { pluginId: 'author.example', localId: 'codex' },
      },
      signal,
    });
  });
});
