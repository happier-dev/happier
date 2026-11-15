import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { SessionTranscriptSourceTimestampMsSchema } from './transcriptSourceTimestampV1.js';
import { SessionSurfaceItemIdSchema } from '../board/ids.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import { EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 } from '../../actions/externalActionLimits.js';
import { SessionFollowTerminalAckFactsV1Schema } from '../follow/accountFollow.js';

export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 = 'session-transcript-observation-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2 = 'session-transcript-observation-v2' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1 = 'transcript-observation-capability-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 = 'transcript-observation-v1' as const;
/**
 * Ordered transcript observations from one publisher in one frame. Home observes them in order
 * through the same per-observation write and stops at the first refusal, so a refused observation
 * never lets a later one commit ahead of it.
 */
export const SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1 = 'transcript-observation-batch-v1' as const;
/**
 * A batch frame must fit Home's Socket.IO receive buffer. Home refuses to start with a buffer
 * below this floor, so a batch whose `[event, payload]` encoding stays under it always arrives.
 * The reserve covers the Socket.IO packet prefix (packet type, namespace and ack id).
 */
export const SESSION_TRANSCRIPT_OBSERVATION_BATCH_MAX_ENCODED_BYTES_V1 = EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 - 64;

const NonBlankStringSchema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, {
  message: 'Expected a non-blank string',
})));

/** Owning Session is the observation's Session. The original address is presentation correlation only. */
export const SessionTranscriptSurfaceItemReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  itemId: SessionSurfaceItemIdSchema,
  itemRevision: SessionSystemRecordRevisionSchema,
  sourceAddress: z.strictObject({ serverId: NonBlankStringSchema, sessionId: NonBlankStringSchema }),
}));
export type SessionTranscriptSurfaceItemReferenceV1 = z.infer<typeof SessionTranscriptSurfaceItemReferenceV1Schema>;

/** Current publishers retain the exact immutable acknowledgement separately from the owned grant. */
export const SessionTranscriptSurfaceItemReferenceMemberV1Schema = lazyZodSchema(() =>
  z.extend(SessionTranscriptSurfaceItemReferenceV1Schema, {
    sourceItemId: SessionSurfaceItemIdSchema,
    sourceItemRevision: z.nullable(SessionSystemRecordRevisionSchema),
    approvalRequestArtifactId: z.optional(NonBlankStringSchema),
  }));
export type SessionTranscriptSurfaceItemReferenceMemberV1 = z.infer<typeof SessionTranscriptSurfaceItemReferenceMemberV1Schema>;

/** Originless singleton members are a development-seam read adapter, not invented origin proof. */
export const SessionTranscriptSurfaceItemReferenceReadV1Schema = lazyZodSchema(() => z.union([
  SessionTranscriptSurfaceItemReferenceMemberV1Schema, SessionTranscriptSurfaceItemReferenceV1Schema,
]));
export type SessionTranscriptSurfaceItemReferenceReadV1 = z.infer<typeof SessionTranscriptSurfaceItemReferenceReadV1Schema>;

export const SessionTranscriptSurfaceItemReferencesV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), references: z.array(SessionTranscriptSurfaceItemReferenceReadV1Schema).check(z.minLength(1)),
}));
export type SessionTranscriptSurfaceItemReferencesV1 = z.infer<typeof SessionTranscriptSurfaceItemReferencesV1Schema>;

/** A keyholding settlement producer offers this candidate; Session Item admission alone grants a read. */
export const ApprovalTranscriptVisualPublicationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), sessionId: NonBlankStringSchema,
  surfaceItemReference: SessionTranscriptSurfaceItemReferencesV1Schema,
}));
export type ApprovalTranscriptVisualPublicationV1 = z.infer<typeof ApprovalTranscriptVisualPublicationV1Schema>;

/** The sole accepted-shape adapter: all new stored/wire writes carry one collection per native row. */
export const SessionTranscriptSurfaceItemReferenceInputV1Schema = lazyZodSchema(() => z.pipe(z.union([
  SessionTranscriptSurfaceItemReferencesV1Schema, SessionTranscriptSurfaceItemReferenceV1Schema,
]), z.transform(value => 'references' in value ? value : { v: 1 as const, references: [value] })));
export type SessionTranscriptSurfaceItemReferenceInputV1 = z.input<typeof SessionTranscriptSurfaceItemReferenceInputV1Schema>;

export function readSessionTranscriptSurfaceItemReferencesV1(value: unknown): readonly SessionTranscriptSurfaceItemReferenceReadV1[] | null {
  const parsed = createStoredReadSchema(SessionTranscriptSurfaceItemReferenceInputV1Schema).safeParse(value);
  return parsed.success ? parsed.data.references : null;
}

/** Distinct settled receipts may share one Item copy without losing their source correspondence. */
export function getSessionTranscriptSurfaceItemReferenceSourceKeyV1(reference: Pick<SessionTranscriptSurfaceItemReferenceMemberV1,
  'sourceAddress' | 'sourceItemId' | 'sourceItemRevision' | 'approvalRequestArtifactId'>): string {
  const source = [reference.sourceAddress.serverId, reference.sourceAddress.sessionId,
    reference.sourceItemId, reference.sourceItemRevision];
  return JSON.stringify(reference.approvalRequestArtifactId ? [...source, reference.approvalRequestArtifactId] : source);
}

/** Existing per-request boundary shared by the v2 and v3 historical import epochs. */
export const SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS = 500;

