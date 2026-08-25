import * as React from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlStaleSnapshotNotice, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionResumeAction } from '@/components/sessions/model/SessionResumeContext';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { usePublishBranchAction } from '@/hooks/session/sourceControl/usePublishBranchAction';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { createScmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { useDaemonScmContributionCatalog } from '@/scm/registry/useDaemonScmContributionCatalog';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScmAdaptivePolling } from '@/scm/refresh/useScmAdaptivePolling';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import { resolveCommitAdjacentPushActionState } from '@/scm/operations/commitAdjacentPushAction';
import { confirmCommitAdjacentPush } from '@/scm/operations/commitAdjacentPushConfirmation';
import { formatRemoteTargetForDisplay } from '@/scm/operations/remoteFeedback';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import {
    storage,
    useProjectForSession,
    useProjectSessions,
    useSession,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmOperationLog,
    useSessionProjectScmSnapshot,
    useSessionProjectScmSnapshotError,
    useSessionRealtimeScmTranscriptConsumer,
    useSessionProjectScmTouchedPaths,
    useSetting,
    useSettingMutable,
} from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode } from '@happier-dev/protocol';
import { WorkspaceScmSubTabsBar } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';
import { SourceControlBranchMenu } from '@/components/sessions/sourceControl/branches/SourceControlBranchMenu';
import { SessionRightPanelGitCommitTabContent } from './SessionRightPanelGitCommitTabContent';
import { WorkspaceScmHistoryTab } from '@/components/workspaces/scm/WorkspaceScmHistoryTab';
import { WorkspaceScmUpdateTab } from '@/components/workspaces/scm/WorkspaceScmUpdateTab';
import { useSessionRightPanelGitTabState } from './useSessionRightPanelGitTabState';
import { useSessionRightPanelGitOpenDetails } from './useSessionRightPanelGitOpenDetails';
import { shouldLoadSessionGitHistory } from './shouldLoadSessionGitHistory';
import type { SourceControlRemoteAction } from '@/components/workspaces/scm/SourceControlRemoteActionsRail';
import { SourceControlRemotesSection } from '@/components/workspaces/scm/update/SourceControlRemotesSection';
import { SourceControlBranchIntegrationSection } from '@/components/workspaces/scm/update/SourceControlBranchIntegrationSection';
import { SourceControlPullRequestSection } from '@/components/workspaces/scm/update/SourceControlPullRequestSection';
import { SourceControlPublishRepositorySection } from '@/components/workspaces/scm/update/SourceControlPublishRepositorySection';
import {
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import {
    sessionScmBranchCreate,
    sessionScmBranchMerge,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchRebase,
    sessionScmHostingRepositoryDescribePublishTargets,
    sessionScmHostingRepositoryPublish,
    sessionScmPullRequestOpenCompose,
    sessionScmPullRequestOpenOrReuse,
    sessionScmRepositoryInit,
    sessionScmRepositoryRemoveIndexLock,
    sessionScmRemoteAdd,
    sessionScmRemoteRemove,
    sessionScmRemoteSetUrl,
} from '@/sync/ops/sessions';
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

export type SessionRightPanelGitViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenFile?: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    onOpenCommit?: (sha: string) => void;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

type ScmUpdateMutationResponse = Readonly<{
    success: boolean;
    error?: string;
    errorCode?: ScmOperationErrorCode;
}>;

function normalizeOptionalRouteSegment(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

export const SessionRightPanelGitView = React.memo((props: SessionRightPanelGitViewProps) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const resumeSession = useSessionResumeAction();
    const requestSessionResume = React.useCallback(() => {
        fireAndForget(emitSessionResumeRequest(props.sessionId), {
            tag: 'SessionRightPanelGitView.resumeSession',
        });
    }, [props.sessionId]);
    const { activeGitSubTab, commitDraftMessage, setCommitDraftMessage, setActiveGitSubTab } = useSessionRightPanelGitTabState(pane);
    const defaultOpenDetails = useSessionRightPanelGitOpenDetails(pane);
    const openFileInDetailsSource = props.onOpenFile ?? defaultOpenDetails.openFileInDetails;
    const openFileInDetailsPinnedSource = props.onOpenFilePinned ?? defaultOpenDetails.openFileInDetailsPinned;
    const openCommitInDetailsSource = props.onOpenCommit ?? defaultOpenDetails.openCommitInDetails;
    const openFileInDetailsRef = React.useRef(openFileInDetailsSource);
    const openFileInDetailsPinnedRef = React.useRef(openFileInDetailsPinnedSource);
    const openCommitInDetailsRef = React.useRef(openCommitInDetailsSource);
    openFileInDetailsRef.current = openFileInDetailsSource;
    openFileInDetailsPinnedRef.current = openFileInDetailsPinnedSource;
    openCommitInDetailsRef.current = openCommitInDetailsSource;
    const openFileInDetails = React.useCallback((fullPath: string) => {
        openFileInDetailsRef.current(fullPath);
    }, []);
    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        openFileInDetailsPinnedRef.current(fullPath);
    }, []);
    const openCommitInDetails = React.useCallback((sha: string) => {
        openCommitInDetailsRef.current(sha);
    }, []);

    const session = useSession(props.sessionId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    const lastGoodScmSnapshot = useLastNonNullValue(scmSnapshot, { resetKey: props.sessionId });
    const effectiveScmSnapshot = scmSnapshot ?? lastGoodScmSnapshot;
    useSessionRealtimeScmTranscriptConsumer(props.sessionId, effectiveScmSnapshot);
    const scmSnapshotError = useSessionProjectScmSnapshotError(props.sessionId);
    const touchedPaths = useSessionProjectScmTouchedPaths(props.sessionId);
    const operationLog = useSessionProjectScmOperationLog(props.sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(props.sessionId);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(props.sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(props.sessionId);
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const [scmRemoteConfirmPolicy, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const autoRefreshIntervalSetting = useSetting('scmFilesAutoRefreshIntervalMs');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const activeServerSnapshot = useActiveServerSnapshot();
    const project = useProjectForSession(props.sessionId);
    const contributionCatalog = useDaemonScmContributionCatalog({
        machineId: project?.key.machineId ?? ownerMetadata?.machineId ?? null,
        serverId: project?.key.serverId ?? session?.serverId ?? activeServerSnapshot.serverId,
    });
    const backendUiRegistry = React.useMemo(
        () => createScmUiBackendRegistry(contributionCatalog),
        [contributionCatalog],
    );
    const projectSessionIds = useProjectSessions(project?.id ?? null);
    const hasGlobalOperationInFlight = Boolean(inFlightScmOperation);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: ownerMetadata?.path ?? null,
        projectPath: project?.key?.rootPath ?? null,
    });
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId);
    const isSessionInactive = session?.active === false;
    const maxIntervalMs = React.useMemo(() => {
        const raw = typeof autoRefreshIntervalSetting === 'number' && Number.isFinite(autoRefreshIntervalSetting)
            ? autoRefreshIntervalSetting
            : 60_000;
        return Math.max(0, raw);
    }, [autoRefreshIntervalSetting]);
    const baseIntervalMs = React.useMemo(() => Math.max(0, Math.min(10_000, maxIntervalMs)), [maxIntervalMs]);
    const snapshotSignature = React.useMemo(() => {
        if (!effectiveScmSnapshot) return null;
        return buildSnapshotSignature(effectiveScmSnapshot);
    }, [effectiveScmSnapshot]);
    const getSnapshotSignature = React.useCallback(() => snapshotSignature, [snapshotSignature]);

    const {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    } = useScmCommitHistory({
        sessionId: props.sessionId,
        readLogEnabled: effectiveScmSnapshot?.repo.isRepo === true && (effectiveScmSnapshot?.capabilities?.readLog ?? true),
        sessionPath,
    });

    const refreshScmData = React.useCallback(async () => {
        await scmStatusSync.invalidateFromUserAndAwait(props.sessionId);
    }, [props.sessionId]);
    const refreshScmDataFromAutoRefresh = React.useCallback(async () => {
        await scmStatusSync.invalidateFromAutoRefreshAndAwait(props.sessionId);
    }, [props.sessionId]);

    const initialRefreshKey = `${props.sessionId}:${sessionPath ?? ''}`;
    const didInitialRefreshKeyRef = React.useRef<string | null>(null);
    const commitHistoryInitKey = `${props.sessionId}:${sessionPath ?? ''}`;
    const didInitCommitHistoryKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (didInitialRefreshKeyRef.current === initialRefreshKey) return;
        didInitialRefreshKeyRef.current = initialRefreshKey;
        void refreshScmDataFromAutoRefresh();
    }, [initialRefreshKey, refreshScmDataFromAutoRefresh]);

    useScmAdaptivePolling({
        enabled: Boolean(props.sessionId) && Boolean(sessionPath),
        baseIntervalMs,
        stepIntervalMs: baseIntervalMs,
        maxIntervalMs,
        getSignature: getSnapshotSignature,
        invalidateAndAwait: refreshScmDataFromAutoRefresh,
    });

    const {
        scmOperationBusy,
        scmOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommitFromMessage,
        commitMessageGeneratorEnabled,
        generateCommitMessageSuggestion,
    } = useFilesScmOperations({
        sessionId: props.sessionId,
        sessionPath,
        scmSnapshot: effectiveScmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        scmRemoteConfirmPolicy,
        scmPushRejectPolicy,
        refreshScmData,
        loadCommitHistory,
    });

    const pullPreflightReason = pullPreflight.allowed === false ? pullPreflight.reason : null;
    const pullPreflightMessage = pullPreflight.allowed === false ? pullPreflight.message : null;
    const pushPreflightReason = pushPreflight.allowed === false ? pushPreflight.reason : null;
    const pushPreflightMessage = pushPreflight.allowed === false ? pushPreflight.message : null;

    const remoteWriteEnabled =
        scmWriteEnabled
        && (
            effectiveScmSnapshot?.capabilities?.writeRemoteFetch === true
            || effectiveScmSnapshot?.capabilities?.writeRemotePull === true
            || effectiveScmSnapshot?.capabilities?.writeRemotePush === true
            || effectiveScmSnapshot?.capabilities?.readPullRequestStatus === true
            || effectiveScmSnapshot?.capabilities?.readHostingRepositoryPublishTargets === true
        )
        && pullPreflightReason !== 'write_disabled'
        && pushPreflightReason !== 'write_disabled';

    const availableTabs = React.useMemo<Array<{ id: 'commit' | 'update' | 'history'; label: string }>>(() => [
        { id: 'commit', label: t('files.toolbar.changedFiles') },
        ...(remoteWriteEnabled ? [{ id: 'update', label: t('common.update') } as const] : []),
        { id: 'history', label: t('common.history') },
    ], [remoteWriteEnabled]);
    const availableTabIdSet = React.useMemo(() => new Set(availableTabs.map((tab) => tab.id)), [availableTabs]);
    const displayActiveGitSubTab: 'commit' | 'update' | 'history' =
        availableTabIdSet.has(activeGitSubTab)
            ? activeGitSubTab
            : (availableTabs[0]?.id ?? 'commit');

    React.useEffect(() => {
        if (displayActiveGitSubTab === activeGitSubTab) return;
        setActiveGitSubTab(displayActiveGitSubTab);
    }, [activeGitSubTab, displayActiveGitSubTab, setActiveGitSubTab]);

    React.useEffect(() => {
        if (!shouldLoadSessionGitHistory({
            activeSubTab: displayActiveGitSubTab,
            sessionPath,
            commitHistoryInitKey,
            loadedCommitHistoryInitKey: didInitCommitHistoryKeyRef.current,
        })) {
            return;
        }
        didInitCommitHistoryKeyRef.current = commitHistoryInitKey;
        void loadCommitHistory({ reset: true });
    }, [commitHistoryInitKey, displayActiveGitSubTab, loadCommitHistory, sessionPath]);

    const loadMoreHistory = React.useCallback(() => {
        void loadCommitHistory();
    }, [loadCommitHistory]);

    const onFetch = React.useCallback(() => {
        void runRemoteOperation('fetch');
    }, [runRemoteOperation]);

    const onPull = React.useCallback(() => {
        void runRemoteOperation('pull');
    }, [runRemoteOperation]);

    const onPush = React.useCallback(() => {
        void runRemoteOperation('push');
    }, [runRemoteOperation]);

    const onCommitFromMessage = React.useCallback((message: string) => {
        void (async () => {
            const result = await createCommitFromMessage(message);
            if (result.ok) {
                setCommitDraftMessage('');
            }
        })();
    }, [createCommitFromMessage, setCommitDraftMessage]);

    const onGenerateCommitMessageSuggestion = React.useCallback(async () => {
        return await generateCommitMessageSuggestion();
    }, [generateCommitMessageSuggestion]);

    const onOpenFilesSidebar = React.useCallback(() => {
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [pane.openRight, pane.setRightTab]);

    const defaultOpenReviewAllChanges = React.useCallback(() => {
        pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }, [pane.openDetailsTab]);

    const defaultOpenStashDetails = React.useCallback(() => {
        pane.openDetailsTab(createSessionScmStashDetailsTab(), { intent: 'pinned' });
    }, [pane.openDetailsTab]);
    const onOpenReviewAllChangesSource = props.onOpenReviewAllChanges ?? defaultOpenReviewAllChanges;
    const onOpenStashDetailsSource = props.onOpenStashDetails ?? defaultOpenStashDetails;
    const onOpenReviewAllChangesRef = React.useRef(onOpenReviewAllChangesSource);
    const onOpenStashDetailsRef = React.useRef(onOpenStashDetailsSource);
    onOpenReviewAllChangesRef.current = onOpenReviewAllChangesSource;
    onOpenStashDetailsRef.current = onOpenStashDetailsSource;
    const onOpenReviewAllChanges = React.useCallback(() => {
        onOpenReviewAllChangesRef.current();
    }, []);
    const onOpenStashDetails = React.useCallback(() => {
        onOpenStashDetailsRef.current();
    }, []);

    const scmStatusFilesSummary: ScmStatusFiles | null = React.useMemo(() => {
        if (!effectiveScmSnapshot?.repo.isRepo) return null;
        return {
            includedFiles: [],
            pendingFiles: [],
            changeSetModel: effectiveScmSnapshot.capabilities?.changeSetModel ?? 'index',
            branch: effectiveScmSnapshot.branch.head,
            upstream: effectiveScmSnapshot.branch.upstream,
            ahead: effectiveScmSnapshot.branch.ahead,
            behind: effectiveScmSnapshot.branch.behind,
            detached: effectiveScmSnapshot.branch.detached,
            totalIncluded: effectiveScmSnapshot.totals.includedFiles,
            totalPending: effectiveScmSnapshot.totals.pendingFiles,
        };
    }, [effectiveScmSnapshot]);

    const isLockedByOtherSession = Boolean(
        inFlightScmOperation && inFlightScmOperation.sessionId !== props.sessionId
    );
    const { canPublish, publishBusy, publishBranch } = usePublishBranchAction({
        sessionId: props.sessionId,
        snapshot: effectiveScmSnapshot,
        writeEnabled: scmWriteEnabled === true && Boolean(sessionPath),
        disabled: false,
    });

    const remoteActions = React.useMemo(() => {
        const actions: SourceControlRemoteAction[] = [];
        if (!effectiveScmSnapshot?.repo.isRepo) return actions;
        const busy = scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession;
        const caps = effectiveScmSnapshot.capabilities;
        if (!caps) return actions;

        const remoteWriteEnabled =
            scmWriteEnabled
            && Boolean(sessionPath)
            && caps != null
            && !(pullPreflight.allowed === false && pullPreflight.reason === 'write_disabled')
            && !(pushPreflight.allowed === false && pushPreflight.reason === 'write_disabled');

        if (!remoteWriteEnabled) return actions;

        if (caps.writeRemoteFetch) {
            actions.push({
                key: 'fetch',
                iconName: 'arrows-clockwise',
                label: t('files.sourceControlOperations.actions.fetch'),
                disabled: busy,
                onPress: onFetch,
                testID: 'scm-update-remote-action-fetch',
            });
        }

        const pullVisible =
            caps.writeRemotePull === true
            && !(pullPreflightReason === 'feature_unsupported' || pullPreflightReason === 'write_disabled' || pullPreflightReason === 'upstream_required');
        if (pullVisible) {
            actions.push({
                key: 'pull',
                iconName: 'arrow-down',
                label: t('files.sourceControlOperations.actions.pull'),
                disabled: busy || !pullPreflight.allowed,
                onPress: onPull,
                testID: 'scm-update-remote-action-pull',
            });
        }

        const pushVisible =
            caps.writeRemotePush === true
            && !(pushPreflightReason === 'feature_unsupported' || pushPreflightReason === 'write_disabled' || pushPreflightReason === 'upstream_required');
        if (pushVisible) {
            actions.push({
                key: 'push',
                iconName: 'arrow-up',
                label: t('files.sourceControlOperations.actions.push'),
                disabled: busy || !pushPreflight.allowed,
                onPress: onPush,
                testID: 'scm-update-remote-action-push',
            });
        }

        if (canPublish && (pullPreflightReason === 'upstream_required' || pushPreflightReason === 'upstream_required')) {
            actions.push({
                key: 'publish',
                iconName: 'upload',
                label: t('files.branchMenu.publish.title'),
                disabled: busy,
                onPress: () => {
                    void publishBranch();
                },
                testID: 'scm-update-publish-branch',
            });
        }

        return actions;
    }, [
        canPublish,
        effectiveScmSnapshot,
        hasGlobalOperationInFlight,
        isLockedByOtherSession,
        onFetch,
        onPull,
        onPush,
        publishBranch,
        publishBusy,
        pullPreflight.allowed,
        pullPreflightReason,
        pushPreflight.allowed,
        pushPreflightReason,
        scmOperationBusy,
        scmWriteEnabled,
        sessionPath,
    ]);

    const remoteHint = React.useMemo(() => {
        if (!remoteActions.length) return null;
        if (pullPreflight.allowed === false && pullPreflightReason !== 'write_disabled' && pullPreflightReason !== 'feature_unsupported' && pullPreflightReason !== 'upstream_required') {
            return `${t('files.sourceControlOperations.blockedHints.pullBlocked')}: ${pullPreflightMessage ?? ''}`;
        }
        if (pushPreflight.allowed === false && pushPreflightReason !== 'write_disabled' && pushPreflightReason !== 'feature_unsupported' && pushPreflightReason !== 'upstream_required') {
            return `${t('files.sourceControlOperations.blockedHints.pushBlocked')}: ${pushPreflightMessage ?? ''}`;
        }
        return null;
    }, [pullPreflight.allowed, pullPreflightMessage, pullPreflightReason, pushPreflight.allowed, pushPreflightMessage, pushPreflightReason, remoteActions.length]);

    const commitAdjacentPushState = React.useMemo(() => {
        return resolveCommitAdjacentPushActionState({
            snapshot: effectiveScmSnapshot,
            pushPreflight,
            scmWriteEnabled,
            sessionPath,
            scmOperationBusy,
            hasGlobalOperationInFlight,
            isLockedByOtherSession,
        });
    }, [
        effectiveScmSnapshot,
        hasGlobalOperationInFlight,
        isLockedByOtherSession,
        pushPreflight,
        scmOperationBusy,
        scmWriteEnabled,
        sessionPath,
    ]);
    const onCommitAdjacentPush = React.useCallback(() => {
        if (!commitAdjacentPushState.visible) return;
        void (async () => {
            const confirmed = await confirmCommitAdjacentPush({
                target: commitAdjacentPushState.target,
                policy: scmRemoteConfirmPolicy,
                setRemoteConfirmPolicy: setScmRemoteConfirmPolicy,
                detachedHeadLabel: t('files.detachedHead'),
            });
            if (!confirmed) return;
            await runRemoteOperation('push', { skipConfirmation: true });
        })();
    }, [
        commitAdjacentPushState,
        runRemoteOperation,
        scmRemoteConfirmPolicy,
        setScmRemoteConfirmPolicy,
    ]);
    const commitAdjacentPushAction = React.useMemo(() => {
        if (!commitAdjacentPushState.visible) return undefined;
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

    const refreshScmDataFromMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [props.sessionId]);
    const runSessionUpdateMutation = React.useCallback(async <T extends ScmUpdateMutationResponse>(input: {
        operation: ScmProjectOperationKind;
        fallbackError: string;
        run: () => Promise<T>;
    }): Promise<T> => {
        const lockResult = await withSessionProjectScmOperationLock({
            state: storage.getState(),
            sessionId: props.sessionId,
            operation: input.operation,
            run: async () => {
                let response = await input.run();
                if (!response.success) {
                    if (sessionPath) {
                        response = await runScmOperationWithGitIndexLockRecovery({
                            cwd: sessionPath,
                            failedResponse: response,
                            removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(props.sessionId, request),
                            retryOriginalOperation: input.run,
                        });
                    }
                }
                if (!response.success) {
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId: props.sessionId,
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

                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId: props.sessionId,
                    operation: input.operation,
                    status: 'success',
                    surface: 'update',
                    tracking: null,
                });
                return response;
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
    }, [props.sessionId, sessionPath]);
    const addRemote = React.useCallback(
        (request: Parameters<typeof sessionScmRemoteAdd>[1]) => runSessionUpdateMutation({
            operation: 'remote_add',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.addFailed'),
            run: () => sessionScmRemoteAdd(props.sessionId, request),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const setRemoteUrl = React.useCallback(
        (request: Parameters<typeof sessionScmRemoteSetUrl>[1]) => runSessionUpdateMutation({
            operation: 'remote_set_url',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.saveFailed'),
            run: () => sessionScmRemoteSetUrl(props.sessionId, request),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const removeRemote = React.useCallback(
        (name: string) => runSessionUpdateMutation({
            operation: 'remote_remove',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.removeFailed'),
            run: () => sessionScmRemoteRemove(props.sessionId, { name }),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const mergeBranch = React.useCallback(
        (sourceRef: string) => runSessionUpdateMutation({
            operation: 'branch_merge',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.mergeFailed'),
            run: () => sessionScmBranchMerge(props.sessionId, { sourceRef }),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const rebaseBranch = React.useCallback(
        (sourceRef: string) => runSessionUpdateMutation({
            operation: 'branch_rebase',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.rebaseFailed'),
            run: () => sessionScmBranchRebase(props.sessionId, { sourceRef }),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const continueBranchOperation = React.useCallback(
        (operation: 'merge' | 'rebase') => runSessionUpdateMutation({
            operation: 'branch_operation_continue',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            run: () => sessionScmBranchOperationContinue(props.sessionId, { operation }),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const abortBranchOperation = React.useCallback(
        (operation: 'merge' | 'rebase') => runSessionUpdateMutation({
            operation: 'branch_operation_abort',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
            run: () => sessionScmBranchOperationAbort(props.sessionId, { operation }),
        }),
        [props.sessionId, runSessionUpdateMutation],
    );
    const initializeRepository = React.useCallback(
        () => sessionScmRepositoryInit(props.sessionId, {}),
        [props.sessionId],
    );
    const openOrReusePullRequest = React.useCallback(
        (request: { base: string; head: string }) => sessionScmPullRequestOpenOrReuse(props.sessionId, request),
        [props.sessionId],
    );
    const openComposePullRequest = React.useCallback(
        (request: { base: string; head: string }) => sessionScmPullRequestOpenCompose(props.sessionId, request),
        [props.sessionId],
    );
    const createFeatureBranch = React.useCallback(
        (request: { name: string; checkout: true; startPoint?: string }) => sessionScmBranchCreate(props.sessionId, request),
        [props.sessionId],
    );
    const publishProviderKind = effectiveScmSnapshot?.hostingProvider?.kind ?? null;
    const describePublishTargets = React.useCallback(
        () => sessionScmHostingRepositoryDescribePublishTargets(props.sessionId, {
            ...(publishProviderKind ? { providerKind: publishProviderKind } : {}),
        }),
        [props.sessionId, publishProviderKind],
    );
    const publishRepository = React.useCallback(
        (request: Parameters<typeof sessionScmHostingRepositoryPublish>[1]) => sessionScmHostingRepositoryPublish(props.sessionId, request),
        [props.sessionId],
    );
    const publishRemediationMachineId = normalizeOptionalRouteSegment(project?.key.machineId ?? ownerMetadata?.machineId ?? null);
    const publishRemediationServerId = normalizeOptionalRouteSegment(project?.key.serverId ?? session?.serverId ?? activeServerSnapshot.serverId);
    const openGitHubConnectedService = React.useCallback(() => {
        router.push({ pathname: '/(app)/settings/connected-services/[serviceId]', params: { serviceId: 'github' } });
    }, []);
    const openMachineInstallables = React.useCallback(() => {
        if (!publishRemediationMachineId) return;
        const serverQuery = publishRemediationServerId ? `?serverId=${encodeURIComponent(publishRemediationServerId)}` : '';
        router.push(`/machine/${encodeURIComponent(publishRemediationMachineId)}/installables${serverQuery}` as never);
    }, [publishRemediationMachineId, publishRemediationServerId]);

    if (!effectiveScmSnapshot && scmSnapshotError) {
        if (isSessionInactive && !machineRpcTargetAvailable) {
            return (
                <SourceControlSessionInactiveState
                    machineReachable={machineReachable}
                    onOpenSession={resumeSession ?? requestSessionResume}
                />
            );
        }

        // `SourceControlUnavailableState` owns the typed body: it resolves user-facing copy from the
        // structured `errorCode` and only shows `details` as a sanitized supplementary line. This
        // view used to hand-roll a one-code ternary and pass the raw `.message` as the whole story,
        // so a transport-level exception was rendered verbatim in the user error slot (`F-UI-2`).
        // The workspace twin already passes the code through; do the same here rather than keeping a
        // second mapper for the same concept.
        const scmSnapshotErrorCode = typeof (scmSnapshotError as { errorCode?: unknown }).errorCode === 'string'
            ? (scmSnapshotError as { errorCode: string }).errorCode
            : undefined;
        const userFacingDetails = scmSnapshotErrorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
            ? t('deps.installNotSupported')
            : scmSnapshotError.message;

        return (
            <SourceControlUnavailableState
                testID="session-rightpanel-git-unavailable"
                details={userFacingDetails}
                {...(scmSnapshotErrorCode ? { errorCode: scmSnapshotErrorCode } : {})}
                onRetry={() => void refreshScmData()}
            />
        );
    }

    if (!effectiveScmSnapshot) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.text.secondary }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    // `F-SCM-2`: the branch above is the only place this view reported a snapshot error, and
    // `scmStatusSync` stores an error WITHOUT clearing the snapshot — so once anything had been
    // cached, every later refresh failure was invisible and stale content read as current. From
    // here on the content is real but possibly stale, so the failure travels WITH it.
    const staleSnapshotNotice = (
        <SourceControlStaleSnapshotNotice
            testID="session-rightpanel-git-stale"
            error={scmSnapshotError}
            onRetry={() => void refreshScmData()}
        />
    );

    if (!effectiveScmSnapshot.repo.isRepo) {
        return (
            <View style={{ flex: 1 }}>
                {staleSnapshotNotice}
                <NotSourceControlRepositoryState
                    canInitializeRepository={scmWriteEnabled && effectiveScmSnapshot.capabilities?.writeRepositoryInit === true}
                    initializeRepositoryBusy={scmOperationBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                    onInitializeRepository={initializeRepository}
                    onRefresh={refreshScmDataFromMutation}
                />
            </View>
        );
    }

    const scmUiPlugin = backendUiRegistry.getPluginForSnapshot(effectiveScmSnapshot);
    const backendLabel = scmUiPlugin.displayName;
    const commitActionLabel = scmUiPlugin.commitActionConfig(effectiveScmSnapshot).label;

    const commitAllowed = commitPreflight.allowed;
    const hasConflicts = effectiveScmSnapshot?.hasConflicts === true;

    const globalLockMessage = isLockedByOtherSession
        ? t('files.sourceControlOperations.globalLock')
        : null;
    const commitAllowedForComposer = commitAllowed && !hasGlobalOperationInFlight && !isLockedByOtherSession;
    const commitBlockedMessageForComposer = globalLockMessage ?? (commitAllowed ? null : commitPreflight.message);

    const commitWriteEnabled =
        scmWriteEnabled
        && effectiveScmSnapshot?.capabilities?.writeCommit === true
        && !(commitPreflight.allowed === false && commitPreflight.reason === 'write_disabled');
    const commitSelectionUiEnabled = commitWriteEnabled;

    const commitTab = (
        <SessionRightPanelGitCommitTabContent
            theme={theme}
            sessionId={props.sessionId}
            sessionPath={sessionPath}
            scmSnapshot={effectiveScmSnapshot}
            touchedPaths={touchedPaths}
            operationLog={operationLog}
            projectSessionIds={projectSessionIds}
            commitSelectionPaths={commitSelectionPaths}
            commitSelectionPatches={commitSelectionPatches}
            scmCommitStrategy={scmCommitStrategy}
            scmWriteEnabled={scmWriteEnabled}
            inFlightScmOperation={inFlightScmOperation}
            hasGlobalOperationInFlight={hasGlobalOperationInFlight}
            scmOperationBusy={scmOperationBusy}
            scmOperationStatus={scmOperationStatus}
            backendLabel={backendLabel}
            commitActionLabel={commitActionLabel}
            hasConflicts={hasConflicts}
            commitAllowedForComposer={commitAllowedForComposer}
            commitBlockedMessageForComposer={commitBlockedMessageForComposer}
            commitWriteEnabled={commitWriteEnabled}
            commitSelectionUiEnabled={commitSelectionUiEnabled}
            commitDraftMessage={commitDraftMessage}
            onCommitDraftMessageChange={setCommitDraftMessage}
            onCommitFromMessage={onCommitFromMessage}
            commitMessageGeneratorEnabled={commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={onGenerateCommitMessageSuggestion}
            commitAdjacentPushAction={commitAdjacentPushAction}
            onOpenFilesSidebar={onOpenFilesSidebar}
            onOpenReviewAllChanges={onOpenReviewAllChanges}
            onOpenStashDetails={onOpenStashDetails}
            openFileInDetails={openFileInDetails}
            openFileInDetailsPinned={openFileInDetailsPinned}
            showBranchSummary={displayActiveGitSubTab === 'commit'}
        />
    );

    const updateTab = (
        <WorkspaceScmUpdateTab
            theme={theme}
            actions={remoteActions}
            hint={remoteHint}
            scmStatusFiles={scmStatusFilesSummary}
            showBranchSummary={displayActiveGitSubTab === 'update'}
            branchTrigger={scmStatusFilesSummary ? (
                <SourceControlBranchMenu
                    sessionId={props.sessionId}
                    currentBranch={scmStatusFilesSummary.branch ?? null}
                    snapshot={effectiveScmSnapshot}
                    writeEnabled={scmWriteEnabled}
                    disabled={scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                    testID="scm-branch-menu-trigger"
                />
            ) : null}
        >
            <SourceControlPullRequestSection
                theme={theme}
                snapshot={effectiveScmSnapshot}
                disabled={scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                onOpenOrReuse={openOrReusePullRequest}
                onOpenCompose={openComposePullRequest}
                onCreateFeatureBranch={createFeatureBranch}
                onRefresh={refreshScmDataFromMutation}
            />
            <SourceControlPublishRepositorySection
                theme={theme}
                snapshot={effectiveScmSnapshot}
                writeEnabled={scmWriteEnabled}
                disabled={scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                publishTargets={null}
                onDescribePublishTargets={describePublishTargets}
                onPublishRepository={publishRepository}
                onRefresh={refreshScmDataFromMutation}
                onConnectGitHub={openGitHubConnectedService}
                onInstallGh={publishRemediationMachineId ? openMachineInstallables : undefined}
                onUseManagedGh={publishRemediationMachineId ? openMachineInstallables : undefined}
                onAuthenticateGh={publishRemediationMachineId ? openMachineInstallables : undefined}
            />
            <SourceControlRemotesSection
                theme={theme}
                snapshot={effectiveScmSnapshot}
                writeEnabled={scmWriteEnabled}
                disabled={scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                onAddRemote={addRemote}
                onSetRemoteUrl={setRemoteUrl}
                onRemoveRemote={removeRemote}
                onRefresh={refreshScmDataFromMutation}
            />
            <SourceControlBranchIntegrationSection
                theme={theme}
                snapshot={effectiveScmSnapshot}
                rootPath={sessionPath}
                writeEnabled={scmWriteEnabled}
                disabled={scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
                onMerge={mergeBranch}
                onRebase={rebaseBranch}
                onContinue={continueBranchOperation}
                onAbort={abortBranchOperation}
                onRefresh={refreshScmDataFromMutation}
            />
        </WorkspaceScmUpdateTab>
    );

    const historyTab = (
        <WorkspaceScmHistoryTab
            theme={theme}
            historyLoading={historyLoading}
            historyEntries={historyEntries}
            historyHasMore={historyHasMore}
            onLoadMoreHistory={loadMoreHistory}
            onOpenCommit={openCommitInDetails}
        />
    );

    return (
        <View style={{ flex: 1 }}>
            <WorkspaceScmSubTabsBar
                tabs={availableTabs}
                activeSubTabId={displayActiveGitSubTab}
                onSelectSubTab={setActiveGitSubTab}
            />
            {staleSnapshotNotice}
            <View style={{ flex: 1, position: 'relative' }}>
                <GitSubTabSurface testID="session-rightpanel-git-surface:commit" isActive={displayActiveGitSubTab === 'commit'}>
                    {commitTab}
                </GitSubTabSurface>
                {availableTabIdSet.has('update') ? (
                    <GitSubTabSurface testID="session-rightpanel-git-surface:update" isActive={displayActiveGitSubTab === 'update'}>
                        {updateTab}
                    </GitSubTabSurface>
                ) : null}
                <GitSubTabSurface testID="session-rightpanel-git-surface:history" isActive={displayActiveGitSubTab === 'history'}>
                    {historyTab}
                </GitSubTabSurface>
            </View>
        </View>
    );
});

const GitSubTabSurface = React.memo((props: Readonly<{ testID?: string; isActive: boolean; children: React.ReactNode }>) => {
    const [hasMounted, setHasMounted] = React.useState(props.isActive);
    React.useEffect(() => {
        if (!props.isActive) return;
        setHasMounted(true);
    }, [props.isActive]);

    if (!props.isActive && !hasMounted) return null;

    const a11yHiddenProps =
        Platform.OS === 'web'
            ? null
            : {
                accessibilityElementsHidden: !props.isActive,
                importantForAccessibility: props.isActive ? ('auto' as const) : ('no-hide-descendants' as const),
            };
    return (
        <View
            style={[
                StyleSheet.absoluteFillObject,
                {
                    opacity: props.isActive ? 1 : 0,
                    pointerEvents: props.isActive ? 'auto' : 'none',
                    display: Platform.OS === 'web' ? (props.isActive ? 'flex' : 'none') : 'flex',
                },
            ]}
            testID={props.testID}
            {...(a11yHiddenProps ?? {})}
        >
            {props.children}
        </View>
    );
});
