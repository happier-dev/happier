import * as React from 'react';
import { View } from 'react-native';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useCodeLinesReviewComments } from '@/components/sessions/reviews/comments/useCodeLinesReviewComments';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { filterReviewCommentDraftsForFile } from '@/sync/domains/input/reviewComments/filterReviewCommentDrafts';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { useSetting } from '@/sync/domains/state/storage';

export type DiffReviewCommentsViewerProps = Readonly<{
    filePath: string;
    unifiedDiff: string;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
}>;

export function DiffReviewCommentsViewer(props: DiffReviewCommentsViewerProps) {
    const wrapLinesSetting = useSetting('wrapLinesInDiffs');
    const showLineNumbersSetting = useSetting('showLineNumbers');
    const effectiveWrapLines = props.wrapLines ?? (wrapLinesSetting !== false);
    const effectiveShowLineNumbers = props.showLineNumbers ?? (showLineNumbersSetting !== false);
    const effectiveShowPrefix = props.showPrefix ?? effectiveShowLineNumbers;

    const intraLineDiff = useIntraLineWordDiffConfig();

    const lines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({
        unifiedDiff: props.unifiedDiff,
        hideFilePrelude: true,
        intraLineDiff,
    }), [intraLineDiff, props.unifiedDiff]);
    const { lineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();

    const draftsForFile = React.useMemo(() => {
        return filterReviewCommentDraftsForFile({
            enabled: props.reviewCommentsEnabled === true,
            filePath: props.filePath,
            source: 'diff',
            drafts: props.reviewCommentDrafts,
        });
    }, [props.filePath, props.reviewCommentDrafts, props.reviewCommentsEnabled]);

    const controls = useCodeLinesReviewComments({
        enabled: props.reviewCommentsEnabled,
        filePath: props.filePath,
        source: 'diff',
        lines,
        drafts: draftsForFile,
        onUpsertDraft: props.onUpsertReviewCommentDraft,
        onDeleteDraft: props.onDeleteReviewCommentDraft,
        onError: props.onReviewCommentError,
    });

    const virtualized = props.reviewCommentsEnabled === true
        ? resolveInlineDiffVirtualization({
            unifiedDiff: props.unifiedDiff,
            oldText: null,
            newText: null,
            lineThreshold,
            byteThreshold,
        })
        : true;

    return (
        <View>
            <DiffViewer
                mode="unified"
                filePath={props.filePath}
                unifiedDiff={props.unifiedDiff}
                onPressAddComment={controls?.onPressAddComment}
                isCommentActive={controls?.isCommentActive}
                renderAfterLine={controls?.renderAfterLine}
                virtualized={virtualized}
                wrapLines={effectiveWrapLines}
                showLineNumbers={effectiveShowLineNumbers}
                showPrefix={effectiveShowPrefix}
            />
        </View>
    );
}
