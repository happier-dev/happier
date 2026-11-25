import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { reviewRoundReviewerStateLabel, type ReviewRoundReviewer } from '@/components/reviews/reviewRoundReviewers';
import { describeWorkflowInvocationLifecycle, type WorkflowLifecyclePresentation } from '../presentation/workflowLifecyclePresentation';

export type WorkflowReviewerStatus = Pick<WorkflowLifecyclePresentation, 'label' | 'variant' | 'marker'>;

/** Review settlement owns coverage; successful invocation mechanics do not imply a finished reviewer. */
export function projectWorkflowReviewerStatuses(reviewers: readonly ReviewRoundReviewer[] | undefined): ReadonlyMap<string, WorkflowReviewerStatus> {
  return new Map((reviewers ?? []).flatMap(reviewer => {
    if (reviewer.outcome === null || reviewer.outcome === 'running') return [];
    const presentation = reviewer.outcome === 'failed' || reviewer.outcome === 'partial'
      ? { variant: 'warning', marker: { kind: 'icon', icon: 'warning-circle' } } as const
      : describeWorkflowInvocationLifecycle(reviewer.outcome);
    return [[reviewer.reviewerId, {
      // Unknown outcomes were excluded above, so the shared presenter always supplies a label.
      label: reviewRoundReviewerStateLabel(reviewer)!,
      variant: presentation.variant,
      marker: presentation.marker,
    } satisfies WorkflowReviewerStatus] as const];
  }));
}

/**
 * Whether a Run's final output is the Review that Run produced: the output value names that Review (a Hunt's final
 * output is its `review.start` result). The Run → Review link itself is the Review owner's `workflowRunId`; this
 * only tells "the result is that Review" apart from a later step's own result.
 */
export function workflowResultNamesReview(
  value: JsonValue | undefined,
  reviewId: string,
): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value === reviewId;
  if (Array.isArray(value))
    return value.some((entry) => workflowResultNamesReview(entry, reviewId));
  if (typeof value === 'object')
    return Object.values(value).some((entry) =>
      workflowResultNamesReview(entry, reviewId),
    );
  return false;
}

/**
 * A step whose result the Run page's embedded Review already shows (lab `hunts-running`): a step that starts the
 * Review, a step whose result names that Review, or the final output when that output is the Review. Its pane then leaves the raw record out.
 */
export function workflowStepResultShownByRunReview(
  params: Readonly<{
    producedReviewId: string | null;
    finalOutputIsReview: boolean;
    finalOutputInvocationId: string | null | undefined;
    selectedInvocationId: string | null;
    selectedStartsReview: boolean;
    /** The selected step's own result: a step whose result names the Review (it produced it) is shown by it. */
    selectedResult?: JsonValue | undefined;
  }>,
): boolean {
  if (params.producedReviewId === null || params.selectedInvocationId === null)
    return false;
  if (params.selectedStartsReview
    || workflowResultNamesReview(params.selectedResult, params.producedReviewId)) return true;
  return (
    params.finalOutputIsReview &&
    params.selectedInvocationId === params.finalOutputInvocationId
  );
}

/**
 * Whether the Review a Run produced is that Run's answer: its final output names it, or the Run declares no final
 * output of its own (a PR preparation that ends by starting the Review). A declared output that is something else
 * stays the Run's result (U8 R6 R4b).
 */
export function workflowRunReviewIsResult(params: Readonly<{
  reviewId: string;
  finalOutputInvocationId: string | null | undefined;
  result: JsonValue | undefined;
}>): boolean {
  return params.finalOutputInvocationId == null || workflowResultNamesReview(params.result, params.reviewId);
}
