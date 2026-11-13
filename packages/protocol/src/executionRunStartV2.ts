import { z } from 'zod';

import { lazySchema } from './lazySchema.js';
import {
  ExecutionRunStartRequestSchema,
  ExecutionRunStartResponseSchema,
} from './executionRunStartRequest.js';
import {
  CustomSessionRoleIdSchema,
  SESSION_ROLES,
  isCustomSessionRoleId,
  type AssignableSessionRole,
  type BuiltInSessionRole,
} from './sessionMetadata/sessionRole.js';

/**
 * Visible and role-bearing execution runs (`execution.run.start.v2`).
 *
 * A hidden roleless run keeps the released `execution.run.start` request byte-for-byte. Any start
 * that carries `visibility: 'session'` or a `role` uses only the exact v2 runner method, never a
 * fallback, and its caller verifies the response echo before treating the run as assigned.
 */

export const ExecutionRunVisibilitySchema = lazySchema(() => z.enum(['hidden', 'session']));
export type ExecutionRunVisibility = z.infer<typeof ExecutionRunVisibilitySchema>;

/** Intents that may be visible or role-bearing in v1. Voice and memory runs stay hidden and roleless. */
export const EXECUTION_RUN_VISIBLE_INTENTS = ['review', 'plan', 'delegate'] as const;
export type ExecutionRunVisibleIntent = (typeof EXECUTION_RUN_VISIBLE_INTENTS)[number];
export function isExecutionRunVisibleIntent(intent: unknown): intent is ExecutionRunVisibleIntent {
  return typeof intent === 'string' && (EXECUTION_RUN_VISIBLE_INTENTS as readonly string[]).includes(intent);
}

/** `project_lead` coordinates sessions and is refused on runs (exploration plan D12). */
export const EXECUTION_RUN_REFUSED_ROLES = ['project_lead'] as const satisfies readonly BuiltInSessionRole[];
export const EXECUTION_RUN_BUILT_IN_ROLES = SESSION_ROLES.filter(
  (role): role is Exclude<BuiltInSessionRole, (typeof EXECUTION_RUN_REFUSED_ROLES)[number]> =>
    !(EXECUTION_RUN_REFUSED_ROLES as readonly string[]).includes(role),
);
export type ExecutionRunRole = (typeof EXECUTION_RUN_BUILT_IN_ROLES)[number] | `custom:${string}`;
export const ExecutionRunRoleSchema: z.ZodType<ExecutionRunRole> = lazySchema(() => z.union([
  z.enum(EXECUTION_RUN_BUILT_IN_ROLES as unknown as [ExecutionRunRole, ...ExecutionRunRole[]]),
  CustomSessionRoleIdSchema,
])) as z.ZodType<ExecutionRunRole>;

/** Where a run's role came from: an explicit start field, the owner's per-intent default, or nowhere. */
export const ExecutionRunRoleSourceSchema = lazySchema(() => z.enum(['explicit', 'settings', 'none']));
export type ExecutionRunRoleSource = z.infer<typeof ExecutionRunRoleSourceSchema>;

export const ExecutionRunBindingSchema = lazySchema(() => z.enum(['created', 'reused']));
export type ExecutionRunBinding = z.infer<typeof ExecutionRunBindingSchema>;

/** The role snapshot applied to a run, resolved by the hosting runner from its own account catalog. */
export const ExecutionRunRoleSnapshotSchema = lazySchema(() => z.object({
  id: ExecutionRunRoleSchema,
  name: z.string().trim().min(1),
  assignmentId: z.string().trim().min(1),
}).passthrough());
export type ExecutionRunRoleSnapshot = z.infer<typeof ExecutionRunRoleSnapshotSchema>;

/**
 * Action-input fields shared by `review.start`, `subagents.plan.start`, `subagents.delegate.start`,
 * and `execution.run.start`. Accepted only on the `session_agent`, `mcp`, and `cli` surfaces in v1.
 */
export function createExecutionRunVisibleStartInputShapeV1() {
  return {
    visibility: ExecutionRunVisibilitySchema.optional()
      .describe('hidden (default) runs as today; session makes the run a child Session the user can open, steer, and interrupt.'),
    role: ExecutionRunRoleSchema.optional()
      .describe('Explicit run role: planner | worker | reviewer | custom:<uuid>. project_lead is refused on runs.'),
    targetSessionId: z.string().trim().min(1).optional()
      .describe('With visibility "session": bind an existing child Session this session created instead of creating one.'),
  };
}

/** Fields only `execution.run.start.v2` accepts. Every older start entry rejects a request carrying any of them. */
export const EXECUTION_RUN_START_V2_ONLY_FIELDS = ['visibility', 'role', 'roleSource', 'targetSessionId'] as const;
export type ExecutionRunStartV2OnlyField = (typeof EXECUTION_RUN_START_V2_ONLY_FIELDS)[number];

