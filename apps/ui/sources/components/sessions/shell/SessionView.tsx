import Color from 'color';

import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentFilePickerHandle, PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionAgentInputExtraActionChips } from '@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { Deferred } from '@/components/ui/forms/Deferred';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { DependabotIcon } from '@/components/ui/icons/DependabotIcon';
import { EmptyMessages } from '@/components/ui/empty/EmptyMessages';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { useDraft } from '@/hooks/session/useDraft';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { continueSessionWithReplay, sessionAbort, resumeSession } from '@/sync/ops';
import { storage, useAllMachines, useAutomations, useEndpointConnectivity, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionPendingMessages, useSessionTranscriptIds, useSessionUsage, useSetting, useSettings, useSyncError, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { setActiveViewingSessionId, clearActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { beginSessionViewingActivation, clearManualUnreadHold, endSessionViewingActivation, shouldSuppressAutomaticMarkViewed } from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, buildResumeSessionExtrasFromUiState } from '@/agents/catalog/catalog';
import { buildSessionComposerNextMessageMetaOverridesFromUiState } from '@/agents/registry/registryUiBehavior';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSession } from '@/sync/domains/state/storage';
import { Session, type Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { computeNextAcpConfigOptionOverrideMetadata } from '@/sync/engine/overrides/acpConfigOptionOverridePublish';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import {
    filterReviewCommentDraftsIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import {
    supportsSessionModeOverrides,
} from '@/sync/acp/sessionModeControl';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform/platform';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { getSessionAvatarId, getSessionName, listPendingPermissionRequests, listPendingUserActionRequests, shouldShowAbortButtonForSessionState, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import {
    resolveParticipantRoutedSend,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { hasSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { nowServerMs } from '@/sync/runtime/time';
import { readSessionUiTelemetryNowMs } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import {
    resolveSessionViewAvailableWidth,
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
} from '@/components/sessions/shell/resolveSessionViewContentBottomSpacing';
import { chooseSubmitMode } from '@/sync/domains/session/control/submitMode';
import { isSessionLocallyAttached } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionSubagentCounts } from '@/sync/domains/session/subagents/deriveSessionSubagentCounts';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, View, type LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { sessionSwitch } from '@/sync/ops';
import { shouldRenderChatTimelineForSession, shouldRequestRemoteControl, shouldRequestRemoteControlAfterPendingEnqueue } from '@/sync/domains/session/control/localControlSwitch';
import { supportsEffectiveLocalControlForSession } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { readControlSwitchUiTimeoutMsFromEnv } from '@/sync/domains/session/control/controlSwitchUiTimeout';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceSessionSnapshot, voiceSessionManager } from '@/voice/session/voiceSession';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/sessionBinding/voiceConversationSession';
import { resolveVoiceSessionComposerRouting } from '@/voice/sessionBinding/voiceSessionComposerRouting';
import { sendVoiceSessionComposerText } from '@/voice/sessionBinding/sendVoiceSessionComposerText';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { countEnabledAutomationsLinkedToSession } from '@/sync/domains/automations/automationSessionLink';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { layout } from '@/components/ui/layout/layout';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { Text } from '@/components/ui/text/Text';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionScreenTestIdsProvider } from './sessionScreenTestIds';
import { useSessionScreenIsFocused } from './useSessionScreenIsFocused';
import { resolveMobileWorkspaceExperienceToggleActionId } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { resolveMultiPaneDeviceType } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';
import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';
import { useSessionResumeRequestListener } from '@/components/sessions/model/sessionResumeRequests';
import { useDirectSessionTakeover } from '@/components/sessions/model/useDirectSessionTakeover';
import { useDirectSessionRuntime } from '@/components/sessions/model/useDirectSessionRuntime';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useAuth } from '@/auth/context/AuthContext';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { isHiddenSystemSession } from '@happier-dev/protocol';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { resolveNextOptimisticAcpConfigOptionOverrides } from './resolveNextOptimisticAcpConfigOptionOverrides';

type SessionAuthSurfaceState = Readonly<{
    message: string;
}>;

function isOwnedSessionRootPathname(pathname: string | null | undefined, sessionId: string): boolean {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim() : '';
    if (!normalizedPathname) {
        return false;
    }

    const match = /^\/session\/([^/]+)\/?$/.exec(normalizedPathname);
    if (!match) {
        return false;
    }

    try {
        return decodeURIComponent(match[1] ?? '') === sessionId;
    } catch {
        return false;
    }
}

function resolveSessionAuthSurfaceState(params: Readonly<{
    endpointStatus: unknown;
    syncError: {
        message: string;
        kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    } | null;
}>): SessionAuthSurfaceState | null {
    if (params.syncError?.kind === 'auth') {
        return { message: params.syncError.message };
    }
    if (params.endpointStatus === 'auth_failed') {
        return { message: createNotAuthenticatedError().message };
    }
    return null;
}

function SessionAuthRecoveryBanner({ message }: Readonly<{ message: string }>) {
    const { theme } = useUnistyles();
    const router = useRouter();

    return (
        <View
            testID="session-auth-sync-error"
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: theme.colors.box.warning.background,
                borderWidth: 1,
                borderColor: theme.colors.box.warning.border,
                borderRadius: 10,
                gap: 8,
            }}
        >
            <Ionicons name="warning-outline" size={16} color={theme.colors.box.warning.text} />
            <View style={{ flexBasis: 0, flexGrow: 1 }}>
                <Text style={{ fontSize: 13, color: theme.colors.box.warning.text, fontWeight: '700' }}>
                    {t('connect.restoreAccount')}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.box.warning.text, lineHeight: 16 }}>
                    {message}
                </Text>
            </View>
            <Pressable
                testID="session-auth-sync-error-restore"
                accessibilityRole="button"
                accessibilityLabel={t('connect.restoreAccount')}
                onPress={() => router.push('/restore')}
                style={({ pressed }) => ({
                    flexShrink: 0,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: theme.colors.box.warning.text,
                    opacity: pressed ? 0.7 : 1,
                })}
            >
                <Text style={{ fontSize: 12, color: theme.colors.box.warning.background, fontWeight: '700' }}>
                    {t('connect.restoreAccount')}
                </Text>
            </Pressable>
        </View>
    );
}

function SessionAuthRecoveryFallback({ message }: Readonly<{ message: string }>) {
    return (
        <View
            testID="session-auth-required-fallback"
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 24,
            }}
        >
            <View style={{ width: '100%', maxWidth: 420 }}>
                <SessionAuthRecoveryBanner message={message} />
            </View>
        </View>
    );
}

type SessionViewProps = Readonly<{
    id: string;
    routeServerId?: string | null;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    contentOverride?: React.ReactNode;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    chatBottomSpacing?: 'default' | 'none';
}>;

