import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useWorkspaceScmCommitHistory } from '@/hooks/workspaces/scm/useWorkspaceScmCommitHistory';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { NotSourceControlRepositoryState, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { WorkspaceScmSubTabsBar, type GitSubTabId } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';
import { WorkspaceScmHistoryTab } from '@/components/workspaces/scm/WorkspaceScmHistoryTab';
import { WorkspaceScmUpdateTab } from '@/components/workspaces/scm/WorkspaceScmUpdateTab';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';
import { WorkspaceSourceControlView, type WorkspaceSourceControlViewProps } from './WorkspaceSourceControlView';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';

export type WorkspaceRightPanelGitViewProps = WorkspaceSourceControlViewProps & Readonly<{
    onOpenCommit?: (sha: string) => void;
}>;

export const WorkspaceRightPanelGitView = React.memo((props: WorkspaceRightPanelGitViewProps) => {
    const { theme } = useUnistyles();
    const [activeSubTab, setActiveSubTab] = React.useState<GitSubTabId>('commit');
    const [scmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);

    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');

    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const normalizedRemoteConfirmPolicy = React.useMemo(() => {
        return scmRemoteConfirmPolicy === 'always' || scmRemoteConfirmPolicy === 'push_only' || scmRemoteConfirmPolicy === 'never'
            ? scmRemoteConfirmPolicy
            : 'never';
    }, [scmRemoteConfirmPolicy]);
    const normalizedPushRejectPolicy = React.useMemo(() => {
        return scmPushRejectPolicy === 'auto_fetch' || scmPushRejectPolicy === 'prompt_fetch' || scmPushRejectPolicy === 'manual'
            ? scmPushRejectPolicy
            : 'manual';
    }, [scmPushRejectPolicy]);

    const { scmStatusFiles } = React.useMemo(
        () => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }),
        [snapshot],
    );

    const { historyEntries, historyLoading, historyHasMore, loadCommitHistory } = useWorkspaceScmCommitHistory({
        machineId: props.machineId,
        rootPath: props.rootPath,
        readLogEnabled: snapshot?.repo.isRepo === true && (snapshot.capabilities?.readLog ?? true),
    });
    const commitHistoryInitKey = `${props.machineId}:${props.rootPath}`;
    const didInitCommitHistoryKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (activeSubTab !== 'history') return;
        if (didInitCommitHistoryKeyRef.current === commitHistoryInitKey) return;
        didInitCommitHistoryKeyRef.current = commitHistoryInitKey;
        void loadCommitHistory({ reset: true });
    }, [activeSubTab, commitHistoryInitKey, loadCommitHistory]);

    const pullPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);
    const pushPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);

    const remoteActions = React.useMemo(() => {
        if (scmWriteEnabled !== true) return [];
        if (!snapshot?.repo.isRepo) return [];
        const actions: Array<React.ComponentProps<typeof WorkspaceScmUpdateTab>['actions'][number]> = [];
        if (snapshot.capabilities?.writeRemoteFetch === true) {
            actions.push({
                key: 'fetch',
                iconName: 'sync',
                label: t('files.sourceControlOperations.actions.fetch'),
                disabled: scmOperationBusy,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
                        kind: 'fetch',
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
                    });
                },
            });
        }
        if (snapshot.capabilities?.writeRemotePull === true) {
            actions.push({
                key: 'pull',
                iconName: 'arrow-down',
                label: t('files.sourceControlOperations.actions.pull'),
                disabled: scmOperationBusy || !pullPreflight.allowed,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
                        kind: 'pull',
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
                    });
                },
            });
        }
        if (snapshot.capabilities?.writeRemotePush === true) {
            actions.push({
                key: 'push',
                iconName: 'arrow-up',
                label: t('files.sourceControlOperations.actions.push'),
                disabled: scmOperationBusy || !pushPreflight.allowed,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
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
                    });
                },
            });
        }
        return actions;
    }, [
        normalizedPushRejectPolicy,
        normalizedRemoteConfirmPolicy,
        pullPreflight.allowed,
        pushPreflight.allowed,
        refresh,
        scmCommitStrategy,
        scmOperationBusy,
        scmWriteEnabled,
        scope,
        snapshot,
    ]);

    const showUpdateTab = remoteActions.length > 0;
    const tabs = React.useMemo(() => {
        return [
            { id: 'commit' as const, label: t('files.toolbar.changedFiles') },
            ...(showUpdateTab ? [{ id: 'update' as const, label: t('common.update') }] : []),
            { id: 'history' as const, label: t('common.history') },
        ];
    }, [showUpdateTab]);

    React.useEffect(() => {
        if (activeSubTab !== 'update' || showUpdateTab) return;
        setActiveSubTab('commit');
    }, [activeSubTab, showUpdateTab]);

    const loadMoreHistory = React.useCallback(() => {
        void loadCommitHistory();
    }, [loadCommitHistory]);

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
            <WorkspaceScmSubTabsBar
                tabs={tabs}
                activeSubTabId={activeSubTab}
                onSelectSubTab={setActiveSubTab}
                testIDPrefix="project-rightpanel-git-subtab:"
            />
            {activeSubTab === 'history' ? (
                <WorkspaceScmHistoryTab
                    theme={theme}
                    historyLoading={historyLoading}
                    historyEntries={historyEntries}
                    historyHasMore={historyHasMore}
                    onLoadMoreHistory={loadMoreHistory}
                    onOpenCommit={props.onOpenCommit ?? (() => {})}
                />
            ) : activeSubTab === 'update' ? (
                <WorkspaceScmUpdateTab
                    theme={theme}
                    actions={remoteActions}
                    hint={!pullPreflight.allowed ? pullPreflight.message : !pushPreflight.allowed ? pushPreflight.message : null}
                    scmStatusFiles={scmStatusFiles}
                    branchTrigger={(
                        <WorkspaceSourceControlBranchMenu
                            machineId={props.machineId}
                            rootPath={props.rootPath}
                            currentBranch={scmStatusFiles?.branch ?? null}
                            snapshot={snapshot}
                            writeEnabled={scmWriteEnabled}
                            disabled={scmOperationBusy}
                            onRefreshSnapshot={refresh}
                            onOpenWorkspacePath={props.onOpenWorkspacePath}
                            onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
                        />
                    )}
                />
            ) : (
                <WorkspaceSourceControlView {...props} />
            )}
        </View>
    );
});
