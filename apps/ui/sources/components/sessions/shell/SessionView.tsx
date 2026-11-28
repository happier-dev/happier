import { useSessionManagedWakePresentation, type SessionManagedWakePresentation } from '@/components/sessions/pending/useSessionManagedWakePresentation';
import { Typography } from "@/constants/Typography";
import { SESSION_PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { usePluginLocalizedTextResolver } from "@/sync/domains/plugins/ui/i18n";
import { isEmbedWindowContext } from "@/embed/isEmbedWindowContext";
import { useAppPaneActionRailVisible } from "@/components/appShell/panes/hooks/useAppPaneActionRailVisible";
import { useReadSessionCockpitChromeRegistration, useSessionCockpitTerminalTabAvailable } from "@/components/workspaceCockpit/session/SessionCockpitChromeRegistry";
import { useOpenSessionCollaboration } from "@/components/sessions/collaboration/useOpenSessionCollaboration";
import { useSessionCollaborationDestinationEntryAdmitted } from "@/hooks/session/useSessionCollaborationAvailability";
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from "@/sync/domains/session/sessionAddress";
import type { AttachmentDraft } from "@/components/sessions/attachments/attachmentDraftModel";
import { useSessionFileUploadAvailability } from "@/components/sessions/files/useSessionFileUploadAvailability";
import { SessionViewLiveStatusPaneHeader } from "@/components/sessions/shell/view/SessionViewLiveStatusPaneHeader";
import { SESSION_HEADER_MENU_OPEN_BROWSER_ID, SESSION_HEADER_MENU_OPEN_TERMINAL_ID } from "@/components/sessions/shell/view/resolveSessionViewHeaderActionItems";
import { useSessionTerminalAction } from "@/components/sessions/terminal/useSessionTerminalAction";
import { useFeatureDecision } from "@/hooks/server/useFeatureDecision";
import { getRightSidebarBuiltinTab } from "@/components/appShell/rightSidebar/rightSidebarTabRegistry";
import { PaneHeaderScrollScope } from "@/components/appShell/panes/paneHeaderScroll";
import { SessionHeaderSandboxChip } from '@/components/sessions/shell/view/SessionHeaderSandboxChip';
import { SessionLineageBreadcrumb } from "@/components/sessions/work/SessionLineageBreadcrumb";
import { PhoneOpenTabsRail } from "@/components/appShell/workspace/PhoneOpenTabsRail";
import { SessionAllTabsOpenerBridge } from "@/components/sessions/shell/useSessionAllTabsOpener";
import { useWorkflowMakeRepeatable } from "@/components/workflows/authoring/useWorkflowMakeRepeatable";
import { mergeAbortSignals } from "@/utils/runtime/abortSignals";
import { useOpenAttachedSessionTerminal } from "@/components/sessions/terminal/openAttachedSessionTerminal";
import { ChatList, type TranscriptViewportChangeState } from "@/components/sessions/transcript/ChatList";
import { applyTranscriptJumpHighlightForJumpResult } from "@/components/sessions/transcript/navigation/transcriptJumpHighlightStore";
import { TranscriptMessageSelectionProvider } from "@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext";
import { TranscriptSelectionToolbarController } from "@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbarController";
import { SessionPhoneTrackWatchCapsule } from "@/components/sessions/files/track/SessionTrack";
import { TranscriptCodeAskControls } from "@/components/sessions/transcript/messageSelection/TranscriptCodeAskControls";
import { FindComposerSlotHost, FindComposerSlotProvider } from "@/components/ui/find/FindComposerSlot";
import type { TranscriptSelectionToolbarMessage } from "@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbar";
import { openOrdinaryNewSessionSeed } from "@/components/sessions/new/newSessionSeedNavigation";
import { openTranscriptSendToSessionModal } from "@/components/sessions/transcript/messageSelection/openTranscriptSendToSessionModal";
import { openBulkSessionComposer } from '@/components/sessions/bulkCompose/bulkSessionComposeRoute';
import { sendTranscriptSelectionToSession } from "@/components/sessions/transcript/messageSelection/sendTranscriptSelectionToSession";
import { useTranscriptSelectionEligibleMessageIds } from "@/components/sessions/transcript/messageSelection/useTranscriptSelectionEligibleMessageIds";
import { EmptyMessages } from "@/components/ui/empty/EmptyMessages";
import type { DropdownMenuItem } from "@/components/ui/forms/dropdown/DropdownMenu";
import { useSessionDraftHydrationAdmission } from "@/components/sessions/drafts/SessionDraftHydrationBoundary";
import { SessionDraftAdmissionContext } from "@/components/sessions/drafts/sessionDraftAdmission";
import { useNavigateToSession } from "@/hooks/session/useNavigateToSession";
import { useFeatureEnabled } from "@/hooks/server/useFeatureEnabled";
import { SESSION_BOARD_HEADER_MENU_ACTION_ID } from "@/components/sessions/board/sessionBoardDestination";
import { useSessionBoardFeatureEnabled } from "@/components/sessions/board/useSessionBoardFeatureEnabled";
import { createSessionBoardDetailsTab } from "@/components/sessions/panes/details/sessionDetailsTabBuilders";
import { isSessionBoardVisibleInDetails } from "@/components/sessions/board/sessionBoardDetailsVisibility";
import { useSessionExecutionRunsSupported } from "@/hooks/server/useSessionExecutionRunsSupported";
import { Modal } from "@/modal";
import { COMPOSER_SETTLED_APPROVAL_PRESENTATIONS, TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from "@/components/tools/shell/approvals/transcriptSettledApprovalPresentations";
import { useWorkspaceRefs, storage, useEnabledAutomationsCountForSession, useComposerApprovalArtifactsForSession, useEndpointConnectivity, useIsDataReady, useLocalSetting, useTranscriptApprovalArtifactsForSession, useSessionPendingMessages, useSessionSelector, useSessionTranscriptCommittedPresence, useSessionTranscriptIds, useSessionVisibleReadSeq, useServerScopedMachineLabel, useSetting, useSyncError } from "@/sync/domains/state/storage";
import type { SessionRouteHydrationState } from "@/sync/domains/session/sessionRouteHydrationState";
import { readSessionContentAvailability } from "@/sync/domains/session/encryptedContentAvailability";
import { appendSessionDraftText } from "@/components/sessions/composer/sessionDraftAppendAction";
import { Session } from "@/sync/domains/state/storageTypes";
import { readSessionOwnerMetadataView } from "@/sync/domains/session/readSessionOwnerMetadataView";
import { presentTranscriptLoadIssue } from '@/components/sessions/shell/transcriptLoadIssuePresentation';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { sync } from "@/sync/sync";
import { t, type TranslationKey } from "@/text";
import { useDeviceType, useIsLandscape, useIsTablet } from "@/utils/platform/responsive";
import { getSessionName } from "@/utils/sessions/sessionUtils";
import { deriveTranscriptInteractionFromSession } from "@/utils/sessions/deriveTranscriptInteraction";
import { AppSessionTranscriptSourceProvider } from "@/components/sessions/transcript/source/appSessionTranscriptSource";
import { SessionDiscussionSourceLinksProvider } from "@/components/discussions/SessionDiscussionSourceLinks";
import { useSessionTranscriptSource } from "@/components/sessions/transcript/source/SessionTranscriptSourceContext";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { runAfterInteractionsWithFallback } from "@/utils/timing/runAfterInteractionsWithFallback";
import type { BrowserContextState } from "@/sync/domains/browser/context";
import { SessionBrowserContextRuntimeProvider, type SessionBrowserContextRuntime, useSessionBrowserContextRuntime } from "@/components/sessions/browser/sessionBrowserContextRuntime";
import { alertBrowserContextUnavailable } from "@/components/sessions/browser/alertBrowserContextUnavailable";
import { useSessionAgentActivity } from "@/hooks/session/useSessionAgentActivity";
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { hasSessionSubagentLaunchCards } from "@/agents/registry/sessionSubagentUiBehavior";
import { nowServerMs } from "@/sync/runtime/time";
import { readSessionUiTelemetryNowMs } from "@/sync/runtime/performance/sessionUiTelemetry";
import { syncPerformanceTelemetry } from "@/sync/runtime/syncPerformanceTelemetry";
import { openNewSessionSourceContextNavigation } from "@/components/sessions/new/navigation/newSessionSourceContextNavigation";
import { requireActionSuccess } from "@/sync/ops/actions/frontDoorRuntimeActionExecutor";
import { useDestinationParams, useDestinationPathname, useDestinationInstanceKey } from "@/components/appShell/workspace/DestinationInstanceHost";
import { useNewSessionDockHoldsComposerSeat, useNewSessionEntryRouter } from '@/components/sessions/new/navigation/newSessionEntry';
import * as React from "react";
import { AtmosphereSurfaceFrame } from "@/components/atmosphere/AtmosphereSurfaceFrame";
import { useWorkspaceFileOriginReturn } from "@/components/workspaces/files/useWorkspaceFileOriginReturn";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import { SessionComposerNoticesContext } from "@/components/sessions/composer/SessionComposerColumn";
import { SessionChatFooter } from "@/components/sessions/transcript/ChatFooter";
import { dismissKeyboard } from '@/components/ui/keyboardAvoidance/dismissKeyboard';
import { layout } from "@/components/ui/layout/layout";
import { useChromeSafeAreaInsets } from "@/components/ui/layout/useChromeSafeAreaInsets";
import { useUnistyles } from "react-native-unistyles";
import { useHappierMaterialColorResolver } from "@happier-dev/plugin-ui/presentation";
import { shouldRenderChatTimelineForSession, shouldOfferLocalControlRelease } from "@/sync/domains/session/control/localControlSwitch";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { shadowLevelStyle } from "@/shadowElevation";
import { isVoiceConversationSystemSessionMetadata } from "@/voice/persistence/voiceConversationSystemSessionLookup";
import { navigateWithBlurOnWeb } from "@/utils/platform/navigateWithBlurOnWeb";
import { safeRouterBack } from "@/utils/navigation/safeRouterBack";
import { useAutomationsSupport } from "@/hooks/server/useAutomationsSupport";
import { buildExactTurnAutomationRouteParams, EXACT_TURN_AUTOMATION_HEADER_ACTION_ID, readExactActiveParentTurn } from "@/components/automations/sessionLifecycle/exactTurnAutomationPrefill";
import { SESSION_WORK_STATE_STATUS_BADGE_KEY } from "@/components/sessions/workState/sessionWorkStatePresentation";
import { projectUiSessionAwareness } from "@/sync/domains/session/awareness/sessionAwareness";
import { SessionWorkSourcesProvider, useSessionWorkSourcesOwner, useStableWorkSummary } from "@/components/sessions/work/sessionWorkSources";
import type { SessionRunnerRuntimeStatusSnapshot } from "@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention";
import { useSessionRunnerRuntimeStatusRetention } from "@/components/sessions/sessionRunner/useSessionRunnerRuntimeStatusRetention";
import { normalizeSessionId } from "@/sync/domains/session/normalizeSessionId";
import type { OpenApprovalArtifactForSession, OpenApprovalAttentionArtifactForSession } from "@/sync/domains/artifacts/approvalArtifacts";
import { resolveServerIdForSessionIdFromLocalCache } from "@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache";
import { SessionInvalidLinkFallback } from "./SessionInvalidLinkFallback";
import { narrowTranscriptInteractionForPresentation, readEmbeddedSessionPresentation, resolveEmbeddedComposerControls, type SessionViewEmbeddedPresentation, type SessionViewPresentation } from "./embedded/embeddedSessionPresentation";
import { EmbeddedSessionPartClaimsScope, EmbeddedSessionPartsProvider, EmbeddedSessionStandardLayout, EmbeddedSessionStatePublication, type EmbeddedSessionPartsState, type EmbeddedSessionPartsValue } from "./embedded/EmbeddedSessionParts";
import { EmbeddedSessionUnavailable } from "./embedded/EmbeddedSessionUnavailable";
import { PluginSurfaceNestingBoundary } from "@/components/plugins/surfaces/pluginSurfaceNesting";
import { Text } from "@/components/ui/text/Text";
import { SessionPageTabs, SessionRightSidebarProvider } from "@/components/sessions/panes/SessionRightPanel";
import { PaneMainComposerAnchor, PaneMainTopAnchor } from '@/components/ui/panels/paneMainComposerAnchor';
import { createSessionPaneSurfaceScope } from "@/components/sessions/plugins/useSessionPluginRuntime";
import { PaneMainHideButton } from "@/components/appShell/panes/mainColumn/PaneMainColumnControls";
import { AppPaneScopeHost } from "@/components/appShell/panes/AppPaneScopeHost";
import { DetailsStartSheetHost } from '@/components/appShell/panes/panePresentation';
import { useRegisterSessionPaneDriver } from "@/components/sessions/panes/useRegisterSessionPaneDriver";
import { useTerminalJumpShortcut } from "@/components/sessions/terminal/jump/useTerminalJumpShortcut";
import { useSessionAddressForSessionId, useSessionPluginRuntime, type SessionPluginRuntimeState } from "@/components/sessions/plugins/useSessionPluginRuntime";
import { createSessionPaneScopeId } from "@/components/sessions/panes/sessionPaneScopeId";
import { SessionBoardControllerProvider, useMountedSessionBoardController } from "@/components/sessions/board/SessionBoardControllerProvider";
import { SessionScreenTestIdsProvider } from "./sessionScreenTestIds";
import { SessionSurfacePresenceProvider, useSessionSurfacePresence, useSessionSurfacePresenceSignal } from "./sessionSurfacePresence";
import { useSessionSurfaceActivation } from "./view/useSessionSurfaceActivation";
import { resolveMultiPaneDeviceType } from "@/components/appShell/panes/layout/resolveMultiPaneDeviceType";
import { buildScopedSessionRouteHref } from "@/hooks/session/sessionRouteServerScope";
import { SessionResumeProvider } from "@/components/sessions/model/SessionResumeContext";
import { useExternalSessionRuntime } from "@/components/sessions/model/useExternalSessionRuntime";
import { SessionExternalSessionRuntimeProvider } from "@/components/sessions/model/useSessionExternalSessionRuntime";
import { useAuth } from "@/auth/context/AuthContext";
import { selectSyncErrorForServer } from "@/sync/runtime/connectivity/syncErrorScope";
import type { SessionParticipantTarget } from "@/sync/domains/session/participants/participantTargets";
import type { PendingMessage } from "@/sync/domains/state/storageTypes";
import { useSessionViewBootstrap } from "./view/useSessionViewBootstrap";
import { SessionPaneUrlSyncHost } from "./view/SessionPaneUrlSyncHost";
import { useSessionViewedLifecycle } from "./view/useSessionViewedLifecycle";
import { resolveMobileWorkspaceExperienceToggleActionId } from "@/components/workspaceCockpit/mobileWorkspaceExperience";
import { useMobileWorkspaceExperienceState } from "@/components/workspaceCockpit/useMobileWorkspaceExperienceState";
import { SessionViewLayout, type SessionViewLayoutProps } from "./view/SessionViewLayout";
import { SessionCompanionHost } from "@/components/sessions/companion/SessionCompanionHost";
import { SessionCompanionRevealOwner } from "@/components/sessions/companion/presentation/SessionCompanionRevealPort";
import { SessionViewerSourceAccountScopeProvider } from "@/components/sessions/viewer/SessionViewerSourceAccountScope";
import { useSessionCompanionPreference } from "@/components/sessions/companion/state/useSessionCompanionPreference";
import { useResolveSessionCompanionPlacementForDensity, useSessionCompanionPlacement } from "@/components/sessions/companion/layout/useSessionCompanionPlacement";
import type { SessionCompanionEdge } from "@/components/sessions/companion/state/sessionCompanionPreference";
import { createSessionSummaryDestinations } from "@/components/sessions/companion/summary/sessionSummaryDestinations";
import { SessionCompanionPresentationBridge } from "@/components/sessions/companion/presentation/SessionCompanionPresentationBridge";
import type { CurrentSessionPresentationAuthorIntentV1 } from "@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1";
import type { SessionPresentationMutationOutcome } from "@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter";
import { createSessionCompanionPanePresentation } from "@/components/sessions/companion/presentation/sessionCompanionPanePresentation";
import type { PaneMainColumnState } from "@/components/appShell/panes/mainColumn/usePaneMainColumn";
import { ComposerAuxiliaryFrame } from "./view/ComposerAuxiliaryFrame";
import { SessionStartFailureBanner } from "@/components/sessions/startFailure/SessionStartFailureBanner";
import { offersPendingDeliverAndResume, readQueuedInputDeliverable } from "@/components/sessions/pending/pendingMessageVisualState";
import { createSessionAgentSignInRoute } from "@/components/sessions/presentation/sessionAgentAuthRequiredPresentation";
import { resolveSessionStartFailureNotice } from "@/components/sessions/startFailure/sessionStartFailureNotice";
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { dispatchProviderRecoveryAction } from '@/providers/connection/recovery';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { readMachineAdministrationTargetRouteParams } from '@/sync/domains/machines/administration/targetSelection';
import { resolveResumeFailurePresentation } from "@/sync/domains/session/resume/resolveResumeFailurePresentation";
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from "@/sync/domains/session/resolveSessionActionDefaultBackend";
import { buildPluginDetailRoute, storeMachineRouteParams } from "@/components/settings/plugins/model/pluginsSurfaceRoutes";
import { SessionComputerPresenceLine } from "@/components/computer/SessionComputerPresenceLine";
import { SessionViewerHost } from "@/components/sessions/viewer/SessionViewerHost";
import { SessionViewerScope } from "@/components/sessions/viewer/SessionViewerScope";
import { useSessionDestinationAccountBinding, useSessionViewerDestinationScope } from "@/components/sessions/viewer/SessionViewerDestinationScope";
import { SessionViewerStickySlot } from "@/components/sessions/viewer/SessionViewerStickySlot";
import { WarningActionBanner } from "./view/WarningActionBanner";
import { ComposerBannerCollapseProvider } from "@/components/sessions/composerBanners/ComposerBannerCollapseProvider";
import { readExternalSessionLink } from "@/sync/domains/session/external/readExternalSessionLink";
import { resolveSessionViewHeaderProps } from "./view/resolveSessionViewHeaderProps";
import { useVoiceConversationHeaderSubtitle } from '@/voice/presence/useVoiceConversationHeaderSubtitle';
import { useWorkspaceSyncRelationshipSummaries } from "@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries";
import { resolveWorkspaceSyncSetAttention } from "@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel";
import { createWorkspaceSyncConflictDetailsTab } from "@/components/workspaces/sync/workspaceSyncConflictDetailsTab";
import { SessionAgentCatalogIdentityIcon } from "@/components/sessions/presentation/SessionAgentCatalogIdentityIcon";
import { BotMarkerFeedback } from "@/components/sessions/bots/botMarkerFeedback";
import type { resolveExternalSessionRuntimePresentation } from "../presentation/externalSessionRuntimePresentation";
import { useSessionExternalRuntimePresentation } from "../presentation/useSessionExternalRuntimePresentation";
import { resolveExternalSessionIdentityPresentation } from "../presentation/externalSessionIdentityPresentation";
import { usePluginUiClientExecutableRegistrationRevision } from "@/components/plugins/reactNative/clientExecutableContributions";
import { useScopedPluginUiProjection } from "@/components/plugins/projection/useScopedPluginUiProjection";
import { PluginSurfacePaneLaunchScope, stagePluginSurfacePaneLaunch, type PluginSurfaceDestinationOpenResolution, type PluginSurfaceDestinationNavigationBinding, usePluginSurfacePaneLaunchScope } from "@/components/plugins/surfaces/pluginSurfaceDestinationNavigation";
import type { PluginSurfaceOpenHandler, PluginSurfaceOpenOutcome } from "@/components/plugins/surfaces/openPluginSurface";
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from "@/sync/domains/scope/useServerCredentialAccountScopes";
import { readExternalSessionOperationPresentationFromMetadata } from "../transcript/items/externalSessionOperationMetadata";
import { resolveSessionWorkspaceDisplayPresentation } from "@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation";
import { useSessionReachableMachineTarget } from "../model/useSessionMachineReachability";
import { useSessionMachineControlTarget } from "../model/useSessionMachineTarget";
import { resolveSessionAuthSurfaceState, type SessionAuthSurfaceState } from "./sessionAuthSurfaceState";
import { resolveSessionBlockedSurfaceState, type SessionBlockedSurfaceActionIntent } from "./sessionBlockedSurfaceState";
import { SessionBlockedSurfaceCard } from "./SessionBlockedSurfaceCard";
import { SETTINGS_ROUTES } from "@/components/settings/catalog/routes";
import { openRouteWithEstablishedHome } from "@/sync/domains/server/selection/openRouteWithEstablishedHome";
import { useSessionViewLatestTurnStatus, useSessionViewShellSession, useSessionViewShellSessionSeq } from "./sessionViewStableSession";
import { ActivitySpinner } from "@/components/ui/feedback/ActivitySpinner";
import { PaneLoadingFallback } from "@/components/ui/panels/PaneLoadingFallback";
import { SessionViewRouteLoading } from "@/components/sessions/shell/SessionViewRouteLoading";
import { SurfaceStateCard } from "@/components/ui/surfaces/SurfaceStateCard";
import { Icon, ICON_SIZE } from "@/components/ui/icons/Icon";
import { useSessionComposerController, SessionAuthRecoveryBanner } from "@/components/sessions/composer/useSessionComposerController";
import type { SessionComposerModel, SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';


export { resolveSessionAuthSurfaceState } from './sessionAuthSurfaceState';

const MemoizedSessionViewLoaded = React.memo(SessionViewLoaded);

type SessionViewProps = Readonly<{
    id: string;
    routeServerId?: string | null;
    jumpToSeq?: number | null;
    jumpToMessageId?: string | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    /** A host's own focus and visibility, replacing the destination's (embedded, pane, onboarding stage). */
    surfaceFocusedOverride?: boolean | null;
    surfaceVisibleOverride?: boolean | null;
    /** A cockpit scene's own activity, narrowing the destination's focus and visibility. */
    surfaceSceneActive?: boolean | null;
    /** `surface`: anchors the route while focused and visible (a hosted classic cockpit tab). */
    routeAnchorOverride?: boolean | 'surface' | null;
    routeHydrationState?: SessionRouteHydrationState | null;
    contentOverride?: React.ReactNode;
    /** Drawn under the Session header on every surface (a cockpit phone's top page strip). */
    headerAccessory?: React.ReactNode;
    /** Seats the existing composer once in the session slot or its sheet, under these providers. */
    renderComposer?: SessionComposerRenderer;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    chatBottomSpacing?: 'default' | 'none';
    browserContextStateForComposer?: BrowserContextState | null;
    /** One-shot request from an incumbent Session host to reveal the existing work-state details. */
    openWorkStateRequestKey?: number | null;
    /** Cockpit supplies its one composition-wide executable Board mount decision. */
    /** Cockpit supplies the same exact-Home plugin runtime every nested host consumes. */
    sessionPluginRuntime?: SessionPluginRuntimeState;
    /**
     * `primary` (default) is the route, canvas and cockpit presentation. `embedded` renders inside
     * another surface (plugin session parts, the embed route, the peek): the transcript, prompts
     * and — unless read-only — the composer, with no header, panes, Companion, Board or voice of its
     * own, and no route or pane side effects.
     */
    presentation?: SessionViewPresentation;
    /**
     * Embedded only: the arrangement of session parts, rendered inside this Session's own
     * providers. Defaults to `EmbeddedSessionStandardLayout`.
     */
    embeddedArrangement?: React.ReactNode;
}>;

function SessionAuthRecoveryFallback() {
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
                <SessionAuthRecoveryBanner />
            </View>
        </View>
    );
}

function resolveRouteHydrationRetryStatusKey(
    cause: Extract<SessionRouteHydrationState, { kind: 'retrying' }>['cause'],
): TranslationKey | null {
    if (cause === 'network' || cause === 'server_unavailable') {
        return 'newSession.notConnectedToServer';
    }
    if (cause === 'decrypting') {
        return 'common.loading';
    }
    return null;
}

/** Whether this surface is the presented, focused one: the commands that act on the user's current Session. */
function useSessionSurfaceActive(): boolean {
    const presence = useSessionSurfacePresence();
    return presence.visible && presence.focused && presence.presented;
}

/** Marks this Session visible, focused and anchored while its surface is (effects only). */
const SessionSurfaceActivationHost = React.memo(function SessionSurfaceActivationHost(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    sessionAccepted: boolean;
}>) {
    const presence = useSessionSurfacePresence();
    useSessionSurfaceActivation({
        sessionId: props.sessionId,
        serverId: props.serverId,
        onSessionVisible: props.sessionAccepted && (presence.focused || presence.routeAnchor) ? sync.onSessionVisible : undefined,
        surfaceFocused: presence.focused,
        // A web route host releases a mounted Session it no longer presents; native back stacks keep theirs.
        surfaceRetained: Platform.OS === 'web' ? presence.presented : true,
        surfaceVisible: presence.visible,
        routeAnchor: presence.routeAnchor,
    });
    return null;
});

/** Menus, panes and selections claim Escape first through the shared stack; then Escape leaves the focused Session. */
const SessionSurfaceEscapeToHome = React.memo(function SessionSurfaceEscapeToHome(props: Readonly<{
    router: Readonly<{ replace: (href: '/') => void }>;
}>) {
    const presence = useSessionSurfacePresence();
    const { router } = props;
    useEscapeLayer({
        enabled: Platform.OS === 'web' && presence.focused && presence.visible,
        priority: ESCAPE_LAYER_PRIORITIES.focusSessionSurface,
        onEscape: (event) => {
            const key = event as Partial<KeyboardEvent>;
            if (key.repeat || key.shiftKey || key.altKey || key.ctrlKey || key.metaKey) return false;
            router.replace('/');
            return true;
        },
    });
    return null;
});

/** The pane URL mirror follows this surface's visibility and route ownership. */
function SessionSurfacePaneUrlSync(props: Omit<React.ComponentProps<typeof SessionPaneUrlSyncHost>, 'surfaceVisible' | 'paneUrlSyncRouteActive'>) {
    const presence = useSessionSurfacePresence();
    return <SessionPaneUrlSyncHost {...props} surfaceVisible={presence.visible} paneUrlSyncRouteActive={presence.paneUrlSyncRouteActive} />;
}

/** The terminal commands follow the destination's focus and the whole pane scope: a leaf of their own. */
const SessionTerminalJumpShortcut = React.memo(function SessionTerminalJumpShortcut(props: Readonly<{ paneScopeId: string }>) {
    useTerminalJumpShortcut(props.paneScopeId);
    return null;
});

function SessionSurfaceTestIdsProvider(props: Readonly<{ children: React.ReactNode }>) {
    return <SessionScreenTestIdsProvider enabled={useSessionSurfacePresence().focused}>{props.children}</SessionScreenTestIdsProvider>;
}

const SessionWorkspaceFileOriginReturn = React.memo(function SessionWorkspaceFileOriginReturn(props: Readonly<{ scopeId: string }>) {
    useWorkspaceFileOriginReturn(props.scopeId, useSessionSurfaceActive());
    return null;
});

const SessionTranscriptCodeAskControls = React.memo(function SessionTranscriptCodeAskControls(
    props: Omit<React.ComponentProps<typeof TranscriptCodeAskControls>, 'active'>,
) {
    return <TranscriptCodeAskControls {...props} active={useSessionSurfaceActive()} />;
});

const SessionContentOverrideViewedLifecycle = React.memo(function SessionContentOverrideViewedLifecycle({
    serverId,
    sessionId,
}: Readonly<{
    serverId: string;
    sessionId: string;
}>) {
    const presence = useSessionSurfacePresence();
    const surfaceFocused = presence.visible && presence.focused;
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
    useSessionViewedLifecycle({
        address: { serverId, sessionId },
        surfaceFocused,
        visibleReadSeq: sessionSeq,
    });
    return null;
});

const SessionPendingMessagesRefresh = React.memo(function SessionPendingMessagesRefresh({
    sessionId,
    sessionAccepted,
}: Readonly<{
    sessionId: string;
    sessionAccepted: boolean;
}>) {
    const pendingVersion = storage((state) => state.sessions[sessionId]?.pendingVersion ?? null);

    React.useEffect(() => {
        if (!sessionAccepted) return;
        return runAfterInteractionsWithFallback(() => {
            fireAndForget(sync.fetchPendingMessages(sessionId), { tag: 'SessionView.fetchPendingMessages' });
        });
    }, [sessionAccepted, sessionId, pendingVersion]);

    return null;
});

const SessionTranscriptViewedLifecycle = React.memo(function SessionTranscriptViewedLifecycle({
    serverId,
    sessionId,
}: Readonly<{
    serverId: string;
    sessionId: string;
}>) {
    const presence = useSessionSurfacePresence();
    const surfaceFocused = presence.visible && presence.focused;
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
    const latestTurnStatus = useSessionViewLatestTurnStatus(sessionId);
    const visibleReadSeq = useSessionVisibleReadSeq(sessionId, {
        sessionSeq,
        latestTurnStatus,
    });
    useSessionViewedLifecycle({
        address: { serverId, sessionId },
        surfaceFocused,
        visibleReadSeq,
    });
    return null;
});

type ChatListProps = React.ComponentProps<typeof ChatList>;

type SessionTranscriptRenderStateInput = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
}>;

