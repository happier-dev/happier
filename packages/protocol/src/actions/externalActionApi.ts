import { lazyZodSchema } from '../lazyZodSchema.js';
import { AccessibleMachineAccessV1Schema } from '../machines/machineAccessV1.js';
import { z } from 'zod';
import { ApiTokenGrantV1Schema, ApiTokenSessionSpawnAdmissionV1Schema } from '../auth/apiTokenGrant.js';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../auth/authToken.js';
import { ManagedAdmissionComputeInputV1Schema } from '../machines/managed/actionsV1.js';
import { ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import { AccountEncryptionModeSchema, type AccountEncryptionMode } from '../features/payload/capabilities/encryptionCapabilities.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';
import type { ProjectAccountRowCipherV1 } from '../projects/projectAccountRowCipherV1.js';
import type { PromptArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket.js';
import { MachineInstallationProofV1Schema, MachineInstallationPublicKeySchema } from '../machines/identity/installationIdentity.js';
import { ManagedWakeTargetV1Schema } from '../machines/managed/managedIntentV1.js';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from './projectActionFamily.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from '../sessions/creation/sessionRequesterBootstrapSchemasV1.js';
import type { ExternalActionRequesterAccountContextPurposeV1 } from '../sessions/creation/sessionRequesterBootstrapV1.js';
import type { ProjectTrustContentV1, ProjectTrustValueV1, QualifiedProjectTrustProjectV1 } from '../workspaces/projectSetup/projectTrustRowV1.js';
import type { MachinePublishedRowV1 } from '../machines/machineContentKeyTransitionV1.js';
import type { AuthoringMemoryContentV1, AuthoringMemoryValueV1 } from '../account/authoringMemory.js';
import type { PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import type { createActionExecutor } from './actionExecutor.js';

import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBindingSchema.js';
import { RunnerClaimV1Schema } from '../ephemeralRunner/endpoint.js';
import { MachineKindFromLegacyProjectionSchema } from '../machines/machineKind.js';

import {
  ActionExecuteFailureSchema,
  type ActionExecuteResult,
} from './actionExecutionResult.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../crypto/accountScopedCipherEnvelope.js';
import {
  measurePluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../plugins/contributions/strictJsonValue.js';
import {
  EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH,
  EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from './externalActionLimits.js';

export {
  EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH,
  EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
};

/** Shared finite HTTP request ceiling for both public Action API origins. */
export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Minimum Socket.IO capacity for a server-to-daemon Action request. This
 * leaves a 1 MiB carrier reserve above the admitted HTTP request body.
 */
export const EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES = 33 * 1024 * 1024;

/** Minimum Socket.IO capacity for a daemon-to-server Action response. */
export const EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES = 25_000_000;

/** Relative path prefix; the Action id is the final path segment. */
export const EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1 = '/v1/actions/' as const;

/**
 * The public path segment is an opaque identifier to the server relay. Its
 * finite scalar bound matches the other external Action identity fields while
 * admission remains exclusively with the target daemon's Action registry.
 */
export const ExternalActionActionIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH)
  .refine((value) => value.trim() === value, 'actionId must not have outer whitespace'));
export type ExternalActionActionIdV1 = z.infer<typeof ExternalActionActionIdV1Schema>;

export const ExternalActionRequestIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1)
  .refine((value) => value.trim() === value, 'requestId must not have outer whitespace'));

const EXTERNAL_ACTION_HTTP_ERROR_CODES_V1 = [
  'invalid_action',
  'invalid_envelope',
  'request_too_large',
  'internal_error',
  'invalid_encrypted_envelope',
  'encrypted_action_unsupported',
] as const;
const ExternalActionHttpErrorCodeV1Schema = lazyZodSchema(() => z.enum(EXTERNAL_ACTION_HTTP_ERROR_CODES_V1));
export type ExternalActionHttpErrorCodeV1 = z.infer<typeof ExternalActionHttpErrorCodeV1Schema>;

const EXTERNAL_ACTION_HTTP_PLACEMENT_ERROR_CODES = [
  'credential_scope_denied',
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
export const ExternalActionPreOpenFailureCodeSchema = lazyZodSchema(() => ExternalActionHttpErrorCodeSchema
  .exclude(EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES));
export type ExternalActionPreOpenFailureCode = z.infer<
  typeof ExternalActionPreOpenFailureCodeSchema
>;

/** Stable transport failures emitted before an Action execution envelope exists. */
export const ExternalActionHttpErrorV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('invalid_request'),
  code: ExternalActionHttpErrorCodeV1Schema,
}).strict());
export type ExternalActionHttpErrorV1 = z.infer<typeof ExternalActionHttpErrorV1Schema>;

const ExternalActionInvalidRequestHttpErrorSchema = lazyZodSchema(() => z.object({
  error: z.literal('invalid_request'),
  code: ExternalActionPreOpenFailureCodeSchema,
  requestId: ExternalActionRequestIdV1Schema.optional(),
}).strict());
export const ExternalActionManagedAdmissionReceiptV1Schema = lazyZodSchema(() => z.object({
  managedId: z.string().min(1).refine(value => value.trim() === value),
}).strict());
export type ExternalActionManagedAdmissionReceiptV1 = z.infer<typeof ExternalActionManagedAdmissionReceiptV1Schema>;
const ExternalActionManagedWaitingHttpErrorSchema = lazyZodSchema(() => z.object({
  error: z.literal('invalid_request'), code: z.literal('target_unavailable'),
  requestId: ExternalActionRequestIdV1Schema.optional(),
  managedAdmission: ExternalActionManagedAdmissionReceiptV1Schema,
}).strict());

const ExternalActionAuthenticationHttpErrorSchema = lazyZodSchema(() => z.object({
  error: z.enum(EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES),
}).strict());
const ExternalActionCredentialScopeHttpErrorSchema = lazyZodSchema(() => z.object({ error: z.literal('credential_scope_denied') }).strict());

/** One strict redacted outer error union shared by both Action HTTP origins. */
export const ExternalActionHttpErrorSchema = lazyZodSchema(() => z.union([
  ExternalActionInvalidRequestHttpErrorSchema,
  ExternalActionManagedWaitingHttpErrorSchema,
  ExternalActionAuthenticationHttpErrorSchema,
  ExternalActionCredentialScopeHttpErrorSchema,
]));
export type ExternalActionHttpError = z.infer<typeof ExternalActionHttpErrorSchema>;

