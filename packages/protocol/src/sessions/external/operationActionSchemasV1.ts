import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { SessionIdSchema } from '../idsV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';
import {
  ExternalSessionOperationProgressV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionTakeoverTargetDirectoryV1Schema,
  projectExternalSessionOperationSharedPresentationV1,
} from './operationV1.js';

const OperationIdSchema = z.string().trim().min(1).max(256);
const OperationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PublicOperationSessionIdSchema = z.string()
  .min(1)
  .max(191)
  .refine((value) => value === value.trim(), 'Session id must already be trimmed.');
const PublicOperationIdSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), 'Operation id must already be trimmed.');

const ExternalSessionMaterializeStartIntentRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  plan: z.literal('materialize'),
  targetStorageMode: z.literal('external-linked'),
  targetRuntimeMode: z.null(),
}).strict();

/**
 * Public materialization intent. The linked source identity and all lifecycle
 * generations are daemon-owned and are captured immediately before the
 * durable semantic operation is created.
 */
export const ExternalSessionMaterializeStartInputV1Schema = z.object({
  request: ExternalSessionMaterializeStartIntentRequestV1Schema,
}).strict();
export type ExternalSessionMaterializeStartInputV1 = z.infer<
  typeof ExternalSessionMaterializeStartInputV1Schema
>;

const ExternalSessionMaterializeActionIntentRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: PublicOperationIdSchema,
  sessionId: PublicOperationSessionIdSchema,
  plan: z.literal('materialize'),
  targetStorageMode: z.literal('external-linked'),
  targetRuntimeMode: z.null(),
}).strict();

export const ExternalSessionMaterializeActionInputV1Schema = z.object({
  request: ExternalSessionMaterializeActionIntentRequestV1Schema,
}).strict();

const ExternalSessionTakeoverStartIntentSourceV1Schema = z.object({
  machineId: OperationIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().trim().min(1).max(256),
}).strict();

const ExternalSessionTakeoverStartIntentRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  source: ExternalSessionTakeoverStartIntentSourceV1Schema,
  plan: z.literal('takeover'),
  targetStorageMode: z.enum(['external-linked', 'persisted']),
  targetDirectory: ExternalSessionTakeoverTargetDirectoryV1Schema,
  targetRuntimeMode: z.literal('terminal'),
}).strict();

/**
 * Public takeover intent. Generation fences owned by the machine/plugin
 * lifecycle are intentionally absent: the daemon re-reads and persists them
 * from the canonical linked session and active contribution.
 */
export const ExternalSessionTakeoverStartInputV1Schema = z.object({
  request: ExternalSessionTakeoverStartIntentRequestV1Schema,
}).strict();
export type ExternalSessionTakeoverStartInputV1 = z.infer<
  typeof ExternalSessionTakeoverStartInputV1Schema
>;

/**
 * Public-safe descriptive reference. The owner machine resolves the private
 * claim from its canonical operation row and revalidates the exact revision.
 */
export const ExternalSessionOperationReferenceV1Schema = z.object({
  sessionId: PublicOperationSessionIdSchema,
  operationId: PublicOperationIdSchema,
  revision: OperationRevisionSchema,
}).strict();
export type ExternalSessionOperationReferenceV1 = z.infer<
  typeof ExternalSessionOperationReferenceV1Schema
>;

export const ExternalSessionOperationTransportReferenceV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  operationId: OperationIdSchema,
  revision: OperationRevisionSchema,
}).strict();

/**
 * The status input has no intent field, so merely hydrating it cannot be
 * interpreted as Resume, Retry, Cancel, or Discard.
 */
export const ExternalSessionOperationStatusInputV1Schema =
  ExternalSessionOperationReferenceV1Schema;
export type ExternalSessionOperationStatusInputV1 = z.infer<
  typeof ExternalSessionOperationStatusInputV1Schema
>;

const ExternalSessionOperationRevisionIntentInputV1Schema =
  ExternalSessionOperationReferenceV1Schema;

export const ExternalSessionOperationCancelInputV1Schema =
  ExternalSessionOperationRevisionIntentInputV1Schema;
export const ExternalSessionOperationResumeInputV1Schema =
  ExternalSessionOperationRevisionIntentInputV1Schema;
export const ExternalSessionOperationRetryInputV1Schema =
  ExternalSessionOperationRevisionIntentInputV1Schema;
export const ExternalSessionOperationDiscardInputV1Schema =
  ExternalSessionOperationRevisionIntentInputV1Schema;

