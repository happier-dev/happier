import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { storage, useSession, useIsDataReady, useLocalSetting, useSessionOrganizationProjection, useSetting } from '@/sync/domains/state/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { getAttachCommandForSession, getTmuxFallbackReason, getTmuxTargetForSession } from '@/utils/sessions/terminalSessionDetails';
import { CodeView } from '@/components/ui/media/CodeView';
import { Session } from '@/sync/domains/state/storageTypes';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationMissing,
} from '@/sync/domains/session/sessionRouteHydrationState';
import { HappyError } from '@/utils/errors/errors';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { useSessionSharingSupport } from '@/hooks/session/useSessionSharingSupport';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { Text } from '@/components/ui/text/Text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import {
    resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { getActionSpec } from '@happier-dev/protocol';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { useSessionRouteServerScope, type SessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import {
    useSessionHandoffSourceReachability,
    type SessionHandoffRuntimeAvailability,
} from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { completeSessionForkNavigation } from '@/components/sessions/transcript/forkContext/completeSessionForkNavigation';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNPIN_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { listVisibleSessionActionIds, resolveSessionReadStateActionId } from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionInfoItemProps } from '@/components/sessions/actions/sessionActionPresentation';
import { getTagsForSession, sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import { useSessionListMoveSheet } from '@/components/sessions/shell/move-sheet/useSessionListMoveSheet';
import type { SessionListMoveSheetTarget } from '@/components/sessions/shell/move-sheet/buildSessionListMoveSheetTargets';
import {
    buildSessionFolderWorkspaceRefKey,
    normalizeSessionFolderWorkspaceRef,
    normalizeSessionFolders,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    setSessionFolderAssignment as setSessionOrganizationFolderAssignment,
    setSessionPin as setSessionOrganizationPin,
    setSessionTagLabels as setSessionOrganizationTagLabels,
} from '@/sync/ops/sessionOrganization';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { Icon } from '@/components/ui/icons/Icon';
import {
    buildSessionDebugInformation,
    isSessionDebugInformationEnabled,
    resolveProviderSessionIdForDebug,
} from '@/components/sessions/debug/sessionDebugInformation';

type RawJsonSectionId = 'agentState' | 'metadata' | 'sessionStatus' | 'session';

const SESSION_INFO_IDLE_MOVE_RESULT = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' as const }),
    visual: Object.freeze({ kind: 'none' as const }),
});

function parseTagPromptValue(value: string | null): string[] | null {
    if (value == null) return null;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const rawTag of value.split(',')) {
        const tag = rawTag.trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}

function resolveSessionInfoWorkspaceRef(
    session: Session,
    serverId: string | null,
): SessionFolderWorkspaceRefV1 | null {
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object') return null;
    const record = metadata as Record<string, unknown>;
    const rootPath = typeof record.path === 'string' ? record.path : null;
    if (!rootPath) return null;
    return normalizeSessionFolderWorkspaceRef({
        t: 'workspaceScope',
        serverId,
        machineId: typeof record.machineId === 'string' ? record.machineId : null,
        rootPath,
    });
}

function resolveFolderDepth(
    folderId: string,
    parentIdByFolderId: ReadonlyMap<string, string | null>,
): number {
    let depth = 0;
    let current = parentIdByFolderId.get(folderId) ?? null;
    const seen = new Set([folderId]);
    while (current && !seen.has(current)) {
        seen.add(current);
        depth += 1;
        current = parentIdByFolderId.get(current) ?? null;
    }
    return depth;
}

function buildSessionInfoMoveTargets(params: Readonly<{
    sessionFolders: unknown;
    workspace: SessionFolderWorkspaceRefV1 | null;
}>): SessionListMoveSheetTarget[] {
    if (!params.workspace) return [];
    const workspaceKey = buildSessionFolderWorkspaceRefKey(params.workspace);
    const normalized = normalizeSessionFolders(params.sessionFolders);
    const parentIdByFolderId = new Map<string, string | null>();
    for (const folder of normalized.folders) {
        parentIdByFolderId.set(folder.id, folder.parentId ?? null);
    }
    const targets: SessionListMoveSheetTarget[] = [{
        id: 'session-info-move-folder:root',
        kind: 'root',
        label: t('sessionsList.moveToWorkspaceRoot'),
        disabled: false,
        result: SESSION_INFO_IDLE_MOVE_RESULT,
    }];
    for (const folder of normalized.folders) {
        if (buildSessionFolderWorkspaceRefKey(folder.workspace) !== workspaceKey) continue;
        targets.push({
            id: `session-info-move-folder:${folder.id}`,
            kind: 'folder',
            label: folder.name,
            disabled: false,
            result: SESSION_INFO_IDLE_MOVE_RESULT,
        });
    }
    return targets.sort((left, right) => {
        if (left.kind === 'root') return -1;
        if (right.kind === 'root') return 1;
        const leftDepth = resolveFolderDepth(left.id.replace('session-info-move-folder:', ''), parentIdByFolderId);
        const rightDepth = resolveFolderDepth(right.id.replace('session-info-move-folder:', ''), parentIdByFolderId);
        return leftDepth - rightDepth || left.label.localeCompare(right.label);
    });
}

function shallowEqualRecord(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }
    return true;
}

