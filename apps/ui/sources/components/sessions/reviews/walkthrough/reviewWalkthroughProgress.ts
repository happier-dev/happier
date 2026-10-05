import type { ScmDiffSummaryOutputState } from '@happier-dev/protocol';

import type { WalkthroughReviewSummary } from './reviewWalkthroughOverlay';

export type ReviewWalkthroughStepState = 'waiting' | 'running' | 'done' | 'partial' | 'failed';

export type ReviewWalkthroughReviewStep = Readonly<
    | { state: 'running'; kind: 'reviewing' }
    | { state: 'running'; kind: 'engines_reviewing'; done: readonly string[]; running: readonly string[] }
    | { state: 'done'; kind: 'reviewed'; findings: number }
    | { state: 'done'; kind: 'engine_reviewed'; engine: string; findings: number }
    | { state: 'done'; kind: 'reviewed_at' | 'review_at'; at: string }
    | { state: 'partial'; kind: 'partial'; findings: number }
>;

export type ReviewWalkthroughNarrationStep = Readonly<
    | { state: 'waiting' | 'running'; kind: 'writing' | 'narrating' }
    | { state: 'waiting' | 'running'; kind: 'narrator_writing'; narrator: string }
    | { state: 'done'; kind: 'ready' }
    | { state: 'failed'; kind: 'failed' }
>;

export type ReviewWalkthroughProgress = Readonly<{
    review: ReviewWalkthroughReviewStep;
    /** Null for a findings-only review; the walkthrough step is named from the start otherwise. */
    narration: ReviewWalkthroughNarrationStep | null;
}>;

/**
 * One review operation as two named steps, Reviewing then Writing walkthrough (Walkthrough lab WT5-R5,
 * R9). Both steps are read from their owners: the review Runs' outcomes and the walkthrough output's
 * progress. A failed narration never reads as a failed review, and a partial review never reads as done.
 */
export function resolveReviewWalkthroughProgress(params: Readonly<{
    review: WalkthroughReviewSummary;
    narration: Readonly<{
        state: ScmDiffSummaryOutputState;
        mode: 'continued_review' | 'seeded_narrator' | null;
        narratorLabel: string | null;
        /** The one reviewer writes no prose, so a named narrator writes inside the same operation. */
        findingsOnlyReviewer?: boolean;
    }> | null;
    /** A walkthrough asked for after the review finished: the review's own time ("11:04"). */
    reviewedAt?: string | null;
}>): ReviewWalkthroughProgress {
    const { review, narration } = params;
    const reviewStep: ReviewWalkthroughReviewStep = review.state === 'running'
        ? (!narration && review.finishedEngineLabels.length > 0
            // A review on its own names who is done and who still reviews ("Claude done · Codex reviewing").
            ? { state: 'running', kind: 'engines_reviewing', done: review.finishedEngineLabels, running: review.runningEngineLabels }
            : { state: 'running', kind: 'reviewing' })
        : review.state === 'partial'
            ? { state: 'partial', kind: 'partial', findings: review.total }
            : params.reviewedAt
                ? { state: 'done', kind: narration?.mode === 'seeded_narrator' ? 'review_at' : 'reviewed_at', at: params.reviewedAt }
                : narration?.findingsOnlyReviewer && review.engineLabels.length === 1
                    ? { state: 'done', kind: 'engine_reviewed', engine: review.engineLabels[0]!, findings: review.total }
                    : { state: 'done', kind: 'reviewed', findings: review.total };
    if (!narration) return { review: reviewStep, narration: null };

    // Narration starts once the findings are in; until then its step waits, named.
    const waiting = review.state === 'running' || narration.state === 'pending';
    const activity = waiting ? 'waiting' as const : 'running' as const;
    let narrationStep: ReviewWalkthroughNarrationStep;
    if (narration.state === 'complete') narrationStep = { state: 'done', kind: 'ready' };
    else if (narration.state === 'failed' || narration.state === 'cancelled' || narration.state === 'partial') narrationStep = { state: 'failed', kind: 'failed' };
    else if (narration.mode === 'seeded_narrator') narrationStep = { state: activity, kind: 'narrating' };
    else if (narration.findingsOnlyReviewer && narration.narratorLabel) narrationStep = { state: activity, kind: 'narrator_writing', narrator: narration.narratorLabel };
    else narrationStep = { state: activity, kind: 'writing' };
    return { review: reviewStep, narration: narrationStep };
}