/** The v2-only fields present on a request, for the fail-closed rejection on every older start entry. */
export function readExecutionRunStartV2OnlyFieldsV1(request: unknown): ExecutionRunStartV2OnlyField[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return [];
  const record = request as Record<string, unknown>;
  return EXECUTION_RUN_START_V2_ONLY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(record, field)
    && record[field] !== undefined);
}

export const EXECUTION_RUN_VISIBLE_ERROR_CODES = {
  /** The target runner, or the calling surface, cannot start a visible run. */
  VISIBILITY_UNSUPPORTED: 'execution_run_visibility_unsupported',
  /** The target runner, or the calling surface, cannot start a role-bearing run. */
  ROLE_UNSUPPORTED: 'execution_run_role_unsupported',
  /** A visible start could not bind the requested existing child. */
  BIND_REJECTED: 'execution_run_bind_rejected',
  /** Turn-stream entries do not apply to a run whose work happens in a linked Session (v1). */
  VISIBLE_TURN_ENTRY_UNSUPPORTED: 'execution_run_visible_turn_entry_unsupported',
  /** Run failure: the linked child never confirmed the link inside the handshake window. */
  VISIBLE_CHILD_UNRESPONSIVE: 'execution_run_visible_child_unresponsive',
  /** Run failure: the linked child's permission mode or model changed during the run. */
  CONTROLS_CHANGED: 'controls_changed',
  /** Cancellation reason: the linked child was archived. */
  CHILD_ARCHIVED: 'child_archived',
  /** Run failure: a child turn failed without a valid result. */
  VISIBLE_CHILD_TURN_FAILED: 'execution_run_visible_child_turn_failed',
  /** Run failure: the output-repair prompt could not be delivered to the child. */
  VISIBLE_REPAIR_UNDELIVERED: 'execution_run_visible_repair_undelivered',
} as const;
export type ExecutionRunVisibleErrorCode = (typeof EXECUTION_RUN_VISIBLE_ERROR_CODES)[keyof typeof EXECUTION_RUN_VISIBLE_ERROR_CODES];

/**
 * The one rule for which typed error a request that cannot be started gets: anything asking for a
 * visible run (or naming a child) is a visibility error; otherwise a role error. An explicit
 * `visibility: 'hidden'` alone on a pre-v2 entry is a visibility error.
 */
export function resolveExecutionRunStartV2UnsupportedErrorCodeV1(request: unknown):
  | typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED
  | typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED {
  const record = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
  if (record.targetSessionId !== undefined || record.visibility === 'session') return EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED;
  if (record.role !== undefined || record.roleSource !== undefined) return EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED;
  return record.visibility !== undefined
    ? EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED
    : EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED;
}

export const ExecutionRunBindRejectionReasonSchema = lazySchema(() => z.enum([
  'foreign_child',
  'child_archived',
  'role_mismatch',
  'child_busy',
  'controls_mismatch',
]));
export type ExecutionRunBindRejectionReason = z.infer<typeof ExecutionRunBindRejectionReasonSchema>;

/**
 * Fixed intent-role check for binding an existing child. It checks an explicit assignment and is
 * never used to infer a role for a created child.
 */
export const EXECUTION_RUN_BIND_ROLE_BY_INTENT_V1: Readonly<Record<ExecutionRunVisibleIntent, BuiltInSessionRole>> = {
  review: 'reviewer',
  plan: 'planner',
  delegate: 'worker',
};

/**
 * A run may bind a child only when the child's role is the intent's role, or, for a custom role,
 * when the run passes that exact custom role explicitly. An explicit built-in role that differs from
 * the intent's role, or a roleless child, is a `role_mismatch`.
 */
export function isExecutionRunBindRoleCompatibleV1(params: Readonly<{
  intent: ExecutionRunVisibleIntent;
  requestedRole?: AssignableSessionRole | null;
  childRole: string | null | undefined;
}>): boolean {
  const childRole = params.childRole ?? null;
  if (!childRole) return false;
  const requested = params.requestedRole ?? null;
  if (requested && isCustomSessionRoleId(requested)) return childRole === requested;
  const intentRole = EXECUTION_RUN_BIND_ROLE_BY_INTENT_V1[params.intent];
  if (requested && requested !== intentRole) return false;
  return childRole === intentRole;
}

function addV2RequestIssues(value: Readonly<Record<string, unknown>>, ctx: z.RefinementCtx): void {
  const visibility = value.visibility;
  const role = value.role;
  const roleSource = value.roleSource;
  if (visibility !== 'session' && role === undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibility'], message: 'execution.run.start.v2 requires visibility "session" or a role' });
  }
  if ((visibility === 'session' || role !== undefined) && !isExecutionRunVisibleIntent(value.intent)) {
    ctx.addIssue({ code: 'custom', path: ['intent'], message: 'Only review, plan, and delegate runs may be visible or role-bearing' });
  }
  if (value.targetSessionId !== undefined && visibility !== 'session') {
    ctx.addIssue({ code: 'custom', path: ['targetSessionId'], message: 'targetSessionId requires visibility "session"' });
  }
  if (role !== undefined && roleSource !== 'explicit' && roleSource !== 'settings') {
    ctx.addIssue({ code: 'custom', path: ['roleSource'], message: 'A role requires roleSource "explicit" or "settings"' });
  }
  if (role === undefined && roleSource !== undefined && roleSource !== 'none') {
    ctx.addIssue({ code: 'custom', path: ['roleSource'], message: 'roleSource requires a role' });
  }
}