function areSessionInfoStaticFieldsEqual(previous: Session, next: Session): boolean {
    if (previous === next) return true;
    const {
        updatedAt: _previousUpdatedAt,
        seq: _previousSeq,
        lastViewedSessionSeq: _previousLastViewedSessionSeq,
        activeAt: _previousActiveAt,
        latestReadyEventSeq: _previousLatestReadyEventSeq,
        latestReadyEventAt: _previousLatestReadyEventAt,
        pendingVersion: _previousPendingVersion,
        metadataVersion: _previousMetadataVersion,
        agentStateVersion: _previousAgentStateVersion,
        thinkingAt: _previousThinkingAt,
        ...previousStaticFields
    } = previous;
    const {
        updatedAt: _nextUpdatedAt,
        seq: _nextSeq,
        lastViewedSessionSeq: _nextLastViewedSessionSeq,
        activeAt: _nextActiveAt,
        latestReadyEventSeq: _nextLatestReadyEventSeq,
        latestReadyEventAt: _nextLatestReadyEventAt,
        pendingVersion: _nextPendingVersion,
        metadataVersion: _nextMetadataVersion,
        agentStateVersion: _nextAgentStateVersion,
        thinkingAt: _nextThinkingAt,
        ...nextStaticFields
    } = next;
    return shallowEqualRecord(previousStaticFields, nextStaticFields);
}

function useStableSessionInfoContentSession(session: Session | null): Session | null {
    return React.useMemo(() => session, [
        session?.id,
        session?.serverId,
        session?.encryptionMode,
        session?.createdAt,
        session?.active,
        session?.archivedAt,
        session?.pendingCount,
        session?.pendingPermissionRequestCount,
        session?.pendingUserActionRequestCount,
        session?.pendingRequestObservedAt,
        session?.latestTurnStatus,
        session?.latestTurnStatusObservedAt,
        session?.lastRuntimeIssue,
        session?.metadata,
        session?.agentState,
        session?.thinking,
        session?.presence,
        session?.optimisticThinkingAt,
        session?.thinkingGraceUntil,
        session?.todos,
        session?.draft,
        session?.permissionMode,
        session?.permissionModeUpdatedAt,
        session?.modelMode,
        session?.modelModeUpdatedAt,
        session?.owner,
        session?.ownerProfile,
        session?.accessLevel,
        session?.canApprovePermissions,
    ]);
}

function areSessionInfoContentPropsEqual(
    previous: Readonly<{
        session: Session;
        sessionServerId: string | null;
        sourceMachineIdForHandoff: string | null;
        runtimeAvailability: SessionHandoffRuntimeAvailability;
        routeScope: SessionRouteServerScope;
    }>,
    next: Readonly<{
        session: Session;
        sessionServerId: string | null;
        sourceMachineIdForHandoff: string | null;
        runtimeAvailability: SessionHandoffRuntimeAvailability;
        routeScope: SessionRouteServerScope;
    }>,
): boolean {
    return previous.sessionServerId === next.sessionServerId
        && previous.sourceMachineIdForHandoff === next.sourceMachineIdForHandoff
        && previous.runtimeAvailability === next.runtimeAvailability
        && previous.routeScope === next.routeScope
        && areSessionInfoStaticFieldsEqual(previous.session, next.session);
}

function SessionInfoVolatileDetailItems({
    sessionId,
    formatDate,
}: Readonly<{
    sessionId: string;
    formatDate: (timestamp: number) => string;
}>) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    if (!session) return null;

    return (
        <>
            <Item
                title={t('sessionInfo.lastUpdated')}
                subtitle={formatDate(session.updatedAt)}
                icon={<Icon name="clock" size={29} color={theme.colors.accent.blue} />}
                showChevron={false}
            />
            <Item
                title={t('sessionInfo.sequence')}
                detail={session.seq.toString()}
                icon={<Icon name="git-commit" size={29} color={theme.colors.accent.blue} />}
                showChevron={false}
            />
        </>
    );
}

function SessionInfoReadStateActionItem({
    sessionId,
    scopedMutationServerId,
    isPinnedSession,
}: Readonly<{
    sessionId: string;
    scopedMutationServerId: string | null;
    isPinnedSession: boolean;
}>) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const target = React.useMemo(() => {
        if (!session) return null;
        return createSessionActionTarget({
            session,
            serverId: scopedMutationServerId,
            currentUserId: !session.accessLevel && typeof session.owner === 'string' ? session.owner : null,
            isConnected: session.active === true,
            isPinned: isPinnedSession,
        });
    }, [isPinnedSession, scopedMutationServerId, session]);
    const readStateActionId = target ? resolveSessionReadStateActionId(target) : null;
    const readStateInfoItem = React.useMemo(() => {
        if (!readStateActionId) return null;
        return createSessionActionInfoItemProps({
            actionId: readStateActionId,
            iconColor: theme.colors.accent.blue,
        });
    }, [readStateActionId, theme.colors.accent.blue]);
    const handleReadStateAction = useCallback(async () => {
        if (!target || !readStateActionId) return;
        await executeSessionAction({
            actionId: readStateActionId,
            target,
        });
    }, [readStateActionId, target]);
    const [updatingReadState, performReadStateAction] = useHappyAction(handleReadStateAction);

    if (!readStateInfoItem) return null;
    return (
        <Item
            {...readStateInfoItem}
            onPress={performReadStateAction}
            loading={updatingReadState}
        />
    );
}

