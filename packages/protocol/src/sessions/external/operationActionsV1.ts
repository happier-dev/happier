import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import {
  StrictSessionStoredMessageContentEnvelopeSchema,
} from '../messages/sessionStoredMessageContent.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';
import {
  SessionMetadataOwnerPatchV1Schema,
} from '../metadata/sessionMetadataEnvelopesV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';
import {
  ExternalSessionMaterializationPublicationV1Schema,
  ExternalSessionOperationProgressV1Schema,
  ExternalSessionOperationSemanticRequestV1Schema,
  ExternalSessionPriorStableStorageV1Schema,
} from './operationV1.js';

const OperationReferenceIdSchema = z.string().trim().min(1).max(512);
const OperationIdSchema = z.string().trim().min(1).max(256);
const TranscriptItemIdSchema = z.string().trim().min(1).max(2_000);
const OperationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OperationCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveBoundSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1 = 200;
const EXTERNAL_SESSION_HISTORICAL_IMPORT_BATCH_ID_PREFIX_V1 =
  'historical-import-batch:v1:';
const EXTERNAL_SESSION_HISTORICAL_IMPORT_BATCH_ID_DOMAIN_V1 =
  'happier.external-session-historical-import.batch-id.v1:';

export const ExternalSessionHistoricalImportBatchIdV1Schema = z.string().regex(
  /^historical-import-batch:v1:[0-9a-f]{64}$/,
);
export type ExternalSessionHistoricalImportBatchIdV1 = z.infer<
  typeof ExternalSessionHistoricalImportBatchIdV1Schema
>;

export function makeExternalSessionHistoricalImportBatchIdV1(
  orderedLocalIds: readonly string[],
): ExternalSessionHistoricalImportBatchIdV1 {
  const parsedLocalIds = z.array(TranscriptItemIdSchema)
    .min(1)
    .max(EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1)
    .parse(orderedLocalIds);
  const digest = bytesToHex(sha256(utf8ToBytes(
    `${EXTERNAL_SESSION_HISTORICAL_IMPORT_BATCH_ID_DOMAIN_V1}${JSON.stringify(parsedLocalIds)}`,
  )));
  return ExternalSessionHistoricalImportBatchIdV1Schema.parse(
    `${EXTERNAL_SESSION_HISTORICAL_IMPORT_BATCH_ID_PREFIX_V1}${digest}`,
  );
}

/**
 * Explicit reference to the session-scoped canonical operation claim.
 *
 * It deliberately carries no account, machine, socket, or client identity.
 * Machine identity is authenticated by the transport and checked against the
 * durable claim binding by the socket handler.
 */
export const ExternalSessionOperationClaimV1Schema = z.object({
  sessionId: SessionIdSchema,
  operationId: OperationIdSchema,
  operationClaimId: OperationReferenceIdSchema,
}).strict();
export type ExternalSessionOperationClaimV1 = z.infer<
  typeof ExternalSessionOperationClaimV1Schema
>;

const ExternalSessionMaterializeStartIntentRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: SessionIdSchema,
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

const ExternalSessionTakeoverStartIntentSourceV1Schema = z.object({
  machineId: OperationIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().trim().min(1).max(256),
}).strict();

const ExternalSessionTakeoverStartIntentRequestV1Schema = z.object({
  v: z.literal(1),
  idempotencyKey: OperationIdSchema,
  sessionId: SessionIdSchema,
  source: ExternalSessionTakeoverStartIntentSourceV1Schema,
  plan: z.literal('takeover'),
  targetStorageMode: z.enum(['external-linked', 'persisted']),
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
  sessionId: SessionIdSchema,
  operationId: OperationIdSchema,
  revision: OperationRevisionSchema,
}).strict();
export type ExternalSessionOperationReferenceV1 = z.infer<
  typeof ExternalSessionOperationReferenceV1Schema
>;

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

export const EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1 =
  'externalSessions.operation.v1' as const;

const ExternalSessionOperationSocketCommandBaseV1Schema = z.object({
  v: z.literal(1),
  claim: ExternalSessionOperationClaimV1Schema,
  expectedRevision: OperationRevisionSchema,
});

