import { describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';

import type { ApprovalRequest, ApprovalRequestV1, ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { createWorkflowTriggerActions } from './executor/workflowTriggerActions.js';
import { createWorkflowDefinitionActions } from './executor/workflowDefinitions.js';
import { createWorkflowActionExecutor } from './executor/workflowAccountActions.js';
import { AutomationDefinitionReconcileRequestSchema, type AutomationDefinitionDetail } from '../automations/automationApiV3.js';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '../automations/automationWorkflowRecipeV2.js';
import { resolveWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionResolverV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';

const defaultActionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });
const securityTokenSummary = {
  tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Requested embed', displayPrefix: 'hap_v1_dd03e74b',
  createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
  hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
  grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null,
};
const securityToken = `hap_v1_${securityTokenSummary.tokenId}_${'a'.repeat(43)}`;

function createApprovalRequest(
  status: ApprovalRequestV1['status'] = 'open',
  overrides: Partial<ApprovalRequestV1> = {},
): ApprovalRequest {
  const actionId = overrides.actionId ?? 'session.message.send';
  const createdBy = overrides.createdBy ?? { surface: 'mcp', sessionId: 's1' };
  const requestedSurface = overrides.requestedSurface === undefined ? 'mcp' : overrides.requestedSurface;
  const sessionId = createdBy.sessionId ?? 's1';
  const serverId = typeof overrides.serverId === 'string' ? overrides.serverId : 'server-1';
  const executionSurface = requestedSurface === 'plugin'
    ? 'plugin'
    : requestedSurface === 'agent'
      ? 'agent'
      : requestedSurface === 'cli'
        ? 'cli'
        : 'mcp';
  const base: ApprovalRequestV2 = {
    v: 2,
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy,
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: executionSurface,
      caller: { kind: 'host' },
      serverId,
      ...(sessionId ? { sessionId, target: { kind: 'session' as const, sessionId } } : {}),
      ...(actionId === 'session.list'
        && (executionSurface === 'agent' || executionSurface === 'mcp' || executionSurface === 'plugin')
        ? { sessionListAccess: 'current_session' as const }
        : {}),
      actionId,
      requestId: 'request-1',
    },
    actionId,
    actionArgs: { sessionId: 's1', message: 'hello' },
    summary: 'Send message',
    requestedSurface,
  };

  const { serverId: _legacyServerId, v: _legacyVersion, ...safeOverrides } = overrides;

  if (status === 'approved') {
    return { ...base, ...safeOverrides, decision: { kind: 'approve', decidedAtMs: 2 } };
  }

  if (status === 'rejected') {
    return { ...base, ...safeOverrides, decision: { kind: 'reject', decidedAtMs: 2 } };
  }

  if (status === 'executed') {
    return {
      ...base,
      ...safeOverrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { ok: true } },
    };
  }

  if (status === 'failed') {
    return {
      ...base,
      ...safeOverrides,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_failed', error: 'action_failed' },
    };
  }

  return { ...base, ...safeOverrides };
}

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  const executor = createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({ status: 'accepted' as const, localId: 'local-1' }),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    isApprovalExecutionOriginCurrent: async () => true,
    ...overrides,
  });
  return {
    ...executor,
    execute: (
      actionId: Parameters<typeof executor.execute>[0],
      input: Parameters<typeof executor.execute>[1],
      context: Parameters<typeof executor.execute>[2] = {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      },
    ) => executor.execute(actionId, input, {
      ...(actionId === 'approval.request.decide'
        ? {}
        : { serverId: 'server-1', actionRequestId: `test-request:${actionId}` }),
      // This approval harness represents a Session-bound host. Agent list
      // admission requires the same explicit corpus boundary as its runtime.
      defaultSessionId: 's1',
      sessionListAccess: 'current_session',
      ...context,
    }),
  };
}

