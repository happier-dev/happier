import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { Platform, StyleSheet, View } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveFilePageMediaFacts } from '@/components/workspaces/files/file/filePageMediaFacts';
import { workspaceStatFile } from '@/sync/ops/workspaceFileSystem';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useDiffHunkTable } from '@/components/ui/code/diff/hunks/useDiffHunkTable';
import type { DiffHunkInfo, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { DiffReviewCommentsViewer } from '@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { ImageCompare } from './imageCompare/ImageCompare';
import { useImageCompare, type ImageCompareSource } from './imageCompare/useImageCompare';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { FileViewerClass } from '@/scm/utils/filePresentation';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';
import type { HunkReviewControllerParams } from './hunkReview/useHunkReviewController';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';

/** Keep / Discard on a Review file's changes (P5): the list's checkout and its one discard owner. */
export type ReviewBlockHunkReview = Readonly<Pick<HunkReviewControllerParams, 'source' | 'host' | 'serverId' | 'onDiscard'
    | 'discardDisabledReason' | 'undo' | 'onReviewAction' | 'onAsk' | 'onOutOfDate' | 'marks'>>;

export type ReviewDiffState = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
    errorCode?: string;
    /** Loaded: a new file with no bytes. */
    emptyFile?: boolean;
    /** Find-only bytes of this patch's before revision; never working-tree substitution. */
    context?: Readonly<{ status: 'loading' | 'unavailable' }> | Readonly<{ status: 'loaded'; baseText: string }>;
}>;

export type ChangedFilesReviewDiffBlockProps = Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    filePath: string;
    isBinaryContent?: boolean;
    estimatedChangedLines?: number | null;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    scrollToLineId?: string;
    findModel?: ChangedFilesReviewFindModel;
    findActive?: boolean;
    /** Edge to edge under the file header, without the inset rounded frame (the comparison stream). */
    flat?: boolean;
    evidenceOnly?: boolean;
    /** Before/after facts for a changed image (Review wells); absent shows the current picture alone. */
    imageCompare?: ImageCompareSource | null;
    /** Opens this file's File page (a changed recording plays there). */
    onOpenFile?: (filePath: string) => void;
    hunkNotes?: Readonly<{
        placement: 'column' | 'inline';
        columnWidth: number;
        render: (path: string, hunkIndex: number, placement: 'column' | 'inline') => React.ReactNode;
    }> | null;
    /** Hunk rows with Keep / Discard (absent: notes and navigation only). */
    hunkReview?: DiffViewerHunks | null;
    reviewUnits?: readonly ReviewUnit[];
}>;

function buildDiffDraftsSignature(filePath: string, drafts: readonly ReviewCommentDraft[]): string {
    let signature = '';
    for (const draft of drafts) {
        if (draft.filePath !== filePath || draft.source !== 'diff') continue;
        signature += `${draft.id}\u0000${draft.body}\u0000${draft.includeInPrompt === false ? '0' : '1'}\u0000${draft.createdAt}\u0000`;
        signature += `${JSON.stringify(draft.anchor)}\u0000${JSON.stringify(draft.snapshot)}\u0000`;
    }
    return signature;
}

/** The comparison stream draws diffs edge to edge under their file header (lab WT8). */
const FLAT_BLOCK_STYLE = { paddingHorizontal: 0, paddingVertical: 0 } as const;
const FLAT_DIFF_FRAME_STYLE = { overflow: 'hidden' } as const;