function isExternalActionHttpAuthenticationErrorCode(
  code: ExternalActionHttpErrorCode,
): code is typeof EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES[number] {
  return EXTERNAL_ACTION_HTTP_AUTHENTICATION_ERROR_CODES.some((candidate) => candidate === code);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The one transport-neutral projection from internal Action execution into
 * the public external Action result. Internal contributors may retain richer
 * diagnostics; neither HTTP origin can disclose them as top-level fields.
 */
export function projectExternalActionExecutionResultV1(value: unknown): ActionExecuteResult | null {
  const result = readRecord(value);
  if (!result) return null;

  if (result.ok === true && Object.prototype.hasOwnProperty.call(result, 'result')) {
    return { ok: true, result: result.result };
  }
  if (result.ok !== false) return null;

  const failure = ActionExecuteFailureSchema.safeParse({
    ok: false,
    errorCode: result.errorCode,
    error: result.error,
    ...(Object.prototype.hasOwnProperty.call(result, 'details')
      ? { details: result.details }
      : {}),
  });
  return failure.success ? failure.data : null;
}

/** Maps a protocol transport failure to its complete HTTP representation. */
function externalActionHttpErrorStatus(code: ExternalActionHttpErrorCode): 400 | 401 | 403 | 409 | 413 | 500 | 503 {
  if (code === 'credential_scope_denied') return 403;
  if (code === 'invalid_token') return 401;
  if (code === 'auth_unavailable' || code === 'server_unavailable') return 503;
  if (code === 'request_too_large') return 413;
  if (code === 'internal_error') return 500;
  if (
    code === 'encrypted_action_unsupported'
    || code === 'target_not_local'
    || code === 'target_unavailable'
    || code === 'session_input_target_update_required'
  ) return 409;
  return 400;
}

export function projectExternalActionHttpErrorV1(code: ExternalActionHttpErrorCodeV1): Readonly<{
  statusCode: 400 | 409 | 413 | 500;
  payload: ExternalActionHttpErrorV1;
}> {
  return {
    statusCode: externalActionHttpErrorStatus(code) as 400 | 409 | 413 | 500,
    payload: { error: 'invalid_request', code },
  };
}

/** Maps a bounded pre-open failure to its complete redacted HTTP representation. */
export function projectExternalActionHttpError(
  code: ExternalActionHttpErrorCode,
  requestId?: string,
  managedAdmission?: ExternalActionManagedAdmissionReceiptV1,
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
  if (code === 'credential_scope_denied') return { statusCode: 403, payload: { error: code } };
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

/** Closed server-to-exact-daemon method; never a public Action or SDK method. */
export const EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 =
  'daemon.actions.external.dispatch' as const;

/**
 * Recovers only safe correlation from a purported protected outer frame. It
 * deliberately does not classify the frame as valid or expose any other key.
 */
export function readExternalActionProtectedRequestId(value: unknown): string | undefined {
  const record = readRecord(value);
  if (record?.v !== 2) return undefined;
  const requestId = ExternalActionRequestIdV1Schema.safeParse(record.requestId);
  return requestId.success ? requestId.data : undefined;
}

const ExternalActionExecutionSuccessV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  result: z.unknown(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result'],
      message: 'result is required',
    });
  }
}));

/** Closed public execution union. Bridge-private execution metadata cannot cross it. */
export const ExternalActionExecutionResultV1Schema = lazyZodSchema(() => z.union([
  ExternalActionExecutionSuccessV1Schema,
  ActionExecuteFailureSchema,
]));

const EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE =
  'Action execution completed, but its response exceeded the external Action response limit and could not be represented.' as const;

/** Strict admitted result used only after the Action has completed. */
export const ExternalActionResultTooLargeExecutionV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: z.literal('result_too_large'),
  error: z.literal(EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE),
  details: z.object({
    executionCompleted: z.literal(true),
    maxSerializedBytes: z.literal(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
  }).strict(),
}).strict());
export type ExternalActionResultTooLargeExecutionV1 = Readonly<z.infer<
  typeof ExternalActionResultTooLargeExecutionV1Schema
>>;

export function createExternalActionResultTooLargeExecutionV1(): ExternalActionResultTooLargeExecutionV1 {
  return {
    ok: false,
    errorCode: 'result_too_large',
    error: EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE,
    details: {
      executionCompleted: true,
      maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    },
  };
}

/**
 * Strict public external Action response. Both HTTP origins and the SDK use
 * this one envelope; Action-domain failures stay inside `execution`.
 */
export const ExternalActionResponseEnvelopeV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema.optional(),
  execution: ExternalActionExecutionResultV1Schema,
}).strict());

/**
 * Strict outer relay framing. The relay may receive a daemon execution result
 * with private metadata, but never gains a second public response envelope.
 */
const ExternalActionResponseEnvelopeV1ProjectionInputSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema.optional(),
  execution: z.unknown(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'execution')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution'],
      message: 'execution is required',
    });
  }
}));

/** Stable finite response envelope shared by the daemon and server adapters. */
export type ExternalActionResponseEnvelopeV1 = Readonly<{
  v: 1;
  actionId: ExternalActionActionIdV1;
  requestId?: string;
  execution: ActionExecuteResult;
}>;

/**
 * The one strict JSON response projection prepared after external Action
 * execution. Same-process HTTP adapters send these bytes directly; the
 * reserved daemon relay carries a binary projection of these exact bytes.
 */
export type PreparedExternalActionResponseEnvelopeV1 = Readonly<{
  response: ExternalActionResponseEnvelopeV1;
  body: string;
  byteLength: number;
}>;

/**
 * Projects an exact-daemon relay result onto the one strict public response
 * union. Only execution metadata is normalized; relay envelope fields remain
 * closed and are never rewritten by a transport adapter.
 */
export function projectExternalActionResponseEnvelopeV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 | null {
  const parsed = ExternalActionResponseEnvelopeV1ProjectionInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const execution = projectExternalActionExecutionResultV1(parsed.data.execution);
  if (!execution) return null;
  return {
    v: 1,
    actionId: parsed.data.actionId,
    ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
    execution,
  };
}

/**
 * Reads the strict public response shape and returns the canonical Action
 * execution projection. Consumers never need a hand-written response parser.
 */
export function parseExternalActionResponseEnvelopeV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 | null {
  const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const execution = projectExternalActionExecutionResultV1(parsed.data.execution);
  if (!execution) return null;
  return {
    v: 1,
    actionId: parsed.data.actionId,
    ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
    execution,
  };
}

const ExternalActionDaemonDispatchInvalidRequestCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_action',
  'invalid_envelope',
]));
export type ExternalActionDaemonDispatchInvalidRequestCodeV1 = z.infer<
  typeof ExternalActionDaemonDispatchInvalidRequestCodeV1Schema
>;

const ExternalActionDaemonDispatchInvalidRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('invalid_request'),
  errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1Schema,
}).strict());

/**
 * Socket.IO carries the already-prepared public response as a binary
 * attachment. A JSON string would need another escaping pass in the Socket.IO
 * frame and could exceed the one-megabyte response-carrier reserve.
 */