function SessionInfoActivityGroup({
    sessionId,
    formatDate,
    sessionStatus,
    showRawDiagnostics,
}: Readonly<{
    sessionId: string;
    formatDate: (timestamp: number) => string;
    sessionStatus: SessionStatus;
    showRawDiagnostics: boolean;
}>) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    if (!session) return null;

    return (
        <ItemGroup title={t('sessionInfo.activity')}>
            <Item
                title={t('sessionInfo.sessionStatus')}
                detail={sessionStatus.statusText}
                icon={<Icon name="pulse" size={29} color={sessionStatus.statusColor} />}
                showChevron={false}
            />
            {showRawDiagnostics ? (
                <>
                    <Item
                        title={t('sessionInfo.thinking')}
                        detail={session.thinking ? t('common.yes') : t('common.no')}
                        icon={<Icon name="lightbulb" size={29} color={session.thinking ? theme.colors.accent.yellow : theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                    {session.thinking && (
                        <Item
                            title={t('sessionInfo.thinkingSince')}
                            subtitle={formatDate(session.thinkingAt)}
                            icon={<Icon name="timer" size={29} color={theme.colors.accent.yellow} />}
                            showChevron={false}
                        />
                    )}
                </>
            ) : null}
        </ItemGroup>
    );
}

function SessionInfoExecutionRunsAction({
    sessionId,
    routeScope,
    router,
}: Readonly<{
    sessionId: string;
    routeScope: SessionRouteServerScope;
    router: ReturnType<typeof useRouter>;
}>) {
    const { theme } = useUnistyles();
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(sessionId);
    if (!sessionExecutionRunsSupported) return null;

    return (
        <Item
            title={t('runs.title')}
            subtitle={t('sessionInfo.executionRunsSubtitle')}
            icon={<Icon name="play" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push(routeScope.buildHref(sessionId, { suffix: '/runs' }))}
        />
    );
}

function SessionInfoContent({ session, sessionServerId, sourceMachineIdForHandoff, runtimeAvailability, routeScope }: Readonly<{
    session: Session;
    sessionServerId: string | null;
    sourceMachineIdForHandoff: string | null;
    runtimeAvailability: SessionHandoffRuntimeAvailability;
    routeScope: SessionRouteServerScope;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    const devModeEnabled = isSessionDebugInformationEnabled(localDevModeEnabled);
    const sessionName = getSessionName(session);
    const sessionStatus = useSessionStatus(session, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const sessionFoldersEnabled = useFeatureEnabled('sessions.folders');
    const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, { enabled: Boolean(sessionServerId) });
    const useProfiles = useSetting('useProfiles') === true;
    const profilesSetting = useSetting('profiles');
    const profiles = Array.isArray(profilesSetting) ? profilesSetting : [];
    const actionsSettingsV1 = useSetting('actionsSettingsV1');
    const sessionReplayEnabled = useSetting('sessionReplayEnabled') === true;
    // The four fields the fork request's Replay options are derived from, read
    // narrowly so this screen does not subscribe to the whole settings object.
    const sessionReplayMaxSeedChars = useSetting('sessionReplayMaxSeedChars');
    const sessionReplayStrategy = useSetting('sessionReplayStrategy');
    const sessionReplaySummaryRunnerV1 = useSetting('sessionReplaySummaryRunnerV1');
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const { openMoveSheet } = useSessionListMoveSheet();
    const sharingSupported = useSessionSharingSupport();
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const [expandedRawJsonSection, setExpandedRawJsonSection] = React.useState<RawJsonSectionId | null>(null);
    // Check if CLI version is outdated
    const isCliOutdated = session.metadata?.version && !isVersionSupported(session.metadata.version, MINIMUM_CLI_VERSION);
    const canManageSharing = !session.accessLevel || session.accessLevel === 'admin';
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(session.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            openSession: (childSessionId) => completeSessionForkNavigation({
                childSessionId,
                parentSessionId: session.id,
                navigate: (targetSessionId) => router.push(routeScope.buildHref(targetSessionId) as any),
            }),
        }),
        [routeScope, router, session.id],
    );

    const forkActionEnabled = React.useMemo(() => {
        return isActionEnabledInState(
            storage.getState() as any,
            'session.fork' as any,
            { surface: 'ui_button', placement: 'session_info' } as any,
        );
    }, [actionsSettingsV1]);

    const forkSupported = React.useMemo(() => {
        return canForkConversation({ session, replayEnabled: sessionReplayEnabled }) === true;
    }, [session, sessionReplayEnabled]);
    const handoffActionSpec = React.useMemo(() => getActionSpec('session.handoff'), []);
    const handoffActionEnabled = React.useMemo(() => {
        return isActionEnabledInState(
            storage.getState() as any,
            'session.handoff' as any,
            { surface: 'ui_button', placement: 'session_info' } as any,
        );
    }, [actionsSettingsV1]);
    const handoffAvailability = resolveSessionHandoffUiAvailability({
        sessionId: session.id,
        session,
        sessionHandoffFeatureEnabled: sessionHandoffEnabled,
        serverSnapshot,
        runtimeAvailability,
    });
    const handoffSupported = handoffAvailability.available;

    const vendorResumeLabelKey = core.resume.uiVendorResumeIdLabelKey;
    const vendorResumeCopiedKey = core.resume.uiVendorResumeIdCopiedKey;
    const vendorResumeId = React.useMemo(() => {
        return getAgentVendorResumeId(session.metadata, agentId);
    }, [agentId, session.metadata]);
    const providerDisplayName = React.useMemo(() => t(core.displayNameKey), [core.displayNameKey]);
    const providerSessionIdForDebug = React.useMemo(() => {
        return resolveProviderSessionIdForDebug({
            metadata: session.metadata,
            vendorResumeIdField: core.resume.vendorResumeIdField,
        });
    }, [core.resume.vendorResumeIdField, session.metadata]);
    const sessionDebugInformation = React.useMemo(() => buildSessionDebugInformation({
        session,
        providerDisplayName,
        providerSessionId: providerSessionIdForDebug,
    }), [providerDisplayName, providerSessionIdForDebug, session]);
    const providerSessionArtifactPath = sessionDebugInformation.providerSessionArtifactPath;

    const profileLabel = React.useMemo(() => {
        const profileId = session.metadata?.profileId;
        if (profileId === null || profileId === '') return t('profiles.noProfile');
        if (typeof profileId !== 'string') return t('status.unknown');
        const resolved = resolveProfileById(profileId, profiles);
        if (resolved) {
            return getProfileDisplayName(resolved);
        }
        return t('status.unknown');
    }, [profiles, session.metadata?.profileId]);

    const attachCommand = React.useMemo(() => {
        return getAttachCommandForSession({ sessionId: session.id, terminal: session.metadata?.terminal });
    }, [session.id, session.metadata?.terminal]);

    const tmuxTarget = React.useMemo(() => {
        return getTmuxTargetForSession(session.metadata?.terminal);
    }, [session.metadata?.terminal]);

    const tmuxFallbackReason = React.useMemo(() => {
        return getTmuxFallbackReason(session.metadata?.terminal);
    }, [session.metadata?.terminal]);
    const rawSessionStatus = React.useMemo(() => ({
        isConnected: sessionStatus.isConnected,
        statusText: sessionStatus.statusText,
        statusColor: sessionStatus.statusColor,
        statusDotColor: sessionStatus.statusDotColor,
        isPulsing: sessionStatus.isPulsing,
    }), [sessionStatus.isConnected, sessionStatus.isPulsing, sessionStatus.statusColor, sessionStatus.statusDotColor, sessionStatus.statusText]);
    const toggleRawJsonSection = React.useCallback((section: RawJsonSectionId) => {
        setExpandedRawJsonSection((current) => (current === section ? null : section));
    }, []);
    const handleToggleAgentStateJson = React.useCallback(() => toggleRawJsonSection('agentState'), [toggleRawJsonSection]);
    const handleToggleMetadataJson = React.useCallback(() => toggleRawJsonSection('metadata'), [toggleRawJsonSection]);
    const handleToggleSessionStatusJson = React.useCallback(() => toggleRawJsonSection('sessionStatus'), [toggleRawJsonSection]);
    const handleToggleSessionJson = React.useCallback(() => toggleRawJsonSection('session'), [toggleRawJsonSection]);
    const expandedRawJsonCode = React.useMemo(() => {
        switch (expandedRawJsonSection) {
            case 'agentState':
                return session.agentState ? JSON.stringify(session.agentState, null, 2) : null;
            case 'metadata':
                return session.metadata ? JSON.stringify(session.metadata, null, 2) : null;
            case 'sessionStatus':
                return JSON.stringify(rawSessionStatus, null, 2);
            case 'session':
                return JSON.stringify(session, null, 2);
            default:
                return null;
        }
    }, [expandedRawJsonSection, rawSessionStatus, session]);
    const reachableMachineTarget = useSessionMachineTarget(session.id);
    const displayMachineTarget = React.useMemo(() => {
        return readDisplayMachineTargetForSession({
            sessionId: session.id,
            metadata: session.metadata,
        });
    }, [session.id, session.updatedAt, session.metadata]);
    const reachableMachineId = reachableMachineTarget?.machineId ?? null;
    const newSessionSeedTarget = reachableMachineTarget
        && (!displayMachineTarget || reachableMachineTarget.machineId === displayMachineTarget.machineId)
        ? reachableMachineTarget
        : displayMachineTarget;
    const newSessionSeedMachineId = newSessionSeedTarget?.machineId
        ?? (typeof session.metadata?.machineId === 'string' ? session.metadata.machineId : null);
    const newSessionSeedDirectory = newSessionSeedTarget?.basePath
        ?? (typeof session.metadata?.path === 'string' ? session.metadata.path : null);
    const displayMachineId = displayMachineTarget?.machineId ?? null;
    const sessionLogPath = React.useMemo(() => {
        const value = typeof (session.metadata as any)?.sessionLogPath === 'string'
            ? (session.metadata as any).sessionLogPath.trim()
            : '';
        return value.length > 0 ? value : null;
    }, [session.metadata]);

    const handleExitAfterSessionMutation = useCallback(() => {
        safeRouterBack({
            router,
            fallbackHref: routeScope.buildHref(session.id),
        });
        safeRouterBack({
            router,
            fallbackHref: '/',
        });
    }, [routeScope, router, session.id]);

    const isArchivedSession = session.archivedAt != null;
    const resolvedServerId = resolveServerIdForSessionIdFromLocalCache(session.id);
    const scopedMutationServerId = resolvedServerId ?? sessionServerId ?? routeScope.serverId ?? null;
    const organizationProjection = useSessionOrganizationProjection(scopedMutationServerId);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: scopedMutationServerId ?? '',
        projection: organizationProjection,
    }), [organizationProjection, scopedMutationServerId]);
    const sessionSettingsKey = typeof scopedMutationServerId === 'string' && scopedMutationServerId.trim()
        ? sessionTagKey(scopedMutationServerId, session.id)
        : null;
    const isPinnedSession = Boolean(
        sessionSettingsKey &&
        organizationListViewState.pinnedSessionKeysV1.includes(sessionSettingsKey),
    );
    const sessionActionTarget = React.useMemo(
        () => createSessionActionTarget({
            session,
            serverId: scopedMutationServerId,
            currentUserId: !session.accessLevel && typeof session.owner === 'string' ? session.owner : null,
            isConnected: sessionStatus.isConnected,
            isPinned: isPinnedSession,
        }),
        [isPinnedSession, scopedMutationServerId, session, sessionStatus.isConnected],
    );
    const canArchiveSession = sessionActionTarget.canArchive;
    const canDeleteSession = sessionActionTarget.canDelete;
    const visibleSessionActionIds = React.useMemo(
        () => new Set(listVisibleSessionActionIds({ target: sessionActionTarget, surface: 'sessionInfo' })),
        [sessionActionTarget],
    );
    const canRenameSession = visibleSessionActionIds.has(SESSION_ACTION_RENAME_ID);
    const sessionInfoTags = sessionSettingsKey
        ? getTagsForSession(organizationListViewState.sessionTagsV1 as Record<string, string[]> | null | undefined, sessionSettingsKey)
        : [];
    const pinInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: isPinnedSession ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
        iconColor: theme.colors.accent.blue,
    }), [isPinnedSession, theme.colors.accent.blue]);
    const tagsInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_EDIT_TAGS_ID,
        iconColor: theme.colors.accent.blue,
    }), [theme.colors.accent.blue]);
    const moveToFolderInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
        iconColor: theme.colors.accent.blue,
    }), [theme.colors.accent.blue]);
    const stopInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_STOP_ID,
        iconColor: theme.colors.state.danger.foreground,
    }), [theme.colors.state.danger.foreground]);
    const archiveInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_ARCHIVE_ID,
        iconColor: theme.colors.state.danger.foreground,
    }), [theme.colors.state.danger.foreground]);
    const deleteInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_DELETE_ID,
        iconColor: theme.colors.state.danger.foreground,
    }), [theme.colors.state.danger.foreground]);
    const moveTargets = React.useMemo(() => buildSessionInfoMoveTargets({
        sessionFolders: organizationListViewState.sessionFoldersV1,
        workspace: resolveSessionInfoWorkspaceRef(session, scopedMutationServerId),
    }), [organizationListViewState.sessionFoldersV1, scopedMutationServerId, session]);

    const getOrganizationMutationContext = useCallback(async () => {
        const serverId = typeof scopedMutationServerId === 'string' ? scopedMutationServerId.trim() : '';
        if (!serverId) {
            throw new HappyError(t('errors.unknownError'), false);
        }
        const serverProfile = getServerProfileById(serverId);
        if (!serverProfile) {
            throw new HappyError(t('errors.unknownError'), false);
        }
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) {
            throw new HappyError(t('errors.unknownError'), false);
        }
        return { credentials, serverId: serverProfile.id, serverUrl: serverProfile.serverUrl };
    }, [scopedMutationServerId]);

    const handleTogglePinned = useCallback(async () => {
        if (!sessionSettingsKey) return;
        await executeSessionAction({
            actionId: isPinnedSession ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
            target: sessionActionTarget,
            context: {
                operations: {
                    setPinned: async (_sessionId, pinned) => {
                        const mutation = await getOrganizationMutationContext();
                        await setSessionOrganizationPin({
                            ...mutation,
                            sessionId: session.id,
                            pinned,
                        });
                    },
                },
            },
        });
    }, [getOrganizationMutationContext, isPinnedSession, session.id, sessionActionTarget, sessionSettingsKey]);
    const [pinningSession, performTogglePinned] = useHappyAction(handleTogglePinned);

    const handleEditTags = useCallback(async () => {
        if (!sessionSettingsKey) return;
        const rawTags = await Modal.prompt(
            t('sessionsList.selectionSetTagsPromptTitle'),
            t('sessionsList.selectionTagsPromptMessage'),
            {
                defaultValue: sessionInfoTags.join(', '),
                placeholder: t('sessionsList.selectionTagsPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        const nextTags = parseTagPromptValue(rawTags);
        if (nextTags == null) return;
        await executeSessionAction({
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            target: sessionActionTarget,
            input: { tags: nextTags },
            context: {
                operations: {
                    setTags: async (_sessionId, tags) => {
                        const mutation = await getOrganizationMutationContext();
                        await setSessionOrganizationTagLabels({
                            ...mutation,
                            sessionId: session.id,
                            tags: [...tags],
                        });
                    },
                },
            },
        });
    }, [getOrganizationMutationContext, session.id, sessionActionTarget, sessionInfoTags, sessionSettingsKey]);
    const [editingTags, performEditTags] = useHappyAction(handleEditTags);

    const handleMoveToFolder = useCallback(async () => {
        if (!sessionFoldersEnabled || moveTargets.length === 0) return;
        const selectedTarget = await openMoveSheet({
            sourceLabel: sessionName,
            targets: moveTargets,
        });
        if (!selectedTarget) return;
        const folderId = selectedTarget.kind === 'root'
            ? null
            : selectedTarget.id.replace('session-info-move-folder:', '');
        await executeSessionAction({
            actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            target: sessionActionTarget,
            input: { folderId },
            context: {
                operations: {
                    moveToFolder: async (_target, input) => {
                        const mutation = await getOrganizationMutationContext();
                        await setSessionOrganizationFolderAssignment({
                            ...mutation,
                            sessionId: session.id,
                            folderId: input?.folderId ?? null,
                        });
                    },
                },
            },
        });
    }, [getOrganizationMutationContext, moveTargets, openMoveSheet, session.id, sessionActionTarget, sessionFoldersEnabled, sessionName]);
    const [movingToFolder, performMoveToFolder] = useHappyAction(handleMoveToFolder);

    const handleStopAndMaybeArchive = useCallback(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: sessionActionTarget,
            context: {
                hideInactiveSessions,
            },
        });
        handleExitAfterSessionMutation();
    }, [handleExitAfterSessionMutation, hideInactiveSessions, sessionActionTarget]);
    const [stoppingSession, performStop] = useHappyAction(handleStopAndMaybeArchive);

    const handleStopSession = useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('sessionInfo.stopSession'),
            t('sessionInfo.stopSessionConfirm'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('sessionInfo.stopSession'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        await performStop();
    }, [performStop]);

    const handleArchive = useCallback(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: sessionActionTarget,
            context: {
                hideInactiveSessions,
            },
        });
        handleExitAfterSessionMutation();
    }, [handleExitAfterSessionMutation, hideInactiveSessions, sessionActionTarget]);
    const [archivingSession, performArchive] = useHappyAction(handleArchive);

    // A launcher only, exactly like the Session header: strategy is chosen
    // before any fork effect is issued, from every UI entry point.
    const performFork = useCallback(() => {
        openSessionForkStrategyFlow({
            sessionId: session.id,
            forkSupportSource: session,
            serverId: sessionServerId ?? null,
            machineId: reachableMachineId ?? (typeof session.metadata?.machineId === 'string'
                ? session.metadata.machineId
                : null),
            forkPoint: { type: 'latest' },
            settings: {
                sessionReplayEnabled,
                sessionReplayMaxSeedChars,
                sessionReplayStrategy,
                sessionReplaySummaryRunnerV1,
            },
            replayEnabled: sessionReplayEnabled,
            executionRunsEnabled: executionRunsEnabled === true,
            navigateToSession: (childSessionId) => {
                router.push(routeScope.buildHref(childSessionId) as any);
            },
            navigateToNewSession: (route) => {
                router.push(route as any);
            },
        });
    }, [
        executionRunsEnabled,
        reachableMachineId,
        routeScope,
        router,
        session,
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1,
        sessionServerId,
    ]);

    const handleNewSessionSameSetup = useCallback(() => {
        const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
            session,
            machineId: newSessionSeedMachineId,
            directoryOverride: newSessionSeedDirectory,
        }));
        router.push({
            pathname: '/new',
            params: {
                dataId,
                ...(newSessionSeedMachineId ? { machineId: newSessionSeedMachineId } : {}),
                ...(newSessionSeedDirectory ? { directory: newSessionSeedDirectory } : {}),
                ...(sessionServerId ? { spawnServerId: sessionServerId } : {}),
            },
        } as any);
    }, [newSessionSeedDirectory, newSessionSeedMachineId, router, session, sessionServerId]);

    const handleHandoffAction = useCallback(async () => {
        const res = await runSessionHandoffPickerFlow({
            execute: executor.execute as any,
            sessionId: session.id,
            sourceMachineId: sourceMachineIdForHandoff,
            serverId: sessionServerId,
            placement: 'session_info',
        });
        if (!res?.ok) return;
    }, [executor.execute, session.id, sessionServerId, sourceMachineIdForHandoff]);

    const [handingOffSession, performHandoff] = useHappyAction(handleHandoffAction);

    const handleArchiveSession = useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('sessionInfo.archiveSession'),
            t('sessionInfo.archiveSessionConfirm'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('sessionInfo.archiveSession'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        await performArchive();
    }, [performArchive]);

    // Use HappyAction for deletion - it handles errors automatically
    const [deletingSession, performDelete] = useHappyAction(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_DELETE_ID,
            target: sessionActionTarget,
        });
        handleExitAfterSessionMutation();
    });

    const handleDeleteSession = useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
    }, [performDelete]);

    const handleRenameSession = useCallback(async () => {
        if (!canRenameSession) return;
        const newName = await Modal.prompt(
            t('sessionInfo.renameSession'),
            t('sessionInfo.renameSessionSubtitle'),
            {
                defaultValue: sessionName,
                placeholder: t('sessionInfo.renameSessionPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel')
            }
        );

        if (!newName?.trim()) return;
        try {
            await executeSessionAction({
                actionId: SESSION_ACTION_RENAME_ID,
                target: sessionActionTarget,
                input: { title: newName },
            });
        } catch (error) {
            if (error instanceof HappyError) {
                Modal.alert(t('common.error'), error.message);
            } else {
                Modal.alert(t('common.error'), t('errors.unknownError'));
            }
        }
    }, [canRenameSession, sessionActionTarget, sessionName]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    return (
        <>
            <ItemList>
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface.base, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={agentId} />
                        <Text style={{
                            fontSize: 20,
                            fontWeight: '600',
                            marginTop: 12,
                            textAlign: 'center',
                            color: theme.colors.text.primary,
                            ...Typography.default('semiBold')
                        }}>
                            {sessionName}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <StatusDot
                                color={sessionStatus.statusDotColor}
                                isPulsing={sessionStatus.isPulsing}
                                size={10}
                                style={{ marginRight: 4 }}
                            />
                            <Text style={{
                                fontSize: 15,
                                color: sessionStatus.statusColor,
                                fontWeight: '500',
                                ...Typography.default()
                            }}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* CLI Version Warning */}
                {isCliOutdated && (
                    <ItemGroup>
                        <Item
                            title={t('sessionInfo.cliVersionOutdated')}
                            subtitle={t('sessionInfo.updateCliInstructions')}
                            icon={<Icon name="warning" size={29} color={theme.colors.accent.orange} />}
                            showChevron={false}
                            copy="happier self update"
                        />
                    </ItemGroup>
                )}

                <SessionRetentionNotice sessionId={session.id} />

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title={t('sessionInfo.happySessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Icon name="fingerprint" size={29} color={theme.colors.accent.blue} />}
                        copy={session.id}
                    />
                    {vendorResumeId && vendorResumeLabelKey && vendorResumeCopiedKey && (
                        <Item
                            title={t(vendorResumeLabelKey)}
                            subtitle={`${vendorResumeId.substring(0, 8)}...${vendorResumeId.substring(vendorResumeId.length - 8)}`}
                            icon={<AgentIcon agentId={agentId} size={29} color={theme.colors.accent.blue} />}
                            copy={vendorResumeId}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        icon={<Icon name="pulse" size={29} color={sessionStatus.isConnected ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        icon={<Icon name="calendar" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                    <SessionInfoVolatileDetailItems sessionId={session.id} formatDate={formatDate} />
                </ItemGroup>

                {/* Quick Actions */}
                <ItemGroup title={t('sessionInfo.quickActions')}>
                    {canRenameSession && (
                        <Item
                            title={t('sessionInfo.renameSession')}
                            subtitle={t('sessionInfo.renameSessionSubtitle')}
                            icon={<Icon name="pencil" size={29} color={theme.colors.accent.blue} />}
                            onPress={handleRenameSession}
                        />
                    )}
                    {!session.accessLevel && forkActionEnabled && forkSupported && (
                        <Item
                            testID="session-info-fork-session"
                            title={t('sessionInfo.forkSession')}
                            subtitle={t('sessionInfo.forkSessionSubtitle')}
                            icon={<Icon name="git-branch" size={29} color={theme.colors.accent.blue} />}
                            onPress={performFork}
                        />
                    )}
                    <Item
                        testID="session-info-new-session-same-setup"
                        title={t('sessionInfo.newSessionSameSetup')}
                        subtitle={t('sessionInfo.newSessionSameSetupSubtitle')}
                        icon={<Icon name="copy" size={29} color={theme.colors.accent.blue} />}
                        onPress={handleNewSessionSameSetup}
                    />
                    {devModeEnabled ? (
                        <Item
                            testID="session-info-copy-debug-information"
                            title={t('sessionInfo.copyDebugInformation')}
                            icon={<Icon name="copy" size={29} color={theme.colors.accent.blue} />}
                            copy={sessionDebugInformation.text}
                        />
                    ) : null}
                    {!session.accessLevel && handoffActionEnabled && handoffSupported && (
                        <Item
                            title={handoffActionSpec.title}
                            subtitle={handoffActionSpec.description}
                            icon={<Icon name="arrows-left-right" size={24} color={theme.colors.accent.blue} />}
                            onPress={performHandoff}
                            loading={handingOffSession}
                        />
                    )}
                    <SessionInfoReadStateActionItem
                        sessionId={session.id}
                        scopedMutationServerId={scopedMutationServerId}
                        isPinnedSession={isPinnedSession}
                    />
                    {!isArchivedSession && sessionSettingsKey && pinInfoItemProps ? (
                        <Item
                            {...pinInfoItemProps}
                            onPress={performTogglePinned}
                            loading={pinningSession}
                        />
                    ) : null}
                    {sessionSettingsKey && tagsInfoItemProps ? (
                        <Item
                            {...tagsInfoItemProps}
                            detail={sessionInfoTags.length > 0 ? sessionInfoTags.join(', ') : undefined}
                            onPress={performEditTags}
                            loading={editingTags}
                        />
                    ) : null}
                    {sessionFoldersEnabled && moveTargets.length > 0 && moveToFolderInfoItemProps ? (
                        <Item
                            {...moveToFolderInfoItemProps}
                            onPress={performMoveToFolder}
                            loading={movingToFolder}
                        />
                    ) : null}
                    {executionRunsEnabled ? (
                        <SessionInfoExecutionRunsAction
                            sessionId={session.id}
                            routeScope={routeScope}
                            router={router}
                        />
                    ) : null}
                    {showAutomations ? (
                        <Item
                            title={t('sessionInfo.automationsTitle')}
                            subtitle={t('sessionInfo.automationsSubtitle')}
                            icon={<Icon name="timer" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/automations' }))}
                        />
                    ) : null}
                    {!session.active && Boolean(vendorResumeId) && (
                        <Item
                            title={t('sessionInfo.copyResumeCommand')}
                            subtitle={t('sessionInfo.resumeCommand', { sessionId: session.id })}
                            icon={<Icon name="terminal" size={29} color={theme.colors.accent.purple} />}
                            showChevron={false}
                            copy={t('sessionInfo.resumeCommand', { sessionId: session.id })}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.viewSessionLogTitle')}
                        subtitle={t('sessionInfo.viewSessionLogSubtitle')}
                        icon={<Icon name="file-text" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/log' }))}
                    />
                    {displayMachineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            subtitleAccessory={
                                <Text
                                    testID="sessionInfo.viewMachineTargetMachineId"
                                    style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
                                >
                                    {displayMachineId}
                                </Text>
                            }
                            icon={<Icon name="hard-drives" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(`/machine/${displayMachineId}`)}
                        />
                    )}
                    {canManageSharing && sharingSupported && (
                        <Item
                            title={t('sessionInfo.manageSharing')}
                            subtitle={t('sessionInfo.manageSharingSubtitle')}
                            icon={<Icon name="share" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/sharing' }))}
                        />
                    )}
                    {visibleSessionActionIds.has(SESSION_ACTION_STOP_ID) && stopInfoItemProps && (
                        <Item
                            {...stopInfoItemProps}
                            onPress={handleStopSession}
                            loading={stoppingSession}
                        />
                    )}
                    {canArchiveSession && archiveInfoItemProps && (
                        <Item
                            {...archiveInfoItemProps}
                            onPress={handleArchiveSession}
                            loading={archivingSession}
                        />
                    )}
                    {canDeleteSession && deleteInfoItemProps && (
                        <Item
                            {...deleteInfoItemProps}
                            onPress={handleDeleteSession}
                        />
                    )}
                </ItemGroup>

                {/* Metadata */}
                {session.metadata && (
                    <ItemGroup title={t('sessionInfo.metadata')}>
                        <Item
                            title={t('sessionInfo.host')}
                            subtitle={session.metadata.host}
                            icon={<Icon name="desktop" size={29} color={theme.colors.accent.indigo} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('sessionInfo.path')}
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Icon name="folder" size={29} color={theme.colors.accent.indigo} />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={session.metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                icon={<Icon name="git-branch" size={29} color={isCliOutdated ? theme.colors.accent.orange : theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Icon name="cpu" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                            <Item
                                title={t('sessionInfo.aiProvider')}
                                subtitle={(() => {
                                    if (agentId) return t(getAgentCore(agentId).displayNameKey);
                                    const flavor = session.metadata.flavor;
                                    return typeof flavor === 'string' && flavor.length > 0
                                        ? flavor
                                        : t(getAgentCore(DEFAULT_AGENT_ID).displayNameKey);
                                })()}
                                icon={<Icon name="sparkle" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                            {useProfiles && session.metadata?.profileId !== undefined && (
                                <Item
                                    title={t('sessionInfo.aiProfile')}
                                    detail={profileLabel}
                                    icon={<Icon name="user-circle" size={29} color={theme.colors.accent.indigo} />}
                                    showChevron={false}
                                />
                            )}
                            {session.metadata.hostPid && (
                                <Item
                                    title={t('sessionInfo.processId')}
                                    subtitle={session.metadata.hostPid.toString()}
                                icon={<Icon name="terminal" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.happyHomeDir && (
                            <Item
                                title={t('sessionInfo.happyHome')}
                                subtitle={formatPathRelativeToHome(session.metadata.happyHomeDir, session.metadata.homeDir)}
                                icon={<Icon name="house" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {sessionLogPath && (
                            <Item
                                title={t('sessionLog.logPathCopyLabel')}
                                subtitle={formatPathRelativeToHome(sessionLogPath, session.metadata.homeDir)}
                                icon={<Icon name="file-text" size={29} color={theme.colors.accent.indigo} />}
                                copy={sessionLogPath}
                                showChevron={false}
                            />
                        )}
                        {devModeEnabled && providerSessionArtifactPath && (
                            <Item
                                title={t('sessionInfo.providerSessionLogs', { provider: providerDisplayName })}
                                subtitle={formatPathRelativeToHome(providerSessionArtifactPath, session.metadata.homeDir)}
                                icon={<Icon name="file-text" size={29} color={theme.colors.accent.indigo} />}
                                copy={providerSessionArtifactPath}
                                showChevron={false}
                            />
                        )}
                        {!!attachCommand && (
                            <Item
                                title={t('sessionInfo.attachFromTerminal')}
                                subtitle={attachCommand}
                                icon={<Icon name="terminal" size={29} color={theme.colors.accent.indigo} />}
                                copy={attachCommand}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxTarget && (
                            <Item
                                title={t('sessionInfo.tmuxTarget')}
                                subtitle={tmuxTarget}
                                icon={<Icon name="stack" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxFallbackReason && (
                            <Item
                                title={t('sessionInfo.tmuxFallback')}
                                subtitle={tmuxFallbackReason}
                                icon={<Icon name="warning-circle" size={29} color={theme.colors.accent.orange} />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.copyMetadata')}
                            icon={<Icon name="copy" size={29} color={theme.colors.accent.blue} />}
                            copy={JSON.stringify(session.metadata, null, 2)}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {session.agentState && (
                    <ItemGroup title={t('sessionInfo.agentState')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={session.agentState.controlledByUser ? t('common.yes') : t('common.no')}
                            icon={<Icon name="person" size={29} color={theme.colors.accent.orange} />}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                icon={<Icon name="hourglass" size={29} color={theme.colors.accent.orange} />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                <SessionInfoActivityGroup
                    sessionId={session.id}
                    formatDate={formatDate}
                    sessionStatus={sessionStatus}
                    showRawDiagnostics={devModeEnabled}
                />

                {/* Raw JSON (Dev Mode Only) */}
                {devModeEnabled && (
                    <ItemGroup title={t('sessionInfo.rawJsonDevMode')}>
                        {session.agentState && (
                            <>
                                <Item
                                    title={t('sessionInfo.agentState')}
                                    icon={<Icon name="code" size={29} color={theme.colors.accent.orange} />}
                                    onPress={handleToggleAgentStateJson}
                                />
                                {expandedRawJsonSection === 'agentState' && expandedRawJsonCode && (
                                    <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={expandedRawJsonCode}
                                        language="json"
                                    />
                                    </View>
                                )}
                            </>
                        )}
                        {session.metadata && (
                            <>
                                <Item
                                    title={t('sessionInfo.metadata')}
                                    icon={<Icon name="info" size={29} color={theme.colors.accent.indigo} />}
                                    onPress={handleToggleMetadataJson}
                                />
                                {expandedRawJsonSection === 'metadata' && expandedRawJsonCode && (
                                    <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={expandedRawJsonCode}
                                        language="json"
                                    />
                                    </View>
                                )}
                            </>
                        )}
                        {sessionStatus && (
                            <>
                                <Item
                                    title={t('sessionInfo.sessionStatus')}
                                    icon={<Icon name="chart-line" size={29} color={theme.colors.accent.blue} />}
                                    onPress={handleToggleSessionStatusJson}
                                />
                                {expandedRawJsonSection === 'sessionStatus' && expandedRawJsonCode && (
                                    <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={expandedRawJsonCode}
                                        language="json"
                                    />
                                    </View>
                                )}
                            </>
                        )}
                        {/* Full Session Object */}
                        <Item
                            title={t('sessionInfo.fullSessionObject')}
                            icon={<Icon name="file-text" size={29} color={theme.colors.state.success.foreground} />}
                            onPress={handleToggleSessionJson}
                        />
                        {expandedRawJsonSection === 'session' && expandedRawJsonCode && (
                            <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                            <CodeView 
                                code={expandedRawJsonCode}
                                language="json"
                            />
                            </View>
                        )}
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
}

const MemoizedSessionInfoContent = React.memo(SessionInfoContent, areSessionInfoContentPropsEqual);

export default () => {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = useSessionRouteServerScope(params);
    const { id } = params;
    const sessionId = String(id ?? '').trim();
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionInfoRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const sessionServerId = usePreferredServerIdForSession(sessionId);
    const reachableMachineIdForHandoff = useSessionMachineTarget(sessionId)?.machineId ?? null;
    const sourceMachineIdForHandoff = React.useMemo(
        () => resolveSessionHandoffSourceMachineId({
            reachableMachineId: reachableMachineIdForHandoff,
            sessionMetadata: session?.metadata as any,
        }),
        [reachableMachineIdForHandoff, session?.metadata],
    );
    const runtimeAvailability = useSessionHandoffSourceReachability({
        serverId: sessionServerId,
        sourceMachineId: sourceMachineIdForHandoff,
    });

    // Handle three states: loading, deleted, and exists.
    // If the session record is already present, fail open and render it even if global hydration
    // is still in progress; otherwise deep links can get stuck in a permanent spinner state.
    const contentSession = useStableSessionInfoContentSession(session);

    if (!session && (!isDataReady || !sessionHydrated) && !sessionMissingAfterHydration) {
        // Still loading data
        return (
            <View testID="session-info-screen" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="hourglass" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!session) {
        // Session has been deleted or doesn't exist
        return (
            <View testID="session-info-screen" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="trash" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.primary, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>{t('errors.sessionDeleted')}</Text>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>{t('errors.sessionDeletedDescription')}</Text>
            </View>
        );
    }

    return (
        <View testID="session-info-screen" style={{ flex: 1 }}>
            <MemoizedSessionInfoContent
                session={contentSession ?? session}
                sessionServerId={sessionServerId}
                sourceMachineIdForHandoff={sourceMachineIdForHandoff}
                runtimeAvailability={runtimeAvailability}
                routeScope={routeScope}
            />
        </View>
    );
};
