import type { PendingDeliveryStatusV1 } from '../messages/pendingDeliveryStatusV1.js';
import type { SessionMessageAcceptedTurnV1 } from '../messages/sessionMessageDeliveryResolutionV1.js';
import type { SessionMessageReplyOutcomeV1 } from '../messages/sessionMessageReplyV1.js';
import type { SessionReceiverDeliveryDecisionV1 } from './sessionReceiverDeliveryV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Presentation only; neither status nor reason grants delivery or ACK authority. */
export const FollowDeliveryProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.nullable(z.enum(['queued', 'next_turn', 'woke', 'answered'])),
  reason: z.nullable(z.enum(['held', 'offline', 'archived', 'locked', 'muted', 'unavailable', 'check_in', 'exchange_stopped'])),
}));
export type FollowDeliveryProjectionV1 = z.infer<typeof FollowDeliveryProjectionV1Schema>;

/**
 * Project already-matched occurrence evidence. The caller must bind acceptance
 * and reply to the same original source occurrence; this never infers them from
 * a resume request, an unaccepted transcript card, or a raw edge frontier.
 */
export function projectFollowDeliveryV1(input: Readonly<{
  intent: 'wake' | 'next_turn';
  decision: SessionReceiverDeliveryDecisionV1;
  pendingStatus?: PendingDeliveryStatusV1;
  acceptedTurn?: SessionMessageAcceptedTurnV1;
  /** Host's exact lifecycle Turn-begin cause for this occurrence; not exchange accounting. */
  acceptedTurnStartsNewTurn?: boolean;
  replyOutcome?: SessionMessageReplyOutcomeV1['kind'];
}>): FollowDeliveryProjectionV1 {
  const reason = input.decision.disposition === 'hold'
    ? input.decision.reason === 'explicit_stop' ? 'held' as const
      : input.decision.reason === 'receiver_unavailable' || input.decision.reason === 'exchange_unavailable'
        ? 'unavailable' as const : input.decision.reason
    : input.decision.disposition === 'drop' ? input.decision.reason : null;
  if (input.replyOutcome === 'answer') return { status: 'answered', reason };
  if (input.acceptedTurn) {
    if (input.acceptedTurn.kind === 'steer') return { status: null, reason };
    if (input.intent === 'next_turn' || input.acceptedTurnStartsNewTurn === false) {
      return { status: 'next_turn', reason };
    }
    return { status: input.acceptedTurnStartsNewTurn === true ? 'woke' : null, reason };
  }
  // Existing Pending custody owns uncertainty. A plausible provider effect is
  // not promoted to accepted Follow delivery by this presentation projection.
  if (input.pendingStatus?.status === 'delivering'
    || input.pendingStatus?.status === 'external_handoff'
    || input.pendingStatus?.status === 'discarded'
    || input.pendingStatus?.status === 'blocked'
      && (input.pendingStatus.reason === 'ambiguous_terminal_delivery'
        || input.pendingStatus.reason === 'delivery_outcome_uncertain'
        || input.pendingStatus.reason === 'unknown')) return { status: null, reason };
  if (input.decision.disposition === 'drop') return { status: null, reason };
  if (input.pendingStatus?.status === 'queued') return { status: 'queued', reason };
  // A next-turn decision is placement intent, not proof that the receiver
  // accepted an input. The existing Pending/turn owner supplies that proof.
  return { status: null, reason };
}
