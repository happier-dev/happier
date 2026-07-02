import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ChangedFilesReviewDiffBlock } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

const EMPTY_REVIEW_COMMENT_DRAFTS: readonly ReviewCommentDraft[] = [];
const EMPTY_REVIEW_COMMENT_DRAFTS_BY_FILE_PATH: ReadonlyMap<string, readonly ReviewCommentDraft[]> = new Map();

export function useChangedFilesReviewDiffBlockRenderer(input: Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
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
        workspaceScope,
        diffStateSource,
        reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        getEstimatedChangedLines,
    } = input;

    const reviewCommentDraftsByDiffFilePath = React.useMemo(() => {
        if (reviewCommentsEnabled !== true || !reviewCommentDrafts || reviewCommentDrafts.length === 0) {
            return EMPTY_REVIEW_COMMENT_DRAFTS_BY_FILE_PATH;
        }

        const draftsByFilePath = new Map<string, ReviewCommentDraft[]>();
        for (const draft of reviewCommentDrafts) {
            if (draft.source !== 'diff') continue;
            const fileDrafts = draftsByFilePath.get(draft.filePath);
            if (fileDrafts) {
                fileDrafts.push(draft);
                continue;
            }
            draftsByFilePath.set(draft.filePath, [draft]);
        }

        return draftsByFilePath.size > 0
            ? draftsByFilePath
            : EMPTY_REVIEW_COMMENT_DRAFTS_BY_FILE_PATH;
    }, [reviewCommentDrafts, reviewCommentsEnabled]);

    return React.useCallback((path: string) => {
        const estimated = getEstimatedChangedLines ? getEstimatedChangedLines(path) : null;
        const fileReviewCommentDrafts = reviewCommentDraftsByDiffFilePath.get(path)
            ?? EMPTY_REVIEW_COMMENT_DRAFTS;
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                snapshotSignature={snapshotSignature}
                workspaceScope={workspaceScope ?? null}
                filePath={path}
                estimatedChangedLines={estimated}
                diffStateSource={diffStateSource}
                reviewCommentsEnabled={reviewCommentsEnabled === true}
                reviewCommentDrafts={fileReviewCommentDrafts}
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
        reviewCommentDraftsByDiffFilePath,
        reviewCommentsEnabled,
        sessionId,
        snapshotSignature,
        theme,
        workspaceScope,
    ]);
}
