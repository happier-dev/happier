import type { ReviewTriageStatus } from '../reviewTriageStatus.js';
import type { ReviewCommentStateV1, ReviewCommentTransitionRequestV1, ReviewCommentV1 } from './v1.js';
import { reviewCommentTransitionAllowedV1 } from './mutation.js';

const IGNORED_REASON = 'Ignored during review triage';

function resolveTargetState(state: ReviewCommentStateV1, decision: ReviewTriageStatus): ReviewCommentStateV1 {
  switch (decision) {
    case 'accept':
      // Choosing to fix a proposed or ignored finding makes it open work again.
      return state === 'proposed' || state === 'dismissed' ? 'open' : state;
    case 'reject':
      return reviewCommentTransitionAllowedV1(state, 'dismissed') ? 'dismissed' : state;
    case 'defer':
    case 'needs_refinement':
      return state === 'dismissed' ? 'open' : state;
  }
}

/**
 * The one mapping from a finding decision (Implement fix · Ignore · Decide later · Pending) to a
 * `reviews.comments.transition` request. The review card and the `review.triage` Action both write
 * a finding's decision through it, so `ReviewComment` stays the only place a decision lives.
 */
export function buildReviewTriageTransitionRequestV1(params: Readonly<{
  comment: Pick<ReviewCommentV1, 'id' | 'state' | 'serverRevision' | 'reviewId' | 'projectId' | 'workspace'>;
  decision: ReviewTriageStatus;
  note?: string;
  clientMutationId: string;
}>): ReviewCommentTransitionRequestV1 {
  const { comment } = params;
  const toState = resolveTargetState(comment.state, params.decision);
  const note = params.note?.trim();
  const reason = note || (toState === 'dismissed' && comment.state !== 'dismissed' ? IGNORED_REASON : undefined);
  return {
    commentId: comment.id,
    ...(comment.reviewId ? { reviewId: comment.reviewId } : {}),
    ...(comment.projectId ? { projectId: comment.projectId } : {}),
    ...(comment.workspace ? { workspace: comment.workspace } : {}),
    toState,
    expectedState: comment.state,
    expectedServerRevision: comment.serverRevision,
    reviewTriageStatus: params.decision,
    ...(reason ? { reason } : {}),
    clientMutationId: params.clientMutationId,
  };
}
