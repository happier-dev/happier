import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionGoalControlFailureV1Schema } from '../sessions/work/state/sessionWorkStateRpc.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposeIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '../rpc/errors.js';
import { ActionErrorClassV1Schema, type ActionErrorClassV1 } from './actionErrorClassV1.js';
import { isPluginError } from '../plugins/errors.js';

const goalControlDiagnosticStages = ['client_creation', 'initialize', 'thread/goal/get', 'thread/goal/set',
  'thread/goal/clear', 'host_publication'] as const;
export type SessionGoalControlDiagnosticStage = typeof goalControlDiagnosticStages[number];

const goalControlNativeErrorCodes = new Set([
  'plugin_exec_native_launch_unavailable', 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
  'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE',
]);
function readGoalControlNativeErrorCode(value: unknown): string | null {
  return typeof value === 'string' && goalControlNativeErrorCodes.has(value) ? value : null;
}

/** Only stage and the existing content-free exception vocabulary cross Goal controls. */
export function projectSessionGoalControlDiagnosticDetails(
  stage: SessionGoalControlDiagnosticStage,
  error: unknown,
): Readonly<{ stage: SessionGoalControlDiagnosticStage; errorClass: ActionErrorClassV1 | 'PluginError'; errorCode: string | null }> {
  const { errorClass, errorCode } = readUnexpectedActionErrorDiagnosticV1(error);
  return { stage, errorClass: isPluginError(error) ? 'PluginError' : errorClass,
    errorCode: errorCode ?? readGoalControlNativeErrorCode(
      error && typeof error === 'object' && 'code' in error ? error.code : undefined) };
}

/** Plugin diagnostics may contain private data; never forward their opaque details. */
export function readSessionGoalControlDiagnosticDetails(
  value: unknown,
): ReturnType<typeof projectSessionGoalControlDiagnosticDetails> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const stage = goalControlDiagnosticStages.find(stage => stage === record.stage);
  if (!stage || typeof record.errorClass !== 'string') return null;
  const details = projectSessionGoalControlDiagnosticDetails(stage, {
    name: record.errorClass,
    code: record.errorClass === 'JsonRpcApplicationError' && typeof record.errorCode === 'string'
      ? Number(record.errorCode) : record.errorCode,
  });
  // Serialized diagnostics are data, not thrown PluginError authority.
  if (record.errorClass === 'PluginError') return { ...details, errorClass: 'PluginError' as const };
  return details.errorClass === record.errorClass ? details : null;
}

/** Historical, content-free admission facts. Not credential authority or a live readiness claim. */
export const ActionOperationCredentialUseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.enum(['connected_account', 'team_resource']),
  label: z.nullable(z.string().check(z.minLength(1))),
  owner: z.nullable(z.union([
    z.strictObject({ kind: z.literal('account'), accountId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)) }),
  ])),
  service: asProtocolZod(PluginContributionIdentityV1Schema),
  why: z.strictObject({
    kind: z.literal('purpose_binding'),
    purpose: QualifiedConnectedAccountPurposeV1Schema,
    target: z.enum(['account', 'group', 'listed_account']),
  }),
  currentness: z.strictObject({
    kind: z.literal('current_at_materialization'),
    resourceRevision: z.optional(z.number().check(z.int(), z.minimum(0))),
  }),
}).check(z.superRefine((value, ctx) => {
  if (value.owner && (value.kind === 'team_resource') !== (value.owner.kind === 'team')) {
    ctx.addIssue({ code: 'custom', path: ['owner'], message: 'Owner must describe the admitted credential kind' });
  }
  if (value.kind !== 'team_resource' && value.currentness.resourceRevision !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['currentness'], message: 'Resource revision requires a Team resource' });
  }
})));
export type ActionOperationCredentialUseV1 = z.infer<typeof ActionOperationCredentialUseV1Schema>;

/** A policy-deferred Action has not failed or executed; the present user owns the next step. */
export const ActionApprovalRequestCreatedResultSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('approval_request_created'),
  artifactId: z.string().check(z.trim(), z.minLength(1)),
  actionId: z.string().check(z.trim(), z.minLength(1)),
}));

export type ActionApprovalRequestCreatedResult = Readonly<
  z.infer<typeof ActionApprovalRequestCreatedResultSchema>
>;

/** Content-free diagnosis of a Home mutation whose acknowledgement was lost. */
export const AccountActionHttpFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  category: z.enum(['transport_timeout', 'transport_error', 'acknowledgement_schema']),
}));
export type AccountActionHttpFailureDetailsV1 = z.infer<typeof AccountActionHttpFailureDetailsV1Schema>;

