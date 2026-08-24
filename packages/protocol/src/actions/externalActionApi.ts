import { z } from 'zod';

import {
  ActionExecuteFailureSchema,
  type ActionExecuteResult,
} from './actionExecutionResult.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import {
  measurePluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../plugins/contributions/strictJsonValue.js';

/** Shared finite HTTP request ceiling for both public Action API origins. */
export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** Maximum serialized UTF-8 bytes for the complete public response envelope. */
export const EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES = 24_000_000;

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
export const EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH = 256;

export const ExternalActionActionIdV1Schema = z.string()
  .min(1)
  .max(EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH)
  .refine((value) => value.trim() === value, 'actionId must not have outer whitespace');
export type ExternalActionActionIdV1 = z.infer<typeof ExternalActionActionIdV1Schema>;

const ExternalActionHttpErrorCodeV1Schema = z.enum([
  'invalid_action',
  'invalid_envelope',
  'request_too_large',
]);
export type ExternalActionHttpErrorCodeV1 = z.infer<typeof ExternalActionHttpErrorCodeV1Schema>;

/** Stable transport failures emitted before an Action execution envelope exists. */
export const ExternalActionHttpErrorV1Schema = z.object({
  error: z.literal('invalid_request'),
  code: ExternalActionHttpErrorCodeV1Schema,
}).strict();
export type ExternalActionHttpErrorV1 = z.infer<typeof ExternalActionHttpErrorV1Schema>;

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
export function projectExternalActionHttpErrorV1(code: ExternalActionHttpErrorCodeV1): Readonly<{
  statusCode: 400 | 413;
  payload: ExternalActionHttpErrorV1;
}> {
  return {
    statusCode: code === 'request_too_large' ? 413 : 400,
    payload: { error: 'invalid_request', code },
  };
}

/** Closed server-to-exact-daemon method; never a public Action or SDK method. */
export const EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 =
  'daemon.actions.external.dispatch' as const;

const ExternalActionRequestIdV1Schema = z.string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, 'requestId must not have outer whitespace');

const ExternalActionExecutionSuccessV1Schema = z.object({
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
});

/** Closed public execution union. Bridge-private execution metadata cannot cross it. */
export const ExternalActionExecutionResultV1Schema = z.union([
  ExternalActionExecutionSuccessV1Schema,
  ActionExecuteFailureSchema,
]);

const EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE =
  'Action execution completed, but its response exceeded the external Action response limit and could not be represented.' as const;

/** Strict admitted result used only after the Action has completed. */
export const ExternalActionResultTooLargeExecutionV1Schema = z.object({
  ok: z.literal(false),
  errorCode: z.literal('result_too_large'),
  error: z.literal(EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE),
  details: z.object({
    executionCompleted: z.literal(true),
    maxSerializedBytes: z.literal(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
  }).strict(),
}).strict();
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
export const ExternalActionResponseEnvelopeV1Schema = z.object({
  v: z.literal(1),
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema.optional(),
  execution: ExternalActionExecutionResultV1Schema,
}).strict();

/**
 * Strict outer relay framing. The relay may receive a daemon execution result
 * with private metadata, but never gains a second public response envelope.
 */
const ExternalActionResponseEnvelopeV1ProjectionInputSchema = z.object({
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
});

/** Stable finite response envelope shared by the daemon and server adapters. */
export type ExternalActionResponseEnvelopeV1 = Readonly<{
  v: 1;
  actionId: ExternalActionActionIdV1;
  requestId?: string;
  execution: ActionExecuteResult;
}>;

/**
 * The one strict JSON response projection prepared after external Action
 * execution. Same-process HTTP adapters send these bytes directly; a process
 * boundary carries only `response` and prepares it again after receipt.
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

const ExternalActionDaemonDispatchInvalidRequestCodeV1Schema = z.enum([
  'invalid_action',
  'invalid_envelope',
]);
export type ExternalActionDaemonDispatchInvalidRequestCodeV1 = z.infer<
  typeof ExternalActionDaemonDispatchInvalidRequestCodeV1Schema
>;

const ExternalActionDaemonDispatchInvalidRequestV1Schema = z.object({
  kind: z.literal('invalid_request'),
  errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1Schema,
}).strict();

/**
 * Closed result of the reserved server-to-daemon Action relay. Admission
 * failures remain transport failures; only a completed/admitted Action may
 * use the public response envelope and its domain result union.
 */
export const ExternalActionDaemonDispatchResultV1Schema = z.discriminatedUnion('kind', [
  ExternalActionDaemonDispatchInvalidRequestV1Schema,
  z.object({
    kind: z.literal('response'),
    response: ExternalActionResponseEnvelopeV1Schema,
  }).strict(),
]);
export type ExternalActionDaemonDispatchResultV1 = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1;
  }
  | {
    kind: 'response';
    response: ExternalActionResponseEnvelopeV1;
  }
>;

