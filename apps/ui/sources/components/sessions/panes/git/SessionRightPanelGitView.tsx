import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { Text } from '@/components/ui/text/Text';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionResumeAction } from '@/components/sessions/model/SessionResumeContext';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { usePublishBranchAction } from '@/hooks/session/sourceControl/usePublishBranchAction';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScmAdaptivePolling } from '@/scm/refresh/useScmAdaptivePolling';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import { resolveCommitAdjacentPushActionState } from '@/scm/operations/commitAdjacentPushAction';
import { confirmCommitAdjacentPush } from '@/scm/operations/commitAdjacentPushConfirmation';
import { formatRemoteTargetForDisplay } from '@/scm/operations/remoteFeedback';
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
    useSessionRealtimeScmTranscriptConsumer,
    useSetting,
    useSettingMutable,
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
import type { ScmCommitAdjacentPushAction } from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';
import type { Theme } from '@/theme';
import {
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

export type SessionRightPanelGitViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenFile?: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    onOpenCommit?: (sha: string) => void;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

function resolveGitThemeSignature(theme: Theme): string {
    const colors = theme.colors;
    const text = colors.text;
    const surface = colors.surface;
    const border = colors.border;
    const button = colors.button;
    const state = colors.state;
    const input = colors.input;
    return [
        border.default,
        surface.base,
        surface.inset,
        text.primary,
        text.secondary,
        input?.placeholder ?? '',
        button?.primary?.tint ?? '',
        state?.success?.foreground ?? '',
    ].join('\u0000');
}

function useStableGitTheme(theme: Theme): Theme {
    const signature = resolveGitThemeSignature(theme);
    const stableThemeRef = React.useRef({ signature, theme });
    if (stableThemeRef.current.signature !== signature) {
        stableThemeRef.current = { signature, theme };
    }
    return stableThemeRef.current.theme;
}

export const SessionRightPanelGitView = React.memo((props: SessionRightPanelGitViewProps) => {
    const { theme } = useUnistyles();
    const gitTheme = useStableGitTheme(theme);
    const pane = useAppPaneScope(props.scopeId);
    const resumeSession = useSessionResumeAction();
    const requestSessionResume = React.useCallback(() => {
        fireAndForget(emitSessionResumeRequest(props.sessionId), {
            tag: 'SessionRightPanelGitView.resumeSession',
        });
    }, [props.sessionId]);
    const { activeGitSubTab, commitDraftMessage, setCommitDraftMessage, setActiveGitSubTab } = useSessionRightPanelGitTabState(pane);
    const setActiveGitSubTabRef = React.useRef(setActiveGitSubTab);
    setActiveGitSubTabRef.current = setActiveGitSubTab;
    const selectGitSubTab = React.useCallback((subTabId: 'commit' | 'update' | 'history') => {
        setActiveGitSubTabRef.current(subTabId);
    }, []);
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
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    useSessionRealtimeScmTranscriptConsumer(props.sessionId, scmSnapshot);
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
    const [scmRemoteConfirmPolicy, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const autoRefreshIntervalSetting = useSetting('scmFilesAutoRefreshIntervalMs');
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
            || effectiveScmSnapshot?.capabilities?.writeRemotePublish === true
            || effectiveScmSnapshot?.capabilities?.writeRemoteAdd === true
            || effectiveScmSnapshot?.capabilities?.writeRemoteSetUrl === true
            || effectiveScmSnapshot?.capabilities?.writeRemoteRemove === true
            || effectiveScmSnapshot?.capabilities?.writeBranchMerge === true
            || effectiveScmSnapshot?.capabilities?.writeBranchRebase === true
            || effectiveScmSnapshot?.capabilities?.writeBranchOperationControl === true
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

    const createCommitFromMessageRef = React.useRef(createCommitFromMessage);
    createCommitFromMessageRef.current = createCommitFromMessage;
    const setCommitDraftMessageRef = React.useRef(setCommitDraftMessage);
    setCommitDraftMessageRef.current = setCommitDraftMessage;
    const onCommitDraftMessageChange = React.useCallback((value: string) => {
        setCommitDraftMessageRef.current(value);
    }, []);
    const onCommitFromMessage = React.useCallback((message: string) => {
        void (async () => {
            const result = await createCommitFromMessageRef.current(message);
            if (result.ok) {
                setCommitDraftMessageRef.current('');
            }
        })();
    }, []);

    const generateCommitMessageSuggestionRef = React.useRef(generateCommitMessageSuggestion);
    generateCommitMessageSuggestionRef.current = generateCommitMessageSuggestion;
    const onGenerateCommitMessageSuggestion = React.useCallback(async () => {
        return await generateCommitMessageSuggestionRef.current();
    }, []);

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
            && !(pushPreflight.allowed === false && pushPreflight.reason === 'write_disabled')
            && (
                caps.writeRemoteFetch === true
                || caps.writeRemotePull === true
                || caps.writeRemotePush === true
                || caps.writeRemotePublish === true
            );

        if (!remoteWriteEnabled) return actions;

        if (caps.writeRemoteFetch) {
            actions.push({
                key: 'fetch',
                iconName: 'arrows-clockwise',
                label: t('files.sourceControlOperations.actions.fetch'),
                testID: 'scm-update-remote-action-fetch',
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
                testID: 'scm-update-remote-action-pull',
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
                testID: 'scm-update-remote-action-push',
                disabled: busy || !pushPreflight.allowed,
                onPress: onPush,
            });
        }

        if (canPublish && (pullPreflightReason === 'upstream_required' || pushPreflightReason === 'upstream_required')) {
            actions.push({
                key: 'publish',
                iconName: 'upload',
                label: t('files.branchMenu.publish.title'),
                testID: 'scm-update-publish-branch',
                disabled: busy,
                onPress: () => {
                    void publishBranch();
                },
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
    const commitAdjacentPushAction = React.useMemo<ScmCommitAdjacentPushAction | undefined>(() => {
        if (!commitAdjacentPushState.visible) return undefined;
        const displayTarget = formatRemoteTargetForDisplay(
            commitAdjacentPushState.target,
            t('files.detachedHead'),
        );
        return {
            visible: true,
            disabled: commitAdjacentPushState.disabled,
            busy: commitAdjacentPushState.busy,
            accessibilityLabel: t('files.commitAdjacentPush.accessibilityLabel', { target: displayTarget }),
            onPress: onCommitAdjacentPush,
        };
    }, [commitAdjacentPushState, onCommitAdjacentPush]);

    if (!effectiveScmSnapshot && scmSnapshotError) {
        if (isSessionInactive && !machineRpcTargetAvailable) {
            return (
                <SourceControlSessionInactiveState
                    machineReachable={machineReachable}
                    onOpenSession={resumeSession ?? requestSessionResume}
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
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ marginTop: 12, fontSize: 12, color: theme.colors.text.secondary }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (!effectiveScmSnapshot.repo.isRepo) {
        return (
            <NotSourceControlRepositoryState
                sessionId={props.sessionId}
                canInitializeRepository={effectiveScmSnapshot.capabilities?.writeRepositoryInit === true}
                onInitialized={refreshScmData}
            />
        );
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
            theme={gitTheme}
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
            onCommitDraftMessageChange={onCommitDraftMessageChange}
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
        <SessionRightPanelGitUpdateTab
            theme={gitTheme}
            sessionId={props.sessionId}
            scmSnapshot={effectiveScmSnapshot}
            scmWriteEnabled={scmWriteEnabled}
            disabled={scmOperationBusy || hasGlobalOperationInFlight || isLockedByOtherSession}
            actions={remoteActions}
            hint={remoteHint}
            scmStatusFiles={scmStatusFilesSummary}
            showBranchSummary={displayActiveGitSubTab === 'update'}
        />
    );

    const historyTab = (
        <SessionRightPanelGitHistoryTab
            theme={gitTheme}
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
                onSelectSubTab={selectGitSubTab}
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
}, (previous, next) => {
    if (previous.testID !== next.testID || previous.isActive !== next.isActive) return false;
    if (!next.isActive) return true;
    return previous.children === next.children;
});
