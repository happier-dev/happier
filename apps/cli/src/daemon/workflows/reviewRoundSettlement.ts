import { collectReviewRoundOutcomes } from '@happier-dev/protocol/actions/executor/review/settlement';
import { ReviewRoundBindingV1Schema, type ReviewRoundBindingV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewReviewerOutcomeV1 } from '@happier-dev/protocol/reviews/reviewPublicationEvidence';
import { ReviewPreparedRoundV1Schema, ReviewSessionInputV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { WorkflowCoordinatorInvocation } from './coordinator';

/** Recover the same round receipts the authored settle Action consumes, plus
 * typed leaf failures that prevented that Action from being reached. */
export function collectWorkflowReviewRoundOutcomes(
  reviewRound: ReviewRoundBindingV1,
  invocations: readonly WorkflowCoordinatorInvocation[],
): ReviewReviewerOutcomeV1[] {
  const outcomes = collectReviewRoundOutcomes({ reviewRound, reviewerResults: invocations.map(invocation =>
    invocation.result ?? (invocation.execution?.kind === 'action' ? invocation.execution.output : undefined)) });
  const preparedSchema = createStoredReadSchema(ReviewPreparedRoundV1Schema);
  for (const invocation of invocations) {
    const action = invocation.execution?.kind === 'action' && invocation.execution.actionId === 'review.start'
      ? readRecord(invocation.execution.input) : undefined;
    const values = invocation.input?.input ?? [];
    const prepared = values.map(value => preparedSchema.safeParse(value)).find(result => result.success);
    const selection = values.map(value => ReviewSessionInputV1Schema.safeParse(value)).find(result => result.success);
    const binding = action ? ReviewRoundBindingV1Schema.safeParse(action.reviewRound) : undefined;
    const ownRound = binding?.success ? binding.data : prepared?.success ? prepared.data.reviewRound : undefined;
    const key = action && typeof action.reviewReviewerId === 'string' ? action.reviewReviewerId
      : selection?.success ? selection.data.reviewerId : undefined;
    if (!key || ownRound?.reviewId !== reviewRound.reviewId || ownRound.roundOrdinal !== reviewRound.roundOrdinal
      || outcomes.some(outcome => outcome.key === key)) continue;
    if (invocation.lifecycle !== 'failed' && invocation.lifecycle !== 'cancelled'
      && invocation.lifecycle !== 'needs_attention' && invocation.lifecycle !== 'outcome_uncertain') continue;
    outcomes.push({ key, outcome: invocation.lifecycle === 'cancelled' ? 'cancelled' : 'failed',
      ...(invocation.execution?.kind === 'detached_run' ? { runId: invocation.execution.runId } : {}),
      ...(invocation.reason ? { errorCode: invocation.reason } : {}),
      ...(invocation.runtimeIssueV1 ? { runtimeIssueV1: invocation.runtimeIssueV1 } : {}),
    });
  }
  return outcomes;
}