const ExternalActionDaemonDispatchPreparedBodyV1Schema = lazyZodSchema(() => z.instanceof(Uint8Array)
  .refine(
    (value) => value.byteLength <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    `external Action relay response must not exceed ${EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES} bytes`,
  ));

/**
 * Closed result of the reserved server-to-daemon Action relay. Admission
 * failures remain transport failures; only a completed/admitted Action may
 * carry the already-serialized strict public response bytes.
 */
export const ExternalActionDaemonDispatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExternalActionDaemonDispatchInvalidRequestV1Schema,
  z.object({
    kind: z.literal('response'),
    body: ExternalActionDaemonDispatchPreparedBodyV1Schema,
  }).strict(),
]));
export type ExternalActionDaemonDispatchResultV1 = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1;
  }
  | {
    kind: 'response';
    body: Uint8Array;
  }
>;

/** Parsed relay result; the prepared body is never re-projected or remeasured. */
export type ParsedExternalActionDaemonDispatchResultV1 = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1;
  }
  | {
    kind: 'response';
    prepared: PreparedExternalActionResponseEnvelopeV1;
  }
>;

/**
 * Projects the canonical prepared body onto the existing closed reserved-RPC
 * response wrapper. The payload is binary so Socket.IO does not quote/escape
 * the already-serialized JSON a second time.
 */
export function createExternalActionDaemonDispatchResponseV1(
  prepared: PreparedExternalActionResponseEnvelopeV1,
): Extract<ExternalActionDaemonDispatchResultV1, Readonly<{ kind: 'response' }>> {
  const body = new TextEncoder().encode(prepared.body);
  if (body.byteLength !== prepared.byteLength) {
    throw new TypeError('External Action prepared response byte length mismatch');
  }
  return { kind: 'response', body };
}

function parsePreparedExternalActionResponseBodyV1(
  value: Uint8Array,
): PreparedExternalActionResponseEnvelopeV1 | null {
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const response = parseExternalActionResponseEnvelopeV1(raw);
  return response
    ? { response, body, byteLength: value.byteLength }
    : null;
}

/** Reads a strict reserved relay result without retaining daemon-private fields. */
export function parseExternalActionDaemonDispatchResultV1(
  value: unknown,
): ParsedExternalActionDaemonDispatchResultV1 | null {
  const parsed = ExternalActionDaemonDispatchResultV1Schema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') {
    return {
      kind: 'invalid_request',
      errorCode: parsed.data.errorCode,
    };
  }
  const prepared = parsePreparedExternalActionResponseBodyV1(parsed.data.body);
  return prepared ? { kind: 'response', prepared } : null;
}

function measureSerializedUtf8Bytes(
  value: ExternalActionResponseEnvelopeV1,
  maximumBytes?: number,
): number {
  return measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    value,
    'externalActionResponse',
    maximumBytes,
  );
}

function projectStrictJsonExternalActionResponseEnvelopeV1(
  response: ExternalActionResponseEnvelopeV1,
): ExternalActionResponseEnvelopeV1 | null {
  // JSON.stringify omits undefined/function/symbol object members and emits
  // null for those values in arrays. Apply that native projection before the
  // strict-data validation so an otherwise valid Action result is not turned
  // into invalid_action_output merely because it contains an optional field.
  const omitted = Symbol('omitted');
  const invalid = Symbol('invalid');
  const project = (value: unknown, ancestors: Set<object>, depth = 0): unknown => {
    // Keep the projection itself stack-safe; the response will be replaced
    // with invalid_action_output rather than allowing a deeply nested result
    // to overflow the process before the existing serializer guard runs.
    if (depth > 1_000) return invalid;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return omitted;
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) return invalid;
    const nextAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
      return value.map((item) => {
        const projected = project(item, nextAncestors, depth + 1);
        return projected === omitted ? null : projected;
      });
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Accessors are not JSON data and must not be invoked at this boundary.
      if (!descriptor || !('value' in descriptor)) return invalid;
      const projected = project(descriptor.value, nextAncestors, depth + 1);
      if (projected !== omitted) output[key] = projected;
    }
    return output;
  };
  const projected = project(response, new Set());
  const strictJson = projected === invalid
    ? { success: false as const }
    : StrictJsonValueSchema.safeParse(projected);
  return strictJson.success
    ? parseExternalActionResponseEnvelopeV1(strictJson.data)
    : null;
}

function invalidActionOutputResponse(
  response: ExternalActionResponseEnvelopeV1,
): ExternalActionResponseEnvelopeV1 {
  return {
    v: 1,
    actionId: response.actionId,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    execution: {
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    },
  };
}

/** Measures exactly the strict JSON envelope that an external transport sends. */
export function measureExternalActionResponseEnvelopeUtf8BytesV1(value: unknown): number {
  const parsed = parseExternalActionResponseEnvelopeV1(value);
  const strictJson = parsed && StrictJsonValueSchema.safeParse(parsed);
  const response = strictJson?.success ? parseExternalActionResponseEnvelopeV1(strictJson.data) : null;
  if (!response) {
    throw new TypeError('External Action response envelope must contain strict JSON data');
  }
  return measureSerializedUtf8Bytes(response);
}

/**
 * Applies the one response ceiling and native JSON representability check
 * after Action execution. Both public entry points consume this one prepared
 * projection rather than owning separate response serializers.
 */
export function prepareExternalActionResponseEnvelopeV1(
  value: unknown,
): PreparedExternalActionResponseEnvelopeV1 {
  const response = parseExternalActionResponseEnvelopeV1(value);
  if (!response) {
    throw new TypeError('Invalid external Action response envelope');
  }
  const strictJsonResponse = projectStrictJsonExternalActionResponseEnvelopeV1(response);
  let candidate: ExternalActionResponseEnvelopeV1;
  if (!strictJsonResponse) {
    candidate = invalidActionOutputResponse(response);
  } else if (
    measureSerializedUtf8Bytes(
      strictJsonResponse,
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    ) > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES
  ) {
    candidate = {
      v: 1,
      actionId: strictJsonResponse.actionId,
      ...(strictJsonResponse.requestId === undefined ? {} : { requestId: strictJsonResponse.requestId }),
      execution: createExternalActionResultTooLargeExecutionV1(),
    };
  } else {
    candidate = strictJsonResponse;
  }

  let body: string | undefined;
  try {
    body = JSON.stringify(candidate);
  } catch {
    // Supported engines do not agree on JSON nesting depth. This is not a
    // size policy, so preserve the existing permanent Action-output failure.
    const invalidActionOutput = invalidActionOutputResponse(candidate);
    const invalidActionOutputBody = JSON.stringify(invalidActionOutput);
    if (invalidActionOutputBody === undefined) {
      throw new TypeError('External Action response envelope must serialize to JSON');
    }
    return {
      response: invalidActionOutput,
      body: invalidActionOutputBody,
      byteLength: measurePluginJsonUtf8Bytes(invalidActionOutputBody, 'externalActionResponse'),
    };
  }
  if (body === undefined) {
    throw new TypeError('External Action response envelope must serialize to JSON');
  }
  return {
    response: candidate,
    body,
    byteLength: measurePluginJsonUtf8Bytes(body, 'externalActionResponse'),
  };
}