describe('createActionExecutor (approvals)', () => {
  it.each(['agent', 'mcp'] as const)('requests approval before a %s Session permission answer and executes with a user waiver', async (surface) => {
    let request: ApprovalRequest | null = null;
    const delivered: string[] = [];
    let settings = defaultActionsSettings;
    // Approval persistence and Session RPC delivery are the system boundaries.
    const executor = createExecutor({
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'permission-answer-approval' }; },
      sessionPermissionRespond: async ({ requestId }) => { delivered.push(requestId ?? ''); return { ok: true }; },
    });
    const input = { sessionId: 's1', requestId: 'permission-1', turnId: 'turn-1', decision: 'allow' };
    const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('session.permission.respond', input, context)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'permission-answer-approval' },
    });
    expect(request).toMatchObject({ status: 'open', actionId: 'session.permission.respond', actionArgs: input });
    expect(delivered).toEqual([]);
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.permission.respond': [surface] } });
    expect(await executor.execute('session.permission.respond', input, context)).toEqual({ ok: true, result: { ok: true } });
    expect(delivered).toEqual(['permission-1']);
  });
  it('copies an Account widget definition into the exact shared approval payload before publication', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const definitions = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
      read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: 'account' } : null; },
      list: async options => { const page = await boundary.transport.list(options); return { ...page,
        items: page.items.map(row => ({ ...row, ownerAccountId: 'account' })) }; },
    }, { accountId: 'account' });
    const definition = await definitions.create({ v: 1, id: 'private-definition', name: 'Checks',
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Checks',
        value: { path: ['count'], type: 'number' }, data: { kind: 'resource', resource: { pluginId: 'acme.metrics', localId: 'counts' },
          input: {}, inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } } } } },
      provenance: { source: { kind: 'authored' }, authorAccountId: 'account' } });
    const shared = structuredClone(definition);
    if (shared.body.kind !== 'declarative' || shared.body.document.root.kind !== 'metric'
      || shared.body.document.root.data.kind !== 'resource') throw new Error('Expected metric declaration');
    delete shared.body.document.root.data.input;
    let request: ApprovalRequest | null = null;
    // Artifact and approval persistence are the boundaries; their domain owners remain real.
    const executor = createExecutor({ widgetDefinitionArtifacts: definitions,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'share-definition' }; },
    });
    expect(await executor.execute('widgets.instance.add', {
      surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } },
      instance: { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: definition.id }, bindings: {} },
      placement: {},
    }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', defaultSessionId: 'shared' }))
      // This boundary captures the pending blocking request; no live user waiter is installed.
      .toEqual({ ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' });
    expect(request).toMatchObject({ actionArgs: { instance: { definition: { kind: 'inline', definition: shared } } } });
    expect(definition.body).not.toEqual(shared.body);
    await definitions.update(definition.id, { name: 'Later', body: { kind: 'declarative',
      document: { version: 1, root: { kind: 'text', text: 'Changed' } } } });
    expect(request).toMatchObject({ actionArgs: { instance: { definition: { kind: 'inline', definition: shared } } } });
  });
  it('rejects removed viewer override input before a shared widget approval is persisted', async () => {
    let persisted = false;
    const executor = createExecutor({ widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      approvalsCreate: async () => { persisted = true; return { artifactId: 'private-choice' }; },
    });
    expect(await executor.execute('widgets.instance.add', {
      surface: { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } },
      instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'example' }, bindings: {} },
      viewerValues: { connection: { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'private' } }, placement: {},
    }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', defaultSessionId: 'shared' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(persisted).toBe(false);
  });
  it('persists the human computer access choice with the edited target for the blocking waiter', async () => {
    const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;
    let request = createApprovalRequest('open', {
      actionId: 'computer.target.select',
      actionArgs: { machineId: 'machine', requestedTarget: 'Editor', access: 'use' },
      approval: { flow: 'blocking', result: 'required' },
    });
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => {
        const transition = decideApprovalRequestTransition(request, value);
        if (!transition.ok) return transition;
        request = value;
        return { ok: true };
      },
      // Native enumeration is a Machine transport boundary; the admission and
      // Artifact transition below it remain real.
      runtimeActionExecute: async () => ({ targets: [{ target }], grants: { capture: 'granted', input: 'granted' } }),
      // The live Session waiter is outside this executor; storage/admission stay real.
      approvalsResolveBlockingDecision: async () => ({ resolved: true }),
    });
    expect(await executor.execute('approval.request.decide', {
      artifactId: 'computer-approval', decision: 'approve', computerTarget: target, computerAccess: 'see',
    })).toMatchObject({ ok: true, result: { status: 'approved' } });
    expect(request).toMatchObject({ status: 'approved', actionArgs: {
      machineId: 'machine', requestedTarget: 'Editor', target, access: 'see',
    }, executionOriginV1: { authority: 'account_automation', surface: 'mcp' }, decision: { authority: 'present_user' } });
  });

  it('accepts a computer access choice only while approving an open computer selection', async () => {
    for (const [actionId, status, decision] of [
      ['computer.target.select', 'open', 'reject'],
      ['session.title.set', 'open', 'approve'],
      ['computer.target.select', 'approved', 'approve'],
    ] as const) {
      let request = createApprovalRequest(status, { actionId,
        actionArgs: actionId === 'computer.target.select'
          ? { machineId: 'machine', requestedTarget: 'Editor' }
          : { sessionId: 's1', title: 'Title' } });
      const initialRequest = request;
      // Approval storage is the persistence boundary; decision admission stays real.
      const executor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      });
      expect(await executor.execute('approval.request.decide', {
        artifactId: 'computer-approval', decision, computerAccess: 'see',
      })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(request).toEqual(initialRequest);
    }
  });

  it('admits an ORC-19 agent attention write through approval before changing the standing', async () => {
    let request: ApprovalRequest | null = null;
    let standing = true;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.attention.set': { approvalRequiredSurfaces: ['agent'] },
    } });
    // Approval persistence and the attention HTTP port are the system boundaries.
    const executor = createExecutor({
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'attention-approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      sessionAttentionSet: async ({ sessionId, request: value }) => {
        if (typeof value.standing === 'boolean') standing = value.standing;
        return { standing: { sessionId, standing, updatedAt: 10 } };
      },
    });

    expect(await executor.execute('session.attention.set', { sessionId: 's1', standing: false }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'attention-approval' } });
    expect(request).toMatchObject({ status: 'open', actionId: 'session.attention.set',
      actionArgs: { sessionId: 's1', standing: false } });
    expect(standing).toBe(true);

    expect(await executor.execute('approval.request.decide', {
      artifactId: 'attention-approval', decision: 'approve',
    })).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(request).toMatchObject({ status: 'executed' });
    expect(standing).toBe(false);
  });

  it('keeps surface control approval decisions human even for a credential with an approve grant', async () => {
    for (const actionId of ['browser.control.takeControl', 'browser.control.handBack', 'computer.targets.list',
      'computer.target.select', 'computer.control.interrupt', 'computer.control.handBack',
      'computer.permissions.openSettings', 'browser.sandbox.install'] as const) {
      let request = createApprovalRequest('open', { actionId, actionArgs: { machineId: 'machine', requestedTarget: 'Editor' } });
      const executor = createExecutor({
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
        isApprovalExecutionOriginCurrent: async () => true,
      });
      for (const decision of ['approve', 'reject'] as const) {
        expect(await executor.execute('approval.request.decide', { artifactId: 'surface-approval', decision }, {
          surface: 'api', authority: 'account_automation', externalActionCredential: {
            accountId: 'account', principalId: 'token', credentialId: 'token', grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
          },
        }), `${actionId}:${decision}`).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(request.status).toBe('open');
      }
      request = { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } };
      expect(await executor.replayApprovedApprovalRequest({
        artifactId: 'surface-approval', callerAuthority: 'account_automation',
      }), actionId).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
    }
  });

  it('allows an approval-granted credential to decide an ordinary approved Action', async () => {
    let request = createApprovalRequest();
    const messages: string[] = [];
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      sessionSendMessage: async ({ message }) => {
        messages.push(message);
        return { status: 'accepted', localId: 'ordinary-message' };
      },
    });
    expect(await executor.execute('approval.request.decide', { artifactId: 'ordinary-approval', decision: 'approve' }, {
      surface: 'api', authority: 'account_automation', externalActionCredential: {
        accountId: 'account', principalId: 'token', credentialId: 'token', grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
      },
    })).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(request.status).toBe('executed');
    expect(messages).toEqual(['hello']);
  });
  it('requires present-user approval for automated fresh-folder consent without changing ordinary open', async () => {
    let request: ApprovalRequest | null = null;
    const sessionOpen = vi.fn(async () => ({ ok: true, status: 'opened' }));
    const executor = createExecutor({
      sessionOpen,
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'folder-consent' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    for (const surface of ['agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'session.open': [surface] } }) };
      expect(await executor.execute('session.open', { sessionId: 's1' }, context)).toMatchObject({ ok: true });
      sessionOpen.mockClear();
      const input = { sessionId: 's1', approvedNewDirectoryCreation: true };
      expect(await executor.execute('session.open', input, { ...context, bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await executor.execute('session.open', input, context))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'folder-consent' } });
      expect(sessionOpen).not.toHaveBeenCalled();
    }
    const tokenContext = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute('approval.request.decide', { artifactId: 'folder-consent', decision: 'approve' }, tokenContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request).toMatchObject({ status: 'open' });
    expect(await executor.execute('approval.request.decide', { artifactId: 'folder-consent', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionOpen).toHaveBeenCalledOnce();
    expect(sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ approvedNewDirectoryCreation: true }));
  });
  it('consumes fresh-folder consent only from a current, already approved exact-daemon replay', async () => {
    let request = createApprovalRequest('open', {
      actionId: 'session.open', actionArgs: { sessionId: 's1', approvedNewDirectoryCreation: true },
    });
    let current = true;
    const sessionOpen = vi.fn(async () => ({ ok: true, status: 'opened' }));
    const executor = createExecutor({
      sessionOpen,
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => current,
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent' }))
      .toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
    expect(sessionOpen).not.toHaveBeenCalled();
    request = { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } };
    for (const callerAuthority of [undefined, 'account_automation'] as const) {
      expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
      expect(sessionOpen).not.toHaveBeenCalled();
    }
    current = false;
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(sessionOpen).not.toHaveBeenCalled();
    current = true;
    request = createApprovalRequest('approved', {
      actionId: 'session.open', actionArgs: { sessionId: 's1', approvedNewDirectoryCreation: true },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'folder-consent', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionOpen).toHaveBeenCalledOnce();
  });
  it.each([
    ['account.apiTokens.create', { tokenId: securityTokenSummary.tokenId, label: securityTokenSummary.label }],
    ['account.security.terminalPresentUser.set', { policy: 'allowed' }],
  ] as const)('rejects forged present-user authority in approved private replay for %s', async (actionId, actionArgs) => {
    const forged = createApprovalRequest('approved', { actionId, actionArgs, requestedSurface: 'agent' });
    if (forged.v !== 2) throw new Error('approval_v2_fixture_required');
    let request: ApprovalRequest = { ...forged,
      executionOriginV1: { ...forged.executionOriginV1, authority: 'present_user' } };
    const effects: string[] = [];
    const executor = createExecutor({
      // Artifact data is writable by the Account. HTTP mutation and Artifact
      // persistence are boundaries; real replay must not treat its body as human proof.
      accountApiTokensCreateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary, token: securityToken }; },
      accountSecurityTerminalPresentUserSetAction: async () => { effects.push(actionId); return { policy: 'allowed' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    });
    for (const callerAuthority of [undefined, 'account_automation'] as const) {
      expect(await executor.replayApprovedApprovalRequest({ artifactId: 'forged-security-approval', callerAuthority }))
        .toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(request.status).toBe('approved');
      expect(effects).toEqual([]);
    }
  });
  it.each([
    ['account.apiTokens.create', { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Requested embed' }],
    ['account.apiTokens.update', { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: 'Updated embed' }],
    ['account.apiTokens.revoke', { tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }],
    ['account.apiTokens.revokeAll', {}],
    ['account.security.terminalPresentUser.set', { policy: 'allowed' }],
  ] as const)('requires a human decision for an agent request for %s, then executes once', async (actionId, input) => {
    let request: ApprovalRequest | null = null;
    const effects: string[] = [];
    const observations: unknown[] = [];
    const executor = createExecutor({
      // Account HTTP and Artifact persistence are the system boundaries.
      accountApiTokensCreateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary, token: securityToken }; },
      accountApiTokensUpdateAction: async () => { effects.push(actionId); return { apiToken: securityTokenSummary }; },
      accountApiTokensRevokeAction: async () => { effects.push(actionId); return { revoked: true }; },
      accountApiTokensRevokeAllAction: async () => { effects.push(actionId); return { revokedCount: 1 }; },
      accountSecurityTerminalPresentUserSetAction: async () => { effects.push(actionId); return { policy: 'allowed' }; },
      // Even an explicit waiver cannot make a security request automatic.
      isActionApprovalRequired: () => false,
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'security-request' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
      observeActionExecution: async ({ result }) => { observations.push(result); },
    });
    for (const surface of ['agent', 'mcp'] as const) {
      expect(await executor.execute(actionId, input, {
        surface, authority: 'account_automation', actionCaller: { kind: 'host' }, bypassApprovals: true,
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await executor.execute(actionId, input, {
        surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'security-request' } });
    }
    expect(effects).toEqual([]);
    const tokenContext = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute(actionId, input, tokenContext)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' }, tokenContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request).toMatchObject({ status: 'open' });
    expect(effects).toEqual([]);
    const decided = await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
    if (actionId === 'account.apiTokens.create') expect(JSON.stringify(decided)).toContain(securityToken);
    const duplicate = await executor.execute('approval.request.decide', { artifactId: 'security-request', decision: 'approve' });
    expect(JSON.stringify(duplicate)).not.toContain(securityToken);
    expect(effects).toEqual([actionId]);
    expect(JSON.stringify(request)).not.toContain(securityToken);
    expect(JSON.stringify(observations)).not.toContain(securityToken);
  });
  it('allows an Approve-scoped token to reject, but not approve, a present-user request', async () => {
    let request = createApprovalRequest('open', {
      actionId: 'account.security.terminalPresentUser.set', actionArgs: { policy: 'allowed' },
    });
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => { request = next; return { ok: true }; },
    });
    const ctx = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'token', credentialId: 'token',
        grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } } };
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'approve' }, ctx))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(request.status).toBe('open');
    expect(await executor.execute('approval.request.decide', { artifactId: 'request', decision: 'reject' }, ctx))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
  });
  it('requires approval before an agent trigger removal and replays the approved write without another approval', async () => {
    let request: ApprovalRequest | null = null;
    const workflow = '11111111-1111-4111-8111-111111111111';
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({
      v: 2, templateVersion: 1, triggerEvidence: null,
      workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } },
    });
    if (recipe.kind !== 'available') throw new Error('Invalid workflow recipe fixture');
    let row: AutomationDefinitionDetail = { id: 'automation', name: 'Triggers', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
      lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: workflow, scopeSessionId: null,
      executionRecipe: recipe.recipe,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: 'trigger', revision: 0, enabled: true, createdAt: 1, updatedAt: 1,
        kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
        nextRunAt: 2, triggerDefinitionEnvelope: null }] };
    const unused = async (): Promise<never> => { throw new Error('Unexpected boundary operation'); };
    // Persistent Automation/Artifact and approval transports are the fake system boundaries.
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: async () => null, list: async () => ({ items: [] }), create: unused, update: unused, delete: unused,
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: unused });
    const triggers = createWorkflowTriggerActions({ automations: {
      list: async () => ({ automations: [row], nextCursor: null }), get: async () => row,
      create: unused, delete: unused,
      reconcile: async (_id, raw) => {
        const input = AutomationDefinitionReconcileRequestSchema.parse(raw);
        row = { ...row, triggers: row.triggers.filter((trigger) => input.triggers.some((item) => item.triggerId === trigger.id)) };
        return row;
      },
    },
      openContext: async (row) => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain'
        ? row.executionRecipe.workflow.v : null,
      sealContext: unused, newId: () => 'unused',
      resolveWorkflow: async (ref) => {
        const source = await resolveWorkflowDefinitionRefV1(ref, { readArtifact: (definitionId) => definitions.get({ definitionId }) });
        if (!source) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        return source.definition;
      },
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'workflow.trigger.remove': ['agent'] } });
    const executor = createExecutor({
      workflowAction: createWorkflowActionExecutor({
        // This is the server feature-bit boundary; family dispatch/trigger semantics stay real.
        isWorkflowFeatureEnabled: () => true, definitions, triggers, runs: { execute: unused },
      }),
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      approvalsCreate: async (input) => { request = input.request; return { artifactId: 'approval' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async (input) => { request = input.request; return { ok: true }; },
    } satisfies Pick<ActionExecutorDeps, 'workflowAction' | 'isActionApprovalRequired'
      | 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'>);
    expect(await executor.execute('workflow.trigger.remove', { automationId: 'automation', triggerId: 'trigger' }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(row.triggers).toHaveLength(1);
    expect(request).toMatchObject({ status: 'open', actionId: 'workflow.trigger.remove' });
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' });
    expect(request).toMatchObject({ status: 'executed' });
    expect(row.triggers).toHaveLength(0);
  });
  it('lets an approve token decide its own request without granting the requested Action', async () => {
    const request = createApprovalRequest();
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      approvalsGet: async () => request,
      approvalsUpdate,
      sessionSendMessage: async () => ({ status: 'accepted' as const, localId: 'local-1' }),
    });
    const result = await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }, {
      surface: 'api', authority: 'account_automation',
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1, actions: { families: [], ids: ['session.title.set'] }, targets: { sessions: ['s1'], machines: [] },
          approve: true, origins: [], models: null, permissionModes: null, create: null },
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ status: 'executed' }) }));
  });

  it('refuses approval target escape before artifact mutation', async () => {
    const request = createApprovalRequest();
    const approvalsUpdate = vi.fn(async () => ({ ok: true }));
    // The contributed-artifact transport reports that this is an ordinary host artifact.
    const targetActionApprovalReplay = async () => null;
    const executor = createExecutor({ approvalsGet: async () => request, approvalsUpdate, targetActionApprovalReplay });
    const result = await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'reject' }, {
      surface: 'api', authority: 'account_automation',
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1, actions: null, targets: { sessions: ['other-session'], machines: [] },
          approve: true, origins: [], models: null, permissionModes: null, create: null },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(approvalsUpdate).not.toHaveBeenCalled();
  });

  it('does not let approve cover token management or a missing approve grant', async () => {
    const executor = createExecutor();
    const context = {
      surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: {
        accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1',
        grant: { v: 1 as const, actions: null, targets: null, approve: false,
          origins: [], models: null, permissionModes: null, create: null },
      },
    };
    expect(await executor.execute('approval.request.decide', { artifactId: 'a1', decision: 'approve' }, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    context.externalActionCredential.grant.approve = true;
    expect(await executor.execute('account.apiTokens.create', {}, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('account.security.terminalPresentUser.set', { policy: 'allowed' }, context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
  });

  it('continues a Session blocking confirmation without creating an Account Artifact', async () => {
    let publishedPreview: unknown;
    // The injected host transport is the Session permission RPC/encrypted-state boundary.
    const transport = {
      sessionActionConfirmation: async (request: Parameters<NonNullable<ActionExecutorDeps['sessionActionConfirmation']>>[0]) => {
        publishedPreview = 'preview' in request ? request.preview : undefined;
        return { decision: 'approve' as const, isCurrent: () => true };
      },
      isActionApprovalRequired: () => true,
      sessionActivityGet: async () => ({
        ok: true,
        sessionId: 's1',
        presence: 'online',
        active: true,
        thinking: false,
        working: false,
        blocked: false,
        permissionRequired: false,
        actionRequired: false,
        updatedAt: null,
      }),
    };
    const executor = createExecutor(transport);
    const result = await executor.execute('session.activity.get', { sessionId: 's1', windowSeconds: 10 }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
    });
    expect(result).toEqual({
      ok: true,
      result: {
        ok: true,
        sessionId: 's1',
        presence: 'online',
        active: true,
        thinking: false,
        working: false,
        blocked: false,
        permissionRequired: false,
        actionRequired: false,
        updatedAt: null,
      },
    });
    expect(publishedPreview).toEqual({ sessionId: 's1', windowSeconds: 10 });
  });

  it('routes plugin dev-loop actions through one executor dependency on the agent surface', async () => {
    const pluginsDevLoopAction = vi.fn(async ({ actionId }) => ({
      kind: actionId.replaceAll('.', '_'),
      ok: true,
    }));
    const executor = createExecutor({ pluginsDevLoopAction } as any);

    for (const [actionId, input] of [
      ['plugins.list', {}],
      ['plugins.uninstall', { pluginId: 'acme.dev-loop' }],
    ] as const) {
      const result = await executor.execute(
        actionId as any,
        input,
        {
          surface: 'agent' as any,
          bypassApprovals: true,
          ...(actionId === 'plugins.uninstall'
            ? { authority: 'present_user' as const }
            : {}),
        },
      );

      expect(result).toEqual({
        ok: true,
        result: {
          kind: actionId.replaceAll('.', '_'),
          ok: true,
        },
      });
      expect(pluginsDevLoopAction).toHaveBeenCalledWith({
        actionId,
        input,
        context: expect.objectContaining({ surface: 'agent' }),
      });
    }
  });

  it('lists approval requests through the bounded approval artifact store dependency', async () => {
    const approvalsList = vi.fn(async () => ({
      items: [
        {
          artifactId: 'a1',
          status: 'open',
          actionId: 'session.message.send',
          summary: 'Send message',
          updatedAtMs: 2,
        },
      ],
      queryPlan: {
        kind: 'approval_artifact_header_scan',
        hydratedTranscripts: false,
      },
    }));

    const executor = createExecutor({ approvalsList } as any);
    const res = await executor.execute(
      'approval.request.list' as any,
      { status: 'open', limit: 5 },
      { surface: 'rpc', serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        items: [
          {
            artifactId: 'a1',
            status: 'open',
            actionId: 'session.message.send',
            summary: 'Send message',
            updatedAtMs: 2,
          },
        ],
        queryPlan: {
          kind: 'approval_artifact_header_scan',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsList).toHaveBeenCalledWith({
      status: 'open',
      limit: 5,
      serverId: 'server-1',
    });
  });

  it('gets approval requests through the keyed approval artifact dependency', async () => {
    const request = createApprovalRequest();
    const approvalsGet = vi.fn(async () => request);

    const executor = createExecutor({ approvalsGet });
    const res = await executor.execute(
      'approval.request.get' as any,
      { artifactId: 'a1' },
      { surface: 'rpc', serverId: 'server-1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        artifactId: 'a1',
        request,
        queryPlan: {
          kind: 'approval_artifact_id_lookup',
          backingStore: 'ArtifactStore',
          boundedBy: 'approval artifact id',
          hydratedTranscripts: false,
        },
      },
    });
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: 'server-1' });
  });

  it('does not route non-surfaced actions through approvals even when a policy requires approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'ui.voice_global.reset' && ctx.surface === 'cli',
    } as any);

    const res = await executor.execute(
      'ui.voice_global.reset' as any,
      {},
      { surface: 'cli' },
    );

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'cli',
        reason: 'unsupported_surface',
      }),
    }));
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('routes actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'mcp' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        summary: expect.stringContaining('Send a message'),
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it('uses host-provided approval preview metadata for plugin installs', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const buildApprovalPreview = vi.fn(async ({ actionId, input, defaultPreview }) => ({
      ...defaultPreview,
      pluginInstall: {
        actionId,
        path: (input as any).path,
        plugin: {
          id: 'acme.dev-loop',
          version: '1.0.0',
          title: 'Acme Dev Loop',
        },
        provenance: {
          sourceKind: 'path',
        },
        permissions: {
          required: ['network'],
          optional: ['filesystem.read'],
        },
      },
    }));
    const executor = createExecutor({
      approvalsCreate,
      buildApprovalPreview,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'plugins.install' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'plugins.install' as any,
      { path: '/tmp/acme-dev-loop', dev: true },
      { surface: 'agent' as any, authority: 'present_user' },
    );

    expect(res.ok).toBe(true);
    expect(buildApprovalPreview).toHaveBeenCalledWith({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-dev-loop', dev: true },
      context: expect.objectContaining({ surface: 'agent' }),
      defaultPreview: { actionId: 'plugins.install', actionArgs: { path: '/tmp/acme-dev-loop', dev: true } },
    });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'plugins.install',
        preview: expect.objectContaining({
          pluginInstall: expect.objectContaining({
            plugin: {
              id: 'acme.dev-loop',
              version: '1.0.0',
              title: 'Acme Dev Loop',
            },
            provenance: expect.objectContaining({ sourceKind: 'path' }),
            permissions: {
              required: ['network'],
              optional: ['filesystem.read'],
            },
          }),
        }),
      }),
    }));
  });

  it('does not persist an explicit approval request after preview cancellation', async () => {
    const controller = new AbortController();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const executor = createExecutor({
      approvalsCreate,
      buildApprovalPreview: async ({ defaultPreview }) => {
        controller.abort();
        return defaultPreview;
      },
    });

    await expect(executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    }, {
      surface: 'mcp',
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('records transcript tool-call origin metadata on policy-created approvals', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
        sessionInputSource: {
          sourceSessionId: 's1',
          sourceTurnId: 'turn-1',
          via: 'action',
        },
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      } as any,
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          toolCallId: 'tool-1',
          toolName: 'session_message_send',
          toolInput: { sessionId: 's1', message: 'hello' },
        },
      }),
    }));
  });

  it('rejects a policy-created cross-session Agent approval before persistence when its source witness is missing', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'must-not-exist' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'agent',
        defaultSessionId: 'requesting-session',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
      } as any,
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'causal_permission_authority_invalid',
      error: 'causal_permission_authority_invalid',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('lets the message owner authorize a policy-created cross-session Agent approval with a host-stamped source witness', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'agent',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 'target-session', message: 'hello target' },
      {
        surface: 'agent',
        defaultSessionId: 'requesting-session',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
        },
        sessionInputSource: {
          sourceSessionId: 'requesting-session',
          sourceTurnId: 'turn-cross-session',
          via: 'action',
        },
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
          toolInput: { sessionId: 'target-session', message: 'hello target' },
        },
      } as any,
    );

    expect(res).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1' },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.message.send',
        actionArgs: { sessionId: 'target-session', message: 'hello target' },
        createdBy: expect.objectContaining({
          surface: 'agent',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          kind: 'transcript_tool_call',
          sessionId: 'requesting-session',
          toolCallId: 'tool-cross-session',
          toolName: 'session_message_send',
        }),
        executionOriginV1: expect.objectContaining({
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'read-only',
          },
          sessionInputSource: {
            sourceSessionId: 'requesting-session',
            sourceTurnId: 'turn-cross-session',
            via: 'action',
          },
        }),
      }),
    }));
  });

  it('records createdBy.surface=cli when approvals are created from the CLI surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    });

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('marks approval requests created from the CLI surface as createdBy.surface=cli', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'cli',
    } as any);

    const res = await executor.execute(
      'session.message.send' as any,
      { sessionId: 's1', message: 'hello' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({ surface: 'cli', sessionId: 's1' }),
      }),
    }));
  });

  it('routes eligible actions through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executionRunStart = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'review.start',
    } as any);

    const res = await executor.execute(
      'review.start' as any,
      { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      { surface: 'cli' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).not.toHaveBeenCalled();
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
  });

  it.each([
    {
      name: 'approval storage is unavailable',
      overrides: {},
      context: { surface: 'cli' as const, actionCaller: { kind: 'host' as const } },
    },
    {
      name: 'plugin approval provenance is incomplete',
      overrides: { approvalsCreate: vi.fn(async () => ({ artifactId: 'a1' })) },
      context: {
        surface: 'plugin' as const,
        actionCaller: { kind: 'plugin' as const, pluginId: 'acme.plugin' },
      },
    },
  ])('classifies $name before execution.run.start dispatch as noRunCreated', async ({ overrides, context }) => {
    const executionRunStart = vi.fn(async () => ({
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
    }));
    const executor = createExecutor({
      executionRunStart,
      isActionApprovalRequired: (actionId) => actionId === 'execution.run.start',
      ...overrides,
    });

    await expect(executor.execute('execution.run.start' as any, {
      sessionId: 's1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Inspect the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, context)).resolves.toEqual({
      ok: false,
      errorCode: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      error: context.surface === 'plugin'
        ? 'plugin_action_caller_required'
        : 'approvals_not_supported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it.each(['cli', 'mcp'] as const)('routes %s approval custody without executing when no live waiter is available', async (surface) => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const agentsBackendsList = vi.fn(async () => ({ items: [] }));

    const executor = createExecutor({
      approvalsCreate,
      agentsBackendsList,
      isActionApprovalRequired: (actionId) => actionId === 'agents.backends.list',
    } as any);

    const res = await executor.execute(
      'agents.backends.list' as any,
      {},
      { surface },
    );

    expect(res).toEqual(surface === 'cli'
      ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'agents.backends.list' } }
      : { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' });
    expect(agentsBackendsList).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        approval: { flow: surface === 'cli' ? 'deferred' : 'blocking', result: 'required' },
        createdBy: expect.objectContaining({ surface }),
      }),
    }));
  });

  it('defers API policy approvals even when the Action normally has a blocking result', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'api-approval-1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsWaitForDecision = vi.fn(async () => {
      throw new Error('external API approvals must not wait for a decision');
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'action.spec.search' && ctx.surface === 'api',
    } as any);

    await expect(executor.execute(
      'action.spec.search' as any,
      { query: 'approval', limit: 1 },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        externalActionCredential: { accountId: 'account-1', principalId: 'account-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'invocation-authorization',
          binding: {
            serverIdentityId: 'server-1',
            accountId: 'account-1',
            principalId: 'account-1',
            credentialId: 'credential-1',
            grant: API_TOKEN_FULL_GRANT_V1,
            machineId: 'machine-1',
            actionId: 'action.spec.search',
            requestId: 'test-request:action.spec.search',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-1' },
          },
        },
        signExternalActionApprovalInput: () => 'a'.repeat(86),
      },
    )).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'api-approval-1',
        actionId: 'action.spec.search',
      },
    });
    expect(approvalsWaitForDecision).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'action.spec.search',
        approval: { flow: 'deferred', result: 'required' },
      }),
    }));
  });

  it('keeps a present-user invitation approval on its live mounted invocation', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'ui-home-approval-1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'reject' as const,
      request: {
        ...request,
        status: 'rejected' as const,
        decision: { kind: 'reject' as const, decidedAtMs: 2 },
      },
    }));
    const homeDomainAction = vi.fn(async () => {
      throw new Error('the mutation must remain gated until the approval owner replays it');
    });
    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      homeDomainAction,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'teams.invitations.create'
        && context.surface === 'ui'
        && context.authority === 'present_user'
      ),
    } as any);

    await expect(executor.execute(
      'teams.invitations.create' as any,
      {
        v: 1,
        teamId: 'team-1',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmail: null,
        requestKey: 'invite-request-1',
      },
      {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
        runtimeAccountId: 'account-1',
      },
    )).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'teams.invitations.create',
        requestedSurface: 'ui',
        executionOriginV1: expect.objectContaining({
          authority: 'present_user',
          surface: 'ui',
          accountId: 'account-1',
        }),
        approval: { flow: 'blocking', result: 'required' },
      }),
    }));
  });

  it('returns an approved invitation bearer to the live invocation but never writes it to the Artifact', async () => {
    const invitation = {
      id: 'invitation-live-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const rawResult = {
      invitation,
      joinUrl: 'https://home.example/join/live-only-bearer',
    };
    const persisted: ApprovalRequest[] = [];
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      persisted.push(request);
      return { ok: true as const };
    });
    const executor = createExecutor({
      approvalsCreate: vi.fn(async () => ({ artifactId: 'ui-live-invitation-approval' })),
      approvalsUpdate,
      approvalsWaitForDecision: vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      })),
      homeDomainAction: vi.fn(async () => rawResult),
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'teams.invitations.create'
        && context.surface === 'ui'
        && context.authority === 'present_user'
      ),
    } as any);

    await expect(executor.execute('teams.invitations.create' as any, {
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'invite-live-request-1',
    }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      runtimeAccountId: 'account-1',
    })).resolves.toEqual({ ok: true, result: rawResult });

    const terminal = persisted.at(-1);
    expect(terminal?.execution).toEqual({
      executedAtMs: expect.any(Number),
      ok: true,
      result: { invitation, joinUrl: null },
    });
    expect(JSON.stringify(persisted)).not.toContain('live-only-bearer');
  });

  it('waits for a blocking approval and returns the underlying action result when approved', async () => {
    const cancellation = new AbortController();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      expect(sessionList).not.toHaveBeenCalled();
      return {
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      };
    });

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp', signal: cancellation.signal },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
        nextCursor: null,
      },
    });
    expect(approvalsWaitForDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        actionId: 'session.list',
        approval: { flow: 'blocking', result: 'required' },
      }),
      serverId: 'server-1',
      signal: cancellation.signal,
    }));
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10,
      serverId: 'server-1',
      signal: cancellation.signal,
      context: expect.objectContaining({
        authority: 'account_automation',
        surface: 'mcp',
        bypassApprovals: true,
      }),
    }));
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: {
            sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
            nextCursor: null,
          },
        }),
      }),
    }));
  });

  it('cancels a blocking approval without invoking the target Action', async () => {
    const cancellation = new AbortController();
    const sessionList = vi.fn(async () => ({ sessions: [], nextCursor: null }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const executor = createExecutor({
      approvalsCreate: async () => ({ artifactId: 'a1' }),
      approvalsUpdate,
      approvalsWaitForDecision: async ({ request, signal }) => {
        // The approval transport observes the same cancellation as its caller.
        cancellation.abort();
        expect(signal?.aborted).toBe(true);
        return { decision: 'canceled', request };
      },
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    });

    const result = await executor.execute('session.list', { limit: 10 }, {
      surface: 'mcp', signal: cancellation.signal,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ status: 'canceled' }),
    }));
  });

  it('returns an already executed blocking approval result without re-executing the target action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const recordedResult = {
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'Recorded' }],
      nextCursor: null,
    };
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's2', active: false, presence: 'offline', updatedAt: 1, title: 'Duplicate' }],
      nextCursor: null,
    }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'approve' as const,
      request: {
        ...request,
        status: 'executed' as const,
        decision: { kind: 'approve' as const, decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true as const, result: recordedResult },
      },
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      { limit: 10 },
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: true, result: recordedResult });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ status: 'executed' }),
    }));
  });

  it('executes a concurrently approved blocking action exactly once', async () => {
    let storedRequest: ApprovalRequest | null = null;
    let resolveWaiter: ((request: ApprovalRequest) => void) | null = null;
    let markWaiterReady: (() => void) | null = null;
    const waiterReady = new Promise<void>((resolve) => {
      markWaiterReady = resolve;
    });
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { artifactId: 'a1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      if (request.status === 'approved') resolveWaiter?.(request);
      return { ok: true as const };
    });
    const approvalsResolveBlockingDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      resolveWaiter?.(request);
      return { resolved: true };
    });
    const approvalsWaitForDecision = vi.fn(async () => {
      markWaiterReady?.();
      const request = await new Promise<ApprovalRequest>((resolveDecision) => {
        resolveWaiter = resolveDecision;
      });
      return { decision: 'approve' as const, request };
    });
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const blockingCall = executor.execute('session.list' as any, {}, { surface: 'mcp', authority: 'present_user' });

    await waiterReady;
    const decideResult = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });
    const blockingResult = await blockingCall;

    expect(decideResult.ok).toBe(true);
    expect(blockingResult).toEqual({
      ok: true,
      result: {
        sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
        nextCursor: null,
      },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('returns approval_rejected when a blocking approval is rejected', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const approvalsWaitForDecision = vi.fn(async ({ request }: { request: ApprovalRequest }) => ({
      decision: 'reject' as const,
      request,
    }));

    const executor = createExecutor({
      approvalsCreate,
      approvalsUpdate,
      approvalsWaitForDecision,
      sessionList,
      isActionApprovalRequired: (actionId) => actionId === 'session.list',
    } as any);

    const res = await executor.execute(
      'session.list' as any,
      {},
      { surface: 'mcp' },
    );

    expect(res).toEqual({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
    expect(sessionList).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'rejected',
        decision: expect.objectContaining({ kind: 'reject' }),
      }),
    }));
  });

  it('routes session.title.set through approvals when required by the caller policy', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const sessionTitleSet = vi.fn(async () => ({ ok: true }));

    const executor = createExecutor({
      approvalsCreate,
      sessionTitleSet,
      isActionApprovalRequired: (actionId) => actionId === 'session.title.set',
    } as any);

    const res = await executor.execute(
      'session.title.set' as any,
      { sessionId: 's1', title: 'Renamed' },
      { surface: 'mcp' },
    );

    expect(res.ok).toBe(true);
    expect((res as any).result?.kind).toBe('approval_request_created');
    expect((res as any).result?.artifactId).toBe('a1');
    expect(sessionTitleSet).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'session.title.set',
        createdBy: expect.objectContaining({ surface: 'mcp', sessionId: 's1' }),
      }),
    }));
  });

  it('allows approval.request.create for a non-internal, non-approval Action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'agents.backends.list',
      actionArgs: {},
      summary: 'List backends',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'agents.backends.list',
        summary: 'List agent backends — s1',
      }),
    }));
  });

  it.each([
    {
      actionId: 'teams.invitations.accept.prepareApproval',
      actionArgs: { v: 1, token: 's'.repeat(43) },
    },
    {
      actionId: 'sessions.subagents.upsert',
      actionArgs: {
        id: 'subagent-1',
        parentSessionId: 's1',
        origin: 'agent',
        kind: 'native',
        status: 'running',
      },
    },
  ] as const)('rejects a public approval request targeting internal Action $actionId', async ({ actionId, actionArgs }) => {
    const persistedRequests: ApprovalRequest[] = [];
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      persistedRequests.push(request);
      return { artifactId: 'must-not-exist' };
    });
    const homeDomainAction = vi.fn(async () => ({ outcome: 'ok' as const }));
    const executor = createExecutor({ approvalsCreate, homeDomainAction } as any);

    await expect(executor.execute('approval.request.create', {
      actionId,
      actionArgs,
      summary: 'Approve internal host work',
      createdBy: { surface: 'system' },
    }, {
      surface: 'mcp',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(homeDomainAction).not.toHaveBeenCalled();
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(persistedRequests).toEqual([]);
    expect(JSON.stringify(persistedRequests)).not.toContain('s'.repeat(43));
  });

  it.each(['decision', 'replay'] as const)(
    'refuses a forged V2 approval targeting an internal Action during $mode',
    async (mode) => {
      const forged = createApprovalRequest('approved', {
        actionId: 'teams.invitations.accept.prepareApproval',
        actionArgs: { v: 1, token: 'f'.repeat(43) },
        summary: 'Forged internal approval',
      });
      const approvalsGet = vi.fn(async () => forged);
      const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
      const homeDomainAction = vi.fn(async () => ({ outcome: 'ok' as const }));
      const executor = createExecutor({ approvalsGet, approvalsUpdate, homeDomainAction } as any);

      const result = mode === 'decision'
        ? await executor.execute('approval.request.decide', {
            artifactId: 'forged-internal-approval',
            decision: 'approve',
          })
        : await executor.replayApprovedApprovalRequest({ artifactId: 'forged-internal-approval' });

      expect(result).toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(homeDomainAction).not.toHaveBeenCalled();
    },
  );

  it('rejects deciding approval artifacts that target approval queue actions', async () => {
    for (const actionId of ['approval.request.list', 'approval.request.get'] as const) {
      const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
        actionId,
        actionArgs: actionId === 'approval.request.get' ? { artifactId: 'a2' } : {},
        summary: 'Nested approval action',
      }));
      const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
      const approvalsList = vi.fn(async () => ({ items: [], queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } }));

      const executor = createExecutor({
        approvalsGet,
        approvalsUpdate,
        approvalsList,
      } as any);

      const res = await executor.execute('approval.request.decide' as any, {
        artifactId: 'a1',
        decision: 'approve',
      });

      expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(approvalsList).not.toHaveBeenCalled();
    }
  });

  it('creates an approval request via deps.approvalsCreate', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        status: 'open',
        actionId: 'session.message.send',
        summary: 'Send a message to a session — s1',
      }),
    }));
  });

  it('inherits transcript tool-call origin metadata from context for approval.request.create', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    }, {
      surface: 'agent',
      defaultSessionId: 's1',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 's1',
        messageId: 'msg-context',
        toolCallId: 'tool-context',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        origin: {
          kind: 'transcript_tool_call',
          sessionId: 's1',
          messageId: 'msg-context',
          toolCallId: 'tool-context',
          toolName: 'approval_request_create',
          toolInput: { actionId: 'session.message.send' },
        },
      }),
    }));
  });

  it('rejects approval.request.create when target action args fail target schema validation', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: '' },
      summary: 'Send message',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('rejects creating approval requests with a blank (trimmed) summary', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: '   ',
      createdBy: { surface: 'system' },
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('forces approval.request.create createdBy.surface to match the execution surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli' },
    }, {
      surface: 'mcp',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
        }),
      }),
    }));
  });

  it('host-stamps plugin provenance for approval-queue requests without publishing the raw action', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));
    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'cli', pluginId: 'forged.plugin' },
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'acme.plugin',
        contributionLocalId: 'approval-queue',
        occurrenceId: 'plugin-occurrence-1',
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
      },
      defaultSessionId: 'requesting-session',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: {
          surface: 'system',
          pluginId: 'acme.plugin',
          contributionLocalId: 'approval-queue',
          sessionId: 'requesting-session',
        },
        requestedSurface: 'plugin',
      }),
    }));
  });

  it('links approval.request.create cross-session approvals to the requesting session', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 'target-session', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 'injected-session' },
    }, {
      surface: 'mcp',
      defaultSessionId: 'requesting-session',
      approvalOrigin: {
        kind: 'transcript_tool_call',
        sessionId: 'requesting-session',
        toolCallId: 'tool-create-cross-session',
        toolName: 'approval_request_create',
        toolInput: { actionId: 'session.message.send' },
      },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionArgs: expect.objectContaining({ sessionId: 'target-session' }),
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 'requesting-session',
        }),
        origin: expect.objectContaining({
          sessionId: 'requesting-session',
          toolCallId: 'tool-create-cross-session',
        }),
      }),
    }));
  });

  it('ignores approval.request.create createdBy.sessionId when actionArgs.sessionId is missing and uses ctx.defaultSessionId instead', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'cli', sessionId: 's-injected' },
    }, {
      surface: 'mcp',
      defaultSessionId: 's-default',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        createdBy: expect.objectContaining({
          surface: 'mcp',
          sessionId: 's-default',
        }),
      }),
    }));
  });

  it('persists the server hint on created approval requests when present in the execution context', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
      createdBy: { surface: 'system', sessionId: 's1' },
    }, {
      surface: 'ui',
      serverId: 'server-a',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
      }),
      serverId: 'server-a',
    }));
  });

  it('allows creating approval requests for safe actions (eligibility is policy-driven, not safety-driven)', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'a1' }));

    const executor = createExecutor({ approvalsCreate });

    const res = await executor.execute('approval.request.create' as any, {
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      createdBy: { surface: 'system' },
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'review.start',
        summary: 'Start review — s1',
      }),
    }));
  });

  it('executes the underlying action when an approval is approved', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest());
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    // Decide commits open→approved, claims approved→executing, then settles the
    // terminal row. The claim is what makes the effect exactly-once.
    expect(approvalsUpdate).toHaveBeenCalledTimes(3);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'approved',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executing',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it('admits only one executor for a persisted approved V2 request', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2);
    let storedRequest = createApprovalRequest('approved');
    let releaseEffect!: () => void;
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
    const effectBlocked = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let releaseInitialReads!: () => void;
    const initialReadsCompleted = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    let initialReads = 0;
    const approvalsGet = vi.fn(async () => {
      const snapshot = structuredClone(storedRequest);
      if (snapshot.status === 'approved' && initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await initialReadsCompleted;
      }
      return snapshot;
    });
    let markSecondClaimAttempted!: () => void;
    const secondClaimAttempted = new Promise<void>((resolve) => { markSecondClaimAttempted = resolve; });
    let claimAttempts = 0;
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (request.status === 'executing') {
        claimAttempts += 1;
        if (claimAttempts === 2) markSecondClaimAttempted();
      }
      // Match the real Artifact adapter contract: terminal equality is
      // idempotent, while observing an equal executing row loses the claim.
      if (isDeepStrictEqual(storedRequest, request)) {
        return request.status === 'executing'
          ? { ok: false as const, errorCode: 'invalid_transition', error: 'approval_request_invalid_transition' }
          : { ok: true as const };
      }
      const isExecutionClaim = storedRequest.status === 'approved' && request.status === 'executing';
      const isTerminal = storedRequest.status === 'executing'
        && (request.status === 'executed' || request.status === 'failed');
      if (!isExecutionClaim && !isTerminal) {
        return { ok: false as const, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
      }
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    let effects = 0;
    const sessionSendMessage = vi.fn(async () => {
      effects += 1;
      markEffectStarted();
      await effectBlocked;
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const decide = executor.execute('approval.request.decide', {
      artifactId: 'a1', decision: 'approve',
    });
    const replay = executor.replayApprovedApprovalRequest({ artifactId: 'a1' });
    await effectStarted;
    await secondClaimAttempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(effects).toBe(1);

    const loser = await Promise.race([decide, replay]);
    expect(loser).toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executing');

    const freshExecutor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });
    await expect(freshExecutor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);

    releaseEffect();
    await Promise.all([decide, replay]);
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executed');
    dateNow.mockRestore();
  });

  it('reports outcome unknown when the effect succeeds but terminal persistence fails', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (storedRequest.status === 'approved' && request.status === 'executing') {
        storedRequest = structuredClone(request);
        return { ok: true as const };
      }
      return { ok: false as const, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });
    expect(sessionSendMessage).toHaveBeenCalledOnce();
    expect(storedRequest.status).toBe('executing');
  });

  it('reports outcome unknown when the terminal persistence write throws a transport error', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      if (storedRequest.status === 'approved' && request.status === 'executing') {
        storedRequest = structuredClone(request);
        return { ok: true as const };
      }
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    let effects = 0;
    const sessionSendMessage = vi.fn(async () => {
      effects += 1;
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
      error: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
    expect(storedRequest.status).toBe('executing');

    // The claim stays persisted, so a replay of the same Artifact reports the
    // same post-effect uncertainty rather than running the effect again.
    const freshExecutor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });
    await expect(freshExecutor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'approval_execution_outcome_unknown',
    });
    expect(effects).toBe(1);
  });

  it('persists strict Board conflict details after deferred approval execution', async () => {
    const boardInput = {
      sessionId: 's1',
      expectedLayoutRevision: null,
      operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
    };
    let storedRequest = createApprovalRequest('approved', {
      actionId: 'session.board.layout.update',
      actionArgs: boardInput,
      requestedSurface: 'mcp',
      createdBy: { surface: 'mcp', sessionId: 's1' },
    });
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const sessionBoardAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'session_board_revision_conflict' as const,
      error: 'session_board_revision_conflict' as const,
      details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
    }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionBoardAction });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: {
          ok: false,
          errorCode: 'session_board_revision_conflict',
          details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        },
      },
    });
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: {
        ok: false,
        errorCode: 'session_board_revision_conflict',
        details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
      },
    });
  });

  it('preserves a request-bound Board outcome-unknown recovery packet after deferred approval', async () => {
    const boardInput = {
      sessionId: 's1',
      expectedLayoutRevision: null,
      operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
    };
    const mutationRequest = {
      operation: 'update_layout' as const,
      expectedLayoutRevision: null,
      layoutContent: {
        t: 'plain' as const,
        v: { v: 1 as const, tabs: [{ id: 'overview', title: 'Overview', items: [] }] },
      },
    };
    const recovery = {
      v: 1 as const,
      actionId: 'session.board.layout.update' as const,
      serverId: 'server-1',
      sessionId: 's1',
      requestBody: JSON.stringify(mutationRequest),
      mutationRequest,
      intent: boardInput,
    };
    let storedRequest = createApprovalRequest('approved', {
      actionId: 'session.board.layout.update',
      actionArgs: boardInput,
      requestedSurface: 'mcp',
      createdBy: { surface: 'mcp', sessionId: 's1' },
    });
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionBoardAction: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'outcome_unknown' as const,
        error: 'outcome_unknown' as const,
        details: { recovery },
      })),
    });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'outcome_unknown', details: { recovery } },
      },
    });
    expect(storedRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'outcome_unknown', details: { recovery } },
    });
  });

  it('does not persist unvalidated failure details from another Action family', async () => {
    let storedRequest = createApprovalRequest('approved');
    const approvalsGet = vi.fn(async () => structuredClone(storedRequest));
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = structuredClone(request);
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'action_failed',
      error: 'action_failed',
      details: { bearer: 'must-not-persist' },
    }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await executor.replayApprovedApprovalRequest({ artifactId: 'a1' });
    expect(storedRequest.execution).toEqual({
      executedAtMs: expect.any(Number),
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
    });
  });

  it('persists the present-user decision before delegating exact-daemon replay', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const approvalRequestApprovedReplay = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      expect(request).toMatchObject({
        status: 'approved',
        decision: { kind: 'approve' },
      });
      expect(storedRequest).toEqual(request);
      return {
        ok: true as const,
        result: { ok: true as const, status: 'executed' as const },
      };
    });

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      approvalRequestApprovedReplay,
    });

    await expect(executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    })).resolves.toEqual({
      ok: true,
      result: { ok: true, status: 'executed' },
    });

    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
    expect(approvalRequestApprovedReplay).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'approved',
        decision: expect.objectContaining({ kind: 'approve' }),
      }),
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('never delegates a rejected decision to an execution host', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalRequestApprovedReplay = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true as const, status: 'executed' as const },
    }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalRequestApprovedReplay,
    });

    await expect(executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'reject',
    })).resolves.toEqual({
      ok: true,
      result: { ok: true, status: 'rejected' },
    });
    expect(approvalRequestApprovedReplay).not.toHaveBeenCalled();
  });

  it('replays only an already-approved Artifact through the immutable origin', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_not_approved',
      error: 'approval_not_approved',
    });
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();

    storedRequest = createApprovalRequest('approved');
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    // Replay owns no decision authority, so it writes only the claim and the
    // terminal row — never a decision.
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-1',
      request: expect.objectContaining({ status: 'executing' }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-1',
      request: expect.objectContaining({ status: 'executed' }),
    }));
  });

  it('returns an approved blocking decision without executing when an external waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      approval: { flow: 'blocking', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: true }));
    const sessionList = vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }] }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'approved',
      },
    });
    expect(approvalsResolveBlockingDecision).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      decision: 'approve',
      request: expect.objectContaining({
        status: 'approved',
        actionId: 'session.list',
      }),
    }));
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('executes an approved blocking decision when no live waiter owns execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'session.list',
      actionArgs: {},
      // Even a stale/manually-created deferred request cannot turn the
      // Artifact into durable bearer custody.
      approval: { flow: 'deferred', result: 'required' },
      summary: 'List sessions',
      requestedSurface: 'mcp',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsResolveBlockingDecision = vi.fn(async () => ({ resolved: false }));
    const sessionList = vi.fn(async () => ({
      sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
      nextCursor: null,
    }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsResolveBlockingDecision,
      sessionList,
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({
          ok: true,
          result: {
            sessions: [{ id: 's1', active: false, presence: 'offline', updatedAt: 1, title: 'One' }],
            nextCursor: null,
          },
        }),
      },
    });
    expect(sessionList).toHaveBeenCalledTimes(1);
  });

  it('marks legacy V1 approvals stale before effects because their execution origin is unprovable', async () => {
    let legacyRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system', sessionId: 's1' },
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
    };
    const approvalsGet = vi.fn(async () => legacyRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      legacyRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'approval_stale' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(legacyRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('terminalizes an already-approved legacy V1 replay that cannot prove its execution origin', async () => {
    let legacyRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'approved',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system', sessionId: 's1' },
      decision: { kind: 'approve', decidedAtMs: 2 },
      actionId: 'session.message.send',
      actionArgs: { sessionId: 's1', message: 'hello' },
      summary: 'Send message',
    };
    const approvalsGet = vi.fn(async () => legacyRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      legacyRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'approval_stale' }),
      },
    });
    expect(approvalsUpdate).toHaveBeenCalledOnce();
    expect(sessionSendMessage).not.toHaveBeenCalled();
    expect(legacyRequest).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });

  it('does not re-route already-approved actions through approvals when executing them', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { createdBy: { surface: 'mcp', sessionId: 's1' } }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'nested' }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      approvalsCreate,
      sessionSendMessage,
      isActionApprovalRequired: (actionId, ctx) => actionId === 'session.message.send' && ctx.surface === 'mcp',
    } as any);

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'mcp',
      authority: 'present_user',
    });

    expect(res.ok).toBe(true);
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
  });

  it('uses the stored approval serverId when the decision context omits one', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', { serverId: 'server-a' }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'a1', serverId: null });
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-a',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'approved',
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'executing',
      }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      artifactId: 'a1',
      serverId: 'server-a',
      request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ serverId: 'server-a' }),
        status: 'executed',
      }),
    }));
  });

  it('executes approved prompt library actions even when the decision surface is ui', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      actionId: 'prompt_doc.update',
      actionArgs: {
        artifactId: 'doc-1',
        title: 'Review prompt',
        markdown: '# Review',
      },
      summary: 'Update prompt',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, promptDocUpdate });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(promptDocUpdate).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
    });
  });

  it('does not bypass per-surface disablement when executing approved actions', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'system', sessionId: 's1' },
      requestedSurface: 'agent',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'agent',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not bypass per-surface disablement when executing approvals created from the CLI surface', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('open', {
      createdBy: { surface: 'cli', sessionId: 's1' },
      requestedSurface: 'cli',
    }));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSendMessage,
      isActionEnabled: (_id, ctx) => ctx.surface !== 'cli',
    });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    }, {
      surface: 'ui',
      authority: 'present_user',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: expect.objectContaining({ ok: false, errorCode: 'action_disabled' }),
      },
    });
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('resumes an already-approved approval by finalizing execution', async () => {
    const approvalsGet = vi.fn(async () => createApprovalRequest('approved'));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(res.ok).toBe(true);
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    // Resuming an already-approved row still claims it before the effect.
    expect(approvalsUpdate).toHaveBeenCalledTimes(2);
    expect(approvalsUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({ status: 'executing' }),
    }));
    expect(approvalsUpdate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      artifactId: 'a1',
      request: expect.objectContaining({
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      }),
    }));
  });

  it.each([
    {
      status: 'rejected',
      decision: 'reject',
      expected: { ok: true, result: { ok: true, status: 'rejected' } },
    },
    {
      status: 'executed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'executed', execution: expect.objectContaining({ ok: true }) },
      },
    },
    {
      status: 'failed',
      decision: 'approve',
      expected: {
        ok: true,
        result: { ok: true, status: 'failed', execution: expect.objectContaining({ ok: false, errorCode: 'action_failed' }) },
      },
    },
  ] as const)('returns the existing terminal result for duplicate $decision decisions on $status approvals', async ({ status, decision, expected }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual(expected);
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('persists only the safe projection when an invitation outlives its live caller', async () => {
    const invitation = {
      id: 'invitation-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const rawResult = {
      invitation,
      joinUrl: 'https://home.example/join/one-time-bearer',
    };
    const request = createApprovalRequest('open', {
      actionId: 'teams.invitations.create',
      actionArgs: {
        v: 1,
        teamId: 'team-1',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmail: null,
        requestKey: 'request-1',
      },
      // `createdBy` is descriptive Artifact provenance; the immutable
      // execution origin below is the present-user UI authority.
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      approval: { flow: 'blocking', result: 'required' },
    });
    if (request.v !== 2) throw new Error('expected V2 approval fixture');
    const {
      sessionId: _fixtureSessionId,
      target: _fixtureTarget,
      ...originWithoutFixtureSession
    } = request.executionOriginV1;
    let storedRequest: ApprovalRequestV2 = {
      ...request,
      executionOriginV1: {
        ...originWithoutFixtureSession,
        authority: 'present_user',
        surface: 'ui',
      },
    };
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request: next }: { request: ApprovalRequest }) => {
      if (next.v !== 2) throw new Error('expected V2 approval update');
      storedRequest = next;
      return { ok: true as const };
    });
    const homeDomainAction = vi.fn(async () => rawResult);
    const executor = createExecutor({ approvalsGet, approvalsUpdate, homeDomainAction });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'a1',
      decision: 'approve',
    })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: {
          executedAtMs: expect.any(Number),
          ok: true,
          result: { invitation, joinUrl: null },
        },
      },
    });

    // The Artifact is history, not bearer custody. The raw result is
    // intentionally unrecoverable after the live blocking invocation is lost.
    expect(storedRequest.execution).toEqual({
      executedAtMs: expect.any(Number),
      ok: true,
      result: { invitation, joinUrl: null },
    });
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'a1' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        execution: { ok: true, result: { invitation, joinUrl: null } },
      },
    });
    expect(homeDomainAction).toHaveBeenCalledTimes(1);
    expect(approvalsUpdate).toHaveBeenCalledTimes(3);
  });

  it.each([
    { status: 'approved', decision: 'reject' },
    { status: 'rejected', decision: 'approve' },
    { status: 'executed', decision: 'reject' },
    { status: 'failed', decision: 'reject' },
    { status: 'canceled', decision: 'approve' },
    { status: 'canceled', decision: 'reject' },
  ] as const)('rejects deciding a $status approval without mutating or executing', async ({ status, decision }) => {
    const approvalsGet = vi.fn(async () => createApprovalRequest(status));
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const res = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision,
    });

    expect(res).toEqual({ ok: false, errorCode: 'approval_not_open', error: 'approval_not_open' });
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(sessionSendMessage).not.toHaveBeenCalled();
  });

  it('does not re-execute an approval on duplicate approve delivery', async () => {
    let storedRequest = createApprovalRequest('open');
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));

    const executor = createExecutor({ approvalsGet, approvalsUpdate, sessionSendMessage });

    const first = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });
    const second = await executor.execute('approval.request.decide' as any, {
      artifactId: 'a1',
      decision: 'approve',
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        execution: expect.objectContaining({ ok: true }),
      },
    });
    expect(sessionSendMessage).toHaveBeenCalledTimes(1);
    // approved, executing, executed. The duplicate delivery reads the terminal
    // row and writes nothing.
    expect(approvalsUpdate).toHaveBeenCalledTimes(3);
  });

  // FINALIZATION-PLAN §3.2 activation proof: after the per-family `RUNTIME_ACTION_DISABLED_SURFACES`
  // flip, a dangerous AGENT-initiated runtime action now passes the enablement gate and REACHES the
  // surface-keyed approval floor (`AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS`, wired through the
  // real `isApprovalRequiredByActionsSettings`) — it is no longer short-circuited by `action_disabled`
  // (finding #31). User-initiated forms execute the runtime directly with no prompt.
  describe('§3.2 agent-approval activation (runtime families flipped on agent)', () => {
    // `browser.context.capturePage` is approval-floored for `agent` AND in
    // RESULT_REQUIRED → a `blocking` approval flow, so the executor waits for a decision. We
    // resolve the decision deterministically per-test to prove the routing path.
    const wireApprovalFloor = (
      runtimeActionExecute: ReturnType<typeof vi.fn>,
      approvalsCreate: ReturnType<typeof vi.fn>,
      decision: 'approve' | 'reject' = 'reject',
    ) =>
      createExecutor({
        runtimeActionExecute,
        approvalsCreate,
        approvalsWaitForDecision: vi.fn(async ({ request }: any) => ({
          decision,
          request: {
            ...request,
            status: decision === 'approve' ? 'approved' : 'rejected',
            decision: { kind: decision === 'approve' ? 'approve' : 'reject', decidedAtMs: 2 },
          },
        })),
        approvalsUpdate: vi.fn(async () => ({ ok: true })),
        // Wire the REAL surface-keyed approval floor exactly as the production default executor
        // does, with no persisted overrides — the dangerous agent subset must still be gated.
        isActionApprovalRequired: (actionId, ctx) =>
          isApprovalRequiredByActionsSettings(actionId, defaultActionsSettings, ctx),
      } as any);
    const capturedPageResult = {
      v: 1,
      kind: 'browserPageReference',
      contextId: 'context_1',
      sourceViewId: 'v1',
      sourceAdapterKind: 'localPreview',
      fidelity: 'previewProxy',
      capturedAtMs: 1,
      navigationGeneration: 0,
      lifecycleState: 'available',
      redactionLevel: 'none',
    } as const;
    const attachedContextResult = {
      v: 1,
      attachmentId: 'attachment_1',
      contextId: 'context_1',
      sourceViewId: 'v1',
      capturedNavigationGeneration: 0,
      currentNavigationGeneration: 0,
      state: 'available',
    } as const;

    it('routes an agent-initiated dangerous capture to the approval gate (not action_disabled)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ captured: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Reaches the APPROVAL gate (NOT the disabled gate); rejected → runtime never runs. This is
      // the §3.2 activation proof: pre-flip this would have short-circuited to `action_disabled`.
      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('runs the runtime executor for an agent capture once approval is granted', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-3' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'approve');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
    });

    it('executes the same capture user-initiated (ui) with no approval prompt', async () => {
      const runtimeActionExecute = vi.fn(async () => capturedPageResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'cap-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.capturePage' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({ ok: true, result: capturedPageResult });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('routes agent-initiated browser context attach to approvals by default', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ attached: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      expect((res as any).errorCode).toBe('approval_rejected');
      expect(approvalsCreate).toHaveBeenCalledTimes(1);
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });

    it('keeps user-initiated browser context attach unprompted', async () => {
      const runtimeActionExecute = vi.fn(async () => attachedContextResult);
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'attach-2' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'browser.context.attachToComposer' as any,
        { browserSessionId: 'bs1', viewId: 'v1' },
        { surface: 'ui', defaultSessionId: 's1' },
      );

      expect(res).toEqual({
        ok: true,
        result: {
          ...attachedContextResult,
          requiresReconfirmBeforeSend: false,
        },
      });
      expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
      expect(approvalsCreate).not.toHaveBeenCalled();
    });

    it('still fail-closes an unsurfaced runtime action on agent (devices.simulator.input.orientation)', async () => {
      const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'd-1' }));
      const executor = wireApprovalFloor(runtimeActionExecute, approvalsCreate, 'reject');

      const res = await executor.execute(
        'devices.simulator.input.orientation' as any,
        { type: 'simulator.input.orientation', orientation: 'landscapeLeft' },
        { surface: 'agent', defaultSessionId: 's1' },
      );

      // Statically-unbacked (no producer) → UNSURFACED on every surface; the approval gate is never
      // reached. (The browser-diagnostics interaction verbs are now executor-backed and surfaced.)
      expect(res).toEqual(expect.objectContaining({
        ok: false,
        errorCode: 'action_disabled',
        error: 'action_disabled',
        details: expect.objectContaining({
          actionId: 'devices.simulator.input.orientation',
          surface: 'agent',
          reason: 'unsupported_surface',
        }),
      }));
      expect(approvalsCreate).not.toHaveBeenCalled();
      expect(runtimeActionExecute).not.toHaveBeenCalled();
    });
  });
});
