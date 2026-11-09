import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { DiffHorizontalScroll } from './DiffHorizontalScroll';
import { DiffLeadingContent } from './DiffLeadingContent';
import { useSetting } from '@/sync/store/settingsReadHooks';

import type { UnifiedDiffViewerProps } from '../diffViewerTypes';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { mapCodeReadingAnchors } from '@/components/ui/code/model/mapCodeReadingAnchor';
import { collapseUnifiedDiffContext } from './collapseUnifiedDiffContext';
import { UnifiedDiffFoldToggleRow } from './UnifiedDiffFoldToggleRow';
import { DiffFindOpenedFoldRow } from '../DiffFindOpenedFoldRow';
import { t } from '@/text';
import { composeDiffLineSlots } from '../hunks/composeDiffLineSlots';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

function applyReviewSeparators(lines: readonly CodeLine[], unifiedDiff: string): readonly CodeLine[] {
    const hunks = parseUnifiedDiffHunks(unifiedDiff);
    const hasRevisionContext = lines.some(candidate => candidate.hunkIndex === null && candidate.kind === 'context');
    return lines.map((line) => {
        if (line.kind !== 'header' || line.hunkIndex === null) return line;
        const hunk = hunks[line.hunkIndex];
        if (!hunk) return line;
        const previous = hunks[line.hunkIndex - 1];
        const hidden = hasRevisionContext ? 0 : Math.max(0, hunk.newStart - (previous ? previous.newStart + previous.newLines : 1));
        const text = hidden > 0
            ? [t('hunkReview.unchangedLines', { count: hidden }), hunk.sectionHeading].filter(Boolean).join('  ')
            : '';
        return { ...line, renderCodeText: text, renderIsSeparatorLine: true };
    });
}

