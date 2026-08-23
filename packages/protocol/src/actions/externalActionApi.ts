import { z } from 'zod';

import type { ActionExecuteResult } from './actionExecutionResult.js';
import { PublicActionIdSchema, type PublicActionId } from './actionSpecs.js';

/** Shared finite HTTP request ceiling for both public Action API origins. */
export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

/** Relative path prefix; the Action id is the final path segment. */
export const EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1 = '/v1/actions/' as const;

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

const ExternalActionTargetIdV1Schema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, 'target id must not have outer whitespace');

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
  actionId: z.string(),
  envelope: ExternalActionRequestEnvelopeV1Schema,
  principal: ExternalActionServerPrincipalV1Schema,
  placement: ExternalActionDaemonPlacementV1Schema,
}).strict();
export type ExternalActionDaemonDispatchRequestV1 = z.infer<
  typeof ExternalActionDaemonDispatchRequestV1Schema
>;

/** Stable finite response envelope shared by the daemon and server adapters. */
export type ExternalActionResponseEnvelopeV1 = Readonly<{
  v: 1;
  actionId: PublicActionId;
  requestId?: string;
  execution: ActionExecuteResult;
}>;
