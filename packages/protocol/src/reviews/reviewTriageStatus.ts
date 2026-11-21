import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import type { ReviewCommentStateV1 } from './comments/v1.js';

export const ReviewTriageStatusSchema = lazyZodSchema(() => z.enum(['accept', 'reject', 'defer', 'needs_refinement']));
export type ReviewTriageStatus = z.infer<typeof ReviewTriageStatusSchema>;

export type ReviewFindingDecisionV1 = Extract<ReviewTriageStatus, 'accept' | 'reject' | 'defer'>;

/** Dismissal is Ignore; choosing again supplies fresh intent until its transition settles. */
export function readReviewFindingDecisionV1(
  status: ReviewTriageStatus | undefined,
  state?: ReviewCommentStateV1,
  pendingDecision?: ReviewTriageStatus,
): ReviewFindingDecisionV1 | 'undecided' {
  if (pendingDecision === undefined && state === 'dismissed') return 'reject';
  const decision = pendingDecision ?? status;
  return decision === 'accept' || decision === 'reject' || decision === 'defer' ? decision : 'undecided';
}

/**
 * A finding whose fix landed: its comment was resolved. It keeps its decision (an accepted finding stays accepted),
 * but Implement never sends it again. A new choice the person just made wins until its transition settles.
 */
export function isReviewFindingFixedV1(state?: ReviewCommentStateV1, pendingDecision?: ReviewTriageStatus): boolean {
  return pendingDecision === undefined && state === 'resolved';
}

/** Deferred and clarification decisions still require a person's attention. */
export const REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1 = ['defer', 'needs_refinement'] as const satisfies readonly ReviewTriageStatus[];

export const REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1 = ['resolved', 'dismissed'] as const satisfies readonly ReviewCommentStateV1[];

export function reviewTriageNeedsDecisionV1(status: ReviewTriageStatus | undefined, state?: ReviewCommentStateV1, redacted = false): boolean {
  return !redacted && !REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1.some(candidate => candidate === state)
    && (status === undefined || REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1.some(candidate => candidate === status));
}
