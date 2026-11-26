import * as React from 'react';
import type { ReviewCommentCreateResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { createReviewCommentsActions } from '@/sync/domains/reviews/comments/actions';
import { submitDurableReviewCommentDraft } from '@/sync/domains/reviews/comments/promoteDraft';
import { recordReviewCommentWrites } from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Review readers submit their gutter through the same durable comment Action and store. */
export function useReviewCommentDraftWriter(scope: ServerAccountScope, reviewId: string, roundOrdinal: number) {
    const { executeValue } = useMountedActionExecution(scope);
    const actions = React.useMemo(() => createReviewCommentsActions({ execute: executeValue }), [executeValue]);
    return React.useCallback(async (draft: ReviewCommentDraft) => {
        const result = await submitDurableReviewCommentDraft({ reviewId, roundOrdinal, draft, clientMutationId: draft.id,
            actions: { create: async input => await actions.create(input) as ReviewCommentCreateResponseV1 } });
        recordReviewCommentWrites([result.comment], scope);
    }, [actions, reviewId, roundOrdinal, scope]);
}
