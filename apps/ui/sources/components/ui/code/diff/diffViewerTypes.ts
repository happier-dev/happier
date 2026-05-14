import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';

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
    interactionMode?: CodeLinesViewProps['interactionMode'];
    rangeSelectionActive?: CodeLinesViewProps['rangeSelectionActive'];
    onPressLine?: CodeLinesViewProps['onPressLine'];
    onPressLineRange?: CodeLinesViewProps['onPressLineRange'];
    pressLineWhenNotSelectable?: CodeLinesViewProps['pressLineWhenNotSelectable'];
    onPressAddComment?: CodeLinesViewProps['onPressAddComment'];
    isCommentActive?: CodeLinesViewProps['isCommentActive'];
    renderAfterLine?: CodeLinesViewProps['renderAfterLine'];
}>;

export type UnifiedDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'unified';
    unifiedDiff: string;
}>;

export type TextDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'text';
    oldText: string;
    newText: string;
    contextLines?: number;
}>;

export type DiffViewerProps = UnifiedDiffViewerProps | TextDiffViewerProps;
