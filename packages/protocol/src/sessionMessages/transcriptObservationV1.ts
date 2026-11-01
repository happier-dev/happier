import { z } from 'zod';

import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 = 'session-transcript-observation-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1 = 'transcript-observation-capability-v1' as const;
export const SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 = 'transcript-observation-v1' as const;

const NonBlankString = lazySchema(() => z.string().refine((value) => value.trim().length > 0, {
  message: 'Expected a non-blank string',
}));
const SourceTimestamp = lazySchema(() => z.number().int().min(0));

export const SessionTranscriptObservationProvenanceV1Schema = lazySchema(() => z.object({
  kind: z.literal('non_dependent'),
  source: z.enum(['background', 'external', 'sidechain', 'history']),
}).strict());

export type SessionTranscriptObservationProvenanceV1 = z.infer<typeof SessionTranscriptObservationProvenanceV1Schema>;

export function isRecoveredHistoryTranscriptObservationProvenance(
  value: unknown,
): value is SessionTranscriptObservationProvenanceV1 & { source: 'history' } {
  if (value === undefined || value === null) return false;
  const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(value);
  return provenance.success && provenance.data.source === 'history';
}

export const SessionTranscriptObservationV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  sessionId: NonBlankString,
  localId: PendingLocalIdSchema,
  sidechainId: NonBlankString.nullable().optional(),
  messageRole: SessionMessageRoleSchema.optional(),
  content: z.union([z.string().min(1), SessionStoredMessageContentSchema]),
  createdAt: SourceTimestamp,
  updatedAt: SourceTimestamp,
  provenance: SessionTranscriptObservationProvenanceV1Schema,
  sessionEventType: z.literal('ready').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.updatedAt < value.createdAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'updatedAt must not precede createdAt' });
  }
}));

export type SessionTranscriptObservationV1 = z.infer<typeof SessionTranscriptObservationV1Schema>;

export const SessionTranscriptObservationCapabilityAckV1Schema = lazySchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    capability: z.literal(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'unsupported', 'invalid_session', 'internal']),
  }).strict(),
]));

export const SessionTranscriptObservationAckV1Schema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal('observed'),
    id: NonBlankString,
    seq: z.number().int().min(0),
    localId: PendingLocalIdSchema,
    didWrite: z.boolean(),
    didUpdate: z.boolean().optional(),
    ingestedAt: SourceTimestamp,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.enum(['forbidden', 'invalid_observation', 'internal']),
  }).strict(),
]));

export type SessionTranscriptObservationCapabilityAckV1 = z.infer<typeof SessionTranscriptObservationCapabilityAckV1Schema>;
export type SessionTranscriptObservationAckV1 = z.infer<typeof SessionTranscriptObservationAckV1Schema>;
