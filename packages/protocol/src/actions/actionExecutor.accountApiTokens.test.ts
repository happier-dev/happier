import { describe, expect, it, vi } from 'vitest';

import type { ActionId } from './actionIds.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { AccountApiTokenSummaryV1 } from '../auth/accountApiTokens.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
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

const encryptionAccess = {
  v: 1,
  serverIdentityId: 'srv_home_alpha',
  contentPublicKey: 'A'.repeat(43) + '=',
  wrappedContentPrivateKey: 'B'.repeat(96),
} as const;

const token = {
  tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d',
  label: 'CI deploy',
  displayPrefix: 'hap_v1_dd03e74b',
  createdAt: '2026-08-22T12:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-11-20T12:00:00.000Z',
  hasEncryptionAccess: false,
  hasUnattendedTeamAccess: false,
  grant: API_TOKEN_FULL_GRANT_V1,
  parentTokenId: null,
  activeChildCount: 0,
  embedConfig: null,
} satisfies AccountApiTokenSummaryV1;

describe('createActionExecutor (account.apiTokens)', () => {
  it('dispatches API-token lifecycle work with no caller-selected Account and reveals a newly minted secret exactly in create output', async () => {
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const accountApiTokensListAction = vi.fn(async () => ({ tokens: [token] }));
    const accountApiTokensRevokeAction = vi.fn(async () => ({ revoked: true }));
    const accountApiTokensRevokeAllAction = vi.fn(async () => ({ revokedCount: 1 }));
    const observeActionExecution = vi.fn();
    const deps = Object.assign(createDeps({
      // The plugin hook transport is the boundary; canonical Action execution stays real.
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      isActionApprovalRequired: () => false,
      observeActionExecution,
    }), {
      accountApiTokensCreateAction,
      accountApiTokensListAction,
      accountApiTokensRevokeAction,
      accountApiTokensRevokeAllAction,
    });
    const executor = createActionExecutor(deps);
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt },
      context,
    )).resolves.toEqual({
      ok: true,
      result: {
        token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
        apiToken: token,
      },
    });
    expect(observeActionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      result: { ok: true, result: { apiToken: token } },
    }));
    expect(accountApiTokensCreateAction).toHaveBeenCalledWith({
      input: { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt },
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
      { tokenId: token.tokenId, label: token.label, accountId: 'caller-selected-account' },
      context,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(accountApiTokensCreateAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tokenId: token.tokenId, label: token.label },
    { tokenId: token.tokenId, label: token.label, encryption: { access: encryptionAccess } },
  ])('rejects generic API creation before approval or issuance', async (actionInput) => {
    const observeActionExecution = vi.fn();
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const approvalsCreate = vi.fn();
    const executor = createActionExecutor(createDeps({
      accountApiTokensCreateAction,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution,
      isActionApprovalRequired: (candidate) => candidate === CREATE_ACTION_ID,
      approvalsCreate,
    }));
    await expect(executor.execute(CREATE_ACTION_ID, actionInput, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      serverId: 'srv_home_alpha',
      actionRequestId: 'req_account_api_token_create',
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'account-1',
        credentialId: 'credential-1',
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });
    expect(accountApiTokensCreateAction).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(observeActionExecution).toHaveBeenCalledTimes(1);
    expect(observeActionExecution.mock.calls[0]?.[0]).toMatchObject({
      actionId: CREATE_ACTION_ID,
      result: {
        ok: false,
        errorCode: 'action_disabled',
        error: 'action_disabled',
        details: expect.objectContaining({ reason: 'unsupported_surface', surface: 'api' }),
      },
    });
  });

  it('keeps a confirmed present-user token creation on the live invocation and never persists the show-once bearer', async () => {
    const bearer = `hap_v1_${token.tokenId}_${'A'.repeat(43)}`;
    const accountApiTokensCreateAction = vi.fn(async () => ({ token: bearer, apiToken: token }));
    const persisted: unknown[] = [];
    let stored: unknown = null;
    const deps = Object.assign(createDeps({
      isActionApprovalRequired: (actionId) => actionId === CREATE_ACTION_ID,
      isApprovalExecutionOriginCurrent: async () => true,
      // The Artifact transport is the boundary: record exactly what the executor persists.
      approvalsCreate: async ({ request }) => { stored = request; persisted.push(request); return { artifactId: 'approval-api-token' }; },
      approvalsGet: async () => stored as never,
      approvalsUpdate: async ({ request }) => { stored = request; persisted.push(request); return { ok: true as const }; },
      // The present user confirms on the waiting invocation.
      approvalsWaitForDecision: async ({ request }) => ({
        decision: 'approve' as const,
        request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: 2 } },
      }),
    }), { accountApiTokensCreateAction });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt },
      {
        surface: 'ui',
        authority: 'present_user',
        serverId: 'home-1',
        runtimeAccountId: 'account-1',
        actionRequestId: 'request-api-token',
        actionCaller: { kind: 'host' },
      },
    )).resolves.toEqual({ ok: true, result: { token: bearer, apiToken: token } });

    expect(accountApiTokensCreateAction).toHaveBeenCalledOnce();
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.at(-1)).toMatchObject({ status: 'executed', execution: { ok: true, result: { apiToken: token } } });
    expect(JSON.stringify(persisted)).not.toContain(bearer);
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
      surface: 'ui' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(LIST_ACTION_ID, {}, automationContext)).resolves.toEqual({
      ok: true,
      result: { tokens: [token] },
    });

    for (const [actionId, input] of [
      [CREATE_ACTION_ID, { tokenId: token.tokenId, label: token.label }],
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

  it('dispatches encryption-capable creation through the same owner with a client-captured token id and opaque wrapping record only', async () => {
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const observeActionExecution = vi.fn();
    const deps = Object.assign(createDeps({
      // The plugin hook transport is the boundary; canonical Action execution stays real.
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution,
    }), { accountApiTokensCreateAction });
    const executor = createActionExecutor(deps);
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt, encryption: { access: encryptionAccess } },
      context,
    )).resolves.toEqual({
      ok: true,
      result: { token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`, apiToken: token },
    });
    expect(observeActionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      result: { ok: true, result: { apiToken: token } },
    }));
    expect(accountApiTokensCreateAction).toHaveBeenCalledWith({
      input: { tokenId: token.tokenId, label: token.label, expiresAt: token.expiresAt, encryption: { access: encryptionAccess } },
      context,
    });

    // The wrapping record is the only material input; no raw key, wrapping
    // secret or caller-selected Account may reach the issuance owner.
    for (const invalid of [
      { tokenId: token.tokenId, label: token.label, encryption: {} },
      { label: token.label, encryption: { access: encryptionAccess } },
      { tokenId: token.tokenId, label: token.label, encryption: { access: encryptionAccess }, accountId: 'caller-selected' },
      { tokenId: token.tokenId, label: token.label, encryption: { access: encryptionAccess }, wrappingSecret: 'C'.repeat(43) },
      { tokenId: 'not-a-uuid', label: token.label, encryption: { access: encryptionAccess } },
      {
        tokenId: token.tokenId,
        label: token.label,
        encryption: { access: { ...encryptionAccess, wrappedContentPrivateKey: 'B'.repeat(95) } },
      },
    ]) {
      await expect(executor.execute(CREATE_ACTION_ID, invalid, context)).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
    }
    expect(accountApiTokensCreateAction).toHaveBeenCalledTimes(1);
  });

  it('refuses encryption-capable creation for account automation before its issuance owner runs', async () => {
    const accountApiTokensCreateAction = vi.fn(async () => ({
      token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
      apiToken: token,
    }));
    const deps = Object.assign(createDeps(), { accountApiTokensCreateAction });
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      CREATE_ACTION_ID,
      { tokenId: token.tokenId, label: token.label, encryption: { access: encryptionAccess } },
      { surface: 'ui' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
    expect(accountApiTokensCreateAction).not.toHaveBeenCalled();
  });

  it('carries the one empty list input to its owner and requires boolean encryption metadata', async () => {
    const accountApiTokensListAction = vi.fn(async () => ({ tokens: [token] }));
    const deps = Object.assign(createDeps(), { accountApiTokensListAction });
    const executor = createActionExecutor(deps);
    const context = {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute(LIST_ACTION_ID, {}, context)).resolves.toEqual({
      ok: true,
      result: { tokens: [token] },
    });
    expect(accountApiTokensListAction).toHaveBeenLastCalledWith({
      input: {},
      context,
    });

    for (const invalid of [{ includeEncryptionAccess: true }, { projectionVersion: 2 }]) {
      await expect(executor.execute(LIST_ACTION_ID, invalid, context)).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
    }
    expect(accountApiTokensListAction).toHaveBeenCalledTimes(1);
  });
});
