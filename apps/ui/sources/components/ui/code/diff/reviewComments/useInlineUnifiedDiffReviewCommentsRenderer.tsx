import * as React from 'react';

import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { DiffReviewCommentsViewer } from './DiffReviewCommentsViewer';
import type { DiffFileFindState } from '../DiffFilesListView';

export type InlineUnifiedDiffReviewCommentsRenderer = (params: Readonly<{
    file: DiffFileEntry;
    virtualized: boolean;
    maxVirtualizedHeight: number;
    wrapLines: boolean;
    showLineNumbers: boolean;
    showPrefix: boolean;
    findState?: DiffFileFindState;
}>) => React.ReactNode;

export function useInlineUnifiedDiffReviewCommentsRenderer(params: Readonly<{
    enabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
}>): InlineUnifiedDiffReviewCommentsRenderer | undefined {
    return React.useMemo(() => {
        if (!params.enabled) return undefined;

        return ({ file, wrapLines, showLineNumbers, showPrefix, findState }) => {
            if (!file.filePath || typeof file.unifiedDiff !== 'string') return null;
            return (
                <DiffReviewCommentsViewer
                    findActive={findState?.findActive}
                    findRangesByLineId={findState?.findRangesByLineId}
                    scrollToLineId={findState?.scrollToLineId}
                    filePath={file.filePath}
                    unifiedDiff={file.unifiedDiff}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={params.reviewCommentDrafts}
                    onUpsertReviewCommentDraft={params.onUpsertReviewCommentDraft}
                    onDeleteReviewCommentDraft={params.onDeleteReviewCommentDraft}
                    onReviewCommentError={params.onReviewCommentError}
                    wrapLines={wrapLines}
                    showLineNumbers={showLineNumbers}
                    showPrefix={showPrefix}
                />
            );
        };
    }, [
        params.enabled,
        params.onDeleteReviewCommentDraft,
        params.onReviewCommentError,
        params.onUpsertReviewCommentDraft,
        params.reviewCommentDrafts,
    ]);
}