function resolveSessionTranscriptTimeline({
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
    committedMessagesCount,
}: Omit<SessionTranscriptRenderStateInput, 'sessionId'> & Readonly<{ committedMessagesCount: number }>) {
    const shouldForceRenderTranscriptFooter =
        isForkedSessionV1
        || readExternalSessionLink(readSessionOwnerMetadataView(session)) !== null
        || readExternalSessionOperationPresentationFromMetadata(session.metadata) !== null
        || ((session.seq ?? 0) > 0 && committedMessagesCount === 0);
    const shouldRenderChatTimeline = !isEncryptedSessionLocked
        && shouldRenderChatTimelineForSession({
            committedMessagesCount,
            pendingMessagesCount,
            controlledByUser: isLocallyAttached,
            // Some sessions can have a non-zero committed transcript seq but end up with 0 visible
            // main-timeline messages (e.g. newest page is sidechain-only). In that case, we must
            // still render the transcript so it can page backwards to find visible messages.
            forceRenderFooter: shouldForceRenderTranscriptFooter,
        });
    return { shouldForceRenderTranscriptFooter, shouldRenderChatTimeline };
}

/** The timeline-or-placeholder decision only: it depends on emptiness, so arriving messages do not re-render it. */
function useSessionTranscriptTimelineDecision({ sessionId, ...input }: SessionTranscriptRenderStateInput) {
    const { hasCommittedMessages } = useSessionTranscriptCommittedPresence(sessionId);
    return resolveSessionTranscriptTimeline({ ...input, committedMessagesCount: hasCommittedMessages ? 1 : 0 });
}

function useSessionTranscriptRenderState({
    sessionId,
    ...input
}: SessionTranscriptRenderStateInput) {
    const { ids: committedMessageIds, isLoaded } = useSessionTranscriptIds(sessionId);
    const { shouldForceRenderTranscriptFooter, shouldRenderChatTimeline } = resolveSessionTranscriptTimeline({
        ...input, committedMessagesCount: committedMessageIds.length,
    });
    return {
        committedMessagesCount: committedMessageIds.length,
        isLoaded,
        shouldForceRenderTranscriptFooter,
        shouldRenderChatTimeline,
    };
}

type SessionTranscriptViewLayoutProps = SessionTranscriptRenderStateInput & SessionViewLayoutProps;

const SessionTranscriptViewLayout = React.memo(function SessionTranscriptViewLayout({
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
    placeholder,
    ...layoutProps
}: SessionTranscriptViewLayoutProps) {
    const { shouldRenderChatTimeline } = useSessionTranscriptTimelineDecision({
        sessionId,
        session,
        isEncryptedSessionLocked,
        isForkedSessionV1,
        isLocallyAttached,
        pendingMessagesCount,
    });

    return (
        <SessionViewLayout
            {...layoutProps}
            placeholder={shouldRenderChatTimeline ? null : placeholder}
        />
    );
});

/**
 * The embedded arm's parts publication: the same elements the primary layout would place, handed to
 * the arrangement's slots (plan 05 §4.3.4). The placeholder follows the incumbent timeline rule.
 */
const SessionEmbeddedPartsPublisher = React.memo(function SessionEmbeddedPartsPublisher({
    transcript,
    composer,
    placeholder,
    arrangement,
    ...renderStateInput
}: SessionTranscriptRenderStateInput & Readonly<{
    transcript: React.ReactNode;
    composer: React.ReactNode;
    placeholder: React.ReactNode;
    arrangement: React.ReactNode | undefined;
}>) {
    const { shouldRenderChatTimeline } = useSessionTranscriptTimelineDecision(renderStateInput);
    const parts = React.useMemo<EmbeddedSessionPartsValue>(() => ({
        transcript,
        placeholder: shouldRenderChatTimeline ? null : placeholder,
        composer: composer ?? null,
        state: 'ready',
        chatBottomSpacing: 'none',
    }), [composer, placeholder, shouldRenderChatTimeline, transcript]);
    return (
        <EmbeddedSessionPartsProvider value={parts}>
            {arrangement ?? <EmbeddedSessionStandardLayout />}
        </EmbeddedSessionPartsProvider>
    );
});

type SessionTranscriptContentProps = Readonly<{
    sessionId: string;
    sessionSurfaceKey: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
    approvalRequests: ChatListProps['approvalRequests'];
    jumpToSeq: ChatListProps['jumpToSeq'];
    jumpToMessageId: ChatListProps['jumpToMessageId'];
    followBottomIntentKey: ChatListProps['followBottomIntentKey'];
    onViewportChange: ChatListProps['onViewportChange'];
    onEditPendingMessage: ChatListProps['onEditPendingMessage'];
    routeHydrationPending: ChatListProps['routeHydrationPending'];
}>;

