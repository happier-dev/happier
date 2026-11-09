import * as React from 'react';
import { usePaneHeaderScrollSink } from '@/components/appShell/panes/paneHeaderScroll';
import { Platform, ScrollView, View } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';

import { Text } from '@/components/ui/text/Text';
import { CodeLinesView, type CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import type { WorkspaceFileLiveMoment } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileLiveMoment';
import { CODE_GUTTER_METRICS, resolveCodeEditorLineNumberDigits } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import type { CodeLineDiagnosticRange } from '@/components/ui/code/view/CodeLineRow';
import type { DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import type { MarkdownSourceRange, MarkdownSourceRangeAction } from '@/components/markdown/MarkdownView';
import { WorkspaceMarkdownView } from '@/components/markdown/WorkspaceMarkdownView';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { DiffHorizontalScroll } from '@/components/ui/code/diff/happier/DiffHorizontalScroll';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { useNativeLineRangeState, type NativeLineRangeSelection } from '@/components/ui/code/selection/nativeLineRangeSelection';
import { useCodeLinesReviewComments } from '@/components/ui/code/reviewComments/useCodeLinesReviewComments';
import { Typography } from '@/constants/Typography';
import type { ReviewCommentAnchor, ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { filterReviewCommentDraftsForFile } from '@/sync/domains/input/reviewComments/filterReviewCommentDrafts';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { resolveInlineCodeVirtualization } from '@/components/ui/code/diff/resolveInlineCodeVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { buildSelectedDiffLineKey } from '@/scm/scmPatchSelection';
import {
    buildReviewCommentDraftFromMarkdownRange,
} from '@/components/ui/code/reviewComments/buildReviewCommentDraftFromCodeLine';
import { resolveCodeLineAnchor } from '@/components/ui/code/reviewComments/resolveCodeLineAnchor';
import { ReviewCommentInlineComposer } from '@/components/ui/code/reviewComments/ReviewCommentInlineComposer';
import { ReviewCommentSavedDrafts } from '@/components/ui/code/reviewComments/ReviewCommentSavedDrafts';
import { isWorkspaceFileReferenceAnchorForFile } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import { CODE_CANVAS_CONTENT_PADDING } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useMarkdownReadingAnchor } from './useMarkdownReadingAnchor';
import { useFileContentScrollTarget } from './useFileContentScrollTarget';
import type { FileDisplayMode } from './filePageModel';
import type { FileViewerFindSnapshot } from '@/components/workspaces/files/details/useFileViewerFind';
import type { CodeLinesSemanticBinding } from '@/components/ui/code/view/useCodeLinesSemanticTokens';

const MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH = 768;
/** Shared View → Edit geometry; review controls keep their existing activation policy. */
export function resolveFileCodeGeometry(params: Readonly<{ text: string; reviewCommentsEnabled?: boolean; reviewCommentModeActive?: boolean }>): Readonly<{ lineNumberDigits: number; reviewLaneWidth: number }> {
    return { lineNumberDigits: resolveCodeEditorLineNumberDigits(params.text),
        reviewLaneWidth: params.reviewCommentsEnabled === true && params.reviewCommentModeActive === true ? CODE_GUTTER_METRICS.reviewLaneWidth : 0 };
}
const MARKDOWN_PREVIEW_COMPACT_PADDING = 16;
const MARKDOWN_PREVIEW_WIDE_HORIZONTAL_PADDING = 32;
const MARKDOWN_PREVIEW_WIDE_TOP_PADDING = 24;
const MARKDOWN_PREVIEW_WIDE_BOTTOM_PADDING = 32;

export type FileCodeIntelligenceBinding = Readonly<{
    onPointer: (line: number, character: number, rect: Rect | null) => void;
    onPointerAway: () => void;
    onActivate: (line: number, character: number, activation: Readonly<{ via: 'modifier' | 'touch'; rect: Rect | null }>) => boolean;
    /** This file's problems by 1-based line (stable until they change), for squiggles in View and Changes. */
    getDiagnosticsByLine: () => ReadonlyMap<number, readonly CodeLineDiagnosticRange[]> | undefined;
    subscribeDiagnostics: (listener: () => void) => () => void;
    semantic?: CodeLinesSemanticBinding;
}>;

const NO_DIAGNOSTICS_SUBSCRIPTION = () => () => undefined;
const NO_DIAGNOSTICS = () => undefined;

type FileContentPanelProps = {
    theme: any;
    displayMode: FileDisplayMode;
    sessionId: string;
    workspaceScope?: WorkspaceScopeBase | null;
    filePath: string;
    diffContent: string | null;
    /** Changes mode: per-change rows and the current change from the File page review owner. */
    hunks?: DiffViewerHunks;
    reviewUnits?: readonly ReviewUnit[];
    reviewScrollToLineId?: string;
    /** Changes mode: content above the diff's first line that scrolls with it (an SVG's image compare on phones). */
    diffLeadingContent?: React.ReactNode;
    fileContent: string | null;
    language: string | null;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    selectedLineKeys: Set<string>;
    lineSelectionEnabled: boolean;
    onToggleLine: (key: string) => void;
    /** Open the inline comment composer on these file lines (the selection toolbar's Comment). */
    commentRangeRequest?: Readonly<{ startLine: number; endLine: number; side?: 'before' | 'after'; key: number }> | null;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    reviewCommentsEnabled?: boolean;
    reviewCommentModeActive?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    rangeSelectionActive?: boolean;
    /**
     * Touch hosts: a long-press selects a row and taps extend the range, published for the page's Ask
     * controls (web selects text in the DOM instead, so it passes none).
     */
    lineRangeAsk?: NativeLineRangeSelection;
    jumpToAnchor?: ReviewCommentAnchor | null;
    /** Transient paint can expire while its line navigation still awaits browser measurement. */
    highlightJumpToAnchor?: boolean;
    jumpToAnchorRequestId?: number;
    find?: FileViewerFindSnapshot;
    readingMemory?: Readonly<{ identity: string; line?: number; active: boolean; remember(line: number): void }>;
    /** A lane before the line numbers (the Blame region's run column), in View and Changes. */
    renderLeadingLane?: CodeLinesViewProps['renderLeadingLane'];
    /** New-side lines to emphasize while their Blame card is open (lab BL1 Bc); a jump highlight wins. */
    emphasizedLines?: Readonly<{ startLine: number; lineCount: number }> | null;
    /**
     * An agent's write landed while you read (P3-R8): its new lines take the add tint once and fade over
     * `liveEdit.flashMs`; a later batch redirects the running fade from where it is, never back to full.
     */
    liveMoment?: WorkspaceFileLiveMoment | null;
    /** The agent writing in this file now (P5 Track): its caret and wash, in View and Changes alike. */
    agentPresence?: CodeLinesViewProps['agentPresence'];
    /**
     * Language features on the read view (P7): the pointer, a modifier-click or a tap on a name, in
     * 1-based file lines and 0-based UTF-16 characters. Keep it referentially stable.
     */
    intelligence?: FileCodeIntelligenceBinding | null;
    /** Room under the code while a phone sheet covers the bottom of the page (P7 name sheet). */
    codeBottomInset?: number;
    scrollTestID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
};

function readThemeToken(theme: any, path: readonly string[]): unknown {
    let current = theme;
    for (const segment of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[segment];
    }
    return current;
}

function areFileContentPanelThemesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    const tokenPaths = [
        ['colors', 'text', 'primary'],
        ['colors', 'text', 'secondary'],
        ['colors', 'textSecondary'],
        ['colors', 'border', 'default'],
        ['colors', 'borderDefault'],
        ['colors', 'surface', 'base'],
        ['colors', 'surface', 'elevated'],
        ['colors', 'surfaceElevated'],
        ['space', 's6'],
        ['space', 's8'],
        ['space', 's16'],
    ] as const;

    return tokenPaths.every((path) => Object.is(readThemeToken(a, path), readThemeToken(b, path)));
}

function areSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const value of a) {
        if (!b.has(value)) return false;
    }
    return true;
}