function areChangedFilesReviewDiffBlockPropsEqual(
    prev: ChangedFilesReviewDiffBlockProps,
    next: ChangedFilesReviewDiffBlockProps,
): boolean {
    if (
        prev.theme !== next.theme
        || prev.sessionId !== next.sessionId
        || prev.snapshotSignature !== next.snapshotSignature
        || prev.workspaceScope !== next.workspaceScope
        || prev.filePath !== next.filePath
        || prev.isBinaryContent !== next.isBinaryContent
        || prev.estimatedChangedLines !== next.estimatedChangedLines
        || prev.diffStateSource !== next.diffStateSource
        || prev.reviewCommentsEnabled !== next.reviewCommentsEnabled
        || prev.onUpsertReviewCommentDraft !== next.onUpsertReviewCommentDraft
        || prev.onDeleteReviewCommentDraft !== next.onDeleteReviewCommentDraft
        || prev.scrollToLineId !== next.scrollToLineId
        || prev.findModel !== next.findModel
        || prev.findActive !== next.findActive
        || prev.onScrollToLine !== next.onScrollToLine
        || prev.externalScrollView !== next.externalScrollView
        || prev.onReviewCommentError !== next.onReviewCommentError
        || prev.flat !== next.flat
        || prev.evidenceOnly !== next.evidenceOnly
        || prev.imageCompare !== next.imageCompare
        || prev.onOpenFile !== next.onOpenFile
        || prev.hunkNotes !== next.hunkNotes
        || prev.hunkReview !== next.hunkReview
        || prev.reviewUnits !== next.reviewUnits
    ) {
        return false;
    }

    if (prev.reviewCommentDrafts === next.reviewCommentDrafts) return true;
    if (!prev.reviewCommentsEnabled) return true;

    return buildDiffDraftsSignature(prev.filePath, prev.reviewCommentDrafts)
        === buildDiffDraftsSignature(next.filePath, next.reviewCommentDrafts);
}

/** Space between two Explain notes that would otherwise touch in the column. */
const HUNK_NOTE_STACK_GAP_PX = 8;

/**
 * Where a hunk starts, for the Explain column (lab WT8-F2). A zero-height marker after the hunk's first
 * content line, measured against the block frame. The notes themselves never render inside the diff
 * renderer: the web renderer paints only inside its own code box (`contain: content`), so anything
 * placed beside the code from in there is clipped away.
 */
function HunkNoteAnchor(props: Readonly<{
    hunkIndex: number;
    frameRef: React.RefObject<View | null>;
    generation: number;
    onMeasure: (hunkIndex: number, y: number) => void;
}>) {
    const ref = React.useRef<View>(null);
    const { frameRef, hunkIndex, onMeasure } = props;
    const measure = React.useCallback(() => {
        const node = ref.current;
        const frame = frameRef.current;
        if (!node || !frame) return;
        node.measureLayout(frame, (_x, y) => onMeasure(hunkIndex, y), () => {});
    }, [frameRef, hunkIndex, onMeasure]);
    React.useEffect(() => { measure(); }, [measure, props.generation]);
    return <View ref={ref} collapsable={false} onLayout={measure} style={{ height: 0 }} />;
}

/**
 * The Explain column beside a file's code: each hunk's notes top-aligned with the hunk's first line,
 * pushed down only when the note above is taller than the code between them. Returns the column and
 * the height it needs, so the block never lets a note run into the next file.
 */
function useHunkNotesColumn(input: Readonly<{
    filePath: string;
    hunkNotes: NonNullable<ChangedFilesReviewDiffBlockProps['hunkNotes']>;
    tops: ReadonlyMap<number, number>;
    borderColor: string;
}>): Readonly<{ column: React.ReactNode; minHeight: number }> {
    const [heights, setHeights] = React.useState<ReadonlyMap<number, number>>(() => new Map());
    const onNoteLayout = React.useCallback((hunkIndex: number, height: number) => {
        setHeights((current) => current.get(hunkIndex) === height ? current : new Map(current).set(hunkIndex, height));
    }, []);
    let cursor = 0;
    const notes: React.ReactNode[] = [];
    for (const [hunkIndex, anchorY] of [...input.tops.entries()].sort((a, b) => a[0] - b[0])) {
        const node = input.hunkNotes.render(input.filePath, hunkIndex, 'column');
        if (!node) continue;
        const top = Math.max(anchorY - CODE_LINE_BASE_HEIGHT, cursor);
        cursor = top + (heights.get(hunkIndex) ?? 0) + HUNK_NOTE_STACK_GAP_PX;
        notes.push(
            <View key={hunkIndex} style={{ position: 'absolute', top, left: 0, right: 0 }}
                onLayout={(event) => onNoteLayout(hunkIndex, event.nativeEvent.layout.height)}>
                {node}
            </View>,
        );
    }
    const column = (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: input.hunkNotes.columnWidth,
            borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: input.borderColor }}>
            {notes}
        </View>
    );
    return { column, minHeight: cursor };
}

