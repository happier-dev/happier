import * as React from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { MarkdownView, type MarkdownSourceRange, type MarkdownSourceRangeAction } from '@/components/markdown/MarkdownView';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
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
import { useMarkdownReadingAnchor } from './useMarkdownReadingAnchor';
import { useFileContentScrollTarget } from './useFileContentScrollTarget';
import type { FileDisplayMode } from './FileActionToolbar';
import type { FileViewerFindSnapshot } from '@/components/workspaces/files/details/useFileViewerFind';

const MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH = 768;
const MARKDOWN_PREVIEW_COMPACT_PADDING = 16;
const MARKDOWN_PREVIEW_WIDE_HORIZONTAL_PADDING = 32;
const MARKDOWN_PREVIEW_WIDE_TOP_PADDING = 24;
const MARKDOWN_PREVIEW_WIDE_BOTTOM_PADDING = 32;

type FileContentPanelProps = {
    theme: any;
    displayMode: FileDisplayMode;
    sessionId: string;
    filePath: string;
    diffContent: string | null;
    fileContent: string | null;
    language: string | null;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    selectedLineKeys: Set<string>;
    lineSelectionEnabled: boolean;
    onToggleLine: (key: string) => void;
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
    jumpToAnchor?: ReviewCommentAnchor | null;
    find?: FileViewerFindSnapshot;
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
        && (props.reviewCommentModeActive === true || hasReviewCommentDrafts(props.reviewCommentDrafts));
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
    filePath,
    diffContent,
    fileContent,
    language,
    syntaxHighlighting,
    selectedLineKeys,
    lineSelectionEnabled,
    onToggleLine,
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
    jumpToAnchor,
    find,
    scrollTestID,
    onLayout,
    onContentSizeChange,
    onScroll,
}: FileContentPanelProps) {
    const codeScrollRef = React.useRef<ScrollView | null>(null);
    const codeScrollContentRef = React.useRef<View>(null);
    const codeScrollOffsetRef = React.useRef(0);
    const externalCodeScrollView = React.useMemo(() => ({
        scrollRef: codeScrollRef,
        contentRef: codeScrollContentRef,
        offsetRef: codeScrollOffsetRef,
    }), []);
    const intraLineDiff = useIntraLineWordDiffConfig();
    const { width: viewportWidth } = useWindowDimensions();
    const effectiveWrapLines = wrapLines ?? true;
    const effectiveShowLineNumbers = showLineNumbers ?? true;
    const effectiveShowPrefix = showPrefix ?? effectiveShowLineNumbers;
    const markdownPreviewHorizontalPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_HORIZONTAL_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;
    const markdownPreviewTopPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_TOP_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;
    const markdownPreviewBottomPadding = viewportWidth >= MARKDOWN_PREVIEW_WIDE_VIEWPORT_WIDTH
        ? MARKDOWN_PREVIEW_WIDE_BOTTOM_PADDING
        : MARKDOWN_PREVIEW_COMPACT_PADDING;

    // Only web observes blocks: native prose must share one text view for cross-paragraph selection.
    const markdownReading = useMarkdownReadingAnchor(`${_sessionId}:${filePath}:${displayMode}`, markdownPreviewTopPadding);

    const commentSource: ReviewCommentSource = displayMode === 'diff' ? 'diff' : 'file';
    const draftsForThisView = React.useMemo(() => {
        return filterReviewCommentDraftsForFile({
            enabled: reviewCommentsEnabled === true,
            filePath,
            source: commentSource,
            drafts: reviewCommentDrafts ?? [],
        });
    }, [commentSource, filePath, reviewCommentDrafts, reviewCommentsEnabled]);
    const reviewCommentControlsEnabled = reviewCommentsEnabled === true
        && (reviewCommentModeActive === true || draftsForThisView.length > 0);

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
    const reviewCommentLineActionsEnabled = reviewCommentsEnabled === true
        && reviewCommentModeActive === true
        && Boolean(reviewCommentControls);
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

    const markdownHighlightRange = React.useMemo<MarkdownSourceRange | null>(() => {
        if (displayMode !== 'markdown') return null;
        const anchor = jumpToAnchor ?? null;
        if (!anchor) return null;
        if (anchor.kind === 'fileLine') return { startLine: anchor.startLine, endLine: anchor.startLine };
        if (anchor.kind === 'line') return { startLine: anchor.line, endLine: anchor.line };
        if (anchor.kind === 'range') return { startLine: anchor.startLine, endLine: anchor.endLine };
        return null;
    }, [displayMode, jumpToAnchor]);

    const scrollToLineId = useFileContentScrollTarget(jumpHighlight?.scrollToLineId, find);

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
            <View style={{ marginTop: 6, marginBottom: 8, gap: 6 }}>
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

    const codeLineInteractionMode = lineSelectionEnabled
        ? 'commitSelection'
        : reviewCommentLineActionsEnabled
            ? 'comment'
            : 'read';

    const { lineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();
    const virtualized = React.useMemo(() => {
        if (!reviewCommentControlsEnabled) return true;
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
    }, [byteThreshold, diffContent, displayMode, fileContent, lineThreshold, reviewCommentControlsEnabled]);

    const fileCodeView = fileContent && displayMode === 'file'
        ? (
            <CodeLinesView
                lines={lines}
                interactionMode={codeLineInteractionMode}
                rangeSelectionActive={rangeSelectionActive}
                onPressLine={reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                onPressLineRange={reviewCommentLineActionsEnabled ? handlePressLineRange : undefined}
                pressLineWhenNotSelectable={reviewCommentLineActionsEnabled}
                onPressAddComment={reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                isCommentActive={reviewCommentControls?.isCommentActive}
                renderAfterLine={reviewCommentControls?.renderAfterLine}
                contentPaddingHorizontal={16}
                contentPaddingVertical={16}
                externalScrollView={!virtualized && Platform.OS !== 'web' ? externalCodeScrollView : undefined}
                virtualized={virtualized}
                scrollToLineId={scrollToLineId}
                findRangesByLineId={find?.lineRanges}
                highlightLineId={jumpHighlight?.scrollToLineId}
                highlightLineIds={jumpHighlight?.highlightLineIds}
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
        ? (jumpHighlight ? false : virtualized)
        : virtualized;
    const diffViewer = displayMode === 'diff' && typeof diffContent === 'string'
        ? (
            <DiffViewer
                mode="unified"
                filePath={filePath}
                unifiedDiff={diffContent}
                selectedLineIds={selectedLineIds}
                interactionMode={codeLineInteractionMode}
                rangeSelectionActive={rangeSelectionActive}
                onPressLine={lineSelectionEnabled ? handlePressLine : reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                onPressLineRange={lineSelectionEnabled || reviewCommentLineActionsEnabled ? handlePressLineRange : undefined}
                pressLineWhenNotSelectable={!lineSelectionEnabled && reviewCommentLineActionsEnabled}
                onPressAddComment={reviewCommentLineActionsEnabled ? reviewCommentControls?.onPressAddComment : undefined}
                isCommentActive={reviewCommentControls?.isCommentActive}
                renderAfterLine={reviewCommentControls?.renderAfterLine}
                contentPaddingHorizontal={16}
                contentPaddingVertical={16}
                externalScrollView={!effectiveDiffVirtualized && Platform.OS !== 'web' ? externalCodeScrollView : undefined}
                virtualized={effectiveDiffVirtualized}
                scrollToLineId={scrollToLineId}
                findActive={find?.open}
                findRangesByLineId={find?.lineRanges}
                highlightLineId={jumpHighlight?.scrollToLineId}
                highlightLineIds={jumpHighlight?.highlightLineIds}
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
            onLayout={onLayout}
            onContentSizeChange={onContentSizeChange}
            onScroll={(event) => {
                codeScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                onScroll?.(event);
            }}
            scrollEventThrottle={16}
        >
            {children}
        </ScrollView>
    );
    const renderFileCode = () => {
        const content = effectiveWrapLines ? fileCodeView : (
            <HorizontalOverflowScrollView
                showsHorizontalScrollIndicator={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                {fileCodeView}
            </HorizontalOverflowScrollView>
        );
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
                            <MarkdownView
                                testID="file-markdown-preview"
                                markdown={fileContent}
                                sourceRangeLayoutObserver={Platform.OS === 'web' || find?.open ? markdownReading.observer : undefined}
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
                            padding: 16,
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
                            padding: 16,
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
                        padding: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.noChanges')}
                </Text>
            )}
        </View>
    );
}

export const FileContentPanel = React.memo(FileContentPanelInner, areFileContentPanelPropsEqual);
FileContentPanel.displayName = 'FileContentPanel';
