import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useCodeLinesReviewComments } from '@/components/ui/code/reviewComments/useCodeLinesReviewComments';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { useSavedReviewCommentLines } from '@/components/ui/code/reviewComments/savedReviewComments';
import { filterReviewCommentDraftsForFile } from '@/sync/domains/input/reviewComments/filterReviewCommentDrafts';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { useInlineDiffViewportStyle } from '@/components/ui/code/diff/useInlineDiffViewportStyle';
import { useSetting } from '@/sync/store/settingsReadHooks';
import type { UnifiedDiffViewerProps } from '../diffViewerTypes';

const DISABLED_INTRA_LINE_WORD_DIFF = {
    enabled: false,
    maxLines: 0,
    maxLineLength: 0,
    maxPairs: 0,
} as const;

export type DiffReviewCommentsViewerProps = Pick<UnifiedDiffViewerProps, 'findActive' | 'findRangesByLineId' | 'registerFindRefold' | 'precomputedLines' | 'contextBaseText' | 'hunks' | 'reviewUnits'
    | 'renderLeadingLane' | 'highlightLineIds'> & Readonly<{
    filePath: string;
    previousFilePath?: string;
    unifiedDiff: string;
    scrollToLineId?: string;
    highlightLineId?: string;
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    reviewComments?: readonly ReviewCommentV1[];
    reviewCommentSource?: ReviewCommentSource;
    virtualized?: boolean;
    serverId?: string;
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void | Promise<void>;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
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
    return previous.scrollToLineId === next.scrollToLineId
        && previous.findActive === next.findActive
        && previous.findRangesByLineId === next.findRangesByLineId
        && previous.precomputedLines === next.precomputedLines
        && previous.contextBaseText === next.contextBaseText
        && previous.registerFindRefold === next.registerFindRefold
        && previous.hunks === next.hunks
        && previous.reviewUnits === next.reviewUnits
        && previous.highlightLineId === next.highlightLineId
        && previous.highlightLineIds === next.highlightLineIds
        && previous.renderLeadingLane === next.renderLeadingLane
        && previous.onScrollToLine === next.onScrollToLine
        && previous.externalScrollView === next.externalScrollView
        && previous.renderAfterLine === next.renderAfterLine
        && previous.filePath === next.filePath
        && previous.previousFilePath === next.previousFilePath
        && previous.unifiedDiff === next.unifiedDiff
        && previous.reviewCommentsEnabled === next.reviewCommentsEnabled
        && areDraftArraysEquivalent(previous.reviewCommentDrafts, next.reviewCommentDrafts)
        && previous.reviewComments === next.reviewComments
        && previous.reviewCommentSource === next.reviewCommentSource
        && previous.virtualized === next.virtualized
        && previous.serverId === next.serverId
        && previous.onUpsertReviewCommentDraft === next.onUpsertReviewCommentDraft
        && previous.onDeleteReviewCommentDraft === next.onDeleteReviewCommentDraft
        && previous.onReviewCommentError === next.onReviewCommentError
        && previous.wrapLines === next.wrapLines
        && previous.showLineNumbers === next.showLineNumbers
        && previous.showPrefix === next.showPrefix;
}

function DiffReviewCommentsViewerInner(props: DiffReviewCommentsViewerProps) {
    const reviewCommentSource = props.reviewCommentSource ?? 'diff';
    const { height: windowHeight } = usePresentationWindowDimensions();
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
    const virtualized = props.virtualized ?? (props.reviewCommentsEnabled === true
        ? resolveInlineDiffVirtualization({
            unifiedDiff: props.unifiedDiff,
            oldText: null,
            newText: null,
            lineThreshold: effectiveLineThreshold,
            byteThreshold,
        })
        : true);
    const viewport = useInlineDiffViewportStyle(virtualized, resolveInlineDiffVirtualizedMaxHeight(windowHeight));
    const lineModelIntraLineDiff = virtualized ? DISABLED_INTRA_LINE_WORD_DIFF : intraLineDiff;

    const lines = React.useMemo(() => props.precomputedLines ?? buildCodeLinesFromUnifiedDiff({
        unifiedDiff: props.unifiedDiff,
        hideFilePrelude: true,
        intraLineDiff: lineModelIntraLineDiff,
    }), [lineModelIntraLineDiff, props.unifiedDiff, props.precomputedLines]);

    const draftsForFile = React.useMemo(() => {
        return filterReviewCommentDraftsForFile({
            enabled: props.reviewCommentsEnabled === true,
            filePath: props.filePath,
            source: reviewCommentSource,
            drafts: props.reviewCommentDrafts,
        });
    }, [props.filePath, props.reviewCommentDrafts, props.reviewCommentsEnabled, reviewCommentSource]);

    const controls = useCodeLinesReviewComments({
        enabled: props.reviewCommentsEnabled,
        filePath: props.filePath,
        source: reviewCommentSource,
        lines,
        drafts: draftsForFile,
        onUpsertDraft: props.onUpsertReviewCommentDraft,
        onDeleteDraft: props.onDeleteReviewCommentDraft,
        onError: props.onReviewCommentError,
    });
    const showInactiveCommentAffordance = Platform.OS === 'web';
    const renderSavedComments = useSavedReviewCommentLines({ comments: props.reviewComments,
        filePath: props.filePath, previousFilePath: props.previousFilePath, source: reviewCommentSource, lines, serverId: props.serverId });
    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const notes = props.renderAfterLine?.(line);
        const comments = controls?.renderAfterLine?.(line);
        const saved = renderSavedComments?.(line);
        return notes || comments || saved ? <>{notes}{saved}{comments}</> : null;
    }, [controls?.renderAfterLine, props.renderAfterLine, renderSavedComments]);

    return (
        <View style={viewport ?? undefined}>
            <DiffViewer
                hunks={props.hunks}
                reviewUnits={props.reviewUnits}
                findActive={props.findActive}
                contextBaseText={props.contextBaseText}
                registerFindRefold={props.registerFindRefold}
                findRangesByLineId={props.findRangesByLineId}
                scrollToLineId={props.scrollToLineId}
                highlightLineId={props.highlightLineId}
                highlightLineIds={props.highlightLineIds}
                renderLeadingLane={props.renderLeadingLane}
                onScrollToLine={props.onScrollToLine}
                externalScrollView={props.externalScrollView}
                mode="unified"
                filePath={props.filePath}
                unifiedDiff={props.unifiedDiff}
                precomputedLines={lines}
                interactionMode={props.reviewCommentsEnabled ? 'comment' : 'read'}
                onPressLine={controls?.onPressAddComment}
                onPressLineRange={controls?.onPressAddCommentRange}
                pressLineWhenNotSelectable={Boolean(controls?.onPressAddComment)}
                onPressAddComment={controls?.onPressAddComment}
                isCommentActive={controls?.isCommentActive}
                renderAfterLine={props.renderAfterLine || renderSavedComments ? renderAfterLine : controls?.renderAfterLine}
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
