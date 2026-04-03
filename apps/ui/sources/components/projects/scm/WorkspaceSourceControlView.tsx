import * as React from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { NotSourceControlRepositoryState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { ScmChangeRow } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { ScmCommitComposerCard } from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { countCommitSelectionItems } from '@/scm/operations/commitSelectionHints';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    storage,
    useSetting,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
} from '@/sync/domains/state/storage';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { WorkspaceScmCommitSelectionToggleButton } from './WorkspaceScmCommitSelectionToggleButton';
import { executeWorkspaceScmCommit } from './executeWorkspaceScmCommit';

export type WorkspaceSourceControlViewProps = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    onOpenFile: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

function matchesQuery(filePath: string, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return true;
    return filePath.toLowerCase().includes(normalizedQuery);
}

export const WorkspaceSourceControlView = React.memo((props: WorkspaceSourceControlViewProps) => {
    const { theme } = useUnistyles();
    const [searchQuery, setSearchQuery] = React.useState('');
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
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');

    const { scmStatusFiles, changedFilesCount, allRepositoryChangedFiles } = React.useMemo(
        () => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }),
        [snapshot],
    );

    const filteredChangedFiles = React.useMemo(() => {
        if (!searchQuery.trim()) return allRepositoryChangedFiles;
        return allRepositoryChangedFiles.filter((file) => matchesQuery(file.fullPath, searchQuery));
    }, [allRepositoryChangedFiles, searchQuery]);

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
    const commitAllowed = commitPreflight.allowed;
    const commitBlockedMessage = commitPreflight.allowed ? null : commitPreflight.message;

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

    if (error && !snapshot) {
        return (
            <SourceControlUnavailableState
                details={error.message}
                onRetry={() => {
                    void refresh();
                }}
            />
        );
    }

    if (loading && !snapshot) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
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
                            padding: 16,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.divider,
                        }}
                    >
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                backgroundColor: theme.colors.input.background,
                                borderRadius: 10,
                                paddingHorizontal: 12,
                                paddingVertical: 8,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                            }}
                        >
                            <Octicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
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
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('common.refresh')}
                                onPress={() => {
                                    void refresh();
                                }}
                                style={({ pressed }) => ({
                                    width: 34,
                                    height: 34,
                                    borderRadius: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    opacity: pressed ? 0.78 : 1,
                                    marginLeft: 8,
                                })}
                            >
                                <Octicons name="sync" size={14} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10 }}>
                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                                {t('files.toolbar.changedFiles')}
                            </Text>
                            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.mono('semiBold') }}>
                                {String(changedFilesCount)}
                            </Text>
                        </View>
                    </View>
                )}
                renderItem={({ item: file, index }) => {
                    return (
                        <ScmChangeRow
                            theme={theme}
                            file={file}
                            density="compact"
                            leadingElement={(
                                <WorkspaceScmCommitSelectionToggleButton
                                    scope={scope}
                                    snapshot={snapshot}
                                    scmWriteEnabled={scmWriteEnabled === true}
                                    commitStrategy={scmCommitStrategy}
                                    file={file}
                                    selectedForCommit={isSelectedForCommit(file)}
                                    onAfterToggle={refresh}
                                />
                            )}
                            onPress={() => openFile(file)}
                            onPressPinned={() => openFilePinned(file)}
                            showDivider={index < filteredChangedFiles.length - 1}
                        />
                    );
                }}
                contentContainerStyle={{ paddingBottom: 12 }}
                initialNumToRender={Math.min(24, filteredChangedFiles.length)}
                maxToRenderPerBatch={24}
                windowSize={7}
                removeClippedSubviews={Platform.OS !== 'web'}
                ListEmptyComponent={(
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                            {t('files.noChanges')}
                        </Text>
                    </View>
                )}
            />

            <View
                style={{
                    borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderTopColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface,
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
                    variant="railFooter"
                    commitMessageGeneratorEnabled={false}
                />
            </View>
        </View>
    );
});
