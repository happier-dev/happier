import * as React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useWorkspaceScmCommitHistory } from '@/hooks/workspaces/scm/useWorkspaceScmCommitHistory';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { normalizeScmRemoteConfirmPolicy } from '@/scm/settings/remoteConfirmationPolicy';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { reportWorkspaceScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { NotSourceControlRepositoryState, SourceControlStaleSnapshotNotice, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { WorkspaceScmSubTabsBar, type GitSubTabId } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';
import { WorkspaceScmHistoryTab } from '@/components/workspaces/scm/WorkspaceScmHistoryTab';
import { WorkspaceScmUpdateTab } from '@/components/workspaces/scm/WorkspaceScmUpdateTab';
import { SourceControlBranchIntegrationSection } from '@/components/workspaces/scm/update/SourceControlBranchIntegrationSection';
import { SourceControlPullRequestSection } from '@/components/workspaces/scm/update/SourceControlPullRequestSection';
import { SourceControlPublishRepositorySection } from '@/components/workspaces/scm/update/SourceControlPublishRepositorySection';
import { SourceControlRemotesSection } from '@/components/workspaces/scm/update/SourceControlRemotesSection';
import {
    machineScmBranchCreate,
    machineScmBranchMerge,
    machineScmBranchOperationAbort,
    machineScmBranchOperationContinue,
    machineScmBranchRebase,
    machineScmHostingRepositoryDescribePublishTargets,
    machineScmHostingRepositoryPublish,
    machineScmPullRequestOpenCompose,
    machineScmPullRequestOpenOrReuse,
    machineScmRemoteAdd,
    machineScmRemoteRemove,
    machineScmRemoteSetUrl,
    machineScmRepositoryInit,
} from '@/sync/ops/scm/machineScm';
import type { ScmOperationErrorCode } from '@happier-dev/protocol';
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';
import { WorkspaceSourceControlView, type WorkspaceSourceControlViewProps } from './WorkspaceSourceControlView';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

export type WorkspaceRightPanelGitViewProps = WorkspaceSourceControlViewProps & Readonly<{
    onOpenCommit?: (sha: string) => void;
}>;

type ScmUpdateMutationResponse = Readonly<{
    success: boolean;
    error?: string;
    errorCode?: ScmOperationErrorCode;
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
    const scmCallOptions = React.useMemo(() => ({ serverId: scope.serverId }), [scope.serverId]);
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
    const normalizedRemoteConfirmPolicy = React.useMemo(
        () => normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicy),
        [scmRemoteConfirmPolicy],
    );
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
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
        readLogEnabled: snapshot?.repo.isRepo === true && (snapshot.capabilities?.readLog ?? true),
    });
    const commitHistoryInitKey = `${props.serverId}:${props.machineId}:${props.rootPath}`;
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
                iconName: 'arrows-clockwise',
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
                testID: 'scm-update-remote-action-fetch',
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
                testID: 'scm-update-remote-action-pull',
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
                testID: 'scm-update-remote-action-push',
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

    const showUpdateTab = remoteActions.length > 0
        || snapshot?.capabilities?.readPullRequestStatus === true
        || snapshot?.capabilities?.readHostingRepositoryPublishTargets === true;
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
    const runWorkspaceUpdateMutation = React.useCallback(async <T extends ScmUpdateMutationResponse>(input: {
        operation: ScmProjectOperationKind;
        fallbackError: string;
        run: () => Promise<T>;
    }): Promise<T> => {
        const lockResult = await withWorkspaceScmOperationLock({
            state: storage.getState(),
            scope,
            operation: input.operation,
            run: async () => {
                setScmOperationBusy(true);
                try {
                    const response = await input.run();
                    if (!response.success) {
                        reportWorkspaceScmOperation({
                            state: storage.getState(),
                            scope,
                            operation: input.operation,
                            status: 'failed',
                            detail: getScmUserFacingError({
                                errorCode: response.errorCode,
                                error: response.error,
                                fallback: response.error || input.fallbackError,
                            }),
                            rawError: response.error,
                            errorCode: response.errorCode,
                            surface: 'update',
                            tracking: null,
                        });
                        return response;
                    }

                    reportWorkspaceScmOperation({
                        state: storage.getState(),
                        scope,
                        operation: input.operation,
                        status: 'success',
                        surface: 'update',
                        tracking: null,
                    });
                    return response;
                } finally {
                    setScmOperationBusy(false);
                    setScmOperationStatus(null);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: input.operation,
                reason: 'lock',
                message: lockResult.message,
                surface: 'update',
                tracking: null,
            });
            return {
                success: false,
                error: lockResult.message,
            } as T;
        }
        return lockResult.value;
    }, [scope]);
    const addRemote = React.useCallback(
        (request: { name: string; fetchUrl: string; pushUrl?: string }) => runWorkspaceUpdateMutation({
            operation: 'remote_add',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.addFailed'),
            run: () => machineScmRemoteAdd(scope.machineId, {
                cwd: scope.rootPath,
                ...request,
            }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const setRemoteUrl = React.useCallback(
        (request: { name: string; fetchUrl: string; pushUrl: string | null }) => runWorkspaceUpdateMutation({
            operation: 'remote_set_url',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.saveFailed'),
            run: () => machineScmRemoteSetUrl(scope.machineId, {
                cwd: scope.rootPath,
                ...request,
            }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const removeRemote = React.useCallback(
        (name: string) => runWorkspaceUpdateMutation({
            operation: 'remote_remove',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.removeFailed'),
            run: () => machineScmRemoteRemove(scope.machineId, { cwd: scope.rootPath, name }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const mergeBranch = React.useCallback(
        (sourceRef: string) => runWorkspaceUpdateMutation({
            operation: 'branch_merge',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.mergeFailed'),
            run: () => machineScmBranchMerge(scope.machineId, { cwd: scope.rootPath, sourceRef }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const rebaseBranch = React.useCallback(
        (sourceRef: string) => runWorkspaceUpdateMutation({
            operation: 'branch_rebase',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.rebaseFailed'),
            run: () => machineScmBranchRebase(scope.machineId, { cwd: scope.rootPath, sourceRef }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const continueBranchOperation = React.useCallback(
        (operation: 'merge' | 'rebase') => runWorkspaceUpdateMutation({
            operation: 'branch_operation_continue',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            run: () => machineScmBranchOperationContinue(scope.machineId, { cwd: scope.rootPath, operation }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const abortBranchOperation = React.useCallback(
        (operation: 'merge' | 'rebase') => runWorkspaceUpdateMutation({
            operation: 'branch_operation_abort',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
            run: () => machineScmBranchOperationAbort(scope.machineId, { cwd: scope.rootPath, operation }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const initializeRepository = React.useCallback(
        () => machineScmRepositoryInit(scope.machineId, { cwd: scope.rootPath }, scmCallOptions),
        [scope.machineId, scope.rootPath, scmCallOptions],
    );
    const openOrReusePullRequest = React.useCallback(
        (request: { base: string; head: string }) => machineScmPullRequestOpenOrReuse(scope.machineId, {
            cwd: scope.rootPath,
            ...request,
        }, scmCallOptions),
        [scope.machineId, scope.rootPath, scmCallOptions],
    );
    const openComposePullRequest = React.useCallback(
        (request: { base: string; head: string }) => machineScmPullRequestOpenCompose(scope.machineId, {
            cwd: scope.rootPath,
            ...request,
        }, scmCallOptions),
        [scope.machineId, scope.rootPath, scmCallOptions],
    );
    const createFeatureBranch = React.useCallback(
        (request: { name: string; checkout: true; startPoint?: string }) => machineScmBranchCreate(scope.machineId, {
            cwd: scope.rootPath,
            ...request,
        }, scmCallOptions),
        [scope.machineId, scope.rootPath, scmCallOptions],
    );
    const publishProviderKind = snapshot?.hostingProvider?.kind ?? null;
    const describePublishTargets = React.useCallback(
        () => machineScmHostingRepositoryDescribePublishTargets(scope.machineId, {
            cwd: scope.rootPath,
            ...(publishProviderKind ? { providerKind: publishProviderKind } : {}),
        }, scmCallOptions),
        [publishProviderKind, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const publishRepository = React.useCallback(
        (request: Parameters<typeof machineScmHostingRepositoryPublish>[1]) => machineScmHostingRepositoryPublish(scope.machineId, {
            cwd: scope.rootPath,
            ...request,
        }, scmCallOptions),
        [scope.machineId, scope.rootPath, scmCallOptions],
    );
    const openGitHubConnectedService = React.useCallback(() => {
        router.push({ pathname: '/(app)/settings/connected-services/[serviceId]', params: { serviceId: 'github' } });
    }, []);
    const openMachineInstallables = React.useCallback(() => {
        router.push(`/machine/${encodeURIComponent(scope.machineId)}/installables?serverId=${encodeURIComponent(scope.serverId)}` as never);
    }, [scope.machineId, scope.serverId]);

    if (error && !snapshot) {
        return (
            <SourceControlUnavailableState
                testID="workspace-rightpanel-git-unavailable"
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
    // `F-SCM-2`: the branch above is the only place this view reported a snapshot error, and
    // `useWorkspaceScmSnapshotController`'s catch stores the error WITHOUT clearing the stored
    // snapshot — so once anything had been cached, every later refresh failure was invisible and
    // stale content read as current. From here on the content is real but possibly stale, so the
    // failure travels WITH it. Same owner and same treatment as the session twin.
    const staleSnapshotNotice = (
        <SourceControlStaleSnapshotNotice
            testID="workspace-rightpanel-git-stale"
            error={error}
            onRetry={() => {
                void refresh();
            }}
        />
    );

    if (snapshot && snapshot.repo.isRepo === false) {
        return (
            <View style={{ flex: 1, minHeight: 0 }}>
                {staleSnapshotNotice}
                <NotSourceControlRepositoryState
                    canInitializeRepository={scmWriteEnabled && snapshot.capabilities?.writeRepositoryInit === true}
                    initializeRepositoryBusy={scmOperationBusy}
                    onInitializeRepository={initializeRepository}
                    onRefresh={refresh}
                />
            </View>
        );
    }

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <WorkspaceScmSubTabsBar
                tabs={tabs}
                activeSubTabId={activeSubTab}
                onSelectSubTab={setActiveSubTab}
                testIDPrefix="project-rightpanel-git-subtab:"
            />
            {staleSnapshotNotice}
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
                            serverId={props.serverId}
                            machineId={props.machineId}
                            rootPath={props.rootPath}
                            currentBranch={scmStatusFiles?.branch ?? null}
                            snapshot={snapshot}
                            writeEnabled={scmWriteEnabled}
                            disabled={scmOperationBusy}
                            onRefreshSnapshot={refresh}
                            onSelectWorkspacePath={props.onSelectWorkspacePath}
                            onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
                        />
                    )}
                >
                    <SourceControlPullRequestSection
                        theme={theme}
                        snapshot={snapshot}
                        disabled={scmOperationBusy}
                        onOpenOrReuse={openOrReusePullRequest}
                        onOpenCompose={openComposePullRequest}
                        onCreateFeatureBranch={createFeatureBranch}
                        onRefresh={refresh}
                    />
                    <SourceControlPublishRepositorySection
                        theme={theme}
                        snapshot={snapshot}
                        writeEnabled={scmWriteEnabled}
                        disabled={scmOperationBusy}
                        publishTargets={null}
                        onDescribePublishTargets={describePublishTargets}
                        onPublishRepository={publishRepository}
                        onRefresh={refresh}
                        onConnectGitHub={openGitHubConnectedService}
                        onInstallGh={openMachineInstallables}
                        onUseManagedGh={openMachineInstallables}
                        onAuthenticateGh={openMachineInstallables}
                    />
                    <SourceControlRemotesSection
                        theme={theme}
                        snapshot={snapshot}
                        writeEnabled={scmWriteEnabled}
                        disabled={scmOperationBusy}
                        onAddRemote={addRemote}
                        onSetRemoteUrl={setRemoteUrl}
                        onRemoveRemote={removeRemote}
                        onRefresh={refresh}
                    />
                    <SourceControlBranchIntegrationSection
                        theme={theme}
                        snapshot={snapshot}
                        rootPath={scope.rootPath}
                        writeEnabled={scmWriteEnabled}
                        disabled={scmOperationBusy}
                        onMerge={mergeBranch}
                        onRebase={rebaseBranch}
                        onContinue={continueBranchOperation}
                        onAbort={abortBranchOperation}
                        onRefresh={refresh}
                    />
                </WorkspaceScmUpdateTab>
            ) : (
                <WorkspaceSourceControlView {...props} />
            )}
        </View>
    );
});
