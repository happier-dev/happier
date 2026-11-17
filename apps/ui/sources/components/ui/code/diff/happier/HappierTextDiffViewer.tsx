import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { DiffHorizontalScroll } from './DiffHorizontalScroll';
import { DiffLeadingContent } from './DiffLeadingContent';
import type { TextDiffViewerProps } from '../diffViewerTypes';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { t } from '@/text';

/**
 * A text comparison's hunk headers read as Pierre's line-info band ("N unchanged lines"), never raw `@@`
 * positions: two texts (an edit's old → new snippet) have no file positions worth reading, and this
 * renderer stands in for Pierre while it loads. A first hunk with nothing above it draws no band unless a
 * change row anchors on it (`keepAnchors`).
 */
function applyTextHunkSeparators(lines: readonly CodeLine[], keepAnchors: boolean): readonly CodeLine[] {
    const out: CodeLine[] = [];
    let previousOld = 0;
    let previousNew = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.kind !== 'header') {
            if (line.oldLine !== null) previousOld = line.oldLine;
            if (line.newLine !== null) previousNew = line.newLine;
            out.push(line);
            continue;
        }
        const first = lines.slice(index + 1).find(next => next.kind !== 'header' && (next.oldLine !== null || next.newLine !== null));
        const hidden = first?.oldLine != null ? first.oldLine - previousOld - 1
            : first?.newLine != null ? first.newLine - previousNew - 1 : 0;
        if (hidden <= 0 && !keepAnchors) continue;
        out.push({ ...line, renderCodeText: hidden > 0 ? t('hunkReview.unchangedLines', { count: hidden }) : '', renderIsSeparatorLine: true });
    }
    return out;
}

export const HappierTextDiffViewer = React.memo<TextDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const contextLines = props.contextLines ?? 3;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const keepAnchors = props.hunks !== undefined;
    const lines = React.useMemo(() => applyTextHunkSeparators(buildCodeLinesFromTextDiff({
        oldText: props.oldText,
        newText: props.newText,
        contextLines,
    }), keepAnchors), [contextLines, keepAnchors, props.newText, props.oldText]);

    const view = (
        <View style={props.virtualized ? styles.virtualizedBody : undefined}>
            <CodeLinesView
                lines={lines}
                selectedLineIds={props.selectedLineIds}
                interactionMode={props.interactionMode}
                rangeSelectionActive={props.rangeSelectionActive}
                onPressLine={props.onPressLine}
                onPressLineRange={props.onPressLineRange}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={props.renderAfterLine}
                renderLeadingLane={props.renderLeadingLane}
                listHeader={props.leadingContent ? <DiffLeadingContent>{props.leadingContent}</DiffLeadingContent> : undefined}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized ?? false}
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
});
