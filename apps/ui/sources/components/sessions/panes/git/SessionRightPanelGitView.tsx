import { readSessionDirectoryKind } from '@happier-dev/protocol';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import { useSessionFilePaneNavigation } from '@/components/sessions/panes/useSessionFileDetailsOpener';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlStaleSnapshotNotice, SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionResumeAction } from '@/components/sessions/model/SessionResumeContext';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { usePublishBranchAction } from '@/hooks/session/sourceControl/usePublishBranchAction';
import { useSessionScmDraft } from '@/hooks/session/sourceControl/useSessionScmDraft';
import { useSessionScmWriteOperation } from '@/hooks/session/sourceControl/useSessionScmWriteOperation';
import { useScmIncomingCommits } from '@/hooks/session/sourceControl/useScmIncomingCommits';
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
import { usePaneHeaderSlotContent, type PaneHeaderLineSegment } from '@/components/appShell/panes/paneHeaderSlot';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { selectScmChangedFiles, selectScmConflictFiles } from '@/scm/scmStatusFiles';
import { isFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import { inferRemoteTargetFromSnapshot, resolveForceWithLeaseTarget } from '@/scm/operations/remoteTarget';
import { resolveSessionGitPaneActions, resolveSessionGitPaneHeaderFacts, type SessionGitPaneActionKey } from './sessionGitPaneHeader';
import {
    useProjectForSession,
    useSessionListRenderableWithServerScope,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmOperationLog,
    useSessionProjectScmSnapshot,
    useSessionProjectScmSnapshotError,
    useSessionRealtimeScmTranscriptConsumer,
    useWorkspaceScmTouchedPathsForSession,
    useSetting,
} from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolveAgentIdFromSessionMetadata, getAgentCore } from '@/agents/catalog/catalog';
import { useSessionTerminalAction } from '@/components/sessions/terminal/useSessionTerminalAction';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { GitPaneLayout, resolveGitPaneActiveSubTab } from '@/components/workspaces/scm/GitPaneLayout';
import { SessionRightPanelGitCommitTabContent } from './SessionRightPanelGitCommitTabContent';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import { useSessionRightPanelGitOpenDetails } from './useSessionRightPanelGitOpenDetails';
import type { SourceControlRemoteAction } from '@/components/workspaces/scm/SourceControlRemoteActionsRail';
import {
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { sessionScmRepositoryInit } from '@/sync/ops/sessions';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { GitOutcomeLine, type GitOutcomeFacts } from './GitOutcomeLine';
import { GitNextActionButton, type GitNextActionMenuExtra } from './GitNextActionButton';
import { GitTimelineSection } from './GitTimelineSection';
import { GitConflictNotice } from './GitConflictNotice';
import { GitCleanState } from './GitCleanState';
import { showGitRemotesAndMergesSheet } from './GitRemotesAndMergesSheet';
import { useSessionGitRepositoryMutations } from './useSessionGitRepositoryMutations';
import { GitPullRequestSection } from './pullRequest/GitPullRequestSection';
import { GitBranchButton } from './branches/GitBranchButton';
import { GitKeptAsideNotice } from './branches/GitKeptAsideNotice';
import { GitDisplayMenu, useGitDisplaySettings } from './display/GitDisplayMenu';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { requestGitPullRequestForm } from './pullRequest/gitPullRequestFormState';
import { resolveSourceControlPullRequestViewModel } from '@/components/workspaces/scm/update/resolveSourceControlPullRequestViewModel';
import { selectLastSuccessfulScmPushAt } from '@/scm/operations/selectScmWriteOperation';

export type SessionRightPanelGitViewProps = Readonly<{
    sessionId: string;
    serverId?: string;
    scopeId: string;
    onOpenFile?: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    onOpenCommit?: (sha: string) => void;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

export const SessionRightPanelGitView = React.memo((props: SessionRightPanelGitViewProps) => {
    const router = useDestinationRouter();
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const terminal = useSessionTerminalAction({ sessionId: props.sessionId, serverId: props.serverId, scopeId: props.scopeId });
    const pane = useAppPaneScope(props.scopeId);
    const fileNavigation = useSessionFilePaneNavigation({ scopeId: props.scopeId, sessionId: props.sessionId, serverId: props.serverId ?? resolveServerIdForSessionIdFromLocalCache(props.sessionId) });
    const resumeSession = useSessionResumeAction();
    const requestSessionResume = React.useCallback(() => {
        fireAndForget(emitSessionResumeRequest(props.sessionId, props.serverId), {
            tag: 'SessionRightPanelGitView.resumeSession',
        });
    }, [props.sessionId, props.serverId]);
    const { activeGitSubTab, setActiveGitSubTab } = useWorkspaceScmTabState(pane);
    // The commit message lives on the session's one draft owner, so every placement and device sees it.
    const scmDraft = useSessionScmDraft({ sessionId: props.sessionId, serverId: props.serverId });
    const commitDraftMessage = scmDraft.draft.commitMessage;
    const setCommitDraftMessage = scmDraft.setCommitMessage;
    const { paneLayout, changesLayout } = useGitDisplaySettings();
    const displayMenu = React.useMemo(() => <GitDisplayMenu />, []);
    const openWalkThrough = React.useCallback(() => {
        pane.openDetailsTab(createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' }), { intent: 'pinned' });
    }, [pane.openDetailsTab]);
    const scopeAccessory = React.useMemo(() => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {displayMenu}
            <RoundButton testID="session-rightpanel-git-walkthrough" size="small" display="inverted"
                title={t('turnChanges.card.walkThrough')} onPress={openWalkThrough}
                leading={<Icon name="path" size={14} color={theme.colors.text.secondary} />} />
        </View>
    ), [displayMenu, openWalkThrough, theme.colors.text.secondary]);
    const defaultOpenDetails = useSessionRightPanelGitOpenDetails(pane);
    // Open (or a second tap) jumps to that commit in the Commits view; the view scrolls it into place.
    const openCommitPlan = React.useCallback((groupId?: string) => {
        pane.openDetailsTab(createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'commits' }), { intent: 'pinned' });
        if (groupId) {
            const previous = pane.scopeState?.details?.tabState?.['scmReview:working'];
            pane.setDetailsTabState('scmReview:working', { ...(previous && typeof previous === 'object' ? previous : {}), commitGroupId: groupId });
        }
    }, [pane.openDetailsTab, pane.setDetailsTabState, pane.scopeState]);
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

    const session = useSessionListRenderableWithServerScope(props.serverId, props.sessionId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const agent = agentId ? getAgentCore(agentId) : null;
    const agentName = agent ? t(agent.displayNameKey) : null;
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId);
    const lastGoodScmSnapshot = useLastNonNullValue(scmSnapshot, { resetKey: props.scopeId });
    const effectiveScmSnapshot = scmSnapshot ?? lastGoodScmSnapshot;
    useSessionRealtimeScmTranscriptConsumer({ serverId: props.serverId ?? null, sessionId: props.sessionId }, effectiveScmSnapshot);
    const scmSnapshotError = useSessionProjectScmSnapshotError(props.sessionId, props.serverId);
    const workspaceTouchedPaths = useWorkspaceScmTouchedPathsForSession(props.sessionId, props.serverId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(props.sessionId, props.serverId);
    const operationLog = useSessionProjectScmOperationLog(props.sessionId, props.serverId);
    const lastPushedAt = React.useMemo(() => effectiveScmSnapshot ? selectLastSuccessfulScmPushAt(operationLog, inferRemoteTargetFromSnapshot(effectiveScmSnapshot)) : null, [operationLog, effectiveScmSnapshot]);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(props.sessionId, props.serverId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(props.sessionId, props.serverId);
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const autoRefreshIntervalSetting = useSetting('scmFilesAutoRefreshIntervalMs');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations', props.serverId ? { scopeKind: 'spawn', serverId: props.serverId } : undefined);
    const activeServerSnapshot = useActiveServerSnapshot();
    const project = useProjectForSession(props.sessionId, props.serverId);
    const contributionCatalog = useDaemonScmContributionCatalog({
        machineId: project?.key.machineId ?? ownerMetadata?.machineId ?? null,
        serverId: props.serverId ?? project?.key.serverId ?? activeServerSnapshot.serverId,
    });
    const backendUiRegistry = React.useMemo(
        () => createScmUiBackendRegistry(contributionCatalog),
        [contributionCatalog],
    );
    const hasGlobalOperationInFlight = Boolean(inFlightScmOperation);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: ownerMetadata?.path ?? null,
        projectPath: project?.key?.rootPath ?? null,
    });
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId, props.serverId);
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
        historyIdentity: commitHistoryInitKey,
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    } = useScmCommitHistory({
        sessionId: props.sessionId, serverId: props.serverId,
        readLogEnabled: effectiveScmSnapshot?.repo.isRepo === true && (effectiveScmSnapshot?.capabilities?.readLog ?? true),
        sessionPath,
        historyBranch: effectiveScmSnapshot?.branch.head,
    });

    const refreshScmData = React.useCallback(async () => {
        await scmStatusSync.invalidateFromUserAndAwait(props.sessionId, props.serverId);
    }, [props.sessionId, props.serverId]);
    const refreshScmDataFromAutoRefresh = React.useCallback(async () => {
        await scmStatusSync.invalidateFromAutoRefreshAndAwait(props.sessionId, props.serverId);
    }, [props.sessionId, props.serverId]);

    const initialRefreshKey = JSON.stringify([props.serverId, props.sessionId, sessionPath]);
    const didInitialRefreshKeyRef = React.useRef<string | null>(null);
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
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommitFromMessage,
        commitMessageGeneratorEnabled,
        generateCommitMessageSuggestion,
    } = useFilesScmOperations({
        sessionId: props.sessionId, serverId: props.serverId,
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
    const pushPreflightReason = pushPreflight.allowed === false ? pushPreflight.reason : null;

    // The one change count (the same list length the rail badge, the header and the cockpit read).
    const changedFileCount = React.useMemo(
        () => (effectiveScmSnapshot?.repo.isRepo ? selectScmChangedFiles(effectiveScmSnapshot).length : 0),
        [effectiveScmSnapshot],
    );
    const selectedForCommitCount = React.useMemo(() => {
        if (!effectiveScmSnapshot?.repo.isRepo) return 0;
        const atomicSelectionPaths = new Set<string>(commitSelectionPaths);
        for (const patch of commitSelectionPatches) atomicSelectionPaths.add(patch.path);
        return selectScmChangedFiles(effectiveScmSnapshot)
            .filter((file) => isFileSelectedForCommit({ commitStrategy: scmCommitStrategy, file, atomicSelectionPaths }))
            .length;
    }, [commitSelectionPatches, commitSelectionPaths, effectiveScmSnapshot, scmCommitStrategy]);
    const conflictPaths = React.useMemo(
        () => (effectiveScmSnapshot?.repo.isRepo ? selectScmConflictFiles(effectiveScmSnapshot).map((file) => file.path) : []),
        [effectiveScmSnapshot],
    );

    // Tabs layout (a setting, not a second design): Changes | History from the same sections.
    const displayActiveGitSubTab = resolveGitPaneActiveSubTab(paneLayout, activeGitSubTab);
    const timelineVisible = paneLayout === 'unified' || displayActiveGitSubTab === 'history';
    const commitHistoryRefreshKey = JSON.stringify([commitHistoryInitKey, effectiveScmSnapshot?.branch.headOid ?? null]);
    React.useEffect(() => {
        if (!timelineVisible || !sessionPath) return;
        if (didInitCommitHistoryKeyRef.current === commitHistoryRefreshKey || historyLoading) return;
        didInitCommitHistoryKeyRef.current = commitHistoryRefreshKey;
        void loadCommitHistory({ reset: true });
    }, [commitHistoryRefreshKey, historyLoading, loadCommitHistory, sessionPath, timelineVisible]);
    const loadMoreHistory = React.useCallback(() => {
        void loadCommitHistory();
    }, [loadCommitHistory]);
    const incomingCommits = useScmIncomingCommits({
        sessionId: props.sessionId,
        serverId: props.serverId,
        enabled: timelineVisible && effectiveScmSnapshot?.repo.isRepo === true,
        upstream: effectiveScmSnapshot?.branch.upstream ?? null,
        behind: effectiveScmSnapshot?.branch.behind ?? 0,
        head: effectiveScmSnapshot?.branch.head ?? null,
    });

    const onCommitFromMessage = React.useCallback(async (message: string) => {
        const result = await createCommitFromMessage(message);
        if (result.ok) {
            setCommitDraftMessage('');
        }
        return result;
    }, [createCommitFromMessage, setCommitDraftMessage]);

    const onGenerateCommitMessageSuggestion = React.useCallback(async () => {
        return await generateCommitMessageSuggestion();
    }, [generateCommitMessageSuggestion]);

    const onOpenFilesSidebar = fileNavigation.openFiles;

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

    const isLockedByOtherSession = Boolean(
        inFlightScmOperation && inFlightScmOperation.sessionId !== props.sessionId
    );
    const { canPublish, publishBusy, publishBranch } = usePublishBranchAction({
        sessionId: props.sessionId, serverId: props.serverId,
        snapshot: effectiveScmSnapshot,
        writeEnabled: scmWriteEnabled === true && Boolean(sessionPath),
        disabled: false,
    });

    // What the remote allows right now (capability, policy and preflight); the header resolver picks from it.
    const remoteActions = React.useMemo(() => {
        const actions: Array<Pick<SourceControlRemoteAction, 'key' | 'disabled'>> = [];
        if (!effectiveScmSnapshot?.repo.isRepo) return actions;
        const caps = effectiveScmSnapshot.capabilities;
        if (!caps || !scmWriteEnabled || !sessionPath) return actions;
        if (pullPreflightReason === 'write_disabled' || pushPreflightReason === 'write_disabled') return actions;
        const busy = scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession || !machineRpcTargetAvailable;
        if (caps.writeRemoteFetch) actions.push({ key: 'fetch', disabled: busy });
        if (caps.writeRemotePull === true
            && !(pullPreflightReason === 'feature_unsupported' || pullPreflightReason === 'upstream_required')) {
            actions.push({ key: 'pull', disabled: busy || !pullPreflight.allowed });
        }
        if (caps.writeRemotePush === true
            && !(pushPreflightReason === 'feature_unsupported' || pushPreflightReason === 'upstream_required')) {
            actions.push({ key: 'push', disabled: busy || !pushPreflight.allowed });
        }
        if (canPublish && (pullPreflightReason === 'upstream_required' || pushPreflightReason === 'upstream_required')) {
            actions.push({ key: 'publish', disabled: busy });
        }
        return actions;
    }, [
        canPublish,
        effectiveScmSnapshot,
        hasGlobalOperationInFlight,
        isLockedByOtherSession,
        machineRpcTargetAvailable,
        publishBusy,
        pullPreflight.allowed,
        pullPreflightReason,
        pushPreflight.allowed,
        pushPreflightReason,
        scmOperationBusy,
        scmWriteEnabled,
        sessionPath,
    ]);

    const refreshScmDataFromMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
    }, [props.sessionId, props.serverId]);
    const refreshAfterUndo = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
        await loadCommitHistory({ reset: true });
    }, [loadCommitHistory, props.serverId, props.sessionId]);
    const repositoryMutations = useSessionGitRepositoryMutations({ sessionId: props.sessionId, serverId: props.serverId, sessionPath, refreshAfterUndo });
    const initializeRepository = React.useCallback(
        () => sessionScmRepositoryInit(props.sessionId, {}, props.serverId),
        [props.sessionId, props.serverId],
    );

    // The pane header (desktop band, phone large title) carries where you are, the one change count and the
    // next sync step; the body never draws a header of its own.
    const sessionPaused = isSessionInactive && !machineRpcTargetAvailable;
    const machineName = useSessionMachineName(props.sessionId, props.serverId);
    const writeOperation = useSessionScmWriteOperation({
        sessionId: props.sessionId,
        serverId: props.serverId,
        machineReachable,
        ...(machineName ? { machine: machineName } : {}),
        ...(effectiveScmSnapshot?.hostingProvider?.kind ? { provider: providerDisplayName(effectiveScmSnapshot.hostingProvider.kind) } : {}),
    });
    const commitReady = commitPreflight.allowed
        && !hasGlobalOperationInFlight
        && !isLockedByOtherSession
        && selectedForCommitCount > 0
        && commitDraftMessage.trim().length > 0;
    const isRepo = effectiveScmSnapshot?.repo.isRepo === true;
    const pullRequestStatus = effectiveScmSnapshot?.pullRequestStatus ?? null;
    const openPullRequest = pullRequestStatus?.openPullRequest ?? null;
    // One PR availability decision (existing PR / in-app create / provider compose page / unavailable).
    const pullRequestModel = React.useMemo(
        () => resolveSourceControlPullRequestViewModel({ snapshot: effectiveScmSnapshot }),
        [effectiveScmSnapshot],
    );
    const canCreatePr = scmWriteEnabled && pullRequestModel.kind === 'create' && Boolean(effectiveScmSnapshot?.branch.upstream);
    const paneActions = React.useMemo(() => {
        if (!effectiveScmSnapshot || !isRepo) return null;
        const branch = effectiveScmSnapshot.branch;
        return resolveSessionGitPaneActions({
            changedCount: changedFileCount,
            ahead: branch.ahead,
            behind: branch.behind,
            upstream: branch.upstream ?? null,
            hasConflicts: conflictPaths.length > 0,
            conflictCount: conflictPaths.length,
            prState: openPullRequest ? 'open' : pullRequestModel.kind === 'create' ? 'none' : 'unknown',
            prNumber: openPullRequest?.number ?? null,
            canCreatePr,
            commitReady,
            // A paused session cannot reach its remote: the menu keeps every step, each unavailable.
            remoteActions: sessionPaused ? [] : remoteActions,
            writeOperation,
        });
    }, [canCreatePr, changedFileCount, commitReady, conflictPaths.length, effectiveScmSnapshot, isRepo, openPullRequest, pullRequestModel.kind, remoteActions, sessionPaused, writeOperation]);
    const headerLineLeadingColor = theme.colors.text.secondary;
    const branchBusy = !scmWriteEnabled || scmOperationBusy || publishBusy || hasGlobalOperationInFlight || isLockedByOtherSession || sessionPaused;
    const headerBranchButton = React.useMemo(
        () => (effectiveScmSnapshot && isRepo ? (
            <GitBranchButton
                sessionId={props.sessionId}
                serverId={props.serverId}
                snapshot={effectiveScmSnapshot}
                disabled={branchBusy}
                onOpenStashDetails={onOpenStashDetails}
            />
        ) : null),
        [branchBusy, effectiveScmSnapshot, isRepo, onOpenStashDetails, props.serverId, props.sessionId],
    );
    const headerMachineGlyph = React.useMemo(
        () => <Icon name="laptop" size={13} color={headerLineLeadingColor} />,
        [headerLineLeadingColor],
    );
    const workspaceFolderName = React.useMemo(() => {
        const root = effectiveScmSnapshot?.repo.rootPath ?? sessionPath;
        if (!root) return null;
        const segments = root.split(/[\\/]+/).filter(Boolean);
        return segments[segments.length - 1] ?? null;
    }, [effectiveScmSnapshot?.repo.rootPath, sessionPath]);
    const headerLine = React.useMemo(() => {
        if (effectiveScmSnapshot && isRepo) {
            const branch = effectiveScmSnapshot.branch;
            const facts = resolveSessionGitPaneHeaderFacts({
                branch: branch.detached ? t('files.detachedHead') : branch.head,
                changedCount: changedFileCount,
                ahead: branch.ahead,
                behind: branch.behind,
                primaryKey: paneActions?.primary.key ?? null,
                operation: effectiveScmSnapshot.operationState,
                asOf: !machineReachable ? effectiveScmSnapshot.fetchedAt : null,
            });
            // The branch is the door to branches, stashes and worktrees (Git lab BR): it leads the line itself.
            const segments: PaneHeaderLineSegment[] = facts.flatMap((fact): PaneHeaderLineSegment[] => {
                switch (fact.kind) {
                    case 'branch': return [];
                    case 'asOf': return [t('surfaceState.asOf', { time: formatHappierAsOfTime(fact.at) })];
                    case 'changed': return [t('sessionGitPane.header.changed', { count: formatExactCount(fact.count) })];
                    case 'clean': return [t('sessionGitPane.flow.header.noChanges')];
                    case 'toPush': return [t('sessionGitPane.header.toPush', { count: formatExactCount(fact.count) })];
                    case 'toPull': return [t('sessionGitPane.header.toPull', { count: formatExactCount(fact.count) })];
                    case 'operation': return [t('sessionGitPane.fidelity.operation', { operation: t(fact.operation === 'cherry_pick' ? 'sessionGitPane.flow.conflicts.cherryPick' : fact.operation === 'merge' ? 'sessionGitPane.flow.conflicts.merge' : fact.operation === 'rebase' ? 'sessionGitPane.flow.conflicts.rebase' : 'sessionGitPane.flow.conflicts.revert'), source: fact.sourceRef ?? '' })];
                }
            });
            return { leading: headerBranchButton, segments };
        }
        // Not a repository yet: say which folder, and where it lives.
        if (effectiveScmSnapshot && !isRepo && workspaceFolderName) {
            return {
                leading: headerMachineGlyph,
                segments: [machineName
                    ? t('sessionGitPane.header.folderOnMachine', { folder: workspaceFolderName, machine: machineName })
                    : workspaceFolderName],
            };
        }
        return null;
    }, [changedFileCount, effectiveScmSnapshot, headerBranchButton, headerMachineGlyph, isRepo, machineName, machineReachable, paneActions?.primary.key, workspaceFolderName]);

    const runningKey: SessionGitPaneActionKey | null = writeOperation && (writeOperation.phase === 'queued' || writeOperation.phase === 'running')
        ? (writeOperation.action === 'push' || writeOperation.action === 'pull' || writeOperation.action === 'fetch'
            ? writeOperation.action
            : writeOperation.action === 'create_pr' ? 'create-pr' : null)
        : publishBusy ? 'publish' : null;

    const openPullRequestUrl = openPullRequest?.url ?? null;
    const onRunHeaderAction = React.useCallback((key: SessionGitPaneActionKey) => {
        if (key === 'push' || key === 'pull' || key === 'fetch') void runRemoteOperation(key);
        else if (key === 'publish') void publishBranch();
        else if (key === 'open-pr' && openPullRequestUrl) void openExternalUrl(openPullRequestUrl);
        else if (key === 'create-pr') requestGitPullRequestForm(props.sessionId, props.serverId);
    }, [openPullRequestUrl, props.serverId, props.sessionId, publishBranch, runRemoteOperation]);
    const undoLastCommit = React.useCallback(async (expectedHeadOid: string) => {
        if (!scmWriteEnabled || effectiveScmSnapshot?.capabilities?.writeCommitUndoLast !== true || branchBusy) return;
        await repositoryMutations.undoLastCommit(expectedHeadOid);
    }, [branchBusy, effectiveScmSnapshot?.capabilities?.writeCommitUndoLast, repositoryMutations, scmWriteEnabled]);
    const leaseTarget = React.useMemo(() => resolveForceWithLeaseTarget(effectiveScmSnapshot), [effectiveScmSnapshot]);
    const menuExtras = React.useMemo<readonly GitNextActionMenuExtra[]>(() => {
        const extras: GitNextActionMenuExtra[] = [{
            id: 'remotes-and-merges',
            title: t('sessionGitPane.flow.tools.title'),
            subtitle: t('sessionGitPane.flow.tools.subtitle'),
            icon: 'git-merge',
            onPress: () => showGitRemotesAndMergesSheet({ sessionId: props.sessionId, serverId: props.serverId, navigation: router }),
        }];
        if (effectiveScmSnapshot?.capabilities?.writeCommitUndoLast === true) {
            const headOid = effectiveScmSnapshot.branch.headOid;
            extras.push({ id: 'undo-last-commit', title: t('sessionGitPane.flow.undo.action'), subtitle: t('sessionGitPane.flow.undo.description'), icon: 'clock-counter-clockwise', disabled: branchBusy || !headOid, onPress: () => { if (headOid) void undoLastCommit(headOid); } });
        }
        if (effectiveScmSnapshot?.capabilities?.writeRemoteForceWithLease === true) {
            extras.push({ id: 'force-with-lease', title: t('sessionGitPane.flow.lease.push'), subtitle: t(leaseTarget ? 'sessionGitPane.flow.lease.description' : 'sessionGitPane.flow.lease.fetchFirst'), icon: 'arrow-up', disabled: branchBusy || !leaseTarget, onPress: () => { if (leaseTarget) void runRemoteOperation('push', { policy: leaseTarget }); } });
        }
        return extras;
    }, [branchBusy, effectiveScmSnapshot?.branch.headOid, effectiveScmSnapshot?.capabilities?.writeCommitUndoLast, effectiveScmSnapshot?.capabilities?.writeRemoteForceWithLease, leaseTarget, props.serverId, props.sessionId, router, runRemoteOperation, undoLastCommit]);
    const headerAction = React.useMemo(() => {
        if (!paneActions || !scmWriteEnabled) return null;
        return (
            <GitNextActionButton
                primary={paneActions.primary}
                menu={paneActions.menu}
                runningKey={runningKey}
                upstream={effectiveScmSnapshot?.branch.upstream ?? null}
                baseBranch={pullRequestModel.baseBranch}
                onRun={onRunHeaderAction}
                extras={menuExtras}
            />
        );
    }, [effectiveScmSnapshot?.branch.upstream, menuExtras, onRunHeaderAction, paneActions, pullRequestModel.baseBranch, runningKey, scmWriteEnabled]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine, action: headerAction }), [headerAction, headerLine]));

    const openFeatureSettings = React.useCallback(() => {
        router.push('/settings/features');
    }, [router]);
    const outcomeFacts = React.useMemo<GitOutcomeFacts>(() => ({
        ahead: effectiveScmSnapshot?.branch.ahead ?? 0,
        behind: effectiveScmSnapshot?.branch.behind ?? 0,
        selectedCount: selectedForCommitCount,
        changedCount: changedFileCount,
        upstream: effectiveScmSnapshot?.branch.upstream ?? null,
    }), [changedFileCount, effectiveScmSnapshot?.branch.ahead, effectiveScmSnapshot?.branch.behind, effectiveScmSnapshot?.branch.upstream, selectedForCommitCount]);
    const outcomeRecovery = React.useMemo(() => ({
        ...(terminal.available ? { openTerminal: () => { if (!terminal.active) terminal.onPress(); } } : {}),
        ...(scmWriteEnabled && effectiveScmSnapshot?.capabilities?.writeCommitUndoLast === true && !branchBusy ? { undoCommit: undoLastCommit } : {}),
        fetch: () => { void runRemoteOperation('fetch'); },
        retry: (action: string) => {
            if (action === 'push' || action === 'pull' || action === 'fetch') void runRemoteOperation(action);
        },
        refresh: () => { void refreshScmData(); },
        publish: () => { void publishBranch(); },
        ...(effectiveScmSnapshot?.capabilities?.writeRemotePolicies === true ? {
            pullThenPush: (policy: Readonly<{ reconcile: 'rebase' | 'merge' }>) => {
                void runRemoteOperation('pull', { policy, pushAfterPull: true, skipConfirmation: true });
            },
            pullWith: (policy: Readonly<{ dirtyPolicy?: 'autostash' | 'allow_git'; reconcile?: 'rebase' | 'merge' }>) => {
                // The person just chose it: no second confirmation for the same pull.
                void runRemoteOperation('pull', { policy, skipConfirmation: true });
            },
        } : {}),
        preferRebase: Boolean(effectiveScmSnapshot?.branch.head)
            && effectiveScmSnapshot?.branch.head !== (effectiveScmSnapshot?.repo.defaultBranch ?? null),
    }), [terminal, branchBusy, effectiveScmSnapshot?.branch.head, effectiveScmSnapshot?.capabilities?.writeCommitUndoLast, effectiveScmSnapshot?.capabilities?.writeRemotePolicies, effectiveScmSnapshot?.repo.defaultBranch, publishBranch, refreshScmData, runRemoteOperation, scmWriteEnabled, undoLastCommit]);
    const landedSha = (writeOperation?.phase === 'succeeded' || writeOperation?.phase === 'effect_applied_with_warning')
        && writeOperation.action === 'commit'
        ? writeOperation.result?.sha ?? null
        : null;

    const timeline = timelineVisible && isRepo ? (
        <GitTimelineSection
            changedCount={changedFileCount}
            selectedCount={selectedForCommitCount}
            ahead={effectiveScmSnapshot?.branch.ahead ?? 0}
            behind={effectiveScmSnapshot?.branch.behind ?? 0}
            upstream={effectiveScmSnapshot?.branch.upstream ?? null}
            entries={historyEntries}
            incoming={incomingCommits}
            loading={historyLoading}
            hasMore={historyHasMore}
            onLoadMore={loadMoreHistory}
            onOpenCommit={openCommitInDetails}
            landedSha={landedSha}
        />
    ) : null;

    if (!effectiveScmSnapshot && scmSnapshotError) {
        if (sessionPaused) {
            return (
                <SourceControlSessionInactiveState
                    machineReachable={machineReachable}
                    onOpenSession={resumeSession ?? requestSessionResume}
                />
            );
        }

        // `SourceControlUnavailableState` owns the typed body: it resolves user-facing copy from the
        // structured `errorCode` and only shows `details` as a sanitized supplementary line.
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
            <SurfaceStateCard testID="session-rightpanel-git-loading" kind="loading" title={t('common.loading')} />
        );
    }

    // `F-SCM-2`: from here on the content is real but possibly stale, so a refresh failure travels WITH it.
    // While the session is paused its machine cannot be asked, so the last-known rows stay at full strength
    // under ONE freshness line that says why, with Resume as the recovery.
    const staleSnapshotNotice = sessionPaused ? (
        <SurfaceFreshnessLine
            testID="session-rightpanel-git-paused"
            asOf={effectiveScmSnapshot.fetchedAt}
            reason={t('sessionGitPane.paused.reason')}
            action={{ label: t('sessionGitPane.paused.resume'), onPress: resumeSession ?? requestSessionResume }}
        />
    ) : (
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
                    folderName={workspaceFolderName}
                    // Never offered for a no-folder session's private folder (Git appears if the agent makes it a repository).
                    canInitializeRepository={scmWriteEnabled
                        && readSessionDirectoryKind(session?.metadata) !== 'managed'
                        && effectiveScmSnapshot.capabilities?.writeRepositoryInit === true}
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
    const hasConflicts = conflictPaths.length > 0;

    const globalLockMessage = isLockedByOtherSession
        ? t('files.sourceControlOperations.globalLock')
        : null;
    const commitAllowedForComposer = commitAllowed && !hasGlobalOperationInFlight && !isLockedByOtherSession;
    const commitBlockedMessageForComposer = globalLockMessage ?? (commitAllowed ? null : commitPreflight.message);

    const commitWriteEnabled =
        scmWriteEnabled
        && !sessionPaused
        && effectiveScmSnapshot?.capabilities?.writeCommit === true
        && !(commitPreflight.allowed === false && commitPreflight.reason === 'write_disabled');
    const commitSelectionUiEnabled = commitWriteEnabled;
    const operationState = effectiveScmSnapshot.operationState ?? null;

    const cleanState = (
        <GitCleanState
            branch={effectiveScmSnapshot.branch.head ?? null}
            upstream={effectiveScmSnapshot.branch.upstream ?? null}
            ahead={effectiveScmSnapshot.branch.ahead}
            behind={effectiveScmSnapshot.branch.behind}
            lastCommitAt={historyEntries[0]?.timestamp ?? null}
            lastCommit={historyEntries[0] ?? null}
            onOpenCommit={openCommitInDetails}
            lastPushedAt={lastPushedAt}
            justCompleted={writeOperation?.phase === 'succeeded' && writeOperation.action === 'push'}
            phone={phone}
            onCreatePullRequest={paneActions?.menu.some((action) => action.key === 'create-pr' && !action.disabled) ? () => onRunHeaderAction('create-pr') : null}
            onOpenPullRequest={openPullRequestUrl ? () => void openExternalUrl(openPullRequestUrl) : null}
            pullRequestNumber={openPullRequest?.number ?? null}
        />
    );

    const renderChanges: React.ComponentProps<typeof GitPaneLayout>['renderChanges'] = ({ active, listFooter }) => (
        <SessionRightPanelGitCommitTabContent
            theme={theme}
            sessionId={props.sessionId}
            serverId={props.serverId}
            sessionPath={sessionPath}
            scmSnapshot={effectiveScmSnapshot}
            workspaceTouchedPaths={workspaceTouchedPaths}
            commitSelectionPaths={commitSelectionPaths}
            commitSelectionPatches={commitSelectionPatches}
            scmCommitStrategy={scmCommitStrategy}
            scmWriteEnabled={scmWriteEnabled}
            inFlightScmOperation={inFlightScmOperation}
            hasGlobalOperationInFlight={hasGlobalOperationInFlight}
            scmOperationBusy={scmOperationBusy}
            // The outcome line owns progress and results; the card shows its own busy button only.
            scmOperationStatus={null}
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
            onOpenFilesSidebar={onOpenFilesSidebar}
            onOpenReviewAllChanges={onOpenReviewAllChanges}
            onOpenCommitPlan={openCommitPlan}
            onOpenWalkthrough={openWalkThrough}
            onOpenStashDetails={onOpenStashDetails}
            openFileInDetails={openFileInDetails}
            openFileInDetailsPinned={openFileInDetailsPinned}
            active={active}
            listFooter={listFooter}
            phone={phone}
            agentId={agentId}
            completedOperationId={writeOperation?.phase === 'succeeded' && (writeOperation.action === 'commit' || writeOperation.action === 'push' || writeOperation.action === 'pull') ? writeOperation.id : null}
            emptyState={cleanState}
            scopeAccessory={scopeAccessory}
            changesLayout={changesLayout}
            machineId={project?.key.machineId ?? ownerMetadata?.machineId ?? null}
        />
    );

    return (
        <View style={{ flex: 1 }}>
            {staleSnapshotNotice}
            {!scmWriteEnabled ? (
                // Git lab ST "Write actions off": the pane stays readable; one notice says why nothing can be
                // committed here and offers the switch instead of hiding the form silently.
                <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 }}>
                    <AttentionBanner
                        testID="session-git-writes-off"
                        tone="neutral"
                        title={t('sessionGitPane.flow.writesOff.title')}
                        description={t('sessionGitPane.flow.writesOff.body')}
                        action={{ label: t('sessionGitPane.flow.writesOff.turnOn'), onPress: openFeatureSettings }}
                    />
                </View>
            ) : null}
            <GitOutcomeLine
                operation={writeOperation}
                facts={outcomeFacts}
                machineName={machineName ?? null}
                machineReachable={machineReachable && machineRpcTargetAvailable}
                machineId={project?.key.machineId ?? ownerMetadata?.machineId ?? null}
                serverId={props.serverId}
                authenticationCommand={effectiveScmSnapshot?.hostingProvider?.kind === 'github' ? 'gh auth login' : null}
                recovery={outcomeRecovery}
                haptics={Platform.OS !== 'web'}
            />
            <GitConflictNotice
                sessionId={props.sessionId}
                serverId={props.serverId}
                operation={operationState}
                agentName={agentName}
                conflictPaths={conflictPaths}
                busy={hasGlobalOperationInFlight}
                onContinue={(operation) => void repositoryMutations.continueBranchOperation(operation)}
                onAbort={(operation) => void repositoryMutations.abortBranchOperation(operation)}
                onSkip={(operation) => void repositoryMutations.skipBranchOperation(operation)}
                canSkipOperation={scmWriteEnabled && effectiveScmSnapshot.capabilities?.writeBranchOperationSkip === true}
            />
            {scmWriteEnabled ? (
                <GitKeptAsideNotice
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    snapshot={effectiveScmSnapshot}
                    disabled={branchBusy}
                    onOpenStashDetails={onOpenStashDetails}
                />
            ) : null}
            <GitPullRequestSection
                sessionId={props.sessionId}
                serverId={props.serverId}
                scopeId={props.scopeId}
                snapshot={effectiveScmSnapshot}
                machineReachable={machineReachable}
            />
            <GitPaneLayout
                layout={paneLayout}
                activeSubTabId={activeGitSubTab}
                onSelectSubTab={setActiveGitSubTab}
                changedCount={changedFileCount}
                historyIdentity={commitHistoryInitKey}
                testIDPrefix="session-rightpanel-git"
                timeline={timeline}
                renderChanges={renderChanges}
            />
        </View>
    );
});

function providerDisplayName(kind: string): string {
    if (kind === 'github') return 'GitHub';
    if (kind === 'gitlab') return 'GitLab';
    if (kind === 'bitbucket') return 'Bitbucket';
    if (kind === 'azure-devops' || kind === 'azureDevOps') return 'Azure DevOps';
    return kind;
}
