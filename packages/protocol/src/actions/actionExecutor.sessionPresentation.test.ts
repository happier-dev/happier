import { describe, expect, it, vi } from 'vitest';

import {
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationActionResultV1Schema,
} from '../sessions/presentation/currentSessionPresentationV1.js';
import { ApprovalRequestSchema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, isInternalActionId } from './actionSpecs.js';

describe('current-Session presentation Action', () => {
  it('uses the public semantic viewer subset without local geometry or caller routing authority', () => {
    const schema = getActionSpec('session.presentation.apply').inputSchema;
    for (const intent of [
      { kind: 'viewer.open', source: 'computer' },
      { kind: 'viewer.close' },
      { kind: 'viewer.source.select', source: 'browser' },
      { kind: 'viewer.expand' },
      { kind: 'viewer.restore' },
    ]) expect(schema.parse({ intent })).toEqual({ intent });
    for (const input of [
      { intent: { kind: 'viewer.float' } },
      { intent: { kind: 'viewer.dock' } },
      { intent: { kind: 'viewer.corner.set', corner: 'br' } },
      { intent: { kind: 'viewer.size.set', width: 400 } },
      { intent: { kind: 'viewer.open', source: 'browser', targetId: 'other' } },
      { intent: { kind: 'viewer.close' }, sessionId: 'other' },
    ]) expect(schema.safeParse(input).success).toBe(false);
  });
  it('publishes one UI and Agent/MCP ActionSpec over the strict presentation intent', () => {
    const spec = getActionSpec('session.presentation.apply');
    expect(spec).toMatchObject({
      id: 'session.presentation.apply',
      requiredAuthority: 'account_automation',
      executionPlacement: 'session',
      safety: 'safe',
      sideEffectClass: 'write',
      approval: { result: 'required' },
      bindings: { mcpToolName: 'session_presentation_apply' },
      surfaces: {
        ui: true,
        voice: false,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
        api: false,
        plugin: false,
      },
    });
    expect(spec.inputSchema).toBe(CurrentSessionPresentationActionInputV1Schema);
    expect(spec.outputSchema).toBe(CurrentSessionPresentationActionResultV1Schema);
    expect(isInternalActionId('session.presentation.apply')).toBe(true);
  });

  it('admits the host-stamped runtime principal and delegates one exact intent', async () => {
    const presentationApply = vi.fn(async () => ({ status: 'applied' as const, revision: 'nonce-a:2' }));
    const executor = createActionExecutor({
      currentSessionPresentationApply: presentationApply,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const signal = new AbortController().signal;
    const context = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-a',
      signal,
    };

    await expect(executor.execute('session.presentation.apply', {
      intent: { kind: 'board.item.reveal', widgetId: 'note-a' },
    }, context)).resolves.toEqual({
      ok: true,
      result: { status: 'applied', revision: 'nonce-a:2' },
    });

    expect(presentationApply).toHaveBeenCalledWith({
      input: { intent: { kind: 'board.item.reveal', widgetId: 'note-a' } },
      context,
      signal,
    });
  });

  it('rejects caller-selected Session identity and unavailable producers before effects', async () => {
    const presentationApply = vi.fn(async () => ({ status: 'applied' as const, revision: 'nonce-a:2' }));
    const executor = createActionExecutor({
      currentSessionPresentationApply: presentationApply,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.presentation.apply', {
      sessionId: 'session-b',
      intent: { kind: 'companion.show' },
    }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-a',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(presentationApply).not.toHaveBeenCalled();

    const unavailable = createActionExecutor({
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    await expect(unavailable.execute('session.presentation.apply', {
      intent: { kind: 'companion.show' },
    }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'session-a',
      actionRequestId: 'tool-call-a',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.presentation.apply',
    });
  });

  it('settles host UI Ask through sealed presentation input without admitting API or plugin replay', async () => {
    let stored: ApprovalRequest | null = null;
    const delivered: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'session.presentation.apply': { approvalRequiredSurfaces: ['ui'] } },
    });
    // Artifact persistence and the daemon's bounded presentation ACK are the
    // executor's external ports. Policy, sealed-origin replay, strict parsing
    // and the approval transition remain the real protocol owners.
    const ports = {
      isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(
        actionId, settings, context, undefined, undefined, input,
      ),
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestSchema.parse(structuredClone(request));
        return { artifactId: 'viewer-approval' };
      },
      approvalsGet: async () => stored && structuredClone(stored),
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing stored approval');
        const next = ApprovalRequestSchema.parse(structuredClone(request));
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = next;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home-a'
        && origin.sessionId === 'session-a' && origin.accountId === 'alice',
      currentSessionPresentationApply: async ({ input, context }) => {
        delivered.push({ input, sessionId: context.defaultSessionId, serverId: context.serverId });
        return { status: 'applied' as const, revision: 'viewer-host:2' };
      },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
      | 'isApprovalExecutionOriginCurrent' | 'currentSessionPresentationApply' | 'isActionApprovalRequired'>;
    // The unrelated required host ports are unreachable in this focused test.
    const executor = createActionExecutor(ports as unknown as ActionExecutorDeps);
    const deferred = await executor.execute('session.presentation.apply', { intent: { kind: 'viewer.close' } }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'session-a', actionRequestId: 'viewer-close', actionsSettings: settings,
    });
    expect(deferred).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'viewer-approval' } });
    expect(stored).toMatchObject({ status: 'open', executionOriginV1: {
      surface: 'ui', caller: { kind: 'host' }, authority: 'present_user', sessionId: 'session-a',
    } });
    expect(delivered).toEqual([]);
    for (const surface of ['api', 'plugin'] as const) {
      const refused = await executor.execute('approval.request.decide', { artifactId: 'viewer-approval', decision: 'approve' }, {
        surface, authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
      });
      expect(refused).toMatchObject({ ok: false });
      expect(stored).toMatchObject({ status: 'open' });
      expect(delivered).toEqual([]);
    }
    const approved = await executor.execute('approval.request.decide', { artifactId: 'viewer-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'caller-selected-other-session',
    });
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(delivered).toEqual([{ input: { intent: { kind: 'viewer.close' } }, sessionId: 'session-a', serverId: 'home-a' }]);
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: { status: 'applied', revision: 'viewer-host:2' } } });
    expect(isInternalActionId('session.presentation.apply')).toBe(true);
  });
});
