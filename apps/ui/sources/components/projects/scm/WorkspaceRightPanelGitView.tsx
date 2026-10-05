import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useWorkspaceScmCommitHistory } from '@/hooks/workspaces/scm/useWorkspaceScmCommitHistory';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { storage, useSetting, useWorkspaceScmCommitSelectionPaths, useWorkspaceScmCommitSelectionPatches, useWorkspaceScmInFlightOperation } from '@/sync/domains/state/storage';
import { countCommitSelectionItems } from '@/scm/operations/commitSelectionHints';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { normalizeScmRemoteConfirmPolicy } from '@/scm/settings/remoteConfirmationPolicy';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { resolveForceWithLeaseTarget } from '@/scm/operations/remoteTarget';
import { trackBlockedScmOperation } from '@/scm/operations/reporting';
import { runWorkspaceScmMutation, type ScmMutationResponse } from '@/scm/operations/runSessionScmMutation';
import { NotSourceControlRepositoryState, SourceControlStaleSnapshotNotice, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import type { GitSubTabId } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';
import { GitPaneLayout, resolveGitPaneActiveSubTab } from '@/components/workspaces/scm/GitPaneLayout';
import { SourceControlRemoteActionsRail, type SourceControlRemoteAction } from '@/components/workspaces/scm/SourceControlRemoteActionsRail';
import { GitDisplayMenu, useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { GitTimelineSection } from '@/components/sessions/panes/git/GitTimelineSection';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SourceControlBranchIntegrationSection } from '@/components/workspaces/scm/update/SourceControlBranchIntegrationSection';
import { SourceControlPullRequestSection } from '@/components/workspaces/scm/update/SourceControlPullRequestSection';
import { SourceControlPublishRepositorySection } from '@/components/workspaces/scm/update/SourceControlPublishRepositorySection';
import { SourceControlRemotesSection } from '@/components/workspaces/scm/update/SourceControlRemotesSection';
import type { ScmOperationState } from '@/sync/domains/state/storageTypes';
import {
    machineScmBranchCreate,
    machineScmBranchMerge,
    machineScmBranchOperationAbort,
    machineScmBranchOperationContinue,
    machineScmBranchOperationSkip,
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
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';
import { executeWorkspaceScmCommitUndoLast } from './executeWorkspaceScmCommit';
import { WorkspaceScmOutcomeLine } from './WorkspaceScmOutcomeLine';
import { WorkspaceSourceControlView, type WorkspaceSourceControlViewProps } from './WorkspaceSourceControlView';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

export type WorkspaceRightPanelGitViewProps = WorkspaceSourceControlViewProps & Readonly<{
    onOpenCommit?: (sha: string) => void;
    activeSubTabId?: GitSubTabId;
    onActiveSubTabChange?: (tabId: GitSubTabId) => void;
}>;

export const WorkspaceRightPanelGitView = React.memo((props: WorkspaceRightPanelGitViewProps) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [localActiveSubTab, setLocalActiveSubTab] = React.useState<GitSubTabId>('commit');
    const activeSubTab = props.activeSubTabId ?? localActiveSubTab;
    const setActiveSubTab = props.onActiveSubTabChange ?? setLocalActiveSubTab;
    const { paneLayout } = useGitDisplaySettings();
    const displayActiveSubTab = resolveGitPaneActiveSubTab(paneLayout, activeSubTab);
    const [toolsExpanded, setToolsExpanded] = React.useState(activeSubTab === 'update');
    const [localScmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);

    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const inFlightOperation = useWorkspaceScmInFlightOperation(scope);
    const scmOperationBusy = localScmOperationBusy || Boolean(inFlightOperation);
    const scmCallOptions = React.useMemo(() => ({ serverId: scope.serverId }), [scope.serverId]);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
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

    const { changedFilesCount } = React.useMemo(
        () => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }),
        [snapshot],
    );

    const { historyIdentity: commitHistoryIdentity, historyEntries, historyLoading, historyHasMore, loadCommitHistory } = useWorkspaceScmCommitHistory({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
        historyBranch: snapshot?.branch.head,
        readLogEnabled: snapshot?.repo.isRepo === true && (snapshot.capabilities?.readLog ?? true),
    });
    // HEAD can move on the same branch (commit or undo). Reload its page while retaining the pane's scroll identity.
    const commitHistoryInitKey = JSON.stringify([commitHistoryIdentity, snapshot?.branch.headOid ?? null]);
    const didInitCommitHistoryKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (paneLayout !== 'unified' && displayActiveSubTab !== 'history') return;
        if (didInitCommitHistoryKeyRef.current === commitHistoryInitKey) return;
        if (historyLoading) return;
        didInitCommitHistoryKeyRef.current = commitHistoryInitKey;
        void loadCommitHistory({ reset: true });
    }, [paneLayout, displayActiveSubTab, commitHistoryInitKey, historyLoading, loadCommitHistory]);

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
    const leaseTarget = resolveForceWithLeaseTarget(snapshot);
    const forceWithLeasePreflight = evaluateScmOperationPreflight({
        intent: 'push', scmWriteEnabled, sessionPath: scope.rootPath, snapshot,
        commitStrategy: scmCommitStrategy,
        remotePolicy: leaseTarget ? { pushMode: leaseTarget.pushMode, expectedRemoteOid: leaseTarget.expectedRemoteOid } : undefined,
    });
    const undoLastCommit = (expectedHeadOid: string) => {
        void executeWorkspaceScmCommitUndoLast({ scope, expectedHeadOid, refreshScmData: refresh });
    };

    const remoteActions = React.useMemo(() => {
        if (scmWriteEnabled !== true) return [];
        if (!snapshot?.repo.isRepo) return [];
        const actions: SourceControlRemoteAction[] = [];
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

    React.useEffect(() => {
        if (activeSubTab !== 'update') return;
        // Retained pane state can still name the removed Sync tab. Reveal its tools in Changes.
        setToolsExpanded(true);
        setActiveSubTab('commit');
    }, [activeSubTab, setActiveSubTab]);

    const loadMoreHistory = React.useCallback(() => {
        void loadCommitHistory();
    }, [loadCommitHistory]);
    const runWorkspaceUpdateMutation = React.useCallback(async <T extends ScmMutationResponse>(input: {
        operation: ScmProjectOperationKind;
        fallbackError: string;
        run: () => Promise<T>;
    }) => {
        const lockResult = await runWorkspaceScmMutation({
            state: storage.getState(), scope, cwd: scope.rootPath, ...input,
            setScmOperationBusy, setScmOperationStatus,
            refreshAfterMutation: async () => {
                await refresh();
                const error = storage.getState().getWorkspaceScmSnapshotError(scope);
                if (error) throw new Error(error.message);
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
            };
        }
        return lockResult.response === 'cancelled' ? { success: false } : lockResult.response;
    }, [refresh, scope]);
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
        (operation: ScmOperationState['kind']) => runWorkspaceUpdateMutation({
            operation: 'branch_operation_continue',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            run: () => machineScmBranchOperationContinue(scope.machineId, { cwd: scope.rootPath, operation }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const abortBranchOperation = React.useCallback(
        (operation: ScmOperationState['kind']) => runWorkspaceUpdateMutation({
            operation: 'branch_operation_abort',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
            run: () => machineScmBranchOperationAbort(scope.machineId, { cwd: scope.rootPath, operation }, scmCallOptions),
        }),
        [runWorkspaceUpdateMutation, scope.machineId, scope.rootPath, scmCallOptions],
    );
    const skipBranchOperation = React.useCallback(
        (operation: ScmOperationState['kind']) => runWorkspaceUpdateMutation({
            operation: 'branch_operation_skip',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            run: () => machineScmBranchOperationSkip(scope.machineId, { cwd: scope.rootPath, operation }, scmCallOptions),
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
        return <PaneLoadingFallback />;
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

    const repositoryTools = (
        <ExpandableItem
            expanded={toolsExpanded}
            onExpandedChange={setToolsExpanded}
            header={({ headerProps, expanded }) => (
                <Item
                    {...headerProps}
                    testID="project-git-tools"
                    title={t('sessionGitPane.flow.tools.title')}
                    rightElement={<Icon name={expanded ? 'caret-up' : 'caret-down'} size={16} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            )}
        >
            {scmWriteEnabled && snapshot?.capabilities?.writeCommitUndoLast === true ? (
                <Item
                    title={t('sessionGitPane.flow.undo.action')}
                    subtitle={t('sessionGitPane.flow.undo.description')}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            title={t('sessionGitPane.flow.undo.action')}
                            display="secondary"
                            size="small"
                            testID="workspace-scm-undo-last-commit"
                            disabled={scmOperationBusy || !snapshot.branch.headOid}
                            onPress={() => {
                                if (snapshot.branch.headOid) undoLastCommit(snapshot.branch.headOid);
                            }}
                        />
                    )}
                />
            ) : null}
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
                onSkip={skipBranchOperation}
            />
            {scmWriteEnabled && snapshot?.capabilities?.writeRemoteForceWithLease === true ? (
                <Item
                    title={t('sessionGitPane.flow.lease.push')}
                    subtitle={leaseTarget ? t('sessionGitPane.flow.lease.description') : t('sessionGitPane.flow.lease.fetchFirst')}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            title={t('sessionGitPane.flow.lease.push')}
                            display="destructive"
                            size="small"
                            testID="workspace-scm-force-with-lease"
                            disabled={scmOperationBusy || !forceWithLeasePreflight.allowed || !leaseTarget}
                            onPress={() => {
                                if (!leaseTarget) return;
                                void executeWorkspaceScmRemoteOperation({
                                    kind: 'push', scope, scmSnapshot: snapshot, scmWriteEnabled,
                                    scmCommitStrategy, scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                                    scmPushRejectPolicy: normalizedPushRejectPolicy,
                                    policy: { pushMode: leaseTarget.pushMode, expectedRemoteOid: leaseTarget.expectedRemoteOid },
                                    refreshScmData: refresh, setScmOperationBusy, setScmOperationStatus, tracking: null,
                                });
                            }}
                        />
                    )}
                />
            ) : null}
        </ExpandableItem>
    );
    const timeline = (
        <GitTimelineSection
            testID="project-git-timeline"
            changedCount={changedFilesCount}
            selectedCount={countCommitSelectionItems({ commitSelectionPaths, commitSelectionPatches })}
            ahead={snapshot?.branch.ahead ?? 0}
            behind={snapshot?.branch.behind ?? 0}
            upstream={snapshot?.branch.upstream ?? null}
            entries={historyEntries}
            incoming={null}
            loading={historyLoading}
            hasMore={historyHasMore}
            onLoadMore={loadMoreHistory}
            onOpenCommit={props.onOpenCommit ?? (() => {})}
            landedSha={null}
        />
    );
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {staleSnapshotNotice}
            <SourceControlRemoteActionsRail
                theme={theme}
                actions={remoteActions}
                hint={!pullPreflight.allowed ? pullPreflight.message : !pushPreflight.allowed ? pushPreflight.message : null}
            />
            <WorkspaceScmOutcomeLine
                scope={scope}
                snapshot={snapshot}
                selectedCount={countCommitSelectionItems({ commitSelectionPaths, commitSelectionPatches })}
                writeEnabled={scmWriteEnabled}
                onRefresh={refresh}
                onFetch={remoteActions.find((action) => action.key === 'fetch')?.onPress}
                onShowConflicts={props.onOpenReviewAllChanges}
            />
            {scmOperationStatus ? (
                <Text style={{ paddingHorizontal: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {scmOperationStatus}
                </Text>
            ) : null}
            <GitPaneLayout
                layout={paneLayout}
                activeSubTabId={activeSubTab}
                onSelectSubTab={setActiveSubTab}
                changedCount={changedFilesCount}
                historyIdentity={commitHistoryIdentity}
                testIDPrefix="project-rightpanel-git"
                timeline={timeline}
                renderChanges={({ listFooter }) => (
                    <WorkspaceSourceControlView
                        {...props}
                        listHeader={repositoryTools}
                        listFooter={listFooter}
                        hideOutcomeLine
                        // Tree review requires a session today; projects expose only supported pane choices.
                        scopeAccessory={<GitDisplayMenu testID="project-git-display" paneOnly />}
                    />
                )}
            />
        </View>
    );
});
