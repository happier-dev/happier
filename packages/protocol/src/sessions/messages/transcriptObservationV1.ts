import { z } from 'zod';

import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';

export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 = 'session-transcript-observation-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1 = 'transcript-observation-capability-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 = 'transcript-observation-v1' as const;

const NonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a non-blank string',
});
const SourceTimestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);

export const SessionTranscriptObservationProvenanceV1Schema = z.object({
  kind: z.literal('non_dependent'),
  source: z.enum(['background', 'external', 'sidechain', 'history']),
}).strict();

export type SessionTranscriptObservationProvenanceV1 = z.infer<typeof SessionTranscriptObservationProvenanceV1Schema>;

export const SessionTranscriptObservationV1Schema = z.object({
  v: z.literal(1),
  sessionId: NonBlankStringSchema,
  localId: PendingLocalIdSchema,
  sidechainId: NonBlankStringSchema.nullable().optional(),
  messageRole: SessionMessageRoleSchema.optional(),
  content: z.union([z.string().min(1), SessionStoredMessageContentSchema]),
  createdAt: SourceTimestampSchema,
  updatedAt: SourceTimestampSchema,
  provenance: SessionTranscriptObservationProvenanceV1Schema,
  sessionEventType: z.literal('ready').optional(),
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must not precede createdAt',
    });
  }
});

export type SessionTranscriptObservationV1 = z.infer<typeof SessionTranscriptObservationV1Schema>;

export const SessionTranscriptObservationCapabilityAckV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'unsupported', 'invalid_session', 'internal']),
  }).strict(),
]);

export const SessionTranscriptObservationAckV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('observed'),
    id: NonBlankStringSchema,
    seq: z.number().int().min(0),
    localId: PendingLocalIdSchema,
    didWrite: z.boolean(),
    didUpdate: z.boolean().optional(),
    ingestedAt: SourceTimestampSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'invalid_observation', 'internal']),
  }).strict(),
]);

export type SessionTranscriptObservationCapabilityAckV1 = z.infer<typeof SessionTranscriptObservationCapabilityAckV1Schema>;
export type SessionTranscriptObservationAckV1 = z.infer<typeof SessionTranscriptObservationAckV1Schema>;
