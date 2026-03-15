import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ChangedFilesReviewDiffBlock, type ReviewDiffState } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffBlock';

const EMPTY_REVIEW_COMMENT_DRAFTS: readonly ReviewCommentDraft[] = [];

export function useChangedFilesReviewDiffBlockRenderer(input: Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    getDiffState: (path: string) => ReviewDiffState;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
}>): (path: string) => React.ReactNode {
    const {
        theme,
        sessionId,
        snapshotSignature,
        getDiffState,
        reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
    } = input;

    return React.useCallback((path: string) => {
        const state: ReviewDiffState = getDiffState(path);
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                snapshotSignature={snapshotSignature}
                filePath={path}
                state={state}
                reviewCommentsEnabled={reviewCommentsEnabled === true}
                reviewCommentDrafts={reviewCommentDrafts ?? EMPTY_REVIEW_COMMENT_DRAFTS}
                onUpsertReviewCommentDraft={onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={onDeleteReviewCommentDraft}
                onReviewCommentError={onReviewCommentError}
            />
        );
    }, [
        getDiffState,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        onUpsertReviewCommentDraft,
        reviewCommentDrafts,
        reviewCommentsEnabled,
        sessionId,
        snapshotSignature,
        theme,
    ]);
}
