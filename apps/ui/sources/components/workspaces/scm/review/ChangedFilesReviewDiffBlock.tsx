import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';
import { Image, Platform, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { diffHunkNoteAnchors } from '@/components/ui/code/diff/diffHunkNoteAnchors';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { DiffReviewCommentsViewer } from '@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';

import { isKnownBinaryPath, isKnownImagePath } from '@/scm/utils/filePresentation';
import { useChangedFilesReviewImagePreview } from './useChangedFilesReviewImagePreview';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';

export type ReviewDiffState = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
}>;

export type ChangedFilesReviewDiffBlockProps = Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    filePath: string;
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
    hunkNotes?: Readonly<{
        placement: 'column' | 'inline';
        columnWidth: number;
        render: (path: string, hunkIndex: number, placement: 'column' | 'inline') => React.ReactNode;
    }> | null;
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
        || prev.hunkNotes !== next.hunkNotes
    ) {
        return false;
    }

    if (prev.reviewCommentDrafts === next.reviewCommentDrafts) return true;
    if (!prev.reviewCommentsEnabled) return true;

    return buildDiffDraftsSignature(prev.filePath, prev.reviewCommentDrafts)
        === buildDiffDraftsSignature(next.filePath, next.reviewCommentDrafts);
}

export const ChangedFilesReviewDiffBlock = React.memo((props: ChangedFilesReviewDiffBlockProps) => {
    const { theme, sessionId, filePath, snapshotSignature } = props;
    const findRangesByLineId = React.useSyncExternalStore(
        React.useCallback((listener) => props.findModel?.subscribeFile(filePath, listener) ?? (() => {}), [filePath, props.findModel]),
        () => props.findModel?.getFileSnapshot(filePath).ranges,
    );
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(filePath, listener), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
    );
    const noOverflowAnchor = Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as any) : null;
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(filePath), [filePath]);
    const blockTestId = `scm-review-diff-${testIdSafePath}`;

    const diffLoaded = state.status === 'loaded';
    const noteAnchors = React.useMemo(() => props.hunkNotes
        ? diffHunkNoteAnchors(state.diff, props.hunkNotes.placement) : null, [state.diff, props.hunkNotes]);
    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const hunkIndex = noteAnchors?.get(line.id);
        if (hunkIndex === undefined || !props.hunkNotes) return null;
        const notes = props.hunkNotes.render(filePath, hunkIndex, props.hunkNotes.placement);
        if (!notes || props.hunkNotes.placement === 'inline') return notes;
        return <View style={{ height: 0, overflow: 'visible' }}>
            <View style={{ position: 'absolute', left: '100%', top: -CODE_LINE_BASE_HEIGHT, width: props.hunkNotes.columnWidth }}>{notes}</View>
        </View>;
    }, [filePath, noteAnchors, props.hunkNotes]);
    const noteColumnStyle = props.hunkNotes?.placement === 'column'
        ? { paddingRight: props.hunkNotes.columnWidth, overflow: 'visible' as const } : null;
    const hasDiff = diffLoaded && Boolean(state.diff);
    const fileIsBinary = isKnownBinaryPath(filePath);
    const fileIsImage = isKnownImagePath(filePath);

    const imagePreview = useChangedFilesReviewImagePreview({
        sessionId,
        snapshotSignature,
        filePath,
        enabled: props.evidenceOnly !== true && diffLoaded && !state.diff && fileIsImage,
        workspaceScope: props.workspaceScope ?? null,
    });

    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = useWindowDimensions();
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
            <View testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor]}>
                <View
                    style={[
                        props.flat
                            ? { alignItems: 'center', justifyContent: 'center', paddingVertical: 12 }
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
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {state.error ?? t('files.reviewUnableToLoadDiff')}
                </Text>
            </View>
        );
    }
    if (!state.diff) {
        if (fileIsImage) {
            if (imagePreview.status === 'loading') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                );
            }

            if (imagePreview.status === 'loaded') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12, gap: 10 }, noOverflowAnchor]}>
                        <View
                            style={{
                                width: '100%',
                                maxWidth: 860,
                                height: 280,
                                borderRadius: 12,
                                overflow: 'hidden',
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                            }}
                        >
                            <Image
                                source={{ uri: imagePreview.uri }}
                                resizeMode="contain"
                                style={{ width: '100%', height: '100%' }}
                                accessibilityLabel={t('files.binaryFile')}
                            />
                        </View>
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.binaryFile')}
                        </Text>
                    </View>
                );
            }

            if (imagePreview.status === 'error') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {imagePreview.error}
                        </Text>
                    </View>
                );
            }
        }

        if (fileIsBinary) {
            return (
                <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                    <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                        {t('files.binaryFile')}
                    </Text>
                </View>
            );
        }

        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('files.noChanges')}
                </Text>
            </View>
        );
    }

    if (props.reviewCommentsEnabled) {
        return (
            <View testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor, noteColumnStyle]}>
                <DiffReviewCommentsViewer
                    findActive={props.findActive}
                    findRangesByLineId={findRangesByLineId}
                    renderAfterLine={props.hunkNotes ? renderAfterLine : undefined}
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
            </View>
        );
    }

    return (
            <View testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor, noteColumnStyle]}>
            <View style={[props.flat ? FLAT_DIFF_FRAME_STYLE : { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border.default }, diffContainerStyle, props.hunkNotes?.placement === 'column' ? { overflow: 'visible' } : null]}>
                <DiffViewer
                    findActive={props.findActive}
                    findRangesByLineId={findRangesByLineId}
                    renderAfterLine={props.hunkNotes ? renderAfterLine : undefined}
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
        </View>
    );
}, areChangedFilesReviewDiffBlockPropsEqual);