/**
 * Applies the one response ceiling after Action execution. Oversize output is
 * replaced with a small admitted result while retaining request correlation.
 */
export function enforceExternalActionResponseEnvelopeLimitV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 {
  return prepareExternalActionResponseEnvelopeV1(value).response;
}

/**
 * The one native JSON body projection for a public Action response. Both
 * Fastify origins consume this pre-serialized representation so a valid
 * Protocol value cannot reach one adapter only to fail during serialization.
 */
export function serializeExternalActionResponseEnvelopeV1(value: unknown): Readonly<{
  body: string;
  byteLength: number;
}> {
  const prepared = prepareExternalActionResponseEnvelopeV1(value);
  return {
    body: prepared.body,
    byteLength: prepared.byteLength,
  };
}

const ExternalActionTargetIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, 'target id must not have outer whitespace'));

/**
 * Closed Account-server bootstrap projection used only to select an exact
 * Machine for a subsequent external Action request.
 *
 * Machine metadata and daemon state do not cross this PAT-authenticated seam.
 * A shared persistent target carries only its safe access/resource mode, exact
 * installation and current recipient-sealed key. A restricted Runner carries the
 * facts a protected request must seal against — its kind, its winning
 * installation, its Account-sealed content-key envelope, the strict
 * non-secret binding that authenticates it and the activation-signed claim
 * that binds it to its Session. None is usable without Account material: the
 * envelope is a sealed box only an Account content key opens, and the binding
 * and claim carry only public keys and signatures. A bearer-only token
 * therefore cannot open encrypted Machine content, and an encryption-capable credential
 * reaches the same verifier every other authorized Account device reaches.
 */
export const ExternalActionMachineBootstrapV1Schema = lazyZodSchema(() => z.object({
  id: ExternalActionTargetIdV1Schema,
  active: z.boolean(),
  revokedAt: z.number().int().nonnegative().nullable(),
  replacedByMachineId: ExternalActionTargetIdV1Schema.nullable(),
  kind: MachineKindFromLegacyProjectionSchema,
  /**
   * Runner only; the activation-signed claim persisted when the endpoint claimed
   * this Runner. It is how a Session-targeted protected request selects the
   * Runner that Session was activated for: the claim signs activation, Session,
   * Machine and installation under the activation identity the reader already
   * trusts for the content-key binding, so the Home relays the correspondence
   * but cannot author it. It carries public keys and proofs only, never a
   * credential.
   */
  runnerClaim: RunnerClaimV1Schema.nullable().default(null),
  /** Exact current installation for Runner or admitted shared persistent target. */
  installationId: z.string().trim().min(1).nullable().default(null),
  dataEncryptionKey: z.string().min(1).nullable().default(null),
  runnerContentKeyBinding: RunnerMachineContentKeyBindingV1Schema.nullable().default(null),
  /** Safe target resource facts; this is discovery, never effect authority. */
  access: AccessibleMachineAccessV1Schema.optional(),
}).strict());
export type ExternalActionMachineBootstrapV1 = z.infer<
  typeof ExternalActionMachineBootstrapV1Schema
>;

export const ExternalActionMachineBootstrapListV1Schema = lazyZodSchema(() => z.array(
  ExternalActionMachineBootstrapV1Schema,
));
export type ExternalActionMachineBootstrapListV1 = z.infer<
  typeof ExternalActionMachineBootstrapListV1Schema
>;

/**
 * Target selection is transport metadata only. It never becomes Action input,
 * caller provenance, approval state, or a contributor-generation assertion.
 */
export const ExternalActionTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('machine'),
    machineId: ExternalActionTargetIdV1Schema,
    /** Optional machine-local project target, cryptographically bound as transport metadata. */
    project: WorkflowProjectTargetV1Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.project && value.project.machineId !== value.machineId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', 'machineId'],
        message: 'project target must match machineId',
      });
    }
  }),
  z.object({
    kind: z.literal('session'),
    sessionId: ExternalActionTargetIdV1Schema,
  }).strict(),
]));
export type ExternalActionTargetV1 = z.infer<typeof ExternalActionTargetV1Schema>;

/** One strict equality owner for cryptographically bound external Action targets. */
export function externalActionTargetsEqualV1(
  left: ExternalActionTargetV1,
  right: ExternalActionTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'session') {
    return right.kind === 'session' && left.sessionId === right.sessionId;
  }
  if (right.kind !== 'machine' || left.machineId !== right.machineId) return false;
  if (!left.project || !right.project) return left.project === right.project;
  return left.project.machineId === right.project.machineId
    && left.project.directory === right.project.directory
    && left.project.workspaceRefId === right.project.workspaceRefId;
}

/**
 * A Home authorizes one exact outer target and one selected relay Machine.
 * That Machine may resolve its own outer Machine target to an exact Session,
 * but it may not substitute another Machine or mutate a project target.
 */
export function isExternalActionResolvedTargetAllowedV1(input: Readonly<{
  authorizedTarget: ExternalActionTargetV1;
  resolvedTarget: ExternalActionTargetV1;
  selectedMachineId: string;
}>): boolean {
  if (input.authorizedTarget.kind === 'session') {
    return externalActionTargetsEqualV1(input.authorizedTarget, input.resolvedTarget);
  }
  if (input.authorizedTarget.machineId !== input.selectedMachineId) return false;
  return input.resolvedTarget.kind === 'session'
    || externalActionTargetsEqualV1(input.authorizedTarget, input.resolvedTarget);
}

/**
 * Public Action HTTP request envelope. Execution context is deliberately
 * absent: each ingress verifies credentials and stamps authority, provenance,
 * cancellation, and placement after this parser succeeds.
 */
export const ExternalActionManagedAdmissionV1Schema = lazyZodSchema(() => z.object({
  actionId: z.literal('machines.managed.acquire'),
  input: ManagedAdmissionComputeInputV1Schema,
  continuationPresent: z.boolean(),
}).strict());
export type ExternalActionManagedAdmissionV1 = z.infer<typeof ExternalActionManagedAdmissionV1Schema>;

