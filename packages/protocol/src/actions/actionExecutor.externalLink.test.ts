import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

describe('answering-client external links', () => {
  it('opens nothing without an answering client, for unsupported schemes, or after cancellation', async () => {
    const id = ActionIdSchema.parse('links.openExternal');
    const opened: string[] = [];
    const deps = { externalUrlOpen: async ({ url }) => { opened.push(url); return { status: 'opened' as const }; } } satisfies Partial<ActionExecutorDeps>;
    const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await createActionExecutor({}).execute(id, { url: 'https://example.test' }, person)).toMatchObject({ ok: false });
    const executor = createActionExecutor(deps);
    expect(await executor.execute(id, { url: 'file:///private' }, person)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const lifetime = new AbortController();
    lifetime.abort();
    expect(await executor.execute(id, { url: 'https://example.test' }, { ...person, signal: lifetime.signal })).toMatchObject({ ok: false });
    expect(opened).toEqual([]);
  });

  it('refuses redacted capability templates before opening and accepts an issued link', async () => {
    const opened: string[] = [];
    const executor = createActionExecutor({ externalUrlOpen: async ({ url }) => {
      opened.push(url); return { status: 'opened' as const };
    } });
    const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    for (const url of ['https://viewer.test/s/:lookup', 'https://viewer.test/s/%3Alookup',
      'https://viewer.test/share/:token', 'https://viewer.test/a/:artifact']) {
      expect(await executor.execute('links.openExternal', { url }, person)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(opened).toEqual([]);
    const url = 'https://viewer.test/s/issued-lookup#k=private-fragment';
    expect(await executor.execute('links.openExternal', { url }, person)).toEqual({ ok: true, result: { status: 'opened' } });
    expect(opened).toEqual([url]);
  });

  it.each(['reject', 'canceled'] as const)('does not open a link after an approval %s', async decision => {
    const id = ActionIdSchema.parse('links.openExternal');
    const opened: string[] = [];
    const deps = {
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async () => ({ artifactId: 'link-decision' }),
      approvalsUpdate: async () => ({ ok: true as const }),
      approvalsWaitForDecision: async ({ request }) => ({ decision,
        request: { ...request, status: decision === 'reject' ? 'rejected' as const : 'canceled' as const,
          ...(decision === 'reject' ? { decision: { kind: 'reject' as const, decidedAtMs: Date.now() } } : {}) } }),
      externalUrlOpen: async ({ url }) => { opened.push(url); return { status: 'opened' as const }; },
    } satisfies Partial<ActionExecutorDeps>;
    expect(await createActionExecutor(deps).execute(id, { url: 'https://example.test' }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'link-decision', defaultSessionMachineId: 'client',
    })).toMatchObject({ ok: false, errorCode: decision === 'reject' ? 'approval_rejected' : 'approval_canceled' });
    expect(opened).toEqual([]);
  });
  it.each(['agent', 'voice'] as const)('executes live egress default, waiver, required and direct person policy on %s through the single Action', async surface => {
    const id = ActionIdSchema.parse('links.openExternal');
    const spec = getActionSpec(id);
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client',
      approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct' }, bindings: { mcpToolName: 'links_open_external' } });
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const opened: string[] = [];
    const deps = {
      // 02102e614e1 / a4a360ea3cc: own-UI Ask uses the native presenter.
      presentUserActionConfirmation: async () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async () => ({ artifactId: 'link-policy' }),
      approvalsUpdate: async () => ({ ok: true as const }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const,
        request: { ...request, status: 'rejected' as const, decision: { kind: 'reject' as const, decidedAtMs: Date.now() } } }),
      externalUrlOpen: async ({ url }) => { opened.push(url); return { status: 'opened' as const }; },
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps, { confirmUiDefault: true });
    const context = { actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account',
      defaultSessionMachineId: 'client', actionRequestId: 'link-policy' } as const;
    const agent = { ...context, surface, authority: 'account_automation' } as const;
    const person = { ...context, surface: 'ui', authority: 'present_user' } as const;
    const input = { url: 'https://example.test/docs' };
    expect(await executor.execute(id, input, { ...agent, actionsSettings: settings })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(opened).toEqual([]);
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: [surface] } });
    expect(await executor.execute(id, input, { ...agent, actionsSettings: settings })).toEqual({ ok: true, result: { status: 'opened' } });
    expect(await executor.execute(id, input, { ...person, actionsSettings: settings })).toEqual({ ok: true, result: { status: 'opened' } });
    // A saved Require overrides a waiver on the actual automation surface.
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: [surface] },
      actions: { [id]: { approvalRequiredSurfaces: [surface] } } });
    expect(await executor.execute(id, input, { ...agent, actionsSettings: settings })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(await executor.execute(id, input, { ...person, actionsSettings: settings })).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    const unmounted = createActionExecutor({ ...deps, presentUserActionConfirmation: undefined });
    expect(await unmounted.execute(id, input, { ...person, actionsSettings: settings })).toMatchObject({
      ok: false, errorCode: 'action_interactive_review_required',
    });
    expect(opened).toEqual([input.url, input.url]);
  });
  it('admits only HTTP(S) links and keeps transient URL values out of observations and approval storage', () => {
    const id = ActionIdSchema.parse('links.openExternal');
    const spec = getActionSpec(id);
    const input = { url: 'https://provider.test/authorize?state=private-state#private-fragment' };
    expect(spec).toMatchObject({ executionPlacement: 'client', approvalInputCustody: 'live_only' });
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
    expect(spec.projectObservationInput?.(input)).toEqual({});
    expect(spec.approvalPresentation?.summary(input)).not.toContain('private-state');
  });

  it('refuses disabled opening before dispatching any external effect and allows an admitted neighbor', async () => {
    const id = ActionIdSchema.parse('links.openExternal');
    const effects: unknown[] = [];
    let enabled = false;
    const executor = createActionExecutor({
      isActionEnabled: () => enabled,
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: ['agent'] } }),
      clientActionExecute: async request => {
        effects.push(request.input);
        return { ok: true, result: { status: 'opened' } };
      },

    });
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    const input = { url: 'https://example.test/docs' };
    expect(await executor.execute(id, input, context)).toMatchObject({ ok: false });
    expect(effects).toEqual([]);
    enabled = true;
    expect(await executor.execute(id, input, context)).toEqual({ ok: true, result: { status: 'opened' } });
    expect(effects).toEqual([input]);
  });

  it('retains an OAuth URL only in live custody while awaiting an automation policy decision', async () => {
    const id = ActionIdSchema.parse('links.openExternal');
    const persisted: ApprovalRequest[] = [];
    const observations: unknown[] = [];
    const opened: string[] = [];
    let created!: () => void;
    const pending = new Promise<void>(resolve => { created = resolve; });
    let approve!: () => void;
    const decision = new Promise<void>(resolve => { approve = resolve; });
    const deps = {
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: Object.fromEntries(ActionIdSchema.options.map(actionId => [actionId, { approvalRequiredSurfaces: [context.surface ?? 'ui'] }])) }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { persisted.push(request); created(); return { artifactId: 'link-approval' }; },
      approvalsUpdate: async ({ request }) => { persisted.push(request); return { ok: true as const }; },
      approvalsWaitForDecision: async ({ request }) => {
        await decision;
        return { decision: 'approve' as const,
          request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: Date.now() } } };
      },
      observeActionExecution: observation => { observations.push(observation); },
      externalUrlOpen: async ({ url }) => { opened.push(url); return { status: 'opened' as const }; },
    } satisfies Partial<ActionExecutorDeps>;
    const url = 'https://provider.test/authorize?state=oauth-private-sentinel#oauth-private-fragment';
    // 02102e614e1: Artifact waits belong to automation, not a person's direct UI press.
    const invocation = createActionExecutor(deps).execute(id, { url }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'link-request', defaultSessionMachineId: 'link-origin',
    });
    await pending;
    expect(opened).toEqual([]);
    expect(persisted[0]?.actionArgs).toEqual({});
    expect(JSON.stringify(persisted)).not.toContain('oauth-private');
    approve();
    expect(await invocation).toEqual({ ok: true, result: { status: 'opened' } });
    expect(opened).toEqual([url]);
    expect(JSON.stringify(observations)).not.toContain('oauth-private');
    expect(JSON.stringify(persisted)).not.toContain('oauth-private');
  });
});
