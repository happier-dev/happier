import { z } from 'zod';

import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SessionTurnV1Schema } from '../turns/sessionTurnV1.js';
import {
  ContentProvenanceV1Schema,
  ExternalActorV1Schema,
  SessionInputAdmissionReceiptV1Schema,
  SessionInputSourceAuthorityV1Schema,
  SessionRoleUserProducerKindV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';

const MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS = 50_000;

/** The approved semantic-page budget; the server reads one extra row as lookahead. */
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 = 100;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1 =
  EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1;
export const EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1 = 2 * 1024 * 1024;

/**
 * The same 2 MiB budget applies to the whole route response, including its
 * transaction witness. Server selection uses this helper on its response
 * envelope; Protocol schemas use it on the projection and witness shapes.
 */
export function isExternalShareableTranscriptWirePayloadWithinLimitV1(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      && new TextEncoder().encode(serialized).byteLength <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1;
  } catch {
    return false;
  }
}

const ExternalShareableTextV1Schema = z.string().refine(
  (value) => Array.from(value).length <= MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS,
  `External transcript text must contain at most ${MAX_EXTERNAL_TRANSCRIPT_TEXT_CODE_POINTS} Unicode code points`,
);

const ExternalShareableSourceAuthorityV1Schema = SessionInputSourceAuthorityV1Schema.pick({
  mediatorPluginId: true,
  sourceRef: true,
  sourceRevisionOrEpoch: true,
}).strict();

export const ExternalShareableActorV1Schema = z.enum(['owner', 'collaborator', 'machine']);
export type ExternalShareableActorV1 = z.infer<typeof ExternalShareableActorV1Schema>;

/**
 * Maps the server-only admission receipt to the one coarse fact that may
 * cross the external transcript boundary. Account identity and the exact
 * shared role remain receipt-local.
 */
export function deriveExternalShareableActorFromAdmissionReceiptV1(
  inputAdmissionReceipt: unknown,
): ExternalShareableActorV1 | null {
  const receipt = SessionInputAdmissionReceiptV1Schema.safeParse(inputAdmissionReceipt);
  if (!receipt.success) return null;
  if (receipt.data.issuer === 'authenticatedMachine') return 'machine';
  return receipt.data.sessionRelationship === 'owner' ? 'owner' : 'collaborator';
}

export const ExternalShareableOriginV1Schema = z.object({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  actor: ExternalShareableActorV1Schema,
  sourceAuthority: ExternalShareableSourceAuthorityV1Schema.optional(),
  externalActor: ExternalActorV1Schema.optional(),
  contentProvenance: ContentProvenanceV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.externalActor === undefined) === (value.contentProvenance === undefined)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: value.externalActor === undefined ? ['externalActor'] : ['contentProvenance'],
    message: 'External actor and content provenance must be supplied together',
  });
});
export type ExternalShareableOriginV1 = z.infer<typeof ExternalShareableOriginV1Schema>;

const ExternalShareableConsumedInputV1Schema = z.object({
  localId: z.string().min(1),
  origin: ExternalShareableOriginV1Schema,
}).strict();

export const ExternalShareableTranscriptItemV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('userText'),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    itemId: z.string().min(1),
    localId: z.string().min(1),
    text: ExternalShareableTextV1Schema,
    origin: ExternalShareableOriginV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('assistantText'),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    itemId: z.string().min(1),
    turnId: z.string().min(1),
    final: z.literal('completed'),
    text: ExternalShareableTextV1Schema,
    consumedInputs: z.array(ExternalShareableConsumedInputV1Schema)
      .max(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1)
      .readonly(),
  }).strict(),
]);
export type ExternalShareableTranscriptItemV1 = z.infer<typeof ExternalShareableTranscriptItemV1Schema>;

export const ExternalShareableTranscriptPageV1Schema = z.object({
  items: z.array(ExternalShareableTranscriptItemV1Schema)
    .max(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1)
    .readonly(),
  nextCursor: z.string().min(1).optional(),
  scannedThroughSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict().superRefine((page, context) => {
  const consumedInputCount = page.items.reduce(
    (total, item) => total + (item.kind === 'assistantText' ? item.consumedInputs.length : 0),
    0,
  );
  if (consumedInputCount > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `External transcript page contains more than ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_CONSUMED_INPUTS_V1} consumed inputs`,
    });
  }
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(page)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `External transcript page exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
});
export type ExternalShareableTranscriptPageV1 = z.infer<typeof ExternalShareableTranscriptPageV1Schema>;

const ExternalShareableReferencedUserRowV1Schema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  localId: z.string().min(1),
  messageRole: z.literal('user'),
  content: SessionStoredMessageContentSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  externalShareableActor: ExternalShareableActorV1Schema.optional(),
}).strict();

/**
 * One database-transaction witness for an external transcript page. Its turns
 * are already publication-visible; the optional barriers mark the earliest
 * row that must not advance a cursor until publication or turn settlement is
 * visible. Referenced user rows are the exact, least-disclosure inputs needed
 * to project a final assistant row from the same transaction.
 */
export const ExternalShareableTranscriptSnapshotV1Schema = z.object({
  turns: z.array(SessionTurnV1Schema)
    .max(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1)
    .readonly(),
  publicationBlockedFromSeq: z.number().int().nonnegative().optional(),
  turnSettlementBlockedFromSeq: z.number().int().nonnegative().optional(),
  referencedUserRows: z.array(ExternalShareableReferencedUserRowV1Schema)
    .max(EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1)
    .readonly()
    .optional(),
}).strict().superRefine((snapshot, context) => {
  if (!isExternalShareableTranscriptWirePayloadWithinLimitV1(snapshot)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `External transcript snapshot exceeds ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SERIALIZED_BYTES_V1} serialized bytes`,
    });
  }
});
export type ExternalShareableTranscriptSnapshotV1 = z.infer<
  typeof ExternalShareableTranscriptSnapshotV1Schema
>;

export function filterExternalShareableOriginForCallerV1(params: Readonly<{
  origin: ExternalShareableOriginV1;
  callerPluginId?: string | null;
}>): ExternalShareableOriginV1 {
  const origin = ExternalShareableOriginV1Schema.parse(params.origin);
  if (
    !origin.sourceAuthority
    || !params.callerPluginId
    || !PluginIdSchema.safeParse(params.callerPluginId).success
    || origin.sourceAuthority.mediatorPluginId !== params.callerPluginId
  ) {
    const { sourceAuthority: _sourceAuthority, ...leastDisclosure } = origin;
    return leastDisclosure;
  }
  return origin;
}
