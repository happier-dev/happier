import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { SessionTranscriptSourceTimestampMsSchema } from './transcriptSourceTimestampV1.js';
import { SessionSurfaceItemIdSchema } from '../board/ids.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';

export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 = 'session-transcript-observation-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2 = 'session-transcript-observation-v2' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1 = 'transcript-observation-capability-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 = 'transcript-observation-v1' as const;

const NonBlankStringSchema = lazyZodSchema(() => z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a non-blank string',
}));

/** Owning Session is the observation's Session. The original address is presentation correlation only. */
export const SessionTranscriptSurfaceItemReferenceV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  itemId: SessionSurfaceItemIdSchema,
  itemRevision: SessionSystemRecordRevisionSchema,
  sourceAddress: z.object({ serverId: NonBlankStringSchema, sessionId: NonBlankStringSchema }).strict(),
}).strict());
export type SessionTranscriptSurfaceItemReferenceV1 = z.infer<typeof SessionTranscriptSurfaceItemReferenceV1Schema>;

/** The v3 operation epoch preserves acknowledged child identities in historical imports. */
export const SessionHistoricalTranscriptImportV3Schema = lazyZodSchema(() => z.object({
  items: z.array(z.object({
    localId: z.string().trim().min(1),
    content: SessionStoredMessageContentSchema,
    messageRole: SessionMessageRoleSchema.optional(),
    surfaceItemReference: SessionTranscriptSurfaceItemReferenceV1Schema.optional(),
  }).strict()).min(1).max(500),
}).strict());

export const SessionTranscriptObservationProvenanceV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('non_dependent'),
  source: z.enum(['background', 'external', 'sidechain', 'history']),
}).strict());

export type SessionTranscriptObservationProvenanceV1 = z.infer<typeof SessionTranscriptObservationProvenanceV1Schema>;

export function isRecoveredHistoryTranscriptObservationProvenance(
  value: unknown,
): value is SessionTranscriptObservationProvenanceV1 & { source: 'history' } {
  const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(value);
  return provenance.success && provenance.data.source === 'history';
}

const SessionTranscriptObservationBodyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionId: NonBlankStringSchema,
  localId: PendingLocalIdSchema,
  sidechainId: NonBlankStringSchema.nullable().optional(),
  messageRole: SessionMessageRoleSchema.optional(),
  content: z.union([z.string().min(1), SessionStoredMessageContentSchema]),
  createdAt: SessionTranscriptSourceTimestampMsSchema,
  updatedAt: SessionTranscriptSourceTimestampMsSchema,
  provenance: SessionTranscriptObservationProvenanceV1Schema,
  sessionEventType: z.literal('ready').optional(),
}).strict());

function refineObservationTimestamps(value: { createdAt: number; updatedAt: number }, context: z.RefinementCtx) {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must not precede createdAt',
    });
  }
}

export const SessionTranscriptObservationV1Schema = lazyZodSchema(() =>
  SessionTranscriptObservationBodyV1Schema.superRefine(refineObservationTimestamps));

export const SessionTranscriptObservationV2Schema = lazyZodSchema(() =>
  SessionTranscriptObservationBodyV1Schema.extend({ v: z.literal(2),
    surfaceItemReference: SessionTranscriptSurfaceItemReferenceV1Schema.optional(),
  }).superRefine(refineObservationTimestamps));

export const SessionTranscriptObservationInputSchema = lazyZodSchema(() =>
  z.union([SessionTranscriptObservationV1Schema, SessionTranscriptObservationV2Schema]));

export const SessionTranscriptObservationCapabilityRequestSchema = lazyZodSchema(() => z.object({
  v: z.union([z.literal(1), z.literal(2)]), sessionId: NonBlankStringSchema,
}).strict());

export type SessionTranscriptObservationV1 = z.infer<typeof SessionTranscriptObservationV1Schema>;

export const SessionTranscriptObservationCapabilityAckV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'unsupported', 'invalid_session', 'internal']),
  }).strict(),
]));

export const SessionTranscriptObservationCapabilityAckSchema = lazyZodSchema(() => z.union([
  SessionTranscriptObservationCapabilityAckV1Schema,
  z.object({ ok: z.literal(true), capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2) }).strict(),
]));

export const SessionTranscriptObservationAckV1Schema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('observed'),
    id: NonBlankStringSchema,
    seq: z.number().int().min(0),
    localId: PendingLocalIdSchema,
    didWrite: z.boolean(),
    didUpdate: z.boolean().optional(),
    ingestedAt: SessionTranscriptSourceTimestampMsSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'invalid_observation', 'internal']),
  }).strict(),
]));

export type SessionTranscriptObservationCapabilityAckV1 = z.infer<typeof SessionTranscriptObservationCapabilityAckV1Schema>;
export type SessionTranscriptObservationAckV1 = z.infer<typeof SessionTranscriptObservationAckV1Schema>;
