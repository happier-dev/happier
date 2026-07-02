import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useCodeLinesReviewComments } from '@/components/ui/code/reviewComments/useCodeLinesReviewComments';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { filterReviewCommentDraftsForFile } from '@/sync/domains/input/reviewComments/filterReviewCommentDrafts';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { useSetting } from '@/sync/domains/state/storage';

const DISABLED_INTRA_LINE_WORD_DIFF = {
    enabled: false,
    maxLines: 0,
    maxLineLength: 0,
    maxPairs: 0,
} as const;

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

function areDraftArraysEquivalent(
    previous: readonly ReviewCommentDraft[],
    next: readonly ReviewCommentDraft[],
): boolean {
    if (previous === next) return true;
    return previous.length === 0 && next.length === 0;
}

function areDiffReviewCommentsViewerPropsEqual(
    previous: DiffReviewCommentsViewerProps,
    next: DiffReviewCommentsViewerProps,
): boolean {
    return previous.filePath === next.filePath
        && previous.unifiedDiff === next.unifiedDiff
        && previous.reviewCommentsEnabled === next.reviewCommentsEnabled
        && areDraftArraysEquivalent(previous.reviewCommentDrafts, next.reviewCommentDrafts)
        && previous.onUpsertReviewCommentDraft === next.onUpsertReviewCommentDraft
        && previous.onDeleteReviewCommentDraft === next.onDeleteReviewCommentDraft
        && previous.onReviewCommentError === next.onReviewCommentError
        && previous.wrapLines === next.wrapLines
        && previous.showLineNumbers === next.showLineNumbers
        && previous.showPrefix === next.showPrefix;
}

function DiffReviewCommentsViewerInner(props: DiffReviewCommentsViewerProps) {
    const { height: windowHeight } = useWindowDimensions();
    const wrapLinesSetting = useSetting('wrapLinesInDiffs');
    const showLineNumbersSetting = useSetting('showLineNumbers');
    const effectiveWrapLines = props.wrapLines ?? (wrapLinesSetting !== false);
    const effectiveShowLineNumbers = props.showLineNumbers ?? (showLineNumbersSetting !== false);
    const effectiveShowPrefix = props.showPrefix ?? effectiveShowLineNumbers;

    const intraLineDiff = useIntraLineWordDiffConfig();
    const { lineThreshold, reviewCommentsLineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();
    const reviewLineThreshold = typeof reviewCommentsLineThreshold === 'number'
        ? reviewCommentsLineThreshold
        : lineThreshold;
    const effectiveLineThreshold = lineThreshold > 0
        ? Math.min(lineThreshold, reviewLineThreshold)
        : lineThreshold;
    const virtualized = props.reviewCommentsEnabled === true
        ? resolveInlineDiffVirtualization({
            unifiedDiff: props.unifiedDiff,
            oldText: null,
            newText: null,
            lineThreshold: effectiveLineThreshold,
            byteThreshold,
        })
        : true;
    const lineModelIntraLineDiff = virtualized ? DISABLED_INTRA_LINE_WORD_DIFF : intraLineDiff;

    const lines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({
        unifiedDiff: props.unifiedDiff,
        hideFilePrelude: true,
        intraLineDiff: lineModelIntraLineDiff,
    }), [lineModelIntraLineDiff, props.unifiedDiff]);

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
    const showInactiveCommentAffordance = Platform.OS === 'web';

    return (
        <View style={virtualized ? resolveInlineDiffVirtualizedViewportStyle(resolveInlineDiffVirtualizedMaxHeight(windowHeight)) : undefined}>
            <DiffViewer
                mode="unified"
                filePath={props.filePath}
                unifiedDiff={props.unifiedDiff}
                precomputedLines={lines}
                onPressLine={controls?.onPressAddComment}
                onPressLineRange={controls?.onPressAddCommentRange}
                pressLineWhenNotSelectable={Boolean(controls?.onPressAddComment)}
                onPressAddComment={controls?.onPressAddComment}
                isCommentActive={controls?.isCommentActive}
                renderAfterLine={controls?.renderAfterLine}
                showInactiveCommentAffordance={showInactiveCommentAffordance}
                virtualized={virtualized}
                wrapLines={effectiveWrapLines}
                showLineNumbers={effectiveShowLineNumbers}
                showPrefix={effectiveShowPrefix}
            />
        </View>
    );
}

export const DiffReviewCommentsViewer = React.memo(
    DiffReviewCommentsViewerInner,
    areDiffReviewCommentsViewerPropsEqual,
);