/** Closed routing hints; only the authenticated Home can turn them into custody authority. */
export const ExternalActionHandoffAdmissionV1Schema = lazyZodSchema(() => z.object({
  sessionId: ExternalActionTargetIdV1Schema,
  sourceMachineId: ExternalActionTargetIdV1Schema,
  targetMachineId: ExternalActionTargetIdV1Schema,
}).strict());
export type ExternalActionHandoffAdmissionV1 = z.infer<typeof ExternalActionHandoffAdmissionV1Schema>;
/** Both installations are issuer-observed, not inferred from a caller's Machine id. */
export const ExternalActionHandoffBindingV1Schema = lazyZodSchema(() => ExternalActionHandoffAdmissionV1Schema.extend({
  sourceInstallationId: ExternalActionTargetIdV1Schema,
  targetInstallationId: ExternalActionTargetIdV1Schema,
}).strict());
export const ExternalActionHandoffContinuationV1Schema = lazyZodSchema(() => z.object({
  rootRequestId: ExternalActionRequestIdV1Schema,
  rootRequestEnvelopeDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  handoffId: ExternalActionTargetIdV1Schema,
}).strict());

export const ExternalActionRequestEnvelopeV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  requestId: ExternalActionRequestIdV1Schema.optional(),
  target: ExternalActionTargetV1Schema.optional(),
  input: StrictJsonValueSchema,
  managedAdmission: ExternalActionManagedAdmissionV1Schema.optional(),
  sessionSpawnAdmission: ApiTokenSessionSpawnAdmissionV1Schema.optional(),
  handoffAdmission: ExternalActionHandoffAdmissionV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['input'],
      message: 'input is required',
    });
  }
}));
export type ExternalActionRequestEnvelopeV1 = z.infer<
  typeof ExternalActionRequestEnvelopeV1Schema
>;

// Six bytes per code unit covers JSON escaping, including control characters.
// These small values model only fields with an actual scalar bound. The target
// and input already share the complete V1 request-byte ceiling and must never
// be materialized independently to calculate a transport reserve.
const maximumBindingId = '\u0000'.repeat(256);
const maximumRequestId = '\u0000'.repeat(EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1);
const maximumServerIdentityId = `srv_${'s'.repeat(60)}`;
const maximumCredentialId = '00000000-0000-4000-8000-000000000000';
const maximumRequestPayloadDigest = 'x'.repeat(43);
const jsonNullBytes = 4;

function measureJsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('External Action framing must serialize to JSON');
  return new TextEncoder().encode(serialized).byteLength;
}

const maximumV1RequestSkeletonBytes = measureJsonUtf8Bytes({
  v: 1, requestId: maximumRequestId, target: null, input: null,
});
const maximumEncryptedRequestSkeletonBytes = measureJsonUtf8Bytes({
  v: 2, direction: 'request', serverIdentityId: maximumServerIdentityId,
  accountId: maximumBindingId, credentialId: maximumCredentialId,
  actionId: maximumBindingId, requestId: maximumRequestId,
  target: null, input: null,
});

/** Largest encrypted plaintext produced from one complete valid V1 request. */
export const EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2 =
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES
  + maximumEncryptedRequestSkeletonBytes
  - maximumV1RequestSkeletonBytes;

const maximumV1ResponseSkeletonBytes = measureJsonUtf8Bytes({
  v: 1, actionId: maximumBindingId, requestId: maximumRequestId, execution: null,
});
const maximumEncryptedResponseSkeletonBytes = measureJsonUtf8Bytes({
  v: 2, direction: 'response', serverIdentityId: maximumServerIdentityId,
  accountId: maximumBindingId, credentialId: maximumCredentialId,
  actionId: maximumBindingId, requestId: maximumRequestId,
  target: null, executedMachineId: maximumBindingId,
  requestPayloadDigest: maximumRequestPayloadDigest, execution: null,
});

/**
 * Largest encrypted response plaintext. Its execution retains the complete V1
 * response budget and its authenticated target is bounded by the complete V1
 * request envelope that produced the response.
 */
export const EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2 =
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES
  + maximumEncryptedResponseSkeletonBytes
  - maximumV1ResponseSkeletonBytes
  - jsonNullBytes
  + EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES;

const maximumRequestOuterFixedBytes = measureJsonUtf8Bytes({
  v: 2, requestId: maximumRequestId, target: null,
  payload: { t: 'encrypted', c: '' },
}) - jsonNullBytes;
const maximumResponseOuterFixedBytes = measureJsonUtf8Bytes({
  v: 2, actionId: maximumBindingId, requestId: maximumRequestId,
  payload: { t: 'encrypted', c: '' },
});

export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2 =
  maximumRequestOuterFixedBytes
  + getAccountScopedBlobCiphertextBase64LengthV1(
    EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
  );
export const EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2 =
  maximumResponseOuterFixedBytes
  + getAccountScopedBlobCiphertextBase64LengthV1(
    EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
  );
export const EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2 = EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2
  + (EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES - EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
export const EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2 = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2
  + (EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES - EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);

/** V2 is closed at every routing and encryption boundary; content is opaque. */
export const ExternalActionRequestEnvelopeV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2), requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema.optional(),
  payload: z.object({ t: z.literal('encrypted'), c: z.string().min(1).max(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2) }).strict(),
  managedAdmission: ExternalActionManagedAdmissionV1Schema.optional(),
  sessionSpawnAdmission: ApiTokenSessionSpawnAdmissionV1Schema.optional(),
  handoffAdmission: ExternalActionHandoffAdmissionV1Schema.optional(),
}).strict());
export type ExternalActionRequestEnvelopeV2 = z.infer<typeof ExternalActionRequestEnvelopeV2Schema>;
export const ExternalActionRequestEnvelopeSchema = lazyZodSchema(() => z.union([
  ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema,
]));
export type ExternalActionRequestEnvelope = z.infer<typeof ExternalActionRequestEnvelopeSchema>;
/** Plain permits genuine protected transport too; encrypted never downgrades to V1. */
export function isExternalActionRequestVersionAllowedForAccountModeV1(input: Readonly<{
  accountEncryptionMode: AccountEncryptionMode; envelopeVersion: 1 | 2;
}>): boolean {
  return input.accountEncryptionMode === 'plain' || input.envelopeVersion === 2;
}
export const ExternalActionResponseEnvelopeV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2), actionId: ExternalActionActionIdV1Schema, requestId: ExternalActionRequestIdV1Schema,
  payload: z.object({ t: z.literal('encrypted'), c: z.string().min(1).max(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2) }).strict(),
}).strict());
export type ExternalActionResponseEnvelopeV2 = z.infer<typeof ExternalActionResponseEnvelopeV2Schema>;
export type PreparedExternalActionResponseEnvelope = Readonly<{
  response: ExternalActionResponseEnvelopeV1 | ExternalActionResponseEnvelopeV2;
  body: string;
  byteLength: number;
}>;

/** Version-specific ceilings retain the V1 decoded-content contract. */
export function isExternalActionRequestWithinLimit(envelope: ExternalActionRequestEnvelope): boolean {
  return measurePluginJsonUtf8Bytes(JSON.stringify(envelope), 'externalActionRequest') <= (
    envelope.v === 1 ? EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES : EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2
  );
}

const ExternalActionServerPrincipalIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, 'principal identifiers must not have outer whitespace'));

/** Server-stamped PAT provenance; it is never accepted in the public envelope. */
export const ExternalActionApiTokenServerPrincipalV1Schema = lazyZodSchema(() => z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  principalId: ExternalActionServerPrincipalIdV1Schema,
  credentialId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  grant: ApiTokenGrantV1Schema,
}).strict());
export const ExternalActionAccountAuthenticationV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('account'),
  tokenEpoch: z.number().int().nonnegative(),
  evidence: AuthTokenAuthenticationEvidenceSnapshotV1Schema.shape.evidence.optional(),
}).strict());
/** The real terminal bearer keeps its signed automation floor and Home epoch. */
export const ExternalActionTerminalAuthenticationV1Schema = lazyZodSchema(() => ExternalActionAccountAuthenticationV1Schema
  .extend({ kind: z.literal('terminal') }).strict());
export const ExternalActionSignedAuthenticationV1Schema = lazyZodSchema(() => z.union([
  ExternalActionAccountAuthenticationV1Schema, ExternalActionTerminalAuthenticationV1Schema,
]));
export type ExternalActionSignedAuthenticationV1 = z.infer<typeof ExternalActionSignedAuthenticationV1Schema>;
export const ExternalActionAccountServerPrincipalV1Schema = lazyZodSchema(() => z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('present_user'),
  authentication: ExternalActionAccountAuthenticationV1Schema,
}).strict());
export const ExternalActionTerminalServerPrincipalV1Schema = lazyZodSchema(() => z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionTerminalAuthenticationV1Schema,
}).strict());
/** Session automation requires the installed source's Home-admitted origin. */
export const ExternalActionSessionAccountServerPrincipalV1Schema = lazyZodSchema(() => z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionSignedAuthenticationV1Schema,
  sessionActionOrigin: SessionActionRpcOriginV1Schema,
}).strict());
/** The installed FIN executor proves this retained Run at Home. */
export const ExternalActionWorkflowOriginV1Schema = lazyZodSchema(() => z.object({
  runId: ExternalActionTargetIdV1Schema, requestId: ExternalActionRequestIdV1Schema,
}).strict());
export const ExternalActionWorkflowAccountServerPrincipalV1Schema = lazyZodSchema(() => z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionSignedAuthenticationV1Schema,
  workflowActionOrigin: ExternalActionWorkflowOriginV1Schema,
}).strict());
export const ExternalActionServerPrincipalV1Schema = lazyZodSchema(() => z.union([
  ExternalActionApiTokenServerPrincipalV1Schema, ExternalActionAccountServerPrincipalV1Schema, ExternalActionTerminalServerPrincipalV1Schema,
  ExternalActionSessionAccountServerPrincipalV1Schema,
  ExternalActionWorkflowAccountServerPrincipalV1Schema,
]));
export type ExternalActionServerPrincipalV1 = z.infer<typeof ExternalActionServerPrincipalV1Schema>;

/** Issuer-derived exact fresh-creation tuple, rechecked at the child effect boundary. */
export const ExternalActionManagedContinuationV1Schema = lazyZodSchema(() => z.object({
  managedId: ExternalActionTargetIdV1Schema,
  creationRequestId: ExternalActionRequestIdV1Schema,
  expectedIntentRevision: z.number().int().nonnegative(),
  controller: ManagedControllerV1Schema,
  acquireRequestEnvelopeDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict());
export type ExternalActionManagedContinuationV1 = z.infer<typeof ExternalActionManagedContinuationV1Schema>;

const ExternalActionSessionSourceV1Schema = lazyZodSchema(() => z.object({
  machineId: ExternalActionTargetIdV1Schema, installationId: ExternalActionTargetIdV1Schema,
}).strict());

/** Home-authenticated invocation facts. The selected daemon owns plaintext transformation. */
const externalActionExecutionAuthorizationRoutingShapeV1 = () => ({
    serverIdentityId: ExternalActionServerPrincipalIdV1Schema,
    machineId: ExternalActionTargetIdV1Schema,
    /** Requester identity remains accountId; custody is bound independently. */
    custodianAccountId: ExternalActionServerPrincipalIdV1Schema,
    installationId: ExternalActionTargetIdV1Schema,
    actionId: ExternalActionActionIdV1Schema,
    requestId: ExternalActionRequestIdV1Schema,
    requestEnvelopeDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    target: ExternalActionTargetV1Schema,
    managedContinuation: ExternalActionManagedContinuationV1Schema.optional(),
    handoffAdmission: ExternalActionHandoffBindingV1Schema.optional(),
    handoffContinuation: ExternalActionHandoffContinuationV1Schema.optional(),
    accountEncryptionMode: AccountEncryptionModeSchema.optional(),
    sessionActionOrigin: SessionActionRpcOriginV1Schema.optional(),
    sessionActionSource: ExternalActionSessionSourceV1Schema.optional(),
    workflowActionOrigin: ExternalActionWorkflowOriginV1Schema.optional(),
  });
export const ExternalActionExecutionAuthorizationBindingV1Schema = lazyZodSchema(() => z.union([
  ExternalActionApiTokenServerPrincipalV1Schema.omit({ authority: true })
    .extend(externalActionExecutionAuthorizationRoutingShapeV1()).strict(),
  ExternalActionAccountServerPrincipalV1Schema.omit({ authority: true })
    .extend(externalActionExecutionAuthorizationRoutingShapeV1()).strict(),
  ExternalActionTerminalServerPrincipalV1Schema.omit({ authority: true })
    .extend(externalActionExecutionAuthorizationRoutingShapeV1()).strict(),
]).superRefine((value, context) => {
  if (value.workflowActionOrigin && (value.sessionActionOrigin || value.managedContinuation || value.handoffAdmission
    || value.workflowActionOrigin.requestId !== value.requestId)) {
    context.addIssue({ code: 'custom', path: ['workflowActionOrigin'], message: 'FIN origin binds only its original invocation' });
  }
  if ((value.sessionActionOrigin === undefined) !== (value.sessionActionSource === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionSource'], message: 'Session origin requires its source installation' });
  }
  if (value.sessionActionOrigin && value.sessionActionOrigin.requestId !== value.requestId) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin', 'requestId'], message: 'Session origin must match the signed invocation' });
  }
  if (value.handoffContinuation && (!value.handoffAdmission || value.managedContinuation
    || value.handoffContinuation.rootRequestId !== value.requestId)) {
    context.addIssue({ code: 'custom', path: ['handoffContinuation'], message: 'Handoff continuation retains its exact original root' });
  }
}));
export type ExternalActionExecutionAuthorizationBindingV1 = z.infer<typeof ExternalActionExecutionAuthorizationBindingV1Schema>;

/** Authorization material: usable only together with the selected Machine's request signature. */
export const ExternalActionExecutionAuthorizationV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  token: z.string().min(1),
  binding: ExternalActionExecutionAuthorizationBindingV1Schema,
  /** Private installed-key custody on this same carrier; never principal authority. */
  requesterAccountContext: SessionRequesterInstallationSealedBootstrapV1Schema.optional(),
  /** Home-proved finite placement hint and private custody; neither retargets the root. */
  managedFiniteWake: z.object({
    target: ManagedWakeTargetV1Schema,
    installationPublicKey: MachineInstallationPublicKeySchema,
    requesterAccountContext: SessionRequesterInstallationSealedBootstrapV1Schema.optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const wake = value.managedFiniteWake;
  if (!wake) return;
  const root = value.binding;
  if (!Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, root.actionId)
    || wake.target.origin.kind !== 'finite-command' || wake.target.origin.actionRequestId !== root.requestId
    || wake.target.homeId !== root.serverIdentityId || wake.target.enrolledMachineId !== root.machineId
    || root.target.kind !== 'machine' || root.target.machineId !== root.machineId
    || wake.requesterAccountContext && wake.requesterAccountContext.installationId !== wake.target.controller.installationId) {
    context.addIssue({ code: 'custom', path: ['managedFiniteWake'], message: 'Finite custody requires its exact original guest root and installed controller' });
  }
}));
/**
 * Admitted host-local Account ports, attached to the existing authorization
 * carrier only after requester custody has been proved. They are not wire
 * fields: the strict authorization schema never accepts them from a caller.
 */
