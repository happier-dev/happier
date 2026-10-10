import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionSurfaceSchema, ActionRequiredAuthoritySchema, getActionSpec, resolveActionExecutionPlacementForInput } from './actionSpecs.js';
import type { ActionExecuteResult } from './executor/types.js';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { ApprovalExecutionOriginCallerV1Schema } from '../approvals/approvalRequestV1.js';
import { ExternalActionTargetV1Schema } from './externalActionApi.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { RPC_METHODS } from '../rpc/methods.js';

/** Private continuation of an Action admitted by the authenticated Machine host. */
export const UiActionDispatchRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  actionId: ActionIdSchema,
  input: z.unknown(),
  context: z.object({
    surface: ActionSurfaceSchema.keyof(),
    authority: ActionRequiredAuthoritySchema,
    defaultSessionId: z.string().min(1).optional(),
    defaultSessionMachineId: z.string().min(1).optional(),
    agentStartWorkspaceWrites: z.enum(['allow', 'deny']).optional(),
    // Host provenance, never Action input. Nested owners recheck the grant and
    // keep their own approval policy; the root's bypass/signature is not delegated.
    actionCaller: ApprovalExecutionOriginCallerV1Schema.optional(),
    actionRequestId: z.string().trim().min(1).optional(),
    externalActionCredential: z.object({
      accountId: z.string().min(1), principalId: z.string().min(1), credentialId: z.string().min(1),
      grant: ApiTokenGrantV1Schema,
    }).strict().optional(),
    externalActionTarget: ExternalActionTargetV1Schema.optional(),
  }).strict(),
}).strict().superRefine((request, ctx) => {
  const spec = getActionSpec(request.actionId);
  const input = spec.inputSchema.safeParse(request.input);
  if (!Object.hasOwn(request, 'input') || !input.success || resolveActionExecutionPlacementForInput(spec, input.data) !== 'client') {
    ctx.addIssue({ code: 'custom', message: 'Invalid client Action', path: ['input'] });
  }
}));
export type UiActionDispatchRequestV1 = z.infer<typeof UiActionDispatchRequestV1Schema>;

export const UiActionDispatchResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  execution: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    ActionExecuteFailureSchema,
  ]),
}).strict());

/** Absence is a declared domain result where the Action has one, otherwise a typed failure. */
export function clientActionUnavailable(actionId: ActionId): ActionExecuteResult {
  if (actionId === 'usage.sources.dismiss') return { ok: true, result: { status: 'unavailable' } };
  if (actionId === 'session.authoring.open') {
    return { ok: true, result: { kind: 'unavailable', reason: 'client_unavailable' } };
  }
  if (actionId === 'ui.find' || actionId === 'ui.prompts.picker.open') {
    return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  }
  if (actionId === 'session.pending.next') return { ok: true, result: { status: 'unavailable' } };
  if (isSettingsDeclarationActionIdV1(actionId)) return { ok: false, errorCode: 'unavailable', error: 'noClient',
    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE,
      instruction: 'Open a signed-in Happier client connected to the target Machine, then retry this setting Action.' } } };
  return { ok: false, errorCode: 'unavailable', error: 'noClient' };
}

/** Dynamic result validation belongs to the same Action spec on both sides of delivery. */
export function parseClientActionDispatchResult(actionId: ActionId, raw: unknown): ActionExecuteResult | null {
  const parsed = UiActionDispatchResultV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const execution = parsed.data.execution;
  if (!execution.ok) return execution;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
  if (approval.success) return { ok: true, result: approval.data };
  const output = getActionSpec(actionId).outputSchema?.safeParse(execution.result);
  return output?.success ? { ok: true, result: output.data } : null;
}
