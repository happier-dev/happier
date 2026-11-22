import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

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
 * Review, or the final output when that output is the Review. Its pane then leaves the raw record out.
 */
export function workflowStepResultShownByRunReview(
  params: Readonly<{
    producedReviewId: string | null;
    finalOutputIsReview: boolean;
    finalOutputInvocationId: string | null | undefined;
    selectedInvocationId: string | null;
    selectedStartsReview: boolean;
  }>,
): boolean {
  if (params.producedReviewId === null || params.selectedInvocationId === null)
    return false;
  if (params.selectedStartsReview) return true;
  return (
    params.finalOutputIsReview &&
    params.selectedInvocationId === params.finalOutputInvocationId
  );
}