export type ExternalSessionOperationCancelInputV1 = z.infer<
  typeof ExternalSessionOperationCancelInputV1Schema
>;
export type ExternalSessionOperationResumeInputV1 = z.infer<
  typeof ExternalSessionOperationResumeInputV1Schema
>;
export type ExternalSessionOperationRetryInputV1 = z.infer<
  typeof ExternalSessionOperationRetryInputV1Schema
>;
export type ExternalSessionOperationDiscardInputV1 = z.infer<
  typeof ExternalSessionOperationDiscardInputV1Schema
>;

export const ExternalSessionOperationActionErrorCodeV1Schema = z.enum([
  'upgrade_required',
  'operation_not_found',
  'operation_conflict',
  'stale_revision',
  'invalid_state',
  'not_allowed',
  'reconciliation_required',
  'source_unavailable',
  'internal_error',
]);
export type ExternalSessionOperationActionErrorCodeV1 = z.infer<
  typeof ExternalSessionOperationActionErrorCodeV1Schema
>;

export const ExternalSessionOperationActionErrorV1Schema = z.object({
  code: ExternalSessionOperationActionErrorCodeV1Schema,
  message: z.string().trim().min(1).max(2_000),
}).strict();
export type ExternalSessionOperationActionErrorV1 = z.infer<
  typeof ExternalSessionOperationActionErrorV1Schema
>;

export const ExternalSessionOperationActionResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      progress: ExternalSessionOperationProgressV1Schema,
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ExternalSessionOperationActionErrorV1Schema,
    }).strict(),
  ]);
export type ExternalSessionOperationActionResponseV1 = z.infer<
  typeof ExternalSessionOperationActionResponseV1Schema
>;

/**
 * Plugin-facing materialize admission result.
 *
 * A completed idempotency receipt no longer owns operation progress. It keeps
 * the exact acknowledged presentation for recipient-safe status, but normal
 * materialize admission exposes only the same stable public reference shape
 * for both a live record and a receipt replay. Active owner/RPC paths retain
 * the full progress response above; status and control projections retain the
 * shared presentation result below.
 */
export const ExternalSessionMaterializeActionResultV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      operation: ExternalSessionOperationReferenceV1Schema,
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ExternalSessionOperationActionErrorV1Schema,
    }).strict(),
  ]);
export type ExternalSessionMaterializeActionResultV1 = z.infer<
  typeof ExternalSessionMaterializeActionResultV1Schema
>;

export const ExternalSessionOperationActionResultV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      operation: ExternalSessionOperationReferenceV1Schema,
      presentation: ExternalSessionOperationSharedPresentationV1Schema,
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ExternalSessionOperationActionErrorV1Schema,
    }).strict(),
  ]).superRefine((result, context) => {
    if (
      result.ok
      && (
        result.operation.operationId !== result.presentation.operationId
        || result.operation.revision !== result.presentation.revision
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['presentation'],
        message: 'Operation presentation must match its public reference.',
      });
    }
  });
export type ExternalSessionOperationActionResultV1 = z.infer<
  typeof ExternalSessionOperationActionResultV1Schema
>;

export function projectExternalSessionOperationActionResultV1(
  value: unknown,
  sessionId: string,
): ExternalSessionOperationActionResultV1 {
  const response = ExternalSessionOperationActionResponseV1Schema.parse(value);
  if (!response.ok) return response;
  return ExternalSessionOperationActionResultV1Schema.parse({
    ok: true,
    operation: {
      sessionId,
      operationId: response.progress.operationId,
      revision: response.progress.revision,
    },
    presentation: projectExternalSessionOperationSharedPresentationV1(
      response.progress,
    ),
  });
}

export function projectExternalSessionMaterializeActionResultV1(
  value: unknown,
  sessionId: string,
): ExternalSessionMaterializeActionResultV1 {
  const projected = ExternalSessionMaterializeActionResultV1Schema.safeParse(value);
  if (projected.success) {
    if (
      projected.data.ok
      && projected.data.operation.sessionId !== sessionId
    ) {
      throw new Error('external_session_operation_session_mismatch');
    }
    return projected.data;
  }

  const response = ExternalSessionOperationActionResponseV1Schema.parse(value);
  if (!response.ok) return response;
  return ExternalSessionMaterializeActionResultV1Schema.parse({
    ok: true,
    operation: {
      sessionId,
      operationId: response.progress.operationId,
      revision: response.progress.revision,
    },
  });
}