export type ExternalActionRequesterAccountProjectionV1 = Readonly<{
  accountId: string;
  serverId: string;
  accountEncryptionMode: 'plain' | 'e2ee';
  projectAccountRowCipher: ProjectAccountRowCipherV1;
  projectTrustRowCipher?: Readonly<{
    open(project: QualifiedProjectTrustProjectV1, content: ProjectTrustContentV1): ProjectTrustValueV1;
    seal(value: ProjectTrustValueV1): ProjectTrustContentV1;
  }>;
  authoringMemoryRowCipher?: Readonly<{
    open(key: string, content: AuthoringMemoryContentV1): AuthoringMemoryValueV1;
    seal(key: string, value: AuthoringMemoryValueV1): AuthoringMemoryContentV1;
  }>;
  /** Private caller owner seals genuine custody for the exact installed destination. */
  sealRequesterAccountContext?(input: Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    purpose: Exclude<ExternalActionRequesterAccountContextPurposeV1, { kind: 'external_action' }>;
    installationPublicKey: Uint8Array;
  }>): Promise<ExternalActionExecutionAuthorizationV1 | null>;
  resolveMachineContentEncryptionContext?(row: MachinePublishedRowV1): Readonly<
    { encryptionMode: 'plain' } | { encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }
  >;
  /** Host-private owner read; never exposes a Session envelope or Account credential. */
  readOwnSessionWorkspace?(input: Readonly<{
    sessionId: string; machineId: string; currentMachineHost: string; currentMachineHomeDir: string;
    candidatePath?: string; signal?: AbortSignal;
  }>): Promise<Readonly<{ rootPath: string; requestedPath?: string }> | null>;
  isCurrent(): Promise<boolean>;
  readArtifact(ref: PromptArtifactRefV1 & Readonly<{ serverId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{
      artifactId: string; header: unknown; promptLibraryArtifact?: PromptLibraryStoredArtifact;
    }> | null>;
}>;
/** Host-local HTTP authority; no bearer or private Account material is exposed. */
export type ExternalActionRequesterHttpProjectionV1 = Readonly<{
  accountId: string;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  accountEncryptionMode?: 'plain' | 'e2ee';
  isCurrent(): Promise<boolean>;
  createRequestHeaders(input: Readonly<{
    effectActionId: string;
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  }>): Promise<Readonly<Record<string, string>> | null>;
}>;
export type ExternalActionExecutionAuthorizationV1 = z.infer<typeof ExternalActionExecutionAuthorizationV1Schema>
  & Readonly<{
    requesterAccountProjection?: ExternalActionRequesterAccountProjectionV1;
    /** Existing factory bound to admitted private custody; never a wire executor or registry. */
    requesterAccountExecutor?: Pick<ReturnType<typeof createActionExecutor>, 'execute'>
      & Partial<Pick<ReturnType<typeof createActionExecutor>, 'replayApprovedApprovalRequest'>>;
    requesterHttpProjection?: ExternalActionRequesterHttpProjectionV1;
  }>;

/** Optional authenticated auxiliary arm of the incumbent socket RPC request. */
export const ExternalActionMachineRpcExecutionV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  authorization: ExternalActionExecutionAuthorizationV1Schema,
  effectActionId: ExternalActionActionIdV1Schema,
  target: ExternalActionTargetV1Schema,
  installationId: z.string().trim().min(1),
  machineSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
}).strict());
export type ExternalActionMachineRpcExecutionV1 = z.infer<typeof ExternalActionMachineRpcExecutionV1Schema>;

