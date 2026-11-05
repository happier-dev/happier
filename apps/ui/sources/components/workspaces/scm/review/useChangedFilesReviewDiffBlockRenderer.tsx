import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';

import type { ChangedFilesReviewLineTarget } from './ChangedFilesReviewNavigation';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ChangedFilesReviewDiffBlock, type ChangedFilesReviewDiffBlockProps } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';

const EMPTY_REVIEW_COMMENT_DRAFTS: readonly ReviewCommentDraft[] = [];
const EMPTY_REVIEW_COMMENT_DRAFTS_BY_FILE_PATH: ReadonlyMap<string, readonly ReviewCommentDraft[]> = new Map();

type DiffFileFacts = Pick<ChangedFilesReviewDiffBlockProps, 'isBinaryContent' | 'estimatedChangedLines' | 'onOpenFile'>;

export function useChangedFilesReviewDiffBlockRenderer(input: Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
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
    /** Before/after facts per changed image path, from the Review's comparison entries. */
    getImageCompare?: (path: string) => ChangedFilesReviewDiffBlockProps['imageCompare'];
    /** Keep / Discard rows on every file's changes (one checkout, one discard owner). */
    getHunkReview?: (path: string) => Readonly<{ hunks: NonNullable<ChangedFilesReviewDiffBlockProps['hunkReview']>;
        reviewUnits: ChangedFilesReviewDiffBlockProps['reviewUnits'] }>;
}>): (path: string, fileFacts: DiffFileFacts) => React.ReactNode {
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
        onScrollToLine,
        externalScrollView,
        lineTarget,
    } = input;
    const flat = input.flat === true;

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
        const review = input.getHunkReview?.(path);
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                snapshotSignature={snapshotSignature}
                workspaceScope={workspaceScope ?? null}
                filePath={path}
                isBinaryContent={fileFacts.isBinaryContent}
                estimatedChangedLines={fileFacts.estimatedChangedLines}
                diffStateSource={diffStateSource}
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
                imageCompare={input.getImageCompare?.(path) ?? null}
                onOpenFile={fileFacts.onOpenFile}
                hunkReview={review?.hunks ?? null}
                reviewUnits={review?.reviewUnits}
            />
        );
    }, [
        diffStateSource,
        flat,
        input.evidenceOnly,
        input.hunkNotes,
        input.getHunkReview,
        input.getImageCompare,
        input.findModel,
        input.findActive,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        onScrollToLine,
        externalScrollView,
        lineTarget,
        onUpsertReviewCommentDraft,
        reviewCommentDraftsByDiffFilePath,
        reviewCommentsEnabled,
        sessionId,
        snapshotSignature,
        theme,
        workspaceScope,
    ]);
}
