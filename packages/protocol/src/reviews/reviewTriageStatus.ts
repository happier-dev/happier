import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import type { ReviewCommentStateV1, ReviewCommentV1 } from './comments/v1.js';

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

/**
 * The commit that fixed a finding, while it reads as fixed: the commit evidence its fix recorded when it resolved the
 * comment (the latest transition into resolved), else commit evidence attached to the comment later. `null` when no
 * commit was recorded or the finding is not fixed.
 */
export function readReviewFindingFixCommitV1(
  comment: Pick<ReviewCommentV1, 'state' | 'transitions' | 'evidence'>,
  pendingDecision?: ReviewTriageStatus,
): string | null {
  if (!isReviewFindingFixedV1(comment.state, pendingDecision)) return null;
  const commitOf = (evidence: ReviewCommentV1['evidence']): string | null => {
    for (let index = (evidence?.length ?? 0) - 1; index >= 0; index -= 1) {
      const item = evidence![index]!;
      if (item.kind === 'commit') return item.sha;
    }
    return null;
  };
  let resolving: ReviewCommentV1['transitions'][number] | undefined;
  for (const transition of comment.transitions) if (transition.toState === 'resolved') resolving = transition;
  return commitOf(resolving?.evidence) ?? commitOf(comment.evidence);
}

/** Deferred and clarification decisions still require a person's attention. */
export const REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1 = ['defer', 'needs_refinement'] as const satisfies readonly ReviewTriageStatus[];

export const REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1 = ['resolved', 'dismissed'] as const satisfies readonly ReviewCommentStateV1[];

export function reviewTriageNeedsDecisionV1(status: ReviewTriageStatus | undefined, state?: ReviewCommentStateV1, redacted = false): boolean {
  return !redacted && !REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1.some(candidate => candidate === state)
    && (status === undefined || REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1.some(candidate => candidate === status));
}