export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER = 'x-happier-action-execution-authorization';
export const EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER = 'x-happier-action-machine-signature';
export const EXTERNAL_ACTION_EFFECT_ACTION_HEADER = 'x-happier-action-effect';
export const EXTERNAL_ACTION_RESOLVED_TARGET_HEADER = 'x-happier-action-target';
export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1 = '/v1/actions/:actionId/execution-authorization';
export const EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1 = '/v1/actions/:actionId/execution-authorization/verify';
export function bindExternalActionExecutionAuthorizationHttpPathV1(actionId: string): string {
  return `/v1/actions/${encodeURIComponent(ExternalActionActionIdV1Schema.parse(actionId))}/execution-authorization`;
}
export function bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId: string): string {
  return `${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}/verify`;
}
export const ExternalActionExecutionAuthorizationRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), machineId: ExternalActionTargetIdV1Schema, envelope: ExternalActionRequestEnvelopeSchema,
  executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
  sessionActionOrigin: SessionActionRpcOriginV1Schema.optional(),
  sessionActionSource: ExternalActionSessionSourceV1Schema.optional(),
  workflowActionOrigin: ExternalActionWorkflowOriginV1Schema.optional(),
  installationProof: MachineInstallationProofV1Schema.optional(),
  managedContinuation: ExternalActionManagedContinuationV1Schema.pick({
    managedId: true, creationRequestId: true, expectedIntentRevision: true,
  }).optional(),
  handoffContinuation: z.object({
    authorization: ExternalActionExecutionAuthorizationV1Schema,
    handoffId: ExternalActionTargetIdV1Schema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.executionAuthorization && (value.sessionActionOrigin || value.sessionActionSource || value.workflowActionOrigin
    || value.installationProof || value.managedContinuation || value.handoffContinuation)) {
    context.addIssue({ code: 'custom', path: ['executionAuthorization'], message: 'An admitted relay cannot author fresh origin or continuation claims' });
  }
  if ((value.sessionActionOrigin === undefined && value.workflowActionOrigin === undefined) !== (value.installationProof === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin'], message: 'Session origin requires its installed source proof' });
  }
  if (value.workflowActionOrigin && (value.sessionActionOrigin || value.managedContinuation || value.handoffContinuation
    || value.workflowActionOrigin.requestId !== value.envelope.requestId
    || value.envelope.target?.kind !== 'machine' || value.envelope.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['workflowActionOrigin'], message: 'FIN origin requires its exact installed executor invocation' });
  }
  if (value.sessionActionOrigin && (value.managedContinuation
    || value.sessionActionOrigin.requestId !== value.envelope.requestId
    || value.envelope.target?.kind !== 'machine' || value.envelope.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin'], message: 'Initial Session origin must bind the exact original Machine request' });
  }
  if ((value.sessionActionOrigin === undefined) !== (value.sessionActionSource === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionSource'], message: 'Session origin requires its source installation' });
  }
  if (value.sessionActionOrigin && value.sessionActionOrigin.requestId !== value.envelope.requestId) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin', 'requestId'], message: 'Session origin must name the invocation request' });
  }
  // The admitted child Action selects its required public facts at the server
  // continuation owner: Session start requires Session facts; machine setup
  // carries only its exact target and keeps the executable preset input sealed.
  if (value.handoffContinuation) {
    const root = value.handoffContinuation.authorization.binding;
    const handoff = value.envelope.handoffAdmission;
    if (root.actionId !== 'session.handoff' || !root.handoffAdmission || root.handoffContinuation
      || value.managedContinuation || value.envelope.requestId !== root.requestId
      || value.sessionActionOrigin || value.sessionActionSource || value.installationProof
      || !handoff || handoff.sessionId !== root.handoffAdmission.sessionId
      || handoff.sourceMachineId !== root.handoffAdmission.sourceMachineId
      || handoff.targetMachineId !== root.handoffAdmission.targetMachineId
      || value.envelope.target?.kind !== 'machine' || value.envelope.target.machineId !== value.machineId
      || ![root.handoffAdmission.sourceMachineId, root.handoffAdmission.targetMachineId].includes(value.machineId)) {
      context.addIssue({ code: 'custom', path: ['handoffContinuation'], message: 'Handoff continuation requires its exact Home-issued root and destination' });
    }
  }
}));
export type ExternalActionExecutionAuthorizationRequestV1 = z.infer<typeof ExternalActionExecutionAuthorizationRequestV1Schema>;
export const ExternalActionExecutionAuthorizationVerifyRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  managedFiniteWakeTarget: z.optional(ManagedWakeTargetV1Schema),
}).strict().superRefine((value, context) => {
  if (value.managedFiniteWakeTarget && value.managedFiniteWakeTarget.origin.kind !== 'finite-command') {
    context.addIssue({ code: 'custom', path: ['managedFiniteWakeTarget'], message: 'Controller custody requires an original finite-command target' });
  }
}));
export const ExternalActionExecutionAuthorizationVerifyResponseV1Schema = lazyZodSchema(() => z.object({ ok: z.literal(true) }).strict());

/** Exact server-held placement facts for the closed daemon dispatch. */
export const ExternalActionDaemonPlacementV1Schema = lazyZodSchema(() => z.object({
  machineId: ExternalActionTargetIdV1Schema,
  target: z.object({
    kind: z.literal('machine'),
    machineId: ExternalActionTargetIdV1Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.machineId !== value.target.machineId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target', 'machineId'],
      message: 'placement target must match machineId',
    });
  }
}));
export type ExternalActionDaemonPlacementV1 = z.infer<typeof ExternalActionDaemonPlacementV1Schema>;

/** Closed server-to-daemon Action dispatch framing. */
export const ExternalActionDaemonDispatchRequestV1Schema = lazyZodSchema(() => z.object({
  // The relay proves only closed framing, provenance, and placement. The
  // target daemon is the sole Action-id admission owner.
  actionId: ExternalActionActionIdV1Schema,
  envelope: ExternalActionRequestEnvelopeV1Schema,
  principal: ExternalActionServerPrincipalV1Schema,
  placement: ExternalActionDaemonPlacementV1Schema,
}).strict());
export type ExternalActionDaemonDispatchRequestV1 = z.infer<
  typeof ExternalActionDaemonDispatchRequestV1Schema
>;

export const ExternalActionDaemonDispatchRequestSchema = lazyZodSchema(() => ExternalActionDaemonDispatchRequestV1Schema.extend({
  envelope: ExternalActionRequestEnvelopeSchema,
  executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
}).strict());
export type ExternalActionDaemonDispatchRequest = z.infer<typeof ExternalActionDaemonDispatchRequestSchema>;

const ExternalActionDaemonDispatchInvalidRequestSchema = lazyZodSchema(() => ExternalActionDaemonDispatchInvalidRequestV1Schema.extend({
  errorCode: ExternalActionPreOpenFailureCodeSchema,
  requestId: ExternalActionRequestIdV1Schema.optional(),
}).strict());

export type ParsedExternalActionDaemonDispatchResult = Readonly<
  | z.infer<typeof ExternalActionDaemonDispatchInvalidRequestSchema>
  | { kind: 'response'; prepared: PreparedExternalActionResponseEnvelope }
>;

/** Same reserved binary carrier; each decoded body retains its own version ceiling. */
export function createExternalActionDaemonDispatchResponse(prepared: PreparedExternalActionResponseEnvelope): Readonly<{
  kind: 'response'; body: Uint8Array;
}> {
  const body = new TextEncoder().encode(prepared.body);
  if (body.byteLength !== prepared.byteLength) throw new TypeError('External Action prepared response byte length mismatch');
  return { kind: 'response', body };
}

const ExternalActionDaemonDispatchResultSchema = lazyZodSchema(() => z.union([
  ExternalActionDaemonDispatchInvalidRequestSchema,
  z.object({ kind: z.literal('response'), body: z.instanceof(Uint8Array)
    .refine((value) => value.byteLength <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2) }).strict(),
]));

export function parseExternalActionDaemonDispatchResult(value: unknown): ParsedExternalActionDaemonDispatchResult | null {
  const parsed = ExternalActionDaemonDispatchResultSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') return parsed.data;
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(parsed.data.body);
    const raw: unknown = JSON.parse(body);
    const encrypted = ExternalActionResponseEnvelopeV2Schema.safeParse(raw);
    if (encrypted.success) return { kind: 'response', prepared: {
      response: encrypted.data, body, byteLength: parsed.data.body.byteLength,
    } };
    return parseExternalActionDaemonDispatchResultV1(value);
  } catch { return null; }
}
