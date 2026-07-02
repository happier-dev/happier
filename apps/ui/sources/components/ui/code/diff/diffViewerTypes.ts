import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

export type DiffViewerMode = 'unified' | 'text';

export type DiffViewerBaseProps = Readonly<{
    filePath?: string | null;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    virtualized?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    /**
     * Optional override for the web/desktop diff presentation style.
     * Useful for compact surfaces (e.g. timeline/tool cards) where split diffs
     * waste horizontal space, especially for new/deleted files.
     */
    presentationStyleOverride?: 'unified' | 'split';
    scrollToLineId?: string;
    highlightLineId?: string;
    highlightLineIds?: CodeLinesViewProps['highlightLineIds'];
    selectedLineIds?: ReadonlySet<string>;
    testID?: CodeLinesViewProps['testID'];
    onLayout?: CodeLinesViewProps['onLayout'];
    onContentSizeChange?: CodeLinesViewProps['onContentSizeChange'];
    onScroll?: CodeLinesViewProps['onScroll'];
    scrollEventThrottle?: CodeLinesViewProps['scrollEventThrottle'];
    interactionMode?: CodeLinesViewProps['interactionMode'];
    rangeSelectionActive?: CodeLinesViewProps['rangeSelectionActive'];
    onPressLine?: CodeLinesViewProps['onPressLine'];
    onPressLineRange?: CodeLinesViewProps['onPressLineRange'];
    pressLineWhenNotSelectable?: CodeLinesViewProps['pressLineWhenNotSelectable'];
    onPressAddComment?: CodeLinesViewProps['onPressAddComment'];
    isCommentActive?: CodeLinesViewProps['isCommentActive'];
    renderAfterLine?: CodeLinesViewProps['renderAfterLine'];
    showInactiveCommentAffordance?: CodeLinesViewProps['showInactiveCommentAffordance'];
}>;

export type UnifiedDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'unified';
    unifiedDiff: string;
    precomputedLines?: readonly CodeLine[];
}>;

export type TextDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'text';
    oldText: string;
    newText: string;
    contextLines?: number;
}>;

export type DiffViewerProps = UnifiedDiffViewerProps | TextDiffViewerProps;