const ExternalActionDaemonDispatchResultV1ProjectionInputSchema = z.discriminatedUnion('kind', [
  ExternalActionDaemonDispatchInvalidRequestV1Schema,
  z.object({
    kind: z.literal('response'),
    response: ExternalActionResponseEnvelopeV1ProjectionInputSchema,
  }).strict(),
]);

/** Reads a strict reserved relay result without retaining daemon-private fields. */
export function parseExternalActionDaemonDispatchResultV1(
  value: unknown,
): ExternalActionDaemonDispatchResultV1 | null {
  const parsed = ExternalActionDaemonDispatchResultV1Schema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') {
    return {
      kind: 'invalid_request',
      errorCode: parsed.data.errorCode,
    };
  }
  const response = parseExternalActionResponseEnvelopeV1(parsed.data.response);
  return response ? { kind: 'response', response } : null;
}

/**
 * Projects a relay result at the server boundary. The outer result stays
 * closed, while existing daemon-private execution metadata is removed before
 * its admitted response crosses the public HTTP boundary.
 */
export function projectExternalActionDaemonDispatchResultV1(
  value: unknown,
): ExternalActionDaemonDispatchResultV1 | null {
  const parsed = ExternalActionDaemonDispatchResultV1ProjectionInputSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') {
    return {
      kind: 'invalid_request',
      errorCode: parsed.data.errorCode,
    };
  }
  const response = projectExternalActionResponseEnvelopeV1(parsed.data.response);
  return response ? { kind: 'response', response } : null;
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
  const strictJson = StrictJsonValueSchema.safeParse(response);
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
  const response = parsed && projectStrictJsonExternalActionResponseEnvelopeV1(parsed);
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

const ExternalActionTargetIdV1Schema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, 'target id must not have outer whitespace');

/**
 * Closed Account-server bootstrap projection used only to select an exact
 * Machine for a subsequent external Action request. Machine content and
 * daemon/install state deliberately do not cross this PAT-authenticated seam.
 */
export const ExternalActionMachineBootstrapV1Schema = z.object({
  id: ExternalActionTargetIdV1Schema,
  active: z.boolean(),
  revokedAt: z.number().int().nonnegative().nullable(),
  replacedByMachineId: ExternalActionTargetIdV1Schema.nullable(),
}).strict();
export type ExternalActionMachineBootstrapV1 = z.infer<
  typeof ExternalActionMachineBootstrapV1Schema
>;

export const ExternalActionMachineBootstrapListV1Schema = z.array(
  ExternalActionMachineBootstrapV1Schema,
);
export type ExternalActionMachineBootstrapListV1 = z.infer<
  typeof ExternalActionMachineBootstrapListV1Schema
>;

/**
 * Target selection is transport metadata only. It never becomes Action input,
 * caller provenance, approval state, or a contributor-generation assertion.
 */
export const ExternalActionTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('machine'),
    machineId: ExternalActionTargetIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session'),
    sessionId: ExternalActionTargetIdV1Schema,
  }).strict(),
]);
export type ExternalActionTargetV1 = z.infer<typeof ExternalActionTargetV1Schema>;

/**
 * Public Action HTTP request envelope. Execution context is deliberately
 * absent: each ingress verifies credentials and stamps authority, provenance,
 * cancellation, and placement after this parser succeeds.
 */
export const ExternalActionRequestEnvelopeV1Schema = z.object({
  v: z.literal(1),
  requestId: ExternalActionRequestIdV1Schema.optional(),
  target: ExternalActionTargetV1Schema.optional(),
  input: z.unknown(),
}).strict().superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['input'],
      message: 'input is required',
    });
  }
});
export type ExternalActionRequestEnvelopeV1 = z.infer<
  typeof ExternalActionRequestEnvelopeV1Schema
>;

const ExternalActionServerPrincipalIdV1Schema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, 'principal identifiers must not have outer whitespace');

/** Server-stamped PAT provenance; it is never accepted in the public envelope. */
export const ExternalActionServerPrincipalV1Schema = z.object({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  principalId: ExternalActionServerPrincipalIdV1Schema,
  credentialId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
}).strict();
export type ExternalActionServerPrincipalV1 = z.infer<typeof ExternalActionServerPrincipalV1Schema>;

/** Exact server-held placement facts for the closed daemon dispatch. */
export const ExternalActionDaemonPlacementV1Schema = z.object({
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
});
export type ExternalActionDaemonPlacementV1 = z.infer<typeof ExternalActionDaemonPlacementV1Schema>;

/** Closed server-to-daemon Action dispatch framing. */
export const ExternalActionDaemonDispatchRequestV1Schema = z.object({
  // The relay proves only closed framing, provenance, and placement. The
  // target daemon is the sole Action-id admission owner.
  actionId: ExternalActionActionIdV1Schema,
  envelope: ExternalActionRequestEnvelopeV1Schema,
  principal: ExternalActionServerPrincipalV1Schema,
  placement: ExternalActionDaemonPlacementV1Schema,
}).strict();
export type ExternalActionDaemonDispatchRequestV1 = z.infer<
  typeof ExternalActionDaemonDispatchRequestV1Schema
>;