export const ChangedFilesReviewDiffBlock = React.memo((props: ChangedFilesReviewDiffBlockProps) => {
    const { theme, sessionId, filePath, snapshotSignature } = props;
    const registerFindRefold = React.useCallback((refold: NonNullable<FindController['refold']>) =>
        props.findModel?.registerRefold(filePath, refold), [filePath, props.findModel]);
    const findSnapshot = React.useSyncExternalStore(
        React.useCallback((listener) => props.findModel?.subscribeFile(filePath, listener) ?? (() => {}), [filePath, props.findModel]),
        () => props.findModel?.getFileSnapshot(filePath),
    );
    const findRangesByLineId = findSnapshot?.ranges;
    const findLines = props.findActive ? findSnapshot?.lines : undefined;
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(filePath, listener), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
    );
    const noOverflowAnchor = Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as any) : null;
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(filePath), [filePath]);
    const blockTestId = `scm-review-diff-${testIdSafePath}`;

    const diffLoaded = state.status === 'loaded';
    const findContextBaseText = props.findActive && state.context?.status === 'loaded' ? state.context.baseText : undefined;
    const hunkTable = useDiffHunkTable({ mode: 'unified', filePath, unifiedDiff: state.diff }, Boolean(props.hunkNotes || props.scrollToLineId));
    const columnNotes = props.hunkNotes?.placement === 'column' ? props.hunkNotes : null;
    const frameRef = React.useRef<View>(null);
    const [noteTops, setNoteTops] = React.useState<ReadonlyMap<number, number>>(() => new Map());
    const [measureGeneration, setMeasureGeneration] = React.useState(0);
    const onAnchorMeasure = React.useCallback((hunkIndex: number, y: number) => {
        setNoteTops((current) => current.get(hunkIndex) === y ? current : new Map(current).set(hunkIndex, y));
    }, []);
    const onFrameLayout = React.useCallback(() => setMeasureGeneration((value) => value + 1), []);
    const renderNote = React.useCallback((hunk: DiffHunkInfo) => {
        const hunkIndex = hunk.hunkIndex;
        // Explain notes describe the captured git hunk, even when it contains several review units.
        if (!props.hunkNotes || hunkTable.hunks[hunk.index - 1]?.hunkIndex === hunkIndex) return null;
        if (props.hunkNotes.placement === 'column') {
            return <HunkNoteAnchor hunkIndex={hunkIndex} frameRef={frameRef} generation={measureGeneration} onMeasure={onAnchorMeasure} />;
        }
        return props.hunkNotes.render(filePath, hunkIndex, props.hunkNotes.placement);
    }, [filePath, measureGeneration, hunkTable.hunks, onAnchorMeasure, props.hunkNotes]);
    const hunks = React.useMemo<DiffViewerHunks | undefined>(() => {
        if (!props.hunkNotes && !props.scrollToLineId) return undefined;
        const currentIndex = hunkTable.hunks.findIndex((hunk) => hunk.revealLineId === props.scrollToLineId);
        return { currentIndex: currentIndex < 0 ? null : currentIndex, renderNote: props.hunkNotes ? renderNote : undefined };
    }, [hunkTable.hunks, props.hunkNotes, props.scrollToLineId, renderNote]);
    const reviewHunks = React.useMemo(() => props.hunkReview
        ? props.hunkNotes ? { ...props.hunkReview, renderNote } : props.hunkReview
        : hunks, [props.hunkReview, props.hunkNotes, renderNote, hunks]);
    const notesColumn = useHunkNotesColumn({ filePath, hunkNotes: columnNotes ?? EMPTY_COLUMN_NOTES, tops: columnNotes ? noteTops : EMPTY_NOTE_TOPS,
        borderColor: theme.colors.border.default });
    const noteColumnStyle = columnNotes ? { paddingRight: columnNotes.columnWidth, minHeight: notesColumn.minHeight } : null;
    const hasDiff = diffLoaded && Boolean(state.diff);
    const fileViewer = resolveFileViewerKind({ path: filePath, isBinaryContent: props.isBinaryContent });
    const fileIsBinary = fileViewer.kind !== 'code' && fileViewer.kind !== 'markdown' && fileViewer.kind !== 'svg';
    const fileIsImage = fileViewer.kind === 'image' || fileViewer.kind === 'svg';

    const imagePreviewInput: UseFilePreviewSourceInput = {
        source: props.workspaceScope ? { kind: 'workspace', scope: props.workspaceScope, filePath }
            : { kind: 'session', sessionId, filePath },
        ...(props.workspaceScope ? buildWorkspacePreviewIdentity(props.workspaceScope, filePath, null, snapshotSignature)
            : { cacheKey: snapshotSignature }),
        mimeType: fileViewer.mimeType,
        // Workspace images read through `ImageCompare`; only a Session-only image needs this preview.
        enabled: props.evidenceOnly !== true && diffLoaded && !state.diff && fileIsImage && !props.workspaceScope,
    };
    const imagePreview = useFilePreviewSource(imagePreviewInput);
    // An SVG change reads as pictures and as text (lab files RV1v).
    const svgPictures = fileViewer.kind === 'svg' && props.workspaceScope && props.imageCompare ? (
        <ReviewBlockImageCompare scope={props.workspaceScope} filePath={filePath} viewer={fileViewer}
            source={props.imageCompare} signature={snapshotSignature} testID="scm-review-svg-preview" />
    ) : null;

    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = usePresentationWindowDimensions();
    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);
    const effectiveWrapLines = wrapLines !== false;
    const effectiveShowLineNumbers = showLineNumbers !== false;

    const estimatedChangedLines = React.useMemo(() => {
        const raw = props.estimatedChangedLines;
        if (raw === null || raw === undefined) return null;
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
        return Math.max(0, Math.floor(raw));
    }, [props.estimatedChangedLines]);

    const virtualized = React.useMemo(() => {
        if (props.reviewCommentsEnabled) return false;
        if (!state.diff) return false;
        return resolveInlineDiffVirtualization({
            unifiedDiff: state.diff,
            oldText: null,
            newText: null,
            lineThreshold: virtualizationLineThreshold,
            byteThreshold: virtualizationByteThreshold,
        });
    }, [props.reviewCommentsEnabled, state.diff, virtualizationByteThreshold, virtualizationLineThreshold]);

    const diffContainerStyle = virtualized ? resolveInlineDiffVirtualizedViewportStyle(maxVirtualizedHeight) : null;
    const shouldReserveVirtualizedHeightWhileLoading = React.useMemo(() => {
        if (props.reviewCommentsEnabled) return false;
        const estimated = estimatedChangedLines;
        if (estimated === null) return false;
        return estimated >= virtualizationLineThreshold;
    }, [estimatedChangedLines, props.reviewCommentsEnabled, virtualizationLineThreshold]);
    // Reserve height during loading for large diffs so rows don't "grow" once a diff arrives
    // (which can cause scroll jumps in virtualized lists). Avoid reserving the large virtualized
    // height for small diffs to prevent stale layout caches from leaving large whitespace gaps.
    const loadingContainerStyle = shouldReserveVirtualizedHeightWhileLoading ? { height: maxVirtualizedHeight } : null;

    if (state.status === 'loading' || state.status === 'idle') {
        return (
            <View testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor]}>
                <View
                    style={[
                        props.flat
                            ? { alignItems: 'center', justifyContent: 'center', paddingVertical: theme.space.s12 }
                            : {
                                borderRadius: 12,
                                overflow: 'hidden',
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                alignItems: 'center',
                                justifyContent: 'center',
                            },
                        loadingContainerStyle,
                    ]}
                >
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </View>
        );
    }
    if (state.status === 'error') {
        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                    {state.error ?? t('files.reviewUnableToLoadDiff')}
                </Text>
            </View>
        );
    }
    if (!state.diff || fileViewer.kind === 'image') {
        if (fileIsImage) {
            // Workspace images compare as images (one owner: `ImageCompare`, P5 modes).
            if (props.workspaceScope && props.imageCompare) {
                return (
                    <View testID={blockTestId} style={noOverflowAnchor}>
                        <ReviewBlockImageCompare scope={props.workspaceScope} filePath={filePath} viewer={fileViewer}
                            source={props.imageCompare} signature={snapshotSignature} testID="scm-review-image-preview" />
                    </View>
                );
            }

            if (imagePreview.status === 'loading') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                );
            }

            if (imagePreview.status === 'error') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                        <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                            {imagePreview.error}
                        </Text>
                    </View>
                );
            }
        }

        if (fileViewer.kind === 'video' || fileViewer.kind === 'audio') {
            // Recognised media wins over git's binary flag (P2 §3.2): a changed recording names its kind and
            // size, and opens the File page that plays it.
            return (
                <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                    <ReviewBlockMediaLine filePath={filePath} viewer={fileViewer} scope={props.workspaceScope ?? null}
                        present={props.imageCompare ? !isDeletedSource(props.imageCompare) : true} onOpenFile={props.onOpenFile} />
                </View>
            );
        }

        if (fileIsBinary) {
            return (
                <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                    <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                        {t('files.binaryFile')}
                    </Text>
                </View>
            );
        }

        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                    {state.emptyFile ? t('files.emptyFile') : t('files.noChanges')}
                </Text>
            </View>
        );
    }

    if (props.reviewCommentsEnabled) {
        return (
            <View ref={frameRef} collapsable={false} onLayout={columnNotes ? onFrameLayout : undefined} testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor, noteColumnStyle]}>
            {svgPictures}
                <DiffReviewCommentsViewer
                    findActive={props.findActive}
                    precomputedLines={findLines}
                    contextBaseText={findContextBaseText}
                    registerFindRefold={registerFindRefold}
                    findRangesByLineId={findRangesByLineId}
                    hunks={reviewHunks}
                    reviewUnits={props.reviewUnits}
                    scrollToLineId={props.scrollToLineId}
                    highlightLineId={props.scrollToLineId}
                    onScrollToLine={props.onScrollToLine}
                    externalScrollView={props.externalScrollView}
                    filePath={filePath}
                    unifiedDiff={state.diff}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={props.reviewCommentDrafts}
                    wrapLines={effectiveWrapLines}
                    showLineNumbers={effectiveShowLineNumbers}
                    onUpsertReviewCommentDraft={props.onUpsertReviewCommentDraft}
                    onDeleteReviewCommentDraft={props.onDeleteReviewCommentDraft}
                    onReviewCommentError={props.onReviewCommentError}
                />
                {columnNotes ? notesColumn.column : null}
            </View>
        );
    }

    return (
            <View ref={frameRef} collapsable={false} onLayout={columnNotes ? onFrameLayout : undefined} testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor, noteColumnStyle]}>
            {svgPictures}
            <View style={[props.flat ? FLAT_DIFF_FRAME_STYLE : { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border.default }, diffContainerStyle]}>
                <DiffViewer
                    findActive={props.findActive}
                    precomputedLines={findLines}
                    contextBaseText={findContextBaseText}
                    registerFindRefold={registerFindRefold}
                    findRangesByLineId={findRangesByLineId}
                    hunks={reviewHunks}
                    reviewUnits={props.reviewUnits}
                    scrollToLineId={props.scrollToLineId}
                    highlightLineId={props.scrollToLineId}
                    onScrollToLine={props.onScrollToLine}
                    externalScrollView={props.externalScrollView}
                    mode="unified"
                    unifiedDiff={state.diff}
                    filePath={filePath}
                    wrapLines={effectiveWrapLines}
                    showLineNumbers={effectiveShowLineNumbers}
                    virtualized={virtualized}
                />
            </View>
            {columnNotes ? notesColumn.column : null}
        </View>
    );
}, areChangedFilesReviewDiffBlockPropsEqual);

