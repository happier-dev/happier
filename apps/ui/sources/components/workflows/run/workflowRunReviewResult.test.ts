import { describe, expect, it } from 'vitest';

import {
  workflowResultNamesReview,
  workflowRunReviewIsResult,
  workflowStepResultShownByRunReview,
} from './workflowRunReviewResult';

describe('workflowResultNamesReview', () => {
  it('reads a final output that carries the produced Review as that Review', () => {
    // A Hunt's final output is its review.start result, which names the Review it settled.
    expect(
      workflowResultNamesReview(
        { review: { reviewRound: { reviewId: 'review-1', roundOrdinal: 1 } } },
        'review-1',
      ),
    ).toBe(true);
    expect(
      workflowResultNamesReview([{ reviewId: 'review-1' }], 'review-1'),
    ).toBe(true);
  });

  it('keeps any other final output as the result it is', () => {
    expect(
      workflowResultNamesReview({ summary: 'Fixed both findings' }, 'review-1'),
    ).toBe(false);
    expect(
      workflowResultNamesReview(
        { reviewRound: { reviewId: 'another-review' } },
        'review-1',
      ),
    ).toBe(false);
    expect(workflowResultNamesReview(undefined, 'review-1')).toBe(false);
  });
});

describe('workflowStepResultShownByRunReview', () => {
  const base = {
    producedReviewId: 'review-1',
    finalOutputIsReview: true,
    finalOutputInvocationId: 'final',
    selectedInvocationId: 'final',
    selectedStartsReview: false,
  } as const;

  it('leaves out the raw record of a step whose result the embedded Review already shows', () => {
    expect(workflowStepResultShownByRunReview(base)).toBe(true);
    expect(
      workflowStepResultShownByRunReview({
        ...base,
        selectedInvocationId: 'reviewer',
        selectedStartsReview: true,
      }),
    ).toBe(true);
  });

  it('keeps the result pane where no Review of this Run shows it', () => {
    // Another round of an existing Review: the run has no Review of its own to embed.
    expect(
      workflowStepResultShownByRunReview({ ...base, producedReviewId: null }),
    ).toBe(false);
    expect(
      workflowStepResultShownByRunReview({
        ...base,
        finalOutputIsReview: false,
      }),
    ).toBe(false);
    expect(
      workflowStepResultShownByRunReview({
        ...base,
        selectedInvocationId: 'other',
      }),
    ).toBe(false);
  });
});

describe('workflowRunReviewIsResult (U8 R6 R4b)', () => {
  it('reads the produced Review as the Run\'s answer when the Run declares no other result', () => {
    expect(workflowRunReviewIsResult({ reviewId: 'review-1', finalOutputInvocationId: null, result: undefined })).toBe(true);
    expect(workflowRunReviewIsResult({ reviewId: 'review-1', finalOutputInvocationId: 'final',
      result: { review: { reviewId: 'review-1' } } })).toBe(true);
  });

  it('keeps a declared final output that is something else as the Run\'s result', () => {
    expect(workflowRunReviewIsResult({ reviewId: 'review-1', finalOutputInvocationId: 'final',
      result: { summary: 'Opened #4' } })).toBe(false);
  });
});

describe('workflowStepResultShownByRunReview for the producing step (U8 R6 R4b)', () => {
  it('leaves out the raw record of a step whose result names the embedded Review', () => {
    expect(workflowStepResultShownByRunReview({ producedReviewId: 'review-1', finalOutputIsReview: true,
      finalOutputInvocationId: null, selectedInvocationId: 'step-3', selectedStartsReview: false,
      selectedResult: { status: 'accepted', review: { reviewId: 'review-1', roundOrdinal: 1 } } })).toBe(true);
    expect(workflowStepResultShownByRunReview({ producedReviewId: 'review-1', finalOutputIsReview: true,
      finalOutputInvocationId: null, selectedInvocationId: 'step-2', selectedStartsReview: false,
      selectedResult: { workspace: '/tmp/pr' } })).toBe(false);
  });
});
