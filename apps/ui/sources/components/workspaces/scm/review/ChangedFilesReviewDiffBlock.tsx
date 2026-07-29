import * as React from 'react';
import { Image, Platform, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
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
        || prev.onReviewCommentError !== next.onReviewCommentError
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
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(filePath, listener), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
    );
    const noOverflowAnchor = Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as any) : null;
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(filePath), [filePath]);
    const blockTestId = `scm-review-diff-${testIdSafePath}`;

    const diffLoaded = state.status === 'loaded';
    const hasDiff = diffLoaded && Boolean(state.diff);
    const fileIsBinary = isKnownBinaryPath(filePath);
    const fileIsImage = isKnownImagePath(filePath);

    const imagePreview = useChangedFilesReviewImagePreview({
        sessionId,
        snapshotSignature,
        filePath,
        enabled: diffLoaded && !state.diff && fileIsImage,
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
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor]}>
                <View
                    style={[
                        {
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
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor]}>
                <DiffReviewCommentsViewer
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
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 8 }, noOverflowAnchor]}>
            <View style={[{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border.default }, diffContainerStyle]}>
                <DiffViewer
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
