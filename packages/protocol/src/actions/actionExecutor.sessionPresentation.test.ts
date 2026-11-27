import { describe, expect, it, vi } from 'vitest';

import {
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationActionResultV1Schema,
} from '../sessions/presentation/currentSessionPresentationV1.js';
import { ApprovalRequestSchema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { SessionInputAdmissionResultV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, isInternalActionId } from './actionSpecs.js';
import { isApprovalRequestActionReplayAdmitted } from './executor/approvalOrigins.js';

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
        voice: true,
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
      context: expect.objectContaining(context),
      signal,
    });
  });

  it('rejects caller-selected Session identity and unavailable producers before effects', async () => {
    const presentationApply = vi.fn(async () => ({ status: 'applied' as const, revision: 'nonce-a:2' }));
    const executor = createActionExecutor({
      currentSessionPresentationApply: presentationApply,
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
      requestId: 'tool-call-a',
      details: { issues: [{ code: 'unrecognized_keys', path: [], message: expect.any(String) }] },
    });
    expect(presentationApply).not.toHaveBeenCalled();

    const unavailable = createActionExecutor({
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
      requestId: 'tool-call-a',
    });
  });

  it('settles host MCP Ask through sealed presentation input without admitting API or plugin replay', async () => {
    let stored: ApprovalRequest | null = null;
    const delivered: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'session.presentation.apply': { approvalRequiredSurfaces: ['mcp'] } },
    });
    // Artifact persistence and the daemon's bounded presentation ACK are the
    // executor's external ports. Policy, sealed-origin replay, strict parsing
    // and the approval transition remain the real protocol owners.
    const ports = {
      readActionsSettings: () => settings,
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
        && origin.machineId === 'machine-a' && origin.sessionId === 'session-a' && origin.accountId === 'alice',
      currentSessionPresentationApply: async ({ input, context }) => {
        delivered.push({ input, sessionId: context.defaultSessionId, serverId: context.serverId });
        return { status: 'applied' as const, revision: 'viewer-host:2' };
      },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
      | 'isApprovalExecutionOriginCurrent' | 'currentSessionPresentationApply' | 'readActionsSettings'>;
    // The unrelated required host ports are unreachable in this focused test.
    const executor = createActionExecutor(ports as unknown as ActionExecutorDeps);
    const deferred = await executor.execute('session.presentation.apply', { intent: { kind: 'viewer.close' } }, {
      surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'session-a', defaultSessionMachineId: 'machine-a', actionRequestId: 'viewer-close', actionsSettings: settings,
    });
    expect(deferred).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'viewer-approval' } });
    expect(stored).toMatchObject({ status: 'open', executionOriginV1: {
      surface: 'mcp', caller: { kind: 'host' }, authority: 'account_automation', machineId: 'machine-a', sessionId: 'session-a',
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
    const sealed = stored;
    if (!sealed || sealed.v !== 2) throw new Error('Expected v2 stored approval');
    for (const forgedOrigin of [
      { ...sealed.executionOriginV1, surface: 'api' as const, principalId: 'token-1', credentialId: 'token-1' },
      { ...sealed.executionOriginV1, surface: 'plugin' as const, caller: { kind: 'plugin' as const, pluginId: 'acme.presentation', contributionLocalId: 'present', sourceCustody: { kind: 'development' as const, registeredRootId: 'root-1' } } },
      { ...sealed.executionOriginV1, surface: 'rpc' as const },
    ]) {
      stored = ApprovalRequestSchema.parse({ ...sealed, requestedSurface: forgedOrigin.surface, executionOriginV1: forgedOrigin });
      const refusedOrigin = await executor.execute('approval.request.decide', { artifactId: 'viewer-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
        runtimeAccountId: 'alice', defaultSessionId: 'caller-selected-other-session',
      });
      expect(refusedOrigin).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(delivered).toEqual([]);
    }
    stored = sealed;
    const approved = await executor.execute('approval.request.decide', { artifactId: 'viewer-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'caller-selected-other-session',
    });
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(delivered).toEqual([{ input: { intent: { kind: 'viewer.close' } }, sessionId: 'session-a', serverId: 'home-a' }]);
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: { status: 'applied', revision: 'viewer-host:2' } } });
    expect(isInternalActionId('session.presentation.apply')).toBe(true);
  });

  it('admits matching session-caller Ask replay and refuses mismatched sessionId or non-host/non-session callers on admitted surfaces', async () => {
    let stored: ApprovalRequest | null = null;
    const delivered: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'session.presentation.apply': { approvalRequiredSurfaces: ['agent'] } },
    });
    const ports = {
      readActionsSettings: () => settings,
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestSchema.parse(structuredClone(request));
        return { artifactId: 'session-caller-approval' };
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
        && origin.machineId === 'machine-a' && origin.sessionId === 'session-a' && origin.accountId === 'alice',
      sessionSendMessage: async ({ localId }) => SessionInputAdmissionResultV1Schema.parse({ status: 'accepted', localId }),
      currentSessionPresentationApply: async ({ input, context }) => {
        delivered.push({ input, sessionId: context.defaultSessionId, serverId: context.serverId });
        return { status: 'applied' as const, revision: 'viewer-session:2' };
      },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'
      | 'isApprovalExecutionOriginCurrent' | 'sessionSendMessage' | 'currentSessionPresentationApply' | 'readActionsSettings'>;
    const executor = createActionExecutor(ports as unknown as ActionExecutorDeps);
    const deferred = await executor.execute('session.presentation.apply', { intent: { kind: 'viewer.close' } }, {
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId: 'session-a', starterDepth: 0, turnDepth: 0 },
      serverId: 'home-a',
      runtimeAccountId: 'alice',
      defaultSessionId: 'session-a',
      defaultSessionMachineId: 'machine-a',
      actionRequestId: 'viewer-close-session',
      actionsSettings: settings,
    });
    expect(deferred).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'session-caller-approval' } });
    const sealed = stored;
    if (!sealed || sealed.v !== 2) throw new Error('Expected v2 stored approval');
    expect(sealed.executionOriginV1).toMatchObject({
      surface: 'agent',
      caller: { kind: 'session', sessionId: 'session-a', starterDepth: 0, turnDepth: 0 },
      sessionId: 'session-a',
    });

    const uiApproveContext = {
      surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'caller-selected-other-session',
    };

    // Negatives on admitted surface ('agent'): mismatched caller.sessionId, plugin, automationRun, and workflowRun callers stay refused.
    for (const { caller: forgedCaller, expectedErrorCode } of [
      { caller: { kind: 'session' as const, sessionId: 'session-other', starterDepth: 0, turnDepth: 0 }, expectedErrorCode: 'invalid_parameters' },
      { caller: { kind: 'plugin' as const, pluginId: 'acme.presentation', contributionLocalId: 'present', sourceCustody: { kind: 'development' as const, registeredRootId: 'root-1' } }, expectedErrorCode: 'invalid_parameters' },
      { caller: { kind: 'automationRun' as const, runId: 'automation-run-1', automationId: 'automation-1', cause: { kind: 'manual' as const, invokedAt: 1 } }, expectedErrorCode: 'invalid_parameters' },
      { caller: { kind: 'workflowRun' as const, runId: 'workflow-run-1', authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } }, expectedErrorCode: 'approval_requester_unavailable' },
    ]) {
      const { requesterSessionMachineId: _ignored, ...baseOrigin } = sealed.executionOriginV1;
      const forged = ApprovalRequestSchema.parse({
        ...sealed,
        executionOriginV1: {
          ...baseOrigin,
          ...(forgedCaller.kind === 'session' ? { requesterSessionMachineId: sealed.executionOriginV1.requesterSessionMachineId } : {}),
          ...(forgedCaller.kind === 'automationRun' ? { runId: forgedCaller.runId } : {}),
          surface: 'agent',
          caller: forgedCaller,
        },
      });
      expect(isApprovalRequestActionReplayAdmitted(forged, uiApproveContext), `predicate must refuse caller ${forgedCaller.kind}`).toBe(false);
      stored = forged;
      const refused = await executor.execute('approval.request.decide', { artifactId: 'session-caller-approval', decision: 'approve' }, uiApproveContext);
      expect(refused, `expected refusal for caller ${forgedCaller.kind}`).toMatchObject({ ok: false, errorCode: expectedErrorCode });
      expect(delivered).toEqual([]);
    }

    // Positive: matching session caller (caller.sessionId === origin.sessionId) settles cleanly into origin.sessionId.
    stored = sealed;
    const approved = await executor.execute('approval.request.decide', { artifactId: 'session-caller-approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-a',
      runtimeAccountId: 'alice', defaultSessionId: 'caller-selected-other-session',
    });
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(delivered).toEqual([{ input: { intent: { kind: 'viewer.close' } }, sessionId: 'session-a', serverId: 'home-a' }]);
  });
});