export const HappierUnifiedDiffViewer = React.memo<UnifiedDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const foldingEnabled = useSetting('filesDiffFoldingEnabled') === true;
    const contextThreshold = useSetting('filesDiffFoldingContextThreshold') ?? 0;
    const contextRadius = useSetting('filesDiffFoldingContextRadius') ?? 0;
    const intraLineDiff = useIntraLineWordDiffConfig();
    const [refoldedFindLine, setRefoldedFindLine] = React.useState<string | null>(null);
    React.useEffect(() => { setRefoldedFindLine(null); }, [props.scrollToLineId, props.findActive, props.findRangesByLineId]);

    // With change rows drawn, a hunk's raw `@@` band becomes the quiet separator the rows sit under:
    // "N unchanged lines · section heading" (lab ade-shell RV2), blank when no lines are hidden.
    const reviewSeparators = props.lineInfoSeparators === true || (props.hunks !== undefined
        && Boolean(props.hunks.actions?.keep || props.hunks.actions?.discard || props.hunks.stateOf));
    const lines = React.useMemo(() => {
        const built = props.precomputedLines ?? buildCodeLinesFromUnifiedDiff({
            unifiedDiff: props.unifiedDiff,
            hideFilePrelude: true,
            intraLineDiff,
        });
        return reviewSeparators ? applyReviewSeparators(built, props.unifiedDiff) : built;
    }, [intraLineDiff, props.precomputedLines, props.unifiedDiff, reviewSeparators]);

    const [expansion, setExpansion] = React.useState(() => ({
        filePath: props.filePath,
        lines,
        indices: new Set<number>(),
    }));
    // Reconcile before committing children so refreshed context never flashes closed.
    if (expansion.filePath !== props.filePath || expansion.lines !== lines) {
        const indices = expansion.filePath === props.filePath && expansion.indices.size > 0
            ? new Set(mapCodeReadingAnchors(
                expansion.lines.map((line) => `${line.kind}:${line.renderCodeText}`),
                lines.map((line) => `${line.kind}:${line.renderCodeText}`),
                [...expansion.indices],
            ).filter((index): index is number => index !== null))
            : new Set<number>();
        setExpansion({ filePath: props.filePath, lines, indices });
    }

    const canFold = foldingEnabled;
    const expandedForComments = React.useMemo(() => {
        if (!canFold || !props.isCommentActive) return expansion.indices;
        const indices = new Set(expansion.indices);
        lines.forEach((line, index) => {
            if (props.isCommentActive?.(line)) indices.add(index);
        });
        return indices;
    }, [canFold, expansion.indices, lines, props.isCommentActive]);

    const folded = React.useMemo(() => {
        if (!canFold) return { lines, regions: [] as const };
        const expandedLineIndices = new Set(expandedForComments);
        if (props.findActive && props.scrollToLineId && refoldedFindLine !== props.scrollToLineId) {
            const currentIndex = lines.findIndex((line) => line.id === props.scrollToLineId);
            if (currentIndex >= 0) expandedLineIndices.add(currentIndex);
        }
        return collapseUnifiedDiffContext({
            lines,
            contextThreshold,
            contextRadius,
            expandedLineIndices,
        });
    }, [canFold, contextRadius, contextThreshold, expandedForComments, lines, props.findActive, props.scrollToLineId, refoldedFindLine]);

    const findOpenedRegion = React.useMemo(() => {
        if (!canFold || !props.findActive || !props.scrollToLineId || refoldedFindLine === props.scrollToLineId) return null;
        const ordinary = collapseUnifiedDiffContext({ lines, contextThreshold, contextRadius, expandedLineIndices: expandedForComments });
        const index = lines.findIndex((line) => line.id === props.scrollToLineId);
        return ordinary.regions.find((region) => index >= region.hiddenStartIndex && index < region.hiddenStartIndex + region.hiddenCount) ?? null;
    }, [canFold, props.findActive, props.scrollToLineId, refoldedFindLine, lines, contextThreshold, contextRadius, expandedForComments]);

    const foldRegionsByAfterLineId = React.useMemo(() => {
        const map = new Map<string, { hiddenStartIndex: number; hiddenCount: number }>();
        for (const region of folded.regions) {
            map.set(region.afterLineId, { hiddenStartIndex: region.hiddenStartIndex, hiddenCount: region.hiddenCount });
        }
        return map;
    }, [folded.regions]);

    const refold = React.useCallback(() => {
        if (!findOpenedRegion) return 'noRevealedFold' as const;
        setRefoldedFindLine(props.scrollToLineId ?? null);
        return 'refolded' as const;
    }, [findOpenedRegion, props.scrollToLineId]);
    React.useEffect(() => canFold ? props.registerFindRefold?.(refold) : undefined,
        [canFold, props.registerFindRefold, refold]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        if (findOpenedRegion?.afterLineId === line.id) return <DiffFindOpenedFoldRow hiddenCount={findOpenedRegion.hiddenCount} onFoldAgain={refold} />;
        const region = foldRegionsByAfterLineId.get(line.id) ?? null;
        if (!region) return null;
        return (
            <UnifiedDiffFoldToggleRow
                hiddenCount={region.hiddenCount}
                onPressExpand={() => {
                    setExpansion((prev) => {
                        const indices = new Set(prev.indices);
                        for (let index = region.hiddenStartIndex; index < region.hiddenStartIndex + region.hiddenCount; index += 1) {
                            indices.add(index);
                        }
                        return { ...prev, indices };
                    });
                }}
            />
        );
    }, [foldRegionsByAfterLineId, findOpenedRegion, refold]);
    const composedAfterLine = React.useMemo(() => canFold
        ? composeDiffLineSlots(props.renderAfterLine, renderAfterLine)
        : props.renderAfterLine, [canFold, props.renderAfterLine, renderAfterLine]);

    const view = (
        <View style={[props.virtualized ? styles.virtualizedBody : null, !wrapLines ? styles.fillScroll : null]}>
            <CodeLinesView
                lines={folded.lines}
                syntaxHighlightingLines={lines}
                selectedLineIds={props.selectedLineIds}
                interactionMode={props.interactionMode}
                rangeSelectionActive={props.rangeSelectionActive}
                onPressLine={props.onPressLine}
                onPressLineRange={props.onPressLineRange}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={composedAfterLine}
                renderLeadingLane={props.renderLeadingLane}
                listHeader={props.leadingContent ? <DiffLeadingContent>{props.leadingContent}</DiffLeadingContent> : undefined}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized}
                showLineNumbers={props.showLineNumbers}
                showPrefix={props.showPrefix}
                scrollToLineId={props.scrollToLineId}
                scrollToLineRequestId={props.scrollToLineRequestId}
                onScrollToLine={props.onScrollToLine}
                externalScrollView={props.externalScrollView}
                highlightLineId={props.highlightLineId}
                highlightLineIds={props.highlightLineIds}
                agentPresence={props.agentPresence}
                reviewedLineIds={props.reviewedLineIds}
                findRangesByLineId={props.findRangesByLineId}
                intelligence={props.intelligence}
                syntaxHighlighting={syntaxHighlighting}
                testID={props.testID}
                onLayout={props.onLayout}
                onContentSizeChange={props.onContentSizeChange}
                onScroll={props.onScroll}
                scrollEventThrottle={props.scrollEventThrottle}
            />
        </View>
    );

    if (wrapLines) return view;

    return (
        <DiffHorizontalScroll>{view}</DiffHorizontalScroll>
    );
});

const styles = StyleSheet.create({
    virtualizedBody: {
        flex: 1,
        minHeight: 0,
    },
    // Unwrapped rows span the visible width even when every line is shorter, as Pierre's do.
    fillScroll: {
        flexGrow: 1,
    },
});