const SessionTranscriptContent = React.memo(function SessionTranscriptContent({
    sessionId,
    sessionSurfaceKey,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
    approvalRequests,
    jumpToSeq,
    jumpToMessageId,
    followBottomIntentKey,
    onViewportChange,
    onEditPendingMessage,
    routeHydrationPending,
}: SessionTranscriptContentProps) {
    const transcriptSource = useSessionTranscriptSource();
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

    const {
        committedMessagesCount,
        isLoaded,
        shouldForceRenderTranscriptFooter,
        shouldRenderChatTimeline,
    } = useSessionTranscriptRenderState({
        sessionId,
        session,
        isEncryptedSessionLocked,
        isForkedSessionV1,
        isLocallyAttached,
        pendingMessagesCount,
    });
    const transcriptLoadIssue = storage((state) => state.sessionTranscriptLoadIssues[sessionId] ?? null);
    const { shouldRenderChatTimelineImmediately } = resolveTranscriptTimelinePresence({
        committedMessagesCount, pendingMessagesCount, isLoaded, shouldRenderChatTimeline, shouldForceRenderTranscriptFooter,
        hasTranscriptLoadIssue: transcriptLoadIssue !== null,
    });
    const shouldShowDeferredTranscriptPlaceholder =
        shouldRenderChatTimeline && !shouldRenderChatTimelineImmediately && transcriptLoadIssue === null;

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
                pendingMessages: pendingMessagesCount,
                sessionSeq: Math.max(0, Math.trunc(session.seq ?? 0)),
                transcript,
            },
        );
    }, [
        committedMessagesCount,
        isEncryptedSessionLocked,
        isLoaded,
        pendingMessagesCount,
        session.seq,
        sessionId,
        shouldRenderChatTimeline,
    ]);

    const handleTranscriptJumpLanded = React.useCallback<NonNullable<ChatListProps['onJumpLanded']>>((result) => {
        const address = transcriptSource.sessionId === sessionId
            ? normalizeSessionAddress(transcriptSource.serverId, sessionId)
            : null;
        if (address) applyTranscriptJumpHighlightForJumpResult(address, result);
    }, [sessionId, transcriptSource.serverId, transcriptSource.sessionId]);

    return (
        <>
            {/* A transcript-load issue is a Session notice (SessionTranscriptLoadIssueNotice in the composer seat). */}
            {/* Who is using the Session's shared window, at the top of the transcript on every device (lab computer HC). */}
            {shouldRenderChatTimeline ? <SessionComputerPresenceLine sessionId={sessionId} serverId={session.serverId ?? null} /> : null}
            {/* Phone: the viewer docks sticky at the top of the reading flow, the transcript beneath (63s3). */}
            {shouldRenderChatTimeline ? <SessionViewerStickySlot sessionId={sessionId} serverId={session.serverId ?? null} /> : null}
            {shouldRenderChatTimeline && shouldRenderChatTimelineImmediately ? (
                <ChatList
                    session={session}
                    sessionSurfaceKey={sessionSurfaceKey}
                    jumpToSeq={jumpToSeq}
                    jumpToMessageId={jumpToMessageId}
                    followBottomIntentKey={followBottomIntentKey}
                    approvalRequests={approvalRequests}
                    onViewportChange={onViewportChange}
                    onEditPendingMessage={onEditPendingMessage}
                    onJumpLanded={handleTranscriptJumpLanded}
                    routeHydrationPending={routeHydrationPending}
                />
            ) : null}
            {shouldShowDeferredTranscriptPlaceholder ? (
                <PaneLoadingFallback />
            ) : null}
        </>
    );
});

/** Whether the timeline paints now, and whether it shows retained rows a load issue stands over. */
function resolveTranscriptTimelinePresence(input: Readonly<{
    committedMessagesCount: number;
    pendingMessagesCount: number;
    isLoaded: boolean | undefined;
    shouldRenderChatTimeline: boolean;
    shouldForceRenderTranscriptFooter: boolean;
    hasTranscriptLoadIssue: boolean;
}>): Readonly<{ shouldRenderChatTimelineImmediately: boolean; retainedTranscriptVisible: boolean }> {
    const hasRetainedTranscript = input.committedMessagesCount > 0;
    const hasPresentableRows = hasRetainedTranscript || input.pendingMessagesCount > 0;
    const shouldRenderChatTimelineImmediately = input.shouldRenderChatTimeline
        && (
            input.isLoaded === true
            || hasPresentableRows
            || (input.shouldForceRenderTranscriptFooter && !input.hasTranscriptLoadIssue)
        );
    return { shouldRenderChatTimelineImmediately, retainedTranscriptVisible: hasRetainedTranscript && shouldRenderChatTimelineImmediately };
}

/**
 * A transcript that failed to load or refresh is a Session-wide notice: it stands in the composer's banner seat
 * with the Session's other notices, its retry kept, whether or not a timeline is retained behind it
 * (owner 2026-11-11; PATTERN-AUDIT-UI-1111 E). The transcript body never repeats it.
 */
type SessionTranscriptLoadIssueNoticeProps = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
}>;

const SessionTranscriptLoadIssueNotice = React.memo(function SessionTranscriptLoadIssueNotice(props: SessionTranscriptLoadIssueNoticeProps) {
    // Only an issue mounts the transcript render-state read: the seat stays still on ordinary sequence updates.
    const hasTranscriptLoadIssue = storage((state) => state.sessionTranscriptLoadIssues[props.sessionId] != null);
    return hasTranscriptLoadIssue ? <SessionTranscriptLoadIssueBody {...props} /> : null;
});

const SessionTranscriptLoadIssueBody = React.memo(function SessionTranscriptLoadIssueBody(props: SessionTranscriptLoadIssueNoticeProps) {
    const { committedMessagesCount, isLoaded, shouldForceRenderTranscriptFooter, shouldRenderChatTimeline } = useSessionTranscriptRenderState(props);
    const { retainedTranscriptVisible } = resolveTranscriptTimelinePresence({
        committedMessagesCount, pendingMessagesCount: props.pendingMessagesCount, isLoaded, shouldRenderChatTimeline,
        shouldForceRenderTranscriptFooter, hasTranscriptLoadIssue: true,
    });
    // Whether rows are retained only chooses the words ("Showing the last known transcript" over rows, the failure
    // itself with none); the notice stands in the seat either way.
    return (
        <ExternalTranscriptLoadIssueBanner sessionId={props.sessionId} serverId={props.session.serverId ?? null}
            machineId={readSessionOwnerMetadataView(props.session)?.machineId ?? null} agentId={readSessionPresentationAgentId(props.session)}
            retainedTranscriptVisible={retainedTranscriptVisible} />
    );
});

type SessionTranscriptPlaceholderProps = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
    /** The queued-input read finished (or failed): the transcript's own pending owner, `useSessionPendingMessages`. */
    pendingMessagesSettled: boolean;
    restoreSecretKeyColor: string;
    restoreSecretKeyDescriptionColor: string;
    restoreButtonBackgroundColor: string;
    restoreButtonBorderColor: string;
    /** `null` in an embedded arm: a mount never offers the account repair flow or leaves its frame. */
    onRestoreSecretKeyPress: (() => void) | null;
    activityColor: string;
}>;

/**
 * Reports one typed transcript-load issue.
 *
 * The same issue means two different things to a reader depending on what is
 * behind the banner. Over a timeline that still shows its last known content,
 * the transcript is readable and only its refresh failed; with no timeline at
 * all, there is nothing safe to read. Saying "unavailable" in both places hides
 * from the reader that the rows in front of them are retained and may be stale.
 */
const ExternalTranscriptLoadIssueBanner = React.memo(function ExternalTranscriptLoadIssueBanner({
    sessionId,
    serverId,
    machineId,
    agentId,
    retainedTranscriptVisible = false,
}: Readonly<{ sessionId: string; serverId: string | null; machineId: string | null; agentId: string | null; retainedTranscriptVisible?: boolean }>) {
    const issue = storage((state) => state.sessionTranscriptLoadIssues[sessionId] ?? null);
    // The same catalog identity the header mark reads names the Agent in a format failure.
    const agentName = useAgentCatalogIdentities({ agentIds: agentId ? [agentId] : [], machineId, serverId })[0]?.entry.title ?? null;
    const [retrying, setRetrying] = React.useState(false);
    const retryInFlightRef = React.useRef(false);
    // The same where-and-why context the Files pane gives: the Machine or Home the read could not reach.
    const machineName = useServerScopedMachineLabel(serverId, machineId);
    const homeProfile = serverId ? getServerProfileById(serverId) : null;
    // Only a saved Home has a name to give; an unknown profile would read as the product name.
    const homeLabel = useHomeDisplayLabel(homeProfile);
    const homeName = homeProfile ? homeLabel || null : null;
    const presented = issue ? presentTranscriptLoadIssue(issue, { retainedTranscriptVisible, machineName, homeName, agentName }) : null;
    const retryable = presented?.retryable ?? false;
    const handleRetry = React.useCallback(async () => {
        if (!retryable || retryInFlightRef.current) return;
        retryInFlightRef.current = true;
        setRetrying(true);
        try {
            // The shared message queue owns retry/backoff and may continue recovering in the
            // background. The banner action only needs to enqueue a fresh attempt; waiting for
            // an unbounded queue would make the Retry control look stuck again.
            await sync.refreshSessionMessages(sessionId, { awaitQueue: false });
        } catch {
            // Sync records the typed failure at the transcript-loading owner. Keep the
            // banner mounted with that current outcome instead of creating a second error path.
        } finally {
            retryInFlightRef.current = false;
            setRetrying(false);
        }
    }, [retryable, sessionId]);

    if (!issue || !presented) return null;

    const banner = (
                <WarningActionBanner
                    testID="session.externalTranscript.loadIssue"
                    title={presented?.title}
                    body={presented?.body}
                    actionLabel={retryable ? t('common.retry') : undefined}
                    actionAccessibilityLabel={retryable ? t('common.retry') : undefined}
                    actionTestID={retryable ? 'session.externalTranscript.loadIssue.retry' : undefined}
                    onActionPress={retryable ? handleRetry : undefined}
                    actionBusy={retrying}
                    disabled={retrying}
                />
    );
    return <ComposerAuxiliaryFrame>{banner}</ComposerAuxiliaryFrame>;
});

