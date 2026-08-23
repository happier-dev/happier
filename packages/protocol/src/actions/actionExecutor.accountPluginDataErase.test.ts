import { describe, expect, it, vi } from 'vitest';

import type { ActionId } from './actionIds.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

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
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

const ACCOUNT_PLUGIN_DATA_ERASE_ACTION_ID = 'account.plugins.data.erase' as ActionId;

describe('createActionExecutor (account.plugins.data.erase)', () => {
  it('admits a host-stamped present-user call regardless of surface, passes no Account target to the owner, and keeps the result per-arm', async () => {
    const accountPluginDataEraseAction = vi.fn(async () => ({
      status: 'partial' as const,
      settings: { status: 'completed' as const, changed: true },
      data: { status: 'pending' as const, reason: 'unavailable' as const },
    }));
    const deps = Object.assign(createDeps(), { accountPluginDataEraseAction });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      ACCOUNT_PLUGIN_DATA_ERASE_ACTION_ID,
      { pluginId: 'com.example.retained-data' },
      { surface: 'api', authority: 'present_user', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: true,
      result: {
        status: 'partial',
        settings: { status: 'completed', changed: true },
        data: { status: 'pending', reason: 'unavailable' },
      },
    });
    expect(accountPluginDataEraseAction).toHaveBeenCalledWith({
      input: { pluginId: 'com.example.retained-data' },
      context: { surface: 'api', authority: 'present_user', actionCaller: { kind: 'host' } },
    });

    await expect(executor.execute(
      ACCOUNT_PLUGIN_DATA_ERASE_ACTION_ID,
      { pluginId: 'com.example.retained-data', accountId: 'other-account' },
      { surface: 'api', authority: 'present_user', actionCaller: { kind: 'host' } },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(accountPluginDataEraseAction).toHaveBeenCalledTimes(1);
  });

  it('rejects API automation before the Account data owner runs', async () => {
    const accountPluginDataEraseAction = vi.fn(async () => ({
      status: 'completed' as const,
      settings: { status: 'completed' as const, changed: false },
      data: { status: 'completed' as const, changed: false },
    }));
    const deps = Object.assign(createDeps(), { accountPluginDataEraseAction });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      ACCOUNT_PLUGIN_DATA_ERASE_ACTION_ID,
      { pluginId: 'com.example.retained-data' },
      { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' } },
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'present_user_required',
    }));
    expect(accountPluginDataEraseAction).not.toHaveBeenCalled();
  });
});
