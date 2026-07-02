import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { storage, useProfile, useSession, useLocalSetting, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId } from '@/utils/sessions/sessionUtils';
import * as Clipboard from 'expo-clipboard';
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
import { HappyError } from '@/utils/errors/errors';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { useSessionSharingSupport } from '@/hooks/session/useSessionSharingSupport';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { Text } from '@/components/ui/text/Text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { executeSessionForkAction } from '@/sync/domains/sessionFork/executeSessionForkAction';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import {
    resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import { getActionSpec } from '@happier-dev/protocol';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSessionHandoffSourceReachability, type SessionHandoffRuntimeAvailability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveSessionActionDefaultBackendTitle } from '@/sync/domains/session/resolveSessionActionDefaultBackendTitle';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
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
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { getTagsForSession, sessionTagKey, setTagsForSession } from '@/components/sessions/shell/sessionTagUtils';
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
import { setSessionFolderAssignment } from '@/sync/ops/sessionFolders';

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

function SessionInfoContent({ session, sessionServerId, sourceMachineIdForHandoff, runtimeAvailability, routeScope }: Readonly<{
    session: Session;
    sessionServerId: string | null;
    sourceMachineIdForHandoff: string | null;
    runtimeAvailability: SessionHandoffRuntimeAvailability;
    routeScope: ReturnType<typeof createSessionRouteServerScope>;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const profile = useProfile();
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    const devModeEnabled = __DEV__ || localDevModeEnabled === true;
    const sessionName = getSessionName(session);
    const sessionStatus = useSessionStatus(session, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const sessionFoldersEnabled = useFeatureEnabled('sessions.folders');
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(session.id, sessionServerId);
    const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, { enabled: Boolean(sessionServerId) });
    const useProfiles = useSetting('useProfiles') === true;
    const profilesSetting = useSetting('profiles');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const profiles = Array.isArray(profilesSetting) ? profilesSetting : [];
    const actionsSettingsV1 = useSetting('actionsSettingsV1');
    const sessionReplayEnabled = useSetting('sessionReplayEnabled') === true;
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionFoldersV1 = useSetting('sessionFoldersV1');
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
    const daemonProjectionMachineId = React.useMemo(() => {
        const raw = typeof (session.metadata as any)?.machineId === 'string' ? (session.metadata as any).machineId : '';
        const trimmed = String(raw ?? '').trim();
        return trimmed.length > 0 ? trimmed : null;
    }, [session.metadata]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: daemonProjectionMachineId,
        serverId: sessionServerId ?? null,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const sessionActionDefaultBackend = React.useMemo(
        () => resolveSessionActionDefaultBackend({
            session,
            enabledAgentIds,
            fallbackAgentId: agentId,
        }),
        [agentId, enabledAgentIds, session],
    );
    const sessionActionDefaultBackendEntry = React.useMemo(() => {
        if (!sessionActionDefaultBackend) return null;
        const selectedTargetKey = resolveBackendTargetKeyV2(sessionActionDefaultBackend.backendTarget);
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: (acpCatalogSettingsV1 as any) ?? { v: 2, backends: [] },
            backendEnabledByTargetKey: (backendEnabledByTargetKey as any) ?? null,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
        }).find((entry) => entry.backendTargetKey === selectedTargetKey) ?? null;
    }, [
        acpCatalogSettingsV1,
        backendEnabledByTargetKey,
        daemonMergedProjectionInputs?.discoveredBackendIds,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        enabledAgentIds,
        sessionActionDefaultBackend,
    ]);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (childSessionId) => {
                const normalizedChildSessionId = normalizeSessionId(childSessionId);
                const resolvedServerId = resolvePreferredServerIdForSessionId(normalizedChildSessionId) ?? sessionServerId ?? '';
                const normalizedServerId = String(resolvedServerId).trim();
                return normalizedServerId || null;
            },
            openSession: (childSessionId) => {
                router.push(routeScope.buildHref(childSessionId) as any);
            },
        }),
        [routeScope, router, sessionServerId],
    );

    const forkActionEnabled = React.useMemo(() => {
        return isActionEnabledInState(
            storage.getState() as any,
            'session.fork' as any,
            { surface: 'ui', placement: 'session_info' } as any,
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
            { surface: 'ui', placement: 'session_info' } as any,
        );
    }, [actionsSettingsV1]);
    const reachableMachineTarget = useSessionReachableMachineTarget(session.id);
    const reachableMachineId = reachableMachineTarget?.machineId ?? null;
    const handoffAvailability = resolveSessionHandoffUiAvailability({
        sessionId: session.id,
        serverId: sessionServerId,
        reachableMachineId,
        session,
        sessionHandoffFeatureEnabled: sessionHandoffEnabled,
        serverSnapshot,
        runtimeAvailability,
    });
    const handoffSupported = handoffAvailability.available;
    const newSessionSeedMachineId = reachableMachineId ?? session.metadata?.machineId ?? null;
    const newSessionSeedDirectory = reachableMachineTarget?.basePath ?? session.metadata?.path ?? null;

    const vendorResumeLabelKey = core.resume.uiVendorResumeIdLabelKey;
    const vendorResumeCopiedKey = core.resume.uiVendorResumeIdCopiedKey;
    const vendorResumeId = React.useMemo(() => {
        return getAgentVendorResumeId(session.metadata, agentId);
    }, [agentId, session.metadata]);

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
    }), [
        sessionStatus.isConnected,
        sessionStatus.isPulsing,
        sessionStatus.statusColor,
        sessionStatus.statusDotColor,
        sessionStatus.statusText,
    ]);
    const toggleRawJsonSection = React.useCallback((section: RawJsonSectionId) => {
        setExpandedRawJsonSection((current) => current === section ? null : section);
    }, []);
    const handleToggleAgentStateJson = React.useCallback(() => toggleRawJsonSection('agentState'), [toggleRawJsonSection]);
    const handleToggleMetadataJson = React.useCallback(() => toggleRawJsonSection('metadata'), [toggleRawJsonSection]);
    const handleToggleSessionStatusJson = React.useCallback(() => toggleRawJsonSection('sessionStatus'), [toggleRawJsonSection]);
    const handleToggleSessionJson = React.useCallback(() => toggleRawJsonSection('session'), [toggleRawJsonSection]);
    const expandedRawJsonCode = React.useMemo(() => {
        switch (expandedRawJsonSection) {
            case 'agentState':
                return JSON.stringify(session.agentState, null, 2);
            case 'metadata':
                return JSON.stringify(session.metadata, null, 2);
            case 'sessionStatus':
                return JSON.stringify(rawSessionStatus, null, 2);
            case 'session':
                return JSON.stringify(session, null, 2);
            default:
                return null;
        }
    }, [expandedRawJsonSection, rawSessionStatus, session]);
    const sessionLogPath = React.useMemo(() => {
        const value = typeof (session.metadata as any)?.sessionLogPath === 'string'
            ? (session.metadata as any).sessionLogPath.trim()
            : '';
        return value.length > 0 ? value : null;
    }, [session.metadata]);

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            Modal.alert(t('common.success'), t('sessionInfo.happySessionIdCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        }
    }, [session]);

    const handleCopyAttachCommand = useCallback(async () => {
        if (!attachCommand) return;
        try {
            await Clipboard.setStringAsync(attachCommand);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('sessionInfo.attachFromTerminal') }));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        }
    }, [attachCommand]);

    const handleCopyMetadata = useCallback(async () => {
        if (!session?.metadata) return;
        try {
            await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
            Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        }
    }, [session]);

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

    const handleCopySessionLogPath = useCallback(async () => {
        if (!sessionLogPath) return;
        try {
            await Clipboard.setStringAsync(sessionLogPath);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('sessionLog.logPathCopyLabel') }));
        } catch {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        }
    }, [sessionLogPath]);

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

    const cachedSessionServerId = resolveServerIdForSessionIdFromLocalCache(session.id);
    const resolvedServerId = cachedSessionServerId ?? sessionServerId;
    const scopedMutationServerId = cachedSessionServerId ?? routeScope.serverId ?? sessionServerId ?? null;
    const isPinnedSession = Boolean(
        resolvedServerId &&
        Array.isArray(pinnedSessionKeysV1) &&
        pinnedSessionKeysV1.includes(`${resolvedServerId}:${session.id}`),
    );
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
        session,
        serverId: scopedMutationServerId,
        currentUserId,
        isConnected: sessionStatus.isConnected,
        isPinned: isPinnedSession,
    }), [currentUserId, isPinnedSession, scopedMutationServerId, session, sessionStatus.isConnected]);
    const canStopSession = sessionActionTarget.isActive && sessionActionTarget.canStop;
    const canArchiveSession = sessionActionTarget.canArchive;
    const canDeleteSession = sessionActionTarget.canDelete;
    const visibleSessionActionIds = React.useMemo(
        () => new Set(listVisibleSessionActionIds({ target: sessionActionTarget, surface: 'sessionInfo' })),
        [sessionActionTarget],
    );
    const canRenameSession = visibleSessionActionIds.has(SESSION_ACTION_RENAME_ID);
    const sessionSettingsKey = typeof resolvedServerId === 'string' && resolvedServerId.trim()
        ? sessionTagKey(resolvedServerId, session.id)
        : null;
    const sessionInfoTags = sessionSettingsKey
        ? getTagsForSession(sessionTagsV1 as Record<string, string[]> | null | undefined, sessionSettingsKey)
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
    const readStateActionId = React.useMemo(
        () => resolveSessionReadStateActionId(sessionActionTarget),
        [sessionActionTarget],
    );
    const readStateInfoItem = React.useMemo(
        () => readStateActionId
            ? createSessionActionInfoItemProps({ actionId: readStateActionId, iconColor: theme.colors.accent.blue })
            : null,
        [readStateActionId, theme.colors.accent.blue],
    );
    const moveTargets = React.useMemo(() => buildSessionInfoMoveTargets({
        sessionFolders: sessionFoldersV1,
        workspace: resolveSessionInfoWorkspaceRef(session, scopedMutationServerId),
    }), [scopedMutationServerId, session, sessionFoldersV1]);

    const handleReadStateAction = useCallback(async () => {
        if (!readStateActionId) return;
        await executeSessionAction({
            actionId: readStateActionId,
            target: sessionActionTarget,
        });
    }, [readStateActionId, sessionActionTarget]);
    const [updatingReadState, performReadStateAction] = useHappyAction(handleReadStateAction);

    const handleTogglePinned = useCallback(async () => {
        if (!sessionSettingsKey) return;
        await executeSessionAction({
            actionId: isPinnedSession ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
            target: sessionActionTarget,
            context: {
                operations: {
                    setPinned: async (_sessionId, pinned) => {
                        const current = Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : [];
                        const withoutSession = current.filter((key) => key !== sessionSettingsKey);
                        await setPinnedSessionKeysV1(pinned ? [...withoutSession, sessionSettingsKey] : withoutSession);
                    },
                },
            },
        });
    }, [isPinnedSession, pinnedSessionKeysV1, sessionActionTarget, sessionSettingsKey, setPinnedSessionKeysV1]);
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
                        await setSessionTagsV1(setTagsForSession(
                            sessionTagsV1 as Record<string, string[]> | null | undefined,
                            sessionSettingsKey,
                            [...tags],
                        ));
                    },
                },
            },
        });
    }, [sessionActionTarget, sessionInfoTags, sessionSettingsKey, sessionTagsV1, setSessionTagsV1]);
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
                        await setSessionFolderAssignment({
                            credentials,
                            serverId: serverProfile.id,
                            serverUrl: serverProfile.serverUrl,
                            sessionId: session.id,
                            folderId: input?.folderId ?? null,
                        });
                    },
                },
            },
        });
    }, [moveTargets, openMoveSheet, scopedMutationServerId, session.id, sessionActionTarget, sessionFoldersEnabled, sessionName]);
    const [movingToFolder, performMoveToFolder] = useHappyAction(handleMoveToFolder);

    const handleStopAndMaybeArchive = useCallback(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: sessionActionTarget,
            context: { hideInactiveSessions },
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
            context: { hideInactiveSessions },
        });
        handleExitAfterSessionMutation();
    }, [handleExitAfterSessionMutation, hideInactiveSessions, sessionActionTarget]);
    const [archivingSession, performArchive] = useHappyAction(handleArchive);

    const handleForkAction = useCallback(async () => {
        const res = await executeSessionForkAction({
            execute: executor.execute as any,
            sessionId: session.id,
            context: { defaultSessionId: session.id, surface: 'ui', placement: 'session_info' } as any,
        });
        if (!res.ok) {
            throw new HappyError(res.error || t('errors.failedToForkSession'), false);
        }
    }, [executor.execute, router, session.id]);

    const [forkingSession, performFork] = useHappyAction(handleForkAction);

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

        if (newName?.trim()) {
            await executeSessionAction({
                actionId: SESSION_ACTION_RENAME_ID,
                target: sessionActionTarget,
                input: { title: newName },
            });
        }
    }, [canRenameSession, sessionActionTarget, sessionName]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    const handleCopyCommand = useCallback(async (command: string) => {
        try {
            await Clipboard.setStringAsync(command);
            Modal.alert(t('common.success'), command);
        } catch (error) {
            Modal.alert(t('common.error'), t('common.error'));
        }
    }, []);

    const handleCopyUpdateCommand = useCallback(async () => {
        const updateCommand = 'happier self update';
        await handleCopyCommand(updateCommand);
    }, [handleCopyCommand]);

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
                            icon={<Ionicons name="warning-outline" size={29} color={theme.colors.accent.orange} />}
                            showChevron={false}
                            onPress={handleCopyUpdateCommand}
                        />
                    </ItemGroup>
                )}

                <SessionRetentionNotice sessionId={session.id} />

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title={t('sessionInfo.happySessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={handleCopySessionId}
                    />
                    {vendorResumeId && vendorResumeLabelKey && vendorResumeCopiedKey && (
                        <Item
                            title={t(vendorResumeLabelKey)}
                            subtitle={`${vendorResumeId.substring(0, 8)}...${vendorResumeId.substring(vendorResumeId.length - 8)}`}
                            icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.accent.blue} />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(vendorResumeId);
                                    Modal.alert(t('common.success'), t(vendorResumeCopiedKey));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
                                }
                            }}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.isConnected ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        icon={<Ionicons name="calendar-outline" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.lastUpdated')}
                        subtitle={formatDate(session.updatedAt)}
                        icon={<Ionicons name="time-outline" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.sequence')}
                        detail={session.seq.toString()}
                        icon={<Ionicons name="git-commit-outline" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Quick Actions */}
                <ItemGroup title={t('sessionInfo.quickActions')}>
                    {canRenameSession && (
                        <Item
                            title={t('sessionInfo.renameSession')}
                            subtitle={t('sessionInfo.renameSessionSubtitle')}
                            icon={<Ionicons name="pencil-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={handleRenameSession}
                        />
                    )}
                    <Item
                        testID="session-info-new-session-same-setup"
                        title={t('sessionInfo.newSessionSameSetup')}
                        subtitle={t('sessionInfo.newSessionSameSetupSubtitle')}
                        icon={<Ionicons name="copy-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={handleNewSessionSameSetup}
                    />
                    {!session.accessLevel && forkActionEnabled && forkSupported && (
                        <Item
                            testID="session-info-fork-session"
                            title={t('sessionInfo.forkSession')}
                            subtitle={t('sessionInfo.forkSessionSubtitle')}
                            icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={performFork}
                            loading={forkingSession}
                        />
                    )}
                    {!session.accessLevel && handoffActionEnabled && handoffSupported && (
                        <Item
                            title={handoffActionSpec.title}
                            subtitle={handoffActionSpec.description}
                            icon={<Octicons name="arrow-switch" size={24} color={theme.colors.accent.blue} />}
                            onPress={performHandoff}
                            loading={handingOffSession}
                        />
                    )}
                    {readStateInfoItem ? (
                        <Item
                            {...readStateInfoItem}
                            onPress={performReadStateAction}
                            loading={updatingReadState}
                        />
                    ) : null}
                    {sessionSettingsKey && pinInfoItemProps ? (
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
                    {executionRunsEnabled && sessionExecutionRunsSupported ? (
                        <Item
                            title={t('runs.title')}
                            subtitle={t('sessionInfo.executionRunsSubtitle')}
                            icon={<Ionicons name="play-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/runs' }))}
                        />
                    ) : null}
                    {showAutomations ? (
                        <Item
                            title={t('sessionInfo.automationsTitle')}
                            subtitle={t('sessionInfo.automationsSubtitle')}
                            icon={<Ionicons name="timer-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/automations' }))}
                        />
                    ) : null}
                        {!session.active && Boolean(vendorResumeId) && (
                            <Item
                                title={t('sessionInfo.copyResumeCommand')}
                                subtitle={t('sessionInfo.resumeCommand', { sessionId: session.id })}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.purple} />}
                                showChevron={false}
                                onPress={() => handleCopyCommand(t('sessionInfo.resumeCommand', { sessionId: session.id }))}
                            />
                        )}
                    <Item
                        title={t('sessionInfo.viewSessionLogTitle')}
                        subtitle={t('sessionInfo.viewSessionLogSubtitle')}
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/log' }))}
                    />
                    {reachableMachineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            subtitleAccessory={
                                <Text
                                    testID="sessionInfo.viewMachineTargetMachineId"
                                    style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
                                >
                                    {reachableMachineId}
                                </Text>
                            }
                            icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => {
                                const encodedMachineId = encodeURIComponent(reachableMachineId);
                                const normalizedServerId = String(sessionServerId ?? '').trim();
                                const href = normalizedServerId
                                    ? `/machine/${encodedMachineId}?serverId=${encodeURIComponent(normalizedServerId)}`
                                    : `/machine/${encodedMachineId}`;
                                router.push(href);
                            }}
                        />
                    )}
                    {canManageSharing && sharingSupported && (
                        <Item
                            title={t('sessionInfo.manageSharing')}
                            subtitle={t('sessionInfo.manageSharingSubtitle')}
                            icon={<Ionicons name="share-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/sharing' }))}
                        />
                    )}
                    {sessionStatus.isConnected && canStopSession && stopInfoItemProps && (
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
                            icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.accent.indigo} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('sessionInfo.path')}
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.indigo} />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={session.metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                icon={<Ionicons name="git-branch-outline" size={29} color={isCliOutdated ? theme.colors.accent.orange : theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                            <Item
                                title={t('sessionInfo.aiProvider')}
                                subtitle={resolveSessionActionDefaultBackendTitle({
                                    session,
                                    sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
                                    fallbackTitle: t(getAgentCore(agentId).displayNameKey),
                                })}
                                icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                            {useProfiles && session.metadata?.profileId !== undefined && (
                                <Item
                                    title={t('sessionInfo.aiProfile')}
                                    detail={profileLabel}
                                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accent.indigo} />}
                                    showChevron={false}
                                />
                            )}
                            {session.metadata.hostPid && (
                                <Item
                                    title={t('sessionInfo.processId')}
                                    subtitle={session.metadata.hostPid.toString()}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.happyHomeDir && (
                            <Item
                                title={t('sessionInfo.happyHome')}
                                subtitle={formatPathRelativeToHome(session.metadata.happyHomeDir, session.metadata.homeDir)}
                                icon={<Ionicons name="home-outline" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {sessionLogPath && (
                            <Item
                                title={t('sessionLog.logPathCopyLabel')}
                                subtitle={formatPathRelativeToHome(sessionLogPath, session.metadata.homeDir)}
                                icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.indigo} />}
                                onPress={handleCopySessionLogPath}
                                showChevron={false}
                            />
                        )}
                        {!!attachCommand && (
                            <Item
                                title={t('sessionInfo.attachFromTerminal')}
                                subtitle={attachCommand}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                                onPress={handleCopyAttachCommand}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxTarget && (
                            <Item
                                title={t('sessionInfo.tmuxTarget')}
                                subtitle={tmuxTarget}
                                icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxFallbackReason && (
                            <Item
                                title={t('sessionInfo.tmuxFallback')}
                                subtitle={tmuxFallbackReason}
                                icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.accent.orange} />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.copyMetadata')}
                            icon={<Ionicons name="copy-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={handleCopyMetadata}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {session.agentState && (
                    <ItemGroup title={t('sessionInfo.agentState')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={session.agentState.controlledByUser ? t('common.yes') : t('common.no')}
                            icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.orange} />}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                icon={<Ionicons name="hourglass-outline" size={29} color={theme.colors.accent.orange} />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Activity */}
                <ItemGroup title={t('sessionInfo.activity')}>
                    <Item
                        title={t('sessionInfo.sessionStatus')}
                        detail={sessionStatus.statusText}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.statusColor} />}
                        showChevron={false}
                    />
                    {devModeEnabled ? (
                        <>
                            <Item
                                title={t('sessionInfo.thinking')}
                                detail={session.thinking ? t('common.yes') : t('common.no')}
                                icon={<Ionicons name="bulb-outline" size={29} color={session.thinking ? theme.colors.accent.yellow : theme.colors.text.secondary} />}
                                showChevron={false}
                            />
                            {session.thinking && (
                                <Item
                                    title={t('sessionInfo.thinkingSince')}
                                    subtitle={formatDate(session.thinkingAt)}
                                    icon={<Ionicons name="timer-outline" size={29} color={theme.colors.accent.yellow} />}
                                    showChevron={false}
                                />
                            )}
                        </>
                    ) : null}
                </ItemGroup>

                {/* Raw JSON (Dev Mode Only) */}
                {devModeEnabled && (
                    <ItemGroup title={t('sessionInfo.rawJsonDevMode')}>
                        {session.agentState && (
                            <>
                                <Item
                                    title={t('sessionInfo.agentState')}
                                    icon={<Ionicons name="code-working-outline" size={29} color={theme.colors.accent.orange} />}
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
                                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.accent.indigo} />}
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
                                    icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accent.blue} />}
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
                            icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.state.success.foreground} />}
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

export default () => {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id } = params;
    const sessionId = normalizeSessionId(id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionInfoRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSession(sessionId);
    const sessionServerId = React.useMemo(() => {
        const directFallback = String(session?.serverId ?? '').trim() || null;
        const listPreferredServerId = resolveSessionListPreferredServerIdFromState(
            storage.getState(),
            sessionId,
            directFallback,
        );
        const canonicalServerId = resolvePreferredServerIdForSessionId(sessionId);
        const resolvedServerId = canonicalServerId ?? listPreferredServerId ?? directFallback;
        const normalizedServerId = String(resolvedServerId ?? directFallback ?? '').trim();
        return normalizedServerId || null;
    }, [session?.serverId, sessionId]);
    const reachableMachineIdForHandoff = useSessionReachableMachineTarget(sessionId)?.machineId ?? null;
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

    // Handle three states: route pending, route terminal missing, and route available.
    // If the session record is already present, fail open and render it; otherwise deep links can
    // get stuck in a permanent spinner state when the local record is ahead of the route check.
    if (!session && !sessionHydrated && !isSessionRouteHydrationMissing(routeHydrationState)) {
        // Still loading data
        return (
            <View testID="session-info-screen" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!session) {
        // Session has been deleted or doesn't exist
        return (
            <View testID="session-info-screen" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.primary, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>{t('errors.sessionDeleted')}</Text>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>{t('errors.sessionDeletedDescription')}</Text>
            </View>
        );
    }

    return (
        <View testID="session-info-screen" style={{ flex: 1 }}>
            <SessionInfoContent
                session={session}
                sessionServerId={sessionServerId}
                sourceMachineIdForHandoff={sourceMachineIdForHandoff}
                runtimeAvailability={runtimeAvailability}
                routeScope={routeScope}
            />
        </View>
    );
};
