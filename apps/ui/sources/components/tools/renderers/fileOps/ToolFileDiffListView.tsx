import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolViewProps } from '../core/_registry';
import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { useDiffFilesExpansionState } from '@/components/ui/code/diff/useDiffFilesExpansionState';
import { useInlineUnifiedDiffReviewCommentsRenderer } from '@/components/ui/code/diff/reviewComments/useInlineUnifiedDiffReviewCommentsRenderer';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useToolHeaderActions } from '../../shell/presentation/ToolHeaderActionsContext';

export type ToolFileDiffListViewProps = Readonly<{
    files: readonly DiffFileEntry[];
    detailLevel?: ToolViewProps['detailLevel'];
    sessionId?: string | null;
}>;

export const ToolFileDiffListView = React.memo<ToolFileDiffListViewProps>(({
    files,
    detailLevel,
    sessionId: sessionIdProp,
}) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const wrapLines = useSetting('wrapLinesInDiffs');
    const fileListVirtualizationMinFilesSetting = useSetting('filesDiffFileListVirtualizationMinFiles');
    const sessionId = typeof sessionIdProp === 'string' && sessionIdProp.trim() ? sessionIdProp.trim() : null;
    const effectiveDetailLevel = detailLevel ?? 'summary';

    const fileListVirtualizationMinFiles = typeof fileListVirtualizationMinFilesSetting === 'number' && fileListVirtualizationMinFilesSetting > 0
        ? fileListVirtualizationMinFilesSetting
        : (settingsDefaults.filesDiffFileListVirtualizationMinFiles as number);
    const virtualizeFileList = files.length >= fileListVirtualizationMinFiles;

    const { expandedKeys, allExpanded, setAllExpanded, toggleExpanded } = useDiffFilesExpansionState({
        files,
        defaultExpanded: effectiveDetailLevel === 'full',
    });

    const canRenderInlineDiffs = effectiveDetailLevel !== 'title';
    const showFileList = effectiveDetailLevel !== 'title';

    const reviewCommentsFeatureEnabled = useFeatureEnabled('files.reviewComments');
    const reviewScope = useWorkspaceScopeForSession(sessionId);
    const reviewCommentsEnabled = reviewCommentsFeatureEnabled === true && Boolean(reviewScope);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(reviewScope);

    const renderInlineUnifiedDiff = useInlineUnifiedDiffReviewCommentsRenderer({
        enabled: reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
        onReviewCommentError: reviewDraftHandlers.onReviewCommentError,
    });

    const headerActionsNode = React.useMemo(() => {
        if (!showFileList) return null;
        const showPresentationToggle = Platform.OS === 'web';
        const showExpandCollapse = files.length > 1;
        if (!showPresentationToggle && !showExpandCollapse) return null;

        return (
            <View style={styles.headerControlsRow}>
                {showExpandCollapse ? (
                    <Pressable
                        onPress={() => setAllExpanded(!allExpanded)}
                        style={styles.headerControlButton}
                        accessibilityRole="button"
                    >
                        <Text style={styles.headerControlButtonText}>
                            {allExpanded ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: files.length })}
                        </Text>
                    </Pressable>
                ) : null}

                {showPresentationToggle ? <DiffPresentationStyleToggleButton /> : null}
            </View>
        );
    }, [allExpanded, files.length, setAllExpanded, showFileList]);

    useToolHeaderActions(headerActionsNode);

    if (files.length === 0) {
        return null;
    }

    if (!showFileList) {
        const first = files[0];
        return (
            <View style={styles.titleRow}>
                <Text style={styles.titleText}>
                    {files.length === 1
                        ? `${first.filePath ?? t('files.diff')} (+${first.added} -${first.removed})`
                        : t('tools.desc.modifyingFiles', { count: files.length })}
                </Text>
            </View>
        );
    }

    return (
        <DiffFilesListView
            files={files}
            expandedKeys={expandedKeys}
            onToggleExpanded={toggleExpanded}
            canRenderInlineDiffs={canRenderInlineDiffs}
            wrapLines={wrapLines}
            showLineNumbers={showLineNumbersInToolViews}
            showPrefix={showLineNumbersInToolViews}
            virtualizeFileList={virtualizeFileList}
            virtualizedListLayout="intrinsic"
            renderInlineUnifiedDiff={renderInlineUnifiedDiff}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    titleRow: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    titleText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        fontFamily: 'monospace',
    },
    headerControlButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    headerControlButtonText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    headerControlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