export const ExternalSessionOperationSocketBatchItemV1Schema = z.object({
  localId: TranscriptItemIdSchema,
  sidechainId: TranscriptItemIdSchema.nullable(),
  messageRole: SessionMessageRoleSchema.nullable(),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  sourceCreatedAtMs: OperationTimestampSchema.optional(),
  sourceUpdatedAtMs: OperationTimestampSchema.optional(),
}).strict().superRefine((item, context) => {
  if (
    item.sourceCreatedAtMs !== undefined
    && item.sourceUpdatedAtMs !== undefined
    && item.sourceUpdatedAtMs < item.sourceCreatedAtMs
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sourceUpdatedAtMs'],
      message: 'Source update time cannot precede source creation time.',
    });
  }
});
export type ExternalSessionOperationSocketBatchItemV1 = z.infer<
  typeof ExternalSessionOperationSocketBatchItemV1Schema
>;

export const ExternalSessionOperationSocketCommandV1Schema =
  z.discriminatedUnion('kind', [
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('inspect'),
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('begin'),
      expectedPriorStableStorage: ExternalSessionPriorStableStorageV1Schema,
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('resume'),
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('batch'),
      batchId: ExternalSessionHistoricalImportBatchIdV1Schema,
      items: z.array(ExternalSessionOperationSocketBatchItemV1Schema)
        .min(1)
        .max(EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1)
        .readonly(),
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('finalize'),
      expectedAcceptedThroughServerSeq: OperationSequenceSchema,
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('admit_persisted_takeover'),
      attemptId: OperationReferenceIdSchema,
      expectedSessionMetadataVersion: OperationRevisionSchema,
      metadataPatch: SessionMetadataOwnerPatchV1Schema,
      expectedSessionSeq: OperationSequenceSchema,
      expectedPending: z.object({
        version: OperationRevisionSchema,
        count: OperationCountSchema,
        blockedCount: OperationCountSchema,
      }).strict(),
      expectedPublication: z.object({
        materializationPublicationId: OperationReferenceIdSchema,
        materializedThroughSourceAt: OperationTimestampSchema,
        publishedThroughServerSeq: OperationSequenceSchema,
      }).strict(),
    }).strict(),
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('discard'),
    }).strict(),
  ]);
export type ExternalSessionOperationSocketCommandV1 = z.infer<
  typeof ExternalSessionOperationSocketCommandV1Schema
>;

export const ExternalSessionOperationSocketBatchLimitsV1Schema = z.object({
  maxItems: PositiveBoundSchema,
  maxSerializedBytes: PositiveBoundSchema,
}).strict();
export type ExternalSessionOperationSocketBatchLimitsV1 = z.infer<
  typeof ExternalSessionOperationSocketBatchLimitsV1Schema
>;

export const ExternalSessionOperationSocketResponseErrorCodeV1Schema = z.enum([
  'upgrade_required',
  'wrong_machine_socket',
  'wrong_session',
  'wrong_operation',
  'wrong_operation_claim',
  'stale_revision',
  'invalid_state',
  'socket_capacity_insufficient',
  'too_many_items',
  'serialized_bytes_exceeded',
  'batch_conflict',
  'storage_mode_conflict',
  'internal_error',
]);
export type ExternalSessionOperationSocketResponseErrorCodeV1 = z.infer<
  typeof ExternalSessionOperationSocketResponseErrorCodeV1Schema
>;

const ExternalSessionOperationSocketResponseBaseV1Schema = z.object({
  v: z.literal(1),
  claim: ExternalSessionOperationClaimV1Schema,
  revision: OperationRevisionSchema,
});

/**
 * Begin and Resume share the ready response, so both always return the
 * effective per-connection limits chosen below the live Socket.IO ceiling.
 */
export const ExternalSessionOperationSocketResponseV1Schema =
  z.discriminatedUnion('kind', [
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('authority'),
      priorStableStorage: ExternalSessionPriorStableStorageV1Schema,
    }).strict(),
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('ready'),
      historicalImportJobId: OperationReferenceIdSchema,
      limits: ExternalSessionOperationSocketBatchLimitsV1Schema,
      acceptedThroughServerSeq: OperationSequenceSchema.optional(),
      priorStableStorage: ExternalSessionPriorStableStorageV1Schema,
    }).strict(),
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('batch_accepted'),
      batchId: ExternalSessionHistoricalImportBatchIdV1Schema,
      acceptedThroughServerSeq: OperationSequenceSchema,
    }).strict(),
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('finalized'),
      acceptedThroughServerSeq: OperationSequenceSchema,
      publication: ExternalSessionMaterializationPublicationV1Schema,
    }).strict(),
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('takeover_admitted'),
      attemptId: OperationReferenceIdSchema,
    }).strict(),
    ExternalSessionOperationSocketResponseBaseV1Schema.extend({
      kind: z.literal('discarded'),
    }).strict(),
    z.object({
      v: z.literal(1),
      kind: z.literal('error'),
      errorCode: ExternalSessionOperationSocketResponseErrorCodeV1Schema,
      message: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]);
