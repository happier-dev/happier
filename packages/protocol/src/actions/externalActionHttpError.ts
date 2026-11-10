import { ExternalActionAuthorizationRefusalPhaseSchema } from './externalActionAuthorizationRefusalPhase.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { ApiTokenGrantDenialReasonV1Schema } from '../auth/apiTokenGrant.js';
import { ActionExecuteFailureSchema, ActionFailureCauseV1Schema, UNEXPECTED_ACTION_FAILURE_CODES_V1, type ActionExecuteFailure, type ActionFailureCauseV1 } from './actionExecutionResult.js';
import { EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1 } from './externalActionLimits.js';
import { RPC_ERROR_CODES } from '../rpc/errors.js';
import { MachineAvailabilityDiagnosticV1Schema, type MachineAvailabilityDiagnosticV1 } from '../machines/machineAccessV1.js';

export const ExternalActionRequestIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1), z.refine((value) => value.trim() === value, 'requestId must not have outer whitespace')));

const ExternalActionHttpErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_action',
  'invalid_envelope',
  'request_too_large',
  'internal_error',
  ...UNEXPECTED_ACTION_FAILURE_CODES_V1,
  'database_transaction_conflict_exhausted',
  'database_transaction_timeout',
  'database_connection_unavailable',
  'storage_unavailable',
  'project_requester_home_unavailable',
  'invalid_encrypted_envelope',
  'encrypted_action_unsupported',
] as const));
export type ExternalActionHttpErrorCodeV1 = z.infer<typeof ExternalActionHttpErrorCodeV1Schema>;

const EXTERNAL_ACTION_HTTP_PLACEMENT_ERROR_CODES = [
  'credential_scope_denied',
  'present_user_required',
  'target_required',
  'target_not_local',
  'target_unavailable',
  'session_input_target_update_required',
  // The owner's typed cap refusal: the requester was admitted to ask, and the answer is about their own Preset.
  'preset_limit_reached',
] as const;
const EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES = [
  'invalid_token',
  'auth_unavailable',
  'server_unavailable',
] as const;

/**
 * Complete bounded pre-open failure vocabulary. These values carry no Action
 * input, execution detail, target metadata, or daemon diagnostics.
 */
export const ExternalActionHttpErrorCodeSchema = lazyZodSchema(() => z.enum([
  ...ExternalActionHttpErrorCodeV1Schema.options,
  ...EXTERNAL_ACTION_HTTP_PLACEMENT_ERROR_CODES,
  ...EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES,
]));
export type ExternalActionHttpErrorCode = z.infer<typeof ExternalActionHttpErrorCodeSchema>;

/**
 * One bounded vocabulary for failures that occur before a protected Action
 * request has been opened. HTTP adapters and the reserved daemon relay project
 * the same codes; authentication-only failures remain at their HTTP boundary.
 */
export const ExternalActionPreOpenFailureCodeSchema = lazyZodSchema(() => (<const Values extends readonly string[], const Excluded extends readonly Values[number][]>(values: Values, excluded: Excluded) => { for (const value of excluded) if (!values.includes(value)) throw new Error(`Key ${value} not found in enum`); return z.enum(values.filter((value): value is Exclude<Values[number], Excluded[number]> => !excluded.some(item => item === value))); })(ExternalActionHttpErrorCodeSchema.options, EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES));
export type ExternalActionPreOpenFailureCode = z.infer<
  typeof ExternalActionPreOpenFailureCodeSchema
>;

/** Stable transport failures emitted before an Action execution envelope exists. */
export const ExternalActionHttpErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'),
  code: ExternalActionHttpErrorCodeV1Schema,
}));
export type ExternalActionHttpErrorV1 = z.infer<typeof ExternalActionHttpErrorV1Schema>;

/** Content-free refusal location supplied by the target admission owner. */
export const ExternalActionTargetRefusalPhaseSchema = lazyZodSchema(() => z.enum([
  'target_placement', 'target_cancelled', 'target_custodian', 'target_installation', 'target_requester_context',
]));
export type ExternalActionTargetRefusalPhase = z.infer<typeof ExternalActionTargetRefusalPhaseSchema>;

const ExternalActionInvalidRequestHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'),
  code: ExternalActionPreOpenFailureCodeSchema,
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  failureCause: z.optional(ActionFailureCauseV1Schema),
}));
const ExternalActionTargetRefusalHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  ...ExternalActionInvalidRequestHttpErrorSchema.shape,
  code: z.literal('target_not_local'),
  phase: z.optional(ExternalActionTargetRefusalPhaseSchema),
}));
export const ExternalActionManagedAdmissionReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: z.string().check(z.minLength(1), z.refine(value => value.trim() === value)),
}));
export type ExternalActionManagedAdmissionReceiptV1 = z.infer<typeof ExternalActionManagedAdmissionReceiptV1Schema>;
const ExternalActionTargetUnavailableHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'), code: z.literal('target_unavailable'),
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  managedAdmission: z.optional(ExternalActionManagedAdmissionReceiptV1Schema),
  diagnostic: z.optional(MachineAvailabilityDiagnosticV1Schema),
}));

export { ExternalActionAuthorizationRefusalPhaseSchema, type ExternalActionAuthorizationRefusalPhase } from './externalActionAuthorizationRefusalPhase.js';

const ExternalActionAuthenticationHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.enum(EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES),
  authorizationRefusal: z.optional(ExternalActionAuthorizationRefusalPhaseSchema),
  details: ActionExecuteFailureSchema.shape.details,
  failureCause: ActionExecuteFailureSchema.shape.failureCause,
}));
export const ExternalActionCredentialScopeDiagnosticV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    admissionStage: z.literal('execution_authorization'),
    grantReason: ApiTokenGrantDenialReasonV1Schema,
  }),
  z.strictObject({
    admissionStage: z.literal('daemon_rpc'),
    errorCode: z.literal(RPC_ERROR_CODES.FORBIDDEN),
    failureCause: z.optional(ActionFailureCauseV1Schema),
  }),
]));
export type ExternalActionCredentialScopeDiagnosticV1 = z.infer<typeof ExternalActionCredentialScopeDiagnosticV1Schema>;
const ExternalActionCredentialScopeHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('credential_scope_denied'),
  diagnostic: z.optional(ExternalActionCredentialScopeDiagnosticV1Schema),
  authorizationRefusal: z.optional(ExternalActionAuthorizationRefusalPhaseSchema),
  details: ActionExecuteFailureSchema.shape.details,
  failureCause: ActionExecuteFailureSchema.shape.failureCause,
}));

/** Transport evidence only: an RPC refusal is not an authenticated Action settlement. */
export const ExternalActionSubmittedUnknownCauseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ reason: z.literal('daemon_rpc_refused'), errorCode: z.enum(Object.values(RPC_ERROR_CODES)) }),
  z.strictObject({ reason: z.enum(['daemon_acknowledgement_lost', 'daemon_response_invalid', 'managed_wake_unconfirmed']) }),
]));
export type ExternalActionSubmittedUnknownCauseV1 = z.infer<typeof ExternalActionSubmittedUnknownCauseV1Schema>;
const ExternalActionSubmittedUnknownHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'), code: z.literal('action_outcome_unknown'),
  requestId: z.optional(ExternalActionRequestIdV1Schema), diagnostic: ExternalActionSubmittedUnknownCauseV1Schema,
}));

export type ActionCredentialScopeDeniedFailureV1 = Pick<ActionExecuteFailure, 'details' | 'failureCause'> & Readonly<{
  ok: false;
  errorCode: 'credential_scope_denied';
  error: 'credential_scope_denied';
}>;

/** Authentication can refuse a domain route before its closed result exists. */
export function readActionCredentialScopeDeniedHttpFailureV1(
  status: number,
  payload: unknown,
): ActionCredentialScopeDeniedFailureV1 | null {
  if (status !== 403) return null;
  const parsed = ExternalActionCredentialScopeHttpErrorSchema.safeParse(payload);
  if (!parsed.success) return null;
  return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
    ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
    ...(parsed.data.failureCause === undefined ? {} : { failureCause: parsed.data.failureCause }) };
}

/** One strict redacted outer error union shared by both Action HTTP origins. */
export const ExternalActionHttpErrorSchema = lazyZodSchema(() => z.union([
  ExternalActionSubmittedUnknownHttpErrorSchema,
  ExternalActionInvalidRequestHttpErrorSchema,
  ExternalActionTargetRefusalHttpErrorSchema,
  ExternalActionTargetUnavailableHttpErrorSchema,
  ExternalActionAuthenticationHttpErrorSchema,
  ExternalActionCredentialScopeHttpErrorSchema,
  z.strictObject({ error: z.literal('present_user_required') }),
]));
export type ExternalActionHttpError = z.infer<typeof ExternalActionHttpErrorSchema>;

function isExternalActionHttpAuthenticationErrorCode(
  code: ExternalActionHttpErrorCode,
): code is typeof EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES[number] {
  return EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES.some((candidate) => candidate === code);
}

