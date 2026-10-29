import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { ApiTokenGrantDenialReasonV1Schema } from '../auth/apiTokenGrant.js';
import { UNEXPECTED_ACTION_FAILURE_CODES_V1 } from './actionExecutionResult.js';
import { EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1 } from './externalActionLimits.js';

export const ExternalActionRequestIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1), z.refine((value) => value.trim() === value, 'requestId must not have outer whitespace')));

const EXTERNAL_ACTION_HTTP_ERROR_CODES_V1 = [
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
] as const;
const ExternalActionHttpErrorCodeV1Schema = lazyZodSchema(() => z.enum(EXTERNAL_ACTION_HTTP_ERROR_CODES_V1));
export type ExternalActionHttpErrorCodeV1 = z.infer<typeof ExternalActionHttpErrorCodeV1Schema>;

const EXTERNAL_ACTION_HTTP_PLACEMENT_ERROR_CODES = [
  'credential_scope_denied',
  'present_user_required',
  'target_required',
  'target_not_local',
  'target_unavailable',
  'session_input_target_update_required',
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
  ...EXTERNAL_ACTION_HTTP_ERROR_CODES_V1,
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

const ExternalActionInvalidRequestHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'),
  code: ExternalActionPreOpenFailureCodeSchema,
  requestId: z.optional(ExternalActionRequestIdV1Schema),
}));
export const ExternalActionManagedAdmissionReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: z.string().check(z.minLength(1), z.refine(value => value.trim() === value)),
}));
export type ExternalActionManagedAdmissionReceiptV1 = z.infer<typeof ExternalActionManagedAdmissionReceiptV1Schema>;
const ExternalActionManagedWaitingHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_request'), code: z.literal('target_unavailable'),
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  managedAdmission: ExternalActionManagedAdmissionReceiptV1Schema,
}));

const ExternalActionAuthenticationHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.enum(EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES),
}));
export const ExternalActionCredentialScopeDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  admissionStage: z.literal('execution_authorization'),
  grantReason: ApiTokenGrantDenialReasonV1Schema,
}));
export type ExternalActionCredentialScopeDiagnosticV1 = z.infer<typeof ExternalActionCredentialScopeDiagnosticV1Schema>;
const ExternalActionCredentialScopeHttpErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('credential_scope_denied'),
  diagnostic: z.optional(ExternalActionCredentialScopeDiagnosticV1Schema),
}));

export type ActionCredentialScopeDeniedFailureV1 = Readonly<{
  ok: false;
  errorCode: 'credential_scope_denied';
  error: 'credential_scope_denied';
}>;

/** Authentication can refuse a domain route before its closed result exists. */
export function readActionCredentialScopeDeniedHttpFailureV1(
  status: number,
  payload: unknown,
): ActionCredentialScopeDeniedFailureV1 | null {
  if (status !== 403 || !ExternalActionCredentialScopeHttpErrorSchema.safeParse(payload).success) return null;
  return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
}

/** One strict redacted outer error union shared by both Action HTTP origins. */
export const ExternalActionHttpErrorSchema = lazyZodSchema(() => z.union([
  ExternalActionInvalidRequestHttpErrorSchema,
  ExternalActionManagedWaitingHttpErrorSchema,
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
): Readonly<{
  statusCode: 400 | 401 | 403 | 409 | 413 | 500 | 503;
  payload: ExternalActionHttpError;
}> {
  if (managedAdmission !== undefined) {
    if (code !== 'target_unavailable') throw new TypeError('Managed admission receipt requires target unavailability');
    return { statusCode: 409, payload: ExternalActionManagedWaitingHttpErrorSchema.parse({
      error: 'invalid_request', code, ...(requestId === undefined ? {} : { requestId }), managedAdmission,
    }) };
  }
  if (credentialScopeDiagnostic !== undefined && code !== 'credential_scope_denied') {
    throw new TypeError('Credential scope diagnostic requires credential scope denial');
  }
  if (code === 'present_user_required') return { statusCode: 403, payload: { error: code } };
  if (code === 'credential_scope_denied') return {
    statusCode: 403,
    payload: ExternalActionCredentialScopeHttpErrorSchema.parse({
      error: code,
      ...(credentialScopeDiagnostic === undefined ? {} : { diagnostic: credentialScopeDiagnostic }),
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
        },
      };
}

