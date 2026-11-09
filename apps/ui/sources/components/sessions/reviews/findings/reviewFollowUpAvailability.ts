import type { ExecutionRunStructuredRunRef} from '@happier-dev/protocol/messages/structured/executionRunStructuredRunRef';
import type { ReviewFollowUpFailureCode } from '@happier-dev/protocol/execution/runs/index';

import { t } from '@/text';

export type ReviewFollowUpAvailability =
    | Readonly<{ available: true }>
    | Readonly<{ available: false; reason: string }>;

/**
 * Advisory projection of the result's runRef retention. It cannot prove current lifecycle or
 * retained-session availability; runtime admission decides those and its refusal is shown below.
 */
export function resolveReviewFollowUpAvailability(runRef: ExecutionRunStructuredRunRef): ReviewFollowUpAvailability {
    if (runRef.retentionPolicy === 'resumable') return { available: true };
    return { available: false, reason: t('runPage.review.followUpUnavailable.notResumable') };
}

/** The words for a refused `review.follow_up`, by the runtime's typed reason. */
export function describeReviewFollowUpFailure(errorCode: ReviewFollowUpFailureCode | undefined): string {
    switch (errorCode) {
        case 'review_follow_up_not_resumable':
        case 'execution_run_action_not_supported':
            return t('runPage.review.followUpUnavailable.notResumable');
        case 'review_follow_up_ended':
            return t('runPage.review.followUpUnavailable.ended');
        case 'review_follow_up_resume_unavailable':
            return t('runPage.review.followUpUnavailable.resumeUnavailable');
        case 'execution_run_busy':
            return t('runPage.review.followUpUnavailable.busy');
        default:
            return t('runPage.review.followUpUnavailable.failed');
    }
}
