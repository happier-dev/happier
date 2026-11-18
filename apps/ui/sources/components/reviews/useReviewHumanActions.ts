import * as React from 'react';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import type {
    ReviewHumanStateV1,
    ReviewRequestedReviewerInputV1,
    ReviewVerdictKindV1,
} from '@happier-dev/protocol/reviews/reviewHumanV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Shared Review host controls use the opened round and the viewer's mounted Account binding. */
export function useReviewHumanActions(scope: ServerAccountScope | null, human: ReviewHumanStateV1 | null) {
    const { execute, ready, approval } = useMountedActionExecution(human === null ? null : scope);
    const reviewId = human?.reviewId;
    const roundOrdinal = human?.roundOrdinal;
    const binding = React.useMemo(() => reviewId === undefined || roundOrdinal === undefined ? null
        : { reviewId, roundOrdinal }, [reviewId, roundOrdinal]);
    const actions = React.useMemo(() => binding === null ? null : {
        setReviewers: (reviewers: readonly ReviewRequestedReviewerInputV1[]) =>
            execute(REVIEW_HUMAN_ACTION_IDS_V1.setReviewers, { ...binding, reviewers }),
        submitVerdict: (verdict: ReviewVerdictKindV1, body?: string) =>
            execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict, { ...binding, verdict, ...(body === undefined ? {} : { body }) }),
    }, [binding, execute]);

    return { ready, approval, setReviewers: actions?.setReviewers, submitVerdict: actions?.submitVerdict };
}