function hasReviewCommentDrafts(drafts: readonly ReviewCommentDraft[] | undefined): boolean {
    return Array.isArray(drafts) && drafts.length > 0;
}

function reviewCommentCallbacksAffectRenderedOutput(props: FileContentPanelProps): boolean {
    return props.reviewCommentsEnabled === true
        && (props.reviewCommentModeActive === true || hasReviewCommentDrafts(props.reviewCommentDrafts)
            || props.displayMode === 'diff' && props.hunks !== undefined);
}

export function areFileContentPanelPropsEqual(
    previous: FileContentPanelProps,
    next: FileContentPanelProps,
): boolean {
    const previousKeys = Object.keys(previous) as Array<keyof FileContentPanelProps>;
    const nextKeys = Object.keys(next) as Array<keyof FileContentPanelProps>;
    if (previousKeys.length !== nextKeys.length) return false;

    for (const key of previousKeys) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) return false;
        if (key === 'theme') {
            if (!areFileContentPanelThemesEqual(previous.theme, next.theme)) return false;
            continue;
        }
        if (key === 'selectedLineKeys') {
            if (!areSetsEqual(previous.selectedLineKeys, next.selectedLineKeys)) return false;
            continue;
        }
        if (key === 'reviewCommentDrafts') {
            if (!hasReviewCommentDrafts(previous.reviewCommentDrafts) && !hasReviewCommentDrafts(next.reviewCommentDrafts)) {
                continue;
            }
        }
        if (
            key === 'onUpsertReviewCommentDraft'
            || key === 'onDeleteReviewCommentDraft'
            || key === 'onReviewCommentError'
        ) {
            if (!reviewCommentCallbacksAffectRenderedOutput(previous) && !reviewCommentCallbacksAffectRenderedOutput(next)) {
                continue;
            }
        }
        if (!Object.is(previous[key], next[key])) return false;
    }
    return true;
}

