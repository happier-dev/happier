import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { isSessionAwarenessContentReadableV1 } from '../awareness/availability.js';
import { SessionAwarenessProjectionV1Schema } from '../awareness/projectionV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionMessageProvenanceV1Schema } from '../messages/sessionInputAdmission.js';
import { SessionTranscriptObservationAckV1Schema } from '../messages/transcriptObservationV1.js';
import { SessionFollowFrontierV1Schema } from './sessionFollowFrontierV1.js';

export const SessionFollowMessageSummaryV1Schema = lazyZodSchema(() => z.object({
  messageId: SessionTranscriptObservationAckV1Schema.options[0].shape.id,
  seq: SessionTranscriptObservationAckV1Schema.options[0].shape.seq,
  text: z.string(),
  /** Sanitized display label; protected provenance remains the authority for origin. */
  authorLabel: z.string().trim().min(1).max(191).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
  provenance: SessionMessageProvenanceV1Schema.nullable(),
}).strict());
export type SessionFollowMessageSummaryV1 = z.infer<typeof SessionFollowMessageSummaryV1Schema>;

export const SessionFollowUpdateEnvelopeV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('session_follow_update'),
  edge: z.object({
    sourceSessionId: asProtocolZod(SessionIdSchema),
    destinationSessionId: asProtocolZod(SessionIdSchema),
  }).strict(),
  reason: z.enum(['source_changed', 'source_unavailable', 'human_changed_source']),
  deliveryIntent: z.enum(['context_only', 'wake']),
  observed: SessionFollowFrontierV1Schema,
  awareness: SessionAwarenessProjectionV1Schema,
  recentMessages: z.array(SessionFollowMessageSummaryV1Schema),
  truncated: z.boolean(),
}).strict().superRefine((update, context) => {
  if ((update.reason === 'human_changed_source') !== (update.deliveryIntent === 'wake')) {
    context.addIssue({ code: 'custom', path: ['deliveryIntent'], message: 'Wake intent requires a human-change reason' });
  }
  if (update.edge.sourceSessionId === update.edge.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['edge'], message: 'Follow requires distinct Sessions' });
  }
  if (update.awareness.sessionId !== update.edge.sourceSessionId) {
    context.addIssue({ code: 'custom', path: ['awareness', 'sessionId'], message: 'Awareness must describe the source Session' });
  }
  for (const [index, message] of update.recentMessages.entries()) {
    if (message.seq > update.observed.transcriptSeq) {
      context.addIssue({ code: 'custom', path: ['recentMessages', index, 'seq'], message: 'Message exceeds the observed frontier' });
    }
  }
  if (update.reason === 'source_unavailable' || !isSessionAwarenessContentReadableV1(update.awareness.encryption)) {
    if (update.recentMessages.length > 0) {
      context.addIssue({ code: 'custom', path: ['recentMessages'], message: 'Unavailable source content must be omitted' });
    }
    for (const field of ['title', 'currentWork', 'workspace', 'lineage'] as const) {
      if (update.awareness[field] !== undefined) {
        context.addIssue({ code: 'custom', path: ['awareness', field], message: 'Unavailable source content must be omitted' });
      }
    }
  }
}));
export type SessionFollowUpdateEnvelopeV1 = z.infer<typeof SessionFollowUpdateEnvelopeV1Schema>;

/**
 * Wake eligibility is intentionally narrower than "user role". Only protected,
 * settled provenance that names a direct authoritative human producer may
 * start a context-only turn. Voice transcript materialization, descriptive
 * host/requested provenance, and forwarded/bot plugin content remain
 * natural-turn context and can never recurse.
 */
export function isAuthoritativeHumanSessionFollowMessageV1(
  message: Pick<SessionFollowMessageSummaryV1, 'provenance'>,
): boolean {
  const provenance = message.provenance;
  if (provenance === null) return false;
  if (provenance.kind === 'happierApp' || provenance.kind === 'cli') return true;
  return provenance.kind === 'pluginSession'
    && provenance.externalActor?.kind === 'human'
    && provenance.contentProvenance === 'original';
}