const SessionTranscriptPlaceholder = React.memo(function SessionTranscriptPlaceholder({
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
    pendingMessagesSettled,
    restoreSecretKeyColor,
    restoreSecretKeyDescriptionColor,
    restoreButtonBackgroundColor,
    restoreButtonBorderColor,
    onRestoreSecretKeyPress,
    activityColor,
}: SessionTranscriptPlaceholderProps) {
    const { isLoaded, shouldRenderChatTimeline } = useSessionTranscriptRenderState({
        sessionId,
        session,
        isEncryptedSessionLocked,
        isForkedSessionV1,
        isLocallyAttached,
        pendingMessagesCount,
    });
    const transcriptLoadIssue = storage((state) => state.sessionTranscriptLoadIssues[sessionId] ?? null);

    if (shouldRenderChatTimeline) return null;

    if (isEncryptedSessionLocked && onRestoreSecretKeyPress === null) return <EmbeddedSessionUnavailable />;

    if (isEncryptedSessionLocked) {
        return (
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
                    <Text style={{ ...Typography.variant('heading'), color: restoreSecretKeyColor }}>
                        {t('navigation.restoreWithSecretKey')}
                    </Text>
                    <Text style={{ ...Typography.variant('reading'), color: restoreSecretKeyDescriptionColor }}>
                        {t('connect.restoreWithSecretKeyDescription')}
                    </Text>
                    <Pressable
                        testID="session-encrypted-locked-restore"
                        onPress={onRestoreSecretKeyPress}
                        style={({ pressed }) => ({
                            alignSelf: 'flex-start',
                            paddingVertical: 12,
                            paddingHorizontal: 14,
                            borderRadius: 12,
                            backgroundColor: restoreButtonBackgroundColor,
                            borderWidth: 1,
                            borderColor: restoreButtonBorderColor,
                            opacity: pressed ? 0.7 : 1,
                        })}
                    >
                        <Text style={{ fontSize: 14, color: restoreSecretKeyColor }}>
                            {t('connect.restoreWithSecretKeyInstead')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    // The failure is stated once, in the composer seat (SessionTranscriptLoadIssueNotice): the body stays clear.
    if (transcriptLoadIssue) return null;

    // "No messages yet" is a settled fact only once queued input has been read too: a cold open reads
    // the queue after the committed transcript, and a queued-only Session was flashing empty first.
    return isLoaded && pendingMessagesSettled ? (
        <EmptyMessages session={session} />
    ) : (
        <ActivitySpinner size="small" color={activityColor} />
    );
});

export const SessionView = React.memo((props: SessionViewProps) => {
    const sessionId = normalizeSessionId(props.id);
    const explicitRouteAddress = normalizeSessionAddress(
        props.routeHydrationState?.serverId ?? props.routeServerId,
        sessionId,
    );
    const routeAddress = explicitRouteAddress ?? normalizeSessionAddress(
        resolveServerIdForSessionIdFromLocalCache(sessionId),
        sessionId,
    );
    const sessionSurfaceKey = routeAddress ? sessionAddressKey(routeAddress) : null;

    if (routeAddress === null || sessionSurfaceKey === null) {
        if (props.presentation?.kind === 'embedded') {
            const loading = props.routeHydrationState?.kind === 'loading';
            return (
                <PluginSurfaceNestingBoundary>
                <EmbeddedSessionStatePublication
                    state={loading ? 'loading' : 'unavailable'}
                    transcript={loading ? (
                        <PaneLoadingFallback />
                    ) : <EmbeddedSessionUnavailable />}
                    arrangement={props.embeddedArrangement}
                />
                </PluginSurfaceNestingBoundary>
            );
        }
        if (props.routeHydrationState?.kind === 'loading') {
            return <SessionViewRouteLoading initialLoading serverId={props.routeHydrationState.serverId ?? props.routeServerId ?? null} />;
        }
        return <SessionInvalidLinkFallback sessionId={sessionId} homeChoice="unknown" />;
    }

    const surface = (
        <SessionViewRetainedSurface
            key={sessionSurfaceKey}
            {...props}
            routeServerId={routeAddress.serverId}
            sessionId={sessionId}
            sessionSurfaceKey={sessionSurfaceKey}
        />
    );
    const embeddedPresentation = props.presentation?.kind === 'embedded';
    // Focus and visibility reach this surface's readers through the presence context, not as props:
    // a workspace tab switch renders those readers only.
    return (
        <SessionSurfacePresenceProvider
            sessionId={sessionId}
            focusedOverride={typeof props.surfaceFocusedOverride === 'boolean' ? props.surfaceFocusedOverride : null}
            visibleOverride={typeof props.surfaceVisibleOverride === 'boolean' ? props.surfaceVisibleOverride : null}
            sceneActive={typeof props.surfaceSceneActive === 'boolean' ? props.surfaceSceneActive : null}
            routeAnchorOverride={props.routeAnchorOverride ?? null}
            presentedWhileVisible={embeddedPresentation || typeof props.surfaceVisibleOverride === 'boolean'
                || typeof props.surfaceSceneActive === 'boolean'}
        >
            {embeddedPresentation
                // The embedded arm's part claims outlive the per-Session surface, so a Session moving between
                // loading, ready and blocked re-publishes its parts into the same slots.
                ? <PluginSurfaceNestingBoundary><EmbeddedSessionPartClaimsScope>{surface}</EmbeddedSessionPartClaimsScope></PluginSurfaceNestingBoundary>
                : <SessionSurfaceAtmosphereFrame address={routeAddress}>{surface}</SessionSurfaceAtmosphereFrame>}
        </SessionSurfacePresenceProvider>
    );
});

function SessionSurfaceAtmosphereFrame(props: Readonly<{ address: SessionAddress; children: React.ReactNode }>) {
    const presence = useSessionSurfacePresence();
    const surface = React.useMemo(() => ({ session: props.address }), [props.address]);
    return <AtmosphereSurfaceFrame surface={surface} session focused={presence.focused} visible={presence.visible}>{props.children}</AtmosphereSurfaceFrame>;
}

const EMBEDDED_PANE_DRIVER_OPTIONS = Object.freeze({ registerDriver: false });

// An embedded Session hosts no Board, so no Board item ever takes its executable mount.

const SessionViewRetainedSurface = React.memo((props: SessionViewProps & {
    sessionId: string;
    sessionSurfaceKey: string;
}) => {
    // Hosts supply visibility independently of focus and route ownership.
    const isPresented = useSessionSurfacePresence().presented;
    const [hasBeenPresented, setHasBeenPresented] = React.useState(isPresented);
    React.useLayoutEffect(() => {
        if (isPresented && !hasBeenPresented) {
            setHasBeenPresented(true);
        }
    }, [hasBeenPresented, isPresented]);

    if (!hasBeenPresented && !isPresented) {
        return <View style={{ flex: 1 }} />;
    }

    const accessibilityProps = Platform.OS === 'web'
        ? {
            'aria-hidden': !isPresented,
            inert: !isPresented,
        }
        : {
            accessibilityElementsHidden: !isPresented,
            importantForAccessibility: isPresented ? ('auto' as const) : ('no-hide-descendants' as const),
        };

    return (
        <View
            testID={`session-view-retained-surface:${props.sessionId}`}
            pointerEvents={isPresented ? 'auto' : 'none'}
            style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                opacity: isPresented ? 1 : 0,
            }}
            {...accessibilityProps}
        >
            <SessionViewFocusedSurface {...props} />
        </View>
    );
});

type SessionViewFocusedSurfaceProps = SessionViewProps & {
    sessionId: string;
    sessionSurfaceKey: string;
};

const SessionViewFocusedSurface = React.memo((props: SessionViewFocusedSurfaceProps) => (
    props.presentation?.kind === 'embedded'
        ? <SessionViewFocusedSurfaceEmbeddedOwner {...props} />
        : props.sessionPluginRuntime
        ? <SessionBoardControllerProvider
            key={`session-board-controller:${props.sessionSurfaceKey}`}
            sessionId={props.sessionId}
            serverId={props.routeHydrationState?.serverId ?? props.routeServerId ?? null}
            pluginRuntime={props.sessionPluginRuntime}
            // The same derived placement the Board, sidebar, Companion and mobile
            // hosts receive as a prop, published for hosts too deep in this shell
            // to be prop-drilled — the inline transcript reference.
        >
            <SessionViewFocusedSurfaceContent
                {...props}
                sessionPluginRuntime={props.sessionPluginRuntime}
            />
        </SessionBoardControllerProvider>
        : <SessionViewFocusedSurfaceBoardOwner {...props} />
));

/** The embedded arm mounts no Board controller: its Session exposes no Board of its own. */
const SessionViewFocusedSurfaceEmbeddedOwner = React.memo((props: SessionViewFocusedSurfaceProps) => {
    const serverId = props.routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const address = useSessionAddressForSessionId(props.sessionId, serverId);
    const sessionPluginRuntime = useSessionPluginRuntime({ address });
    return (
        <SessionViewFocusedSurfaceContent
            {...props}
            sessionPluginRuntime={props.sessionPluginRuntime ?? sessionPluginRuntime}
        />
    );
});

const SessionViewFocusedSurfaceBoardOwner = React.memo((props: SessionViewFocusedSurfaceProps) => {
    const serverId = props.routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const address = useSessionAddressForSessionId(props.sessionId, serverId);
    const sessionPluginRuntime = useSessionPluginRuntime({ address });
    return (
        <SessionBoardControllerProvider
            key={`session-board-controller:${props.sessionSurfaceKey}`}
            sessionId={props.sessionId}
            serverId={address?.serverId ?? serverId}
            pluginRuntime={sessionPluginRuntime}
        >
            <SessionViewFocusedSurfaceContent
                {...props}
                sessionPluginRuntime={sessionPluginRuntime}
            />
        </SessionBoardControllerProvider>
    );
});

type SessionViewFocusedSurfaceContentProps = SessionViewFocusedSurfaceProps & {
    sessionPluginRuntime: SessionPluginRuntimeState;
};

const SessionViewFocusedSurfaceContent = React.memo((props: SessionViewFocusedSurfaceContentProps) => (
    <PluginSurfacePaneLaunchScope accountLifetime={props.sessionPluginRuntime.accountLifetime}>
        <SessionViewFocusedSurfaceContentBody {...props} />
    </PluginSurfacePaneLaunchScope>
));

const SessionViewFocusedSurfaceContentBody = React.memo((props: SessionViewFocusedSurfaceContentProps) => {
    const sessionId = props.sessionId;
    // Presence starts and stops this surface's work by subscription; its drawn readers are leaves. A tab
    // switch renders none of this body.
    const surfacePresence = useSessionSurfacePresenceSignal();
    const surfacePresentedSignal = React.useMemo(() => ({
        get: () => surfacePresence.get().presented, subscribe: surfacePresence.subscribe,
    }), [surfacePresence]);
    const surfaceFocusedSignal = React.useMemo(() => ({
        get: () => { const current = surfacePresence.get(); return current.visible && current.focused; },
        subscribe: surfacePresence.subscribe,
    }), [surfacePresence]);
    const surfaceVisibleSignal = React.useMemo(() => ({
        get: () => surfacePresence.get().visible, subscribe: surfacePresence.subscribe,
    }), [surfacePresence]);
    const router = useNewSessionEntryRouter();
    const pathname = useDestinationPathname();
    const routeParams = useDestinationParams<{ mobileSurface?: string | string[] }>();
    const routeMobileSurface = Array.isArray(routeParams.mobileSurface)
        ? routeParams.mobileSurface[0]
        : routeParams.mobileSurface;
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const auth = useAuth();
    const routeHydrationState = props.routeHydrationState ?? null;
    const expectedRouteServerId = routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const session = useSessionViewShellSession(sessionId, expectedRouteServerId);
    const ownerMetadata = session
        ? readSessionOwnerMetadataView(session)
        : null;
    const embedded = readEmbeddedSessionPresentation(props.presentation);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const executionRunServerId = expectedRouteServerId ?? session?.serverId ?? null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs', executionRunServerId
        ? { scopeKind: 'spawn', serverId: executionRunServerId }
        : undefined);
    const browserContextFeatureEnabled = useFeatureEnabled('browser.context');
    const handleBackPress = React.useCallback(() => {
        safeRouterBack({
            router,
            fallbackHref: '/',
        });
    }, [router]);
    const acceptedSessionId = session ? sessionId : '';
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(
        session?.metadataProjection === 'displayOnly' ? '' : acceptedSessionId,
        executionRunServerId,
    );
    const approvalSessionAddress = normalizeSessionAddress(
        expectedRouteServerId ?? session?.serverId,
        sessionId,
    );
    const approvalRequests = useComposerApprovalArtifactsForSession(approvalSessionAddress, COMPOSER_SETTLED_APPROVAL_PRESENTATIONS);
    // The transcript also keeps decided approvals whose body has a settled presentation (AGW-8).
    const transcriptApprovalRequests = useTranscriptApprovalArtifactsForSession(approvalSessionAddress, TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS);
    const safeArea = useChromeSafeAreaInsets();
    const safeAreaTopInset = props.safeAreaTopMode === 'external' ? 0 : safeArea.top;
    const headerSafeAreaTopMode = props.headerSafeAreaTopMode ?? props.safeAreaTopMode ?? 'internal';
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const { width: windowWidth } = useWindowDimensions();
    const isTablet = useIsTablet();
    const hasAuthCredentials = Boolean(auth.credentials);
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const explicitRouteServerId = (routeHydrationState?.serverId ?? props.routeServerId ?? '').trim();
    const currentSessionRouteServerId =
        explicitRouteServerId
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || getActiveServerSnapshot().serverId;
    const destinationAccountBinding = useSessionDestinationAccountBinding(sessionId, currentSessionRouteServerId);
    const destinationOwnsAccountBinding = destinationAccountBinding !== undefined;
    const routeAccountBindingServerIds = React.useMemo(
        () => !destinationOwnsAccountBinding && currentSessionRouteServerId ? [currentSessionRouteServerId] : [],
        [currentSessionRouteServerId, destinationOwnsAccountBinding],
    );
    const routeAccountBindings = useServerCredentialAccountScopeBindings(routeAccountBindingServerIds);
    const routeAccountBinding = destinationOwnsAccountBinding ? destinationAccountBinding : routeAccountBindings.values().next().value as
        | ServerCredentialAccountScopeBinding
        | undefined;
    const sessionAccountBinding = routeAccountBinding && (isEmbedWindowContext() || routeAccountBinding.isCurrent())
        ? routeAccountBinding
        : null;
    const scopedSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, currentSessionRouteServerId);
    }, [currentSessionRouteServerId, syncError]);
    const authSurfaceState = React.useMemo(() => {
        return resolveSessionAuthSurfaceState({
            endpointStatus: endpointConnectivity.status,
            syncError: scopedSyncError,
            routeHydrationState,
        });
    }, [endpointConnectivity.status, routeHydrationState, scopedSyncError]);
    const sessionContentAvailability = session ? readSessionContentAvailability(session) : null;
    const blockedSurfaceState = React.useMemo(() => resolveSessionBlockedSurfaceState({
        authSurfaceState,
        routeHydrationState,
        sessionPresent: session !== null,
        contentAvailability: sessionContentAvailability,
    }), [authSurfaceState, routeHydrationState, session, sessionContentAvailability]);
    const headerBlockedSurface = blockedSurfaceState && blockedSurfaceState.kind !== 'account_recovery'
        ? blockedSurfaceState.kind
        : null;
    const buildCurrentSessionHref = React.useCallback((suffix = '') => {
        return buildScopedSessionRouteHref({
            sessionId,
            serverId: currentSessionRouteServerId,
            suffix,
        });
    }, [currentSessionRouteServerId, sessionId]);
    const sessionEncryptionMode: 'e2ee' | 'plain' = (session?.encryptionMode ?? 'e2ee');
    const isEncryptedSessionLocked = Boolean(session && sessionEncryptionMode === 'e2ee' && !hasAuthCredentials);
    const showTopHeader = !embedded && !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web');
    const routeHydrationInFlight =
        routeHydrationState?.kind === 'loading' ||
        routeHydrationState?.kind === 'retrying';
    const routeHydrationPending =
        routeHydrationState?.kind === 'loading' ||
        routeHydrationState?.kind === 'retrying';
    const routeHydrationLoading = !session && routeHydrationState?.kind === 'loading';
    const routeHydrationRetrying = !session && routeHydrationState?.kind === 'retrying';
    const routeHydrationRetryStatusKey = routeHydrationRetrying
        ? resolveRouteHydrationRetryStatusKey(routeHydrationState.cause)
        : null;
    const routeHydrationTerminalMissing = !session && routeHydrationState?.kind === 'missing';

    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const workspaceRefsV1 = useWorkspaceRefs();
    const headerMachineTarget = useSessionReachableMachineTarget(sessionId, currentSessionRouteServerId);
    const statusControlMachineTarget = useSessionMachineControlTarget(sessionId, currentSessionRouteServerId);
    const currentSessionMachineId = statusControlMachineTarget?.machineId
        ?? headerMachineTarget?.machineId
        ?? null;
    const sessionRunnerRuntimeStatusRetention = useSessionRunnerRuntimeStatusRetention({
        enabled: Boolean(session),
        active: surfacePresentedSignal,
        accountLifetime: sessionAccountBinding,
        serverId: currentSessionRouteServerId,
        sessionId,
        machineId: statusControlMachineTarget?.machineId
            ?? headerMachineTarget?.machineId
            ?? ownerMetadata?.machineId,
        activeSelectionRunnerKey: ownerMetadata?.sessionModelsV1?.activeSelectionV1
            ? JSON.stringify(ownerMetadata.sessionModelsV1.activeSelectionV1.runner)
            : null,
    });
    const resourceNavigationRef = React.useRef<PluginSurfaceDestinationNavigationBinding | undefined>(undefined);
    const paneDriverOptions = React.useMemo(() => embedded ? EMBEDDED_PANE_DRIVER_OPTIONS : {
        readResourceNavigation: () => resourceNavigationRef.current,
    }, [embedded]);
    const paneScopeId = useRegisterSessionPaneDriver(
        sessionId,
        props.routeServerId,
        props.sessionPluginRuntime,
        paneDriverOptions,
    );
    const actionRailVisible = useAppPaneActionRailVisible(paneScopeId);
    // Without a visible rail the header's ⋯ reaches Terminal and Browser through their own openers.
    const headerTerminalAction = useSessionTerminalAction({ sessionId, scopeId: paneScopeId, serverId: props.routeServerId ?? null });
    const headerBrowserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const headerBrowserTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const browserMenuEntryAvailable = headerBrowserDecision?.state === 'enabled'
        && headerBrowserTargetsDecision?.state === 'enabled';
    // The cockpit chrome names the shown Session: this view follows only whether its own has a Terminal tab.
    const cockpitTerminalTabAvailable = useSessionCockpitTerminalTabAvailable(sessionId);
    const mobileTerminalTabAvailable = deviceType === 'phone' && cockpitTerminalTabAvailable;
    const sessionsRightPaneDefaultOpen = useLocalSetting('sessionsRightPaneDefaultOpen');
    const {
        mobileWorkspaceExperience,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();
    const {
        pane,
        machineReachable: isMachineReachable,
        machineReachability,
        machinePower: headerMachinePower,
    } = useSessionViewBootstrap({
        sessionId,
        serverId: session?.serverId ?? currentSessionRouteServerId,
        paneScopeId,
        sessionPath: ownerMetadata?.path ?? null,
        sessionAccepted: session != null,
    });
    const { messages: pendingMessages, isLoaded: pendingMessagesLoaded, readState: pendingReadState } = useSessionPendingMessages(sessionId);
    const managedWakePresentation = useSessionManagedWakePresentation({
        session: !headerBlockedSurface ? session : null,
        active: surfacePresentedSignal,
        accountLifetime: sessionAccountBinding,
        machineReachable: machineReachability === 'unknown' ? null : isMachineReachable,
        pendingMessages, pendingLoaded: pendingMessagesLoaded, pendingReadState,
    });
    const stableSessionForLoadedView = session;
    const stableSessionForHeader = stableSessionForLoadedView ?? session;
    const externalSessionRuntime = useExternalSessionRuntime({
        // This surface already holds the qualified address, so the runtime must not
        // re-derive the Home through the bare-Session-id legacy boundary: that
        // resolver returns nothing when the same Session id exists on two Homes,
        // which would send status reads, transcript leases and takeover to no Home.
        serverId: expectedRouteServerId ?? session?.serverId ?? null,
        sessionId: acceptedSessionId,
        metadata: ownerMetadata,
        enabled: sessionId.length > 0 && session != null,
        active: surfaceFocusedSignal,
    });
    const externalSessionRuntimePresentation = useSessionExternalRuntimePresentation(
        stableSessionForHeader ?? null, externalSessionRuntime.externalSessionLink !== null, surfaceVisibleSignal);
    const externalSessionIdentityPresentation = React.useMemo(
        () => resolveExternalSessionIdentityPresentation(ownerMetadata, currentSessionMachineId),
        [currentSessionMachineId, ownerMetadata],
    );
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads');
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(acceptedSessionId, currentSessionRouteServerId, 'attachment');
    const attachmentsUploadsEnabled = attachmentsUploadsFeatureEnabled
        && resolveEmbeddedComposerControls(embedded)?.attachments !== false;
    const attachmentsUploadsAvailable = attachmentsUploadsEnabled && attachmentsUploadsTransferAvailable;
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntime({
        // The runtime only serves this Session's own subtree (its composer and Browser pane); it is not a
        // focus-elected target, so a visible pane keeps it while another pane has focus.
        enabled: browserContextFeatureEnabled && session != null,
        scopeKey: acceptedSessionId,
        sessionId: acceptedSessionId,
        accountScope: sessionAccountBinding?.scope,
        attachmentsUploadsEnabled: attachmentsUploadsAvailable,
        nowMs: nowServerMs,
        onAttachUnavailable: alertBrowserContextUnavailable,
    });
    // The narrow width: this shell needs the numbers and the recipient list, not the transcript
    // detail the Agents pane pays for. The counts come from the ONE owner, so the header glyph and
    // the pane it opens cannot report different amounts of work.
    const sessionAgentActivity = useSessionAgentActivity({
        sessionId: acceptedSessionId,
        serverId: expectedRouteServerId ?? undefined,
        session,
        externalSessionRuntime,
    });
    const { counts: subagentCounts, participantTargets } = sessionAgentActivity;
    // The one owner of this Session's Work sources (ORC R-09): the header strip reads its summary,
    // the Work tab and the Session body read the same sources through context.
    const runningWorkCount = useSessionSelector(acceptedSessionId, expectedRouteServerId ?? session?.serverId, current =>
        current ? projectUiSessionAwareness(current, nowServerMs(), {
            includeTitle: false, includeWorkspace: false, includeWork: false,
        }).runningWorkCount : undefined);
    const sessionWorkSources = useSessionWorkSourcesOwner({
        sessionId: acceptedSessionId,
        serverId: expectedRouteServerId ?? session?.serverId ?? null,
        ownerMetadata,
        runningWorkCount,
        agentActivity: sessionAgentActivity,
        enabled: acceptedSessionId !== '',
    });
    const workSummary = useStableWorkSummary(sessionWorkSources.projection.summary);
    const shouldShowSubagentsButton = subagentCounts.total > 0 || sessionExecutionRunsSupported || hasSessionSubagentLaunchCards(session);

    const sessionAutomationsEnabledCount = useEnabledAutomationsCountForSession(sessionId, {
        enabled: showAutomations && acceptedSessionId !== '',
        serverId: currentSessionRouteServerId ?? undefined,
    });
    const paneRef = React.useRef(pane);
    paneRef.current = pane;
    // The mounted AppPane host owns pane selection and persistence. This
    // session-scoped input handoff is the existing generic pane scope shared
    // with the sidebar mount, so the shell can remain its one target owner
    // before the sidebar is selected.
    const sessionPaneLaunchScope = usePluginSurfacePaneLaunchScope();
    const [appPaneNavigationBinding, setAppPaneNavigationBinding] = React.useState<
        PluginSurfaceDestinationNavigationBinding | undefined
    >(undefined);
    const handleAppPanePluginSurfaceNavigationBindingChange = React.useCallback((
        binding: PluginSurfaceDestinationNavigationBinding | undefined,
    ) => {
        resourceNavigationRef.current = binding;
        setAppPaneNavigationBinding(binding);
    }, []);
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(
        session ? sessionId : null,
        props.routeServerId,
        session,
    );
    const routerRef = React.useRef(router);
    routerRef.current = router;
    const toggleWorkspaceExperienceRef = React.useRef(toggleWorkspaceExperience);
    toggleWorkspaceExperienceRef.current = toggleWorkspaceExperience;

    // The one qualified Session address this header works from: the exact Home
    // and Session every address-scoped destination (Collaboration, Board,
    // Companion) is bound to.
    const sessionRouteAddress = React.useMemo(
        () => normalizeSessionAddress(currentSessionRouteServerId, sessionId),
        [currentSessionRouteServerId, sessionId],
    );
    const collaborationAdmitted = useSessionCollaborationDestinationEntryAdmitted(currentSessionRouteServerId ?? '');
    const collaborationAvailable = session !== null && sessionRouteAddress !== null && collaborationAdmitted;
    // The composer's access chip hands off to Collaboration on a narrow window (no pointer geometry to anchor
    // its editor). That is a window fact, kept as it was; the header's own fold is measured (SessionPaneHeader).
    const foldCollaborationHeaderEntry = windowWidth < 520;
    const collaborationHeader = React.useMemo(() => collaborationAvailable && sessionRouteAddress
        ? { target: sessionRouteAddress }
        : undefined, [collaborationAvailable, sessionRouteAddress]);
    const openSessionCollaboration = useOpenSessionCollaboration({ target: sessionRouteAddress, pane });
    const openSessionAccess = useOpenSessionCollaboration({ target: sessionRouteAddress, pane, focusTarget: 'access' });
    const mountedBoardForHeader = useMountedSessionBoardController(sessionRouteAddress);
    const boardIsOpen = isSessionBoardVisibleInDetails(pane.scopeState?.details);
    const boardHasContent = mountedBoardForHeader?.binding.status === 'ready'
        && mountedBoardForHeader.binding.snapshot.itemsById.size > 0;
    const openSessionBoard = React.useCallback(() => {
        paneRef.current.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' });
    }, []);

    // The same exact-Home `sessions.board` decision the sidebar tab, the Details
    // destination, the Companion surfaces and the mobile Cockpit apply.
    const boardDestinationAvailable = useSessionBoardFeatureEnabled(currentSessionRouteServerId);
    const repeatableWorkflow = useWorkflowMakeRepeatable({ sessionId, serverId: currentSessionRouteServerId });
    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === 'header.makeRepeatable') {
            repeatableWorkflow.openRepeatable();
            return true;
        }
        if (actionId === 'header.openCollaboration') {
            openSessionCollaboration();
            return true;
        }
        // Share opens People at Access through the mounted Session's own opener, which switches a phone cockpit.
        if (actionId === 'header.share') {
            openSessionAccess();
            return true;
        }
        if (actionId === 'header.openAttachedSessionTerminal') {
            attachedSessionTerminal.open();
            return true;
        }
        if (actionId === SESSION_BOARD_HEADER_MENU_ACTION_ID) {
            openSessionBoard();
            return true;
        }
        if (actionId === SESSION_HEADER_MENU_OPEN_TERMINAL_ID) {
            headerTerminalAction.onPress();
            return true;
        }
        if (actionId === SESSION_HEADER_MENU_OPEN_BROWSER_ID) {
            paneRef.current.openRight({ tabId: getRightSidebarBuiltinTab('browser').id });
            return true;
        }
        if (actionId === 'header.openSubagents') {
            paneRef.current.openRight({ tabId: 'agents' });
            paneRef.current.setRightTab('agents');
            return true;
        }
        if (actionId === 'header.openAutomations') {
            // A Session's automations are edited in one place, Info › Automations (merged Session lab OQ10): the
            // Session's triggers deep link opens that section.
            navigateWithBlurOnWeb(() => routerRef.current.push({
                pathname: `/session/${sessionId}/triggers` as any,
                ...(sessionRouteAddress ? { params: { serverId: sessionRouteAddress.serverId } } : {}),
            }));
            return true;
        }
        if (actionId === EXACT_TURN_AUTOMATION_HEADER_ACTION_ID) {
            const observed = readExactActiveParentTurn(storage.getState().sessions[sessionId]);
            if (!observed) return true;
            navigateWithBlurOnWeb(() => routerRef.current.push({
                // Info's Automations section, with its popover bound to this exact turn (04 §5.5).
                pathname: `/session/${sessionId}/triggers` as any,
                params: {
                    ...buildExactTurnAutomationRouteParams(observed),
                    serverId: observed.sourceServerId,
                },
            }));
            return true;
        }
        const workspaceModeToggleActionId = resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperience);
        if (actionId === workspaceModeToggleActionId && showWorkspaceExperienceToggle) {
            if (actionId === 'header.openMobileWorkspaceCockpit') {
                dismissKeyboard();
            }
            if (mobileWorkspaceExperience === 'cockpit' && pathname === `/session/${sessionId}`) {
                routerRef.current.replace(buildCurrentSessionHref() as any);
            }
            toggleWorkspaceExperienceRef.current();
            return true;
        }
        return false;
    }, [
        repeatableWorkflow.openRepeatable,
        openSessionCollaboration,
        openSessionAccess,
        openSessionBoard,
        attachedSessionTerminal,
        headerTerminalAction,
        buildCurrentSessionHref,
        mobileWorkspaceExperience,
        pathname,
        sessionId,
        sessionRouteAddress,
        showWorkspaceExperienceToggle,
    ]);

    const headerMenuExtraItems = React.useMemo(() => {
        const items: DropdownMenuItem[] = [];
        if (repeatableWorkflow.available) {
            items.push({
                id: 'header.makeRepeatable',
                title: t('workflows.authoring.repeatable'),
                subtitle: t('workflows.authoring.repeatableDescription'),
                icon: <Icon name="arrows-clockwise" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (attachedSessionTerminal.available) {
            items.push({
                id: 'header.openAttachedSessionTerminal',
                title: t('tools.askUserQuestion.attachedTerminalNotice.openTerminal'),
                icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (showWorkspaceExperienceToggle) {
            items.push({
                id: resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperience),
                title: t(workspaceExperienceToggleLabelKey),
                icon: <Icon name="arrows-left-right" size={16} color={theme.colors.text.secondary} />,
            });
        }
        // Offered by the menu while it reads a turn in progress (it reads the live row when opened).
        if (showAutomations) {
            items.push({
                id: EXACT_TURN_AUTOMATION_HEADER_ACTION_ID,
                title: t('automations.exactTurn.actionTitle'),
                icon: <Icon name="clock" size={16} color={theme.colors.text.secondary} />,
            });
        }
        return items.length > 0 ? items : undefined;
    }, [attachedSessionTerminal.available, mobileWorkspaceExperience, repeatableWorkflow.available, showAutomations, showWorkspaceExperienceToggle, theme.colors.text.secondary, workspaceExperienceToggleLabelKey]);

    const headerWorkspaceDisplay = React.useMemo(() => resolveSessionWorkspaceDisplayPresentation({
        serverId: currentSessionRouteServerId,
        metadata: stableSessionForHeader
            ? readSessionOwnerMetadataView(stableSessionForHeader)
            : null,
        machineTarget: headerMachineTarget,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
    }), [currentSessionRouteServerId, headerMachineTarget, stableSessionForHeader, workspaceRefsV1]);
    const headerWorkspaceSyncSummaries = useWorkspaceSyncRelationshipSummaries(headerWorkspaceDisplay.workspaceRefId, currentSessionRouteServerId ?? undefined);
    const headerWorkspaceSyncAttention = React.useMemo(
        () => headerWorkspaceDisplay.workspaceRefId
            ? resolveWorkspaceSyncSetAttention(
                headerWorkspaceSyncSummaries,
                headerWorkspaceDisplay.workspaceRefId,
            )
            : null,
        [headerWorkspaceDisplay.workspaceRefId, headerWorkspaceSyncSummaries],
    );
    const openHeaderWorkspaceSyncConflicts = React.useCallback(() => {
        const currentSet = headerWorkspaceSyncSummaries.find((summary) => summary.relationship.enabled);
        if (currentSet) {
            pane.openDetailsTab(createWorkspaceSyncConflictDetailsTab(currentSet, headerWorkspaceDisplay.workspaceRefId), { intent: 'pinned' });
        }
    }, [headerWorkspaceDisplay.workspaceRefId, headerWorkspaceSyncSummaries, pane]);

    // Phase 2.2 — plugin-UI projection + open handler for the session header
    // action menu (closing finding #11; the header action menu was previously
    // mounted without a projection so plugin-contributed header actions were
    // inert). Scoped to the session's reachable machine, matching the right
    // sidebar's plugin projection scope.
    const headerPluginProjection = useScopedPluginUiProjection({
        machineId: headerMachineTarget?.machineId ?? null,
        serverId: currentSessionRouteServerId,
        sections: SESSION_PLUGIN_UI_SECTIONS,
    });
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const headerAccountLifetime = sessionAccountBinding;
    const headerScopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: headerPluginProjection.serverId ?? null,
        machineId: headerPluginProjection.machineId ?? null,
        interactionEnabled: headerPluginProjection.phase === 'current'
            && headerPluginProjection.interactionEnabled === true,
    }), [
        headerPluginProjection.interactionEnabled,
        headerPluginProjection.phase,
        headerPluginProjection.machineId,
        headerPluginProjection.serverId,
    ]);
    // Reuse the captured Account lifetime as the only press-time currentness
    // owner. Header facts make retained descriptors displayable; this predicate
    // prevents a retired Account scope from beginning an executeAction RPC.
    const headerPluginScopeIsCurrent = headerAccountLifetime?.isCurrent;
    const openSessionRightSidebarTab = React.useCallback((
        resolution: PluginSurfaceDestinationOpenResolution,
    ): PluginSurfaceOpenOutcome => {
        if (!sessionPaneLaunchScope || !stagePluginSurfacePaneLaunch({
            store: sessionPaneLaunchScope.store,
            resolution,
        })) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_origin_unavailable',
            };
        }
        paneRef.current.selectRightDestination({
            kind: 'plugin',
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined
                ? {}
                : { instanceKey: resolution.request.instanceKey }),
        });
        return { ok: true };
    }, [sessionPaneLaunchScope]);
    React.useEffect(() => {
        if (!appPaneNavigationBinding) return;
        return appPaneNavigationBinding.registerOwner({
            container: 'rightSidebarTab',
            handler: openSessionRightSidebarTab,
        });
    }, [appPaneNavigationBinding, openSessionRightSidebarTab]);
    const handleOpenSessionPluginSurface = React.useCallback<PluginSurfaceOpenHandler>(async (request) => {
        if (!appPaneNavigationBinding) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        return await appPaneNavigationBinding.openSurface(request);
    }, [appPaneNavigationBinding]);

    const companionPreference = useSessionCompanionPreference({
        sessionId,
        serverId: currentSessionRouteServerId,
    });
    const resolveCompanionHeaderPlacement = useResolveSessionCompanionPlacementForDensity(
        {
            sessionId,
            serverId: currentSessionRouteServerId,
            paneScopeId,
        },
        companionPreference.preference.density,
    );
    const companionHeaderPlacement = React.useMemo(
        () => resolveCompanionHeaderPlacement(companionPreference.preference),
        [companionPreference.preference, resolveCompanionHeaderPlacement],
    );

    const localizeHeaderPluginText = usePluginLocalizedTextResolver({ projection: headerPluginProjection.pluginUiProjection });
    const voiceConversationSubtitle = useVoiceConversationHeaderSubtitle(ownerMetadata, sessionRouteAddress);
    const taskSessionScope = stableSessionForHeader && !blockedSurfaceState ? sessionAccountBinding?.scope : undefined;
    const headerTaskSession = React.useMemo(() => taskSessionScope ? { sessionId, scope: taskSessionScope } : undefined,
        [sessionId, taskSessionScope]);
    // Compute header props based on session state
    const headerProps = React.useMemo(() => resolveSessionViewHeaderProps({
        isDataReady,
        routeHydrationState,
        blockedSurface: headerBlockedSurface,
        session: stableSessionForHeader,
        managedWakeProjection: managedWakePresentation.projection,
        currentMachineId: currentSessionMachineId,
        sessionId,
        sessionInfoHref: buildCurrentSessionHref('/info'),
        sessionRunsHref: buildCurrentSessionHref('/runs'),
        sessionAutomationsHref: buildCurrentSessionHref('/automations'),
        paneScopeId,
        windowWidth,
        actionRailVisible,
        mobileTerminalTabAvailable: mobileTerminalTabAvailable || !headerTerminalAction.available,
        browserMenuEntryAvailable,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        showAutomations,
        shouldShowSubagentsButton,
        runningWorkCount,
        workSummary,
        navigateWithBlurOnWeb,
        handleHeaderExtraItemSelect,
        headerMenuExtraItems,
        taskSession: headerTaskSession,
        collaborationHeader,
        router: routerRef.current,
        actionIconColor: theme.colors.text.secondary,
        headerTintColor: theme.colors.chrome.header.foreground,
        statusErrorColor: theme.colors.status.error,
        workspaceSubtitle: headerWorkspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: headerWorkspaceDisplay.subtitleEllipsizeMode,
        voiceConversationSubtitle,
        machinePower: headerMachinePower,
        externalSessionRuntime: externalSessionRuntimePresentation,
        pluginUiProjection: headerPluginProjection.pluginUiProjection,
        localizePluginText: localizeHeaderPluginText,
        pluginUiScopedLaunchFacts: headerScopedLaunchFacts,
        pluginUiScopeIsCurrent: headerPluginScopeIsCurrent,
        actionAccountLifetime: sessionAccountBinding,
        onOpenPluginSurface: handleOpenSessionPluginSurface,
        workspaceSyncAttention: headerWorkspaceSyncAttention ?? undefined,
        onOpenWorkspaceSyncConflicts: openHeaderWorkspaceSyncConflicts,
        boardHeaderAction: boardDestinationAvailable
            ? {
                onPress: openSessionBoard,
                preferDirect: boardHasContent || boardIsOpen,
            }
            : undefined,
        // Companion is not a Board placement gate. Its first-party Session
        // Summary is composed from Session facts alone, so the entry point is
        // admitted by the same qualified Session address its host mounts on.
        // Board records and the Board destination stay behind `sessions.board`.
        companionHeaderAction: sessionRouteAddress ? {
            availability: companionPreference.availability,
            preferenceExists: companionPreference.preferenceExists,
            visible: companionPreference.preference.visible,
            itemCount: companionPreference.preference.items.length,
            placement: companionHeaderPlacement,
            isPhone: deviceType === 'phone',
        } : undefined,
    }), [
        managedWakePresentation.projection,
        voiceConversationSubtitle,
        headerMachinePower,
        actionRailVisible,
        mobileTerminalTabAvailable,
        headerTerminalAction.available,
        browserMenuEntryAvailable,
        buildCurrentSessionHref,
        clientExecutableRegistrationRevision,
        currentSessionMachineId,
        handleHeaderExtraItemSelect,
        handleOpenSessionPluginSurface,
        headerPluginScopeIsCurrent,
        sessionAccountBinding,
        headerScopedLaunchFacts,
        headerPluginProjection.pluginUiProjection,
        localizeHeaderPluginText,
        headerWorkspaceDisplay.displayTitle,
        headerWorkspaceDisplay.subtitleEllipsizeMode,
        headerWorkspaceSyncAttention,
        openHeaderWorkspaceSyncConflicts,
        openSessionBoard,
        boardDestinationAvailable,
        sessionRouteAddress,
        boardHasContent,
        boardIsOpen,
        companionPreference.availability,
        companionPreference.preference.items.length,
        companionPreference.preference.visible,
        companionPreference.preferenceExists,
        companionHeaderPlacement,
        resolveCompanionHeaderPlacement,
        deviceType,
        externalSessionRuntimePresentation,
        headerBlockedSurface,
        headerMenuExtraItems,
        headerTaskSession,
        collaborationHeader,
        isDataReady,
        paneScopeId,
        routeHydrationState,
        stableSessionForHeader,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        sessionId,
        shouldShowSubagentsButton,
        showAutomations,
        runningWorkCount,
        workSummary,
        theme.colors.chrome.header.foreground,
        theme.colors.status.error,
        theme.colors.text.secondary,
        windowWidth,
    ]);

    // At compact widths the empty people state uses the canonical header overflow, while a live
    // facepile stays direct. Both presentations carry the same attention label and command.
    // The header's last control is "Hide session" (lab ade-shell H1): it draws itself only where the
    // pane host offers hiding.
    const headerRightElement = React.useMemo(() => (
        <>
            {headerProps.rightElement}
            <PaneMainHideButton color={theme.colors.chrome.header.foreground} />
        </>
    ), [theme.colors.chrome.header.foreground, headerProps.rightElement]);

    // Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones.
    // Phone: pulling the title down opens All tabs; the opener lives in a leaf so this screen never
    // subscribes to the workspace's tab set.
    const openAllTabsRef = React.useRef<(() => void) | null>(null);
    const handlePullAllTabs = React.useCallback(() => { openAllTabsRef.current?.(); }, []);
    const sessionHeader = React.useMemo(() => showTopHeader ? (
        <View style={{ zIndex: 1000 }} {...pane.overlayFocusReturnCaptureProps}>
            {isTablet ? null : (
                <SessionAllTabsOpenerBridge sessionId={sessionId} serverId={currentSessionRouteServerId || null} openRef={openAllTabsRef} />
            )}
            <SessionViewLiveStatusPaneHeader
                {...headerProps}
                rightElement={headerRightElement}
                // Desktop renames in place (the title is the field); a phone keeps ⋯ Rename.
                rename={isTablet && stableSessionForHeader?.access?.capabilities.renameSession === true
                    ? { sessionId, serverId: currentSessionRouteServerId || null } : undefined}
                editBotFace={stableSessionForHeader?.access?.capabilities.renameSession === true
                    ? { sessionId, serverId: currentSessionRouteServerId || null, accountLifetime: sessionAccountBinding } : undefined}
                agentIdentity={headerProps.agentId ? (
                    // An accepted Make this a bot / regular session acknowledges itself on the mark (lab `b-promote`).
                    <BotMarkerFeedback kind="mark" session={{ serverId: currentSessionRouteServerId, sessionId }}>
                        <SessionAgentCatalogIdentityIcon
                            agentId={headerProps.agentId}
                            machineId={headerMachineTarget?.machineId ?? null}
                            serverId={currentSessionRouteServerId}
                            color={theme.colors.chrome.header.foreground}
                            size={26}
                        />
                    </BotMarkerFeedback>
                ) : null}
                // Wide headers show the root-first breadcrumb; a phone header names only who it reports to,
                // one tappable line, as the desktop peek does (DA3 D15).
                lineage={<SessionLineageBreadcrumb sessionId={sessionId} serverId={currentSessionRouteServerId || null} presentation={isTablet ? 'breadcrumb' : 'manager'} />}
                // A Session that runs in a sandbox names it after the folder and opens its detail (lab firstsend-chip).
                sandbox={<SessionHeaderSandboxChip sessionId={sessionId} serverId={currentSessionRouteServerId || null} />}
                onBackPress={handleBackPress}
                showBackButton={!isTablet}
                includeTopInset={headerSafeAreaTopMode !== 'external'}
                onPullAllTabs={isTablet ? undefined : handlePullAllTabs}
            />
            {isTablet ? null : <PhoneOpenTabsRail />}
            {/* The Session's own page tabs touch the content they switch, under the app's open-tabs rail. */}
            {props.headerAccessory}
        </View>
    ) : null, [
        props.headerAccessory,
        handlePullAllTabs,
        sessionId,
        currentSessionRouteServerId,
        handleBackPress,
        headerMachineTarget?.machineId,
        headerProps,
        headerRightElement,
        headerSafeAreaTopMode,
        isTablet,
        sessionAccountBinding,
        stableSessionForHeader?.access?.capabilities.renameSession,
        pane.overlayFocusReturnCaptureProps,
        showTopHeader,
        theme.colors.chrome.header.foreground,
    ]);

    const handleBlockedSurfaceAction = React.useCallback(async (
        intent: SessionBlockedSurfaceActionIntent,
    ) => {
        if (intent === 'open_session_access') {
            openSessionAccess();
            return;
        }
        if (intent === 'retry_session_hydration') {
            // One exact retry through the canonical route hydration owner. A failure leaves the
            // settled card in place rather than claiming recovery.
            try {
                await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    serverId: currentSessionRouteServerId,
                    forceRefresh: true,
                });
            } catch {
                // The surface already states the condition; no second failure vocabulary here.
            }
            return;
        }
        // Account encryption setup edits the Account of whichever Home is active, so establish this
        // Session's Home first and open the existing security screen only if that actually happened.
        try {
            await openRouteWithEstablishedHome({
                serverId: currentSessionRouteServerId,
                refreshAuth: auth.refreshFromActiveServer ?? null,
                navigate: () => {
                    routerRef.current.push(SETTINGS_ROUTES.accountSecurity as any);
                },
            });
        } catch {
            // A blocked switch keeps the person here with the same actionable state.
        }
    }, [auth, currentSessionRouteServerId, openSessionAccess, sessionId]);

    const browserContextStateForComposer = props.browserContextStateForComposer
        ?? sessionBrowserContextRuntime?.state
        ?? null;
    const browserContextComposerContext = props.browserContextStateForComposer == null
        ? sessionBrowserContextRuntime?.composerContext ?? null
        : null;

    const rendersLoadedSessionView = !blockedSurfaceState
        && !routeHydrationRetrying
        && !((!isDataReady && !session) || routeHydrationLoading)
        && !(!session && (routeHydrationTerminalMissing || !routeHydrationState))
        && !props.contentOverride
        && session !== null;

    // The states that stand in for a loaded Session. The primary presentation renders them in place;
    // the embedded arm publishes them as its transcript part so the host's arrangement stays put.
    const sessionStateSurface = ((): Readonly<{
        node: React.ReactElement;
        state: Exclude<EmbeddedSessionPartsState, 'ready'>;
    }> | null => {
        const surface = (node: React.ReactElement, state: Exclude<EmbeddedSessionPartsState, 'ready'>) => ({ node, state });
        if (blockedSurfaceState?.kind === 'account_recovery') {
            return surface(<SessionAuthRecoveryFallback />, 'blocked');
        }
        if (blockedSurfaceState) {
            return surface((
                <SessionBlockedSurfaceCard
                    state={blockedSurfaceState}
                    collaborationAvailable={collaborationAvailable}
                    onAction={handleBlockedSurfaceAction}
                />
            ), 'blocked');
        }
        if (routeHydrationRetrying) {
            return surface(<SurfaceStateCard testID="session-route-retrying" kind="loading"
                title={routeHydrationRetryStatusKey ? t(routeHydrationRetryStatusKey) : t('common.loading')}
                accessibilitySemantics="status" />, 'loading');
        }
        if ((!isDataReady && !session) || routeHydrationLoading) {
            return surface(embedded
                ? <PaneLoadingFallback testID="session-route-loading" />
                : <SessionViewRouteLoading testID="session-route-loading" initialLoading={routeHydrationLoading} serverId={currentSessionRouteServerId || null} />, 'loading');
        }
        if (!session && (routeHydrationTerminalMissing || !routeHydrationState)) {
            // An embedded mount cannot tell a deleted Session from one it may not see, and must not
            // reveal which: one neutral state for missing, out-of-scope and inaccessible alike.
            return surface(embedded ? <EmbeddedSessionUnavailable /> : (
                <View testID="session-root-unavailable" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Icon name="trash" size={48} color={theme.colors.text.secondary} />
                    <Text style={{ color: theme.colors.text.primary, ...Typography.variant('title'), marginTop: theme.space.s16,  }}>{t('errors.sessionDeleted')}</Text>
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: theme.space.s8, textAlign: 'center', paddingHorizontal: theme.space.s32 }}>{t('errors.sessionDeletedDescription')}</Text>
                </View>
            ), 'unavailable');
        }
        return null;
    })();

    const cockpitSurfaceOverride = sessionStateSurface === null && Boolean(props.contentOverride);

    return (
        <SessionWorkSourcesProvider value={sessionWorkSources}>
        <SessionBrowserContextRuntimeProvider runtime={sessionBrowserContextRuntime}>
        <SessionExternalSessionRuntimeProvider value={externalSessionRuntime}>
        <SessionSurfaceTestIdsProvider>
            <SessionSurfaceActivationHost
                sessionId={sessionId}
                serverId={session?.serverId ?? currentSessionRouteServerId}
                sessionAccepted={session != null}
            />
            {embedded ? null : <SessionSurfaceEscapeToHome router={router} />}
            {/* ⌘J / ⌥J: Jump to a terminal of this session. An embedded presentation is not the focused session. */}
            {embedded ? null : <SessionTerminalJumpShortcut paneScopeId={paneScopeId} />}
            <SessionSurfacePaneUrlSync
                paneScopeId={paneScopeId}
                multiPaneEnabled={multiPaneEnabled}
                sessionsRightPaneDefaultOpen={sessionsRightPaneDefaultOpen === true}
                deviceType={deviceType}
                paneEffectsEnabled={!embedded}
            />
            {props.contentOverride == null ? (
                <SessionPendingMessagesRefresh
                    sessionId={sessionId}
                    sessionAccepted={session != null}
                />
            ) : null}
            {session ? (
                props.contentOverride != null ? (
                    <SessionContentOverrideViewedLifecycle
                        serverId={currentSessionRouteServerId}
                        sessionId={sessionId}
                    />
                ) : (
                    <SessionTranscriptViewedLifecycle
                        serverId={currentSessionRouteServerId}
                        sessionId={sessionId}
                    />
                )
            ) : null}
            {debugRouterEnabled && Platform.OS === 'web' ? (
                <View
                    testID="debug-expo-pathname"
                    style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
                >
                    <Text>{pathname}</Text>
                </View>
            ) : null}
            {/* Status bar shadow for landscape mode */}
            {!embedded && isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeAreaTopInset,
                    backgroundColor: materialColor(theme.colors.surface.base, 'transparent'),
                    zIndex: 1000,
                    ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                }} />
            )}

            {/* Content based on state. The header opens the transcript column: a loaded Session
                seats it at the top of the pane host's main column, so it spans the transcript's
                width while the details pane, sidebar and action rail run the sheet's full height
                beside it; every other state stacks it above the state it explains. */}
            <View
                style={{ flex: 1 }}
                {...pane.overlayFocusReturnCaptureProps}
            >
                {/* The header and the transcript beneath it are one pair: the transcript's scroll drives the header's shade.
                    Without a header of its own (embedded in a peek or a Run) the transcript is the body of its host's header. */}
                <PaneHeaderScrollScope passThrough={!showTopHeader}>
                {rendersLoadedSessionView || cockpitSurfaceOverride ? null : sessionHeader}
                {sessionStateSurface !== null ? (
                    embedded ? (
                        <EmbeddedSessionStatePublication
                            state={sessionStateSurface.state}
                            transcript={sessionStateSurface.node}
                            arrangement={props.embeddedArrangement}
                        />
                    ) : sessionStateSurface.node
                  ) : cockpitSurfaceOverride ? (
                      // Another cockpit surface's page (Browser, Files, Git, ...) keeps the Session's viewer
                      // owner mounted around its header, so the session actions can open the Computer from
                      // any phone projection (the loaded Chat view mounts the same owner around its panes).
                      <SessionViewerScope sessionId={sessionId} serverId={currentSessionRouteServerId || null}>
                          {sessionHeader}
                          {props.contentOverride}
                      </SessionViewerScope>
                  ) : !session || !rendersLoadedSessionView ? (
                      null
                  ) : (
                      // Normal session view
                       <ComposerBannerCollapseProvider>
                       <SessionHeaderSlotContext.Provider value={sessionHeader}>
                       <MemoizedSessionViewLoaded
                           renderComposer={props.renderComposer}
                           authSurfaceState={authSurfaceState}
                           key={props.sessionSurfaceKey}
                           headerTitle={headerProps.title}
                           headerAgentId={headerProps.agentId ?? null}
                           headerMachineId={headerMachineTarget?.machineId ?? null}
                           sessionId={sessionId}
                           sessionSurfaceKey={props.sessionSurfaceKey}
                           routeServerId={currentSessionRouteServerId}
                           accountBinding={sessionAccountBinding}
                           routeMobileSurface={routeMobileSurface}
                           session={stableSessionForLoadedView ?? session}
                           pane={pane}
                           isMachineReachable={isMachineReachable}
                           machineReachability={machineReachability}
                           onBackPress={handleBackPress}
                           isEncryptedSessionLocked={isEncryptedSessionLocked}
                           executionRunsEnabled={executionRunsEnabled}
                           jumpToSeq={props.jumpToSeq ?? null}
                           jumpToMessageId={props.jumpToMessageId ?? null}
                           participantTargets={participantTargets}
                           approvalRequests={approvalRequests}
                           transcriptApprovalRequests={transcriptApprovalRequests}
                           initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                           attachmentsUploadsEnabled={attachmentsUploadsEnabled}
                           attachmentsUploadsAvailable={attachmentsUploadsAvailable}
                           browserContextStateForComposer={browserContextStateForComposer}
                           browserContextComposerContext={browserContextComposerContext}
                           paneScopeId={paneScopeId}
                           sessionPluginRuntime={props.sessionPluginRuntime}
                           pendingMessages={pendingMessages}
                           pendingMessagesLoaded={pendingMessagesLoaded}
                           pendingReadState={pendingReadState}
                           managedWakePresentation={managedWakePresentation}
                           externalSessionRuntime={externalSessionRuntime}
                           externalSessionRuntimePresentation={externalSessionRuntimePresentation}
                           externalSessionIdentityPresentation={externalSessionIdentityPresentation}
                           chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                           routeHydrationPending={routeHydrationPending}
                           sessionRunnerRuntimeStatus={sessionRunnerRuntimeStatusRetention.status}
                           sessionRunnerRuntimeStatusMachineId={sessionRunnerRuntimeStatusRetention.machineId}
                           onSessionRunnerRuntimeStatusInvalidated={sessionRunnerRuntimeStatusRetention.invalidateAndRefresh}
                           onAppPanePluginSurfaceNavigationBindingChange={handleAppPanePluginSurfaceNavigationBindingChange}
                           collaborationTarget={sessionRouteAddress}
                           collaborationAvailable={collaborationAvailable}
                           foldCollaborationHeaderEntry={foldCollaborationHeaderEntry}
                           openSessionCollaboration={openSessionCollaboration}
                           openSessionAccess={openSessionAccess}
                           companionEdge={companionPreference.preference.edge}
                           openWorkStateRequestKey={props.openWorkStateRequestKey ?? null}
                           embedded={embedded}
                           embeddedArrangement={props.embeddedArrangement}
                       />
                       </SessionHeaderSlotContext.Provider>
                       </ComposerBannerCollapseProvider>
                  )}
                </PaneHeaderScrollScope>
            </View>
        </SessionSurfaceTestIdsProvider>
        </SessionExternalSessionRuntimeProvider>
        </SessionBrowserContextRuntimeProvider>
        </SessionWorkSourcesProvider>
    );
});

