import { describe, expect, it } from 'vitest';
import { getActionSpec, PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema } from './actionSpecs.js';
import { isActionDiscoverableOnToolSurface } from './actionToolExposure.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { clientActionUnavailable, parseClientActionDispatchResult, UiActionDispatchRequestV1Schema } from './clientDispatchV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';

const composerRef = { kind: 'session', sessionId: 'target' } as const;
const requests = [
  { actionId: 'ui.prompts.picker.select', input: { composerRef, selection: { kind: 'doc', artifactId: 'doc' } }, result: { status: 'selected', composerRef } },
  { actionId: 'ui.prompts.picker.apply', input: { composerRef, mode: 'insert' }, result: { status: 'applied', composerRef } },
  { actionId: 'ui.prompts.history', input: { composerRef, op: 'read' }, result: { status: 'ready', composerRef, entries: [], coverage: 'partial', hasMore: true, isLoading: false, error: false, progress: { pagesLoaded: 0, sessionsSearched: 0, totalSessions: 1 } } },
  { actionId: 'session.messages.pins', input: { op: 'read', sessionId: 'target' }, result: { status: 'ready', sessionId: 'target', pins: [] } },
] as const;

describe('mounted prompt and device message-pin Actions', () => {
  it.each(['ui.prompts.picker.apply', 'session.messages.pins'] as const)('keeps explicit human UI $actionId direct while retaining custom Ask and automation review', actionId => {
    const spec = getActionSpec(actionId);
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const settings = normalizeActionsSettingsV1({});
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent', authority: 'account_automation' }, settings }).required).toBe(true);
  });
  it('admits a pin read without automation approval while pin mutations retain review', async () => {
    const actionId = 'session.messages.pins';
    const spec = getActionSpec(actionId);
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    const settings = normalizeActionsSettingsV1({});
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings, input: { op: 'read', sessionId: 'target' } }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings, input: { op: 'pin', sessionId: 'target' } }).required).toBe(true);
    const executor = createActionExecutor({ clientActionExecute: async ({ actionId }) => clientActionUnavailable(actionId) } as ActionExecutorDeps);
    expect(await executor.execute(actionId, { op: 'read', sessionId: 'target' }, context))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
  });
  it.each(requests)('publishes $actionId on the canonical strict client/public/tool boundary', async request => {
    const actionId = PublicActionIdSchema.parse(request.actionId);
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ executionPlacement: 'client', surfaces: { ui: true, agent: true, mcp: true, cli: true, api: true } });
    expect(spec.bindings?.mcpToolName).toBeTruthy();
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp')).toBe(true);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(PUBLIC_ACTION_INPUT_SCHEMAS[actionId].safeParse(request.input).success).toBe(true);
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(request.result).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...request.input, unexpected: true }).success).toBe(false);
    const clientActionExecute: NonNullable<ActionExecutorDeps['clientActionExecute']> = async invocation => {
      const wire = UiActionDispatchRequestV1Schema.parse({ v: 1, ...invocation, context: { surface: invocation.context.surface, authority: invocation.context.authority } });
      return parseClientActionDispatchResult(wire.actionId, { v: 1, execution: { ok: true, result: request.result } })!;
    };
    const executor = createActionExecutor({ clientActionExecute } as ActionExecutorDeps);
    expect(await executor.execute(actionId, request.input, { surface: 'cli', authority: 'account_automation', bypassApprovals: true })).toEqual({ ok: true, result: request.result });
    expect(clientActionUnavailable(actionId)).toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
    expect(await createActionExecutor({} as ActionExecutorDeps).execute(actionId, request.input, { surface: 'ui', bypassApprovals: true }))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
  });

  it('rejects cross-Session pins and open nested selectors before delivery', () => {
    const select = getActionSpec(ActionIdSchema.parse('ui.prompts.picker.select'));
    expect(select.inputSchema.safeParse({ selection: { kind: 'doc', artifactId: 'doc', text: 'forged' } }).success).toBe(false);
    const pins = getActionSpec(ActionIdSchema.parse('session.messages.pins'));
    const pin = { version: 1, sessionId: 'other', seq: 1, transcriptBlockIndex: null, routeMessageId: null, role: 'user', pinnedAtMs: 0, label: null };
    expect(pins.inputSchema.safeParse({ op: 'pin', sessionId: 'target', pin }).success).toBe(false);
    expect(pins.inputSchema.safeParse({ op: 'pin', sessionId: 'target', pin: { ...pin, sessionId: 'target' } }).success).toBe(true);
  });

  it.each([
    requests[1],
    { actionId: 'session.messages.pins', input: { op: 'pin', sessionId: 'target', pin: { version: 1, sessionId: 'target', seq: 1, transcriptBlockIndex: null, routeMessageId: null, role: 'user', pinnedAtMs: 0, label: null } }, result: { status: 'ready', sessionId: 'target', pins: [] } },
  ] as const)('requires approval before agent $actionId delivery', async request => {
    let delivered = false;
    const executor = createActionExecutor({ clientActionExecute: async () => { delivered = true; return { ok: true, result: request.result }; } } as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse(request.actionId), request.input, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(delivered).toBe(false);
  });
});
