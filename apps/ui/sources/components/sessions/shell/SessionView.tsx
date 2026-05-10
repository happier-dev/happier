import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentFilePickerHandle, PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionAgentInputExtraActionChips } from '@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { EmptyMessages } from '@/components/ui/empty/EmptyMessages';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { useDraft } from '@/hooks/session/useDraft';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { continueSessionWithReplay, sessionAbort, resumeSession } from '@/sync/ops';
import { storage, useAutomations, useEndpointConnectivity, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionPendingMessages, useSessionUsage, useSetting, useSettings, useSyncError, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { getAgentCore, resolveAgentIdFromFlavor, buildResumeSessionExtrasFromUiState } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSession } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import {
    supportsSessionModeOverrides,
} from '@/sync/domains/sessionControl/sessionModeControl';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { listPendingPermissionRequests, listPendingUserActionRequests, shouldShowAbortButtonForSessionState, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { nativeReadClipboardImageAttachment } from '@/utils/files/nativeClipboardImageAttachment';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import {
    resolveParticipantRoutedSend,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { hasSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { nowServerMs } from '@/sync/runtime/time';
import { readSessionUiTelemetryNowMs } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { chooseSubmitMode } from '@/sync/domains/session/control/submitMode';
import { isSessionLocallyAttached } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionSubagentCounts } from '@/sync/domains/session/subagents/deriveSessionSubagentCounts';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useUnistyles } from 'react-native-unistyles';
import { sessionSwitch } from '@/sync/ops';
import { shouldRenderChatTimelineForSession, shouldRequestRemoteControl } from '@/sync/domains/session/control/localControlSwitch';
import { supportsEffectiveLocalControlForSession } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { readControlSwitchUiTimeoutMsFromEnv } from '@/sync/domains/session/control/controlSwitchUiTimeout';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceSessionSnapshot, voiceSessionManager } from '@/voice/session/voiceSession';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { shadowLevelStyle } from '@/shadowElevation';
import { resolveVoiceSessionComposerRouting } from '@/voice/binding/voiceSessionComposerRouting';
import { sendVoiceSessionComposerText } from '@/voice/binding/sendVoiceSessionComposerText';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { countEnabledAutomationsLinkedToSession } from '@/sync/domains/automations/automationSessionLink';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveSessionActionDefaultBackendTitle } from '@/sync/domains/session/resolveSessionActionDefaultBackendTitle';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { Text } from '@/components/ui/text/Text';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { SessionScreenTestIdsProvider } from './sessionScreenTestIds';
import { useSessionScreenIsFocused } from './useSessionScreenIsFocused';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { resolveMultiPaneDeviceType } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';
import { useSessionResumeRequestListener } from '@/components/sessions/model/sessionResumeRequests';
import { useExternalSessionTakeover } from '@/components/sessions/model/useExternalSessionTakeover';
import { useExternalSessionRuntime } from '@/components/sessions/model/useExternalSessionRuntime';
import { SessionExternalSessionRuntimeProvider } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useAuth } from '@/auth/context/AuthContext';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { isHiddenSystemSession } from '@happier-dev/protocol';
import { useSessionViewBootstrap } from './view/useSessionViewBootstrap';
import {
    resolveMobileWorkspaceExperienceToggleActionId,
} from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { SessionViewLayout } from './view/SessionViewLayout';
import { combineSessionViewExtraActionChips } from './view/combineSessionViewExtraActionChips';
import { resolveSessionViewModeOptionIds } from './view/resolveSessionViewModeOptionIds';
import { resolveSessionViewHeaderProps } from './view/resolveSessionViewHeaderProps';
import { resolveSessionViewDirectControlFooter } from './view/resolveSessionViewDirectControlFooter';
import { resolveSessionViewRuntimeDisplayState } from './view/resolveSessionViewRuntimeDisplayState';
import { resolveSessionViewMicButtonState } from './view/resolveSessionViewMicButtonState';
import { isSessionRootRoutePathActive, isSessionRoutePathActive } from './view/isSessionRoutePathActive';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { useSessionReachableMachineTarget } from '../model/useSessionMachineReachability';
import {
    resolveSessionAuthSurfaceState,
    type SessionAuthSurfaceState,
} from './sessionAuthSurfaceState';

