import { z } from 'zod';

/** A policy-deferred Action has not failed or executed; the present user owns the next step. */
export const ActionApprovalRequestCreatedResultSchema = z.object({
  kind: z.literal('approval_request_created'),
  artifactId: z.string().trim().min(1),
  actionId: z.string().trim().min(1),
}).strict();

export type ActionApprovalRequestCreatedResult = Readonly<
  z.infer<typeof ActionApprovalRequestCreatedResultSchema>
>;

/**
 * The canonical outcome shape shared by Action execution projections.
 *
 * It is deliberately separate from the daemon-heavy executor type graph so
 * browser-facing SDK declarations do not pull the aggregate Actions barrel.
 */
export const ActionExecuteFailureSchema = z.object({
  ok: z.literal(false),
  errorCode: z.string().trim().min(1),
  error: z.string().trim().min(1),
  // Failure details remain an existing opaque Action contract. Their owning
  // producers decide their shape; this public envelope only excludes extra
  // top-level transit metadata.
  details: z.unknown().optional(),
}).strict();

export type ActionExecuteFailure = Readonly<z.infer<typeof ActionExecuteFailureSchema>>;

export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | ActionExecuteFailure;

/**
 * Projects an Action failure onto the public envelope. This is intentionally
 * not a generic error parser: known Action fields and opaque details survive,
 * while bridge-private top-level metadata cannot cross the Action boundary.
 */
export function projectActionExecuteFailure(result: ActionExecuteFailure): ActionExecuteFailure {
  const projected = ActionExecuteFailureSchema.safeParse({
    ok: false,
    errorCode: result.errorCode,
    error: result.error,
    ...(result.details === undefined ? {} : { details: result.details }),
  });
  return projected.success
    ? projected.data
    : { ok: false, errorCode: 'action_failed', error: 'action_failed' };
}
