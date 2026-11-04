import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { useUnistyles } from 'react-native-unistyles';

import { NotSourceControlRepositoryState, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { SourceControlBranchSummary } from '@/components/workspaces/scm/SourceControlBranchSummary';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { ScmChangeOverflowMenu } from '@/components/workspaces/scm/changes/ScmChangeOverflowMenu';
import { ScmCommitComposerCard } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { countCommitSelectionItems, isFileSelectedForCommit as resolveFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { resolveChangedFilesViewMode, type ChangedFilesViewMode } from '@/scm/scmAttribution';
import { storage } from '@/sync/domains/state/storage';
import { machineScmStashList } from '@/sync/ops/scm/machineScm';
import { resolveSnapshotScmStashCount, useScmStashSummaryCount } from '@/scm/stash/useScmStashSummaryCount';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';
import { applyWorkspaceFileStageAction, WorkspaceScmCommitSelectionToggleButton } from './WorkspaceScmCommitSelectionToggleButton';
import { applyWorkspaceFileDiscardAction } from './applyWorkspaceFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useWorkspaceScmCommitControls } from './useWorkspaceScmCommitControls';
import { WorkspaceScmOutcomeLine } from './WorkspaceScmOutcomeLine';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { activeReviewFileKeyForWorkspace, openChangedFileFromList, useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';

export type WorkspaceSourceControlViewProps = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    onOpenFile: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
    onSelectWorkspacePath?: (path: string) => void;
    onRequestCreateWorktreeFromAnotherBranch?: () => void;
    onRevealInFilesTree?: (fullPath: string) => void;
    listHeader?: React.ReactNode;
    listFooter?: React.ReactElement | null;
    scopeAccessory?: React.ReactNode;
    /** The full Git pane mounts the same outcome above both Changes and History. */
    hideOutcomeLine?: boolean;
}>;

const WORKSPACE_CHANGED_FILES_INITIAL_RENDER_COUNT = 12;
const WORKSPACE_CHANGED_FILES_BATCH_RENDER_COUNT = 12;
const WORKSPACE_CHANGED_FILES_WINDOW_SIZE = 5;

function matchesQuery(filePath: string, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    return filePath.toLowerCase().includes(normalizedQuery);
}

export const WorkspaceSourceControlView = React.memo((props: WorkspaceSourceControlViewProps) => {
    const { theme } = useUnistyles();
    const copyFeedback = useHappierCopyFeedback();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [requestedChangedFilesViewMode, setChangedFilesViewMode] = React.useState<ChangedFilesViewMode>('repository');
    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const {
        snapshot, loading, error, refresh,
        commitDraftMessage, setCommitDraftMessage, scmOperationBusy, scmOperationStatus,
        commitSelectionPaths, commitSelectionPatches, scmCommitStrategy, scmWriteEnabled,
        commitAllowed, commitBlockedMessage, handleCommitFromMessage, handleClearSelection, commitAdjacentPushAction,
        commitMessageGeneratorEnabled, generateCommitMessageSuggestion, cancelCommitMessageSuggestion, suggestionContextKey,
    } = useWorkspaceScmCommitControls(scope);
    const activeReviewFileKey = activeReviewFileKeyForWorkspace(scope);
    const activeReviewPath = useActiveReviewFilePath(activeReviewFileKey);
    const listRef = React.useRef<VirtualizedListRef | null>(null);
    const { scmStatusFiles, allRepositoryChangedFiles } = React.useMemo(
        () => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }),
        [snapshot],
    );

    const openFile = React.useCallback((file: ScmFileStatus) => {
        openChangedFileFromList(activeReviewFileKey, file.fullPath, props.onOpenFile);
    }, [activeReviewFileKey, props.onOpenFile]);

    const openFilePinned = React.useCallback((file: ScmFileStatus) => {
        (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath);
    }, [props]);

    const commitSelectionSet = React.useMemo(() => {
        const set = new Set<string>();
        for (const p of commitSelectionPaths) set.add(p);
        for (const patch of commitSelectionPatches) set.add(patch.path);
        return set;
    }, [commitSelectionPatches, commitSelectionPaths]);

    const commitSelectionCount = React.useMemo(() => {
        return countCommitSelectionItems({
            commitSelectionPaths,
            commitSelectionPatches,
        });
    }, [commitSelectionPatches, commitSelectionPaths]);

    const isSelectedForCommit = React.useCallback((file: ScmFileStatus) => {
        return resolveFileSelectedForCommit({
            commitStrategy: scmCommitStrategy,
            file,
            atomicSelectionPaths: commitSelectionSet,
        });
    }, [commitSelectionSet, scmCommitStrategy]);

    const selectedRepositoryChangedFiles = React.useMemo(() => {
        return allRepositoryChangedFiles.filter((file) => isSelectedForCommit(file));
    }, [allRepositoryChangedFiles, isSelectedForCommit]);

    const changedFilesViewMode = React.useMemo(() => resolveChangedFilesViewMode({
        mode: requestedChangedFilesViewMode,
        showTurnViewToggle: false,
        showSessionViewToggle: false,
        showSelectedViewToggle: selectedRepositoryChangedFiles.length > 0,
    }), [requestedChangedFilesViewMode, selectedRepositoryChangedFiles.length]);

    const currentScopeChangedFiles = React.useMemo(() => {
        if (changedFilesViewMode === 'selected') return selectedRepositoryChangedFiles;
        return allRepositoryChangedFiles;
    }, [allRepositoryChangedFiles, changedFilesViewMode, selectedRepositoryChangedFiles]);

    const filteredChangedFiles = React.useMemo(() => {
        if (!searchQuery.trim()) return currentScopeChangedFiles;
        return currentScopeChangedFiles.filter((file) => matchesQuery(file.fullPath, searchQuery));
    }, [currentScopeChangedFiles, searchQuery]);

    React.useEffect(() => {
        if (!activeReviewPath) return;
        const index = filteredChangedFiles.findIndex((file) => file.fullPath === activeReviewPath);
        if (index < 0) return;
        void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    }, [activeReviewPath, filteredChangedFiles]);

    const repositorySelectedCount = React.useMemo(() => {
        if (isAtomicCommitStrategy(scmCommitStrategy)) return commitSelectionCount;
        return filteredChangedFiles.filter((file) => isSelectedForCommit(file)).length;
    }, [commitSelectionCount, filteredChangedFiles, isSelectedForCommit, scmCommitStrategy]);

    const [selectionModeUserOn, setSelectionModeUserOn] = React.useState(false);
    const commitSelectionAvailable = scmWriteEnabled === true;
    // Selection mode is opt-in: the per-file "+" toggles stay hidden until the user taps
    // "Select files to commit". A non-empty selection forces it on so nothing is hidden.
    const selectionModeActive = commitSelectionAvailable && (selectionModeUserOn || repositorySelectedCount > 0);
    const enterSelectionMode = React.useCallback(() => setSelectionModeUserOn(true), []);
    const exitSelectionMode = React.useCallback(() => setSelectionModeUserOn(false), []);

    const branchSummaryDisabled = scmOperationBusy;
    const stashCount = useScmStashSummaryCount({
        enabled: snapshot?.capabilities?.readStash === true,
        snapshotCount: resolveSnapshotScmStashCount(snapshot),
        refreshKey: `${props.machineId}:${props.rootPath}:${snapshot?.fetchedAt ?? 0}`,
        load: React.useCallback(
            async () => await machineScmStashList(scope.machineId, { cwd: scope.rootPath }, { serverId: scope.serverId }),
            [scope],
        ),
    });

    const handleSelectAll = React.useCallback(() => {
        if (!isAtomicCommitStrategy(scmCommitStrategy)) return;
        const paths = filteredChangedFiles.map((file) => file.fullPath);
        storage.getState().markWorkspaceScmCommitSelectionPaths(scope, paths);
    }, [filteredChangedFiles, scmCommitStrategy, scope]);

    if (error && !snapshot) {
        return (
            <SourceControlUnavailableState
                details={error.message}
                errorCode={error.errorCode}
                onRetry={() => {
                    void refresh();
                }}
            />
        );
    }

    if (loading && !snapshot) {
        return <PaneLoadingFallback />;
    }

    if (snapshot && snapshot.repo.isRepo === false) {
        return <NotSourceControlRepositoryState />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {!props.hideOutcomeLine ? (
                <WorkspaceScmOutcomeLine
                    scope={scope}
                    snapshot={snapshot}
                    selectedCount={repositorySelectedCount}
                    writeEnabled={scmWriteEnabled}
                    onRefresh={refresh}
                    onShowConflicts={props.onOpenReviewAllChanges}
                />
            ) : null}
            <VirtualizedList
                ref={listRef}
                data={filteredChangedFiles}
                keyExtractor={(file) => `workspace-scm-${file.fullPath}`}
                ListHeaderComponent={(
                    <View
                        style={{
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        {props.listHeader}
                        {stashCount > 0 && props.onOpenStashDetails ? (
                            <Pressable
                                testID="workspace-scm-open-stash"
                                accessibilityRole="button"
                                accessibilityLabel={t('files.stash.summaryA11y')}
                                onPress={props.onOpenStashDetails}
                                style={({ pressed }) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: theme.space.s10,
                                    paddingHorizontal: theme.space.s12,
                                    paddingVertical: theme.space.s10,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.border.default,
                                    backgroundColor: theme.colors.surface.base,
                                    opacity: pressed ? motionTokens.press.opacitySubtle : 1,
                                })}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0, flex: 1 }}>
                                    <Icon name="archive" size={14} color={theme.colors.text.secondary} />
                                    <Text numberOfLines={1} style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary,  }}>
                                        {t('files.stash.summaryTitle')}
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 0 }}>
                                    <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                                        {String(stashCount)}
                                    </Text>
                                    <Icon name="caret-right" size={14} color={theme.colors.text.secondary} />
                                </View>
                            </Pressable>
                        ) : null}
                        {scmStatusFiles ? (
                            <SourceControlBranchSummary
                                theme={theme}
                                scmStatusFiles={scmStatusFiles}
                                variant="rail"
                                actionSlot={props.scopeAccessory}
                                branchTrigger={(
                                    <WorkspaceSourceControlBranchMenu
                                        serverId={props.serverId}
                                        machineId={props.machineId}
                                        rootPath={props.rootPath}
                                        currentBranch={scmStatusFiles.branch}
                                        snapshot={snapshot}
                                        writeEnabled={scmWriteEnabled}
                                        disabled={branchSummaryDisabled}
                                        onRefreshSnapshot={refresh}
                                        onSelectWorkspacePath={props.onSelectWorkspacePath}
                                        onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
                                    />
                                )}
                            />
                        ) : null}
                        <View style={{ paddingHorizontal: theme.space.s16, paddingTop: theme.space.s16 }}>
                            <CompactSearchField
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                placeholder={t('files.searchPlaceholder')}
                            />
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.space.s10, gap: theme.space.s10, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s12 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8, minWidth: 0, flex: 1 }}>
                                <Text style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  }}>
                                    {t('files.toolbar.changedFiles')}
                                </Text>
                                <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                                    {String(filteredChangedFiles.length)}
                                </Text>
                            </View>
                            <ChangedFilesViewModeMenu
                                theme={theme}
                                changedFilesViewMode={changedFilesViewMode}
                                showSelectedViewToggle={selectedRepositoryChangedFiles.length > 0}
                                onChangedFilesViewMode={setChangedFilesViewMode}
                            />
                            {props.onOpenReviewAllChanges ? (
                                <Pressable
                                    testID="workspace-scm-open-review"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('files.toolbar.review')}
                                    onPress={props.onOpenReviewAllChanges}
                                    style={({ pressed }) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        paddingHorizontal: theme.space.s10,
                                        height: 30,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: theme.colors.border.default,
                                        backgroundColor: theme.colors.surface.base,
                                        opacity: pressed ? motionTokens.press.opacity : 1,
                                        gap: theme.space.s6,
                                    })}
                                >
                                    <Icon name="git-diff" size={14} color={theme.colors.text.secondary} />
                                    <Text style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  }}>
                                        {t('files.toolbar.review')}
                                    </Text>
                                </Pressable>
                            ) : null}
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('common.refresh')}
                                testID="workspace-scm-refresh"
                                onPress={() => {
                                    void refresh();
                                }}
                                style={({ pressed }) => ({
                                    width: 30,
                                    height: 30,
                                    borderRadius: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.border.default,
                                    backgroundColor: theme.colors.surface.base,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    opacity: pressed ? motionTokens.press.opacity : 1,
                                })}
                            >
                                <Icon name="arrows-clockwise" size={14} color={theme.colors.text.secondary} />
                            </Pressable>
                        </View>
                    </View>
                )}
                renderItem={({ item: file, index }) => {
                    const canDiscard = scmWriteEnabled === true && snapshot?.capabilities?.writeDiscard === true;
                    const revealInTree = props.onRevealInFilesTree
                        ? () => props.onRevealInFilesTree?.(file.fullPath)
                        : undefined;
                    return (
                        <ScmChangeRow
                            activeReviewFileKey={activeReviewFileKey}
                            theme={theme}
                            file={file}
                            density="compact"
                            leadingElement={selectionModeActive ? (
                                <WorkspaceScmCommitSelectionToggleButton
                                    scope={scope}
                                    snapshot={snapshot ?? null}
                                    scmWriteEnabled={true}
                                    commitStrategy={scmCommitStrategy}
                                    file={file}
                                    selectedForCommit={isSelectedForCommit(file)}
                                    onAfterToggle={refresh}
                                />
                            ) : null}
                            onPress={() => openFile(file)}
                            onPressPinned={() => openFilePinned(file)}
                            onToggleSelection={() => {
                                void applyWorkspaceFileStageAction({
                                    scope,
                                    filePath: file.fullPath,
                                    snapshot,
                                    scmWriteEnabled: scmWriteEnabled === true,
                                    commitStrategy: scmCommitStrategy,
                                    stage: !isSelectedForCommit(file),
                                    surface: 'files',
                                    onAfterToggle: refresh,
                                });
                            }}
                            trailingElement={(
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                                    <CopiedPill
                                        visible={copyFeedback.isCopied(file.fullPath)}
                                        testID={`workspace-scm-change-copy-feedback:${file.fullPath}`}
                                    />
                                    <ScmChangeOverflowMenu
                                        title={file.fileName}
                                        filePath={file.fullPath}
                                        onCopyPathSuccess={() => copyFeedback.markCopied(file.fullPath)}
                                        onRevealInTree={revealInTree}
                                        onDiscard={canDiscard ? () => {
                                            fireAndForget(applyWorkspaceFileDiscardAction({
                                                scope,
                                                machineId: props.machineId,
                                                rootPath: props.rootPath,
                                                file,
                                                snapshot: snapshot ?? null,
                                                scmWriteEnabled: scmWriteEnabled === true,
                                                commitStrategy: scmCommitStrategy,
                                                surface: 'files',
                                                refreshAll: refresh,
                                            }), { tag: 'WorkspaceSourceControlView.discard' });
                                        } : undefined}
                                    />
                                </View>
                            )}
                            showDivider={index < filteredChangedFiles.length - 1}
                        />
                    );
                }}
                contentContainerStyle={{ paddingBottom: theme.space.s12 }}
                ListFooterComponent={props.listFooter ?? null}
                initialNumToRender={Math.min(WORKSPACE_CHANGED_FILES_INITIAL_RENDER_COUNT, filteredChangedFiles.length)}
                maxToRenderPerBatch={WORKSPACE_CHANGED_FILES_BATCH_RENDER_COUNT}
                windowSize={WORKSPACE_CHANGED_FILES_WINDOW_SIZE}
                removeClippedSubviews={Platform.OS !== 'web'}
                ListEmptyComponent={(
                    <View style={{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }}>
                        <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('meta'),  }}>
                            {t('files.noChanges')}
                        </Text>
                    </View>
                )}
            />

            {(scmWriteEnabled === true && snapshot?.capabilities?.writeCommit === true) ? (
                <View
                    style={{
                        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderTopColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.base,
                    }}
                >
                    <ScmCommitComposerCard
                        theme={theme}
                        commitActionLabel={t('common.commit')}
                        draftMessage={commitDraftMessage}
                        onDraftMessageChange={setCommitDraftMessage}
                        busy={scmOperationBusy}
                        status={scmOperationStatus}
                        commitAllowed={commitAllowed}
                        commitBlockedMessage={commitBlockedMessage}
                        onCommitFromMessage={handleCommitFromMessage}
                        selectionCount={repositorySelectedCount}
                        onClearSelection={repositorySelectedCount > 0 ? handleClearSelection : undefined}
                        onSelectAllSelection={isAtomicCommitStrategy(scmCommitStrategy) ? handleSelectAll : undefined}
                        commitSelectionAvailable={commitSelectionAvailable}
                        selectionModeActive={selectionModeActive}
                        onEnterSelectionMode={enterSelectionMode}
                        onExitSelectionMode={exitSelectionMode}
                        pushShortcut={commitAdjacentPushAction}
                        variant="railFooter"
                        commitMessageGeneratorEnabled={commitMessageGeneratorEnabled}
                        onGenerateCommitMessageSuggestion={generateCommitMessageSuggestion}
                        onCancelCommitMessageSuggestion={cancelCommitMessageSuggestion}
                        suggestionContextKey={suggestionContextKey}
                    />
                </View>
            ) : null}
        </View>
    );
});