/** The v3 operation epoch preserves acknowledged child identities in historical imports. */
export const SessionHistoricalTranscriptImportV3Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    localId: z.string().check(z.trim(), z.minLength(1)),
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
    content: SessionStoredMessageContentSchema,
    messageRole: z.optional(SessionMessageRoleSchema),
    surfaceItemReference: z.optional(SessionTranscriptSurfaceItemReferenceInputV1Schema),
  })).check(z.minLength(1), z.maxLength(SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS)),
}));

export const SessionTranscriptObservationProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('non_dependent'),
  source: z.enum(['background', 'external', 'sidechain', 'history']),
}));

export type SessionTranscriptObservationProvenanceV1 = z.infer<typeof SessionTranscriptObservationProvenanceV1Schema>;

export function isRecoveredHistoryTranscriptObservationProvenance(
  value: unknown,
  purpose: 'input' | 'stored' = 'input',
): value is SessionTranscriptObservationProvenanceV1 & { source: 'history' } {
  if (value === undefined || value === null) return false;
  const provenance = (purpose === 'stored'
    ? createStoredReadSchema(SessionTranscriptObservationProvenanceV1Schema)
    : SessionTranscriptObservationProvenanceV1Schema).safeParse(value);
  return provenance.success && provenance.data.source === 'history';
}

const SessionTranscriptObservationBodyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: NonBlankStringSchema,
  usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
  localId: PendingLocalIdSchema,
  sidechainId: z.optional(z.nullable(NonBlankStringSchema)),
  messageRole: z.optional(SessionMessageRoleSchema),
  content: z.union([z.string().check(z.minLength(1)), SessionStoredMessageContentSchema]),
  createdAt: SessionTranscriptSourceTimestampMsSchema,
  updatedAt: SessionTranscriptSourceTimestampMsSchema,
  provenance: SessionTranscriptObservationProvenanceV1Schema,
  sessionEventType: z.optional(z.literal('ready')),
  /**
   * What changed since the publisher's last acknowledged commit of this localId: `content` is the
   * same record shape carrying only the appended text. Home stores `content`; it relays `append`
   * to live consumers only when its stored row is that base (`baseUpdatedAt` = the stored
   * source `updatedAt`), otherwise it publishes the full message.
   */
  append: z.optional(z.strictObject({
    content: z.union([z.string().check(z.minLength(1)), SessionStoredMessageContentSchema]),
    baseLength: z.number().check(z.int(), z.minimum(0)),
    baseUpdatedAt: SessionTranscriptSourceTimestampMsSchema,
  })),
  /**
   * The publisher will announce this row as a terminal Follow original: Home returns the
   * writer's own follow facts for it in the ack (`followRoutes`), when it may.
   */
  followFacts: z.optional(z.literal(true)),
}));

function refineObservationTimestamps(value: { createdAt: number; updatedAt: number }, context: z.core.$RefinementCtx) {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: "custom",
      path: ['updatedAt'],
      message: 'updatedAt must not precede createdAt',
    });
  }
}

export const SessionTranscriptObservationV1Schema = lazyZodSchema(() =>
  SessionTranscriptObservationBodyV1Schema.check(z.superRefine(refineObservationTimestamps)));

export const SessionTranscriptObservationV2Schema = lazyZodSchema(() =>
  z.extend(SessionTranscriptObservationBodyV1Schema, { v: z.literal(2),
    surfaceItemReference: z.optional(SessionTranscriptSurfaceItemReferenceInputV1Schema),
    approvalRequestArtifactId: z.optional(NonBlankStringSchema),
  }).check(z.superRefine(refineObservationTimestamps)));

export const SessionTranscriptObservationInputSchema = lazyZodSchema(() =>
  z.union([SessionTranscriptObservationV1Schema, SessionTranscriptObservationV2Schema]));

export const SessionTranscriptObservationCapabilityRequestSchema = lazyZodSchema(() => z.strictObject({
  v: z.union([z.literal(1), z.literal(2)]), sessionId: NonBlankStringSchema,
}));

export type SessionTranscriptObservationV1 = z.infer<typeof SessionTranscriptObservationV1Schema>;

export const SessionTranscriptObservationCapabilityAckV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'unsupported', 'invalid_session', 'internal']),
  }),
]));

export const SessionTranscriptObservationCapabilityAckSchema = lazyZodSchema(() => z.union([
  SessionTranscriptObservationCapabilityAckV1Schema,
  z.strictObject({ ok: z.literal(true), capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2) }),
]));

export const SessionTranscriptObservationAckV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.literal('observed'),
    id: NonBlankStringSchema,
    seq: z.number().check(z.int(), z.minimum(0)),
    localId: PendingLocalIdSchema,
    didWrite: z.boolean(),
    didUpdate: z.optional(z.boolean()),
    ingestedAt: SessionTranscriptSourceTimestampMsSchema,
    /** Only for a `followFacts` request from the Session's own admitted publisher. */
    followRoutes: z.optional(SessionFollowTerminalAckFactsV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'invalid_observation', 'internal']),
  }),
]));

export type SessionTranscriptObservationCapabilityAckV1 = z.infer<typeof SessionTranscriptObservationCapabilityAckV1Schema>;
export type SessionTranscriptObservationAckV1 = z.infer<typeof SessionTranscriptObservationAckV1Schema>;

export const SessionTranscriptObservationBatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: NonBlankStringSchema,
  observations: z.array(z.unknown()).check(z.minLength(1)),
}));

/** Acks for the observed prefix, in order; the last one is the refusal when Home stopped early. */
export const SessionTranscriptObservationBatchAckV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), acks: z.array(SessionTranscriptObservationAckV1Schema) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['forbidden', 'invalid_observation', 'internal']) }),
]));
export type SessionTranscriptObservationBatchAckV1 = z.infer<typeof SessionTranscriptObservationBatchAckV1Schema>;
