import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';

import type { ChangedFilesReviewLineTarget } from './ChangedFilesReviewNavigation';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ChangedFilesReviewDiffBlock, type ChangedFilesReviewDiffBlockProps } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';
import { useHunkReviewSource, type ChangedFilesReviewHunkReviewModels } from './changedFilesReviewHunkReviewSource';

const EMPTY_REVIEW_COMMENT_DRAFTS: readonly ReviewCommentDraft[] = [];
const EMPTY_REVIEW_COMMENT_DRAFTS_BY_FILE_PATH: ReadonlyMap<string, readonly ReviewCommentDraft[]> = new Map();

type DiffFileFacts = Pick<ChangedFilesReviewDiffBlockProps, 'isBinaryContent' | 'estimatedChangedLines' | 'onOpenFile' | 'imageCompare' | 'snapshotSignature'>;

export function useChangedFilesReviewDiffBlockRenderer(input: Readonly<{
    theme: any;
    sessionId: string;
    workspaceScope?: WorkspaceScopeBase | null;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onRetryDiff?: ChangedFilesReviewDiffBlockProps['onRetryDiff'];
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void | Promise<void>;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    lineTarget?: ChangedFilesReviewLineTarget | null;
    findModel?: ChangedFilesReviewFindModel;
    findActive?: boolean;
    /** Diffs drawn edge to edge under their file header (the comparison stream), not as inset cards. */
    flat?: boolean;
    evidenceOnly?: boolean;
    hunkNotes?: ChangedFilesReviewDiffBlockProps['hunkNotes'];
    /** Keep / Discard rows on every file's changes (one checkout, one discard owner). */
    hunkReview?: ChangedFilesReviewHunkReviewModels;
}>): (path: string, fileFacts: DiffFileFacts) => React.ReactNode {
    const {
        theme,
        sessionId,
        workspaceScope,
        diffStateSource,
        reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        onScrollToLine,
        externalScrollView,
        lineTarget,
    } = input;
    const flat = input.flat === true;
    const hunkReviewSource = useHunkReviewSource(input.hunkReview);

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

    return React.useCallback((path: string, fileFacts: DiffFileFacts) => {
        const fileReviewCommentDrafts = reviewCommentDraftsByDiffFilePath.get(path)
            ?? EMPTY_REVIEW_COMMENT_DRAFTS;
        const imageCompare = fileFacts.imageCompare ?? null;
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                snapshotSignature={fileFacts.snapshotSignature}
                workspaceScope={workspaceScope ?? null}
                filePath={path}
                isBinaryContent={fileFacts.isBinaryContent}
                estimatedChangedLines={fileFacts.estimatedChangedLines}
                diffStateSource={diffStateSource}
                onRetryDiff={input.onRetryDiff}
                reviewCommentsEnabled={reviewCommentsEnabled === true}
                reviewCommentDrafts={fileReviewCommentDrafts}
                onUpsertReviewCommentDraft={onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={onDeleteReviewCommentDraft}
                onReviewCommentError={onReviewCommentError}
                onScrollToLine={onScrollToLine}
                externalScrollView={externalScrollView}
                scrollToLineId={lineTarget?.filePath === path ? lineTarget.lineId : undefined}
                findModel={input.findModel}
                findActive={input.findActive}
                flat={flat}
                evidenceOnly={input.evidenceOnly}
                hunkNotes={input.hunkNotes}
                imageCompare={imageCompare}
                onOpenFile={fileFacts.onOpenFile}
                hunkReviewSource={hunkReviewSource}
            />
        );
    }, [
        diffStateSource,
        flat,
        input.evidenceOnly,
        input.hunkNotes,
        hunkReviewSource,
        input.findModel,
        input.findActive,
        input.onRetryDiff,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        onScrollToLine,
        externalScrollView,
        lineTarget,
        onUpsertReviewCommentDraft,
        reviewCommentDraftsByDiffFilePath,
        reviewCommentsEnabled,
        sessionId,
        theme,
        workspaceScope,
    ]);
}
