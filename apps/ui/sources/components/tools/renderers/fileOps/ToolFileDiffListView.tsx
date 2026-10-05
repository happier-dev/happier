import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolViewProps } from '../core/_registry';
import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffFilesListView, type DiffFilesListViewHandle, type DiffFileFindState } from '@/components/ui/code/diff/DiffFilesListView';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
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
import { useToolFindState } from '../core/ToolFindText';
import { buildToolFileDiffLines, toolDiffContextLines, toolDiffFindProps } from './toolDiffDisplayText';
export { projectToolFileDiffDisplayText } from './toolDiffDisplayText';

export type ToolFileDiffListViewProps = Readonly<{
    files: readonly DiffFileEntry[];
    detailLevel?: ToolViewProps['detailLevel'];
    sessionId?: string | null;
    serverId?: string | null;
    messageId?: string;
    findBlockPrefix?: string;
}>;

export const ToolFileDiffListView = React.memo<ToolFileDiffListViewProps>(({
    files,
    detailLevel,
    sessionId: sessionIdProp,
    serverId,
    messageId,
    findBlockPrefix = 'tool-diff',
}) => {
    const find = useToolFindState(messageId);
    const listRef = React.useRef<DiffFilesListViewHandle>(null);
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
    const findStates = React.useMemo(() => {
        const states = new Map<string, DiffFileFindState>();
        if (!find.active) return states;
        files.forEach((file, index) => {
            const prefix = `${findBlockPrefix}-${index}`;
            const lines = buildToolFileDiffLines(file);
            states.set(file.key, {
                findActive: true, ...toolDiffFindProps(lines, prefix, find.ranges),
                pathRanges: find.ranges(`${prefix}-path`),
                statsRanges: find.ranges(`${prefix}-stats`),
                kindRanges: find.ranges(`${prefix}-kind`),
                contextLines: toolDiffContextLines(file.oldText ?? '', file.newText ?? ''),
            });
        });
        return states;
    }, [files, findBlockPrefix, find.active, find.blocks]);
    const currentFileIndex = files.findIndex((file) => {
        const state = findStates.get(file.key);
        return state?.scrollToLineId !== undefined || [state?.pathRanges, state?.statsRanges, state?.kindRanges].some((ranges) => ranges?.some((range) => range.current));
    });
    const currentFileKey = files[currentFileIndex]?.key;
    React.useEffect(() => {
        if (!currentFileKey || expandedKeys.has(currentFileKey)) return;
        toggleExpanded(currentFileKey);
    }, [currentFileKey, expandedKeys, toggleExpanded]);
    React.useEffect(() => {
        if (currentFileIndex < 0 || !virtualizeFileList) return;
        listRef.current?.scrollToIndex({ index: currentFileIndex, animated: false });
    }, [currentFileIndex, virtualizeFileList, find.reveal?.requestId]);
    const getFindStateForFile = React.useCallback((file: DiffFileEntry) => findStates.get(file.key), [findStates]);

    const reviewCommentsFeatureEnabled = useFeatureEnabled('files.reviewComments');
    const reviewScope = useWorkspaceScopeForSession(sessionId, serverId);
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
        const showWrapLinesToggle = effectiveDetailLevel === 'full';
        const showExpandCollapse = files.length > 1;
        if (!showPresentationToggle && !showWrapLinesToggle && !showExpandCollapse) return null;

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
                {showWrapLinesToggle ? <WrapLinesToggleButton /> : null}
            </View>
        );
    }, [allExpanded, effectiveDetailLevel, files.length, setAllExpanded, showFileList]);

    useToolHeaderActions(headerActionsNode);

    if (files.length === 0) {
        return null;
    }

    if (!showFileList && !find.active) {
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
            ref={listRef}
            getFindStateForFile={find.active ? getFindStateForFile : undefined}
            files={files}
            expandedKeys={expandedKeys}
            onToggleExpanded={toggleExpanded}
            canRenderInlineDiffs={canRenderInlineDiffs || find.active}
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
