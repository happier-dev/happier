import { resolveEffectiveReviewFindingFollowUps, type EffectiveReviewFindings } from '@happier-dev/protocol/reviews/resolveEffectiveReviewFindings';
import { ReviewFollowUpV1Schema, type ReviewFollowUpV1 } from '@happier-dev/protocol/messages/structured/reviewFollowUpV1';
import type { ExecutionRunStructuredRunRef } from '@happier-dev/protocol/messages/structured/executionRunStructuredRunRef';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import type { Message } from '@happier-dev/session-core/messages';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';

export type { EffectiveReviewFindings, ReviewFindingThreadEntry } from '@happier-dev/protocol';

/** Transcript adapter; host and UI share the same effective finding/thread decision owner. */
export function resolveEffectiveReviewFindings(params: Readonly<{
    runRef: ExecutionRunStructuredRunRef;
    initialFindings: readonly ReviewFinding[];
    messages: readonly Message[];
}>): EffectiveReviewFindings {
    const followUps: ReviewFollowUpV1[] = [];
    for (const message of params.messages) {
        const envelope = parseHappierMetaEnvelope(message.meta);
        if (envelope?.kind !== 'review_follow_up.v1') continue;
        const parsed = ReviewFollowUpV1Schema.safeParse(envelope.payload);
        if (parsed.success) followUps.push(parsed.data);
    }
    return resolveEffectiveReviewFindingFollowUps({ ...params, followUps });
}
