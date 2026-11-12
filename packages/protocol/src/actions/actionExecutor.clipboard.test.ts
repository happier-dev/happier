import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

describe('answering-client clipboard Action', () => {
  it('writes exact text through ordinary automated admission without exposing copied text in observations', async () => {
    const written: string[] = [];
    // The clipboard is a native platform boundary, not an internal domain service.
    const executor = createActionExecutor({ clipboardWrite: async ({ text }: { text: string }) => {
      written.push(text);
      return { status: 'copied' };
    } } as unknown as ActionExecutorDeps);
    const text = '\n{"message":"private 🔐"}\n';
    expect(await executor.execute('clipboard.write', { text }, { surface: 'agent', authority: 'account_automation' }))
      .toEqual({ ok: true, result: { status: 'copied' } });
    expect(written).toEqual([text]);
    expect(getActionSpec('clipboard.write').projectObservationInput?.({ text })).toEqual({});
    expect(getActionSpec('clipboard.write').inputSchema.safeParse({ text, accountId: 'someone-else' }).success).toBe(false);
  });

  it('refuses a missing answering-client boundary and a cancelled invocation without claiming a copy', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    expect(await executor.execute('clipboard.write', { text: '' }, { surface: 'mcp', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const controller = new AbortController();
    controller.abort();
    const written: string[] = [];
    const withBoundary = createActionExecutor({ clipboardWrite: async ({ text }: { text: string }) => {
      written.push(text);
      return { status: 'copied' };
    } } as unknown as ActionExecutorDeps);
    expect(await withBoundary.execute('clipboard.write', { text: 'cancelled' }, {
      surface: 'ui', authority: 'present_user', signal: controller.signal,
    })).toMatchObject({ ok: false });
    expect(written).toEqual([]);
  });

  it('keeps policy-confirmed clipboard text in its live invocation and out of the approval Artifact', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'clipboard.write': { approvalRequiredSurfaces: ['agent'] },
    } });
    const persisted: ApprovalRequest[] = [];
    const written: string[] = [];
    const observations: unknown[] = [];
    let markCreated!: () => void;
    const created = new Promise<void>(resolve => { markCreated = resolve; });
    let approve!: () => void;
    const decision = new Promise<void>(resolve => { approve = resolve; });
    // Only Artifact persistence/decision delivery, the external extension hook
    // and observer, and the native clipboard boundaries are substituted.
    const deps = {
      interceptActionExecution: async request => ({ status: 'continue' as const, input: request.input }),
      observeActionExecution: observation => { observations.push(observation); },
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { persisted.push(request); markCreated(); return { artifactId: 'clipboard-approval' }; },
      approvalsUpdate: async ({ request }) => { persisted.push(request); return { ok: true as const }; },
      approvalsWaitForDecision: async ({ request }) => {
        await decision;
        return { decision: 'approve' as const,
          request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: Date.now() } } };
      },
      clipboardWrite: async ({ text }) => { written.push(text); return { status: 'copied' as const }; },
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const text = 'clipboard-private-custody-sentinel 🔐';
    const execution = executor.execute('clipboard.write', { text }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'clipboard-request',
      defaultSessionMachineId: 'clipboard-origin',
      approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'clipboard-session', toolCallId: 'clipboard-tool', toolInput: { text } },
    });
    await created;
    expect(written).toEqual([]);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]?.actionArgs).toEqual({});
    expect(JSON.stringify(persisted)).not.toContain('clipboard-private-custody-sentinel');
    approve();
    expect(await execution).toEqual({ ok: true, result: { status: 'copied' } });
    expect(written).toEqual([text]);
    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain('clipboard-private-custody-sentinel');
    expect(JSON.stringify(persisted)).not.toContain('clipboard-private-custody-sentinel');
  });
});
