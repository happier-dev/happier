import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
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
        <View style={{ flex: 1 }}>
            <CodeLinesView
                lines={lines}
                selectedLineIds={props.selectedLineIds}
                onPressLine={props.onPressLine}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={props.renderAfterLine}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized ?? false}
                showLineNumbers={props.showLineNumbers}
                showPrefix={props.showPrefix}
                scrollToLineId={props.scrollToLineId}
                highlightLineId={props.highlightLineId}
                syntaxHighlighting={syntaxHighlighting}
            />
        </View>
    );

    if (wrapLines) return view;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            {view}
        </ScrollView>
    );
});
