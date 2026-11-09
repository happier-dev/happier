import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { DiffHorizontalScroll } from './DiffHorizontalScroll';
import { DiffLeadingContent } from './DiffLeadingContent';
import type { TextDiffViewerProps } from '../diffViewerTypes';

export const HappierTextDiffViewer = React.memo<TextDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const contextLines = props.contextLines ?? 3;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const lines = React.useMemo(() => {
        return buildCodeLinesFromTextDiff({
            oldText: props.oldText,
            newText: props.newText,
            contextLines,
        });
    }, [contextLines, props.newText, props.oldText]);

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