const EMPTY_NOTE_TOPS: ReadonlyMap<number, number> = new Map();
const EMPTY_COLUMN_NOTES: NonNullable<ChangedFilesReviewDiffBlockProps['hunkNotes']> = { placement: 'column', columnWidth: 0, render: () => null };

function isDeletedSource(source: ImageCompareSource): boolean {
    return (source.kind === 'captured' ? source.file.changeKind : source.changeKind) === 'deleted';
}

/** A changed recording in Review: its kind and size on one quiet line that opens the File page's player. */
function ReviewBlockMediaLine(props: Readonly<{
    filePath: string;
    viewer: FileViewerClass;
    scope: WorkspaceScopeBase | null;
    /** The file is still on disk (not deleted), so its size can be read. */
    present: boolean;
    onOpenFile?: (filePath: string) => void;
}>) {
    const { theme } = useUnistyles();
    const [sizeBytes, setSizeBytes] = React.useState<number | null>(null);
    const { scope, filePath, present } = props;
    const serverId = scope?.serverId;
    const machineId = scope?.machineId;
    const rootPath = scope?.rootPath;
    React.useEffect(() => {
        if (!present || !machineId || !rootPath) return;
        const controller = new AbortController();
        void workspaceStatFile({ serverId, machineId, rootPath }, filePath, { signal: controller.signal }).then((stat) => {
            if (!controller.signal.aborted && stat.success && stat.exists && typeof stat.sizeBytes === 'number') setSizeBytes(stat.sizeBytes);
        }, () => {});
        return () => controller.abort();
    }, [present, serverId, machineId, rootPath, filePath]);
    const facts = resolveFilePageMediaFacts({ viewer: props.viewer, sizeBytes }).join(' · ');
    const glyph = props.viewer.kind === 'video' ? 'video-camera' : 'waveform';
    const line = (hovered: boolean) => (
        <>
            <Icon name={glyph} size={ICON_SIZE.xs} color={hovered ? theme.colors.text.primary : theme.colors.text.secondary} />
            <Text style={{ ...Typography.variant('meta'), color: hovered ? theme.colors.text.primary : theme.colors.text.secondary, fontVariant: ['tabular-nums'] }}>
                {facts}
            </Text>
        </>
    );
    const onOpenFile = props.onOpenFile;
    const rowStyle = [mediaLineStyles.row, { gap: theme.space.s6 }];
    if (!onOpenFile) return <View testID="scm-review-media-line" style={rowStyle}>{line(false)}</View>;
    return (
        <HappierPressable testID="scm-review-media-open" accessibilityRole="link" accessibilityLabel={`${filePath.split('/').pop() ?? filePath} · ${facts}`}
            onPress={() => onOpenFile(filePath)}
            style={(state) => [rowStyle, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
            {(state) => line(state.hovered || state.focused)}
        </HappierPressable>
    );
}

const mediaLineStyles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
});

/** Review's changed image through the one compare owner; a live working tree compares HEAD with the file. */
function ReviewBlockImageCompare(props: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    viewer: FileViewerClass;
    source: ImageCompareSource;
    signature: string | null;
    testID: string;
}>) {
    const compare = useImageCompare({
        enabled: true,
        scope: props.scope,
        filePath: props.filePath,
        source: props.source,
    });
    const stage = useMediaStage();
    const openStage = (side: 'before' | 'after') => {
        const index = side === 'before' ? compare.beforeGalleryIndex : compare.afterGalleryIndex;
        if (index !== null) stage.open(compare.gallery, index);
    };
    return (
        <ImageCompare
            testID={props.testID}
            filePath={props.filePath}
            kind={props.viewer.kind === 'svg' ? 'svg' : 'image'}
            alphaCapable={props.viewer.alphaCapable}
            before={compare.before}
            after={compare.after}
            beforePreviewInput={compare.beforePreviewInput}
            afterPreviewInput={compare.afterPreviewInput}
            onRetry={compare.retry}
            {...(compare.gallery.length > 0 ? { onOpenStage: openStage } : {})}
        />
    );
}