function SessionTranscriptSelectionBoundary(props: Readonly<{
    sessionId: string;
    metadata: ReturnType<typeof readSessionOwnerMetadataView>;
    enabled: boolean;
    locked: boolean;
    children: React.ReactNode;
}>) {
    const eligibleMessageIds = useTranscriptSelectionEligibleMessageIds(props.sessionId, {
        enabled: props.enabled,
        metadata: props.metadata,
    });
    return <TranscriptMessageSelectionProvider
        sessionId={props.sessionId}
        eligibleMessageIdsInOrder={eligibleMessageIds}
        enabled={props.enabled && !props.locked}
    >{props.children}</TranscriptMessageSelectionProvider>;
}

function SessionViewLoaded(props: Parameters<typeof SessionViewLoadedContent>[0]) {
    // The transcript, header and panes present at once; only the composer waits for this Session's
    // own draft read (never the Account's whole draft collection) before it takes custody.
    const draftAddresses = React.useMemo(() => [{ kind: 'session' as const, sessionId: props.sessionId }], [props.sessionId]);
    const draftsAdmitted = useSessionDraftHydrationAdmission({ lifetime: props.accountBinding, addresses: draftAddresses });
    const interaction = React.useMemo(
        () => narrowTranscriptInteractionForPresentation(deriveTranscriptInteractionFromSession(props.session), props.embedded),
        [props.session.access, props.session.active, props.session.presence, props.embedded],
    );
    return <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.routeServerId ?? props.session.serverId} interaction={interaction} navigation={props.embedded?.navigation}>
        <SessionDraftAdmissionContext.Provider value={draftsAdmitted}>
            <SessionDiscussionSourceLinksProvider sessionId={props.sessionId} serverId={props.routeServerId ?? props.session.serverId ?? null}>
                <SessionViewLoadedContent {...props} />
            </SessionDiscussionSourceLinksProvider>
        </SessionDraftAdmissionContext.Provider>
    </AppSessionTranscriptSourceProvider>;
}
type SessionComposerView = ReturnType<typeof useSessionComposerController>['view'];
const SessionComposerModelContext = React.createContext<SessionComposerModel | null>(null);

