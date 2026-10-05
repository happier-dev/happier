import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Avatar } from '@/components/ui/avatar/Avatar';
import {
    storage,
    useProfile,
    useLocalSetting,
    useSetting,
    useSettings,
    useSessionOrganizationProjection,
    useMachineListByServerId,
} from '@/sync/domains/state/storage';
import { useMachinePoolOriginName } from '@/sync/engine/machines/useMachinePoolOriginName';
import type { MachinePoolProjectionMachine } from '@/sync/engine/machines/useMachinePoolProjections';
import { getSessionName, resolveLockedSessionTitle, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId } from '@/utils/sessions/sessionUtils';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { getAttachCommandForSession, getTmuxFallbackReason, getTmuxTargetForSession } from '@/utils/sessions/terminalSessionDetails';
import { CodeView } from '@/components/ui/media/CodeView';
import { Session } from '@/sync/domains/state/storageTypes';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { HappyError } from '@/utils/errors/errors';
import { resolveProfileById } from '@/sync/domains/profiles/profileUtils';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useOpenSessionCollaboration } from '@/components/sessions/collaboration/useOpenSessionCollaboration';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { Text } from '@/components/ui/text/Text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';
import { runSessionHandoffPickerFlow } from '@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow';
import { resolveSessionHandoffSourceMachineId } from '@/sync/domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import {
    resolveSessionHandoffUiAvailability,
} from '@/sync/domains/sessionHandoff/resolveSessionHandoffUiAvailability';
import { getActionSpec, readSessionDirectoryKind } from '@happier-dev/protocol';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { buildScopedSessionRouteHref, createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSessionHandoffSourceReachability, type SessionHandoffRuntimeAvailability } from '@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { resolveSessionDeleteWarning } from '@/components/sessions/actions/sessionActionPresentation';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import {
    resolveSessionActionDefaultBackend,
    resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveSessionActionDefaultBackendTitle } from '@/sync/domains/session/resolveSessionActionDefaultBackendTitle';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { SessionFollowSourcesEditor } from '@/components/sessions/follow/SessionFollowSourcesEditor';
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
import {
    listVisibleSessionActionIds,
    resolveSessionAttentionStandingActionId,
    resolveSessionReadStateActionId,
} from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionInfoItemProps } from '@/components/sessions/actions/sessionActionPresentation';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import {
    buildSessionFolderWorkspaceTargets,
    normalizeSessionFolderWorkspaceRef,
    normalizeSessionFolders,
    type SessionFolderWorkspaceRefV1,
    type SessionFolderMoveTarget,
} from '@/sync/domains/session/folders';
import {
    requireSessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
    writeSessionOrganizationPin,
    writeSessionOrganizationTagLabels,
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import { resolveSessionAttentionStanding } from '@/sync/domains/session/organization/attentionStanding';
import { useSessionAttentionStandingInputs } from '@/hooks/session/useSessionAttentionStandingInputs';
import {
    buildSessionDebugInformation,
    isSessionDebugInformationEnabled,
    resolveProviderSessionArtifactPath,
    resolveProviderSessionIdForDebug,
} from '@/components/sessions/debug/sessionDebugInformation';
import { stringifySessionDebugJson } from '@/components/sessions/debug/sessionDebugRedaction';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { Icon } from '@/components/ui/icons/Icon';
import { useSessionAddressForSessionId, useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import { usePluginUiSessionPolicyEvaluationContext } from '@/components/sessions/model/usePluginUiSessionPolicyEvaluationContext';
import { WorkspaceSyncRelationshipList } from '@/components/workspaces/sync/WorkspaceSyncRelationshipList';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

type RawJsonSectionId = 'agentState' | 'metadata' | 'sessionStatus' | 'session';
type RawJsonSnapshot = Readonly<{
    section: RawJsonSectionId;
    code: string;
}>;

function SessionMachinePoolOriginItem(props: Readonly<{
    serverId: string | null;
    poolId: string;
    machines?: readonly MachinePoolProjectionMachine[];
}>) {
    const name = useMachinePoolOriginName(props);
    return (
        <Item
            testID="session-info-placement-origin"
            title={t('machinePools.chosenFrom')}
            subtitle={name ?? t('machinePools.aMachinePool')}
            showChevron={false}
        />
    );
}

// Session info is a private-detail surface. Once the canonical content
// availability owner says this viewer cannot open the Session, retain only
// the safe title and identity shell; metadata and actions must not bypass
// the locked Session surface's privacy boundary.
function isSessionInfoContentUnavailable(session: Session): boolean {
    return !isSessionContentReadable(readSessionContentAvailability(session));
}

function resolveSessionInfoWorkspaceRef(
    session: Session,
    serverId: string | null,
): SessionFolderWorkspaceRefV1 | null {
    const metadata = isSessionInfoContentUnavailable(session) ? null : readSessionOwnerMetadataView(session);
    if (!metadata || typeof metadata !== 'object') return null;
    const record = metadata as Record<string, unknown>;
    // A no-folder session lives in its machine's Chats scope for session folders.
    if (readSessionDirectoryKind(metadata) === 'managed') {
        return normalizeSessionFolderWorkspaceRef({
            t: 'managedSessions',
            serverId,
            machineId: typeof record.machineId === 'string' ? record.machineId : null,
        });
    }
    const rootPath = typeof record.path === 'string' ? record.path : null;
    if (!rootPath) return null;
    return normalizeSessionFolderWorkspaceRef({
        t: 'workspaceScope',
        serverId,
        machineId: typeof record.machineId === 'string' ? record.machineId : null,
        rootPath,
    });
}

function buildSessionInfoMoveTargets(params: Readonly<{
    sessionFolders: unknown;
    workspace: SessionFolderWorkspaceRefV1 | null;
}>): SessionFolderMoveTarget[] {
    if (!params.workspace) return [];
    const normalized = normalizeSessionFolders(params.sessionFolders);
    const targets: SessionFolderMoveTarget[] = [{
        id: 'session-info-move-folder:root',
        folderId: null,
        title: t('sessionsList.moveToWorkspaceRoot'),
        depth: 0,
        disabled: false,
    }];
    targets.push(...buildSessionFolderWorkspaceTargets({
        folders: normalized,
        workspace: params.workspace,
    }).map<SessionFolderMoveTarget>((folder) => ({
            ...folder,
            id: `session-info-move-folder:${folder.folderId}`,
            disabled: false,
        })));
    return targets;
}

function SessionInfoContent({ session, sessionServerId, sourceMachineIdForHandoff, runtimeAvailability, routeScope }: Readonly<{
    session: Session;
    sessionServerId: string | null;
    sourceMachineIdForHandoff: string | null;
    runtimeAvailability: SessionHandoffRuntimeAvailability;
    routeScope: ReturnType<typeof createSessionRouteServerScope>;
}>) {
    const contentUnavailable = isSessionInfoContentUnavailable(session);
    const metadata = contentUnavailable ? null : readSessionOwnerMetadataView(session);
    const { theme } = useUnistyles();
    const router = useRouter();
    const profile = useProfile();
    const sessionPluginAddress = useSessionAddressForSessionId(session.id, sessionServerId);
    const pluginRuntime = useSessionPluginRuntime({ address: sessionPluginAddress });
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    const devModeEnabled = isSessionDebugInformationEnabled(localDevModeEnabled);
    const sessionName = contentUnavailable
        ? resolveLockedSessionTitle(getSessionName(session))
        : getSessionName(session);
    const sessionStatus = useSessionStatus(session, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsEnabled = useFeatureEnabled('execution.runs', sessionServerId
        ? { scopeKind: 'spawn', serverId: sessionServerId }
        : undefined);
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const sessionFoldersEnabled = useFeatureEnabled('sessions.folders', sessionServerId
        ? { scopeKind: 'spawn', serverId: sessionServerId }
        : { scopeKind: 'main_selection' });
    // Scoped to THIS Session's server, like the in-Session picker: the child is
    // created on that server, so an unrelated selected server must not decide
    // whether this conversation may continue with another Agent.
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: sessionServerId,
    });
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(session.id, sessionServerId);
    const serverSnapshot = useServerFeaturesSnapshotForServerId(sessionServerId, { enabled: Boolean(sessionServerId) });
    const useProfiles = useSetting('useProfiles') === true;
    const profilesSetting = useSetting('profiles');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const profiles = useAiLaunchProfilesForLegacyUi(profilesSetting);
    const actionsSettingsV1 = useSetting('actionsSettingsV1');
    const sessionReplayEnabled = useSetting('sessionReplayEnabled') === true;
    const settings = useSettings();
    const workspaceRefsV1 = useSetting('workspaceRefsV1');
    const machineListByServerId = useMachineListByServerId();
    const workspaceDisplay = React.useMemo(() => resolveSessionWorkspaceDisplayPresentation({
        serverId: sessionServerId,
        metadata,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
    }), [metadata, sessionServerId, workspaceRefsV1]);
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(sessionServerId ?? '');
    const collaborationTarget = React.useMemo(
        () => normalizeSessionAddress(sessionServerId, session.id),
        [session.id, sessionServerId],
    );
    // An ordinary `Collaboration` row is not an access affordance: it opens the
    // destination's default mode. Only `Manage access`-intent entry points ask
    // for the Access focus target.
    const openSessionCollaboration = useOpenSessionCollaboration({ target: collaborationTarget, replace: true });
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const [expandedRawJsonSnapshot, setExpandedRawJsonSnapshot] = React.useState<RawJsonSnapshot | null>(null);
    const [privateFolderExpanded, setPrivateFolderExpanded] = React.useState(false);
    // Check if CLI version is outdated
    const isCliOutdated = metadata?.version && !isVersionSupported(metadata.version, MINIMUM_CLI_VERSION);
    // A session whose Agent the presentation reader cannot name has no brand to
    // show. Substituting the product default would present it as Claude's.
    const agentId = readSessionPresentationAgentId(session);
    const core = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
    const daemonProjectionMachineId = React.useMemo(() => {
        const raw = typeof (metadata as any)?.machineId === 'string' ? (metadata as any).machineId : '';
        const trimmed = String(raw ?? '').trim();
        return trimmed.length > 0 ? trimmed : null;
    }, [metadata]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: daemonProjectionMachineId,
        serverId: sessionServerId ?? null,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const currentAgentCapabilities = React.useMemo(() => readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        agentId: resolveAgentIdFromSessionMetadata(metadata),
    }), [daemonMergedProjectionInputs?.pluginProjectionV2, metadata]);
    // The mounted Session owns these availability facts. Feature decisions
    // reuse the exact Session server snapshot and canonical feature owner;
    // Session capability ids remain unknown until an exact capability owner
    // supplies them rather than being inferred from presentation state.
    const pluginPolicyContext = usePluginUiSessionPolicyEvaluationContext({
        platform: pluginRuntime.platform,
        settings,
        serverId: sessionServerId,
        serverFeaturesSnapshot: serverSnapshot,
        facts: {
            pluginEnabled: true,
            sessionAgentId: agentId,
            sessionState: sessionStatus.state,
            machineId: pluginRuntime.machineId,
            projectId: null,
            browserExists: false,
        },
    });
    const sessionInfoSections = React.useMemo(() => {
        if (contentUnavailable) return [];
        return Object.values(pluginRuntime.pluginUiProjection?.sessionInfoSectionsById ?? {})
            .map((section) => ({ section, policy: evaluatePluginUiPolicy(section, pluginPolicyContext) }))
            .filter((entry) => entry.policy.visible)
            .sort((left, right) => ((left.section.order ?? 0) - (right.section.order ?? 0))
                || left.section.id.localeCompare(right.section.id));
    }, [contentUnavailable, pluginRuntime.pluginUiProjection?.sessionInfoSectionsById, pluginPolicyContext]);
    const sessionActionDefaultBackend = React.useMemo(
        () => resolveSessionActionDefaultBackend({
            session,
            enabledAgentIds,
            fallbackAgentId: core?.id ?? null,
        }),
        [agentId, enabledAgentIds, session],
    );
    const sessionActionDefaultBackendEntry = React.useMemo(() => {
        const target = resolveSessionActionDefaultTarget(sessionActionDefaultBackend);
        if (!target) return null;
        const selectedTargetKey = resolveBackendTargetKeyV2(target);
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
            openSession: (childSessionId, options) => {
                router.push(buildScopedSessionRouteHref({
                    sessionId: childSessionId,
                    serverId: options?.serverId ?? sessionServerId,
                    query: options?.query,
                }) as any);
            },
        }),
        [router, sessionServerId],
    );

    const forkActionEnabled = React.useMemo(() => {
        return isActionEnabledInState(
            storage.getState() as any,
            'session.fork' as any,
            { surface: 'ui', placement: 'session_info' } as any,
        );
    }, [actionsSettingsV1]);

    const forkSupported = React.useMemo(() => {
        return canForkConversation({
            session,
            replayEnabled: sessionReplayEnabled,
            agentSwitchingEnabled,
            currentAgentCapabilities,
        }) === true;
    }, [agentSwitchingEnabled, currentAgentCapabilities, session, sessionReplayEnabled]);
    const handoffActionSpec = React.useMemo(() => getActionSpec('session.handoff'), []);
    const handoffActionEnabled = React.useMemo(() => {
        return isActionEnabledInState(
            storage.getState() as any,
            'session.handoff' as any,
            { surface: 'ui', placement: 'session_info' } as any,
        );
    }, [actionsSettingsV1]);
    const reachableMachineTarget = useSessionReachableMachineTarget(session.id, sessionServerId);
    const reachableMachineId = reachableMachineTarget?.machineId ?? null;
    const currentExecutionMachineId = reachableMachineId ?? sourceMachineIdForHandoff;
    const currentExecutionMachine = sessionServerId && currentExecutionMachineId
        ? (machineListByServerId[sessionServerId] ?? [])
            .find((machine) => machine.id === currentExecutionMachineId)
        : null;
    const currentExecutionMachineLabel = currentExecutionMachineId
        ? getMachineDisplayName(currentExecutionMachine) ?? currentExecutionMachineId
        : null;
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
    const newSessionSeedMachineId = reachableMachineId ?? metadata?.machineId ?? null;
    // "New session here" from a no-folder session starts another no-folder session: its private
    // folder is never handed on (the seed carries the no-folder choice instead).
    const newSessionSeedDirectory = readSessionDirectoryKind(metadata) === 'managed'
        ? null
        : reachableMachineTarget?.basePath ?? metadata?.path ?? null;

    const vendorResumeLabelKey = core?.resume.uiVendorResumeIdLabelKey ?? null;
    const vendorResumeCopiedKey = core?.resume.uiVendorResumeIdCopiedKey ?? null;
    const vendorResumeId = React.useMemo(() => {
        return getAgentVendorResumeId(metadata, agentId);
    }, [agentId, metadata]);
    const providerDisplayName = React.useMemo(
        () => core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(agentId),
        [agentId, core],
    );
    const providerSessionIdForDebug = React.useMemo(() => resolveProviderSessionIdForDebug({
        metadata,
        vendorResumeIdField: core?.resume.vendorResumeIdField,
    }), [core?.resume.vendorResumeIdField, metadata]);
    const providerSessionArtifactPath = React.useMemo(
        () => resolveProviderSessionArtifactPath(metadata),
        [metadata],
    );
    const sessionDebugInformation = React.useMemo(() => buildSessionDebugInformation({
        session,
        providerDisplayName,
        providerSessionId: providerSessionIdForDebug,
    }), [providerDisplayName, providerSessionIdForDebug, session]);

    const profileLabel = React.useMemo(() => {
        const profileId = metadata?.profileId;
        if (profileId === null || profileId === '') return t('profiles.noProfile');
        if (typeof profileId !== 'string') return t('status.unknown');
        const resolved = resolveProfileById(profileId, profiles);
        if (resolved) {
            return getProfileDisplayName(resolved);
        }
        return t('status.unknown');
    }, [metadata?.profileId, profiles]);

    const attachCommand = React.useMemo(() => {
        return getAttachCommandForSession({ sessionId: session.id, terminal: metadata?.terminal });
    }, [metadata?.terminal, session.id]);

    const tmuxTarget = React.useMemo(() => {
        return getTmuxTargetForSession(metadata?.terminal);
    }, [metadata?.terminal]);

    const tmuxFallbackReason = React.useMemo(() => {
        return getTmuxFallbackReason(metadata?.terminal);
    }, [metadata?.terminal]);
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
    const buildRawJsonCode = React.useCallback((section: RawJsonSectionId) => {
        switch (section) {
            case 'agentState':
                return stringifySessionDebugJson(session.agentState);
            case 'metadata':
                return stringifySessionDebugJson(metadata);
            case 'sessionStatus':
                return stringifySessionDebugJson(rawSessionStatus);
            case 'session':
                return stringifySessionDebugJson(session);
        }
    }, [rawSessionStatus, session]);
    const toggleRawJsonSection = React.useCallback((section: RawJsonSectionId) => {
        setExpandedRawJsonSnapshot((current) => current?.section === section
            ? null
            : { section, code: buildRawJsonCode(section) });
    }, [buildRawJsonCode]);
    const handleToggleAgentStateJson = React.useCallback(() => toggleRawJsonSection('agentState'), [toggleRawJsonSection]);
    const handleToggleMetadataJson = React.useCallback(() => toggleRawJsonSection('metadata'), [toggleRawJsonSection]);
    const handleToggleSessionStatusJson = React.useCallback(() => toggleRawJsonSection('sessionStatus'), [toggleRawJsonSection]);
    const handleToggleSessionJson = React.useCallback(() => toggleRawJsonSection('session'), [toggleRawJsonSection]);
    const expandedRawJsonSection = expandedRawJsonSnapshot?.section ?? null;
    const expandedRawJsonCode = expandedRawJsonSnapshot?.code ?? null;
    const sessionLogPath = React.useMemo(() => {
        const value = typeof (metadata as any)?.sessionLogPath === 'string'
            ? (metadata as any).sessionLogPath.trim()
            : '';
        return value.length > 0 ? value : null;
    }, [metadata]);

    const handleNewSessionSameSetup = useCallback(() => {
        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
        const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
            session,
            machineId: newSessionSeedMachineId,
            directoryOverride: newSessionSeedDirectory,
        }));
        router.push({
            pathname: '/new',
            params: {
                ...buildNewSessionLaunchRouteParams({
                    draftId,
                    machineId: newSessionSeedMachineId,
                    directory: newSessionSeedDirectory,
                    targetServerId: sessionServerId,
                }),
                dataId,
            },
        } as any);
    }, [newSessionSeedDirectory, newSessionSeedMachineId, router, session, sessionServerId]);

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

    // A qualified route owns this screen's identity. Bare-id cache discovery is only a
    // compatibility fallback for navigation that did not carry a Home.
    const cachedSessionServerId = routeScope.serverId
        ? null
        : resolveServerIdForSessionIdFromLocalCache(session.id);
    const resolvedServerId = routeScope.serverId ?? sessionServerId ?? cachedSessionServerId;
    const scopedMutationServerId = routeScope.serverId ?? sessionServerId ?? cachedSessionServerId ?? null;
    const organizationProjection = useSessionOrganizationProjection(resolvedServerId ?? null);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: resolvedServerId ?? '',
        projection: organizationProjection,
    }), [organizationProjection, resolvedServerId]);
    const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1;
    const sessionTagsV1 = organizationListViewState.sessionTagsV1;
    const sessionFoldersV1 = organizationListViewState.sessionFoldersV1;
    const isPinnedSession = Boolean(
        resolvedServerId &&
        pinnedSessionKeysV1.includes(sessionTagKey(resolvedServerId, session.id)),
    );
    const isArchivedSession = session.archivedAt != null;
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const sessionSettingsKey = typeof resolvedServerId === 'string' && resolvedServerId.trim()
        ? sessionTagKey(resolvedServerId, session.id)
        : null;
    const attentionStanding = useSessionAttentionStandingInputs(
        organizationListViewState.attentionStandingOverridesBySessionKey,
    );
    const attentionStandingEnabled = attentionStanding.actionEnabled && sessionSettingsKey != null;
    const isAttentionStandingSession = sessionSettingsKey != null
        && resolveSessionAttentionStanding(attentionStanding.policy, sessionSettingsKey);
    const followEditor = useAccountSessionFollowEditorHost({ serverId: scopedMutationServerId ?? null, sessionId: session.id });
    const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
        session,
        serverId: scopedMutationServerId,
        currentUserId,
        isConnected: sessionStatus.isConnected,
        isPinned: isPinnedSession,
        attentionStandingEnabled,
        followEnabled: followEditor.enabled,
        attentionStanding: isAttentionStandingSession,
    }), [
        attentionStandingEnabled,
        followEditor.enabled,
        currentUserId,
        isAttentionStandingSession,
        isPinnedSession,
        scopedMutationServerId,
        session,
        sessionStatus.isConnected,
    ]);
    const canStopSession = sessionActionTarget.isActive && sessionActionTarget.canStop;
    const canArchiveSession = sessionActionTarget.canArchive;
    const canDeleteSession = sessionActionTarget.canDelete;
    const visibleSessionActionIds = React.useMemo(
        () => contentUnavailable
            ? new Set<string>()
            : new Set(listVisibleSessionActionIds({ target: sessionActionTarget, surface: 'sessionInfo' })),
        [contentUnavailable, sessionActionTarget],
    );
    const canRenameSession = visibleSessionActionIds.has(SESSION_ACTION_RENAME_ID);
    const sessionInfoTagEntries = sessionSettingsKey
        ? sessionTagsV1[sessionSettingsKey] ?? []
        : [];
    const sessionInfoTags = sessionInfoTagEntries.flatMap((tag) =>
        tag.display.status === 'available' ? [tag.display.value] : []);
    const sessionInfoTagIds = sessionInfoTagEntries.map((tag) => tag.tagId);
    const sessionInfoTagLabelById = buildSessionOrganizationTagLabelById(
        organizationProjection?.tagsById ?? {},
    );
    const sessionInfoTagDetail = sessionInfoTagEntries
        .map((tag) => tag.display.status === 'available'
            ? tag.display.value
            : t('common.unavailable'))
        .join(', ');
    const getSessionOrganizationMutationScopeOrThrow = useCallback(async (
        serverIdRaw?: string | null,
    ): Promise<SessionOrganizationMutationScope> => {
        const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
            ? serverIdRaw.trim()
            : scopedMutationServerId;
        return await requireSessionOrganizationMutationScope(serverId);
    }, [scopedMutationServerId]);
    const pinInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: isPinnedSession ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
    }), [isPinnedSession]);
    const tagsInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_EDIT_TAGS_ID,
    }), []);
    const moveToFolderInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
    }), []);
    const stopInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_STOP_ID,
    }), []);
    const archiveInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_ARCHIVE_ID,
    }), []);
    const deleteInfoItemProps = React.useMemo(() => createSessionActionInfoItemProps({
        actionId: SESSION_ACTION_DELETE_ID,
    }), []);
    const readStateActionId = React.useMemo(
        () => resolveSessionReadStateActionId(sessionActionTarget),
        [sessionActionTarget],
    );
    const readStateInfoItem = React.useMemo(
        () => readStateActionId
            ? createSessionActionInfoItemProps({ actionId: readStateActionId })
            : null,
        [readStateActionId],
    );
    const attentionStandingActionId = React.useMemo(
        () => resolveSessionAttentionStandingActionId(sessionActionTarget),
        [sessionActionTarget],
    );
    const attentionStandingInfoItem = React.useMemo(
        () => attentionStandingActionId
            ? createSessionActionInfoItemProps({ actionId: attentionStandingActionId })
            : null,
        [attentionStandingActionId],
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

    const handleAttentionStandingAction = useCallback(async () => {
        if (!attentionStandingActionId) return;
        await executeSessionAction({
            actionId: attentionStandingActionId,
            target: sessionActionTarget,
        });
    }, [attentionStandingActionId, sessionActionTarget]);
    const [updatingAttentionStanding, performAttentionStandingAction] = useHappyAction(handleAttentionStandingAction);

    const handleTogglePinned = useCallback(async () => {
        if (!sessionSettingsKey) return;
        await executeSessionAction({
            actionId: isPinnedSession ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
            target: sessionActionTarget,
            context: {
                operations: {
                    setPinned: async (_sessionId, pinned, opts) => {
                        const scope = await getSessionOrganizationMutationScopeOrThrow(opts?.serverId ?? scopedMutationServerId);
                        await writeSessionOrganizationPin({
                            scope,
                            sessionId: session.id,
                            pinned,
                        });
                    },
                },
            },
        });
    }, [getSessionOrganizationMutationScopeOrThrow, isPinnedSession, scopedMutationServerId, session.id, sessionActionTarget, sessionSettingsKey]);
    const [pinningSession, performTogglePinned] = useHappyAction(handleTogglePinned);

    const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
    const [editingTags, setEditingTags] = React.useState(false);
    const applySessionInfoTagLabels = useCallback(async (nextTags: readonly string[]) => {
        if (!sessionSettingsKey) return;
        await executeSessionAction({
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            target: sessionActionTarget,
            input: { tags: [...nextTags] },
            context: {
                operations: {
                    setTags: async (_sessionId, tags, opts) => {
                        const scope = await getSessionOrganizationMutationScopeOrThrow(opts?.serverId ?? scopedMutationServerId);
                        await writeSessionOrganizationTagLabels({
                            scope,
                            sessionId: session.id,
                            tags: [...tags],
                        });
                    },
                },
            },
        });
    }, [getSessionOrganizationMutationScopeOrThrow, scopedMutationServerId, session.id, sessionActionTarget, sessionSettingsKey]);
    const runSessionInfoTagUpdate = useCallback((nextTags: readonly string[]) => {
        setEditingTags(true);
        void applySessionInfoTagLabels(nextTags).catch((error) => {
            Modal.alert(
                t('common.error'),
                error instanceof HappyError ? error.message : t('errors.unknownError'),
            );
        }).finally(() => setEditingTags(false));
    }, [applySessionInfoTagLabels]);
    const tagMenuContent = React.useMemo(() => buildSessionTagsMenuContent({
        tags: Object.entries(sessionInfoTagLabelById).map(([id, label]) => ({ id, label })),
        selectedTagIds: sessionInfoTagIds,
        iconColor: theme.colors.text.secondary,
        onToggle: (tagId) => {
            const nextTagIds = sessionInfoTagIds.includes(tagId)
                ? sessionInfoTagIds.filter((candidate) => candidate !== tagId)
                : [...sessionInfoTagIds, tagId];
            runSessionInfoTagUpdate(nextTagIds.flatMap((id) => sessionInfoTagLabelById[id] ?? []));
        },
        onCreate: (label) => runSessionInfoTagUpdate([...sessionInfoTags, label]),
    }), [runSessionInfoTagUpdate, sessionInfoTagIds, sessionInfoTagLabelById, sessionInfoTags, theme.colors.text.secondary]);

    const handleMoveToFolder = useCallback(async () => {
        if (!sessionFoldersEnabled || moveTargets.length === 0) return;
        const selectedTarget = await openSessionFolderSelection({
            sourceLabel: sessionName,
            targets: moveTargets,
        });
        if (!selectedTarget) return;
        const folderId = selectedTarget.folderId;
        await executeSessionAction({
            actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            target: sessionActionTarget,
            input: { folderId },
            context: {
                operations: {
                    moveToFolder: async (_target, input) => {
                        const scope = await getSessionOrganizationMutationScopeOrThrow(scopedMutationServerId);
                        await writeSessionOrganizationFolderAssignment({
                            scope,
                            sessionId: session.id,
                            folderId: input?.folderId ?? null,
                        });
                    },
                },
            },
        });
    }, [getSessionOrganizationMutationScopeOrThrow, moveTargets, scopedMutationServerId, session.id, sessionActionTarget, sessionFoldersEnabled, sessionName]);
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

    // A launcher only, exactly like the Session header: strategy is chosen
    // before any fork effect is issued, from every UI entry point.
    const performFork = useCallback(() => {
        openSessionForkStrategyFlow({
            navigation: router,
            sessionId: session.id,
            forkSupportSource: session,
            serverId: sessionServerId ?? null,
            machineId: reachableMachineId ?? readSessionOwnerMetadataView(session)?.machineId ?? null,
            forkPoint: { type: 'latest' },
            settings,
            replayEnabled: sessionReplayEnabled,
            currentAgentCapabilities,
            executionRunsEnabled,
            agentSwitchingEnabled,
            navigateToSession: (childSessionId, options) => {
                router.push(buildScopedSessionRouteHref({
                    sessionId: childSessionId,
                    serverId: options?.serverId ?? sessionServerId,
                }) as any);
            },
            navigateToNewSession: (route) => {
                router.push(route as any);
            },
        });
    }, [
        agentSwitchingEnabled,
        currentAgentCapabilities,
        executionRunsEnabled,
        reachableMachineId,
        router,
        session,
        sessionReplayEnabled,
        sessionServerId,
        settings,
    ]);

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

    const handleDeleteSession = useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('sessionInfo.deleteSession'),
            resolveSessionDeleteWarning({
                metadata, machineOnline: currentExecutionMachine ? isMachineOnline(currentExecutionMachine) : false,
                defaultWarning: t('sessionInfo.deleteSessionWarning'),
                offlineManagedWarning: t('sessionDirectoryRecovery.offlineDelete', { machine: currentExecutionMachineLabel ?? metadata?.host ?? t('status.unknown') }),
            }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('sessionInfo.deleteSession'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        await performDelete();
    }, [currentExecutionMachine, currentExecutionMachineLabel, metadata, performDelete]);

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

    const updateCommand = 'happier self update';
    const resumeCommand = React.useMemo(
        () => t('sessionInfo.resumeCommand', { sessionId: session.id }),
        [session.id],
    );

    const aiProviderTitle = resolveSessionActionDefaultBackendTitle({
        session,
        sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
        fallbackTitle: providerDisplayName,
    });
    const headerMachineLabel = currentExecutionMachineLabel ?? metadata?.host ?? null;
    const headerPath = metadata?.path ? formatPathRelativeToHome(metadata.path, metadata.homeDir) : null;
    const headerMeta = [
        aiProviderTitle ? { key: 'agent', text: aiProviderTitle } : null,
        headerMachineLabel ? { key: 'machine', text: headerMachineLabel } : null,
        headerPath ? { key: 'path', text: headerPath } : null,
    ].filter((fact): fact is { key: string; text: string } => fact !== null);
    const headerMenuActions = canRenameSession
        ? [{ id: 'rename', testID: 'session-info-rename', title: t('sessionInfo.renameSession'), onSelect: handleRenameSession }]
        : [];
    const showStop = sessionStatus.isConnected && canStopSession && stopInfoItemProps;
    const showArchive = canArchiveSession && archiveInfoItemProps;
    const showDelete = canDeleteSession && deleteInfoItemProps;
    const showOrganize = Boolean(readStateInfoItem || attentionStandingInfoItem
        || (!isArchivedSession && sessionSettingsKey && pinInfoItemProps)
        || (sessionSettingsKey && tagsInfoItemProps)
        || (sessionFoldersEnabled && moveTargets.length > 0 && moveToFolderInfoItemProps));

    return (
        <>
            <ItemList style={{ paddingTop: 0 }}>
                <PageHeader
                    testID="session-info-header"
                    alwaysShowTitle
                    title={sessionName}
                    leading={<Avatar id={getSessionAvatarId(session)} size={48} monochrome={!sessionStatus.isConnected} flavor={agentId} />}
                    details={(
                        <View style={infoStyles.status}>
                            <StatusDot
                                color={sessionStatus.statusDotColor}
                                isPulsing={sessionStatus.isPulsing}
                                size={8}
                            />
                            <Text style={[infoStyles.statusText, { color: sessionStatus.statusColor }]}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    )}
                    meta={headerMeta}
                    actions={headerMenuActions.length > 0 ? (
                        <PageHeaderMenu testID="session-info-menu" actions={headerMenuActions} />
                    ) : undefined}
                />

                {/* What blocks use comes first: an outdated CLI, then retention. */}
                {!contentUnavailable && isCliOutdated && (
                    <ItemGroup>
                        <Item
                            title={t('sessionInfo.cliVersionOutdated')}
                            subtitle={t('sessionInfo.updateCliInstructions')}
                            icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                            showChevron={false}
                            copy={updateCommand}
                        />
                    </ItemGroup>
                )}

                {!contentUnavailable ? <SessionRetentionNotice sessionId={session.id} /> : null}

                {sessionInfoSections.map(({ section, policy }) => (
                    <View
                        key={section.id}
                        style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', paddingHorizontal: 16, marginBottom: 8 }}
                    >
                        <PluginInlineSurfaceHost
                            placement={section.placement}
                            inlineMount={{ role: 'sessionInfoSection', presentation: 'content' }}
                            sessionId={session.id}
                            machineId={pluginRuntime.machineId}
                            serverId={pluginRuntime.serverId}
                            pluginUiProjection={pluginRuntime.pluginUiProjection}
                            platform={pluginRuntime.platform}
                            projectionInteractionEnabled={pluginRuntime.phase === 'current'
                                && pluginRuntime.interactionEnabled === true
                                && policy.enabled}
                            policyContext={pluginPolicyContext}
                        />
                    </View>
                ))}

                {/* Activity: what the agent is doing, and whether you hear about it. */}
                {!contentUnavailable ? followEditor.editor : null}
                {!contentUnavailable ? <ItemGroup title={t('sessionInfo.activity')} description={t('sessionPages.info.activityDescription')}>
                    {visibleSessionActionIds.has('ui.session.follow') ? (
                        <View ref={followEditor.anchorRef} collapsable={false}>
                            <Item
                                pressableRef={followEditor.triggerRef}
                                testID="session-info-follow"
                                title={t('session.follow.editor.title')}
                                onPress={() => {
                                    void executeSessionAction({
                                        actionId: 'ui.session.follow',
                                        target: sessionActionTarget,
                                        context: { operations: { openFollowEditor: followEditor.openEditor } },
                                    });
                                }}
                            />
                        </View>
                    ) : null}
                    <Item
                        title={t('sessionInfo.sessionStatus')}
                        detail={sessionStatus.statusText}
                        showChevron={false}
                    />
                    {devModeEnabled ? (
                        <>
                            <Item
                                title={t('sessionInfo.thinking')}
                                detail={session.thinking ? t('common.yes') : t('common.no')}
                                showChevron={false}
                            />
                            {session.thinking && (
                                <Item
                                    title={t('sessionInfo.thinkingSince')}
                                    subtitle={formatDate(session.thinkingAt)}
                                    showChevron={false}
                                />
                            )}
                        </>
                    ) : null}
                </ItemGroup> : null}
                {!contentUnavailable ? <SessionFollowSourcesEditor
                    destination={session}
                    serverId={scopedMutationServerId}
                    destinationMachineId={currentExecutionMachineId}
                /> : null}

                {/* Continue: new work from where this session is. */}
                {!contentUnavailable ? <ItemGroup title={t('sessionPages.info.continueTitle')} description={t('sessionPages.info.continueDescription')}>
                    <Item
                        testID="session-info-new-session-same-setup"
                        title={t('sessionInfo.newSessionSameSetup')}
                        subtitle={t('sessionInfo.newSessionSameSetupSubtitle')}
                        onPress={handleNewSessionSameSetup}
                    />
                    {session.access?.role === 'owner' && forkActionEnabled && forkSupported && (
                        <Item
                            testID="session-info-fork-session"
                            title={t('sessionInfo.forkSession')}
                            subtitle={t('sessionInfo.forkSessionSubtitle')}
                            onPress={performFork}
                        />
                    )}
                    {session.access?.role === 'owner' && handoffActionEnabled && handoffSupported && (
                        <Item
                            title={handoffActionSpec.title}
                            subtitle={handoffActionSpec.description}
                            onPress={performHandoff}
                            loading={handingOffSession}
                        />
                    )}
                    {!session.active && Boolean(vendorResumeId) && (
                        <Item
                            title={t('sessionInfo.copyResumeCommand')}
                            subtitle={resumeCommand}
                            showChevron={false}
                            copy={resumeCommand}
                        />
                    )}
                </ItemGroup> : null}

                {/* Organize: where this session shows up in your lists. */}
                {!contentUnavailable && showOrganize ? (
                    <ItemGroup title={t('sessionPages.info.organizeTitle')} description={t('sessionPages.info.organizeDescription')}>
                        {readStateInfoItem ? (
                            <Item
                                {...readStateInfoItem}
                                onPress={performReadStateAction}
                                loading={updatingReadState}
                            />
                        ) : null}
                        {attentionStandingInfoItem ? (
                            <Item
                                {...attentionStandingInfoItem}
                                onPress={performAttentionStandingAction}
                                loading={updatingAttentionStanding}
                            />
                        ) : null}
                        {!isArchivedSession && sessionSettingsKey && pinInfoItemProps ? (
                            <Item
                                {...pinInfoItemProps}
                                onPress={performTogglePinned}
                                loading={pinningSession}
                            />
                        ) : null}
                        {sessionSettingsKey && tagsInfoItemProps ? (
                            <DropdownMenu
                                open={tagMenuOpen}
                                onOpenChange={setTagMenuOpen}
                                items={tagMenuContent.dropdownItems}
                                onSelect={tagMenuContent.dropdownOnSelect}
                                closeOnSelect={false}
                                onCreateItem={tagMenuContent.dropdownOnCreate}
                                search
                                searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
                                emptyLabel={t('sessionTags.noTagsFound')}
                                placement="auto-vertical"
                                variant="slim"
                                matchTriggerWidth={false}
                                maxWidthCap={320}
                                trigger={({ toggle }) => (
                                    <Item
                                        {...tagsInfoItemProps}
                                        detail={sessionInfoTagDetail || undefined}
                                        onPress={toggle}
                                        loading={editingTags}
                                    />
                                )}
                            />
                        ) : null}
                        {sessionFoldersEnabled && moveTargets.length > 0 && moveToFolderInfoItemProps ? (
                            <Item
                                {...moveToFolderInfoItemProps}
                                onPress={performMoveToFolder}
                                loading={movingToFolder}
                            />
                        ) : null}
                    </ItemGroup>
                ) : null}

                {/* Details: identifiers and history. */}
                {!contentUnavailable ? <ItemGroup title={t('sessionPages.info.detailsTitle')} description={t('sessionPages.info.detailsDescription')}>
                    <Item
                        title={t('sessionInfo.happySessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        copy={session.id}
                    />
                    {core && vendorResumeId && vendorResumeLabelKey && vendorResumeCopiedKey && (
                        <Item
                            title={t(vendorResumeLabelKey)}
                            subtitle={`${vendorResumeId.substring(0, 8)}...${vendorResumeId.substring(vendorResumeId.length - 8)}`}
                            copy={vendorResumeId}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        showChevron={false}
                    />
                    {currentExecutionMachineLabel && (
                        <Item
                            testID="session-info-execution-machine"
                            title={t('machinePools.executionMachine')}
                            subtitle={currentExecutionMachineLabel}
                            showChevron={false}
                        />
                    )}
                    {metadata?.placementOrigin?.kind === 'machine_pool' && (
                        <SessionMachinePoolOriginItem
                            serverId={sessionServerId}
                            poolId={metadata.placementOrigin.poolId}
                            machines={sessionServerId ? machineListByServerId[sessionServerId] ?? undefined : undefined}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.lastUpdated')}
                        subtitle={formatDate(session.updatedAt)}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.sequence')}
                        detail={session.seq.toString()}
                        showChevron={false}
                    />
                </ItemGroup> : null}

                {!contentUnavailable ? <WorkspaceSyncRelationshipList workspaceRefId={workspaceDisplay.workspaceRefId} /> : null}

                {/* Environment: the machine, folder and agent this session runs with. */}
                {metadata && (
                    <ItemGroup title={t('sessionPages.info.environmentTitle')} description={t('sessionPages.info.environmentDescription')}>
                        <Item
                            title={t('sessionInfo.host')}
                            subtitle={metadata.host}
                            showChevron={false}
                        />
                        {readSessionDirectoryKind(metadata) === 'managed' ? (
                            // A no-folder session's folder is Happier's own: named, not shown, with the
                            // real path one disclosure away (with Copy) for support.
                            <ExpandableItem
                                testID="session-info-private-folder"
                                expanded={privateFolderExpanded}
                                onExpandedChange={setPrivateFolderExpanded}
                                header={({ expanded, headerProps }) => (
                                    <Item
                                        {...headerProps}
                                        title={t('session.folderless.folder')}
                                        detail={t('session.folderless.privateToSession')}
                                        showChevron={false}
                                        rightElement={<Icon name={expanded ? 'caret-down' : 'caret-right'} size={16} color={theme.colors.text.secondary} />}
                                    />
                                )}
                            >
                                <Item
                                    testID="session-info-private-folder-path"
                                    title={metadata.path}
                                    copy={metadata.path}
                                    showChevron={false}
                                />
                            </ExpandableItem>
                        ) : (
                            <Item
                                title={t('sessionInfo.path')}
                                subtitle={formatPathRelativeToHome(metadata.path, metadata.homeDir)}
                                showChevron={false}
                            />
                        )}
                        {metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                showChevron={false}
                            />
                        )}
                        {metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(metadata.os)}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.aiProvider')}
                            subtitle={aiProviderTitle}
                            showChevron={false}
                        />
                        {useProfiles && metadata.profileId !== undefined && (
                            <Item
                                title={t('sessionInfo.aiProfile')}
                                detail={profileLabel}
                                showChevron={false}
                            />
                        )}
                        {metadata.hostPid && (
                            <Item
                                title={t('sessionInfo.processId')}
                                subtitle={metadata.hostPid.toString()}
                                showChevron={false}
                            />
                        )}
                        {metadata.happyHomeDir && (
                            <Item
                                title={t('sessionInfo.happyHome')}
                                subtitle={formatPathRelativeToHome(metadata.happyHomeDir, metadata.homeDir)}
                                showChevron={false}
                            />
                        )}
                        {sessionLogPath && (
                            <Item
                                title={t('sessionLog.logPathCopyLabel')}
                                subtitle={formatPathRelativeToHome(sessionLogPath, metadata.homeDir)}
                                copy={sessionLogPath}
                                showChevron={false}
                            />
                        )}
                        {devModeEnabled && providerSessionArtifactPath && (
                            <Item
                                title={t('sessionInfo.providerSessionLogs', { provider: providerDisplayName })}
                                subtitle={formatPathRelativeToHome(providerSessionArtifactPath, metadata.homeDir)}
                                copy={providerSessionArtifactPath}
                                showChevron={false}
                            />
                        )}
                        {!!attachCommand && (
                            <Item
                                title={t('sessionInfo.attachFromTerminal')}
                                subtitle={attachCommand}
                                copy={attachCommand}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxTarget && (
                            <Item
                                title={t('sessionInfo.tmuxTarget')}
                                subtitle={tmuxTarget}
                                showChevron={false}
                            />
                        )}
                        {!!tmuxFallbackReason && (
                            <Item
                                title={t('sessionInfo.tmuxFallback')}
                                subtitle={tmuxFallbackReason}
                                icon={<Icon name="warning-circle" size={20} color={theme.colors.state.warning.foreground} />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.copyMetadata')}
                            copy={stringifySessionDebugJson(metadata)}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {!contentUnavailable && session.agentState && (
                    <ItemGroup title={t('sessionInfo.agentState')} description={t('sessionPages.info.agentStateDescription')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={session.agentState.controlledByUser ? t('common.yes') : t('common.no')}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Related: destinations that belong to this session. */}
                {!contentUnavailable ? <ItemGroup title={t('sessionPages.info.relatedTitle')} description={t('sessionPages.info.relatedDescription')}>
                    {executionRunsEnabled && sessionExecutionRunsSupported ? (
                        <Item
                            title={t('session.subagents.panel.title')}
                            icon={<Icon name="robot" />}
                            subtitle={t('sessionInfo.executionRunsSubtitle')}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/runs' }))}
                        />
                    ) : null}
                    {showAutomations ? (
                        <Item
                            title={t('sessionInfo.automationsTitle')}
                            icon={<Icon name="timer" />}
                            subtitle={t('sessionInfo.automationsSubtitle')}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/automations' }))}
                        />
                    ) : null}
                    <Item
                        title={t('sessionInfo.viewSessionLogTitle')}
                        icon={<Icon name="file-text" />}
                        subtitle={t('sessionInfo.viewSessionLogSubtitle')}
                        onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/log' }))}
                    />
                    {reachableMachineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            icon={<Icon name="hard-drives" />}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            subtitleAccessory={
                                <Text
                                    testID="sessionInfo.viewMachineTargetMachineId"
                                    style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
                                >
                                    {reachableMachineId}
                                </Text>
                            }
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
                    {collaborationTarget && collaborationAdmitted && (
                        <Item
                            testID="session-info-collaboration"
                            icon={<Icon name="users" />}
                            title={t('session.collaboration.title')}
                            onPress={openSessionCollaboration}
                        />
                    )}
                    {sessionActionTarget.isOwnedByCurrentUser ? (
                        <Item
                            testID="session-info-remote-permission-grants"
                            icon={<Icon name="shield-check" />}
                            title={t('sessionRemotePermissionGrants.entryTitle')}
                            subtitle={t('sessionRemotePermissionGrants.entrySubtitle')}
                            onPress={() => router.push(routeScope.buildHref(session.id, { suffix: '/permissions' }))}
                        />
                    ) : null}
                </ItemGroup> : null}

                {/* Developer: raw records, developer mode only. */}
                {!contentUnavailable && devModeEnabled && (
                    <ItemGroup title={t('sessionPages.info.developerTitle')} description={t('sessionPages.info.developerDescription')}>
                        <Item
                            testID="session-info-copy-debug-information"
                            title={t('sessionInfo.copyDebugInformation')}
                            copy={sessionDebugInformation.text}
                        />
                        {session.agentState && (
                            <>
                                <Item
                                    title={t('sessionInfo.agentState')}
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
                        {metadata && (
                            <>
                                <Item
                                    title={t('sessionInfo.metadata')}
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
                        <Item
                            title={t('sessionInfo.fullSessionObject')}
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

                {/* Leaving: quiet buttons; the irreversible one stands apart at the end. */}
                {!contentUnavailable && (showStop || showArchive || showDelete) ? (
                    <ItemGroup surface="none" accessibilityLabel={t('sessionPages.info.leaveLabel')}>
                        <View testID="session-info-leave-actions" style={infoStyles.leaveActions}>
                            {showStop && stopInfoItemProps ? (
                                <RoundButton
                                    testID={stopInfoItemProps.testID}
                                    size="small"
                                    display="secondary"
                                    title={stopInfoItemProps.title}
                                    titleNumberOfLines="complete"
                                    accessibilityHint={stopInfoItemProps.subtitle}
                                    onPress={handleStopSession}
                                    loading={stoppingSession}
                                />
                            ) : null}
                            {showArchive && archiveInfoItemProps ? (
                                <RoundButton
                                    testID={archiveInfoItemProps.testID}
                                    size="small"
                                    display="secondary"
                                    title={archiveInfoItemProps.title}
                                    titleNumberOfLines="complete"
                                    accessibilityHint={archiveInfoItemProps.subtitle}
                                    onPress={handleArchiveSession}
                                    loading={archivingSession}
                                />
                            ) : null}
                            <View style={infoStyles.leaveSpacer} />
                            {showDelete && deleteInfoItemProps ? (
                                <RoundButton
                                    testID={deleteInfoItemProps.testID}
                                    size="small"
                                    display="destructive"
                                    title={deleteInfoItemProps.title}
                                    titleNumberOfLines="complete"
                                    accessibilityHint={deleteInfoItemProps.subtitle}
                                    onPress={handleDeleteSession}
                                    loading={deletingSession}
                                />
                            ) : null}
                        </View>
                        <Text style={infoStyles.footnote}>{t('sessionPages.info.leaveFootnote')}</Text>
                    </ItemGroup>
                ) : null}
            </ItemList>
        </>
    );
}

export const WorkspaceRouteBody = () => {
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
    const session = useSessionViewShellSession(sessionId, routeScope.serverId);
    const sessionServerId = React.useMemo(() => {
        if (routeScope.serverId) return routeScope.serverId;
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
    }, [routeScope.serverId, session?.serverId, sessionId]);
    const reachableMachineIdForHandoff = useSessionReachableMachineTarget(sessionId, sessionServerId)?.machineId ?? null;
    const sourceMachineIdForHandoff = React.useMemo(
        () => resolveSessionHandoffSourceMachineId({
            reachableMachineId: reachableMachineIdForHandoff,
            sessionMetadata: session
                ? readSessionOwnerMetadataView(session) as any
                : null,
        }),
        [reachableMachineIdForHandoff, session],
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

const infoStyles = StyleSheet.create((theme) => ({
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 4,
    },
    statusText: {
        ...Typography.default('medium'),
        fontSize: 13,
    },
    leaveActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    // Pushes "Delete" to the far edge when the row fits, apart from the recoverable actions.
    leaveSpacer: {
        flexGrow: 1,
    },
    footnote: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        marginTop: 10,
        marginHorizontal: 2,
    },
}));

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
