import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { NotSourceControlRepositoryState, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { SourceControlBranchSummary } from '@/components/workspaces/scm/SourceControlBranchSummary';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { ScmChangeOverflowMenu } from '@/components/workspaces/scm/changes/ScmChangeOverflowMenu';
import { ScmCommitComposerCard } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { countCommitSelectionItems } from '@/scm/operations/commitSelectionHints';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { resolveChangedFilesViewMode, type ChangedFilesViewMode } from '@/scm/scmAttribution';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    storage,
    useSetting,
    useSettingMutable,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
} from '@/sync/domains/state/storage';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { resolveCommitAdjacentPushActionState } from '@/scm/operations/commitAdjacentPushAction';
import { confirmCommitAdjacentPush } from '@/scm/operations/commitAdjacentPushConfirmation';
import { formatRemoteTargetForDisplay } from '@/scm/operations/remoteFeedback';
import type { ScmPushRejectPolicy } from '@/scm/settings/preferences';
import { normalizeScmRemoteConfirmPolicy } from '@/scm/settings/remoteConfirmationPolicy';
import { machineScmStashList } from '@/sync/ops/scm/machineScm';
import { resolveSnapshotScmStashCount, useScmStashSummaryCount } from '@/scm/stash/useScmStashSummaryCount';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';
import { applyWorkspaceFileStageAction, WorkspaceScmCommitSelectionToggleButton } from './WorkspaceScmCommitSelectionToggleButton';
import { WorkspaceScmChangeDiscardButton } from './WorkspaceScmChangeDiscardButton';
import { executeWorkspaceScmCommit } from './executeWorkspaceScmCommit';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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
    const [searchQuery, setSearchQuery] = React.useState('');
    const [requestedChangedFilesViewMode, setChangedFilesViewMode] = React.useState<ChangedFilesViewMode>('repository');
    const [commitDraftMessage, setCommitDraftMessage] = React.useState('');
    const [scmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);
    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const [scmRemoteConfirmPolicySetting, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const scmPushRejectPolicySetting = useSetting('scmPushRejectPolicy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const normalizedRemoteConfirmPolicy = React.useMemo(
        () => normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicySetting),
        [scmRemoteConfirmPolicySetting],
    );
    const normalizedPushRejectPolicy: ScmPushRejectPolicy = React.useMemo(() => {
        return scmPushRejectPolicySetting === 'auto_fetch'
            || scmPushRejectPolicySetting === 'prompt_fetch'
            || scmPushRejectPolicySetting === 'manual'
            ? scmPushRejectPolicySetting
            : 'manual';
    }, [scmPushRejectPolicySetting]);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');

    const { scmStatusFiles, allRepositoryChangedFiles } = React.useMemo(
        () => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }),
        [snapshot],
    );

    const openFile = React.useCallback((file: ScmFileStatus) => {
        props.onOpenFile(file.fullPath);
    }, [props]);

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
        return isAtomicCommitStrategy(scmCommitStrategy) ? commitSelectionSet.has(file.fullPath) : file.isIncluded === true;
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

    const repositorySelectedCount = React.useMemo(() => {
        if (isAtomicCommitStrategy(scmCommitStrategy)) return commitSelectionCount;
        return filteredChangedFiles.filter((file) => isSelectedForCommit(file)).length;
    }, [commitSelectionCount, filteredChangedFiles, isSelectedForCommit, scmCommitStrategy]);

    const commitSelectionPathHints = React.useMemo(() => {
        return buildCommitSelectionPathHints({
            commitSelectionPaths,
            commitSelectionPatches,
        });
    }, [commitSelectionPatches, commitSelectionPaths]);

    const commitPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
            commitSelectionPaths: commitSelectionPathHints,
        });
    }, [commitSelectionPathHints, scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);
    const pushPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);
    const commitAllowed = commitPreflight.allowed;
    const commitBlockedMessage = commitPreflight.allowed ? null : commitPreflight.message;
    const branchSummaryDisabled = scmOperationBusy;
    const stashCount = useScmStashSummaryCount({
        enabled: snapshot?.capabilities?.readStash === true,
        snapshotCount: resolveSnapshotScmStashCount(snapshot),
        refreshKey: `${props.machineId}:${props.rootPath}:${snapshot?.fetchedAt ?? 0}`,
        load: React.useCallback(
            async () => await machineScmStashList(props.machineId, { cwd: props.rootPath }),
            [props.machineId, props.rootPath],
        ),
    });

    const handleClearSelection = React.useCallback(() => {
        storage.getState().clearWorkspaceScmCommitSelectionPaths(scope);
        storage.getState().clearWorkspaceScmCommitSelectionPatches(scope);
    }, [scope]);

    const handleSelectAll = React.useCallback(() => {
        if (!isAtomicCommitStrategy(scmCommitStrategy)) return;
        const paths = filteredChangedFiles.map((file) => file.fullPath);
        storage.getState().markWorkspaceScmCommitSelectionPaths(scope, paths);
    }, [filteredChangedFiles, scmCommitStrategy, scope]);

    const handleCommitFromMessage = React.useCallback((message: string) => {
        const trimmed = String(message ?? '').trim();
        if (!trimmed) return;
        void executeWorkspaceScmCommit({
            scope,
            commitMessage: trimmed,
            scmCommitStrategy,
            commitSelectionPaths: [...commitSelectionPaths],
            commitSelectionPatches: [...commitSelectionPatches],
            refreshScmData: refresh,
            setScmOperationBusy,
            setScmOperationStatus,
            tracking: null,
        });
    }, [commitSelectionPatches, commitSelectionPaths, refresh, scmCommitStrategy, scope]);

    const commitAdjacentPushState = React.useMemo(() => {
        return resolveCommitAdjacentPushActionState({
            snapshot,
            pushPreflight,
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            scmOperationBusy,
            hasGlobalOperationInFlight: false,
            isLockedByOtherSession: false,
        });
    }, [pushPreflight, scmOperationBusy, scmWriteEnabled, scope.rootPath, snapshot]);

    const onCommitAdjacentPush = React.useCallback(() => {
        if (!commitAdjacentPushState.visible) return;
        void (async () => {
            const confirmed = await confirmCommitAdjacentPush({
                target: commitAdjacentPushState.target,
                policy: normalizedRemoteConfirmPolicy,
                setRemoteConfirmPolicy: setScmRemoteConfirmPolicy,
                detachedHeadLabel: t('files.detachedHead'),
            });
            if (!confirmed) return;
            await executeWorkspaceScmRemoteOperation({
                kind: 'push',
                scope,
                scmSnapshot: snapshot,
                scmWriteEnabled,
                scmCommitStrategy,
                scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                scmPushRejectPolicy: normalizedPushRejectPolicy,
                refreshScmData: refresh,
                setScmOperationBusy,
                setScmOperationStatus,
                tracking: null,
                skipConfirmation: true,
            });
        })();
    }, [
        commitAdjacentPushState,
        normalizedPushRejectPolicy,
        normalizedRemoteConfirmPolicy,
        refresh,
        scmCommitStrategy,
        scmWriteEnabled,
        scope,
        setScmRemoteConfirmPolicy,
        snapshot,
    ]);

    const commitAdjacentPushAction = React.useMemo(() => {
        if (!commitAdjacentPushState.visible) return null;
        const displayTarget = formatRemoteTargetForDisplay(
            commitAdjacentPushState.target,
            t('files.detachedHead'),
        );
        return {
            label: t('files.commitAdjacentPush.accessibilityLabel', { target: displayTarget }),
            disabled: commitAdjacentPushState.disabled,
            busy: commitAdjacentPushState.busy,
            onPress: onCommitAdjacentPush,
        };
    }, [commitAdjacentPushState, onCommitAdjacentPush]);

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
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (snapshot && snapshot.repo.isRepo === false) {
        return <NotSourceControlRepositoryState />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <FlatList
                data={filteredChangedFiles}
                keyExtractor={(file) => `workspace-scm-${file.fullPath}`}
                ListHeaderComponent={(
                    <View
                        style={{
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
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
                                    gap: 10,
                                    paddingHorizontal: 12,
                                    paddingVertical: 10,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.border.default,
                                    backgroundColor: theme.colors.surface.base,
                                    opacity: pressed ? 0.85 : 1,
                                })}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                                    <Octicons name="archive" size={14} color={theme.colors.text.secondary} />
                                    <Text numberOfLines={1} style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                        {t('files.stash.summaryTitle')}
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                    <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                                        {String(stashCount)}
                                    </Text>
                                    <Octicons name="chevron-right" size={14} color={theme.colors.text.secondary} />
                                </View>
                            </Pressable>
                        ) : null}
                        {scmStatusFiles ? (
                            <SourceControlBranchSummary
                                theme={theme}
                                scmStatusFiles={scmStatusFiles}
                                variant="rail"
                                branchTrigger={(
                                    <WorkspaceSourceControlBranchMenu
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
                        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    backgroundColor: theme.colors.input.background,
                                    borderRadius: 10,
                                    paddingHorizontal: 12,
                                    paddingVertical: 8,
                                    borderWidth: 1,
                                    borderColor: theme.colors.border.default,
                                }}
                            >
                                <Octicons name="search" size={16} color={theme.colors.text.secondary} style={{ marginRight: 8 }} />
                                <TextInput
                                    value={searchQuery}
                                    onChangeText={setSearchQuery}
                                    placeholder={t('files.searchPlaceholder')}
                                    style={{
                                        flex: 1,
                                        fontSize: 16,
                                        ...Typography.default(),
                                    }}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 10, paddingHorizontal: 16, paddingBottom: 12 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0, flex: 1 }}>
                                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
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
                                        paddingHorizontal: 10,
                                        height: 30,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: theme.colors.border.default,
                                        backgroundColor: theme.colors.surface.base,
                                        opacity: pressed ? 0.78 : 1,
                                        gap: 6,
                                    })}
                                >
                                    <Octicons name="diff" size={14} color={theme.colors.text.secondary} />
                                    <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
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
                                    opacity: pressed ? 0.78 : 1,
                                })}
                            >
                                <Octicons name="sync" size={14} color={theme.colors.text.secondary} />
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
                            theme={theme}
                            file={file}
                            density="compact"
                            leadingElement={scmWriteEnabled === true ? (
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
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    {canDiscard ? (
                                        <WorkspaceScmChangeDiscardButton
                                            scope={scope}
                                            machineId={props.machineId}
                                            rootPath={props.rootPath}
                                            snapshot={snapshot ?? null}
                                            scmWriteEnabled={scmWriteEnabled === true}
                                            commitStrategy={scmCommitStrategy}
                                            file={file}
                                            surface="files"
                                            onAfterDiscard={refresh}
                                        />
                                    ) : null}
                                    <ScmChangeOverflowMenu
                                        title={file.fileName}
                                        filePath={file.fullPath}
                                        onRevealInTree={revealInTree}
                                    />
                                </View>
                            )}
                            showDivider={index < filteredChangedFiles.length - 1}
                        />
                    );
                }}
                contentContainerStyle={{ paddingBottom: 12 }}
                initialNumToRender={Math.min(WORKSPACE_CHANGED_FILES_INITIAL_RENDER_COUNT, filteredChangedFiles.length)}
                maxToRenderPerBatch={WORKSPACE_CHANGED_FILES_BATCH_RENDER_COUNT}
                windowSize={WORKSPACE_CHANGED_FILES_WINDOW_SIZE}
                removeClippedSubviews={Platform.OS !== 'web'}
                ListEmptyComponent={(
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
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
                        pushShortcut={commitAdjacentPushAction}
                        variant="railFooter"
                        commitMessageGeneratorEnabled={false}
                    />
                </View>
            ) : null}
        </View>
    );
});