/**
 * The session header opens the transcript column, so the loaded frame seats it, but its content (title, status,
 * plugin actions, counts) changes on its own schedule. It reaches the frame through this slot, not through the
 * loaded view's props, so a header change redraws the header and never re-runs the composer controller.
 */
const SessionHeaderSlotContext = React.createContext<React.ReactNode>(null);

function SessionHeaderSlot() {
    return <>{React.useContext(SessionHeaderSlotContext)}</>;
}

function SessionComposerSlot({ renderComposer }: Readonly<{ renderComposer?: SessionComposerRenderer }>) {
    const composer = React.useContext(SessionComposerModelContext);
    if (!composer) throw new Error('Session composer host is missing');
    return renderComposer ? renderComposer(composer) : composer.content;
}

/** Composer state updates its own slot, not the transcript/pane layout. */
function SessionViewLoadedContent(props: Omit<React.ComponentProps<typeof SessionViewLoadedFrame>, keyof SessionComposerView>) {
    // The composer acts on this surface's focus and presentation by subscription: a tab switch renders
    // neither the controller nor the loaded frame.
    const presence = useSessionSurfacePresenceSignal();
    const { composer, view } = useSessionComposerController({ ...props, presence });
    return <SessionComposerModelContext.Provider value={composer}>
        <SessionViewLoadedFrame {...props} {...view} />
    </SessionComposerModelContext.Provider>;
}