type ResolvedJumpHighlight = Readonly<{
    scrollToLineId: string;
    highlightLineIds: ReadonlySet<string>;
}>;

function FileContentPanelInner({
    theme,
    displayMode,
    sessionId: _sessionId,
    workspaceScope,
    filePath,
    diffContent,
    hunks,
    reviewUnits,
    reviewScrollToLineId,
    diffLeadingContent,
    fileContent,
    language,
    syntaxHighlighting,
    selectedLineKeys,
    lineSelectionEnabled,
    onToggleLine,
    commentRangeRequest,
    wrapLines,
    showLineNumbers,
    showPrefix,
    reviewCommentsEnabled,
    reviewCommentModeActive,
    reviewCommentDrafts,
    onUpsertReviewCommentDraft,
    onDeleteReviewCommentDraft,
    onReviewCommentError,
    rangeSelectionActive,
    lineRangeAsk,
    jumpToAnchor,
    highlightJumpToAnchor = true,
    jumpToAnchorRequestId,
    find,
    readingMemory,
    renderLeadingLane,
    emphasizedLines,
    liveMoment,
    agentPresence,
    intelligence,
    codeBottomInset,
    scrollTestID,
    onLayout,
    onContentSizeChange,
    onScroll: onScrollProp,
}: FileContentPanelProps) {
    // The file's one primary scroller (code, diff or Markdown) drives its tab header's shade.
    const paneHeaderScroll = usePaneHeaderScrollSink();
    const onScroll = React.useCallback((event: any) => {
        paneHeaderScroll?.reportTopDistance(event?.nativeEvent?.contentOffset?.y ?? 0);
        onScrollProp?.(event);
    }, [onScrollProp, paneHeaderScroll]);
    const codeScrollRef = React.useRef<ScrollView | null>(null);
    const codeScrollContentRef = React.useRef<View>(null);
    const codeScrollOffsetRef = React.useRef(0);
    const codeScrollHeightRef = React.useRef(0);
    const codeViewportListeners = React.useRef(new Set<() => void>());
    const externalCodeScrollView = React.useMemo(() => ({
        scrollRef: codeScrollRef,
        contentRef: codeScrollContentRef,
        offsetRef: codeScrollOffsetRef,
        getViewport: () => ({ offset: codeScrollOffsetRef.current, height: codeScrollHeightRef.current }),
        subscribeViewport: (listener: () => void) => {
            codeViewportListeners.current.add(listener);
            return () => { codeViewportListeners.current.delete(listener); };
        },
    }), []);
    const intraLineDiff = useIntraLineWordDiffConfig();
    const { width: viewportWidth } = usePresentationWindowDimensions();
    const effectiveWrapLines = wrapLines ?? true;
    const effectiveShowLineNumbers = showLineNumbers ?? true;
    const effectiveShowPrefix = showPrefix ?? effectiveShowLineNumbers;
    const codeGeometry = React.useMemo(() => resolveFileCodeGeometry({ text: fileContent ?? '', reviewCommentsEnabled, reviewCommentModeActive }), [fileContent, reviewCommentsEnabled, reviewCommentModeActive]);
    const markdownPreviewHorizontalPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_HORIZONTAL_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;
    const markdownPreviewTopPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_TOP_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;
    const markdownPreviewBottomPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_BOTTOM_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;

    // Native prose shares one text view for cross-paragraph selection, so it is read by rendered run;
    // web and native Find measure each block.
    const rememberedLine = React.useMemo(() => readingMemory?.line, [readingMemory?.identity]);
    const markdownReading = useMarkdownReadingAnchor(`${_sessionId}:${filePath}:${displayMode}`, markdownPreviewTopPadding,
        !jumpToAnchor && !find?.open ? rememberedLine : undefined, Platform.OS === 'web' || find?.open ? 'block' : 'run');
    const canReadMarkdown = displayMode === 'markdown';
    React.useLayoutEffect(() => {
        if (!readingMemory?.active || !canReadMarkdown) return;
        return () => {
            const line = markdownReading.readLine();
            if (line !== null) readingMemory.remember(line);
        };
    }, [readingMemory?.active, readingMemory?.identity, readingMemory?.remember, canReadMarkdown, markdownReading.readLine]);

    const commentSource: ReviewCommentSource = displayMode === 'diff' ? 'diff' : 'file';
    const draftsForThisView = React.useMemo(() => {
        return filterReviewCommentDraftsForFile({
            enabled: reviewCommentsEnabled === true,
            filePath,
            source: commentSource,
            drafts: reviewCommentDrafts ?? [],
        });
    }, [commentSource, filePath, reviewCommentDrafts, reviewCommentsEnabled]);
    const reviewCommentPresentationActive = reviewCommentsEnabled === true
        && (reviewCommentModeActive === true || draftsForThisView.length > 0);
    const reviewCommentControlsEnabled = reviewCommentsEnabled === true
        && (reviewCommentPresentationActive || displayMode === 'diff' && hunks !== undefined);

    const needsDiffCodeLines = displayMode === 'diff'
        && typeof diffContent === 'string'
        && (
            lineSelectionEnabled === true
            || selectedLineKeys.size > 0
            || reviewCommentControlsEnabled
            || jumpToAnchor?.kind === 'diffLine'
            || jumpToAnchor?.kind === 'line'
            || jumpToAnchor?.kind === 'range'
            || find?.open
        );

    const lines = React.useMemo(() => {
        if (displayMode === 'diff' && typeof diffContent === 'string') {
            if (!needsDiffCodeLines) return [];
            return buildCodeLinesFromUnifiedDiff({
                unifiedDiff: diffContent,
                hideFilePrelude: true,
                intraLineDiff,
            });
        }
        if (displayMode === 'file' && typeof fileContent === 'string') {
            return buildCodeLinesFromFile({ text: fileContent });
        }
        return [];
    }, [diffContent, displayMode, fileContent, intraLineDiff, needsDiffCodeLines]);

    const reviewCommentControls = useCodeLinesReviewComments({
        enabled: reviewCommentControlsEnabled,
        filePath,
        source: commentSource,
        lines,
        drafts: draftsForThisView,
        contextRadius: 2,
        onUpsertDraft: onUpsertReviewCommentDraft,
        onDeleteDraft: onDeleteReviewCommentDraft,
        onError: onReviewCommentError,
    });
    const reviewCommentLineActionsEnabled = codeGeometry.reviewLaneWidth > 0 && Boolean(reviewCommentControls);
    const handledCommentRangeKey = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (!commentRangeRequest || handledCommentRangeKey.current === commentRangeRequest.key || !reviewCommentControls) return;
        handledCommentRangeKey.current = commentRangeRequest.key;
        const rangeLines = lines.filter((line) => {
            const number = commentRangeRequest.side === 'before' ? line.oldLine : line.newLine;
            return !line.renderIsHeaderLine && number !== null
                && number >= commentRangeRequest.startLine && number <= commentRangeRequest.endLine;
        });
        if (rangeLines.length > 0) reviewCommentControls.onPressAddCommentRange(rangeLines);
    }, [commentRangeRequest, lines, reviewCommentControls]);
    const markdownSourceRangeActionsEnabled = reviewCommentsEnabled === true
        && reviewCommentModeActive === true
        && displayMode === 'markdown';
    const [activeMarkdownRange, setActiveMarkdownRange] = React.useState<MarkdownSourceRange | null>(null);
    const [activeMarkdownEditingDraftId, setActiveMarkdownEditingDraftId] = React.useState<string | null>(null);
    const [markdownCommentBody, setMarkdownCommentBody] = React.useState('');

    const selectedLineIds = React.useMemo(() => {
        if (displayMode !== 'diff') return undefined;
        if (!selectedLineKeys || selectedLineKeys.size === 0) return undefined;
        const ids = new Set<string>();
        for (const line of lines) {
            if (!line.selectable) continue;
            const key = line.renderPrefixText === '-'
                ? (typeof line.oldLine === 'number' ? buildSelectedDiffLineKey('deletions', line.oldLine) : null)
                : line.renderPrefixText === '+'
                    ? (typeof line.newLine === 'number' ? buildSelectedDiffLineKey('additions', line.newLine) : null)
                    : null;
            if (!key) continue;
            if (selectedLineKeys.has(key)) ids.add(line.id);
        }
        return ids;
    }, [displayMode, lines, selectedLineKeys]);

    const jumpHighlight = React.useMemo((): ResolvedJumpHighlight | null => {
        if (!jumpToAnchor || (displayMode !== 'file' && displayMode !== 'diff')) return null;
        const resolution = resolveCodeLineAnchor({ filePath, source: displayMode, lines, anchor: jumpToAnchor });
        const first = resolution.lines[0];
        if (!first) return null;
        return { scrollToLineId: first.id, highlightLineIds: new Set(resolution.lines.map((line) => line.id)) };
    }, [displayMode, filePath, jumpToAnchor, lines]);

    const emphasizedLineIds = React.useMemo(() => {
        if (!emphasizedLines) return undefined;
        const end = emphasizedLines.startLine + emphasizedLines.lineCount;
        return new Set(lines.filter((line) => typeof line.newLine === 'number'
            && line.newLine >= emphasizedLines.startLine && line.newLine < end).map((line) => line.id));
    }, [emphasizedLines, lines]);
    const activeJumpHighlight = highlightJumpToAnchor ? jumpHighlight : null;
    const highlightLineIds = activeJumpHighlight?.highlightLineIds ?? emphasizedLineIds;

    const markdownHighlightRange = React.useMemo<MarkdownSourceRange | null>(() => {
        if (displayMode !== 'markdown' || !highlightJumpToAnchor) return null;
        const anchor = jumpToAnchor ?? null;
        if (!anchor) return null;
        if (anchor.kind === 'fileLine') return { startLine: anchor.startLine, endLine: anchor.startLine };
        if (anchor.kind === 'line') return { startLine: anchor.line, endLine: anchor.line };
        if (anchor.kind === 'range') return { startLine: anchor.startLine, endLine: anchor.endLine };
        return null;
    }, [displayMode, highlightJumpToAnchor, jumpToAnchor]);

    const rememberedTarget = displayMode === 'file' ? lines.find(line => line.newLine === rememberedLine)?.id : undefined;
    const scrollToLineId = useFileContentScrollTarget(jumpHighlight?.scrollToLineId ?? reviewScrollToLineId, find, rememberedTarget, readingMemory?.identity);

    React.useEffect(() => {
        if (displayMode === 'markdown' && find?.open && find.markdownLineTarget !== null) {
            markdownReading.revealLine(find.markdownLineTarget);
        }
    }, [displayMode, find?.open, find?.markdownLineTarget, find?.revealRevision, markdownReading.revealLine]);

    const findMarkdownDraftsForRange = React.useCallback((range: MarkdownSourceRange): ReviewCommentDraft[] => {
        return draftsForThisView.filter((draft) => {
            const anchor = draft.anchor;
            if (anchor.kind === 'fileLine') {
                return anchor.startLine >= range.startLine && anchor.startLine <= range.endLine;
            }
            if (anchor.kind === 'line') {
                return anchor.line >= range.startLine && anchor.line <= range.endLine;
            }
            if (anchor.kind === 'range') {
                return anchor.startLine <= range.endLine && range.startLine <= anchor.endLine;
            }
            return false;
        });
    }, [draftsForThisView]);

    const onPressMarkdownSourceRange = React.useCallback((action: MarkdownSourceRangeAction) => {
        if (!markdownSourceRangeActionsEnabled) return;
        const existingDraft = findMarkdownDraftsForRange(action.sourceRange)[0] ?? null;
        setActiveMarkdownRange((previous) => (
            previous?.startLine === action.sourceRange.startLine && previous?.endLine === action.sourceRange.endLine
                ? null
                : action.sourceRange
        ));
        setActiveMarkdownEditingDraftId(existingDraft?.id ?? null);
        setMarkdownCommentBody(existingDraft?.body ?? '');
    }, [findMarkdownDraftsForRange, markdownSourceRangeActionsEnabled]);

    const startEditingMarkdownDraft = React.useCallback((range: MarkdownSourceRange, draft: ReviewCommentDraft) => {
        setActiveMarkdownRange(range);
        setActiveMarkdownEditingDraftId(draft.id);
        setMarkdownCommentBody(draft.body);
    }, []);

    const renderAfterMarkdownSourceRange = React.useCallback((action: MarkdownSourceRangeAction) => {
        if (reviewCommentsEnabled !== true) return null;
        const drafts = findMarkdownDraftsForRange(action.sourceRange);
        const isActive = activeMarkdownRange?.startLine === action.sourceRange.startLine
            && activeMarkdownRange?.endLine === action.sourceRange.endLine;
        if (!isActive && drafts.length === 0) return null;

        const existing = activeMarkdownEditingDraftId
            ? drafts.find((draft) => draft.id === activeMarkdownEditingDraftId) ?? null
            : null;

        return (
            <View style={{ marginTop: theme.space.s6, marginBottom: theme.space.s8, gap: theme.space.s6 }}>
                {drafts.length > 0 && !isActive ? (
                    <ReviewCommentSavedDrafts
                        drafts={drafts}
                        onEditDraft={(draft) => startEditingMarkdownDraft(action.sourceRange, draft)}
                        onDeleteDraft={onDeleteReviewCommentDraft}
                    />
                ) : null}
                {isActive ? (
                    <ReviewCommentInlineComposer
                        value={markdownCommentBody}
                        onChange={setMarkdownCommentBody}
                        onCancel={() => {
                            setActiveMarkdownRange(null);
                            setActiveMarkdownEditingDraftId(null);
                            setMarkdownCommentBody('');
                        }}
                        onDelete={existing ? () => {
                            onDeleteReviewCommentDraft?.(existing.id);
                            setActiveMarkdownRange(null);
                            setActiveMarkdownEditingDraftId(null);
                            setMarkdownCommentBody('');
                        } : undefined}
                        onSave={() => {
                            const body = markdownCommentBody.trim();
                            if (!body) {
                                onReviewCommentError?.(t('files.reviewComments.errors.empty'));
                                return;
                            }
                            const draft = buildReviewCommentDraftFromMarkdownRange({
                                filePath,
                                markdown: fileContent ?? '',
                                sourceRange: action.sourceRange,
                                body,
                                contextRadius: 2,
                                existing: existing ? { id: existing.id, createdAt: existing.createdAt } : null,
                            });
                            onUpsertReviewCommentDraft?.(draft);
                            setActiveMarkdownRange(null);
                            setActiveMarkdownEditingDraftId(null);
                            setMarkdownCommentBody('');
                        }}
                    />
                ) : null}
            </View>
        );
    }, [
        activeMarkdownEditingDraftId,
        activeMarkdownRange,
        fileContent,
        filePath,
        findMarkdownDraftsForRange,
        markdownCommentBody,
        onDeleteReviewCommentDraft,
        onReviewCommentError,
        onUpsertReviewCommentDraft,
        reviewCommentsEnabled,
        startEditingMarkdownDraft,
    ]);

    const handlePressLine = React.useCallback((line: any) => {
        if (!lineSelectionEnabled) return;
        if (!onToggleLine) return;
        if (!line?.selectable) return;
        const key = line.renderPrefixText === '-'
            ? (typeof line.oldLine === 'number' ? buildSelectedDiffLineKey('deletions', line.oldLine) : null)
            : line.renderPrefixText === '+'
                ? (typeof line.newLine === 'number' ? buildSelectedDiffLineKey('additions', line.newLine) : null)
                : null;
        if (!key) return;
        onToggleLine(key);
    }, [lineSelectionEnabled, onToggleLine]);

    const handlePressLineRange = React.useCallback((rangeLines: readonly CodeLine[]) => {
        if (lineSelectionEnabled) {
            for (const line of rangeLines) {
                handlePressLine(line);
            }
            return;
        }
        if (reviewCommentLineActionsEnabled) {
            reviewCommentControls?.onPressAddCommentRange(rangeLines);
        }
    }, [handlePressLine, lineSelectionEnabled, reviewCommentControls, reviewCommentLineActionsEnabled]);

    const lineRangeAskEnabled = lineRangeAsk !== undefined && !lineSelectionEnabled && !reviewCommentLineActionsEnabled
        && (displayMode === 'file' || displayMode === 'diff');
    const codeLineInteractionMode = lineSelectionEnabled
        ? 'commitSelection'
        : reviewCommentLineActionsEnabled
            ? 'comment'
            : lineRangeAskEnabled ? 'selectRange' : 'read';
    const askRange = useNativeLineRangeState(lineRangeAsk);
    const askRangeActive = lineRangeAskEnabled && askRange.lineIds.size > 0;
    // A selection belongs to the rows it was made on: another file, view or content, or another mode, drops it.
    React.useEffect(() => {
        lineRangeAsk?.clear();
    }, [lineRangeAsk, lineRangeAskEnabled, filePath, displayMode, fileContent, diffContent]);
    const onPressAskRange = React.useCallback((rangeLines: readonly CodeLine[]) => {
        lineRangeAsk?.select(rangeLines, displayMode === 'diff' ? 'diff' : 'file');
    }, [displayMode, lineRangeAsk]);

    const { lineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();
    const virtualized = React.useMemo(() => {
        if (!reviewCommentPresentationActive) return true;
        if (displayMode === 'diff') {
            return resolveInlineDiffVirtualization({
                unifiedDiff: typeof diffContent === 'string' ? diffContent : null,
                oldText: null,
                newText: null,
                lineThreshold,
                byteThreshold,
            });
        }
        if (displayMode === 'file') {
            return resolveInlineCodeVirtualization({
                text: typeof fileContent === 'string' ? fileContent : null,
                lineThreshold,
                byteThreshold,
            });
        }
        return false;
    }, [byteThreshold, diffContent, displayMode, fileContent, lineThreshold, reviewCommentPresentationActive]);

    const liveTint = useFileLiveEditTint(liveMoment ?? null, lines);
    const diagnosticsByNewLine = React.useSyncExternalStore(
        intelligence?.subscribeDiagnostics ?? NO_DIAGNOSTICS_SUBSCRIPTION,
        intelligence?.getDiagnosticsByLine ?? NO_DIAGNOSTICS,
        NO_DIAGNOSTICS,
    );
    // One binding for the read view and the Changes body: rows report their 1-based new-side line.
    const codeIntelligence = React.useMemo(() => {
        if (!intelligence) return undefined;
        return {
            onPointerToken: (_lineId: string, offset16: number, rect: Rect | null, newLine: number) => {
                intelligence.onPointer(newLine, offset16, rect);
            },
            onPointerAway: intelligence.onPointerAway,
            onActivateToken: (_lineId: string, offset16: number, activation: Readonly<{ via: 'modifier' | 'touch'; rect: Rect | null }>, newLine: number) => {
                return intelligence.onActivate(newLine, offset16, activation);
            },
            ...(diagnosticsByNewLine ? { diagnosticsByNewLine } : {}),
            ...(displayMode === 'file' && intelligence.semantic ? { semantic: intelligence.semantic } : {}),
        };
    }, [diagnosticsByNewLine, intelligence, displayMode]);
    const fileCodeView = fileContent && displayMode === 'file'
        ? (
            <CodeLinesView
                {...codeGeometry}
                lines={lines}
                selectedLineIds={askRangeActive ? askRange.lineIds : undefined}
                interactionMode={codeLineInteractionMode}
                rangeSelectionActive={rangeSelectionActive || askRangeActive}
                onPressLine={reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                onPressLineRange={reviewCommentLineActionsEnabled ? handlePressLineRange : lineRangeAskEnabled ? onPressAskRange : undefined}
                pressLineWhenNotSelectable={reviewCommentLineActionsEnabled || lineRangeAskEnabled}
                onPressAddComment={reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                isCommentActive={reviewCommentControls?.isCommentActive}
                renderAfterLine={reviewCommentControls?.renderAfterLine}
                renderLeadingLane={renderLeadingLane}
                liveTint={liveTint}
                agentPresence={agentPresence}
                intelligence={codeIntelligence}
                contentPaddingHorizontal={CODE_CANVAS_CONTENT_PADDING}
                contentPaddingVertical={CODE_CANVAS_CONTENT_PADDING}
                contentPaddingBottom={codeBottomInset}
                externalScrollView={!virtualized && Platform.OS !== 'web' ? externalCodeScrollView : undefined}
                virtualized={virtualized}
                scrollToLineId={scrollToLineId}
                scrollToLineRequestId={jumpToAnchorRequestId}
                scrollToLineAlignment={scrollToLineId && scrollToLineId === rememberedTarget && !jumpHighlight && !(find?.open && find.lineTarget) ? 'start' : undefined}
                onRememberReadingLine={readingMemory?.active ? readingMemory.remember : undefined}
                findRangesByLineId={find?.lineRanges}
                highlightLineId={activeJumpHighlight?.scrollToLineId}
                highlightLineIds={highlightLineIds}
                wrapLines={effectiveWrapLines}
                showLineNumbers={effectiveShowLineNumbers}
                showPrefix={effectiveShowPrefix}
                syntaxHighlighting={syntaxHighlighting}
                testID={virtualized ? scrollTestID : undefined}
                onLayout={virtualized ? onLayout : undefined}
                onContentSizeChange={virtualized ? onContentSizeChange : undefined}
                onScroll={virtualized ? onScroll : undefined}
                scrollEventThrottle={16}
            />
        )
        : null;
    const effectiveDiffVirtualized = displayMode === 'diff'
        ? (activeJumpHighlight ? false : virtualized)
        : virtualized;
    const diffViewer = displayMode === 'diff' && typeof diffContent === 'string'
        ? (
            <DiffViewer
                mode="unified"
                filePath={filePath}
                unifiedDiff={diffContent}
                hunks={hunks}
                reviewUnits={reviewUnits}
                selectedLineIds={askRangeActive ? askRange.lineIds : selectedLineIds}
                interactionMode={codeLineInteractionMode}
                rangeSelectionActive={rangeSelectionActive || askRangeActive}
                onPressLine={lineSelectionEnabled ? handlePressLine : reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                onPressLineRange={lineSelectionEnabled || reviewCommentLineActionsEnabled ? handlePressLineRange : lineRangeAskEnabled ? onPressAskRange : undefined}
                pressLineWhenNotSelectable={!lineSelectionEnabled && (reviewCommentLineActionsEnabled || lineRangeAskEnabled)}
                onPressAddComment={reviewCommentControls?.onPressAddComment}
                isCommentActive={reviewCommentControls?.isCommentActive}
                renderAfterLine={reviewCommentControls?.renderAfterLine}
                renderLeadingLane={renderLeadingLane}
                leadingContent={diffLeadingContent}
                contentPaddingHorizontal={CODE_CANVAS_CONTENT_PADDING}
                contentPaddingVertical={CODE_CANVAS_CONTENT_PADDING}
                externalScrollView={!effectiveDiffVirtualized && Platform.OS !== 'web' ? externalCodeScrollView : undefined}
                virtualized={effectiveDiffVirtualized}
                scrollToLineId={scrollToLineId}
                scrollToLineRequestId={jumpToAnchorRequestId}
                findActive={find?.open}
                findRangesByLineId={find?.lineRanges}
                intelligence={codeIntelligence}
                highlightLineId={activeJumpHighlight?.scrollToLineId}
                highlightLineIds={highlightLineIds}
                agentPresence={agentPresence}
                wrapLines={effectiveWrapLines}
                showLineNumbers={effectiveShowLineNumbers}
                showPrefix={effectiveShowPrefix}
                testID={effectiveDiffVirtualized ? scrollTestID : undefined}
                onLayout={effectiveDiffVirtualized ? onLayout : undefined}
                onContentSizeChange={effectiveDiffVirtualized ? onContentSizeChange : undefined}
                onScroll={effectiveDiffVirtualized ? onScroll : undefined}
                scrollEventThrottle={effectiveDiffVirtualized ? 16 : undefined}
            />
        )
        : null;

    const renderCodeScroll = (children: React.ReactNode) => (
        <ScrollView
            ref={codeScrollRef}
            // RN declares this host ref non-null even though it is null before mount.
                        innerViewRef={codeScrollContentRef as React.RefObject<View>}
            style={{ flex: 1, minHeight: 0 }}
            testID={scrollTestID}
            onLayout={(event) => {
                codeScrollHeightRef.current = event.nativeEvent.layout.height;
                for (const listener of codeViewportListeners.current) listener();
                onLayout?.(event);
            }}
            onContentSizeChange={(width, height) => {
                for (const listener of codeViewportListeners.current) listener();
                onContentSizeChange?.(width, height);
            }}
            onScroll={(event) => {
                codeScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                for (const listener of codeViewportListeners.current) listener();
                onScroll?.(event);
            }}
            scrollEventThrottle={16}
        >
            {children}
        </ScrollView>
    );
    const renderFileCode = () => {
        // The diff's sideways scroller: it tells what renders under a line (a comment composer) the visible width.
        const content = effectiveWrapLines ? fileCodeView : <DiffHorizontalScroll>{fileCodeView}</DiffHorizontalScroll>;
        return virtualized ? content : renderCodeScroll(content);
    };

    return (
        <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {displayMode === 'diff' && typeof diffContent === 'string' ? (
                effectiveDiffVirtualized ? (
                    diffViewer
                ) : (
                    renderCodeScroll(diffViewer)
                )
            ) : displayMode === 'markdown' && typeof fileContent === 'string' ? (
                fileContent.length > 0 ? (
                    <ScrollView
                        ref={markdownReading.scrollRef}
                        style={{ flex: 1, minHeight: 0, ...(Platform.OS === 'web' ? { overflowAnchor: 'none' } : {}) }}
                        testID={scrollTestID}
                        onLayout={onLayout}
                        onContentSizeChange={(width, height) => {
                            markdownReading.onContentSizeChange();
                            onContentSizeChange?.(width, height);
                        }}
                        onScroll={(event) => {
                            markdownReading.onScroll(event);
                            onScroll?.(event);
                        }}
                        scrollEventThrottle={16}
                    >
                        <View
                            style={{
                                paddingHorizontal: markdownPreviewHorizontalPadding,
                                paddingTop: markdownPreviewTopPadding,
                                paddingBottom: markdownPreviewBottomPadding,
                            }}
                        >
                            <WorkspaceMarkdownView
                                scope={workspaceScope}
                                filePath={filePath}
                                testID="file-markdown-preview"
                                markdown={fileContent}
                                sourceRangeLayoutObserver={markdownReading.observer}
                                profile="default"
                                streamingMode="static"
                                selectable
                                onPressSourceRange={markdownSourceRangeActionsEnabled ? onPressMarkdownSourceRange : undefined}
                                renderAfterSourceRange={reviewCommentsEnabled === true ? renderAfterMarkdownSourceRange : undefined}
                                highlightSourceRange={markdownHighlightRange}
                                findSourceRanges={find?.markdownRanges}
                                findActive={find?.open}
                            />
                        </View>
                    </ScrollView>
                ) : (
                    <Text
                        style={{
                            fontSize: 16,
                            color: theme.colors.text.secondary,
                            fontStyle: 'italic',
                            padding: theme.space.s16,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.fileEmpty')}
                    </Text>
                )
            ) : displayMode === 'file' && typeof fileContent === 'string' ? (
                fileContent.length > 0 ? (
                    renderFileCode()
                ) : (
                    <Text
                        style={{
                            fontSize: 16,
                            color: theme.colors.text.secondary,
                            fontStyle: 'italic',
                            padding: theme.space.s16,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.fileEmpty')}
                    </Text>
                )
            ) : (
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.text.secondary,
                        fontStyle: 'italic',
                        padding: theme.space.s16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.noChanges')}
                </Text>
            )}
        </View>
    );
}

/** One shared clock for a live-edit batch: full tint at once, then fade; a newer batch fades on from the current value. */
function useFileLiveEditTint(moment: WorkspaceFileLiveMoment | null, lines: readonly CodeLine[]) {
    const opacity = useSharedValue(0);
    const changed = moment?.changedLines;
    const lineIds = React.useMemo(() => {
        if (!changed || changed.length === 0) return null;
        const wanted = new Set(changed);
        return new Set(lines.filter((line) => line.newLine !== null && wanted.has(line.newLine)).map((line) => line.id));
    }, [changed, lines]);
    React.useEffect(() => {
        if (!lineIds || lineIds.size === 0) return;
        cancelAnimation(opacity);
        if (opacity.value <= 0) opacity.value = 1;
        opacity.value = withTiming(0, { duration: motionTokens.liveEdit.flashMs, easing: reanimatedMotionTokens.easing.standard });
    }, [lineIds, opacity]);
    return React.useMemo(() => lineIds && lineIds.size > 0 ? { lineIds, opacity } : undefined, [lineIds, opacity]);
}

export const FileContentPanel = React.memo(FileContentPanelInner, areFileContentPanelPropsEqual);
FileContentPanel.displayName = 'FileContentPanel';