/** Maps a protocol transport failure to its complete HTTP representation. */
function externalActionHttpErrorStatus(code: ExternalActionHttpErrorCode): 400 | 401 | 403 | 409 | 413 | 500 | 503 {
  if (code === 'credential_scope_denied' || code === 'present_user_required') return 403;
  if (code === 'invalid_token') return 401;
  if (code === 'auth_unavailable' || code === 'server_unavailable'
    || code === 'database_transaction_conflict_exhausted' || code === 'database_transaction_timeout' || code === 'database_connection_unavailable'
    || code === 'storage_unavailable' || code === 'project_requester_home_unavailable') return 503;
  if (code === 'request_too_large') return 413;
  if (code === 'internal_error' || UNEXPECTED_ACTION_FAILURE_CODES_V1.some(value => value === code)) return 500;
  if (
    code === 'encrypted_action_unsupported'
    || code === 'target_not_local'
    || code === 'target_unavailable'
    || code === 'session_input_target_update_required'
    || code === 'preset_limit_reached'
  ) return 409;
  return 400;
}

export function projectExternalActionHttpErrorV1(code: ExternalActionHttpErrorCodeV1): Readonly<{
  statusCode: 400 | 409 | 413 | 500 | 503;
  payload: ExternalActionHttpErrorV1;
}> {
  return {
    statusCode: externalActionHttpErrorStatus(code) as 400 | 409 | 413 | 500 | 503,
    payload: { error: 'invalid_request', code },
  };
}

/** Maps a bounded pre-open failure to its complete redacted HTTP representation. */
export function projectExternalActionHttpError(
  code: ExternalActionHttpErrorCode,
  requestId?: string,
  managedAdmission?: ExternalActionManagedAdmissionReceiptV1,
  credentialScopeDiagnostic?: ExternalActionCredentialScopeDiagnosticV1,
  phase?: ExternalActionTargetRefusalPhase,
  machineAvailabilityDiagnostic?: MachineAvailabilityDiagnosticV1,
  failureCause?: ActionFailureCauseV1,
): Readonly<{
  statusCode: 400 | 401 | 403 | 409 | 413 | 500 | 503;
  payload: ExternalActionHttpError;
}> {
  if (phase !== undefined && code !== 'target_not_local') {
    throw new TypeError('Target refusal phase requires target locality refusal');
  }
  if (managedAdmission !== undefined && code !== 'target_unavailable') {
    throw new TypeError('Managed admission receipt requires target unavailability');
  }
  if (machineAvailabilityDiagnostic !== undefined && code !== 'target_unavailable') {
    throw new TypeError('Machine availability diagnostic requires target unavailability');
  }
  if (credentialScopeDiagnostic !== undefined && code !== 'credential_scope_denied') {
    throw new TypeError('Credential scope diagnostic requires credential scope denial');
  }
  if (code === 'target_unavailable') return { statusCode: 409, payload: ExternalActionTargetUnavailableHttpErrorSchema.parse({
    error: 'invalid_request', code, ...(requestId === undefined ? {} : { requestId }),
    ...(managedAdmission === undefined ? {} : { managedAdmission }),
    ...(machineAvailabilityDiagnostic === undefined ? {} : { diagnostic: machineAvailabilityDiagnostic }),
  }) };
  if (phase !== undefined) return { statusCode: 409, payload: ExternalActionTargetRefusalHttpErrorSchema.parse({
    error: 'invalid_request', code, ...(requestId === undefined ? {} : { requestId }), phase,
  }) };
  if (code === 'present_user_required') return { statusCode: 403, payload: { error: code } };
  if (code === 'credential_scope_denied') return {
    statusCode: 403,
    payload: ExternalActionCredentialScopeHttpErrorSchema.parse({
      error: code,
      ...(credentialScopeDiagnostic === undefined ? {} : { diagnostic: credentialScopeDiagnostic }),
      ...(failureCause === undefined ? {} : { failureCause }),
    }),
  };
  return isExternalActionHttpAuthenticationErrorCode(code)
    ? { statusCode: externalActionHttpErrorStatus(code), payload: { error: code } }
    : {
        statusCode: externalActionHttpErrorStatus(code),
        payload: {
          error: 'invalid_request',
          code,
          ...(requestId === undefined ? {} : { requestId }),
          ...(failureCause === undefined ? {} : { failureCause: ActionFailureCauseV1Schema.parse(failureCause) }),
        },
      };
}