/**
 * The header stands on the transcript column: a docked Companion rail's width is left beside it on the rail's
 * side. It reads the same placement owner the Companion host reads, from inside the pane layout that owner needs.
 */
function SessionHeaderBesideCompanionRail(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId: string | null;
    paneScopeId: string;
}>>) {
    const placement = useSessionCompanionPlacement({ sessionId: props.sessionId, serverId: props.serverId, paneScopeId: props.paneScopeId });
    // One View in every placement, so a rail appearing never remounts the header.
    const railPx = placement.kind === 'reserved_rail' ? placement.widthPx : 0;
    const edge = placement.kind === 'reserved_rail' ? placement.edge : 'trailing';
    return <View style={edge === 'leading' ? { paddingStart: railPx } : { paddingEnd: railPx }}>{props.children}</View>;
}

const SessionViewLoadedFrame = React.memo(function SessionViewLoadedFrame({
    renderComposer,
    authSurfaceState,
    headerTitle,
    headerAgentId,
    headerMachineId,
    sessionId,
    sessionSurfaceKey,
    routeServerId,
    routeMobileSurface,
    session,
    pane,
    onBackPress,
    isEncryptedSessionLocked,
    executionRunsEnabled,
    jumpToSeq,
    jumpToMessageId,
    approvalRequests,
    transcriptApprovalRequests,
    paneScopeId,
    sessionPluginRuntime,
    pendingMessages,
    pendingMessagesLoaded,
    pendingReadState,
    externalSessionRuntime,
    chatBottomSpacing,
    routeHydrationPending,
    onAppPanePluginSurfaceNavigationBindingChange,
    companionEdge,
    embedded,
    embeddedArrangement,
    companionAddress,
    ownerMetadata,
    machineId,
    sessionRouteServerId,
    sessionAccountLifetime,
    cliAuthState,
    currentSessionAgentCatalogEntry,
    controlSwitchAttemptIdRef,
    controlSwitchTo,
    setControlSwitchTo,
    hasWriteAccess,
    controlSwitchCallerRef,
    sessionViewCaller,
    executeRecoveryAction,
    isHiddenSystemSessionSession,
    externalControlFooter,
    sessionAccountScope,
    router,
    sessionMachineAccessRemoved,
    machineName,
    inactiveUi,
    isLocallyAttached,
    shouldShowInput,
    bottomNotice,
    followBottomIntentSeq,
    handleEditPendingMessage,
    readPendingMessageEditText,
    isBoardPresentationUndoCurrent,
    actionExecutor,
    presentSessionActionOutcome,
    setActiveStatusBadgeKey,
    sessionPresentationApplierRef,
    sessionStatusState,
    openModelPicker,
    handleResumeSession,
}: {
    renderComposer?: SessionComposerRenderer;
    headerTitle: string;
    headerAgentId: string | null;
    headerMachineId: string | null;
    embedded: SessionViewEmbeddedPresentation | null;
    embeddedArrangement?: React.ReactNode;
    authSurfaceState: SessionAuthSurfaceState | null;
    sessionId: string;
    sessionSurfaceKey: string;
    routeServerId?: string | null;
    accountBinding: ServerCredentialAccountScopeBinding | null;
    routeMobileSurface?: string;
    session: Session;
    pane: ReturnType<typeof useSessionViewBootstrap>['pane'];
    isMachineReachable: boolean;
    machineReachability: ReturnType<typeof useSessionViewBootstrap>['machineReachability'];
    onBackPress: () => void;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    jumpToSeq: number | null;
    jumpToMessageId: string | null;
    participantTargets: readonly SessionParticipantTarget[];
    approvalRequests: ReadonlyArray<OpenApprovalAttentionArtifactForSession>;
    /** Open approvals plus decided ones whose body keeps a settled presentation (the transcript's list). */
    transcriptApprovalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    attachmentsUploadsEnabled: boolean;
    attachmentsUploadsAvailable: boolean;
    browserContextStateForComposer: BrowserContextState | null;
    browserContextComposerContext: SessionBrowserContextRuntime['composerContext'] | null;
    paneScopeId: string;
    sessionPluginRuntime: SessionPluginRuntimeState;
    pendingMessages: readonly PendingMessage[];
    pendingMessagesLoaded: boolean;
    pendingReadState: 'loading' | 'error' | undefined;
    managedWakePresentation: SessionManagedWakePresentation;
    externalSessionRuntime: ReturnType<typeof useExternalSessionRuntime>;
    externalSessionRuntimePresentation: ReturnType<
        typeof resolveExternalSessionRuntimePresentation
    > | null;
    externalSessionIdentityPresentation: ReturnType<
        typeof resolveExternalSessionIdentityPresentation
    >;
    chatBottomSpacing: 'default' | 'none';
    routeHydrationPending: boolean;
    sessionRunnerRuntimeStatus: SessionRunnerRuntimeStatusSnapshot | null;
    sessionRunnerRuntimeStatusMachineId: string | null;
    onSessionRunnerRuntimeStatusInvalidated: () => void;
    onAppPanePluginSurfaceNavigationBindingChange: (
        binding: PluginSurfaceDestinationNavigationBinding | undefined,
    ) => void;
    // The focused surface owns the one collaboration availability/target derivation; the loaded
    // view consumes it so the composer access chip cannot resolve a second answer.
    collaborationTarget: SessionAddress | null;
    collaborationAvailable: boolean;
    foldCollaborationHeaderEntry: boolean;
    openSessionCollaboration: () => void;
    openSessionAccess: () => void;
    companionEdge: SessionCompanionEdge;
    openWorkStateRequestKey: number | null;
} & SessionComposerView) {
    const { theme } = useUnistyles();
    // A phone's open New card holds this seat: the Session composer yields until it closes (one composer, L11).
    const dockHoldsComposerSeat = useNewSessionDockHoldsComposerSeat();
    const input = shouldShowInput && !dockHoldsComposerSeat ? <SessionComposerSlot renderComposer={renderComposer} /> : null;

    const mountedBoard = useMountedSessionBoardController(companionAddress);
    const presentationPaneRef = React.useRef(pane);
    presentationPaneRef.current = pane;
    const presentationMainColumnRef = React.useRef<PaneMainColumnState | null>(null);
    const onMainColumnControlsChange = React.useCallback((controls: PaneMainColumnState | null) => {
        presentationMainColumnRef.current = controls;
    }, []);
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const forkV1 = ownerMetadata?.forkV1;
    const isForkedSessionV1 =
        forkV1?.v === 1 &&
        typeof forkV1.parentSessionId === 'string' &&
        forkV1.parentSessionId.trim().length > 0;

    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(ownerMetadata);
    const viewerDestination = useSessionViewerDestinationScope(sessionId, sessionRouteServerId);
    const viewerAccountLifetime = viewerDestination?.accountLifetime ?? sessionAccountLifetime;
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptMessageSendToSessionTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const navigateToSession = useNavigateToSession();
    const bulkComposeRouter = useNewSessionEntryRouter();

    const canReleaseLocalControl = shouldOfferLocalControlRelease(session, cliAuthState, currentSessionAgentCatalogEntry);

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
        const accountLifetime = sessionAccountLifetime;
        if (!accountLifetime?.isCurrent()) return;
        const attemptId = controlSwitchAttemptIdRef.current + 1;
        controlSwitchCallerRef.current?.abort();
        const caller = new AbortController();
        controlSwitchCallerRef.current = caller;
        const requestedControlMode = 'remote' as const;
        controlSwitchAttemptIdRef.current = attemptId;
        fireAndForget((async () => {
            const cancellation = mergeAbortSignals([sessionViewCaller.signal, caller.signal]);
            try {
                const result = await executeRecoveryAction('session.control.switch', {
                    sessionId, to: requestedControlMode,
                }, {
                    defaultSessionId: sessionId,
                    signal: cancellation.signal,
                    onTransportIssued: () => {
                        if (controlSwitchAttemptIdRef.current === attemptId && accountLifetime.isCurrent()) {
                            setControlSwitchTo(requestedControlMode);
                        }
                    },
                });
                if (!accountLifetime.isCurrent() || cancellation.signal.aborted) {
                    finishControlSwitchAttempt(attemptId);
                    return;
                }
                if (!result.ok) {
                    if (!finishControlSwitchAttempt(attemptId)) return;
                    Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
                    return;
                }
                finishControlSwitchAttempt(attemptId);
            } catch {
                if (!finishControlSwitchAttempt(attemptId)) return;
                if (cancellation.signal.aborted) return;
                Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
            } finally {
                cancellation.dispose();
                if (controlSwitchCallerRef.current === caller) controlSwitchCallerRef.current = null;
            }
        })(), { tag: 'SessionView.requestSwitchToRemote' });
    }, [executeRecoveryAction, finishControlSwitchAttempt, hasWriteAccess, sessionAccountLifetime, sessionId, sessionViewCaller]);

    const handleTranscriptViewportChange = React.useCallback((state: TranscriptViewportChangeState) => {
        sync.onSessionViewportChange(sessionId, state);
    }, [sessionId]);

    const transcriptSelectionRoleLabels = React.useMemo(
        () => ({
            user: t('voiceActivity.format.you'),
            assistant: t('voiceActivity.format.assistant'),
        }),
        [],
    );
    const handleSendSelectedTranscriptMessages = React.useCallback(async (
        selectedMessages: ReadonlyArray<TranscriptSelectionToolbarMessage>,
    ) => {
        try {
            await sendTranscriptSelectionToSession({
                sourceSessionId: sessionId,
                sourceServerId: sessionRouteServerId,
                sourceMachineId: typeof machineId === 'string' && machineId.trim().length > 0
                    ? machineId
                    : null,
                sourceSessionName: getSessionName(session),
                selectedMessages,
                bulkCopyFormat: transcriptBulkCopyFormat,
                template: transcriptMessageSendToSessionTemplate,
                roleLabels: transcriptSelectionRoleLabels,
                chooseDestinationSessionId: openTranscriptSendToSessionModal,
                appendToDraft: appendSessionDraftText,
                openNewSession: async ({ promptText, sourceServerId, placement }) => {
                    const accountLifetime = sessionAccountLifetime;
                    if (!sessionAccountScope || !accountLifetime?.isCurrent()) return false;
                    // A cross-server source must carry its exact machine too.
                    // Falling back to the active Account's target while keeping
                    // only the source server would recreate the split placement
                    // contract this seed deliberately rejects.
                    if (placement === undefined && sessionAccountScope.serverId !== sourceServerId) {
                        return false;
                    }
                    const outcome = await openOrdinaryNewSessionSeed({
                        seed: {
                            prompt: promptText,
                            ...(placement === undefined ? {} : { placement }),
                        },
                        pluginId: 'happier.transcript.selection',
                        scope: sessionAccountScope,
                        isCurrent: () => accountLifetime.isCurrent(),
                    });
                    return outcome.kind === 'opened';
                },
                openBulkComposer: ({ targets, text }) => openBulkSessionComposer(bulkComposeRouter, { targets, text }),
                navigateToSession: ({ sessionId: destinationSessionId, serverId }) => {
                    void navigateToSession(destinationSessionId, { serverId });
                },
            });
        } catch {
            Modal.alert(t('common.error'), t('transcript.selection.sendTo.sendFailed'));
        }
    }, [
        sessionAccountLifetime,
        sessionAccountScope,
        machineId,
        navigateToSession,
        bulkComposeRouter,
        session,
        sessionRouteServerId,
        sessionId,
        transcriptBulkCopyFormat,
        transcriptMessageSendToSessionTemplate,
        transcriptSelectionRoleLabels,
    ]);

      const requesterRecoveryBanner = sessionMachineAccessRemoved ? (
                  <ComposerAuxiliaryFrame>
                      <WarningActionBanner
                          testID="session-requester-access-removed"
                          tone="warning"
                          title={inactiveUi.inactiveStatusTextKey === 'session.accessWithdrawn' ? t('session.accessWithdrawn') : t('machineRequester.accessRemoved', { machine: machineName })}
                          body={inactiveUi.inactiveStatusTextKey === 'session.accessWithdrawn' ? t('session.accessWithdrawnGuestBody', { machine: machineName }) : t('machineRequester.resumeElsewhere', { machine: machineName })}
                          actionTestID="session-requester-continue-elsewhere"
                          // Continue opens a new session from this one's context: the label says where it goes.
                          actionLabel={t('session.accessWithdrawnContinue')}
                          actionAccessibilityLabel={t('session.accessWithdrawnContinue')}
                          onActionPress={() => { openNewSessionSourceContextNavigation({
                              sourceSessionId: sessionId,
                              forkPoint: { type: 'latest' },
                              // Withdrawal unmounts an open edit of a queued message; its unsent words start the new Session.
                              restoredDraftText: readPendingMessageEditText(),
                              serverId: sessionRouteServerId ?? null,
                              accountLifetime: sessionAccountLifetime,
                              navigateToNewSession: route => router.push(route),
                          }); }}
                      />
                  </ComposerAuxiliaryFrame>
              ) : null;
      // Retry is the Resume owner and is offered only while it can run, as the status line's own Resume is.
      // A held message's "Deliver and resume" is that same Resume carrying the message: it is then the one step (PF1).
      const startFailureRetry = inactiveUi.shouldShowInput && inactiveUi.noticeKind === 'none'
          && !sessionMachineAccessRemoved && hasWriteAccess && !offersPendingDeliverAndResume(pendingMessages, session)
          ? {
              busy: sessionStatusState === 'resuming',
              run: () => fireAndForget(handleResumeSession(), { tag: 'SessionView.startFailure.retry' }),
          }
          : null;
      // With a queued message to deliver, the banner's step is that row's Deliver, never "send it again"; the banner
      // waits until the queue can answer, so its words never change once shown.
      const queuedInputDeliverable = readQueuedInputDeliverable(pendingMessages, session,
          pendingMessagesLoaded || pendingReadState === 'error');
      const startFailureNotice = queuedInputDeliverable === null ? null
          : resolveSessionStartFailureNotice({ issue: session.lastRuntimeIssue, sessionActive: session.active === true,
              appliedProviderBinding: readSessionProviderBindingMetadataV1(ownerMetadata), queuedInputDeliverable });
      const startFailureProviderRecovery = startFailureNotice?.providerRecovery;
      const startFailureProviderTarget = startFailureProviderRecovery ? readMachineAdministrationTargetRouteParams({
          machineId: ownerMetadata?.machineId,
          serverIdentityId: resolvePortableServerIdentityForRoutingId(session.serverId) ?? undefined,
      }) : null;
      const startFailureRecovery = startFailureNotice?.code === 'plugin_disabled'
          ? resolveResumeFailurePresentation({ errorCode: startFailureNotice.code }, startFailureNotice.message,
              resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })))
          : null;
      const disabledPluginId = startFailureRecovery?.kind === 'plugin_disabled' ? startFailureRecovery.pluginId : null;
      const startFailureSignInRoute = startFailureNotice
          ? createSessionAgentSignInRoute(startFailureNotice.issue, ownerMetadata?.machineId, session.serverId) : null;
      const startFailureBanner = startFailureNotice
          ? <SessionStartFailureBanner notice={startFailureNotice} retry={startFailureRetry}
              {...(startFailureSignInRoute ? { signIn: () => router.push(startFailureSignInRoute as never) } : {})}
              {...(startFailureProviderRecovery ? { reviewConnection: () => {
                  fireAndForget(dispatchProviderRecoveryAction({ router, recovery: {
                      ...startFailureProviderRecovery,
                      ...(startFailureProviderTarget ? { machine: startFailureProviderTarget } : {}),
                  } }),
                      { tag: 'SessionView.startFailure.reviewConnection' });
              } } : {})}
              {...(startFailureRetry && openModelPicker && session.lastRuntimeIssue?.failureCause?.failureReason === 'model_selection_required'
                  ? { chooseModel: openModelPicker } : {})}
              {...(disabledPluginId ? { managePlugin: () => {
                  const route = buildPluginDetailRoute('settings', disabledPluginId);
                  router.push({ ...route, params: { ...route.params, ...storeMachineRouteParams(
                      machineId ? { serverId: sessionRouteServerId, machineId } : null,
                  ) } });
              } } : {})} />
          : null;
      // Session-level notices stand in the composer seat, above the composer like its own banners, and
      // alone there when this Session shows no composer (access removed, signed out, read-only).
      const authRecoveryNotice = authSurfaceState && !(inactiveUi.shouldShowInput && !isEncryptedSessionLocked)
          ? <ComposerAuxiliaryFrame><SessionAuthRecoveryBanner /></ComposerAuxiliaryFrame>
          : null;
      // Every Session notice stands here, in the composer's banner seat (owner 2026-11-11): the transcript-load
      // issue over retained rows, the control/external-Agent banner, access, auth and a failed start.
      const sessionNotices = (
          <>
              <SessionTranscriptLoadIssueNotice sessionId={sessionId} session={session}
                  isEncryptedSessionLocked={isEncryptedSessionLocked} isForkedSessionV1={isForkedSessionV1}
                  isLocallyAttached={isLocallyAttached} pendingMessagesCount={pendingMessages.length} />
              <SessionChatFooter
                  sessionId={sessionId}
                  // With a composer on screen its status line states this cause once; the notice
                  // speaks only where no composer does (a Session that cannot take input).
                  bottomNotice={shouldShowInput || (sessionMachineAccessRemoved && inactiveUi.inactiveStatusTextKey === 'session.accessWithdrawn') ? null : bottomNotice}
                  controlledByUserOverride={isLocallyAttached}
                  controlSwitchTo={controlSwitchTo}
                  onRequestSwitchToRemote={isHiddenSystemSessionSession || !canReleaseLocalControl ? undefined : handleRequestSwitchToRemote}
                  externalControl={externalControlFooter}
              />
              {authRecoveryNotice}{requesterRecoveryBanner}{startFailureBanner}
          </>
      );
      const content = (
          <>
              <SessionTranscriptContent
                  sessionId={sessionId}
                  sessionSurfaceKey={sessionSurfaceKey}
                  session={session}
                  isEncryptedSessionLocked={isEncryptedSessionLocked}
                  isForkedSessionV1={isForkedSessionV1}
                  isLocallyAttached={isLocallyAttached}
                  pendingMessagesCount={pendingMessages.length}
                  jumpToSeq={jumpToSeq}
                  jumpToMessageId={jumpToMessageId}
                  followBottomIntentKey={followBottomIntentSeq}
                  approvalRequests={transcriptApprovalRequests}
                  onViewportChange={handleTranscriptViewportChange}
                  onEditPendingMessage={handleEditPendingMessage}
                  routeHydrationPending={routeHydrationPending}
              />
          </>
      );
    const placeholder = (
        <SessionTranscriptPlaceholder
            sessionId={sessionId}
            session={session}
            isEncryptedSessionLocked={isEncryptedSessionLocked}
            isForkedSessionV1={isForkedSessionV1}
            isLocallyAttached={isLocallyAttached}
            pendingMessagesCount={pendingMessages.length}
            pendingMessagesSettled={pendingMessagesLoaded || pendingReadState === 'error'}
            restoreSecretKeyColor={theme.colors.text.primary}
            restoreSecretKeyDescriptionColor={theme.colors.text.secondary}
            restoreButtonBackgroundColor={theme.colors.surface.inset}
            restoreButtonBorderColor={theme.colors.border.default}
            onRestoreSecretKeyPress={embedded ? null : () => router.push('/restore/manual')}
            activityColor={theme.colors.text.secondary}
        />
    );

    const transcriptSelectionToolbar = transcriptMessageSelectionEnabled === true ? (
        <TranscriptSelectionToolbarController
            bulkCopyFormat={transcriptBulkCopyFormat}
            roleLabels={transcriptSelectionRoleLabels}
            sendToSessionEnabled={transcriptMessageSendToSessionEnabled === true && sessionRouteServerId.trim().length > 0}
            maxWidth={layout.maxWidth}
            onSendToSession={handleSendSelectedTranscriptMessages}
        />
    ) : null;
    // On a phone, an open Find seats its bar in this slot in place of the composer (Find lab F1p).
    const inputWithTranscriptSelection = transcriptSelectionToolbar || input || sessionNotices ? (
        // A session-group tab presented in this column stops at the composer's top (lab AR1 EFv).
        <PaneMainComposerAnchor style={{ gap: theme.space.s8 }}>
            {transcriptSelectionToolbar}
            <SessionPhoneTrackWatchCapsule sessionId={sessionId} serverId={sessionRouteServerId.trim() || null} />
            <SessionWorkspaceFileOriginReturn scopeId={pane.scopeId} />
            <SessionTranscriptCodeAskControls sessionId={sessionId} serverId={sessionRouteServerId.trim() || null}
                scopeId={pane.scopeId} />
            {/* The notices and the composer share one stack, spaced as the composer's own banners are. */}
            {/* With a composer, the notices join its card stack and share the column's room with the input. */}
            <View testID="session-notice-seat">
                {input ? null : sessionNotices}
                <SessionComposerNoticesContext.Provider value={input ? sessionNotices : null}>
                    <FindComposerSlotHost composer={input} />
                </SessionComposerNoticesContext.Provider>
            </View>
        </PaneMainComposerAnchor>
    ) : null;

    const readCockpitChrome = useReadSessionCockpitChromeRegistration();
    const openCompanionFullSurface = React.useCallback((): SessionPresentationMutationOutcome => {
        if (routeMobileSurface === 'companion') return { status: 'unchanged' };
        // A mounted Cockpit (a phone, or a window narrowed to one) presents the Companion as its own surface,
        // through the same switch its bottom bar uses. Beside the chat, the Companion is the side panel's
        // Companion tab, opened through the pane owner like Work (QA-RERUN-1113 R2-2, QA-SHELL C4).
        const cockpit = readCockpitChrome();
        if (cockpit?.sessionId === sessionId) {
            cockpit.switchSurface('companion');
            return { status: 'applied' };
        }
        pane.openRight({ tabId: 'companion' });
        pane.setRightTab('companion');
        return { status: 'applied' };
    }, [pane, readCockpitChrome, routeMobileSurface, sessionId]);
    const boardPresentationUndoCurrentRef = React.useRef(isBoardPresentationUndoCurrent);
    boardPresentationUndoCurrentRef.current = isBoardPresentationUndoCurrent;
    const {
        openBoard: openCompanionBoardForPresentation,
        revealBoardItem: revealCompanionBoardItem,
        returnToChat: returnToCompanionChat,
    } = React.useMemo(() => createSessionCompanionPanePresentation({
        readPane: () => presentationPaneRef.current,
        readMainColumn: () => presentationMainColumnRef.current,
        isUndoCurrent: () => boardPresentationUndoCurrentRef.current(),
    }), []);
    const applyCompanionItemPresentation = React.useCallback((intent: Extract<CurrentSessionPresentationAuthorIntentV1,
        { kind: 'board.item.reveal' | 'chat.item.show' }>) => {
        const lifetime = sessionAccountLifetime;
        if (!lifetime?.isCurrent()) return;
        void actionExecutor.execute('session.presentation.apply', {
            intent,
        }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
            defaultSessionId: sessionId,
        }).then(requireActionSuccess).catch(error => presentSessionActionOutcome(error, lifetime));
    }, [actionExecutor, presentSessionActionOutcome, sessionAccountLifetime, sessionId]);
    const revealCompanionBoardItemThroughPresentation = React.useCallback((widgetId: string) => {
        applyCompanionItemPresentation({ kind: 'board.item.reveal', widgetId });
    }, [applyCompanionItemPresentation]);
    const showCompanionItemInChatThroughPresentation = React.useCallback((widgetId: string, occurrenceId: string) => {
        applyCompanionItemPresentation({ kind: 'chat.item.show', widgetId, occurrenceId });
    }, [applyCompanionItemPresentation]);
    const companionSummaryDestinations = React.useMemo(() => createSessionSummaryDestinations({
        address: { sessionId, serverId: sessionRouteServerId },
        navigate: href => router.push(href as never),
        approvalId: approvalRequests[0]?.artifact.id,
        openWorkStatus: () => setActiveStatusBadgeKey(SESSION_WORK_STATE_STATUS_BADGE_KEY),
        openPane: tabId => { pane.openRight({ tabId }); pane.setRightTab(tabId); },
    }), [approvalRequests, pane, router, sessionId, sessionRouteServerId]);
    // The rail is a flex sibling of Chat, and only the row that holds both can
    // seat it on the viewer's chosen side on every platform. This is the one
    // Companion fact the shell reads: the edge, not the Companion's content.
    const manageCompanionBoardItemPlugin = React.useCallback((itemId: string) => {
        if (!mountedBoard?.controller.supports('item.managePlugin')) return;
        void mountedBoard.controller.run({ kind: 'item.managePlugin', itemId });
    }, [mountedBoard]);
    // Companion is not a Board placement gate. Its first-party Session Summary
    // is composed from Session facts alone, so the Companion host, presentation
    // bridge and reveal port mount on every Home. Where that Home does not serve
    // the Board destination, `boardBinding` simply stays `unavailable`: the
    // Summary still renders and `board: null` discloses no shared item content.
    const companion = (
        <>
            <SessionCompanionPresentationBridge
                sessionId={sessionId}
                serverId={routeServerId}
                applierRef={sessionPresentationApplierRef}
                openBoard={openCompanionBoardForPresentation}
                revealBoardItem={revealCompanionBoardItem}
                returnToChat={returnToCompanionChat}
                openFullSurface={openCompanionFullSurface}
            />
            {/*
              * The Companion outlives the Board binding on purpose. Its built-in
              * Session Summary is composed from Session facts that stay readable
              * while the Board repository is still loading, offline or refused,
              * and its own local references must render the recoverable pending
              * state rather than vanishing — uncertainty is never a deletion.
              * Mounting is inert until this viewer has a visible preference, and
              * `board: null` discloses no shared item content, so the feature and
              * access gates keep living at the entry points that own them.
              */}
            {companionAddress ? <SessionCompanionHost
                session={session}
                address={companionAddress}
                boardBinding={mountedBoard?.binding ?? null}
                {...(mountedBoard?.pluginRuntime ? { pluginRuntime: mountedBoard.pluginRuntime } : {})}
                {...(mountedBoard
                    ? { resolveSourceAvailability: mountedBoard.controller.resolveSourceAvailability }
                    : {})}
                {...(mountedBoard?.callerHostedHtmlRuntime
                    ? { callerHostedHtmlRuntime: mountedBoard.callerHostedHtmlRuntime }
                    : {})}
                openFullSurface={openCompanionFullSurface}
                onRevealBoardItem={revealCompanionBoardItemThroughPresentation}
                {...(mountedBoard?.controller.supports('item.managePlugin') === true
                    ? { onManageBoardItemPlugin: manageCompanionBoardItemPlugin }
                    : {})}
                paneScopeId={paneScopeId}
                // The mounted Board owner adds whether its selected view draws the item, so
                // a Board tab showing another view never claims a Companion item's mount.
                summaryDestinations={companionSummaryDestinations}
            /> : null}
        </>
    );

    const main = (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {/* The header and the desktop page tabs under it stay put: a page in this column starts below them. */}
            {/* The header opens the transcript column, so a docked Companion rail's width is left beside it on the
                rail's side: its title and controls then stand on the transcript's column, as they do without the rail. */}
            {embedded ? null : <PaneMainTopAnchor>
                <SessionHeaderBesideCompanionRail sessionId={sessionId} serverId={companionAddress?.serverId ?? null} paneScopeId={paneScopeId}>
                    <SessionHeaderSlot />
                </SessionHeaderBesideCompanionRail>
                <SessionPageTabs />
            </PaneMainTopAnchor>}
            {/* The transcript's own positioning context: its floating notices anchor below the header. */}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
            <SessionTranscriptSelectionBoundary
                sessionId={sessionId}
                metadata={ownerMetadata}
                enabled={transcriptMessageSelectionEnabled === true}
                locked={isEncryptedSessionLocked}
            >
                <FindComposerSlotProvider>
                {embedded ? (
                    <SessionEmbeddedPartsPublisher
                        sessionId={sessionId}
                        session={session}
                        isEncryptedSessionLocked={isEncryptedSessionLocked}
                        isForkedSessionV1={isForkedSessionV1}
                        isLocallyAttached={isLocallyAttached}
                        pendingMessagesCount={pendingMessages.length}
                        transcript={content}
                        composer={inputWithTranscriptSelection}
                        placeholder={placeholder}
                        arrangement={embeddedArrangement}
                    />
                ) : <SessionTranscriptViewLayout
                    sessionId={sessionId}
                    session={session}
                    isEncryptedSessionLocked={isEncryptedSessionLocked}
                    isForkedSessionV1={isForkedSessionV1}
                    isLocallyAttached={isLocallyAttached}
                    pendingMessagesCount={pendingMessages.length}
                    content={content}
                    input={inputWithTranscriptSelection}
                    placeholder={placeholder}
                    isLandscape={isLandscape}
                    deviceType={deviceType}
                    onBackPress={onBackPress}
                    chatBottomSpacing={chatBottomSpacing}
                    companion={companion}
                    companionEdge={companionEdge}
                />}
                </FindComposerSlotProvider>
            </SessionTranscriptSelectionBoundary>
            {/* The Session's floating viewer floats over this same positioning context (63s1/70s3). */}
            {embedded ? null : <SessionViewerHost sessionId={sessionId} serverId={sessionRouteServerId} pluginProjection={sessionPluginRuntime} />}
            </View>
            {embedded?.repliesBanner ?? null}
        </View>
    );
    const sidebarSurfaceScope = React.useMemo(() => createSessionPaneSurfaceScope(sessionId, sessionPluginRuntime), [sessionId, sessionPluginRuntime]);
    const wrapPaneScopeContent = React.useCallback((content: React.ReactElement) => (
        <SessionViewerSourceAccountScopeProvider accountLifetime={viewerAccountLifetime}>
            <SessionViewerScope sessionId={sessionId} serverId={sessionRouteServerId}>
            <SessionCompanionRevealOwner
                address={companionAddress}
                paneScopeId={paneScopeId}
                openFullSurface={openCompanionFullSurface}
                revealBoardItem={revealCompanionBoardItemThroughPresentation}
                showItemInChat={showCompanionItemInChatThroughPresentation}
            >
                <SessionRightSidebarProvider sessionId={sessionId} scopeId={paneScopeId} paneSurfaceScope={sidebarSurfaceScope}>
                    {content}
                </SessionRightSidebarProvider>
            </SessionCompanionRevealOwner>
            </SessionViewerScope>
        </SessionViewerSourceAccountScopeProvider>
    ), [
        viewerAccountLifetime,
        sessionRouteServerId,
        sessionId,
        sidebarSurfaceScope,
        companionAddress,
        openCompanionFullSurface,
        paneScopeId,
        revealCompanionBoardItemThroughPresentation,
        showCompanionItemInChatThroughPresentation,
    ]);

    const hideSessionLabel = t('panes.mainColumn.hideSession');
    const showSessionLabel = t('panes.mainColumn.showSession');
    const mainColumn = React.useMemo(() => ({
        hideLabel: hideSessionLabel,
        showLabel: showSessionLabel,
        identity: {
            mark: headerAgentId ? <SessionAgentCatalogIdentityIcon agentId={headerAgentId}
                machineId={headerMachineId} serverId={sessionRouteServerId}
                color={theme.colors.text.secondary} size={ICON_SIZE.sm} /> : undefined,
            name: headerTitle,
            // The header's own lifecycle projection: one interpretation of "working" and "needs you".
            state: sessionStatusState === 'thinking' || sessionStatusState === 'archiving' ? 'working' as const
                : sessionStatusState === 'permission_required' || sessionStatusState === 'action_required' ? 'attention' as const
                    : undefined,
        },
    }), [headerAgentId, headerMachineId, headerTitle, hideSessionLabel, showSessionLabel,
        sessionRouteServerId, sessionStatusState, theme.colors.text.secondary]);

    if (embedded) {
        // Embedded in another surface's pane (the peek): the Session's own providers, without its
        // pane columns — the host surface owns the columns this view sits in.
        return (
            <SessionResumeProvider onResumeSession={handleResumeSession}>
                <DetailsStartSheetHost>{wrapPaneScopeContent(main)}</DetailsStartSheetHost>
            </SessionResumeProvider>
        );
    }

    return (
        <SessionResumeProvider onResumeSession={handleResumeSession}>
            <AppPaneScopeHost
                scopeId={paneScopeId}
                arrangement="honour"
                mainColumn={mainColumn}
                onMainColumnControlsChange={onMainColumnControlsChange}
                wrapScopeContent={wrapPaneScopeContent}
                onPluginSurfaceNavigationBindingChange={onAppPanePluginSurfaceNavigationBindingChange}
                // Keep the real session tree mounted; the pane host is responsible for hiding
                // the main region when hidden so visibility toggles don't accidentally
                // render an empty placeholder region.
                main={main}
            />
        </SessionResumeProvider>
    );
});
