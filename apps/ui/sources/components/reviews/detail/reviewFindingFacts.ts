import type { ReviewFindingRoundStatusV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import type { ReviewFindingScopeAttribution } from '@happier-dev/protocol/reviews/reviewFindingClassification';
import type { ReviewWorkflowHistoryResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';

import { t } from '@/text';

/**
 * A finding's standing in the opened round and where it came from, as the row's meta words (lab
 * `detail-round2`): New in round N, Still there, Not found in round N, and Was there before these
 * changes. The facts are the round owner's and the captured-scope owner's; unknown stays unsaid.
 */
export function reviewFindingFacts(input: Readonly<{
    appearance: ReviewFindingRoundStatusV1 | null | undefined;
    scopeAttribution: ReviewFindingScopeAttribution | undefined;
    roundOrdinal: number;
}>): string[] {
    const facts: string[] = [];
    if (input.appearance === 'new' && input.roundOrdinal > 1) facts.push(t('reviewWalkthrough.detail.newInRound', { round: input.roundOrdinal }));
    if (input.appearance === 'still_there') facts.push(t('reviewWalkthrough.detail.stillThere'));
    if (input.appearance === 'looks_addressed') facts.push(t('reviewWalkthrough.detail.notFoundInRound', { round: input.roundOrdinal }));
    if (input.scopeAttribution === 'pre_existing') facts.push(t('reviewWalkthrough.detail.preExisting'));
    return facts;
}

type ReviewHistoryItem = ReviewWorkflowHistoryResponseV1['items'][number];

/** One Hunt finding across runs, from the history owner's counts only (lab `hunts-running`: "also in 4 earlier runs"). */
export function reviewHistoryFacts(item: Pick<ReviewHistoryItem,
    'priorRunCount' | 'openReviewCount' | 'newSincePrevious' | 'inCurrentReview' | 'inPreviousReview'>): string[] {
    const facts: string[] = [];
    if (item.newSincePrevious === true) facts.push(t('reviewWalkthrough.detail.historyNewSincePrevious'));
    if (item.priorRunCount > 0) facts.push(t('reviewWalkthrough.detail.historyEarlierRuns', { count: item.priorRunCount }));
    if (item.openReviewCount > 0) facts.push(t('reviewWalkthrough.detail.historyOpenElsewhere', { count: item.openReviewCount }));
    if (item.inPreviousReview && !item.inCurrentReview) facts.push(t('reviewWalkthrough.detail.historyNotFoundThisTime'));
    return facts;
}
