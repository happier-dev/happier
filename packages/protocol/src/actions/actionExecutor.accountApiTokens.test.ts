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

const CREATE_ACTION_ID = 'account.apiTokens.create' as ActionId;
const LIST_ACTION_ID = 'account.apiTokens.list' as ActionId;
const REVOKE_ACTION_ID = 'account.apiTokens.revoke' as ActionId;
const REVOKE_ALL_ACTION_ID = 'account.apiTokens.revokeAll' as ActionId;

const token = {
  tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d',
  label: 'CI deploy',
  displayPrefix: 'hap_v1_dd03e74b',
  createdAt: '2026-08-22T12:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-11-20T12:00:00.000Z',
} as const;

describe('createActionExecutor (account.apiTokens)', () => {
  it('dispatches API-token lifecycle work with no caller-selected Account and reveals a newly minted secret exactly in create output', async () => {
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const accountApiTokensListAction = vi.fn(async () => ({ tokens: [token] }));
    const accountApiTokensRevokeAction = vi.fn(async () => ({ revoked: true }));
    const accountApiTokensRevokeAllAction = vi.fn(async () => ({ revokedCount: 1 }));
    const deps = Object.assign(createDeps(), {
      accountApiTokensCreateAction,
      accountApiTokensListAction,
      accountApiTokensRevokeAction,
      accountApiTokensRevokeAllAction,
    });
    const executor = createActionExecutor(deps);
    const context = {
      surface: 'api' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { label: token.label, expiresAt: token.expiresAt },
      context,
    )).resolves.toEqual({
      ok: true,
      result: {
        token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
        apiToken: token,
      },
    });
    expect(accountApiTokensCreateAction).toHaveBeenCalledWith({
      input: { label: token.label, expiresAt: token.expiresAt },
      context,
    });

    await expect(executor.execute(LIST_ACTION_ID, {}, context)).resolves.toEqual({
      ok: true,
      result: { tokens: [token] },
    });
    await expect(executor.execute(REVOKE_ACTION_ID, { tokenId: token.tokenId }, context)).resolves.toEqual({
      ok: true,
      result: { revoked: true },
    });
    await expect(executor.execute(REVOKE_ALL_ACTION_ID, {}, context)).resolves.toEqual({
      ok: true,
      result: { revokedCount: 1 },
    });

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { label: token.label, accountId: 'caller-selected-account' },
      context,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(accountApiTokensCreateAction).toHaveBeenCalledTimes(1);
  });

  it('lets account automation read token summaries but refuses every token-management mutation before its owner runs', async () => {
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const accountApiTokensListAction = vi.fn(async () => ({ tokens: [token] }));
    const accountApiTokensRevokeAction = vi.fn(async () => ({ revoked: true }));
    const accountApiTokensRevokeAllAction = vi.fn(async () => ({ revokedCount: 1 }));
    const deps = Object.assign(createDeps(), {
      accountApiTokensCreateAction,
      accountApiTokensListAction,
      accountApiTokensRevokeAction,
      accountApiTokensRevokeAllAction,
    });
    const executor = createActionExecutor(deps);
    const automationContext = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(LIST_ACTION_ID, {}, automationContext)).resolves.toEqual({
      ok: true,
      result: { tokens: [token] },
    });

    for (const [actionId, input] of [
      [CREATE_ACTION_ID, { label: token.label }],
      [REVOKE_ACTION_ID, { tokenId: token.tokenId }],
      [REVOKE_ALL_ACTION_ID, {}],
    ] as const) {
      await expect(executor.execute(actionId, input, automationContext)).resolves.toEqual({
        ok: false,
        errorCode: 'present_user_required',
        error: 'present_user_required',
      });
    }

    expect(accountApiTokensCreateAction).not.toHaveBeenCalled();
    expect(accountApiTokensListAction).toHaveBeenCalledExactlyOnceWith({
      input: {},
      context: automationContext,
    });
    expect(accountApiTokensRevokeAction).not.toHaveBeenCalled();
    expect(accountApiTokensRevokeAllAction).not.toHaveBeenCalled();
  });
});
