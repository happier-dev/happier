import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { ReactNode } from 'react';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';

export type DiffViewerMode = 'unified' | 'text';

export type DiffHunkInfo = Readonly<{
    index: number;
    hunkIndex: number;
    key: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    sectionHeading: string;
    /** The changed lines the unit lands on (new side; old side for a pure deletion), for its label. */
    rangeStart: number;
    rangeEnd: number;
    rangeSide: 'new' | 'old';
    firstChangeLineId: string;
    /**
     * Where a page move to this change lands: the line its "Change n" row is drawn after, so a top-aligned
     * landing shows the row and one line of context; the first changed line when only the hunk header is above.
     */
    revealLineId: string;
    /** CodeLine ids of the unit's changed lines (its run), for the kept tint release. */
    changeLineIds: readonly string[];
}>;

/**
 * A file's change numbers, read live by each change row: a change loading in another file renumbers only the
 * rows (their "Change n" label and accessible "of total"), never the file's diff.
 */
export type DiffHunkNumbering = Readonly<{
    subscribe: (listener: () => void) => () => void;
    /** Changes before this file's first one. */
    offset: () => number;
    total: () => number;
}>;

export type DiffHunkReviewState = 'open' | 'kept' | 'discarding';
/** `comment` opens the surface's review comment at the change (composed by the viewer from `onPressAddComment`). */
export type DiffHunkAction = 'keep' | 'discard' | 'ask' | 'copy' | 'comment';

export type DiffViewerHunks = Readonly<{
    onHunks?: (hunks: readonly DiffHunkInfo[]) => void;
    currentIndex?: number | null;
    stateOf?: (hunk: DiffHunkInfo) => DiffHunkReviewState;
    actions?: Readonly<Partial<Record<DiffHunkAction, (hunk: DiffHunkInfo) => void>>>;
    disabledReason?: (hunk: DiffHunkInfo, action: DiffHunkAction) => string | null;
    /**
     * What `keep` means here: `keep` beside Discard (the change stays in the working tree), or `markReviewed` where a
     * change can only be marked (a captured comparison, such as a Review's Changes): "Mark reviewed" · "Reviewed".
     */
    keepVerb?: 'keep' | 'markReviewed';
    /** Where this file's changes sit in the whole comparison ("Change 3", "change 2 of 7"); absent numbers from 1. */
    numbering?: DiffHunkNumbering;
    renderNote?: (hunk: DiffHunkInfo) => ReactNode;
    /**
     * Host-chosen choices for a hunk that are not review verbs (the editor's Compare: Use mine · Use theirs).
     * Drawn in the hunk row's action position; never relabels Keep / Discard.
     */
    renderActions?: (hunk: DiffHunkInfo) => ReactNode;
}>;

export type DiffViewerBaseProps = Readonly<{
    hunks?: DiffViewerHunks;
    /** Captured evidence supplies its canonical per-layer keys to the shared table. */
    reviewUnits?: readonly ReviewUnit[];
    /** Host-private: changed lines of kept units let go of their tint (composed by the wrapper from `hunks`). */
    reviewedLineIds?: ReadonlySet<string>;
    /** Surface-owned evidence state, used instead of raw patch bytes when rendering fails. */
    errorFallback?: ReactNode;
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
    scrollToLineRequestId?: CodeLinesViewProps['scrollToLineRequestId'];
    onScrollToLine?: CodeLinesViewProps['onScrollToLine'];
    externalScrollView?: CodeLinesViewProps['externalScrollView'];
    highlightLineId?: string;
    highlightLineIds?: CodeLinesViewProps['highlightLineIds'];
    /** The agent writing in this file now (P5 Track): wash over its new-side lines and its caret after the last. */
    agentPresence?: CodeLinesViewProps['agentPresence'];
    findActive?: boolean;
    /** Bind this mounted renderer's temporary Find refold operation to its surface controller. */
    registerFindRefold?: (refold: NonNullable<FindController['refold']>) => (() => void) | undefined;
    findRangesByLineId?: CodeLinesViewProps['findRangesByLineId'];
    /** P7: names on the new side answer like the read view (card, definition, squiggles). */
    intelligence?: CodeLinesViewProps['intelligence'];
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
    /** The code view's leading lane (Blame on the new side); removed lines get an empty cell. */
    renderLeadingLane?: CodeLinesViewProps['renderLeadingLane'];
    /**
     * Content above the first line that scrolls with the diff, inside its own scroller (an SVG's image
     * compare on a phone), so the page has one scroll. It spans the visible width, never the code's.
     */
    leadingContent?: ReactNode;
    showInactiveCommentAffordance?: CodeLinesViewProps['showInactiveCommentAffordance'];
}>;

export type UnifiedDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'unified';
    unifiedDiff: string;
    precomputedLines?: readonly CodeLine[];
    /**
     * Find: this patch's before revision, the text its omitted unchanged rows come from. A renderer that
     * folds against the patch alone (Pierre) completes its diff from it to reveal a match in omitted text.
     */
    contextBaseText?: string;
    /**
     * Host-private: draw each hunk header as Pierre's quiet "N unchanged lines · heading" band rather than
     * the raw `@@` header, so the Happier renderer standing in while Pierre initializes reads like Pierre, and a
     * prose-anchored hunk card (a walkthrough stop) reads the same whichever renderer the person chose.
     */
    lineInfoSeparators?: boolean;
}>;

export type TextDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'text';
    oldText: string;
    newText: string;
    contextLines?: number;
    /**
     * `prose`: R5, the reading face for instructions people read (two labelled sides, proportional type,
     * soft bands, no hunk headers). `code` (default) is the code diff.
     */
    face?: 'code' | 'prose';
    /**
     * The prose face's side labels and, when a choice is made, which side is kept (the other dims).
     * `inline`: an edit read top to bottom rather than two versions to compare — one column in document
     * order, each change marked where it happens (no sides, labels or kept choice).
     * `words`: one passage edited, read as one run of words with only the changed words marked, in place
     * (a suggested edit to a sentence). Labels, when given, only name the sides for assistive technology.
     * `inBody`: the words stand in a Markdown body in place of its paragraph, so they read at that body's scale.
     * `by`: one person's version (`newText`) read against the base (`oldText`): their name beside only the lines they
     * changed, with only their changed words marked (an update review's author and recipient rows).
     */
    prose?: Readonly<{ oldLabel?: ReactNode; newLabel?: ReactNode; kept?: 'old' | 'new' | null; inline?: boolean; words?: boolean; inBody?: boolean;
        by?: string }>;
}>;

export type DiffViewerProps = UnifiedDiffViewerProps | TextDiffViewerProps;