/** Closed transport vocabulary shared by reverse delivery and durable approval history. */
export const ClientActionRpcFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  ...Object.values(RPC_ERROR_CODES), MACHINE_RPC_TIMEOUT_ERROR_CODE,
  'machine_socket_unavailable', 'machine_rpc_result_decrypt_failed', 'cancelled',
]));
const clientHttpStatus = z.nullable(z.number().check(z.int(), z.minimum(100), z.maximum(599)));
const clientErrorCode = z.string().check(z.refine(value =>
  readUnexpectedActionErrorDiagnosticV1({ name: 'Error', code: value }).errorCode === value
  || readUnexpectedActionErrorDiagnosticV1({ name: 'JsonRpcApplicationError', code: Number(value) }).errorCode === value));
/** No prose, stack, query, identity or arbitrary receiver data may enter saved client failures. */
export const ClientActionFailureDetailsV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ reason: z.enum(['client_rpc_transport_failure', 'client_rpc_invalid_response']),
    errorCode: z.nullable(ClientActionRpcFailureCodeV1Schema),
    errorClass: z.optional(ActionErrorClassV1Schema), httpStatus: z.optional(clientHttpStatus) }),
  z.strictObject({ reason: z.literal('client_execution_exception'), errorClass: ActionErrorClassV1Schema,
    errorCode: z.nullable(clientErrorCode), httpStatus: clientHttpStatus }),
  z.strictObject({ reason: z.literal('client_account_scope_changed') }),
]));

/**
 * The canonical outcome shape shared by Action execution projections.
 *
 * It is deliberately separate from the daemon-heavy executor type graph so
 * browser-facing SDK declarations do not pull the aggregate Actions barrel.
 */
export const ActionExecuteFailureSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: z.string().check(z.trim(), z.minLength(1)),
  error: z.string().check(z.trim(), z.minLength(1)),
  // Failure details remain an existing opaque Action contract. Their owning
  // producers decide their shape; this public envelope only excludes extra
  // top-level transit metadata.
  details: z.optional(z.unknown()),
  goalControlFailure: z.optional(SessionGoalControlFailureV1Schema),
}));

export type ActionExecuteFailure = Readonly<z.infer<typeof ActionExecuteFailureSchema>>;

export type ActionExecuteResult = Readonly<{
  /** Host-only settlement annotation; public failure envelopes remain unchanged. Never Action input. */
  operationCredentialUses?: readonly ActionOperationCredentialUseV1[];
}> & (
  | Readonly<{ ok: true; result: unknown }>
  | ActionExecuteFailure);

/** The complete public Action settlement, including original operation custody. */
export const ActionExecuteResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    result: z.unknown(),
    operationCredentialUses: z.optional(z.array(ActionOperationCredentialUseV1Schema)),
  }),
  z.strictObject({
    ...ActionExecuteFailureSchema.shape,
    operationCredentialUses: z.optional(z.array(ActionOperationCredentialUseV1Schema)),
  }),
]));

/** Failure of confirmation is not proof that an admitted effect did not happen. */
export const UNEXPECTED_ACTION_FAILURE_CODES_V1 = ['action_not_admitted', 'action_outcome_unknown'] as const;

/** A lost acknowledgement is not a definite failure, including approval replay. */
export function isActionOutcomeUnknownErrorCodeV1(code: unknown): boolean {
  return code === 'outcome_unknown' || code === UNEXPECTED_ACTION_FAILURE_CODES_V1[1]
    || code === 'approval_execution_outcome_unknown'
    // The Project row transport/receipt owner has already classified settlement.
    || code === 'project_account_row_outcome_unknown' || code === 'project_account_row_acknowledgement_invalid';
}

export function projectUnexpectedActionFailureV1(admissionCommitted: boolean | null, requestId?: string): ActionExecuteFailure & Readonly<{
  errorCode: typeof UNEXPECTED_ACTION_FAILURE_CODES_V1[number];
}> {
  const errorCode = admissionCommitted === false ? 'action_not_admitted' : 'action_outcome_unknown';
  return { ok: false, errorCode,
    error: errorCode === 'action_not_admitted'
      ? 'Creation could not be confirmed; nothing was created.'
      : 'The Action outcome is unknown. Check its state before trying again.',
    ...(requestId ? { details: { requestId } } : {}),
  };
}