export { resolveSessionAuthSurfaceState } from './sessionAuthSurfaceState';

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


export const SessionView = React.memo((props: {
    id: string;
    routeServerId?: string | null;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocusedOverride?: boolean | null;
    surfaceVisibleOverride?: boolean | null;
    routeAnchorOverride?: boolean | null;
    contentOverride?: React.ReactNode;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    chatBottomSpacing?: 'default' | 'none';
}) => {
    const sessionId = normalizeSessionId(props.id);
    const router = useRouter();
    const pathname = usePathname();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const auth = useAuth();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const automations = useAutomations();
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const handleBackPress = React.useCallback(() => {
        safeRouterBack({
            router,
            fallbackHref: '/',
        });
    }, [router]);
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(sessionId);
    const safeArea = useChromeSafeAreaInsets();
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
    const routeFocused = useSessionScreenIsFocused();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeSessionRoute = isSessionRoutePathActive(pathname, sessionId);
    const isFocused = typeof props.surfaceFocusedOverride === 'boolean'
        ? props.surfaceFocusedOverride
        : routeFocused;
    const isSurfaceVisible = typeof props.surfaceVisibleOverride === 'boolean'
        ? props.surfaceVisibleOverride
        : true;
    const isActiveSessionRoute = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : activeSessionRoute;
    const isPaneUrlSyncRouteActive = isFocused && isSurfaceVisible && (
        typeof props.routeAnchorOverride === 'boolean'
            ? props.routeAnchorOverride
            : isSessionRootRoutePathActive(pathname, sessionId)
    );
    const currentSessionRouteServerId =
        resolveServerIdForSessionIdFromLocalCache(sessionId)
        || (props.routeServerId ?? '').trim()
        || getActiveServerSnapshot().serverId;
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
    const sessionEncryptionMode: 'e2ee' | 'plain' = (session?.encryptionMode ?? 'e2ee');
    const isEncryptedSessionLocked = Boolean(session && sessionEncryptionMode === 'e2ee' && !hasAuthCredentials);
    const showTopHeader = !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web');

    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const workspaceRefsV1 = useSetting('workspaceRefsV1');
    const headerMachineTarget = useSessionReachableMachineTarget(sessionId);
    const paneScopeId = useRegisterSessionPaneDriver(sessionId);
    const sessionsRightPaneDefaultOpen = useLocalSetting('sessionsRightPaneDefaultOpen');
    const {
        mobileWorkspaceExperience,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();
    const { pane, machineReachable: isMachineReachable, isSurfaceFocused } = useSessionViewBootstrap({
        sessionId,
        paneScopeId,
        paneUrlState: props.paneUrlState ?? null,
        multiPaneEnabled,
        sessionsRightPaneDefaultOpen: sessionsRightPaneDefaultOpen === true,
        deviceType,
        sessionPath: session?.metadata?.path ?? null,
        sessionSeq: session?.seq ?? null,
        sessionPendingVersion: session?.pendingVersion ?? null,
        surfaceFocused: isFocused,
        surfaceVisible: isSurfaceVisible,
        routeAnchor: isActiveSessionRoute,
        paneUrlSyncRouteActive: isPaneUrlSyncRouteActive,
    });
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const { messages: committedMessages, isLoaded: committedMessagesLoaded } = useSessionMessages(sessionId);
    const externalSessionRuntime = useExternalSessionRuntime({
        sessionId,
        metadata: session?.metadata ?? null,
        enabled: isSurfaceFocused,
    });
    const { subagents, participantTargets, sidechainIds: participantSidechainIds } = useSessionSubagents({
        sessionId,
        session,
        messages: committedMessages,
        externalSessionRuntime,
    });
    const subagentCounts = deriveSessionSubagentCounts(subagents);
    const shouldShowSubagentsButton = subagentCounts.total > 0 || sessionExecutionRunsSupported || hasSessionSubagentLaunchCards(session);

    useEnsureSidechainsLoaded({
        enabled: participantSidechainIds.length > 0,
        sessionId,
        sidechainIds: participantSidechainIds,
    });

    const sessionAutomationsEnabledCount = showAutomations
        ? countEnabledAutomationsLinkedToSession(automations, sessionId)
        : 0;

    const constrainHeaderWidth = !(multiPaneEnabled
        && Platform.OS === 'web'
        && ((pane.scopeState?.right.isOpen ?? false) || (pane.scopeState?.details.isOpen ?? false)));

    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === 'header.openSubagents') {
            pane.openRight({ tabId: 'agents' });
            pane.setRightTab('agents');
            return true;
        }
        if (actionId === 'header.openRuns') {
            router.push(buildCurrentSessionHref('/runs') as any);
            return true;
        }
        if (actionId === 'header.openAutomations') {
            navigateWithBlurOnWeb(() => router.push(buildCurrentSessionHref('/automations') as any));
            return true;
        }
        const workspaceModeToggleActionId = resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperience);
        if (actionId === workspaceModeToggleActionId && showWorkspaceExperienceToggle) {
            if (mobileWorkspaceExperience === 'cockpit' && pathname === `/session/${sessionId}`) {
                router.replace(buildCurrentSessionHref() as any);
            }
            toggleWorkspaceExperience();
            return true;
        }
        return false;
    }, [buildCurrentSessionHref, mobileWorkspaceExperience, pane, pathname, router, sessionId, showWorkspaceExperienceToggle, toggleWorkspaceExperience]);

    const headerMenuExtraItems = React.useMemo(() => {
        if (!showWorkspaceExperienceToggle) {
            return undefined;
        }
        return [{
            id: resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperience),
            title: t(workspaceExperienceToggleLabelKey),
            icon: <Ionicons name="swap-horizontal-outline" size={18} color={theme.colors.textSecondary} />,
        }];
    }, [mobileWorkspaceExperience, showWorkspaceExperienceToggle, theme.colors.textSecondary, workspaceExperienceToggleLabelKey]);

    const headerWorkspaceDisplay = React.useMemo(() => resolveSessionWorkspaceDisplayPresentation({
        serverId: currentSessionRouteServerId,
        metadata: session?.metadata ?? null,
        machineTarget: headerMachineTarget,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
    }), [currentSessionRouteServerId, headerMachineTarget, session?.metadata, workspaceRefsV1]);

    // Compute header props based on session state
    const headerProps = React.useMemo(() => resolveSessionViewHeaderProps({
        isDataReady,
        session,
        sessionId,
        sessionInfoHref: buildCurrentSessionHref('/info'),
        sessionRunsHref: buildCurrentSessionHref('/runs'),
        sessionAutomationsHref: buildCurrentSessionHref('/automations'),
        paneScopeId,
        windowWidth,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        showAutomations,
        shouldShowSubagentsButton,
        subagentActiveCount: subagentCounts.active,
        navigateWithBlurOnWeb,
        handleHeaderExtraItemSelect,
        headerMenuExtraItems,
        router,
        actionIconColor: theme.colors.textSecondary,
        headerTintColor: theme.colors.header.tint,
        statusErrorColor: theme.colors.status.error,
        workspaceSubtitle: headerWorkspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: headerWorkspaceDisplay.subtitleEllipsizeMode,
    }), [
        buildCurrentSessionHref,
        handleHeaderExtraItemSelect,
        headerWorkspaceDisplay.displayTitle,
        headerWorkspaceDisplay.subtitleEllipsizeMode,
        headerMenuExtraItems,
        isDataReady,
        paneScopeId,
        router,
        session,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        sessionId,
        shouldShowSubagentsButton,
        showAutomations,
        subagentCounts.active,
        theme.colors.header.tint,
        theme.colors.status.error,
        theme.colors.textSecondary,
        windowWidth,
    ]);

    return (
        <SessionExternalSessionRuntimeProvider value={externalSessionRuntime}>
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
                    height: safeAreaTopInset,
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
                  ) : props.contentOverride ? (
                      props.contentOverride
                  ) : (
                      // Normal session view
                       <SessionViewLoaded
                           authSurfaceState={authSurfaceState}
                           key={sessionId}
                           sessionId={sessionId}
                           routeServerId={currentSessionRouteServerId}
                           session={session}
                           pane={pane}
                           isMachineReachable={isMachineReachable}
                           onBackPress={handleBackPress}
                           isEncryptedSessionLocked={isEncryptedSessionLocked}
                           executionRunsEnabled={executionRunsEnabled}
                           committedMessages={committedMessages}
                           committedMessagesLoaded={committedMessagesLoaded}
                           jumpToSeq={props.jumpToSeq ?? null}
                           participantTargets={participantTargets}
                           paneUrlState={props.paneUrlState ?? null}
                           initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                           paneScopeId={paneScopeId}
                           pendingMessages={pendingMessages}
                           externalSessionRuntime={externalSessionRuntime}
                           chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                       />
                  )}
            </View>
        </SessionScreenTestIdsProvider>
        </SessionExternalSessionRuntimeProvider>
    );
});


