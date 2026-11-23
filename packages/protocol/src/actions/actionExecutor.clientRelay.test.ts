import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from './actionIds.js';
import { WORKFLOW_AUTHORING_ACTION_ID } from './workflowAuthoringActionIds.js';
import { ActionDefinitionSummaryV1Schema } from './actionDefinitionV1.js';
import { UiActionChildExecuteRequestV1Schema, mountedWorkReadClientRpcMethod, isMountedWorkReadClientRpcMethod, clientActionUnavailable, UiActionDispatchRequestV1Schema, parseClientActionDispatchResult } from './clientDispatchV1.js';

describe('client placement delivery after canonical admission', () => {
  it('retains the mounted Save caller for exact Workflow operations and safe setup reads', async () => {
    const read = { pluginId: 'fixture.setup', localId: 'observation' };
    const write = { pluginId: 'fixture.setup', localId: 'write' };
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const triggerInput = {
      workflow: '11111111-1111-4111-8111-111111111111',
      project: { machineId: 'machine-a', directory: '/workspace' },
      trigger: { kind: 'schedule', enabled: true,
        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null } },
    };
    const caller = { surface: 'agent', authority: 'account_automation', serverId: scope.serverId,
      actionRequestId: 'mounted-workflow-save',
      executeOrdinaryChildAction: async (actionId: string, input: unknown, options?: { actionRequestId?: string }) => {
        issued.push({ actionId, input, requestId: options?.actionRequestId });
        return actionId === ACTION_INVOKE_ACTION_ID_V1
          ? { ok: true as const, result: { sourceInstanceId: 'source-a' } }
          : { ok: false as const, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      },
      runtimeAccountId: scope.accountId, defaultSessionId: 'session-a',
      actionCaller: { kind: 'session', sessionId: 'session-a' } } as const;
    const issued: { actionId: string; input: unknown; requestId?: string }[] = [];
    const deps = {
      listContributedActionDefinitions: () => [
        { localId: read.localId, sideEffectClass: 'read' },
        { localId: write.localId, sideEffectClass: 'write' },
      ].map(({ localId, sideEffectClass }) => ActionDefinitionSummaryV1Schema.parse({
        id: `fixture.setup/actions/${localId}`, sideEffectClass, safety: 'safe', title: localId,
        description: null, slash: null, placements: [], bindings: null, examples: null,
        surfaces: { agent: true }, inputHints: null,
      })),
      // Home refuses a plugin read proved by the parent's mounted-write authorization.
      invokeContributedAction: async () => ({ ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' }),
      clientActionExecute: async ({ executeChild }) => {
        const child = (action: typeof read) => UiActionChildExecuteRequestV1Schema.parse({
          v: 1, parentRequestId: 'parent-a', sessionId: 'session-a', actionId: ACTION_INVOKE_ACTION_ID_V1,
          input: { action, input: {} },
        });
        const allowed = child(read);
        const denied = child(write);
        const execution = await executeChild!(allowed.actionId, allowed.input);
        expect(parseClientActionDispatchResult(allowed.actionId, { v: 1, execution }))
          .toMatchObject({ ok: true, result: { sourceInstanceId: 'source-a' } });
        expect(await executeChild!(denied.actionId, denied.input)).toMatchObject({ ok: false, errorCode: 'permission_denied' });
        const trigger = UiActionChildExecuteRequestV1Schema.parse({
          v: 1, parentRequestId: 'parent-a', sessionId: 'session-a', actionId: 'workflow.trigger.add',
          input: triggerInput,
        });
        expect(await executeChild!(trigger.actionId, trigger.input)).toMatchObject({
          ok: false, errorCode: 'approval_context_unavailable',
        });
        return { ok: true, result: { status: 'applied' } };
      },
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute(WORKFLOW_AUTHORING_ACTION_ID.draftSave, { scope, draftId: 'draft-a' }, caller))
      .toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(issued).toEqual([
      { actionId: ACTION_INVOKE_ACTION_ID_V1, input: { action: read, input: {} }, requestId: expect.any(String) },
      { actionId: 'workflow.trigger.add', input: triggerInput, requestId: expect.any(String) },
    ]);
    expect(new Set([caller.actionRequestId, ...issued.map(operation => operation.requestId)]).size).toBe(3);
  });
  it('preserves automation notices beside successful and refused Usage history results', () => {
    const result = { status: 'idle', progress: { selected: 0, notRead: 0, completed: 0, failed: 0 } };
    const automationNotices = [{ code: 'action_automations_not_checked', reason: 'not_found' }];
    const success = { ok: true, result, automationNotices };
    const refusal = { ok: false, errorCode: 'unavailable', error: 'unavailable', automationNotices };
    for (const execution of [success, refusal]) {
      expect(parseClientActionDispatchResult('usage.history.read', { v: 1, execution })).toEqual(execution);
    }
    expect(parseClientActionDispatchResult('usage.history.read', { v: 1,
      execution: { ...success, result: { status: 'idle' } } })).toBeNull();
    expect(parseClientActionDispatchResult('usage.history.read', { v: 1,
      execution: { ...success, automationNotices: [{ code: 'unknown_notice', reason: 'not_found' }] } })).toBeNull();
  });
  it('distinguishes a missing answering view from an unavailable navigation host', async () => {
    expect(clientActionUnavailable('session.pending.next'))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
    expect(await createActionExecutor({} as ActionExecutorDeps).execute('session.pending.next', {}, { surface: 'ui' }))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'no_navigation_host' } });
  });
  it.each([
    { actionId: 'workspace.tabs.list', input: {}, result: { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null } },
    { actionId: 'updates.get', input: {}, result: { groups: [], batch: null } },
    { actionId: 'app.updates.get', input: {}, result: { channel: 'web-ui', state: 'upToDate', currentVersion: '0.3', latestVersion: null, checkedAt: null, action: null, skipped: false, canSkip: false } },
    { actionId: 'account.signOut', input: { serverId: 'home', accountId: 'account' }, result: { status: 'signed_out' } },
    { actionId: 'bugreport.submit', input: { draft: { title: 'Report', summary: 'Summary', reproductionStepsText: '', whatChangedRecently: '', environment: { appVersion: '0.3', platform: 'web', deploymentType: 'self-hosted' }, includeDiagnostics: false, acceptedPrivacyNotice: false }, destination: { providerUrl: 'https://reports.example.test', issueOwner: 'happier-dev', issueRepo: 'happier' } }, result: { mode: 'submitted', reportId: 'report', issueNumber: 1, issueUrl: 'https://github.com/happier-dev/happier/issues/1', artifactCount: 0 } },
  ] as const)('admits CLI $actionId through the strict client carrier and refuses absent owners', async request => {
    // The answering app is a separate process; keep admission and both wire schemas real.
    const clientActionExecute: NonNullable<ActionExecutorDeps['clientActionExecute']> = async invocation => {
      const wire = UiActionDispatchRequestV1Schema.parse({ v: 1, ...invocation,
        context: { surface: invocation.context.surface, authority: invocation.context.authority } });
      expect(wire).toMatchObject({ actionId: request.actionId, input: request.input,
        context: { surface: 'cli', authority: 'account_automation' } });
      return parseClientActionDispatchResult(wire.actionId, { v: 1, execution: { ok: true, result: request.result } })
        ?? { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' };
    };
    const context = { surface: 'cli', authority: 'account_automation', bypassApprovals: true } as const;
    expect(await createActionExecutor({ clientActionExecute } as ActionExecutorDeps).execute(request.actionId, request.input, context))
      .toEqual({ ok: true, result: request.result });
    const absent: NonNullable<ActionExecutorDeps['clientActionExecute']> = async ({ actionId }) => clientActionUnavailable(actionId);
    expect(await createActionExecutor({ clientActionExecute: absent } as ActionExecutorDeps).execute(request.actionId, request.input, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
  it('recognizes only the mounted Work/Inbox reverse method family, preserving encoded Session identities', () => {
    for (const sessionId of ['lead', 'with/%/separators', '\u0800'.repeat(600), '\ud800']) {
      expect(isMountedWorkReadClientRpcMethod(mountedWorkReadClientRpcMethod('session.work.get', sessionId))).toBe(true);
    }
    expect(isMountedWorkReadClientRpcMethod(mountedWorkReadClientRpcMethod('inbox.get'))).toBe(true);
    for (const method of ['ui.actions.execute.v1', 'ui.actions.execute.v1.work.', 'ui.actions.execute.v1.work.%20',
      'ui.actions.execute.v1.work.%ZZ', 'ui.actions.execute.v1.work.%7B%7D', 'ui.actions.execute.v1.inbox.extra']) {
      expect(isMountedWorkReadClientRpcMethod(method)).toBe(false);
    }
  });
  it.each([
    { actionId: 'ui.find' as const, input: { op: 'read' }, result: { status: 'idle' } },
    { actionId: 'session.pending.next' as const, input: {}, result: { status: 'opened' } },
    { actionId: 'workspace.tabs.list' as const, input: {}, result: { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null } },
  ])('delivers $actionId on the invoking surface', async ({ actionId, input, result }) => {
    const requests: unknown[] = [];
    const deps = {
      clientActionExecute: async (request: unknown) => { requests.push(request); return { ok: true as const, result }; },
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    expect(await executor.execute(actionId, input, { surface: 'mcp', authority: 'account_automation' }))
      .toEqual({ ok: true, result });
    expect(requests).toEqual([expect.objectContaining({ actionId, input, context: expect.objectContaining({ surface: 'mcp', authority: 'account_automation' }) })]);
  });

  it.each([
    { actionId: 'session.draft.delete' as const, input: { draftId: '11111111-1111-4111-8111-111111111111' } },
    { actionId: 'prompts.invocation.create' as const, input: { token: '/new', title: 'New', target: { kind: 'doc', artifactId: 'doc' } } },
    { actionId: 'prompts.invocation.update' as const, input: { invocationId: 'saved', expectedRevision: 4, token: '/new', title: 'New', target: { kind: 'doc', artifactId: 'doc' } } },
    { actionId: 'prompts.invocation.delete' as const, input: { invocationId: 'saved', expectedRevision: 4 } },
  ])('does not dispatch $actionId without approval', async ({ actionId, input }) => {
    let issued = false;
    const executor = createActionExecutor({ clientActionExecute: async () => {
      issued = true; return { ok: true, result: {} };
    } } as unknown as ActionExecutorDeps);
    const result = await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(issued).toBe(false);
  });
});