/** Code-only diagnostic shared by the existing Home and daemon log owners. */
export function readUnexpectedActionErrorDiagnosticV1(error: unknown): Readonly<{
  errorClass: ActionErrorClassV1;
  errorCode: string | null;
  httpStatus: number | null;
  stackFrames: readonly Readonly<{ file: string; line: number; column: number }>[];
}> {
  let errorClass: ActionErrorClassV1 = 'UnknownThrownValue';
  let errorCode: string | null = null;
  let httpStatus: number | null = null;
  const stackFrames: Array<{ file: string; line: number; column: number }> = [];
  try {
    errorClass = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
      : error instanceof SyntaxError ? 'SyntaxError' : error instanceof Error ? 'Error' : 'UnknownThrownValue';
    if (error && typeof error === 'object') {
      const name = 'name' in error ? error.name : undefined;
      const parsedClass = ActionErrorClassV1Schema.safeParse(name);
      if (parsedClass.success) errorClass = parsedClass.data;
      const code = 'code' in error ? error.code : undefined;
      // Only known platform/database/Session codes; arbitrary fields may be private content.
      if (typeof code === 'string' && (/^P\d{4}$/u.test(code) || [
        'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EBUSY', 'EINVAL',
        'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
        'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_FULL', 'SQLITE_CONSTRAINT', 'SQLITE_ERROR',
        'SQLITE_CANTOPEN', 'SQLITE_CORRUPT',
        'session_detail_invalid_response', 'session_detail_projection_unavailable', 'not_authenticated', 'client-upgrade-required',
        'database_transaction_conflict_exhausted', 'database_connection_unavailable',
      ].includes(code))) errorCode = code;
      // JSON-RPC reserves these protocol/server codes. Preserve only that
      // bounded vocabulary, never native application data or message text.
      if (name === 'JsonRpcApplicationError' && typeof code === 'number' && Number.isInteger(code)
        && ([-32700, -32600, -32601, -32602, -32603].includes(code)
          || (code >= -32099 && code <= -32000))) errorCode = String(code);
      const response = 'response' in error ? error.response : undefined;
      // Only the Home's known availability vocabulary may cross from an HTTP
      // body. An arbitrary server error/code can itself contain private data.
      const data = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
      if (errorCode === null && data && typeof data === 'object') {
        const serverCode = 'error' in data ? data.error : 'code' in data ? data.code : undefined;
        if (serverCode === 'database_transaction_conflict_exhausted' || serverCode === 'database_connection_unavailable') errorCode = serverCode;
      }
      const status = response && typeof response === 'object' && 'status' in response ? response.status
        : 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
      const stack = 'stack' in error ? error.stack : undefined;
      const message = 'message' in error ? error.message : undefined;
      // V8 renders the entire (possibly multiline) message before its frames.
      // Without that exact header, a source-looking line has no established
      // provenance and must not be persisted as a code-only diagnostic.
      const header = typeof name === 'string' && typeof message === 'string'
        ? (name ? (message ? `${name}: ${message}` : name) : message) : undefined;
      const frames = typeof stack === 'string' && header !== undefined && stack.startsWith(`${header}\n`)
        ? stack.slice(header.length + 1).split('\n') : [];
      for (const frame of frames) {
        const pointer = /^\s*at (?:.*\()?((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[\w./\\:@+-]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)\)?$/u.exec(frame);
        if (pointer) stackFrames.push({ file: pointer[1], line: Number(pointer[2]), column: Number(pointer[3]) });
      }
    }
  } catch { /* Hostile Error accessors cannot replace the original failure. */ }
  return { errorClass, errorCode, httpStatus, stackFrames };
}


/**
 * Projects an Action failure onto the public envelope. This is intentionally
 * not a generic error parser: known Action fields and opaque details survive,
 * while bridge-private top-level metadata cannot cross the Action boundary.
 */
export function projectActionExecuteFailure(result: ActionExecuteFailure): ActionExecuteFailure {
  const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(result.goalControlFailure);
  const projected = ActionExecuteFailureSchema.safeParse({
    ok: false,
    errorCode: result.errorCode,
    error: result.error,
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(goalControlFailure.success ? { goalControlFailure: goalControlFailure.data } : {}),
  });
  return projected.success
    ? projected.data
    : { ok: false, errorCode: 'action_failed', error: 'action_failed' };
}

/**
 * A present person (or their approver) answered an Action's confirmation or approval with "no":
 * `approval_rejected` is an explicit rejection, `approval_canceled` is the dialog or request being
 * withdrawn. Either way the Action did not run and nothing failed, so a caller that has no reason to
 * tell the two apart stays quiet. This is the one predicate over those codes; callers that present
 * the two differently (for example "rejected" versus "canceled" wording) still read the code itself.
 */
export function isActionApprovalDeclinedErrorCode(code: unknown): boolean {
  return code === 'approval_rejected' || code === 'approval_canceled';
}

/**
 * A person turned this Action off in Settings, Actions: it did not run and nothing failed. In-app
 * callers present a calm notice that leads to that setting instead of an error, and this is the one
 * predicate over that code.
 */
export function isActionTurnedOffErrorCode(code: unknown): boolean {
  return code === 'action_disabled';
}
