import { sha256 } from '@noble/hashes/sha256';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import { SessionIdSchema, SidechainIdSchema } from '../idsV1.js';
import {
  StrictSessionStoredMessageContentEnvelopeSchema,
} from '../messages/sessionStoredMessageContent.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';
import { SessionTranscriptSourceTimestampMsSchema } from '../messages/transcriptSourceTimestampV1.js';
import {
  SessionMetadataOwnerPatchV1Schema,
  SessionMetadataPublisherPreconditionV1Schema,
} from '../metadata/sessionMetadataEnvelopesV1.js';
import {
  ExternalSessionMaterializationPublicationV1Schema,
  ExternalSessionPriorStableStorageV1Schema,
} from './operationV1.js';

export {
  ExternalSessionMaterializeActionInputV1Schema,
  ExternalSessionMaterializeActionResultV1Schema,
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionOperationActionErrorCodeV1Schema,
  ExternalSessionOperationActionErrorV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  ExternalSessionOperationTransportReferenceV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionMaterializeActionResultV1,
  projectExternalSessionOperationActionResultV1,
  type ExternalSessionMaterializeActionResultV1,
  type ExternalSessionMaterializeStartInputV1,
  type ExternalSessionOperationActionErrorCodeV1,
  type ExternalSessionOperationActionErrorV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationActionResultV1,
  type ExternalSessionOperationCancelInputV1,
  type ExternalSessionOperationDiscardInputV1,
  type ExternalSessionOperationReferenceV1,
  type ExternalSessionOperationResumeInputV1,
  type ExternalSessionOperationRetryInputV1,
  type ExternalSessionOperationStatusInputV1,
  type ExternalSessionTakeoverStartInputV1,
} from './operationActionSchemasV1.js';

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
  sessionId: asProtocolZod(SessionIdSchema),
  operationId: OperationIdSchema,
  operationClaimId: OperationReferenceIdSchema,
}).strict();
export type ExternalSessionOperationClaimV1 = z.infer<
  typeof ExternalSessionOperationClaimV1Schema
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
  sidechainId: SidechainIdSchema.nullable(),
  messageRole: SessionMessageRoleSchema.nullable(),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  sourceCreatedAtMs: SessionTranscriptSourceTimestampMsSchema.optional(),
  sourceUpdatedAtMs: SessionTranscriptSourceTimestampMsSchema.optional(),
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

const ExternalSessionTakeoverAdmissionCommandV1Schema =
  z.discriminatedUnion('mode', [
    ExternalSessionOperationSocketCommandBaseV1Schema.extend({
      kind: z.literal('admit_persisted_takeover'),
      mode: z.literal('persisted'),
      attemptId: OperationReferenceIdSchema,
      publisherPrecondition: SessionMetadataPublisherPreconditionV1Schema,
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
      kind: z.literal('admit_persisted_takeover'),
      mode: z.literal('external_linked'),
      attemptId: OperationReferenceIdSchema,
      publisherPrecondition: SessionMetadataPublisherPreconditionV1Schema,
      expectedSessionMetadataVersion: OperationRevisionSchema,
      expectedSessionSeq: OperationSequenceSchema,
      expectedPending: z.object({
        version: OperationRevisionSchema,
        count: OperationCountSchema,
        blockedCount: OperationCountSchema,
      }).strict(),
      expectedPriorStableStorage: ExternalSessionPriorStableStorageV1Schema,
    }).strict(),
  ]);

export const ExternalSessionOperationSocketCommandV1Schema =
  z.union([
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
    ExternalSessionTakeoverAdmissionCommandV1Schema,
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
      mode: z.enum(['persisted', 'external_linked']),
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
