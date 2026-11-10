import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { isSessionAwarenessContentReadableV1 } from '../awareness/availability.js';
import { SessionAwarenessProjectionV1Schema } from '../awareness/projectionV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionMessageProvenanceV1Schema } from '../messages/sessionInputAdmission.js';
import { SessionTranscriptObservationAckV1Schema } from '../messages/transcriptObservationV1.js';
import { SessionFollowFrontierV1Schema } from './sessionFollowFrontierV1.js';
import { InteractionTransientQuestionV1Schema, MAX_INTERACTION_TRANSIENT_QUESTIONS_V1 } from '../../plugins/interactions/transientV1.js';
import { SessionQuestionHandlerV1Schema, SessionQuestionContextV1Schema } from '../permissions/questionV1.js';
import { SessionPermissionRequestIdV1Schema } from '../permissions/v1.js';

export const SessionFollowMessageSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  messageId: SessionTranscriptObservationAckV1Schema._zod.def.options[0].shape.id,
  seq: SessionTranscriptObservationAckV1Schema._zod.def.options[0].shape.seq,
  text: z.string(),
  /** Content-free committed Goal original, classified by the source hydrator. */
  event: z.optional(z.strictObject({ kind: z.literal('goal_changed') })),
  /** Sanitized display label; protected provenance remains the authority for origin. */
  authorLabel: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(191), z.regex(/^[^\u0000-\u001f\u007f]+$/u))),
  provenance: z.nullable(SessionMessageProvenanceV1Schema),
}));
export type SessionFollowMessageSummaryV1 = z.infer<typeof SessionFollowMessageSummaryV1Schema>;

export const SessionFollowUpdateEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('session_follow_update'),
  edge: z.strictObject({
    sourceSessionId: asProtocolZod(SessionIdSchema),
    destinationSessionId: asProtocolZod(SessionIdSchema),
  }),
  reason: z.enum(['source_changed', 'source_unavailable', 'human_changed_source']),
  deliveryIntent: z.enum(['context_only', 'wake']),
  observed: SessionFollowFrontierV1Schema,
  awareness: SessionAwarenessProjectionV1Schema,
  recentMessages: z.array(SessionFollowMessageSummaryV1Schema),
  /** Ephemeral, complete forms opened from exact admitted request originals. No answer authority. */
  questionOffers: z.optional(z.array(z.strictObject({
    requestId: SessionPermissionRequestIdV1Schema,
    currentHandler: SessionQuestionHandlerV1Schema,
    questionV1: z.optional(SessionQuestionContextV1Schema),
    questions: z.array(InteractionTransientQuestionV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1)),
  }))),
  truncated: z.boolean(),
}).check(z.superRefine((update, context) => {
  if ((update.reason === 'human_changed_source') !== (update.deliveryIntent === 'wake')) {
    context.addIssue({ code: 'custom', path: ['deliveryIntent'], message: 'Wake intent requires a human-change reason' });
  }
  if (update.edge.sourceSessionId === update.edge.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['edge'], message: 'Follow requires distinct Sessions' });
  }
  if (update.awareness.sessionId !== update.edge.sourceSessionId) {
    context.addIssue({ code: 'custom', path: ['awareness', 'sessionId'], message: 'Awareness must describe the source Session' });
  }
  for (const [index, offer] of (update.questionOffers ?? []).entries()) {
    if (offer.currentHandler.kind !== 'session' || offer.currentHandler.sessionId !== update.edge.destinationSessionId) {
      context.addIssue({ code: 'custom', path: ['questionOffers', index, 'currentHandler'], message: 'Question offers describe this destination handler' });
    }
  }
  for (const [index, message] of update.recentMessages.entries()) {
    if (message.seq > update.observed.transcriptSeq) {
      context.addIssue({ code: 'custom', path: ['recentMessages', index, 'seq'], message: 'Message exceeds the observed frontier' });
    }
  }
  if (update.reason === 'source_unavailable' || !isSessionAwarenessContentReadableV1(update.awareness.encryption)) {
    if (update.questionOffers?.length) {
      context.addIssue({ code: 'custom', path: ['questionOffers'], message: 'Unavailable question content must be omitted' });
    }
    if (update.recentMessages.length > 0) {
      context.addIssue({ code: 'custom', path: ['recentMessages'], message: 'Unavailable source content must be omitted' });
    }
    for (const field of ['title', 'currentWork', 'workspace', 'lineage'] as const) {
      if (update.awareness[field] !== undefined) {
        context.addIssue({ code: 'custom', path: ['awareness', field], message: 'Unavailable source content must be omitted' });
      }
    }
  }
})));
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
