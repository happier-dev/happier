import * as React from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionResumeAction } from '@/components/sessions/model/SessionResumeContext';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import {
    useProjectForSession,
    useProjectSessions,
    useSession,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmOperationLog,
    useSessionProjectScmSnapshot,
    useSessionProjectScmSnapshotError,
    useSessionProjectScmTouchedPaths,
    useSetting,
} from '@/sync/domains/state/storage';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { SessionRightPanelGitSubTabsBar } from './SessionRightPanelGitSubTabsBar';
import { SessionRightPanelGitCommitTabContent } from './SessionRightPanelGitCommitTabContent';
import { SessionRightPanelGitHistoryTab } from './SessionRightPanelGitHistoryTab';
import { SessionRightPanelGitUpdateTab } from './SessionRightPanelGitUpdateTab';
import { useSessionRightPanelGitTabState } from './useSessionRightPanelGitTabState';
import { useSessionRightPanelGitOpenDetails } from './useSessionRightPanelGitOpenDetails';
import type { SourceControlRemoteAction } from '@/components/sessions/sourceControl/remoteActions/SourceControlRemoteActionsRail';

export type SessionRightPanelGitViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
}>;

export const SessionRightPanelGitView = React.memo((props: SessionRightPanelGitViewProps) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const resumeSession = useSessionResumeAction();
    const { activeGitSubTab, commitDraftMessage, setCommitDraftMessage, setActiveGitSubTab } = useSessionRightPanelGitTabState(pane);
    const { openFileInDetails, openFileInDetailsPinned, openCommitInDetails } = useSessionRightPanelGitOpenDetails(pane);

    const session = useSession(props.sessionId);
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    const lastGoodScmSnapshot = useLastNonNullValue(scmSnapshot, { resetKey: props.sessionId });
    const effectiveScmSnapshot = scmSnapshot ?? lastGoodScmSnapshot;
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
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const project = useProjectForSession(props.sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);
    const hasGlobalOperationInFlight = Boolean(inFlightScmOperation);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.path ?? null,
    });
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId);
    const isSessionInactive = session?.active === false;

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

    const initialRefreshKey = `${props.sessionId}:${sessionPath ?? ''}`;
    const didInitialRefreshKeyRef = React.useRef<string | null>(null);
    const commitHistoryInitKey = `${props.sessionId}:${sessionPath ?? ''}`;
    const didInitCommitHistoryKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (didInitialRefreshKeyRef.current === initialRefreshKey) return;
        didInitialRefreshKeyRef.current = initialRefreshKey;
        void refreshScmData();

        if (!sessionPath) return;
        if (didInitCommitHistoryKeyRef.current === commitHistoryInitKey) return;
        didInitCommitHistoryKeyRef.current = commitHistoryInitKey;
        void loadCommitHistory({ reset: true });
    }, [commitHistoryInitKey, initialRefreshKey, loadCommitHistory, refreshScmData, sessionPath]);

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
        )
        && pullPreflightReason !== 'write_disabled'
        && pushPreflightReason !== 'write_disabled';

    const availableTabs: Array<{ id: 'commit' | 'update' | 'history'; label: string }> = [
        { id: 'commit', label: t('files.toolbar.changedFiles') },
        ...(remoteWriteEnabled ? [{ id: 'update', label: t('common.update') } as const] : []),
        { id: 'history', label: t('common.history') },
    ];
    const availableTabIdSet = new Set(availableTabs.map((tab) => tab.id));
    const displayActiveGitSubTab: 'commit' | 'update' | 'history' =
        availableTabIdSet.has(activeGitSubTab)
            ? activeGitSubTab
            : (availableTabs[0]?.id ?? 'commit');

    React.useEffect(() => {
        if (displayActiveGitSubTab === activeGitSubTab) return;
        setActiveGitSubTab(displayActiveGitSubTab);
    }, [activeGitSubTab, displayActiveGitSubTab, setActiveGitSubTab]);

    React.useEffect(() => {
        if (displayActiveGitSubTab !== 'history') return;
        if (!sessionPath) return;
        if (didInitCommitHistoryKeyRef.current === commitHistoryInitKey) return;
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

    const onOpenReviewAllChanges = React.useCallback(() => {
        pane.openDetailsTab(
            {
                key: 'scmReview:working',
                kind: 'scmReview',
                title: t('files.toolbar.review'),
                resource: { kind: 'scmReview', scope: 'working' },
            },
            { intent: 'pinned' },
        );
    }, [pane.openDetailsTab]);

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

    const remoteActions = React.useMemo(() => {
        const actions: SourceControlRemoteAction[] = [];
        if (!effectiveScmSnapshot?.repo.isRepo) return actions;
        const busy = scmOperationBusy || hasGlobalOperationInFlight || isLockedByOtherSession;
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
                iconName: 'sync',
                label: t('files.sourceControlOperations.actions.fetch'),
                disabled: busy,
                onPress: onFetch,
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
            });
        }

        return actions;
    }, [
        effectiveScmSnapshot,
        hasGlobalOperationInFlight,
        isLockedByOtherSession,
        onFetch,
        onPull,
        onPush,
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

    if (!effectiveScmSnapshot && scmSnapshotError) {
        if (isSessionInactive && !machineRpcTargetAvailable) {
            return (
                <SourceControlSessionInactiveState
                    machineReachable={machineReachable}
                    onOpenSession={resumeSession ?? (() => emitSessionResumeRequest(props.sessionId))}
                />
            );
        }

        const userFacingDetails =
            (
                typeof (scmSnapshotError as { errorCode?: unknown }).errorCode === 'string'
                    ? (scmSnapshotError as { errorCode: string }).errorCode
                    : undefined
            ) === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
                ? t('deps.installNotSupported')
                : scmSnapshotError.message;

        return <SourceControlUnavailableState details={userFacingDetails} onRetry={() => void refreshScmData()} />;
    }

    if (!effectiveScmSnapshot) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.textSecondary }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!effectiveScmSnapshot.repo.isRepo) {
        return <NotSourceControlRepositoryState />;
    }

    const scmUiPlugin = scmUiBackendRegistry.getPluginForSnapshot(effectiveScmSnapshot);
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
            onOpenFilesSidebar={onOpenFilesSidebar}
            onOpenReviewAllChanges={onOpenReviewAllChanges}
            openFileInDetails={openFileInDetails}
            openFileInDetailsPinned={openFileInDetailsPinned}
        />
    );

    const updateTab = (
        <SessionRightPanelGitUpdateTab
            theme={theme}
            actions={remoteActions}
            hint={remoteHint}
            scmStatusFiles={scmStatusFilesSummary}
        />
    );

    const historyTab = (
        <SessionRightPanelGitHistoryTab
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
            <SessionRightPanelGitSubTabsBar
                tabs={availableTabs}
                activeSubTabId={displayActiveGitSubTab}
                onSelectSubTab={setActiveGitSubTab}
            />
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
                { opacity: props.isActive ? 1 : 0, pointerEvents: props.isActive ? 'auto' : 'none' },
            ]}
            testID={props.testID}
            {...(a11yHiddenProps ?? {})}
        >
            {props.children}
        </View>
    );
});