function SessionViewLoaded({
    authSurfaceState,
    committedMessages,
    committedMessagesLoaded,
    sessionId,
    routeServerId,
    session,
    pane,
    isMachineReachable,
    onBackPress,
    isEncryptedSessionLocked,
    executionRunsEnabled,
    jumpToSeq,
    participantTargets,
    paneUrlState,
    initialAttachmentDrafts,
    paneScopeId,
    pendingMessages,
    externalSessionRuntime,
    chatBottomSpacing,
}: {
    authSurfaceState: SessionAuthSurfaceState | null;
    committedMessages: readonly Message[];
    committedMessagesLoaded: boolean;
    sessionId: string;
    routeServerId?: string | null;
    session: Session;
    pane: ReturnType<typeof useSessionViewBootstrap>['pane'];
    isMachineReachable: boolean;
    onBackPress: () => void;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    jumpToSeq: number | null;
    participantTargets: readonly SessionParticipantTarget[];
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    paneScopeId: string;
    pendingMessages: readonly PendingMessage[];
    externalSessionRuntime: ReturnType<typeof useExternalSessionRuntime>;
    chatBottomSpacing: 'default' | 'none';
}) {
    const { theme } = useUnistyles();
    const applyLocalSettings = useApplyLocalSettings();
    const router = useRouter();
    const pathname = usePathname();
    const safeArea = useChromeSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidth } = useWindowDimensions();
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const [message, setMessage] = React.useState('');
    const realtimeStatus = useRealtimeStatus();
    const committedMessagesCount = committedMessages.length;
    const isLoaded = committedMessagesLoaded;
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
    const forkV1 = session.metadata?.forkV1;
    const isForkedSessionV1 =
        forkV1?.v === 1 &&
        typeof forkV1.parentSessionId === 'string' &&
        forkV1.parentSessionId.trim().length > 0;
    const reachableMachineTarget = useSessionReachableMachineTarget(sessionId);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = reachableMachineTarget?.machineId ?? session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = Boolean(isCliOutdated && !isAcknowledged);
    const sessionAgentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(session.metadata?.flavor) ?? null;
    const liveAuthoringContext = buildLiveSessionAuthoringContext({
        session,
    });
    const liveComposerState = resolveSessionComposerStateFromAuthoringContext(liveAuthoringContext, {
        fallbackAgentId: sessionAgentId,
    });
    const agentId = liveComposerState.agentId ?? sessionAgentId;
    const permissionMode = liveComposerState.permissionMode;
    const sessionModeOptionIds = agentId
        ? resolveSessionViewModeOptionIds(
            agentId,
            (session.metadata as any)?.sessionModesV1
                ?? (session.metadata as any)?.acpSessionModesV1
                ?? null,
            getAgentCore(agentId)?.sessionModes,
        )
        : [];
    const enabledAgentIds = useEnabledAgentIds();
    const sessionActionDefaultBackend = resolveSessionActionDefaultBackend({
        session: session as any,
        enabledAgentIds,
        fallbackAgentId: agentId,
    });
    const agentInputAgentType = agentId ?? sessionActionDefaultBackend?.displayAgentType ?? null;
    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(session.metadata ?? null);
    const isHiddenSystemSessionSession = isHiddenSystemSession({ metadata: session.metadata ?? null });
    const modelMode = liveComposerState.modelMode;
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const sessionUsageWithContextWindowTokens = sessionUsage as (typeof sessionUsage & { contextWindowTokens?: number }) | null;
    const latestUsageWithContextWindowTokens = session.latestUsage as (typeof session.latestUsage & { contextWindowTokens?: number }) | null;
    const activeServerId = getActiveServerSnapshot().serverId;
    const capabilityServerId = (routeServerId ?? '').trim() || activeServerId;
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
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: capabilityServerId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const sessionActionDefaultBackendEntry = React.useMemo(() => {
        if (!sessionActionDefaultBackend) return null;
        const selectedTargetKey = resolveBackendTargetKeyV2(sessionActionDefaultBackend.backendTarget as any);
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        }).find((entry) => entry.backendTargetKey === selectedTargetKey) ?? null;
    }, [
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        sessionActionDefaultBackend,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const voiceEnabled = useFeatureEnabled('voice');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads');
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
    const pasteAttachmentImage = React.useCallback(() => {
        fireAndForget((async () => {
            const picked = await nativeReadClipboardImageAttachment();
            if (picked.length === 0) {
                Modal.alert(t('attachments.alerts.noClipboardImageTitle'), t('attachments.alerts.noClipboardImageBody'));
                return;
            }
            addPickedAttachments(picked);
        })(), {
            onError: () => {
                Modal.alert(t('attachments.alerts.noClipboardImageTitle'), t('attachments.alerts.noClipboardImageBody'));
            },
        });
    }, [addPickedAttachments]);
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

    const sessionRouteServerId = (routeServerId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || activeServerId;
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

    const actionExecutor = createDefaultActionExecutor({
        resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
        openSession: (sid) => {
            router.push(buildSessionHref(sid) as any);
        },
    });

    // Inactive session resume state
    // Use `session.active` as the source of truth for whether the provider process is running.
    // `presence` is derived from server snapshots and can drift if a partial update lands.
    const isSessionActive = session.active === true;
    const supportsLocalControl = !isHiddenSystemSessionSession && agentId != null
        ? supportsEffectiveLocalControlForSession({
            agentId,
            metadata: session.metadata,
            accountSettings: settings,
        })
        : false;
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: capabilityServerId,
        settings,
        enabled: !isSessionActive || supportsLocalControl,
    });

    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions);
    const [isResuming, setIsResuming] = React.useState(false);
    const [isPendingQueueWakeResuming, setIsPendingQueueWakeResuming] = React.useState(false);
    const persistedVoiceComposerRouting = resolveVoiceSessionComposerRouting({
        conversationSessionId: sessionId,
        sessionMetadata: session.metadata,
    });

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

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
        fireAndForget(sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId,
            configId,
            value: valueId,
            updatedAt: nowServerMs(),
        }), { tag: 'SessionView.updateAcpConfigOptionOverride' });
    }, [sessionId]);

    // Function to update model mode (only for agents that expose model selection in the UI)
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (!agentId) return;
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

        if (!agentId) {
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
                            backendTarget: sessionActionDefaultBackend?.backendTarget ?? { kind: 'builtInAgent', agentId },
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
    }, [agentId, capabilityServerId, executionRunsEnabled, isMachineReachable, reachableMachineTarget, resumeCapabilityOptions, router, session, sessionActionDefaultBackend, sessionId, settings]);

    useSessionResumeRequestListener(React.useCallback((requestedSessionId) => {
        if (requestedSessionId !== sessionId) return;
        void handleResumeSession();
    }, [handleResumeSession, sessionId]));

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
    const micButtonState = resolveSessionViewMicButtonState({
        voiceProviderId,
        voiceStatus: voiceSnap.status,
        onMicPress:
            voiceProviderId !== 'off' || voiceSnap.status !== 'disconnected'
                ? handleMicrophonePress
                : undefined,
    });

    const providerName = sessionActionDefaultBackendEntry?.title
        ?? resolveSessionActionDefaultBackendTitle({
            session,
            sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
            fallbackTitle: agentId ? getAgentCore(agentId).uiConnectedService.label ?? t('status.unknown') : t('status.unknown'),
        })
        ?? t('status.unknown');
    const machineName = session.metadata?.host ?? t('status.unknown');

    const runtimeDisplayState = resolveSessionViewRuntimeDisplayState({
        session,
        isSessionActive,
        isResumable,
        isMachineReachable,
        allowInputWhileInactive: persistedVoiceComposerRouting?.kind === 'adapter_text',
        providerName,
        machineName,
    });
    const inactiveUi = runtimeDisplayState.inactiveUi;
    const bottomNotice = runtimeDisplayState.bottomNotice;

    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const isReadOnly = session.accessLevel === 'view';
    const transcriptInteraction = runtimeDisplayState.transcriptInteraction;

    const [pendingQueueResumeFailed, setPendingQueueResumeFailed] = React.useState(false);
    React.useEffect(() => {
        if (!pendingQueueResumeFailed) return;
        if (!isSessionActive) return;
        setPendingQueueResumeFailed(false);
    }, [isSessionActive, pendingQueueResumeFailed]);

    const isLocallyAttached = !isHiddenSystemSessionSession && isSessionLocallyAttached(session);
    const cliDetectionAgentIds = agentId ? [agentId] : [];
    const cliAvailability = useCLIDetection(machineId ?? null, {
        autoDetect: isLocallyAttached,
        includeLoginStatus: isLocallyAttached,
        agentIds: cliDetectionAgentIds,
        serverId: capabilityServerId,
    });
    const cliAuthStatus = agentId ? cliAvailability.authStatus[agentId] ?? null : null;
    const canRequestRemoteControl = shouldRequestRemoteControl(session, cliAuthStatus?.state ?? null);
    const [controlSwitchTo, setControlSwitchTo] = React.useState<'remote' | null>(null);
    const controlSwitchAttemptIdRef = React.useRef(0);
    React.useEffect(() => {
        if (controlSwitchTo === 'remote' && !isLocallyAttached) {
            setControlSwitchTo(null);
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
        const requestedControlMode = 'remote' as const;
        controlSwitchAttemptIdRef.current = attemptId;
        setControlSwitchTo(requestedControlMode);
        fireAndForget((async () => {
            try {
                const ok = await sessionSwitch(sessionId, requestedControlMode);
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
    const externalSessionTakeover = useExternalSessionTakeover({
        sessionId,
        hasWriteAccess,
        externalSessionRuntime,
    });

    const directControlFooter = resolveSessionViewDirectControlFooter({
        externalSessionLink: externalSessionRuntime.externalSessionLink,
        externalSessionRuntime,
        externalSessionTakeover,
        isHiddenSystemSessionSession,
    });

    const shouldForceRenderTranscriptFooter =
        isForkedSessionV1 || ((session.seq ?? 0) > 0 && committedMessagesCount === 0);
    const shouldRenderChatTimeline = !isEncryptedSessionLocked
        && shouldRenderChatTimelineForSession({
            committedMessagesCount,
            pendingMessagesCount: pendingMessages.length,
            controlledByUser: isLocallyAttached,
            // Some sessions can have a non-zero committed transcript seq but end up with 0 visible
            // main-timeline messages (e.g. newest page is sidechain-only). In that case, we must
            // still render the transcript so it can page backwards to find visible messages.
            forceRenderFooter: shouldForceRenderTranscriptFooter,
        });
    const shouldRenderChatTimelineImmediately = shouldRenderChatTimeline
        && (
            isLoaded === true
            || committedMessagesCount > 0
            || pendingMessages.length > 0
            || shouldForceRenderTranscriptFooter
        );

    const shouldShowDeferredTranscriptPlaceholder =
        shouldRenderChatTimeline && !shouldRenderChatTimelineImmediately;

    React.useEffect(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        const state = openToTranscriptTelemetryRef.current;
        if (!state || state.recorded || state.sessionId !== sessionId) return;
        if (isLoaded !== true) return;

        const transcript = shouldRenderChatTimeline ? 1 : 0;
        const empty = !shouldRenderChatTimeline && !isEncryptedSessionLocked ? 1 : 0;
        if (transcript !== 1 && empty !== 1) return;

        state.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.openToTranscript',
            readSessionUiTelemetryNowMs() - state.startedAtMs,
            {
                committedMessages: committedMessagesCount,
                empty,
                pendingMessages: pendingMessages.length,
                sessionSeq: Math.max(0, Math.trunc(session.seq ?? 0)),
                transcript,
            },
        );
    }, [
        committedMessagesCount,
        isEncryptedSessionLocked,
        isLoaded,
        pendingMessages.length,
        session.seq,
        sessionId,
        shouldRenderChatTimeline,
    ]);

      let content = (
          <>
              {authSurfaceState && !(inactiveUi.shouldShowInput && !isEncryptedSessionLocked) ? (
                  <View style={{ marginTop: 8, marginHorizontal: 8 }}>
                      <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                  </View>
              ) : null}
              {shouldRenderChatTimeline && shouldRenderChatTimelineImmediately ? (
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
              ) : null}
              {shouldShowDeferredTranscriptPlaceholder ? (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                      <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                  </View>
              ) : null}
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
            onPasteAttachmentImage: pasteAttachmentImage,
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
        const agentInputExtraActionChips = combineSessionViewExtraActionChips(extraActionChips, routingControls.extraActionChips);

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
            router.push(href);
            return;
        }

        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [multiPaneDeviceType, multiPaneEnabled, pane, pathname, router, sessionId, windowWidth]);

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
                agentType={agentInputAgentType ?? undefined}
                agentLabel={agentInputAgentType ? resolveSessionActionDefaultBackendTitle({
                    session,
                    sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
                }) || undefined : undefined}
                attachments={attachmentsUploadsEnabled ? agentInputAttachments : undefined}
                onAttachmentsAdded={attachmentsUploadsEnabled ? addAttachments : undefined}
                hasSendableAttachments={hasIncludedReviewCommentDrafts || (attachmentsUploadsEnabled && attachmentDrafts.length > 0)}
                permissionRequests={listPendingPermissionRequests(session)}
                userActionRequests={listPendingUserActionRequests(session)}
                canApprovePermissions={transcriptInteraction.canApprovePermissions}
                permissionDisabledReason={transcriptInteraction.permissionDisabledReason}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                onAcpSessionModeChange={agentId && supportsSessionModeOverrides(agentId) ? updateAcpSessionModeOverride : undefined}
                onAcpConfigOptionChange={updateAcpConfigOptionOverride}
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
                    text: (isResuming || isPendingQueueWakeResuming) ? t('session.resuming') : (inactiveStatusText || sessionStatus.statusText),
                    color: sessionStatus.statusColor,
                    dotColor: sessionStatus.statusDotColor,
                    isPulsing: isResuming || isPendingQueueWakeResuming || sessionStatus.isPulsing
                }}
                onSend={(sendOptions) => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }

                    const sendComposerText = (
                        messageToSend: string,
                        composerTextBeforeSend: string,
                        sendIntent?: Readonly<{ forceImmediate?: boolean }>,
                    ) => {
                        const configuredMode = storage.getState().settings.sessionMessageSendMode;
                        const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
                        const submitMode = chooseSubmitMode({ configuredMode, busySteerSendPolicy, session });
                        const forceImmediateSend = sendIntent?.forceImmediate === true;

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
                                    const readyForSend = await externalSessionTakeover.ensureReadyForSend();
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

                                    const outbound = shouldSendReviewComments
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

                        const outbound = shouldSendReviewComments
                            ? {
                                ...buildReviewCommentsOutboundMessage({
                                    sessionId,
                                    drafts: includedReviewCommentDrafts,
                                    additionalMessage,
                                }),
                            }
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

                        if (executionRunSend) {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await externalSessionTakeover.ensureReadyForSend();
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

                        if (submitMode === 'server_pending' && !forceImmediateSend) {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await externalSessionTakeover.ensureReadyForSend();
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
                                    setPendingQueueResumeFailed(true);
                                    return;
                                }

                                try {
                                    setIsPendingQueueWakeResuming(true);
                                    const result = await resumeSession({
                                        ...wakeOpts,
                                        serverId: capabilityServerId,
                                    });
                                    if (result.type === 'error') {
                                        // Non-fatal: message is already persisted in the pending queue.
                                        setPendingQueueResumeFailed(true);
                                    }
                                } catch {
                                    // Non-fatal: message is already persisted in the pending queue.
                                    setPendingQueueResumeFailed(true);
                                } finally {
                                    setIsPendingQueueWakeResuming(false);
                                }
                            })(), { tag: 'SessionView.sendMessage.serverPending' });
                            return;
                        }

                        if (!isSessionActive && isResumable) {
                            fireAndForget((async () => {
                                markComposerSent();
                                const readyForSend = await externalSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    setMessage(previousMessage);
                                    return;
                                }

                                try {
                                    const supportsPendingQueueV2 = typeof session.pendingVersion === 'number';
                                    if (supportsPendingQueueV2 && !forceImmediateSend) {
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
                            const readyForSend = await externalSessionTakeover.ensureReadyForSend();
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

                                sendComposerText(expanded, composerTextBeforeSend, sendOptions);
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
	                        if (!agentId && resolved.actionId !== 'ui.pet.choose') {
	                            Modal.alert(t('common.error'), t('session.resumeFailed'));
	                            return;
	                        }
	                        const previousMessage = message;
	                        void executeSessionComposerResolution({
	                            resolved,
	                            sessionId,
	                            agentId: agentId ?? '',
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
                    sendComposerText(resolved.text, message, sendOptions);
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
                usageData={sessionUsageWithContextWindowTokens ? {
                    inputTokens: sessionUsageWithContextWindowTokens.inputTokens,
                    outputTokens: sessionUsageWithContextWindowTokens.outputTokens,
                    cacheCreation: sessionUsageWithContextWindowTokens.cacheCreation,
                    cacheRead: sessionUsageWithContextWindowTokens.cacheRead,
                    contextSize: sessionUsageWithContextWindowTokens.contextSize,
                    ...(typeof sessionUsageWithContextWindowTokens.contextWindowTokens === 'number'
                        ? { contextWindowTokens: sessionUsageWithContextWindowTokens.contextWindowTokens }
                        : {}),
                } : latestUsageWithContextWindowTokens ? {
                    inputTokens: latestUsageWithContextWindowTokens.inputTokens,
                    outputTokens: latestUsageWithContextWindowTokens.outputTokens,
                    cacheCreation: latestUsageWithContextWindowTokens.cacheCreation,
                    cacheRead: latestUsageWithContextWindowTokens.cacheRead,
                    contextSize: latestUsageWithContextWindowTokens.contextSize,
                    ...(typeof latestUsageWithContextWindowTokens.contextWindowTokens === 'number'
                        ? { contextWindowTokens: latestUsageWithContextWindowTokens.contextWindowTokens }
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

    const main = (
        <SessionViewLayout
            content={content}
            input={input}
            placeholder={placeholder}
            shouldShowCliWarning={shouldShowCliWarning}
            onDismissCliWarning={handleDismissCliWarning}
            isLandscape={isLandscape}
            deviceType={deviceType}
            onBackPress={onBackPress}
            chatBottomSpacing={chatBottomSpacing}
        />
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
