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

const SIGN_OUT_EVERYWHERE_ACTION_ID = 'account.sessions.signOutEverywhere' as ActionId;

describe('createActionExecutor (account.sessions.signOutEverywhere)', () => {
  it('dispatches the current Account only for a host-stamped present-user call', async () => {
    const accountSessionsSignOutEverywhereAction = vi.fn(async () => ({ status: 'signed_out' as const }));
    const deps = Object.assign(createDeps(), { accountSessionsSignOutEverywhereAction });
    const executor = createActionExecutor(deps);
    const context = { surface: 'api' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };

    await expect(executor.execute(
      SIGN_OUT_EVERYWHERE_ACTION_ID,
      {},
      context,
    )).resolves.toEqual({ ok: true, result: { status: 'signed_out' } });
    expect(accountSessionsSignOutEverywhereAction).toHaveBeenCalledWith({ input: {}, context });

    await expect(executor.execute(
      SIGN_OUT_EVERYWHERE_ACTION_ID,
      { accountId: 'other-account' },
      context,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(accountSessionsSignOutEverywhereAction).toHaveBeenCalledTimes(1);
  });

  it('rejects account automation before the sign-out owner runs', async () => {
    const accountSessionsSignOutEverywhereAction = vi.fn(async () => ({ status: 'signed_out' as const }));
    const deps = Object.assign(createDeps(), { accountSessionsSignOutEverywhereAction });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      SIGN_OUT_EVERYWHERE_ACTION_ID,
      {},
      { surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' } },
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'present_user_required',
    }));
    expect(accountSessionsSignOutEverywhereAction).not.toHaveBeenCalled();
  });
});
