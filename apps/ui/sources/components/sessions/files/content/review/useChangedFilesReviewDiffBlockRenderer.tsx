import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ChangedFilesReviewDiffBlock } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffBlock';
import type { ChangedFilesReviewDiffStateSource } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffStore';

const EMPTY_REVIEW_COMMENT_DRAFTS: readonly ReviewCommentDraft[] = [];

export function useChangedFilesReviewDiffBlockRenderer(input: Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    getEstimatedChangedLines?: (path: string) => number | null;
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
        diffStateSource,
        reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        getEstimatedChangedLines,
    } = input;

    return React.useCallback((path: string) => {
        const estimated = getEstimatedChangedLines ? getEstimatedChangedLines(path) : null;
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                snapshotSignature={snapshotSignature}
                filePath={path}
                estimatedChangedLines={estimated}
                diffStateSource={diffStateSource}
                reviewCommentsEnabled={reviewCommentsEnabled === true}
                reviewCommentDrafts={reviewCommentDrafts ?? EMPTY_REVIEW_COMMENT_DRAFTS}
                onUpsertReviewCommentDraft={onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={onDeleteReviewCommentDraft}
                onReviewCommentError={onReviewCommentError}
            />
        );
    }, [
        diffStateSource,
        getEstimatedChangedLines,
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
