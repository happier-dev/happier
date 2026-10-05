import { z } from 'zod';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionSurfaceSchema, ActionRequiredAuthoritySchema, getActionSpec } from './actionSpecs.js';
import type { ActionExecuteResult } from './executor/types.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';

/** Private continuation of an Action admitted by the authenticated Machine host. */
export const UiActionDispatchRequestV1Schema = z.object({
  v: z.literal(1),
  actionId: ActionIdSchema,
  input: z.unknown(),
  context: z.object({
    surface: ActionSurfaceSchema.keyof(),
    authority: ActionRequiredAuthoritySchema,
    defaultSessionId: z.string().min(1).optional(),
    defaultSessionMachineId: z.string().min(1).optional(),
    agentStartWorkspaceWrites: z.enum(['allow', 'deny']).optional(),
  }).strict(),
}).strict().superRefine((request, ctx) => {
  const spec = getActionSpec(request.actionId);
  if (!Object.hasOwn(request, 'input') || spec.executionPlacement !== 'client' || !spec.inputSchema.safeParse(request.input).success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid client Action', path: ['input'] });
  }
});
export type UiActionDispatchRequestV1 = z.infer<typeof UiActionDispatchRequestV1Schema>;

export const UiActionDispatchResultV1Schema = z.object({
  v: z.literal(1),
  execution: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    ActionExecuteFailureSchema,
  ]),
}).strict();

/** Absence is a declared domain result where the Action has one, otherwise a typed failure. */
export function clientActionUnavailable(actionId: ActionId): ActionExecuteResult {
  if (actionId === 'ui.find' || actionId === 'ui.prompts.picker.open') {
    return { ok: true, result: { status: 'unavailable', reason: 'noClient' } };
  }
  if (actionId === 'session.pending.next') return { ok: true, result: { status: 'unavailable' } };
  return { ok: false, errorCode: 'unavailable', error: 'noClient' };
}

/** Dynamic result validation belongs to the same Action spec on both sides of delivery. */
export function parseClientActionDispatchResult(actionId: ActionId, raw: unknown): ActionExecuteResult | null {
  const parsed = UiActionDispatchResultV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const execution = parsed.data.execution;
  if (!execution.ok) return execution;
  const output = getActionSpec(actionId).outputSchema?.safeParse(execution.result);
  return output?.success ? { ok: true, result: output.data } : null;
}
