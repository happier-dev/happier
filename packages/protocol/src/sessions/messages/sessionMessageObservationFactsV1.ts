import { z } from '../../zodRuntimePolicy.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { SessionMessageAttentionImpactSchema, SESSION_MESSAGE_USER_ATTENTION_IMPACT } from './transcriptRawRecordV1.js';
import { SessionTranscriptObservationProvenanceV1Schema } from './transcriptObservationV1.js';
import type { SessionMessageV1 } from './sessionMessagesPageV1.js';

const timestamp = z.number().check(z.int(), z.minimum(0));
/** Closed bodyless observation. Full stored/HTTP messages remain a separate type. */
export const SessionMessageObservationFactsV1Schema = z.strictObject({
  id: z.string().check(z.minLength(1)), seq: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
  localId: z.nullable(z.string()), sidechainId: z.optional(z.nullable(z.string())),
  messageRole: z.optional(z.nullable(SessionMessageRoleSchema)),
  attentionImpact: SessionMessageAttentionImpactSchema,
  createdAt: timestamp, updatedAt: timestamp,
  sourceCreatedAt: z.optional(timestamp), sourceUpdatedAt: z.optional(timestamp),
  transcriptObservationProvenance: z.optional(SessionTranscriptObservationProvenanceV1Schema),
});
export type SessionMessageObservationFactsV1 = z.infer<typeof SessionMessageObservationFactsV1Schema>;

/** Input is already admitted and serialized; never inspect content to derive facts. */
export function buildSessionMessageObservationFactsV1(message: SessionMessageV1): SessionMessageObservationFactsV1 {
  return {
    id: message.id, seq: message.seq, localId: message.localId ?? null,
    ...(message.sidechainId === undefined ? {} : { sidechainId: message.sidechainId }),
    ...(message.messageRole === undefined ? {} : { messageRole: message.messageRole }),
    attentionImpact: message.attentionImpact ?? SESSION_MESSAGE_USER_ATTENTION_IMPACT,
    createdAt: message.createdAt, updatedAt: message.updatedAt ?? message.createdAt,
    ...(message.sourceCreatedAt === undefined ? {} : { sourceCreatedAt: message.sourceCreatedAt }),
    ...(message.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: message.sourceUpdatedAt }),
    ...(message.transcriptObservationProvenance === undefined ? {} : { transcriptObservationProvenance: message.transcriptObservationProvenance }),
  };
}