export type ExternalSessionOperationSocketResponseV1 = z.infer<
  typeof ExternalSessionOperationSocketResponseV1Schema
>;

export type ExternalSessionOperationSocketBoundClaimV1 = Readonly<
  ExternalSessionOperationClaimV1 & {
    machineId: string;
    revision: number;
  }
>;

export type ExternalSessionOperationSocketAuthorizationV1 =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'wrong_machine_socket'
        | 'wrong_session'
        | 'wrong_operation'
        | 'wrong_operation_claim'
        | 'stale_revision';
    }>;

export function authorizeExternalSessionOperationSocketCommandV1(params: Readonly<{
  transportMachineId: string;
  boundClaim: ExternalSessionOperationSocketBoundClaimV1;
  command: ExternalSessionOperationSocketCommandV1;
}>): ExternalSessionOperationSocketAuthorizationV1 {
  if (params.transportMachineId !== params.boundClaim.machineId) {
    return { ok: false, errorCode: 'wrong_machine_socket' };
  }
  if (params.command.claim.sessionId !== params.boundClaim.sessionId) {
    return { ok: false, errorCode: 'wrong_session' };
  }
  if (params.command.claim.operationId !== params.boundClaim.operationId) {
    return { ok: false, errorCode: 'wrong_operation' };
  }
  if (
    params.command.claim.operationClaimId
    !== params.boundClaim.operationClaimId
  ) {
    return { ok: false, errorCode: 'wrong_operation_claim' };
  }
  if (params.command.expectedRevision !== params.boundClaim.revision) {
    return { ok: false, errorCode: 'stale_revision' };
  }
  return { ok: true };
}

export type ExternalSessionOperationSocketBatchLimitResolutionV1 =
  | Readonly<{
      ok: true;
      limits: ExternalSessionOperationSocketBatchLimitsV1;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'socket_capacity_insufficient';
    }>;

/**
 * Resolves the per-connection payload budget from the server's actual live
 * socket ceiling. Reserving the full envelope allowance guarantees the
 * returned serialized-byte ceiling is strictly smaller than that socket max.
 */
export function resolveExternalSessionOperationSocketBatchLimitsV1(
  paramsInput: Readonly<{
    socketMaxSerializedBytes: number;
    envelopeOverheadBytes: number;
    configuredMaxSerializedBytes: number;
    configuredMaxItems: number;
  }>,
): ExternalSessionOperationSocketBatchLimitResolutionV1 {
  const params = z.object({
    socketMaxSerializedBytes: PositiveBoundSchema,
    envelopeOverheadBytes: PositiveBoundSchema,
    configuredMaxSerializedBytes: PositiveBoundSchema,
    configuredMaxItems: PositiveBoundSchema,
  }).strict().parse(paramsInput);

  const socketPayloadCapacity =
    params.socketMaxSerializedBytes - params.envelopeOverheadBytes;
  if (socketPayloadCapacity < 1) {
    return { ok: false, errorCode: 'socket_capacity_insufficient' };
  }

  return {
    ok: true,
    limits: {
      maxItems: Math.min(
        params.configuredMaxItems,
        EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1,
      ),
      maxSerializedBytes: Math.min(
        params.configuredMaxSerializedBytes,
        socketPayloadCapacity,
      ),
    },
  };
}

export type ExternalSessionOperationSocketBatchValidationV1 =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'too_many_items' | 'serialized_bytes_exceeded';
    }>;

export function validateExternalSessionOperationSocketBatchV1(
  command: ExternalSessionOperationSocketCommandV1,
  limits: Readonly<{ maxItems: number; maxSerializedBytes: number }>,
): ExternalSessionOperationSocketBatchValidationV1 {
  if (command.kind !== 'batch') return { ok: true };
  if (command.items.length > limits.maxItems) {
    return { ok: false, errorCode: 'too_many_items' };
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
  if (serializedBytes > limits.maxSerializedBytes) {
    return { ok: false, errorCode: 'serialized_bytes_exceeded' };
  }
  return { ok: true };
}