export const SessionView = React.memo((props: SessionViewProps) => {
    const sessionId = props.id;
    const router = useRouter();
    const pathname = usePathname();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const auth = useAuth();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const automations = useAutomations();
    const currentSessionRouteServerId =
        resolveServerIdForSessionIdFromLocalCache(sessionId)
        || (props.routeServerId ?? '').trim()
        || getActiveServerSnapshot().serverId;
    const automationsSupport = useAutomationsSupport({ scopeKind: 'spawn', serverId: currentSessionRouteServerId });
    const showAutomations = automationsSupport?.enabled !== false;
    const executionRunsEnabled = useFeatureEnabled('execution.runs', {
        scopeKind: 'spawn',
        serverId: currentSessionRouteServerId,
    });
    const mobileWorkspaceExperienceState = useMobileWorkspaceExperienceState();
    const handleBackPress = React.useCallback(() => {
        safeRouterBack({
            router,
            fallbackHref: '/',
        });
    }, [router]);
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(sessionId, { serverId: currentSessionRouteServerId });
    const safeArea = useSafeAreaInsets();
    const safeAreaTopInset = props.safeAreaTopMode === 'external' ? 0 : safeArea.top;
    const headerSafeAreaTopMode = props.headerSafeAreaTopMode ?? props.safeAreaTopMode ?? 'internal';
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const { width: windowWidth } = useWindowDimensions();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();
    const voiceSnap = useVoiceSessionSnapshot();
    const hasAuthCredentials = Boolean(auth.credentials);
    const isFocused = useSessionScreenIsFocused();
    const endpointConnectivity =
        typeof useEndpointConnectivity === 'function'
            ? useEndpointConnectivity()
            : {
                status: 'idle' as const,
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            };
    const syncError = useSyncError();
    const allMachines = useAllMachines();
    const machinesById = React.useMemo(() => {
        const next: Record<string, (typeof allMachines)[number]> = {};
        for (const machine of allMachines) {
            next[machine.id] = machine;
        }
        return next;
    }, [allMachines]);
    const workspaceLabelsV1 = useSetting('workspaceLabelsV1');
    const sessionWorkspacePresentation = React.useMemo(() => {
        if (!session) return null;
        return resolveSessionWorkspacePresentation({
            metadata: session.metadata ?? null,
            machines: machinesById,
            target: readMachineTargetForSession(session.id),
            workspaceLabelsV1,
        });
    }, [machinesById, session, workspaceLabelsV1]);
    const sessionEncryptionMode: 'e2ee' | 'plain' = (session?.encryptionMode ?? 'e2ee');
    const isEncryptedSessionLocked = Boolean(session && sessionEncryptionMode === 'e2ee' && !hasAuthCredentials);
    const showTopHeader = !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web');
    const paneUrlSyncRouteActive = isFocused && isOwnedSessionRootPathname(pathname, sessionId);
    const scopedSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, currentSessionRouteServerId);
    }, [currentSessionRouteServerId, syncError]);
    const authSurfaceState = React.useMemo(() => {
        return resolveSessionAuthSurfaceState({
            endpointStatus: endpointConnectivity.status,
            syncError: scopedSyncError,
        });
    }, [endpointConnectivity.status, scopedSyncError]);
    const buildCurrentSessionHref = React.useCallback((suffix = '') => {
        return buildScopedSessionRouteHref({
            sessionId,
            serverId: currentSessionRouteServerId,
            suffix,
        });
    }, [currentSessionRouteServerId, sessionId]);

    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const paneScopeId = useRegisterSessionPaneDriver(sessionId);
    const pane = useAppPaneScope(paneScopeId);
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const { messages: committedMessages } = useSessionMessages(sessionId);
    const directSessionRuntime = useDirectSessionRuntime({
        sessionId,
        metadata: session?.metadata ?? null,
    });
    const { subagents, participantTargets, sidechainIds: participantSidechainIds } = useSessionSubagents({
        sessionId,
        session,
        messages: committedMessages,
        directSessionRuntime,
    });
    const subagentCounts = React.useMemo(() => deriveSessionSubagentCounts(subagents), [subagents]);
    const shouldShowSubagentsButton = subagentCounts.total > 0 || sessionExecutionRunsSupported || hasSessionSubagentLaunchCards(session);

    useEnsureSidechainsLoaded({
        enabled: participantSidechainIds.length > 0,
        sessionId,
        sidechainIds: participantSidechainIds,
    });
    const sessionAutomationsEnabledCount = React.useMemo(() => {
        if (!showAutomations) return 0;
        return countEnabledAutomationsLinkedToSession(automations, sessionId);
    }, [automations, sessionId, showAutomations]);

    const constrainHeaderWidth = !(multiPaneEnabled
        && Platform.OS === 'web'
        && ((pane.scopeState?.right.isOpen ?? false) || (pane.scopeState?.details.isOpen ?? false)));

    const mobileWorkspaceExperienceToggleActionId = React.useMemo(
        () => resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperienceState.mobileWorkspaceExperience),
        [mobileWorkspaceExperienceState.mobileWorkspaceExperience],
    );

    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === mobileWorkspaceExperienceToggleActionId) {
            mobileWorkspaceExperienceState.toggleWorkspaceExperience();
            return true;
        }
        if (actionId !== 'header.openSubagents') return false;
        pane.openRight({ tabId: 'agents' });
        pane.setRightTab('agents');
        return true;
    }, [mobileWorkspaceExperienceState, mobileWorkspaceExperienceToggleActionId, pane]);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady && !session) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const isConnected = session.presence === 'online';
        const directSessionLink = readDirectSessionLink(session.metadata);
        const shouldFoldHeaderIconActions = windowWidth < 520;
        const badgeLabel =
            sessionAutomationsEnabledCount > 99 ? '99+' : String(sessionAutomationsEnabledCount);
        const storageBadge = directSessionLink ? t('sessionsList.storageDirectTab') : t('sessionsList.storagePersistedTab');
        const providerBadge = directSessionLink
            ? [
                t(getAgentCore(directSessionLink.providerId).displayNameKey),
                typeof session.metadata?.host === 'string' && session.metadata.host.trim()
                    ? session.metadata.host.trim()
                    : directSessionLink.machineId,
            ].join(' · ')
            : null;
        const headerExtraItems = (() => {
            const items: DropdownMenuItem[] = [];
            if (mobileWorkspaceExperienceState.showWorkspaceExperienceToggle) {
                items.push({
                    id: mobileWorkspaceExperienceToggleActionId,
                    title: t(mobileWorkspaceExperienceState.workspaceExperienceToggleLabelKey),
                    icon: <Ionicons name="phone-portrait-outline" size={18} color={theme.colors.textSecondary} />,
                });
            }
            if (!shouldFoldHeaderIconActions) return items;

            if (shouldShowSubagentsButton) {
                items.push({
                    id: 'header.openSubagents',
                    title: t('session.openSubagents', { count: subagentCounts.active }),
                    icon: <DependabotIcon size={18} color={theme.colors.textSecondary} />,
                });
            }
            if (sessionExecutionRunsSupported) {
                items.push({
                    id: 'header.openRuns',
                    title: t('session.openRuns'),
                    icon: <Ionicons name="play-outline" size={18} color={theme.colors.textSecondary} />,
                });
            }
            if (showAutomations) {
                items.push({
                    id: 'header.openAutomations',
                    title: t('session.openAutomations'),
                    icon: <Ionicons name="timer-outline" size={18} color={theme.colors.textSecondary} />,
                });
            }
            return items;
        })();
        const rightElement = (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <SessionHeaderActionMenu
                    sessionId={sessionId}
                    session={session}
                    extraItems={headerExtraItems.length > 0 ? headerExtraItems : undefined}
                    onSelectExtraItem={handleHeaderExtraItemSelect}
                />
                {!shouldFoldHeaderIconActions ? (
                    <SessionHeaderSubagentsButton
                        scopeId={paneScopeId}
                        activeCount={subagentCounts.active}
                        hasAnySubagents={shouldShowSubagentsButton}
                    />
                ) : null}
                <SessionHeaderTerminalButton
                    sessionId={sessionId}
                    scopeId={paneScopeId}
                    serverId={currentSessionRouteServerId}
                />
                {!shouldFoldHeaderIconActions && sessionExecutionRunsSupported ? (
                    <Pressable
                        onPress={() => router.push(buildCurrentSessionHref('/runs') as any)}
                        hitSlop={15}
                        style={({ pressed }) => ({
                            width: 44,
                            height: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.7 : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={t('session.openRuns')}
                    >
                        <Ionicons name="play-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                ) : null}
                {!shouldFoldHeaderIconActions && showAutomations ? (
                    <Pressable
                        onPress={() => navigateWithBlurOnWeb(() => router.push(buildCurrentSessionHref('/automations') as any))}
                        hitSlop={15}
                        style={({ pressed }) => ({
                            width: 44,
                            height: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.7 : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={t('session.openAutomations')}
                    >
                        <View style={{ position: 'relative', width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="timer-outline" size={22} color={theme.colors.header.tint} />
                            {sessionAutomationsEnabledCount > 0 ? (
                                <View style={{
                                    position: 'absolute',
                                    top: -2,
                                    right: -6,
                                    backgroundColor: theme.colors.status.error,
                                    borderRadius: 8,
                                    minWidth: 16,
                                    height: 16,
                                    paddingHorizontal: 4,
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                }}>
	                                    <Text style={{
	                                        color: theme.colors.overlay.text,
	                                        fontSize: 10,
	                                        fontWeight: '600',
	                                    }}>
	                                        {badgeLabel}
	                                    </Text>
                                </View>
                            ) : null}
                        </View>
                    </Pressable>
                ) : null}
            </View>
        );
        return {
            title: getSessionName(session),
            subtitle: sessionWorkspacePresentation?.displayTitle || undefined,
            subtitleEllipsizeMode: sessionWorkspacePresentation?.displayPath && !sessionWorkspacePresentation.hasCustomLabel ? 'head' as const : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.navigate(buildCurrentSessionHref('/info') as any, {
                dangerouslySingular() {
                    return 'session-info';
                },
            } as any),
	            rightElement,
	            badges: providerBadge ? [storageBadge, providerBadge] : [storageBadge],
	            isConnected: isConnected,
	            flavor: session.metadata?.flavor || null,
	        };
	    }, [
	        handleHeaderExtraItemSelect,
	        isDataReady,
        mobileWorkspaceExperienceState.showWorkspaceExperienceToggle,
        mobileWorkspaceExperienceState.workspaceExperienceToggleLabelKey,
        mobileWorkspaceExperienceToggleActionId,
        paneScopeId,
        router,
        session,
        sessionWorkspacePresentation,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        sessionId,
        shouldShowSubagentsButton,
        showAutomations,
        subagentCounts.active,
        subagentCounts.total,
        theme.colors.header.tint,
        theme.colors.status.error,
        theme.colors.textSecondary,
        windowWidth,
    ]);

    const normalSessionContent = session
        ? (props.contentOverride ?? (
            <SessionViewLoaded
                authSurfaceState={authSurfaceState}
                key={sessionId}
                sessionId={sessionId}
                routeServerId={currentSessionRouteServerId}
                session={session}
                onBackPress={handleBackPress}
                isEncryptedSessionLocked={isEncryptedSessionLocked}
                executionRunsEnabled={executionRunsEnabled}
                committedMessages={committedMessages}
                jumpToSeq={props.jumpToSeq ?? null}
                participantTargets={participantTargets}
                paneUrlState={props.paneUrlState ?? null}
                initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                paneScopeId={paneScopeId}
                pendingMessages={pendingMessages}
                directSessionRuntime={directSessionRuntime}
                chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                paneUrlSyncRouteActive={paneUrlSyncRouteActive}
            />
        ))
        : null;

    return (
        <SessionScreenTestIdsProvider enabled={isFocused}>
            {debugRouterEnabled && Platform.OS === 'web' ? (
                <View
                    testID="debug-expo-pathname"
                    style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
                >
                    <Text>{pathname}</Text>
                </View>
            ) : null}
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {showTopHeader && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={handleBackPress}
                        constrainWidth={constrainHeaderWidth}
                        includeTopInset={headerSafeAreaTopMode !== 'external'}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: showTopHeader ? safeAreaTopInset + headerHeight : 0 }}>
                {!session && authSurfaceState ? (
                    <SessionAuthRecoveryFallback message={authSurfaceState.message} />
                ) : !isDataReady && !session ? (
                    // Loading state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    // Deleted state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                  ) : normalSessionContent}
            </View>
        </SessionScreenTestIdsProvider>
    );
});


function SessionViewLoaded({
    authSurfaceState,
    committedMessages,
    sessionId,
    routeServerId,
    session,
    onBackPress,
    isEncryptedSessionLocked,
    executionRunsEnabled,
    jumpToSeq,
    participantTargets,
    paneUrlState,
    initialAttachmentDrafts,
    paneScopeId,
    pendingMessages,
    directSessionRuntime,
    chatBottomSpacing,
    paneUrlSyncRouteActive,
}: {
    authSurfaceState: SessionAuthSurfaceState | null;
    committedMessages: readonly Message[];
    sessionId: string;
    routeServerId?: string | null;
    session: Session;
    onBackPress: () => void;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    jumpToSeq: number | null;
    participantTargets: readonly SessionParticipantTarget[];
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    paneScopeId: string;
    pendingMessages: readonly PendingMessage[];
    directSessionRuntime: ReturnType<typeof useDirectSessionRuntime>;
    chatBottomSpacing: 'default' | 'none';
    paneUrlSyncRouteActive: boolean;
}) {
    const { theme } = useUnistyles();
    const applyLocalSettings = useApplyLocalSettings();
    const router = useRouter();
    const pathname = usePathname();
    const safeArea = useSafeAreaInsets();
    const directSessionLink = directSessionRuntime.directSessionLink;
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = React.useMemo(
        () => resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType }),
        [deviceType],
    );
    const { width: windowWidth } = useWindowDimensions();
    const [measuredContentWidth, setMeasuredContentWidth] = React.useState<number | null>(null);
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const sessionsRightPaneDefaultOpen = useLocalSetting('sessionsRightPaneDefaultOpen');
    const pane = useAppPaneScope(paneScopeId);
    const activeServerId = getActiveServerSnapshot().serverId;
    const sessionRouteServerId = resolveServerIdForSessionIdFromLocalCache(sessionId)
        || (routeServerId ?? '').trim()
        || activeServerId;
    const capabilityServerId = sessionRouteServerId;
    const buildSessionHref = React.useCallback((sid: string, suffix = '') => {
        return buildScopedSessionRouteHref({
            sessionId: sid,
            serverId: resolveServerIdForSessionIdFromLocalCache(sid) ?? sessionRouteServerId,
            suffix,
        });
    }, [sessionRouteServerId]);
    const buildCurrentSessionHref = React.useCallback((suffix = '') => {
        return buildSessionHref(sessionId, suffix);
    }, [buildSessionHref, sessionId]);

    useSessionPaneUrlSync({
        enabled: paneUrlSyncRouteActive && multiPaneEnabled && Platform.OS === 'web',
        scopeKey: paneScopeId,
        scopeState: pane.scopeState,
        urlState: paneUrlState,
        pane,
        setParams: typeof (router as any)?.setParams === 'function' ? (router as any).setParams.bind(router) : null,
    });

    // Session preference: optionally open the right sidebar by default (files tab) when
    // entering a session for the first time on this device.
    React.useEffect(() => {
        if (!sessionsRightPaneDefaultOpen) return;
        if (!multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || deviceType === 'tablet')) return;
        if (paneUrlState?.rightTabId) return;
        const right = (pane.scopeState as any)?.right ?? null;
        if (!right) return;
        if (right.isOpen === true) return;
        // If the user previously opened any right-pane tab in this session, don't override their choice
        // (even if they closed the pane after).
        if (right.activeTabId !== null && right.activeTabId !== undefined) return;
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [
        deviceType,
        multiPaneEnabled,
        pane,
        pane.scopeState,
        paneUrlState?.rightTabId,
        sessionsRightPaneDefaultOpen,
    ]);
    const [message, setMessage] = React.useState('');
    const realtimeStatus = useRealtimeStatus();
    const { ids: committedMessageIds, isLoaded } = useSessionTranscriptIds(sessionId);
    const openToTranscriptTelemetryRef = React.useRef<{
        recorded: boolean;
        sessionId: string;
        startedAtMs: number;
    } | null>(null);
    if (openToTranscriptTelemetryRef.current?.sessionId !== sessionId) {
        openToTranscriptTelemetryRef.current = {
            recorded: false,
            sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const isForkedSessionV1 = React.useMemo(() => {
        const fork = (session.metadata as any)?.forkV1;
        if (!fork || typeof fork !== 'object') return false;
        if ((fork as any).v !== 1) return false;
        const parentSessionId = (fork as any).parentSessionId;
        return typeof parentSessionId === 'string' && parentSessionId.trim().length > 0;
    }, [session.metadata]);
    const reachableMachineTarget = React.useMemo(() => {
        return readMachineTargetForSession(sessionId);
    }, [sessionId, session.updatedAt, session.metadata]);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = reachableMachineTarget?.machineId ?? session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get model mode from session object - default is agent-specific (Gemini needs an explicit default)
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(session.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    const liveAuthoringContext = React.useMemo(() => {
        return buildLiveSessionAuthoringContext({
            session,
        });
    }, [session]);
    const liveComposerState = React.useMemo(() => {
        return resolveSessionComposerStateFromAuthoringContext(liveAuthoringContext, {
            fallbackAgentId: agentId,
        });
    }, [agentId, liveAuthoringContext]);
    const permissionMode = liveComposerState.permissionMode;
    const sessionModeOptionIds = React.useMemo(() => {
        const modeState =
            (session.metadata as any)?.sessionModesV1
            ?? (session.metadata as any)?.acpSessionModesV1
            ?? null;
        if (
            modeState
            && modeState.provider === liveComposerState.agentId
            && Array.isArray(modeState.availableModes)
        ) {
            return modeState.availableModes
                .map((mode: { id?: unknown }) => (typeof mode?.id === 'string' ? mode.id.trim() : ''))
                .filter((id: string) => id.length > 0);
        }

        const sessionModes = getAgentCore(liveComposerState.agentId)?.sessionModes;
        if (sessionModes?.kind !== 'staticAgentModes') return [];
        return (sessionModes.staticOptions ?? [])
            .map((mode) => (typeof mode?.id === 'string' ? mode.id.trim() : ''))
            .filter((id) => id.length > 0);
    }, [liveComposerState.agentId, session.metadata]);
    const enabledAgentIds = useEnabledAgentIds();
    const sessionActionDefaultBackend = React.useMemo(
        () => resolveSessionActionDefaultBackend({
            session: session as any,
            enabledAgentIds,
            fallbackAgentId: agentId,
        }),
        [agentId, enabledAgentIds, session],
    );
    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(session.metadata ?? null);
    const isHiddenSystemSessionSession = isHiddenSystemSession({ metadata: session.metadata ?? null });
    const modelMode = liveComposerState.modelMode;
    const sessionAcpConfigOptionOverrides = React.useMemo<React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride']>(() => {
        return (session.metadata?.acpConfigOptionOverridesV1 ?? session.metadata?.sessionConfigOptionOverridesV1 ?? null) as React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride'];
    }, [session.metadata]);
    const [optimisticAcpConfigOptionOverrides, setOptimisticAcpConfigOptionOverrides] =
        React.useState<React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride']>(
            sessionAcpConfigOptionOverrides,
        );
    const optimisticAcpConfigOptionOverridesSessionIdRef = React.useRef(sessionId);
    React.useEffect(() => {
        setOptimisticAcpConfigOptionOverrides((current) => {
            const sessionChanged = optimisticAcpConfigOptionOverridesSessionIdRef.current !== sessionId;
            optimisticAcpConfigOptionOverridesSessionIdRef.current = sessionId;
            return resolveNextOptimisticAcpConfigOptionOverrides({
                current,
                incoming: sessionAcpConfigOptionOverrides,
                sessionChanged,
            }) as typeof current;
        });
    }, [sessionAcpConfigOptionOverrides, sessionId]);
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const scmSessionAutoRefreshIntervalMsSetting = useSetting('scmSessionAutoRefreshIntervalMs' as any);
    const scmSessionAutoRefreshIntervalMs =
        typeof scmSessionAutoRefreshIntervalMsSetting === 'number' && Number.isFinite(scmSessionAutoRefreshIntervalMsSetting) && scmSessionAutoRefreshIntervalMsSetting >= 5_000
            ? scmSessionAutoRefreshIntervalMsSetting
            : 5 * 60 * 1000;
    const voice = useSetting('voice') as any;
    const voiceProviderId = voice?.providerId ?? 'off';
    const voiceSnap = useVoiceSessionSnapshot();
    const settings = useSettings();
    const voiceEnabled = useFeatureEnabled('voice');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads', {
        scopeKind: 'spawn',
        serverId: capabilityServerId,
    });
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(sessionId);
    const attachmentsUploadsEnabled = attachmentsUploadsFeatureEnabled && attachmentsUploadsTransferAvailable;
    const reviewScope = useWorkspaceScopeForSession(sessionId);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const includedReviewCommentDrafts = React.useMemo(
        () => filterReviewCommentDraftsIncludedInPrompt(reviewCommentDrafts),
        [reviewCommentDrafts],
    );
    const hasIncludedReviewCommentDrafts = reviewCommentsEnabled && includedReviewCommentDrafts.length > 0;
    const reviewWorkspaceCacheKey = React.useMemo(() => (
        reviewScope ? tryBuildWorkspaceCacheKey(reviewScope) : null
    ), [reviewScope]);
    const clearSentReviewCommentDrafts = React.useCallback(() => {
        const store = storage.getState();
        for (const draft of includedReviewCommentDrafts) {
            if (reviewWorkspaceCacheKey) {
                store.deleteWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draft.id);
            } else {
                store.deleteSessionReviewCommentDraft(sessionId, draft.id);
            }
        }
    }, [includedReviewCommentDrafts, reviewWorkspaceCacheKey, sessionId]);

    const attachmentsUploadConfig = useAttachmentsUploadConfig();

    const attachmentDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsEnabled,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
        initialDrafts: initialAttachmentDrafts ?? undefined,
    });
    const filePickerRef = attachmentDraftManager.filePickerRef;
    const attachmentDrafts = attachmentDraftManager.drafts;
    const agentInputAttachments = attachmentDraftManager.agentInputAttachments;
    const addAttachments = attachmentDraftManager.addWebFiles;
    const addPickedAttachments = attachmentDraftManager.addPickedAttachments;
    const [isUploadingAttachments, setIsUploadingAttachments] = React.useState(false);
    const recipientState = useSessionRecipientState({ targets: participantTargets, autoRecipient: null });

    React.useEffect(() => {
        if (!sessionId) return;
        // Screen-scoped SCM refresh: keep the status badge reasonably up-to-date without noisy polling.
        scmStatusSync.invalidateFromAutoRefresh(sessionId);
        const interval = setInterval(() => {
            scmStatusSync.invalidateFromAutoRefresh(sessionId);
        }, scmSessionAutoRefreshIntervalMs);
        return () => {
            clearInterval(interval);
        };
    }, [scmSessionAutoRefreshIntervalMs, sessionId]);

    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            openSession: (sid) => {
                router.push(buildSessionHref(sid) as any);
            },
        }),
        [buildSessionHref, router]
    );

    // Inactive session resume state
    // Use `session.active` as the source of truth for whether the provider process is running.
    // `presence` is derived from server snapshots and can drift if a partial update lands.
    const isSessionActive = session.active === true;
    const supportsLocalControl = !isHiddenSystemSessionSession && supportsEffectiveLocalControlForSession({
        agentId,
        metadata: session.metadata,
        accountSettings: settings,
    });
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: capabilityServerId,
        settings,
        enabled: !isSessionActive || supportsLocalControl,
    });

    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions);
    const [isResuming, setIsResuming] = React.useState(false);
    const persistedVoiceComposerRouting = React.useMemo(
        () => resolveVoiceSessionComposerRouting({
            conversationSessionId: sessionId,
            sessionMetadata: session.metadata,
        }),
        [session.metadata, sessionId],
    );

    const { machineReachable: isMachineReachable, machineOnline } = useSessionMachineReachability(sessionId);

    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId,
        sessionPath: session?.metadata?.path ?? null,
        machineOnline,
    });

    const inactiveUi = React.useMemo(() => {
        return getInactiveSessionUiState({
            isSessionActive,
            isResumable,
            isMachineOnline: isMachineReachable,
            allowInputWhileInactive: persistedVoiceComposerRouting?.kind === 'adapter_text',
        });
    }, [isMachineReachable, isResumable, isSessionActive, persistedVoiceComposerRouting]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    const isFocusedRef = React.useRef(false);
    const viewingActivationIdRef = React.useRef<number | null>(null);
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Unread is driven by committed transcript `session.seq` only (pending queue does not affect unread).
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);

    const markSessionViewed = React.useCallback((opts?: { sessionSeq?: number; activationId?: number | null }) => {
        const sessionSeq = opts?.sessionSeq ?? storage.getState().sessions[sessionId]?.seq ?? 0;
        const activationId = opts?.activationId ?? viewingActivationIdRef.current;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId,
            sessionSeq,
            activationId,
        })) {
            return;
        }
        fireAndForget(
            sync.markSessionViewed(
                sessionId,
                opts?.sessionSeq === undefined ? undefined : { sessionSeq: opts.sessionSeq },
            ).then(() => {
                clearManualUnreadHold({ sessionId, activationId });
            }),
            { tag: 'SessionView.markSessionViewed' },
        );
    }, [sessionId]);

    useFocusEffect(React.useCallback(() => {
        isFocusedRef.current = true;
        const activationId = beginSessionViewingActivation(sessionId);
        viewingActivationIdRef.current = activationId;
        setActiveViewingSessionId(sessionId, activationId);
        {
            const current = storage.getState().sessions[sessionId];
            lastMarkedRef.current = {
                sessionSeq: current?.seq ?? 0,
            };
        }
        const cancelMarkViewed = runAfterInteractionsWithFallback(markSessionViewed);
        return () => {
            isFocusedRef.current = false;
            const sessionSeqAtBlur = storage.getState().sessions[sessionId]?.seq ?? 0;
            cancelMarkViewed();
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
            const blurActivationId = viewingActivationIdRef.current;
            clearActiveViewingSessionId(sessionId, blurActivationId);
            if (!shouldSuppressAutomaticMarkViewed({ sessionId, sessionSeq: sessionSeqAtBlur, activationId: blurActivationId })) {
                runAfterInteractionsWithFallback(() => {
                    markSessionViewed({ sessionSeq: sessionSeqAtBlur, activationId: blurActivationId });
                });
            }
            if (blurActivationId !== null) {
                endSessionViewingActivation(sessionId, blurActivationId);
            }
            viewingActivationIdRef.current = null;
        };
    }, [markSessionViewed, sessionId]));

    React.useEffect(() => {
        if (!isFocusedRef.current) return;

        const sessionSeq = session.seq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId,
            sessionSeq,
            activationId: viewingActivationIdRef.current,
        })) {
            return;
        }

        lastMarkedRef.current = { sessionSeq };
        if (markViewedTimeoutRef.current) clearTimeout(markViewedTimeoutRef.current);
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            markSessionViewed();
        }, 250);
        return () => {
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
        };
    }, [markSessionViewed, session.seq]);

    React.useEffect(() => {
        return runAfterInteractionsWithFallback(() => {
            fireAndForget(sync.fetchPendingMessages(sessionId), { tag: 'SessionView.fetchPendingMessages' });
        });
    }, [sessionId, session.pendingVersion]);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [acknowledgedCliVersions, applyLocalSettings, cliVersion, machineId]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        fireAndForget(applyPermissionModeSelection({
            sessionId,
            mode,
            applyTiming: settings.sessionPermissionModeApplyTiming === 'next_prompt' ? 'next_prompt' : 'immediate',
            updateSessionPermissionMode: (sid, nextMode) => storage.getState().updateSessionPermissionMode(sid, nextMode),
            getSessionPermissionModeUpdatedAt: (sid) => storage.getState().sessions[sid]?.permissionModeUpdatedAt ?? null,
            publishSessionPermissionModeToMetadata: (payload) => sync.publishSessionPermissionModeToMetadata(payload),
        }), { tag: 'SessionView.updatePermissionMode' });
    }, [sessionId, settings.sessionPermissionModeApplyTiming]);

    const updateAcpSessionModeOverride = React.useCallback((modeId: string) => {
        const normalized = typeof modeId === 'string' ? modeId.trim() : '';
        const publishModeId =
            normalized === 'default' && !sessionModeOptionIds.includes('default')
                ? ''
                : normalized;
        fireAndForget(sync.publishSessionAcpSessionModeOverrideToMetadata({
            sessionId,
            modeId: publishModeId,
            updatedAt: nowServerMs(),
        }), { tag: 'SessionView.updateAcpSessionModeOverride' });
    }, [sessionId, sessionModeOptionIds]);

    const updateAcpConfigOptionOverride = React.useCallback((configId: string, valueId: string) => {
        const updatedAt = nowServerMs();
        setOptimisticAcpConfigOptionOverrides((current) => {
            const baseMetadata = (current
                ? {
                    ...(session.metadata ?? {}),
                    acpConfigOptionOverridesV1: current,
                    sessionConfigOptionOverridesV1: current,
                }
                : (session.metadata ?? {})) as Metadata;
            const nextMetadata = computeNextAcpConfigOptionOverrideMetadata({
                metadata: baseMetadata,
                configId,
                value: valueId,
                updatedAt,
            });
            return (nextMetadata.acpConfigOptionOverridesV1 ?? nextMetadata.sessionConfigOptionOverridesV1 ?? null) as React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride'];
        });
        fireAndForget(sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId,
            configId,
            value: valueId,
            updatedAt,
        }), { tag: 'SessionView.updateAcpConfigOptionOverride' });
    }, [session.metadata, sessionId]);
    const buildNextMessageMetaOverrides = React.useCallback((metaOverrides?: Record<string, unknown>) => {
        return buildSessionComposerNextMessageMetaOverridesFromUiState({
            agentId: liveComposerState.agentId,
            configOptionOverrides: optimisticAcpConfigOptionOverrides,
            metaOverrides,
        });
    }, [liveComposerState.agentId, optimisticAcpConfigOptionOverrides]);

    // Function to update model mode (only for agents that expose model selection in the UI)
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (!isModelSelectableForSession(agentId, session.metadata ?? null, mode)) return;
        storage.getState().updateSessionModelMode(sessionId, mode);
        fireAndForget(sync.publishSessionModelOverrideToMetadata({
            sessionId,
            modelId: mode,
            updatedAt: nowServerMs(),
        }), { tag: 'SessionView.updateModelMode' });
    }, [agentId, sessionId, session.metadata]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
        const silent = opts?.silent === true;
        const resumeMachineId = reachableMachineTarget?.machineId ?? session.metadata?.machineId ?? null;
        const resumeDirectory = reachableMachineTarget?.basePath ?? session.metadata?.path ?? null;

        const maybeAlert = (message: string) => {
            if (silent) return;
            Modal.alert(t('common.error'), message);
        };

        if (!resumeMachineId || !resumeDirectory || !session.metadata?.flavor) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (!canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)) {
            if (silent) return false;

            const replayCfg = resolveHappierReplayConfig(settings);
            if (replayCfg.enabled) {
                if (!isMachineReachable) {
                    maybeAlert(t('session.machineOfflineCannotResume'));
                    return false;
                }

                const wantsReplay = await Modal.confirm(
                    t('session.resumeFailed'),
                    t('settingsSession.replayResume.footer'),
                    { confirmText: t('common.continue') },
                );
                if (wantsReplay) {
                    try {
                        const permissionOverride = getPermissionModeOverrideForSpawn(session);
                        const modelOverride = getModelOverrideForSpawn(session);
                        const summaryRunner =
                            executionRunsEnabled && replayCfg.strategy === 'summary_plus_recent'
                                ? (settings.sessionReplaySummaryRunnerV1 ?? null)
                                : null;
                        const spawnResult: any = await continueSessionWithReplay({
                            machineId: resumeMachineId,
                            serverId: capabilityServerId,
                            directory: resumeDirectory,
                            approvedNewDirectoryCreation: true,
                            agent: agentId,
                            ...(permissionOverride ? permissionOverride : {}),
                            ...(modelOverride ? modelOverride : {}),
                            replay: {
                                previousSessionId: sessionId,
                                strategy: replayCfg.strategy,
                                recentMessagesCount: replayCfg.recentMessagesCount,
                                maxSeedChars: replayCfg.maxSeedChars,
                                ...(summaryRunner ? { summaryRunner } : {}),
                            },
                        });
                        if (spawnResult.type !== 'success' || !spawnResult.sessionId) {
                            maybeAlert(t('session.resumeFailed'));
                            return false;
                        }

                        await sync.refreshSessions();
                        router.push(buildSessionHref(spawnResult.sessionId) as any);
                        return true;
                    } catch (e) {
                        maybeAlert(e instanceof Error ? e.message : t('session.resumeFailed'));
                        return false;
                    }
                }
            }

            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (!isMachineReachable) {
            maybeAlert(t('session.machineOfflineCannotResume'));
            return false;
        }

        setIsResuming(true);
        try {
            const permissionOverride = getPermissionModeOverrideForSpawn(session);
            const modelOverride = getModelOverrideForSpawn(session);
            const resumeTarget = reachableMachineTarget;
            const base = buildResumeSessionBaseOptionsFromSession({
                sessionId,
                session,
                resumeCapabilityOptions,
                resumeTargetOverride: resumeTarget
                    ? {
                        machineId: resumeTarget.machineId,
                        directory: resumeTarget.basePath,
                    }
                    : null,
                permissionOverride,
                modelOverride,
            });
            if (!base) {
                Modal.alert(t('common.error'), t('session.resumeFailed'));
                return false;
            }

            fireAndForget(
                ensureAgentInstallablesBackground({
                    agentId,
                    machineId: base.machineId,
                    serverId: capabilityServerId,
                    settings,
                    resumeSessionId: base.resume ?? null,
                }),
                { tag: `SessionView.installables.ensure.${agentId}` },
            );

            const result = await resumeSession({
                ...base,
                serverId: capabilityServerId,
                ...buildResumeSessionExtrasFromUiState({
                    agentId,
                    settings,
                    session,
                }),
            });

            if (result.type === 'error') {
                maybeAlert(result.errorMessage);
                return false;
            }
            // On success, the session will become active and UI will update automatically
            return true;
        } catch (error) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        } finally {
            setIsResuming(false);
        }
    }, [agentId, capabilityServerId, executionRunsEnabled, isMachineReachable, reachableMachineTarget, resumeCapabilityOptions, router, session, sessionId, settings]);

    useSessionResumeRequestListener(React.useCallback((requestedSessionId) => {
        if (requestedSessionId !== sessionId) return;
        void handleResumeSession();
    }, [handleResumeSession, sessionId]));

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        try {
            await voiceSessionManager.toggle(sessionId);
            tracking?.capture('voice_session_toggled', { sessionId, providerId: voiceProviderId });
        } catch (error) {
            Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
            tracking?.capture('voice_session_error', {
                sessionId,
                providerId: voiceProviderId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }, [sessionId, voiceProviderId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(
        () => ({
            onMicPress:
                voiceProviderId !== 'off' || voiceSnap.status !== 'disconnected'
                    ? handleMicrophonePress
                    : undefined,
            isMicActive: voiceSnap.status !== 'disconnected',
        }),
        [handleMicrophonePress, voiceProviderId, voiceSnap.status],
    );

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);
    }, [sessionId]);

    const showInactiveNotResumableNotice = inactiveUi.noticeKind === 'not-resumable';
    const showMachineOfflineNotice = inactiveUi.noticeKind === 'machine-offline';
    const providerName = getAgentCore(agentId).uiConnectedService.label ?? t('status.unknown');
    const machineName = session.metadata?.host ?? t('status.unknown');

    const bottomNotice = React.useMemo(() => {
        if (showInactiveNotResumableNotice) {
            return {
                title: t('session.inactiveNotResumableNoticeTitle'),
                body: t('session.inactiveNotResumableNoticeBody', { provider: providerName }),
            };
        }
        if (showMachineOfflineNotice) {
            return {
                title: t('session.machineOfflineNoticeTitle'),
                body: t('session.machineOfflineNoticeBody', { machine: machineName }),
            };
        }
        return null;
    }, [machineName, providerName, showInactiveNotResumableNotice, showMachineOfflineNotice]);

    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const isReadOnly = session.accessLevel === 'view';
    const transcriptInteraction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: session.accessLevel,
            canApprovePermissions: session.canApprovePermissions,
            active: session.active,
            presence: session.presence,
        });
    }, [session.accessLevel, session.active, session.canApprovePermissions, session.presence]);

    const [pendingQueueResumeFailed, setPendingQueueResumeFailed] = React.useState(false);
    React.useEffect(() => {
        if (!pendingQueueResumeFailed) return;
        if (!isSessionActive) return;
        setPendingQueueResumeFailed(false);
    }, [isSessionActive, pendingQueueResumeFailed]);

    const isLocallyAttached = !isHiddenSystemSessionSession && isSessionLocallyAttached(session);
    const cliAvailability = useCLIDetection(machineId ?? null, {
        autoDetect: isLocallyAttached,
        includeLoginStatus: isLocallyAttached,
        agentIds: [agentId],
        serverId: capabilityServerId,
    });
    const cliAuthStatus = cliAvailability.authStatus[agentId] ?? null;
    const canRequestRemoteControl = shouldRequestRemoteControl(session, cliAuthStatus?.state ?? null);
    const [controlSwitchTo, setControlSwitchTo] = React.useState<'remote' | null>(null);
    const controlSwitchAttemptIdRef = React.useRef(0);
    React.useEffect(() => {
        if (controlSwitchTo === 'remote' && !isLocallyAttached) {
            setControlSwitchTo(null);
            return;
        }
    }, [controlSwitchTo, isLocallyAttached]);

    React.useEffect(() => {
        if (!controlSwitchTo) return;
        const attemptId = controlSwitchAttemptIdRef.current;
        const timeoutMs = readControlSwitchUiTimeoutMsFromEnv();
        if (timeoutMs <= 0) return;
        const timeoutId = setTimeout(() => {
            if (controlSwitchAttemptIdRef.current !== attemptId) return;
            setControlSwitchTo(null);
            controlSwitchAttemptIdRef.current = 0;
            Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
        }, timeoutMs);
        return () => clearTimeout(timeoutId);
    }, [controlSwitchTo]);

    const finishControlSwitchAttempt = React.useCallback((attemptId: number): boolean => {
        if (controlSwitchAttemptIdRef.current !== attemptId) return false;
        controlSwitchAttemptIdRef.current = 0;
        setControlSwitchTo(null);
        return true;
    }, []);

    const handleRequestSwitchToRemote = React.useCallback(() => {
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        const attemptId = controlSwitchAttemptIdRef.current + 1;
        controlSwitchAttemptIdRef.current = attemptId;
        setControlSwitchTo('remote');
        fireAndForget((async () => {
            try {
                const ok = await sessionSwitch(sessionId, 'remote');
                if (ok !== true) {
                    if (!finishControlSwitchAttempt(attemptId)) return;
                    Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
                    return;
                }
                finishControlSwitchAttempt(attemptId);
            } catch {
                if (!finishControlSwitchAttempt(attemptId)) return;
                Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
            }
        })(), { tag: 'SessionView.requestSwitchToRemote' });
    }, [finishControlSwitchAttempt, hasWriteAccess, sessionId]);
    const directSessionTakeover = useDirectSessionTakeover({
        sessionId,
        hasWriteAccess,
        directSessionRuntime,
    });

    const directControlFooter = React.useMemo(() => {
        if (isHiddenSystemSessionSession) return null;
        if (!directSessionLink) return null;
        const status = directSessionRuntime.status;
        return {
            machineOnline: status?.machineOnline ?? true,
            runnerActive: status?.runnerActive ?? false,
            activity: status?.activity ?? 'unknown',
            canTakeOverDirect: status?.canTakeOverDirect ?? false,
            canTakeOverPersist: status?.canTakeOverPersist ?? false,
            takeoverInFlight: directSessionTakeover.takeoverInFlight,
            onRequestTakeOverDirect: (status?.canTakeOverDirect ?? false)
                ? () => { void directSessionTakeover.requestTakeover('direct'); }
                : undefined,
            onRequestTakeOverPersist: (status?.canTakeOverPersist ?? false)
                ? () => { void directSessionTakeover.requestTakeover('persisted'); }
                : undefined,
        } as const;
    }, [directSessionLink, directSessionRuntime.status, directSessionTakeover, isHiddenSystemSessionSession]);

    const shouldRenderChatTimeline = React.useMemo(() => {
        if (isEncryptedSessionLocked) return false;
        return shouldRenderChatTimelineForSession({
            committedMessagesCount: committedMessageIds.length,
            pendingMessagesCount: pendingMessages.length,
            controlledByUser: isLocallyAttached,
            // Some sessions can have a non-zero committed transcript seq but end up with 0 visible
            // main-timeline messages (e.g. newest page is sidechain-only). In that case, we must
            // still render the transcript so it can page backwards to find visible messages.
            forceRenderFooter: isForkedSessionV1 || (isLoaded === true && (session.seq ?? 0) > 0 && committedMessageIds.length === 0),
        });
    }, [committedMessageIds.length, isEncryptedSessionLocked, isForkedSessionV1, isLoaded, isLocallyAttached, pendingMessages.length, session.seq]);

    React.useEffect(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        const state = openToTranscriptTelemetryRef.current;
        if (!state || state.recorded || state.sessionId !== sessionId) return;
        if (!session || isLoaded !== true) return;

        const transcript = shouldRenderChatTimeline ? 1 : 0;
        const empty = !shouldRenderChatTimeline && !isEncryptedSessionLocked ? 1 : 0;
        if (transcript !== 1 && empty !== 1) return;

        state.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.openToTranscript',
            readSessionUiTelemetryNowMs() - state.startedAtMs,
            {
                committedMessages: committedMessageIds.length,
                empty,
                pendingMessages: pendingMessages.length,
                sessionSeq: Math.max(0, Math.trunc(session.seq ?? 0)),
                transcript,
            },
        );
    }, [
        committedMessageIds.length,
        isEncryptedSessionLocked,
        isLoaded,
        pendingMessages.length,
        session,
        sessionId,
        shouldRenderChatTimeline,
    ]);

      let content = (
          <>
              <Deferred>
                  {shouldRenderChatTimeline && (
                      <ChatList
                          session={session}
                          bottomNotice={bottomNotice}
                          controlledByUserOverride={isLocallyAttached}
                          controlSwitchTo={controlSwitchTo}
                          onRequestSwitchToRemote={isHiddenSystemSessionSession || !canRequestRemoteControl ? undefined : handleRequestSwitchToRemote}
                          directControlFooter={directControlFooter}
                          jumpToSeq={jumpToSeq}
                          onViewportChange={(state) => {
                              sync.onSessionViewportChange(sessionId, state);
                          }}
                      />
                  )}
              </Deferred>
          </>
      );
    const placeholder = !shouldRenderChatTimeline ? (
        <>
            {isEncryptedSessionLocked ? (
                <View
                    testID="session-encrypted-locked"
                    style={{
                        flex: 1,
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 24,
                    }}
                >
                    <View
                        style={{
                            width: '100%',
                            maxWidth: 520,
                            gap: 10,
                        }}
                    >
                        <Text style={{ fontSize: 18, color: theme.colors.text }}>
                            {t('navigation.restoreWithSecretKey')}
                        </Text>
                        <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
                            {t('connect.restoreWithSecretKeyDescription')}
                        </Text>
                        <Pressable
                            testID="session-encrypted-locked-restore"
                            onPress={() => router.push('/restore/manual')}
                            style={({ pressed }) => ({
                                alignSelf: 'flex-start',
                                paddingVertical: 12,
                                paddingHorizontal: 14,
                                borderRadius: 12,
                                backgroundColor: theme.colors.surfaceHigh,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                opacity: pressed ? 0.7 : 1,
                            })}
                        >
                            <Text style={{ fontSize: 14, color: theme.colors.text }}>
                                {t('connect.restoreWithSecretKeyInstead')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ) : isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = inactiveUi.inactiveStatusTextKey ? t(inactiveUi.inactiveStatusTextKey) : null;

      const shouldShowInput = inactiveUi.shouldShowInput && !isEncryptedSessionLocked;
        const extraActionChips = useSessionAgentInputExtraActionChips({
            sessionId,
            attachmentsUploadsEnabled,
            isReadOnly,
            isUploadingAttachments,
            onPickAttachmentFile: () => {
                openAttachmentFilePickerFiles(filePickerRef.current);
            },
            onPickAttachmentImage: () => {
                openAttachmentFilePickerImages(filePickerRef.current);
            },
            onAppendLinkedPath: (path) => {
                setMessage((prev) => {
                    const base = prev ?? '';
                    const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
                    return `${base}${spacer}@${path} `;
                });
            },
            reviewCommentsEnabled,
            reviewScope,
            reviewCommentDrafts,
            defaultBackendTarget: sessionActionDefaultBackend?.backendTarget ?? null,
            defaultBackendId: sessionActionDefaultBackend?.defaultBackendId ?? null,
            instructionsText: message,
        });
        const routingControls = useSessionAgentInputRoutingControls({
            isReadOnly,
            participantTargets,
            recipientState,
        });
        const agentInputExtraActionChips = React.useMemo(() => {
            const chips = [...(extraActionChips ?? []), ...(routingControls.extraActionChips ?? [])];
            return chips.length > 0 ? chips : undefined;
        }, [extraActionChips, routingControls.extraActionChips]);

    const openFileViewer = React.useCallback(() => {
        const layoutIfOpened = resolvePaneLayout({
            containerWidthPx: windowWidth,
            deviceType: multiPaneDeviceType,
            multiPaneEnabled,
            rightOpen: true,
            detailsOpen: false,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        });

        if (layoutIfOpened.kind === 'single') {
            const href = buildCurrentSessionHref('/files');
            prepareMobileSurfaceTransition({
                currentPathname: pathname,
                targetHref: href,
                operation: 'push',
            });
            router.push(href as never);
            return;
        }

        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [buildCurrentSessionHref, multiPaneDeviceType, multiPaneEnabled, pane, pathname, router, windowWidth]);

    const input = shouldShowInput ? (
        <View>
            {voiceEnabled && voiceProviderId !== 'off' && !isHiddenSystemSessionSession ? <VoiceSurface variant="session" sessionId={sessionId} /> : null}
            {authSurfaceState ? (
                <View style={{ marginTop: 8, marginHorizontal: 8 }}>
                    <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                </View>
            ) : null}
            {pendingQueueResumeFailed ? (
                <View
                    testID="session-pendingQueue-resumeFailed"
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        backgroundColor: theme.colors.box.warning.background,
                        borderWidth: 1,
                        borderColor: theme.colors.box.warning.border,
                        borderRadius: 10,
                        marginTop: 8,
                        marginHorizontal: 8,
                        gap: 8,
                    }}
                >
                    <Ionicons name="warning-outline" size={16} color={theme.colors.box.warning.text} />
                    <View style={{ flexBasis: 0, flexGrow: 1 }}>
                        <Text style={{ fontSize: 13, color: theme.colors.box.warning.text, fontWeight: '700' }}>
                            {t('session.pendingQueuedResumeFailedTitle')}
                        </Text>
                        <Text style={{ fontSize: 12, color: theme.colors.box.warning.text, lineHeight: 16 }}>
                            {t('session.pendingQueuedResumeFailedBody')}
                        </Text>
                    </View>
                    <Pressable
                        testID="session-pendingQueue-resumeFailed-retry"
                        accessibilityLabel={t('common.retry')}
                        disabled={isResuming}
                        onPress={async () => {
                            const ok = await handleResumeSession({ silent: false });
                            if (ok) {
                                setPendingQueueResumeFailed(false);
                            }
                        }}
                        style={({ pressed }) => ({
                            flexShrink: 0,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            backgroundColor: theme.colors.box.warning.text,
                            opacity: pressed || isResuming ? 0.7 : 1,
                        })}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.box.warning.background, fontWeight: '700' }}>
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
            <AgentInput
                placeholder={isReadOnly ? t('session.sharing.viewOnlyMode') : t('session.inputPlaceholder')}
                value={message}
                onChangeText={setMessage}
                sessionId={sessionId}
                agentType={liveComposerState.agentId}
                attachments={attachmentsUploadsEnabled ? agentInputAttachments : undefined}
                onAttachmentsAdded={attachmentsUploadsEnabled ? addAttachments : undefined}
                hasSendableAttachments={hasIncludedReviewCommentDrafts || (attachmentsUploadsEnabled && attachmentDrafts.length > 0)}
                permissionRequests={listPendingPermissionRequests(session)}
                userActionRequests={listPendingUserActionRequests(session)}
                canApprovePermissions={transcriptInteraction.canApprovePermissions}
                permissionDisabledReason={transcriptInteraction.permissionDisabledReason}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                onAcpSessionModeChange={supportsSessionModeOverrides(liveComposerState.agentId) ? updateAcpSessionModeOverride : undefined}
                onAcpConfigOptionChange={updateAcpConfigOptionOverride}
                acpConfigOptionOverridesOverride={optimisticAcpConfigOptionOverrides}
                modelMode={modelMode}
                onModelModeChange={updateModelMode}
                metadata={session.metadata}
                profileId={liveComposerState.profileId ?? undefined}
                onProfileClick={liveComposerState.profileId !== null ? () => {
                    const profileId = liveComposerState.profileId;
                    const profileInfo = (profileId === null || (typeof profileId === 'string' && profileId.trim() === ''))
                        ? t('profiles.noProfile')
                        : (typeof profileId === 'string' ? profileId : t('status.unknown'));
                    Modal.alert(
                        t('profiles.title'),
                        `${t('profiles.sessionUses', { profile: profileInfo })}\n\n${t('profiles.profilesFixedPerSession')}`,
                    );
                } : undefined}
                connectionStatus={{
                    text: isResuming ? t('session.resuming') : (inactiveStatusText || sessionStatus.statusText),
                    color: sessionStatus.statusColor,
                    dotColor: sessionStatus.statusDotColor,
                    isPulsing: isResuming || sessionStatus.isPulsing
                }}
                onSend={() => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }

                    const sendComposerText = (messageToSend: string, composerTextBeforeSend: string) => {
                        const configuredMode = storage.getState().settings.sessionMessageSendMode;
                        const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
                        const submitMode = chooseSubmitMode({ configuredMode, busySteerSendPolicy, session });

                        const additionalMessage = messageToSend;
                        const trimmedText = messageToSend.trim();
                        const shouldSendReviewComments = hasIncludedReviewCommentDrafts;
                        const hasAttachments = attachmentsUploadsEnabled && attachmentDrafts.length > 0;
                        const participantRecipient = recipientState.recipient;

                        if (participantRecipient && (shouldSendReviewComments || hasAttachments)) {
                            Modal.alert(t('common.error'), t('session.participants.unsupportedAttachmentsOrReviewComments'));
                            return;
                        }

                        if (hasAttachments && !isSessionActive && !isResumable) {
                            Modal.alert(t('common.error'), t('session.inactiveNotResumableNoticeTitle'));
                            return;
                        }

                        const outboundBase = shouldSendReviewComments
                            ? { kind: 'review_comments' as const }
                            : { kind: 'plain' as const };

                        if (outboundBase.kind === 'plain' && trimmedText.length === 0 && !hasAttachments) {
                            return;
                        }

                        const previousMessage = composerTextBeforeSend;
                        const markComposerSent = () => {
                            setMessage('');
                            clearDraft();
                            trackMessageSent();
                        };

                        if (hasAttachments) {
                            fireAndForget((async () => {
                                markComposerSent();
                                try {
                                    const readyForSend = await directSessionTakeover.ensureReadyForSend();
                                    if (!readyForSend) {
                                        setMessage(previousMessage);
                                        return;
                                    }
                                    setIsUploadingAttachments(true);

                                    if (!isSessionActive && isResumable) {
                                        const resumed = await handleResumeSession();
                                        if (!resumed) {
                                            throw new Error(t('session.resumeFailed'));
                                        }
                                    }

                                    const { uploaded } = await uploadAttachmentDraftsToSession({
                                        sessionId,
                                        drafts: attachmentDrafts,
                                        config: attachmentsUploadConfig,
                                        applyDraftPatch: attachmentDraftManager.applyDraftPatch,
                                    });
                                    const attachmentsBlock = formatAttachmentsBlock(uploaded);
                                    const attachmentsMetaOverrides = {
                                        happier: {
                                            kind: 'attachments.v1',
                                            payload: {
                                                attachments: uploaded.map((a) => ({
                                                    name: a.name,
                                                    path: a.path,
                                                    mimeType: a.mimeType,
                                                    sizeBytes: a.sizeBytes,
                                                    sha256: a.sha256,
                                                })),
                                            },
                                        },
                                    } as Record<string, unknown>;

                                    const outbound: {
                                        text: string;
                                        displayText?: string;
                                        metaOverrides?: Record<string, unknown>;
                                    } = shouldSendReviewComments
                                        ? buildReviewCommentsOutboundMessage({
                                            sessionId,
                                            drafts: includedReviewCommentDrafts,
                                            additionalMessage: trimmedText.length > 0
                                                ? `${additionalMessage}\n\n${attachmentsBlock}`
                                                : attachmentsBlock,
                                            displayTextSuffix: attachmentsBlock,
                                            metaOverrides: attachmentsMetaOverrides,
                                        })
                                        : {
                                            text: trimmedText.length > 0 ? `${trimmedText}\n\n${attachmentsBlock}` : attachmentsBlock,
                                            displayText: trimmedText,
                                            metaOverrides: attachmentsMetaOverrides,
                                        };
                                    outbound.metaOverrides = buildNextMessageMetaOverrides(outbound.metaOverrides);

                                    if (submitMode === 'interrupt') {
                                        try { await sessionAbort(sessionId); } catch { }
                                    }
                                    await sync.sendMessage(sessionId, outbound.text, outbound.displayText, outbound.metaOverrides);
                                    if (shouldSendReviewComments) {
                                        clearSentReviewCommentDrafts();
                                    }
                                    attachmentDraftManager.clearDrafts();
                                } catch (e) {
                                    setMessage(previousMessage);
                                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                                } finally {
                                    setIsUploadingAttachments(false);
                                }
                            })(), { tag: 'SessionView.sendMessage.attachments' });
                            return;
                        }

                        const outbound: {
                            text: string;
                            displayText?: string;
                            metaOverrides?: Record<string, unknown>;
                        } | null = shouldSendReviewComments
                        ? buildReviewCommentsOutboundMessage({
                                sessionId,
                                drafts: includedReviewCommentDrafts,
                                additionalMessage,
                            })
                          : (trimmedText.length > 0
                              ? { text: trimmedText, displayText: undefined, metaOverrides: undefined }
                              : null);

                        if (!outbound) return;

                        const voiceComposerRouting =
                            outboundBase.kind === 'plain' && !participantRecipient
                                ? resolveVoiceSessionComposerRouting({
                                    conversationSessionId: sessionId,
                                    sessionMetadata: session.metadata,
                                })
                                : null;

                        if (voiceComposerRouting?.kind === 'adapter_text') {
                            fireAndForget((async () => {
                                const voiceSend = await sendVoiceSessionComposerText({
                                    conversationSessionId: sessionId,
                                    text: outbound.text,
                                    sessionMetadata: session.metadata,
                                    getAdapter: (adapterId) => getVoiceAdapterRegistry().get(adapterId),
                                });
                                if (!voiceSend.ok) {
                                    Modal.alert(
                                        t('common.error'),
                                        voiceSend.reason === 'send_failed' && voiceSend.message
                                            ? voiceSend.message
                                            : t('errors.voiceServiceUnavailable'),
                                    );
                                    return;
                                }
                                markComposerSent();
                                if (shouldSendReviewComments) {
                                    clearSentReviewCommentDrafts();
                                }
                            })(), { tag: 'SessionView.sendMessage.voiceConversation' });
                            return;
                        }

                        let executionRunSend:
                            | Readonly<{
                                runId: string;
                                message: string;
                                delivery: typeof recipientState.executionRunDelivery;
                            }>
                            | null = null;

                        if (outboundBase.kind === 'plain' && participantRecipient) {
                            const routed = resolveParticipantRoutedSend({
                                text: outbound.text,
                                recipient: participantRecipient,
                                executionRunDelivery: recipientState.executionRunDelivery,
                            });
                            if (routed.type === 'execution_run_send') {
                                executionRunSend = {
                                    runId: routed.runId,
                                    message: routed.message,
                                    delivery: routed.delivery,
                                };
                            } else {
                                outbound.text = routed.text;
                                outbound.displayText = routed.displayText;
                                outbound.metaOverrides = routed.metaOverrides;
                            }
                        }
                        outbound.metaOverrides = buildNextMessageMetaOverrides(outbound.metaOverrides);

                        if (executionRunSend) {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await directSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    setMessage(previousMessage);
                                    return;
                                }

                                const result = await sessionExecutionRunSend(sessionId, executionRunSend);
                                if (!result.ok) {
                                    if (isExecutionRunNotRunningSendError(result)) {
                                        recipientState.setManualRecipient(null);
                                    }
                                    setMessage(previousMessage);
                                    Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                                }
                            })(), { tag: 'SessionView.sendMessage.participantRouting.executionRun' });
                            return;
                        }

                        if (submitMode === 'server_pending') {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await directSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    setMessage(previousMessage);
                                    return;
                                }

                                try {
                                    await sync.enqueuePendingMessage(sessionId, outbound.text, outbound.displayText, outbound.metaOverrides);
                                } catch (e) {
                                    setMessage(previousMessage);
                                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                                    return;
                                }

                                if (shouldSendReviewComments) {
                                    clearSentReviewCommentDrafts();
                                }

                                const wakeOpts = getPendingQueueWakeResumeOptions({
                                    sessionId,
                                    session,
                                    resumeCapabilityOptions,
                                    resumeTargetOverride: reachableMachineTarget
                                        ? {
                                            machineId: reachableMachineTarget.machineId,
                                            directory: reachableMachineTarget.basePath,
                                        }
                                        : null,
                                    permissionOverride: getPermissionModeOverrideForSpawn(session),
                                    canWakeMachineId: (machineId) => Boolean(sync.encryption.getMachineEncryption(machineId)),
                                });
                                if (!wakeOpts) {
                                    if (!isSessionActive && isResumable) {
                                        setPendingQueueResumeFailed(true);
                                    }
                                    return;
                                }

                                try {
                                    const result = await resumeSession({
                                        ...wakeOpts,
                                        serverId: capabilityServerId,
                                    });
                                    if (result.type === 'error') {
                                        // Non-fatal: message is already persisted in the pending queue.
                                        if (!isSessionActive && isResumable) {
                                            setPendingQueueResumeFailed(true);
                                        }
                                    }
                                } catch {
                                    // Non-fatal: message is already persisted in the pending queue.
                                    if (!isSessionActive && isResumable) {
                                        setPendingQueueResumeFailed(true);
                                    }
                                }

                                if (shouldRequestRemoteControlAfterPendingEnqueue(session, cliAuthStatus?.state ?? null)) {
                                    try {
                                        await sessionSwitch(sessionId, 'remote');
                                    } catch {
                                        // Non-fatal: the message is already persisted in the pending queue.
                                    }
                                }
                            })(), { tag: 'SessionView.sendMessage.serverPending' });
                            return;
                        }

                        if (!isSessionActive && isResumable) {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await directSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    setMessage(previousMessage);
                                    return;
                                }

                                try {
                                    const supportsPendingQueueV2 = typeof session.pendingVersion === 'number';
                                    if (supportsPendingQueueV2) {
                                        await sync.enqueuePendingMessage(sessionId, outbound.text, outbound.displayText, outbound.metaOverrides);
                                        if (shouldSendReviewComments) {
                                            clearSentReviewCommentDrafts();
                                        }
                                        const resumed = await handleResumeSession({ silent: true });
                                        if (!resumed) {
                                            setPendingQueueResumeFailed(true);
                                        }
                                        return;
                                    }

                                    const resumed = await handleResumeSession();
                                    if (!resumed) {
                                        setMessage(previousMessage);
                                        return;
                                    }
                                    await sync.submitMessage(sessionId, outbound.text, outbound.displayText, outbound.metaOverrides);
                                    if (shouldSendReviewComments) {
                                        clearSentReviewCommentDrafts();
                                    }
                                } catch (e) {
                                    setMessage(previousMessage);
                                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToResumeSession'));
                                }
                            })(), { tag: 'SessionView.sendMessage.resumeInactive' });
                            return;
                        }

                        fireAndForget((async () => {
                            markComposerSent();
                            const readyForSend = await directSessionTakeover.ensureReadyForSend();
                            if (!readyForSend) {
                                setMessage(previousMessage);
                                return;
                            }

                            try {
                                await sync.submitMessage(sessionId, outbound.text, outbound.displayText, outbound.metaOverrides);
                                if (shouldSendReviewComments) {
                                    clearSentReviewCommentDrafts();
                                }
                            } catch (e) {
                                setMessage(previousMessage);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                            }
                        })(), { tag: 'SessionView.sendMessage.submitMessage' });
                    };

                    const promptInvocationsV1 = storage.getState().settings.promptInvocationsV1;
                    const resolved = resolveSessionComposerSend({ input: message, executionRunsEnabled, promptInvocationsV1 });
                    if (resolved.kind === 'noop') {
                        return;
                    }

                    if (resolved.kind === 'template') {
                        const composerTextBeforeSend = message;
                        fireAndForget((async () => {
                            try {
                                const expanded = await expandPromptTemplateInvocation({
                                    targetArtifactId: resolved.targetArtifactId,
                                    argsText: resolved.rest,
                                });

                                if (resolved.behavior === 'insert') {
                                    setMessage(expanded);
                                    return;
                                }

                                sendComposerText(expanded, composerTextBeforeSend);
                            } catch (e) {
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                            }
                        })(), { tag: 'SessionView.sendMessage.template' });
                        return;
                    }

                    if (
                        resolved.kind === 'action' &&
                        (
                            resolved.actionId === 'ui.voice_global.reset' ||
                            resolved.actionId === 'ui.pet.choose' ||
                            resolved.actionId === 'execution.run.list' ||
                            resolved.actionId === 'review.start' ||
                            resolved.actionId === 'subagents.plan.start' ||
                            resolved.actionId === 'subagents.delegate.start'
                        )
                    ) {
                        const previousMessage = message;
                        void executeSessionComposerResolution({
                            resolved,
                            sessionId,
                            agentId,
                            backendTarget: sessionActionDefaultBackend?.backendTarget ?? null,
                            permissionMode,
                            actionExecutor,
                            previousMessage,
                            setMessage,
                            clearDraft,
                            trackMessageSent,
                            navigateToRuns: () => router.push(buildCurrentSessionHref('/runs') as any),
                            navigateToPetSettings: () => router.push('/settings/pets' as any),
                            modalAlert: (_title, msg) => Modal.alert(t('common.error'), msg),
                        });
                        return;
                    }

                    if (resolved.kind !== 'send') return;
                    sendComposerText(resolved.text, message);
                }}
                isSendDisabled={!shouldShowInput || isResuming || isReadOnly || isUploadingAttachments}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                onAbort={() => sessionAbort(sessionId)}
                showAbortButton={shouldShowAbortButtonForSessionState(sessionStatus.state)}
                onFileViewerPress={openFileViewer}
                // Autocomplete configuration
                autocompletePrefixes={['@', '/']}
                autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
                disabled={isReadOnly}
                usageData={sessionUsage ? {
                    inputTokens: sessionUsage.inputTokens,
                    outputTokens: sessionUsage.outputTokens,
                    cacheCreation: sessionUsage.cacheCreation,
                    cacheRead: sessionUsage.cacheRead,
                    contextSize: sessionUsage.contextSize,
                    ...(typeof sessionUsage.contextWindowTokens === 'number'
                        ? { contextWindowTokens: sessionUsage.contextWindowTokens }
                        : {}),
                } : session.latestUsage ? {
                    inputTokens: session.latestUsage.inputTokens,
                    outputTokens: session.latestUsage.outputTokens,
                    cacheCreation: session.latestUsage.cacheCreation,
                    cacheRead: session.latestUsage.cacheRead,
                    contextSize: session.latestUsage.contextSize,
                    ...(typeof session.latestUsage.contextWindowTokens === 'number'
                        ? { contextWindowTokens: session.latestUsage.contextWindowTokens }
                        : {}),
                } : undefined}
                alwaysShowContextSize={alwaysShowContextSize}
                extraActionChips={agentInputExtraActionChips}
            />
            {attachmentsUploadsEnabled ? (
                <AttachmentFilePicker
                    ref={filePickerRef}
                    onAttachmentsPicked={addPickedAttachments}
                    multiple
                />
            ) : null}
        </View>
    ) : null;

    const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.trunc(event.nativeEvent.layout.width);
        if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
        setMeasuredContentWidth((currentWidth) => (
            currentWidth === nextWidth ? currentWidth : nextWidth
        ));
    }, []);
    const contentPaddingBottom = resolveSessionViewContentBottomSpacing({
        chatBottomSpacing,
        safeAreaBottomPx: safeArea.bottom,
        availableWidthPx: resolveSessionViewAvailableWidth({
            measuredContentWidthPx: measuredContentWidth,
            windowWidthPx: windowWidth,
        }),
        contentMaxWidthPx: layout.maxWidth,
        defaultContentBottomGapPx: (isRunningOnMac() || Platform.OS === 'web')
            ? SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX
            : 0,
        inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    });

    const main = (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: theme.colors.box.warning.background,
                        borderWidth: 1,
                        borderColor: theme.colors.box.warning.border,
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color={theme.colors.box.warning.text} style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.box.warning.text,
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color={theme.colors.box.warning.text} style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View
                onLayout={handleContentLayout}
                style={{
                    flexBasis: 0,
                    flexGrow: 1,
                    paddingBottom: contentPaddingBottom,
                }}
            >
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={onBackPress}
                        testID="session-view-landscape-back-button"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            zIndex: 1000,
                            width: 44,
	                            height: 44,
	                            borderRadius: 22,
	                            backgroundColor: Color(theme.colors.header.background).alpha(0.9).rgb().string(),
	                            alignItems: 'center',
	                            justifyContent: 'center',
	                            ...shadowLevelStyle(theme.colors.shadowLevels[4]),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.text}
                        />
                    </Pressable>
                )
            }
        </>
    );

    return (
        <SessionResumeProvider onResumeSession={handleResumeSession}>
            <AppPaneScopeHost
                scopeId={paneScopeId}
                // Keep the real session tree mounted; the pane host is responsible for hiding
                // the main region in pane focus mode so focus toggles don't accidentally
                // render an empty placeholder region.
                main={main}
            />
        </SessionResumeProvider>
    );
}
