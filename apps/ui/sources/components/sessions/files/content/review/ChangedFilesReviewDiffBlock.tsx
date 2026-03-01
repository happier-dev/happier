import * as React from 'react';
import { ActivityIndicator, Image, Platform, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { DiffReviewCommentsViewer } from '@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';

import { isKnownBinaryPath, isKnownImagePath } from '@/scm/utils/filePresentation';
import { useChangedFilesReviewImagePreview } from './useChangedFilesReviewImagePreview';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type ReviewDiffState = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
}>;

export const ChangedFilesReviewDiffBlock = React.memo((props: Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    filePath: string;
    state: ReviewDiffState;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
}>) => {
    const { theme, sessionId, filePath, state, snapshotSignature } = props;
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
    });

    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = useWindowDimensions();
    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);
    const effectiveWrapLines = wrapLines !== false;
    const effectiveShowLineNumbers = showLineNumbers !== false;

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

    const diffContainerStyle = virtualized ? { maxHeight: maxVirtualizedHeight } : null;

    if (state.status === 'loading' || state.status === 'idle') {
        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    if (state.status === 'error') {
        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
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
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
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
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                            }}
                        >
                            <Image
                                source={{ uri: imagePreview.uri }}
                                resizeMode="contain"
                                style={{ width: '100%', height: '100%' }}
                                accessibilityLabel={t('files.binaryFile')}
                            />
                        </View>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('files.binaryFile')}
                        </Text>
                    </View>
                );
            }

            if (imagePreview.status === 'error') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {imagePreview.error}
                        </Text>
                    </View>
                );
            }
        }

        if (fileIsBinary) {
            return (
                <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.binaryFile')}
                    </Text>
                </View>
            );
        }

        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: 16, paddingVertical: 12 }, noOverflowAnchor]}>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
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
            <View style={[{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.divider }, diffContainerStyle]}>
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
});