export const ExecutionRunStartV2RequestSchema = lazySchema(() => ExecutionRunStartRequestSchema.extend({
  visibility: ExecutionRunVisibilitySchema,
  role: ExecutionRunRoleSchema.optional(),
  roleSource: ExecutionRunRoleSourceSchema.optional(),
  /** Bind an existing child created by the hosting session instead of creating one. */
  targetSessionId: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => addV2RequestIssues(value as Record<string, unknown>, ctx)));
export type ExecutionRunStartV2Request = z.infer<typeof ExecutionRunStartV2RequestSchema>;

/** Echo every v2 start returns; the caller verifies it before using the run. */
export const ExecutionRunStartV2EchoSchema = lazySchema(() => z.object({
  visibility: ExecutionRunVisibilitySchema,
  binding: ExecutionRunBindingSchema.nullable(),
  linkedSessionId: z.string().trim().min(1).nullable(),
  role: ExecutionRunRoleSnapshotSchema.nullable(),
  roleSource: ExecutionRunRoleSourceSchema,
  /** Effective permission mode the run executes with. */
  permissionMode: z.string().trim().min(1),
  /** Effective model, or null when the backend default applies. */
  modelId: z.string().trim().min(1).nullable(),
}).passthrough());
export type ExecutionRunStartV2Echo = z.infer<typeof ExecutionRunStartV2EchoSchema>;

export const ExecutionRunStartV2ResponseSchema = lazySchema(() => ExecutionRunStartResponseSchema.extend(
  ExecutionRunStartV2EchoSchema.shape,
).passthrough());
export type ExecutionRunStartV2Response = z.infer<typeof ExecutionRunStartV2ResponseSchema>;

export type ExecutionRunStartV2EchoVerification =
  | Readonly<{ ok: true; response: ExecutionRunStartV2Response }>
  | Readonly<{
    ok: false;
    errorCode: typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED | typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED;
    error: string;
    /** Present when the runner returned a run id, so the caller can inspect or stop it. */
    runId?: string;
  }>;

/**
 * The single echo check every v2 caller uses. A missing or mismatched echo means the run is not
 * the run that was requested and must be reported, not used.
 */
export function verifyExecutionRunStartV2EchoV1(params: Readonly<{
  request: Pick<ExecutionRunStartV2Request, 'visibility' | 'role' | 'roleSource' | 'targetSessionId' | 'modelId'>;
  response: unknown;
}>): ExecutionRunStartV2EchoVerification {
  const { request } = params;
  const runId = params.response && typeof params.response === 'object' && typeof (params.response as { runId?: unknown }).runId === 'string'
    ? (params.response as { runId: string }).runId
    : undefined;
  const fail = (errorCode: typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED | typeof EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED, error: string): ExecutionRunStartV2EchoVerification => (
    { ok: false, errorCode, error, ...(runId ? { runId } : {}) }
  );
  const visibilityCode = request.visibility === 'session'
    ? EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED
    : EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED;
  const parsed = ExecutionRunStartV2ResponseSchema.safeParse(params.response);
  if (!parsed.success) return fail(visibilityCode, 'The run start response did not include the execution.run.start.v2 echo');
  const echo = parsed.data;
  if (echo.visibility !== request.visibility) {
    return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED, `The runner started a ${echo.visibility} run instead of a ${request.visibility} run`);
  }
  if (request.role !== undefined) {
    if (!echo.role || echo.role.id !== request.role || echo.roleSource !== request.roleSource) {
      return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED, 'The run start echo does not carry the requested role');
    }
  } else if (echo.role !== null || echo.roleSource !== 'none') {
    return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.ROLE_UNSUPPORTED, 'The run start echo carries a role that was not requested');
  }
  if (request.visibility === 'session') {
    const expectedBinding = request.targetSessionId ? 'reused' : 'created';
    if (echo.binding !== expectedBinding || !echo.linkedSessionId) {
      return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED, `The run start echo does not report a ${expectedBinding} linked session`);
    }
    if (request.targetSessionId && echo.linkedSessionId !== request.targetSessionId) {
      return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED, 'The run bound a different session than targetSessionId');
    }
  } else if (echo.binding !== null || echo.linkedSessionId !== null) {
    return fail(EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBILITY_UNSUPPORTED, 'A hidden run must not report a linked session');
  }
  if (request.modelId !== undefined && echo.modelId !== request.modelId) {
    return fail(visibilityCode, 'The run start echo reports a different model than requested');
  }
  return { ok: true, response: echo };
}
