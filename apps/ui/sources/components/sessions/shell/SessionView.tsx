import { Typography } from "@/constants/Typography";
import { isEmbedWindowContext } from "@/embed/isEmbedWindowContext";
import { useAppPaneActionRailVisible } from "@/components/appShell/panes/hooks/useAppPaneActionRailVisible";
import { useSessionCockpitChromeRegistration } from "@/components/workspaceCockpit/session/SessionCockpitChromeRegistry";
import { SessionCollaborationHeaderEntry } from "@/components/sessions/collaboration/SessionCollaborationHeaderEntry";
import { useOpenSessionCollaboration } from "@/components/sessions/collaboration/useOpenSessionCollaboration";
import { useSessionCollaborationDestinationAdmitted } from "@/hooks/session/useSessionCollaborationAvailability";
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from "@/sync/domains/session/sessionAddress";
import type { AttachmentDraft } from "@/components/sessions/attachments/attachmentDraftModel";
import { useSessionFileUploadAvailability } from "@/components/sessions/files/useSessionFileUploadAvailability";
import { ChatHeaderView } from "@/components/sessions/transcript/ChatHeaderView";
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
import { seedAndOpenNewSession } from "@/components/sessions/new/newSessionSeedComposer";
import { openTranscriptSendToSessionModal } from "@/components/sessions/transcript/messageSelection/openTranscriptSendToSessionModal";
import { sendTranscriptSelectionToSession } from "@/components/sessions/transcript/messageSelection/sendTranscriptSelectionToSession";
import { useTranscriptSelectionEligibleMessageIds } from "@/components/sessions/transcript/messageSelection/useTranscriptSelectionEligibleMessageIds";
import { EmptyMessages } from "@/components/ui/empty/EmptyMessages";
import type { DropdownMenuItem } from "@/components/ui/forms/dropdown/DropdownMenu";
import { SessionDraftHydrationBoundary } from "@/components/sessions/drafts/SessionDraftHydrationBoundary";
import { useNavigateToSession } from "@/hooks/session/useNavigateToSession";
import { useFeatureEnabled } from "@/hooks/server/useFeatureEnabled";
import { SESSION_BOARD_HEADER_MENU_ACTION_ID } from "@/components/sessions/board/sessionBoardDestination";
import { useSessionBoardFeatureEnabled } from "@/components/sessions/board/useSessionBoardFeatureEnabled";
import { createSessionBoardDetailsTab } from "@/components/sessions/panes/details/sessionDetailsTabBuilders";
import { isSessionBoardVisibleInDetails } from "@/components/sessions/board/sessionBoardDetailsVisibility";
import { useSessionExecutionRunsSupported } from "@/hooks/server/useSessionExecutionRunsSupported";
import { useEventCallback } from "@/hooks/ui/useEventCallback";
import { Modal } from "@/modal";
import { COMPOSER_SETTLED_APPROVAL_PRESENTATIONS, TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from "@/components/tools/shell/approvals/transcriptSettledApprovalPresentations";
import { useToolApprovalRequestsIndex } from '@/components/tools/shell/views/toolApprovalPromptMatching';
import { useWorkspaceRefs, storage, useEnabledAutomationsCountForSession, useComposerApprovalArtifactsForSession, useEndpointConnectivity, useIsDataReady, useLocalSetting, useTranscriptApprovalArtifactsForSession, useSessionPendingMessages, useSessionTranscriptIds, useSessionVisibleReadSeq, useSetting, useSyncError } from "@/sync/domains/state/storage";
import type { SessionRouteHydrationState } from "@/sync/domains/session/sessionRouteHydrationState";
import { readSessionContentAvailability } from "@/sync/domains/session/encryptedContentAvailability";
import { writeSessionInitialPromptV1 } from "@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1";
import { Session } from "@/sync/domains/state/storageTypes";
import { readSessionOwnerMetadataView } from "@/sync/domains/session/readSessionOwnerMetadataView";
import { sync } from "@/sync/sync";
import type { SessionTranscriptLoadIssue } from "@/sync/store/domains/transcriptLoading";
import { t, type TranslationKey } from "@/text";
import { useDeviceType, useIsLandscape, useIsTablet } from "@/utils/platform/responsive";
import { getSessionName, getSessionStatus } from "@/utils/sessions/sessionUtils";
import { deriveTranscriptInteractionFromSession } from "@/utils/sessions/deriveTranscriptInteraction";
import { AppSessionTranscriptSourceProvider } from "@/components/sessions/transcript/source/appSessionTranscriptSource";
import { SessionDiscussionSourceLinksProvider } from "@/components/discussions/SessionDiscussionSourceLinks";
import { useSessionTranscriptSource } from "@/components/sessions/transcript/source/SessionTranscriptSourceContext";
import { isVersionSupported, MINIMUM_CLI_VERSION } from "@/utils/system/versionUtils";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { runAfterInteractionsWithFallback } from "@/utils/timing/runAfterInteractionsWithFallback";
import type { BrowserContextState } from "@/sync/domains/browser/context";
import { SessionBrowserContextRuntimeProvider, type SessionBrowserContextRuntime, useSessionBrowserContextRuntime } from "@/components/sessions/browser/sessionBrowserContextRuntime";
import { useSessionAgentActivity } from "@/hooks/session/useSessionAgentActivity";
import { hasSessionSubagentLaunchCards } from "@/agents/registry/sessionSubagentUiBehavior";
import { nowServerMs } from "@/sync/runtime/time";
import { readSessionUiTelemetryNowMs } from "@/sync/runtime/performance/sessionUiTelemetry";
import { syncPerformanceTelemetry } from "@/sync/runtime/syncPerformanceTelemetry";
import { openNewSessionSourceContextNavigation } from "@/components/sessions/new/navigation/newSessionSourceContextNavigation";
import { requireActionSuccess } from "@/sync/ops/actions/frontDoorRuntimeActionExecutor";
import { useDestinationParams, useDestinationPathname, useDestinationRouter, useDestinationVisibility, useDestinationInstanceKey } from "@/components/appShell/workspace/DestinationInstanceHost";
import * as React from "react";
import { AtmosphereSurfaceFrame } from "@/components/atmosphere/AtmosphereSurfaceFrame";
import { useWorkspaceFileOriginReturn } from "@/components/workspaces/files/useWorkspaceFileOriginReturn";
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from "react-native";
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
import { buildExactTurnAutomationRouteParams, readExactActiveParentTurn } from "@/components/automations/sessionLifecycle/exactTurnAutomationPrefill";
import { SESSION_WORK_STATE_STATUS_BADGE_KEY } from "@/components/sessions/workState/sessionWorkStatePresentation";
import { SessionWorkSourcesProvider, useSessionWorkSourcesOwner, useStableWorkSummary } from "@/components/sessions/work/sessionWorkSources";
import type { SessionRunnerRuntimeStatusSnapshot } from "@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention";
import { useSessionRunnerRuntimeStatusRetention } from "@/components/sessions/sessionRunner/useSessionRunnerRuntimeStatusRetention";
import { normalizeSessionId } from "@/sync/domains/session/normalizeSessionId";
import type { OpenApprovalArtifactForSession } from "@/sync/domains/artifacts/approvalArtifacts";
import { resolveServerIdForSessionIdFromLocalCache } from "@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache";
import { SessionInvalidLinkFallback } from "./SessionInvalidLinkFallback";
import { narrowTranscriptInteractionForPresentation, readEmbeddedSessionPresentation, resolveEmbeddedComposerControls, type SessionViewEmbeddedPresentation, type SessionViewPresentation } from "./embedded/embeddedSessionPresentation";
import { EmbeddedSessionPartClaimsScope, EmbeddedSessionPartsProvider, EmbeddedSessionStandardLayout, EmbeddedSessionStatePublication, type EmbeddedSessionPartsState, type EmbeddedSessionPartsValue } from "./embedded/EmbeddedSessionParts";
import { EmbeddedSessionUnavailable } from "./embedded/EmbeddedSessionUnavailable";
import { PluginSurfaceNestingBoundary } from "@/components/plugins/surfaces/pluginSurfaceNesting";
import { Text } from "@/components/ui/text/Text";
import { SessionRightSidebarProvider } from "@/components/sessions/panes/SessionRightPanel";
import { PaneMainBody, PaneMainComposerAnchor } from '@/components/ui/panels/paneMainComposerAnchor';
import { createSessionPaneSurfaceScope } from "@/components/sessions/plugins/useSessionPluginRuntime";
import { PaneMainHideButton } from "@/components/appShell/panes/mainColumn/PaneMainColumnControls";
import { AppPaneScopeHost } from "@/components/appShell/panes/AppPaneScopeHost";
import { useRegisterSessionPaneDriver } from "@/components/sessions/panes/useRegisterSessionPaneDriver";
import { useTerminalJumpShortcut } from "@/components/sessions/terminal/jump/useTerminalJumpShortcut";
import { useSessionAddressForSessionId, useSessionPluginRuntime, type SessionPluginRuntimeState } from "@/components/sessions/plugins/useSessionPluginRuntime";
import { createSessionPaneScopeId } from "@/components/sessions/panes/sessionPaneScopeId";
import { useSessionBoardPrimaryMountResolver } from "@/components/sessions/board/useSessionBoardPrimaryMountHost";
import type { SessionBoardPrimaryMountResolver } from "@/sync/domains/session/board";
import { SessionBoardControllerProvider, useMountedSessionBoardController } from "@/components/sessions/board/SessionBoardControllerProvider";
import { SessionScreenTestIdsProvider } from "./sessionScreenTestIds";
import { useSessionScreenIsFocused } from "./useSessionScreenIsFocused";
import { resolveMultiPaneDeviceType } from "@/components/appShell/panes/layout/resolveMultiPaneDeviceType";
import type { SessionPaneUrlState } from "@/components/sessions/panes/url/sessionPaneUrlState";
import { buildScopedSessionRouteHref } from "@/hooks/session/sessionRouteServerScope";
import { SessionResumeProvider } from "@/components/sessions/model/SessionResumeContext";
import { useExternalSessionMaterialize } from "@/components/sessions/model/useExternalSessionMaterialize";
import { useExternalSessionRuntime } from "@/components/sessions/model/useExternalSessionRuntime";
import { SessionExternalSessionRuntimeProvider } from "@/components/sessions/model/useSessionExternalSessionRuntime";
import { useAuth } from "@/auth/context/AuthContext";
import { selectSyncErrorForServer } from "@/sync/runtime/connectivity/syncErrorScope";
import type { SessionParticipantTarget } from "@/sync/domains/session/participants/participantTargets";
import type { PendingMessage } from "@/sync/domains/state/storageTypes";
import { useSessionViewBootstrap } from "./view/useSessionViewBootstrap";
import { useSessionViewedLifecycle } from "./view/useSessionViewedLifecycle";
import { resolveMobileWorkspaceExperienceToggleActionId } from "@/components/workspaceCockpit/mobileWorkspaceExperience";
import { useMobileWorkspaceExperienceState } from "@/components/workspaceCockpit/useMobileWorkspaceExperienceState";
import { SessionViewLayout, type SessionViewLayoutProps } from "./view/SessionViewLayout";
import { SessionCompanionHost } from "@/components/sessions/companion/SessionCompanionHost";
import { SessionCompanionRevealOwner } from "@/components/sessions/companion/presentation/SessionCompanionRevealPort";
import { SessionViewerSourceAccountScopeProvider } from "@/components/sessions/viewer/SessionViewerSourceAccountScope";
import { useSessionCompanionPreference } from "@/components/sessions/companion/state/useSessionCompanionPreference";
import { useResolveSessionCompanionPlacementForDensity } from "@/components/sessions/companion/layout/useSessionCompanionPlacement";
import type { SessionCompanionEdge } from "@/components/sessions/companion/state/sessionCompanionPreference";
import { createSessionSummaryDestinations } from "@/components/sessions/companion/summary/sessionSummaryDestinations";
import { SessionCompanionPresentationBridge } from "@/components/sessions/companion/presentation/SessionCompanionPresentationBridge";
import type { SessionPresentationMutationOutcome } from "@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter";
import { createSessionCompanionPanePresentation } from "@/components/sessions/companion/presentation/sessionCompanionPanePresentation";
import type { PaneMainColumnState } from "@/components/appShell/panes/mainColumn/usePaneMainColumn";
import { resolveSessionRoutePathForSurface } from "@/components/workspaceCockpit/session/sessionCockpitState";
import { ComposerAuxiliaryFrame } from "./view/ComposerAuxiliaryFrame";
import { SessionStartFailureBanner } from "@/components/sessions/startFailure/SessionStartFailureBanner";
import { resolveSessionStartFailureNotice } from "@/components/sessions/startFailure/sessionStartFailureNotice";
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
import { resolveSessionViewHeaderProps, shouldFoldSessionHeaderIconActions } from "./view/resolveSessionViewHeaderProps";
import { useWorkspaceSyncRelationshipSummaries } from "@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries";
import { resolveWorkspaceSyncSetAttention } from "@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel";
import { createWorkspaceSyncConflictDetailsTab } from "@/components/workspaces/sync/workspaceSyncConflictDetailsTab";
import { SessionAgentCatalogIdentityIcon } from "@/components/sessions/presentation/SessionAgentCatalogIdentityIcon";
import { BotMarkerFeedback } from "@/components/sessions/bots/botMarkerFeedback";
import { readExternalAgentObservationPresentationInput, resolveExternalSessionRuntimePresentation } from "../presentation/externalSessionRuntimePresentation";
import { resolveExternalSessionIdentityPresentation } from "../presentation/externalSessionIdentityPresentation";
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from "@/hooks/session/sessionListRuntimeClock";
import { usePluginUiClientExecutableRegistrationRevision } from "@/components/plugins/reactNative/clientExecutableContributions";
import { useScopedPluginUiProjection } from "@/components/plugins/projection/useScopedPluginUiProjection";
import { PluginSurfacePaneLaunchScope, stagePluginSurfacePaneLaunch, type PluginSurfaceDestinationOpenResolution, type PluginSurfaceDestinationNavigationBinding, usePluginSurfacePaneLaunchScope } from "@/components/plugins/surfaces/pluginSurfaceDestinationNavigation";
import type { PluginSurfaceOpenHandler, PluginSurfaceOpenOutcome } from "@/components/plugins/surfaces/openPluginSurface";
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from "@/sync/domains/scope/useServerCredentialAccountScopes";
import { resolveSessionViewExternalControlFooter } from "./view/resolveSessionViewExternalControlFooter";
import { readExternalSessionOperationPresentationFromMetadata } from "../transcript/items/externalSessionOperationMetadata";
import { isSessionRootRoutePathActive, isSessionRoutePathActive } from "@/sync/domains/session/sessionSurfaceVisibility";
import { useSurfaceAnchorPathname } from "./surface/sessionSurfaceAnchorPathname";
import { resolveSessionWorkspaceDisplayPresentation } from "@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation";
import { useSessionReachableMachineTarget } from "../model/useSessionMachineReachability";
import { useSessionMachineControlTarget } from "../model/useSessionMachineTarget";
import { resolveSessionAuthSurfaceState, type SessionAuthSurfaceState } from "./sessionAuthSurfaceState";
import { resolveSessionBlockedSurfaceState, type SessionBlockedSurfaceActionIntent } from "./sessionBlockedSurfaceState";
import { SessionBlockedSurfaceCard } from "./SessionBlockedSurfaceCard";
import { SETTINGS_ROUTES } from "@/components/settings/catalog/routes";
import { openRouteWithEstablishedHome } from "@/sync/domains/server/selection/openRouteWithEstablishedHome";
import { useSessionViewShellSession, useSessionViewShellSessionSeq } from "./sessionViewStableSession";
import { ActivitySpinner } from "@/components/ui/feedback/ActivitySpinner";
import { PaneLoadingFallback } from "@/components/ui/panels/PaneLoadingFallback";
import { SurfaceStateCard } from "@/components/ui/surfaces/SurfaceStateCard";
import { Icon, ICON_SIZE } from "@/components/ui/icons/Icon";
import { useSessionComposerController, SessionAuthRecoveryBanner } from "@/components/sessions/composer/useSessionComposerController";
import type { SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';


export { resolveSessionAuthSurfaceState } from './sessionAuthSurfaceState';

const MemoizedSessionViewLoaded = React.memo(SessionViewLoaded);

type SessionViewProps = Readonly<{
    id: string;
    routeServerId?: string | null;
    jumpToSeq?: number | null;
    jumpToMessageId?: string | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocusedOverride?: boolean | null;
    surfaceVisibleOverride?: boolean | null;
    routeAnchorOverride?: boolean | null;
    routeHydrationState?: SessionRouteHydrationState | null;
    contentOverride?: React.ReactNode;
    /** Seats the existing composer once in the session slot or its sheet, under these providers. */
    renderComposer?: SessionComposerRenderer;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    chatBottomSpacing?: 'default' | 'none';
    browserContextStateForComposer?: BrowserContextState | null;
    /** One-shot request from an incumbent Session host to reveal the existing work-state details. */
    openWorkStateRequestKey?: number | null;
    /** Cockpit supplies its one composition-wide executable Board mount decision. */
    resolveBoardPrimaryHost?: SessionBoardPrimaryMountResolver;
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

const SessionContentOverrideViewedLifecycle = React.memo(function SessionContentOverrideViewedLifecycle({
    serverId,
    sessionId,
    surfaceFocused,
}: Readonly<{
    serverId: string;
    sessionId: string;
    surfaceFocused: boolean;
}>) {
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
    latestTurnStatus,
    surfaceFocused,
}: Readonly<{
    serverId: string;
    sessionId: string;
    latestTurnStatus: Session['latestTurnStatus'];
    surfaceFocused: boolean;
}>) {
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
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

function useSessionTranscriptRenderState({
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
}: SessionTranscriptRenderStateInput) {
    const { ids: committedMessageIds, isLoaded } = useSessionTranscriptIds(sessionId);
    const shouldForceRenderTranscriptFooter =
        isForkedSessionV1
        || readExternalSessionLink(readSessionOwnerMetadataView(session)) !== null
        || readExternalSessionOperationPresentationFromMetadata(session.metadata) !== null
        || ((session.seq ?? 0) > 0 && committedMessageIds.length === 0);
    const shouldRenderChatTimeline = !isEncryptedSessionLocked
        && shouldRenderChatTimelineForSession({
            committedMessagesCount: committedMessageIds.length,
            pendingMessagesCount,
            controlledByUser: isLocallyAttached,
            // Some sessions can have a non-zero committed transcript seq but end up with 0 visible
            // main-timeline messages (e.g. newest page is sidechain-only). In that case, we must
            // still render the transcript so it can page backwards to find visible messages.
            forceRenderFooter: shouldForceRenderTranscriptFooter,
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
    const { shouldRenderChatTimeline } = useSessionTranscriptRenderState({
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
    const { shouldRenderChatTimeline } = useSessionTranscriptRenderState(renderStateInput);
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
    bottomNotice: ChatListProps['bottomNotice'];
    controlledByUserOverride: ChatListProps['controlledByUserOverride'];
    controlSwitchTo: ChatListProps['controlSwitchTo'];
    onRequestSwitchToRemote: ChatListProps['onRequestSwitchToRemote'];
    externalControlFooter: ChatListProps['externalControlFooter'];
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
    bottomNotice,
    controlledByUserOverride,
    controlSwitchTo,
    onRequestSwitchToRemote,
    externalControlFooter,
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
    const hasRetainedTranscript = committedMessagesCount > 0;
    const hasPresentableRows = hasRetainedTranscript || pendingMessagesCount > 0;
    const shouldRenderChatTimelineImmediately = shouldRenderChatTimeline
        && (
            isLoaded === true
            || hasPresentableRows
            || (shouldForceRenderTranscriptFooter && transcriptLoadIssue === null)
        );
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
            {shouldRenderChatTimeline ? (
                <ExternalTranscriptLoadIssueBanner sessionId={sessionId} retainedTranscriptVisible={hasRetainedTranscript && shouldRenderChatTimelineImmediately} />
            ) : null}
            {/* Who is using the Session's shared window, at the top of the transcript on every device (lab computer HC). */}
            {shouldRenderChatTimeline ? <SessionComputerPresenceLine sessionId={sessionId} serverId={session.serverId ?? null} /> : null}
            {/* Phone: the viewer docks sticky at the top of the reading flow, the transcript beneath (63s3). */}
            {shouldRenderChatTimeline ? <SessionViewerStickySlot sessionId={sessionId} serverId={session.serverId ?? null} /> : null}
            {shouldRenderChatTimeline && shouldRenderChatTimelineImmediately ? (
                <ChatList
                    session={session}
                    sessionSurfaceKey={sessionSurfaceKey}
                    bottomNotice={bottomNotice}
                    controlledByUserOverride={controlledByUserOverride}
                    controlSwitchTo={controlSwitchTo}
                    onRequestSwitchToRemote={onRequestSwitchToRemote}
                    externalControlFooter={externalControlFooter}
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

type SessionTranscriptPlaceholderProps = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
    restoreSecretKeyColor: string;
    restoreSecretKeyDescriptionColor: string;
    restoreButtonBackgroundColor: string;
    restoreButtonBorderColor: string;
    /** `null` in an embedded arm: a mount never offers the account repair flow or leaves its frame. */
    onRestoreSecretKeyPress: (() => void) | null;
    activityColor: string;
}>;

function resolveExternalTranscriptLoadIssueBody(issue: SessionTranscriptLoadIssue): string {
    if (issue.kind === 'authority_unavailable') {
        return issue.reason === 'machine_offline'
            ? t('newSession.machineOfflineInlineBody')
            : t('externalSessions.sharingTranscriptUnavailable');
    }
    if (issue.kind === 'read_failed') {
        if (issue.errorCode === 'machine_offline') {
            return t('newSession.machineOfflineInlineBody');
        }
        if (issue.errorCode === 'agent_unavailable') {
            return t('externalSessions.browseAgentUnavailable');
        }
        if (issue.errorCode === 'agent_timeout') {
            return t('externalSessions.browseAgentTimedOut');
        }
        if (issue.errorCode === 'agent_error') {
            return t('externalSessions.browseAgentFailed');
        }
    }
    return t('externalSessions.transcriptLoadFailed');
}

function isExternalTranscriptLoadIssueRetryable(issue: SessionTranscriptLoadIssue): boolean {
    if (issue.kind === 'source_discontinuity') return true;
    if (issue.kind === 'read_failed') return issue.errorCode !== 'invalid_request';
    return issue.reason === 'machine_offline';
}

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
    retainedTranscriptVisible = false,
}: Readonly<{ sessionId: string; retainedTranscriptVisible?: boolean }>) {
    const issue = storage((state) => state.sessionTranscriptLoadIssues[sessionId] ?? null);
    const [retrying, setRetrying] = React.useState(false);
    const retryInFlightRef = React.useRef(false);
    const retryable = issue ? isExternalTranscriptLoadIssueRetryable(issue) : false;
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

    if (!issue) return null;

    return (
        <View
            style={retainedTranscriptVisible
                ? { marginTop: 8, marginHorizontal: 8 }
                : {
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 24,
                }}
        >
            <View style={{ width: '100%', maxWidth: retainedTranscriptVisible ? undefined : 560 }}>
                <WarningActionBanner
                    testID="session.externalTranscript.loadIssue"
                    title={retainedTranscriptVisible
                        ? t('externalSessions.transcriptRetainedRefreshFailedTitle')
                        : t('externalSessions.sharingTranscriptUnavailableTitle')}
                    body={resolveExternalTranscriptLoadIssueBody(issue)}
                    actionLabel={retryable ? t('common.retry') : undefined}
                    actionAccessibilityLabel={retryable ? t('common.retry') : undefined}
                    actionTestID={retryable ? 'session.externalTranscript.loadIssue.retry' : undefined}
                    onActionPress={retryable ? handleRetry : undefined}
                    actionBusy={retrying}
                    disabled={retrying}
                />
            </View>
        </View>
    );
});

const SessionTranscriptPlaceholder = React.memo(function SessionTranscriptPlaceholder({
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
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

    if (transcriptLoadIssue) {
        return <ExternalTranscriptLoadIssueBanner sessionId={sessionId} />;
    }

    return isLoaded ? (
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
    const routeFocused = useSessionScreenIsFocused();
    const destinationVisible = useDestinationVisibility();
    const pathname = useDestinationPathname();
    const isFocused = typeof props.surfaceFocusedOverride === 'boolean'
        ? props.surfaceFocusedOverride
        : routeFocused;
    const isSurfaceVisible = typeof props.surfaceVisibleOverride === 'boolean'
        ? props.surfaceVisibleOverride
        : destinationVisible;
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const isRouteAnchor = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : isSessionRoutePathActive(anchorPathname, sessionId);

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
            return <PaneLoadingFallback />;
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
            isFocused={isFocused}
            isSurfaceVisible={isSurfaceVisible}
            isRouteAnchor={isRouteAnchor}
        />
    );
    // The embedded arm's part claims outlive the per-Session surface, so a Session moving between
    // loading, ready and blocked re-publishes its parts into the same slots.
    return props.presentation?.kind === 'embedded'
        ? <PluginSurfaceNestingBoundary><EmbeddedSessionPartClaimsScope>{surface}</EmbeddedSessionPartClaimsScope></PluginSurfaceNestingBoundary>
        : <AtmosphereSurfaceFrame surface="home" session focused={isFocused} visible={isSurfaceVisible}>{surface}</AtmosphereSurfaceFrame>;
});

const EMBEDDED_PANE_DRIVER_OPTIONS = Object.freeze({ registerDriver: false });

// An embedded Session hosts no Board, so no Board item ever takes its executable mount.
const EMBEDDED_SESSION_BOARD_PRIMARY_HOST: SessionBoardPrimaryMountResolver = () => null;

const SessionViewRetainedSurface = React.memo((props: SessionViewProps & {
    sessionId: string;
    sessionSurfaceKey: string;
    isFocused: boolean;
    isSurfaceVisible: boolean;
    isRouteAnchor: boolean;
}) => {
    // Hosts supply visibility independently of focus and route ownership.
    const isPresented = props.presentation?.kind === 'embedded' || typeof props.surfaceVisibleOverride === 'boolean'
        ? props.isSurfaceVisible
        : (props.isFocused || props.isRouteAnchor) && props.isSurfaceVisible;
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
            <SessionViewFocusedSurface
                {...props}
                isPresented={isPresented}
            />
        </View>
    );
});

type SessionViewFocusedSurfaceProps = SessionViewProps & {
    sessionId: string;
    sessionSurfaceKey: string;
    isFocused: boolean;
    isSurfaceVisible: boolean;
    isPresented: boolean;
};

const SessionViewFocusedSurface = React.memo((props: SessionViewFocusedSurfaceProps) => (
    props.presentation?.kind === 'embedded'
        ? <SessionViewFocusedSurfaceEmbeddedOwner {...props} />
        : props.resolveBoardPrimaryHost && props.sessionPluginRuntime
        ? <SessionBoardControllerProvider
            key={`session-board-controller:${props.sessionSurfaceKey}`}
            sessionId={props.sessionId}
            serverId={props.routeHydrationState?.serverId ?? props.routeServerId ?? null}
            pluginRuntime={props.sessionPluginRuntime}
            // The same derived placement the Board, sidebar, Companion and mobile
            // hosts receive as a prop, published for hosts too deep in this shell
            // to be prop-drilled — the inline transcript reference.
            resolvePrimaryHost={props.resolveBoardPrimaryHost}
        >
            <SessionViewFocusedSurfaceContent
                {...props}
                resolveBoardPrimaryHost={props.resolveBoardPrimaryHost}
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
            resolveBoardPrimaryHost={EMBEDDED_SESSION_BOARD_PRIMARY_HOST}
            sessionPluginRuntime={props.sessionPluginRuntime ?? sessionPluginRuntime}
        />
    );
});

const SessionViewFocusedSurfaceBoardOwner = React.memo((props: SessionViewFocusedSurfaceProps) => {
    const instanceKey = useDestinationInstanceKey();
    const serverId = props.routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const address = useSessionAddressForSessionId(props.sessionId, serverId);
    const sessionPluginRuntime = useSessionPluginRuntime({ address });
    const paneScopeId = React.useMemo(
        () => createSessionPaneScopeId(props.sessionId, address?.serverId ?? serverId, instanceKey),
        [address?.serverId, instanceKey, serverId, props.sessionId],
    );
    const resolveBoardPrimaryHost = useSessionBoardPrimaryMountResolver({
        address,
        paneScopeId,
        presented: props.isPresented,
    });
    return (
        <SessionBoardControllerProvider
            key={`session-board-controller:${props.sessionSurfaceKey}`}
            sessionId={props.sessionId}
            serverId={address?.serverId ?? serverId}
            pluginRuntime={sessionPluginRuntime}
            resolvePrimaryHost={resolveBoardPrimaryHost}
        >
            <SessionViewFocusedSurfaceContent
                {...props}
                resolveBoardPrimaryHost={resolveBoardPrimaryHost}
                sessionPluginRuntime={sessionPluginRuntime}
            />
        </SessionBoardControllerProvider>
    );
});

type SessionViewFocusedSurfaceContentProps = SessionViewFocusedSurfaceProps & {
    resolveBoardPrimaryHost: SessionBoardPrimaryMountResolver;
    sessionPluginRuntime: SessionPluginRuntimeState;
};

const SessionViewFocusedSurfaceContent = React.memo((props: SessionViewFocusedSurfaceContentProps) => (
    <PluginSurfacePaneLaunchScope accountLifetime={props.sessionPluginRuntime.accountLifetime}>
        <SessionViewFocusedSurfaceContentBody {...props} />
    </PluginSurfacePaneLaunchScope>
));

const SessionViewFocusedSurfaceContentBody = React.memo((props: SessionViewFocusedSurfaceContentProps) => {
    const sessionId = props.sessionId;
    const isFocused = props.isFocused;
    const isSurfaceVisible = props.isSurfaceVisible;
    const router = useDestinationRouter();
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
        acceptedSessionId,
        executionRunServerId,
    );
    const approvalSessionAddress = normalizeSessionAddress(
        expectedRouteServerId ?? session?.serverId,
        sessionId,
    );
    const approvalRequests = useComposerApprovalArtifactsForSession(approvalSessionAddress, COMPOSER_SETTLED_APPROVAL_PRESENTATIONS);
    // The transcript also keeps decided approvals whose body has a settled presentation (AGW-8).
    const transcriptApprovalRequests = useTranscriptApprovalArtifactsForSession(approvalSessionAddress, TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS);
    useToolApprovalRequestsIndex(transcriptApprovalRequests);
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
    // Visibility follows the anchor route (an overlay such as /new does not replace the screen
    // behind it); URL ownership below deliberately stays on the raw pathname, because while an
    // overlay is open the address bar belongs to the overlay.
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const activeSessionRoute = isSessionRoutePathActive(anchorPathname, sessionId);
    const isActiveSessionRoute = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : activeSessionRoute;
    const isPaneUrlSyncRouteActive = isFocused && isSurfaceVisible && (
        typeof props.routeAnchorOverride === 'boolean'
            ? props.routeAnchorOverride
            : isSessionRootRoutePathActive(pathname, sessionId)
    );
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
    const shouldRenderSessionSurface = props.isPresented;
    const shouldRetainSessionSurface = Platform.OS === 'web'
        ? shouldRenderSessionSurface
        : true;
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
    const headerMachineTarget = useSessionReachableMachineTarget(sessionId);
    const statusControlMachineTarget = useSessionMachineControlTarget(sessionId);
    const currentSessionMachineId = statusControlMachineTarget?.machineId
        ?? headerMachineTarget?.machineId
        ?? null;
    const sessionRunnerRuntimeStatusRetention = useSessionRunnerRuntimeStatusRetention({
        enabled: Boolean(session && shouldRenderSessionSurface),
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
    const paneScopeId = useRegisterSessionPaneDriver(
        sessionId,
        props.routeServerId,
        props.resolveBoardPrimaryHost,
        props.sessionPluginRuntime,
        embedded ? EMBEDDED_PANE_DRIVER_OPTIONS : undefined,
    );
    // ⌘J / ⌥J: Jump to a terminal of this session. An embedded presentation is not the focused session.
    useTerminalJumpShortcut(embedded ? '' : paneScopeId);
    const actionRailVisible = useAppPaneActionRailVisible(paneScopeId);
    const cockpitChrome = useSessionCockpitChromeRegistration();
    const mobileTerminalTabAvailable = deviceType === 'phone'
        && cockpitChrome?.sessionId === sessionId
        && cockpitChrome.terminalTabAvailable;
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
        isSurfaceFocused,
    } = useSessionViewBootstrap({
        sessionId,
        serverId: session?.serverId ?? currentSessionRouteServerId,
        paneScopeId,
        paneUrlState: props.paneUrlState ?? null,
        multiPaneEnabled,
        sessionsRightPaneDefaultOpen: sessionsRightPaneDefaultOpen === true,
        deviceType,
        sessionPath: ownerMetadata?.path ?? null,
        sessionAccepted: session != null,
        surfaceFocused: isFocused,
        surfaceRetained: shouldRetainSessionSurface,
        surfaceVisible: isSurfaceVisible,
        routeAnchor: isActiveSessionRoute,
        paneUrlSyncRouteActive: isPaneUrlSyncRouteActive,
        paneEffectsEnabled: !embedded,
    });
    const { messages: pendingMessages, isLoaded: pendingMessagesLoaded, readState: pendingReadState } = useSessionPendingMessages(sessionId);
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
        enabled: isSurfaceFocused && session != null,
    });
    const externalAgentPresentationClockEnabled = isSurfaceVisible
        && externalSessionRuntime.externalSessionLink !== null;
    const externalAgentPresentationNowMs = useSessionListRuntimeNowMs(externalAgentPresentationClockEnabled);
    const externalSessionRuntimePresentation = React.useMemo(() => {
        if (!stableSessionForHeader || !externalSessionRuntime.externalSessionLink) return null;
        const hostedStatus = getSessionStatus(stableSessionForHeader, externalAgentPresentationNowMs, {
            workingTextMode: 'static',
        });
        return resolveExternalSessionRuntimePresentation({
            controlConnectivity: hostedStatus.isConnected ? 'connected' : 'offline',
            detachedActivity: hostedStatus.state === 'background_active'
                ? 'active'
                : hostedStatus.isConnected
                    ? 'idle'
                    : 'unknown',
            externalAgent: readExternalAgentObservationPresentationInput(
                readSessionOwnerMetadataView(stableSessionForHeader),
            ),
            nowMs: externalAgentPresentationNowMs,
        });
    }, [externalAgentPresentationNowMs, externalSessionRuntime.externalSessionLink, stableSessionForHeader]);
    useSessionListRuntimeWake(
        externalSessionRuntimePresentation?.externalAgent.nextExpiryAtMs ?? null,
        externalAgentPresentationClockEnabled,
    );
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
        enabled: browserContextFeatureEnabled && isSurfaceFocused && session != null,
        scopeKey: acceptedSessionId,
        sessionId: acceptedSessionId,
        attachmentsUploadsEnabled: attachmentsUploadsAvailable,
        nowMs: nowServerMs,
        onAttachUnavailable: React.useCallback(() => {
            Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
        }, []),
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
    const sessionWorkSources = useSessionWorkSourcesOwner({
        sessionId: acceptedSessionId,
        serverId: expectedRouteServerId ?? session?.serverId ?? null,
        ownerMetadata,
        agentActivity: sessionAgentActivity,
        enabled: acceptedSessionId !== '',
    });
    const workSummary = useStableWorkSummary(sessionWorkSources.projection.summary);
    const shouldShowSubagentsButton = subagentCounts.total > 0 || sessionExecutionRunsSupported || hasSessionSubagentLaunchCards(session);

    const sessionAutomationsEnabledCount = useEnabledAutomationsCountForSession(sessionId, {
        enabled: showAutomations,
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
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(currentSessionRouteServerId ?? '');
    const collaborationAvailable = session !== null && sessionRouteAddress !== null && collaborationAdmitted;
    const foldCollaborationHeaderEntry = shouldFoldSessionHeaderIconActions(windowWidth);
    const collaborationHeader = React.useMemo(() => collaborationAvailable && sessionRouteAddress
        ? { target: sessionRouteAddress, compact: foldCollaborationHeaderEntry }
        : undefined, [collaborationAvailable, sessionRouteAddress, foldCollaborationHeaderEntry]);
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
        if (actionId === 'header.openAttachedSessionTerminal') {
            attachedSessionTerminal.open();
            return true;
        }
        if (actionId === SESSION_BOARD_HEADER_MENU_ACTION_ID) {
            openSessionBoard();
            return true;
        }
        if (actionId === 'header.openSubagents') {
            paneRef.current.openRight({ tabId: 'agents' });
            paneRef.current.setRightTab('agents');
            return true;
        }
        if (actionId === 'header.openAutomations') {
            navigateWithBlurOnWeb(() => routerRef.current.push(buildCurrentSessionHref('/triggers') as any));
            return true;
        }
        if (actionId === 'header.automateExactTurnCompletion') {
            const observed = readExactActiveParentTurn(storage.getState().sessions[sessionId]);
            if (!observed) return true;
            navigateWithBlurOnWeb(() => routerRef.current.push({
                // The Work tab's Triggers section, with its popover bound to this exact turn (04 §5.5).
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
                Keyboard.dismiss();
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
        openSessionBoard,
        attachedSessionTerminal,
        buildCurrentSessionHref,
        mobileWorkspaceExperience,
        pathname,
        sessionId,
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
        if (showAutomations && readExactActiveParentTurn(stableSessionForHeader)) {
            items.push({
                id: 'header.automateExactTurnCompletion',
                title: t('automations.exactTurn.actionTitle'),
                icon: <Icon name="clock" size={16} color={theme.colors.text.secondary} />,
            });
        }
        return items.length > 0 ? items : undefined;
    }, [attachedSessionTerminal.available, mobileWorkspaceExperience, repeatableWorkflow.available, showAutomations, showWorkspaceExperienceToggle, stableSessionForHeader, theme.colors.text.secondary, workspaceExperienceToggleLabelKey]);

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

    // Compute header props based on session state
    const headerProps = React.useMemo(() => resolveSessionViewHeaderProps({
        isDataReady,
        routeHydrationState,
        blockedSurface: headerBlockedSurface,
        session: stableSessionForHeader,
        currentMachineId: currentSessionMachineId,
        sessionId,
        sessionInfoHref: buildCurrentSessionHref('/info'),
        sessionRunsHref: buildCurrentSessionHref('/runs'),
        sessionAutomationsHref: buildCurrentSessionHref('/automations'),
        paneScopeId,
        windowWidth,
        actionRailVisible,
        mobileTerminalTabAvailable,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        showAutomations,
        shouldShowSubagentsButton,
        subagentActiveCount: subagentCounts.live,
        workSummary,
        navigateWithBlurOnWeb,
        handleHeaderExtraItemSelect,
        headerMenuExtraItems,
        collaborationHeader,
        router: routerRef.current,
        actionIconColor: theme.colors.text.secondary,
        headerTintColor: theme.colors.chrome.header.foreground,
        statusErrorColor: theme.colors.status.error,
        workspaceSubtitle: headerWorkspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: headerWorkspaceDisplay.subtitleEllipsizeMode,
        externalSessionRuntime: externalSessionRuntimePresentation,
        pluginUiProjection: headerPluginProjection.pluginUiProjection,
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
        actionRailVisible,
        mobileTerminalTabAvailable,
        buildCurrentSessionHref,
        clientExecutableRegistrationRevision,
        currentSessionMachineId,
        handleHeaderExtraItemSelect,
        handleOpenSessionPluginSurface,
        headerPluginScopeIsCurrent,
        sessionAccountBinding,
        headerScopedLaunchFacts,
        headerPluginProjection.pluginUiProjection,
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
        subagentCounts.live,
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
            {collaborationAvailable && sessionRouteAddress ? (
                <SessionCollaborationHeaderEntry
                    target={sessionRouteAddress}
                    compact={foldCollaborationHeaderEntry}
                    onPress={openSessionCollaboration}
                />
            ) : null}
            <PaneMainHideButton color={theme.colors.chrome.header.foreground} />
        </>
    ), [theme.colors.chrome.header.foreground, collaborationAvailable, sessionRouteAddress, foldCollaborationHeaderEntry, headerProps.rightElement, openSessionCollaboration]);

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
            <ChatHeaderView
                {...headerProps}
                rightElement={headerRightElement}
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
                onBackPress={handleBackPress}
                showBackButton={!isTablet}
                includeTopInset={headerSafeAreaTopMode !== 'external'}
                onPullAllTabs={isTablet ? undefined : handlePullAllTabs}
            />
            {isTablet ? null : <PhoneOpenTabsRail />}
        </View>
    ) : null, [
        handlePullAllTabs,
        sessionId,
        currentSessionRouteServerId,
        handleBackPress,
        headerMachineTarget?.machineId,
        headerProps,
        headerRightElement,
        headerSafeAreaTopMode,
        isTablet,
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
            return surface(<SessionAuthRecoveryFallback message={blockedSurfaceState.auth.message} />, 'blocked');
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
            return surface(<PaneLoadingFallback testID="session-route-loading" />, 'loading');
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
        <SessionScreenTestIdsProvider enabled={isFocused}>
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
                        surfaceFocused={isSurfaceVisible && isFocused}
                    />
                ) : (
                    <SessionTranscriptViewedLifecycle
                        serverId={currentSessionRouteServerId}
                        sessionId={sessionId}
                        latestTurnStatus={session.latestTurnStatus}
                        surfaceFocused={isSurfaceVisible && isFocused}
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
                       <MemoizedSessionViewLoaded
                           renderComposer={props.renderComposer}
                           authSurfaceState={authSurfaceState}
                           key={props.sessionSurfaceKey}
                           header={sessionHeader}
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
                           surfaceFocused={isSurfaceFocused}
                           surfacePresented={props.isPresented}
                           onBackPress={handleBackPress}
                           isEncryptedSessionLocked={isEncryptedSessionLocked}
                           executionRunsEnabled={executionRunsEnabled}
                           jumpToSeq={props.jumpToSeq ?? null}
                           jumpToMessageId={props.jumpToMessageId ?? null}
                           participantTargets={participantTargets}
                           approvalRequests={approvalRequests}
                           transcriptApprovalRequests={transcriptApprovalRequests}
                           paneUrlState={props.paneUrlState ?? null}
                           initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                           attachmentsUploadsEnabled={attachmentsUploadsEnabled}
                           attachmentsUploadsAvailable={attachmentsUploadsAvailable}
                           browserContextStateForComposer={browserContextStateForComposer}
                           browserContextComposerContext={browserContextComposerContext}
                           paneScopeId={paneScopeId}
                           resolveBoardPrimaryHost={props.resolveBoardPrimaryHost}
                           sessionPluginRuntime={props.sessionPluginRuntime}
                           pendingMessages={pendingMessages}
                           pendingMessagesLoaded={pendingMessagesLoaded}
                           pendingReadState={pendingReadState}
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
                       </ComposerBannerCollapseProvider>
                  )}
            </View>
        </SessionScreenTestIdsProvider>
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
    const interaction = React.useMemo(
        () => narrowTranscriptInteractionForPresentation(deriveTranscriptInteractionFromSession(props.session), props.embedded),
        [props.session.access, props.session.active, props.session.presence, props.embedded],
    );
    return <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.routeServerId ?? props.session.serverId} interaction={interaction} navigation={props.embedded?.navigation}>
        <SessionDraftHydrationBoundary lifetime={props.accountBinding} addresses={[{ kind: 'session', sessionId: props.sessionId }]}>
            <SessionDiscussionSourceLinksProvider sessionId={props.sessionId} serverId={props.routeServerId ?? props.session.serverId ?? null}>
                <SessionViewLoadedContent {...props} />
            </SessionDiscussionSourceLinksProvider>
        </SessionDraftHydrationBoundary>
    </AppSessionTranscriptSourceProvider>;
}
function SessionViewLoadedContent({
    renderComposer,
    authSurfaceState,
    header,
    headerTitle,
    headerAgentId,
    headerMachineId,
    sessionId,
    sessionSurfaceKey,
    routeServerId,
    accountBinding,
    routeMobileSurface,
    session,
    pane,
    isMachineReachable,
    machineReachability,
    surfaceFocused,
    surfacePresented,
    onBackPress,
    isEncryptedSessionLocked,
    executionRunsEnabled,
    jumpToSeq,
    jumpToMessageId,
    participantTargets,
    approvalRequests,
    transcriptApprovalRequests,
    paneUrlState,
    initialAttachmentDrafts,
    attachmentsUploadsEnabled,
    attachmentsUploadsAvailable,
    browserContextStateForComposer,
    browserContextComposerContext,
    paneScopeId,
    resolveBoardPrimaryHost,
    sessionPluginRuntime,
    pendingMessages,
    pendingMessagesLoaded,
    pendingReadState,
    externalSessionRuntime,
    externalSessionRuntimePresentation,
    externalSessionIdentityPresentation,
    chatBottomSpacing,
    routeHydrationPending,
    sessionRunnerRuntimeStatus,
    sessionRunnerRuntimeStatusMachineId,
    onSessionRunnerRuntimeStatusInvalidated,
    onAppPanePluginSurfaceNavigationBindingChange,
    collaborationTarget,
    collaborationAvailable,
    foldCollaborationHeaderEntry,
    openSessionCollaboration,
    openSessionAccess,
    companionEdge,
    openWorkStateRequestKey,
    embedded,
    embeddedArrangement,
}: {
    renderComposer?: SessionComposerRenderer;
    /** The session header: it opens the transcript column, so it spans the transcript's width. */
    header: React.ReactNode;
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
    surfaceFocused: boolean;
    surfacePresented: boolean;
    onBackPress: () => void;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    jumpToSeq: number | null;
    jumpToMessageId: string | null;
    participantTargets: readonly SessionParticipantTarget[];
    approvalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    /** Open approvals plus decided ones whose body keeps a settled presentation (the transcript's list). */
    transcriptApprovalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    attachmentsUploadsEnabled: boolean;
    attachmentsUploadsAvailable: boolean;
    browserContextStateForComposer: BrowserContextState | null;
    browserContextComposerContext: SessionBrowserContextRuntime['composerContext'] | null;
    paneScopeId: string;
    resolveBoardPrimaryHost: SessionBoardPrimaryMountResolver;
    sessionPluginRuntime: SessionPluginRuntimeState;
    pendingMessages: readonly PendingMessage[];
    pendingMessagesLoaded: boolean;
    pendingReadState: 'loading' | 'error' | undefined;
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
}) {
    const { composer, view: {
        companionAddress,
        ownerMetadata,
        machineId,
        sessionRouteServerId,
        sessionAccountLifetime,
        attachmentDraftManager,
        cliAuthState,
        currentSessionAgentCatalogEntry,
        controlSwitchAttemptIdRef,
        controlSwitchTo,
        setControlSwitchTo,
        hasWriteAccess,
        controlSwitchCallerRef,
        sessionViewCaller,
        executeRecoveryAction,
        externalTranscriptAuthorityState,
        externalSessionTakeover,
        externalSessionOperationShell,
        isHiddenSystemSessionSession,
        sessionAccountScope,
        router,
        sessionMachineAccessRemoved,
        machineName,
        inactiveUi,
        theme,
        isLocallyAttached,
        shouldShowInput,
        bottomNotice,
        followBottomIntentSeq,
        setFollowBottomIntentSeq,
        handleEditPendingMessage,
        boardPresentationUndoCurrentRef,
        actionExecutor,
        presentSessionActionOutcome,
        activeStatusBadgeKey,
        setActiveStatusBadgeKey,
        sessionPresentationApplierRef,
        sessionStatus,
        handleResumeSession
    } } = useSessionComposerController({
        authSurfaceState,
        sessionId,
        routeServerId,
        accountBinding,
        session,
        pane,
        isMachineReachable,
        machineReachability,
        surfaceFocused,
        surfacePresented,
        isEncryptedSessionLocked,
        executionRunsEnabled,
        participantTargets,
        approvalRequests,
        initialAttachmentDrafts,
        attachmentsUploadsEnabled,
        attachmentsUploadsAvailable,
        browserContextStateForComposer,
        browserContextComposerContext,
        pendingMessages,
        pendingMessagesLoaded,
        pendingReadState,
        externalSessionRuntime,
        sessionRunnerRuntimeStatus,
        sessionRunnerRuntimeStatusMachineId,
        onSessionRunnerRuntimeStatusInvalidated,
        collaborationTarget,
        collaborationAvailable,
        foldCollaborationHeaderEntry,
        openSessionAccess,
        openWorkStateRequestKey,
        embedded
    });
    const input = shouldShowInput && renderComposer ? renderComposer(composer) : composer.content;

    const mountedBoard = useMountedSessionBoardController(companionAddress);
    const presentationPaneRef = React.useRef(pane);
    presentationPaneRef.current = pane;
    const presentationMainColumnRef = React.useRef<PaneMainColumnState | null>(null);
    const onMainColumnControlsChange = React.useCallback((controls: PaneMainColumnState | null) => {
        presentationMainColumnRef.current = controls;
    }, []);
    const pathname = useDestinationPathname();
    const safeArea = useChromeSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const forkV1 = ownerMetadata?.forkV1;
    const isForkedSessionV1 =
        forkV1?.v === 1 &&
        typeof forkV1.parentSessionId === 'string' &&
        forkV1.parentSessionId.trim().length > 0;

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = ownerMetadata?.version;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = Boolean(isCliOutdated && !isAcknowledged);
    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(ownerMetadata);
    const viewerDestination = useSessionViewerDestinationScope(sessionId, sessionRouteServerId);
    const viewerAccountLifetime = viewerDestination?.accountLifetime ?? sessionAccountLifetime;
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptMessageSendToSessionTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const navigateToSession = useNavigateToSession();
    const getAttachmentDraftRevisionSnapshot = attachmentDraftManager.getDraftRevisionSnapshot;

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            }, { source: 'ui' });
        }
    }, [acknowledgedCliVersions, cliVersion, machineId]);
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
    const externalSessionMaterialize = useExternalSessionMaterialize({
        sessionId,
        hasWriteAccess,
        externalSessionRuntime,
    });

    const externalSessionMaterializeNeeded =
        externalTranscriptAuthorityState.sharing.kind === 'requires_persisted_import';
    const requestExternalSessionTakeoverPreflight = useEventCallback(
        () => externalSessionTakeover.requestTakeoverPreflight(),
    );
    const requestExternalSessionMaterialize = useEventCallback(
        () => externalSessionMaterialize.requestMaterialize(),
    );
    const externalControlFooter = React.useMemo(
        () => resolveSessionViewExternalControlFooter({
            externalSessionOperationRunning: externalSessionOperationShell.running,
            externalSessionOperationBlocksNewOperation: externalSessionOperationShell.blocksNewOperation,
            externalSessionLink: externalSessionRuntime.externalSessionLink
                ? { machineId: externalSessionRuntime.externalSessionLink.machineId }
                : null,
            externalSessionRuntimePresentation: externalSessionRuntimePresentation
                ? {
                    externalAgent: {
                        state: externalSessionRuntimePresentation.externalAgent.state,
                        labelKey: externalSessionRuntimePresentation.externalAgent.labelKey,
                    },
                }
                : null,
            externalSessionIdentity: {
                agentLabel: externalSessionIdentityPresentation.agentLabel,
                machineLabel: externalSessionIdentityPresentation.machineLabel,
            },
            materializeNeeded: externalSessionMaterializeNeeded,
            hasWriteAccess,
            externalSessionRuntime: {
                status: externalSessionRuntime.status
                    ? {
                        machineOnline: externalSessionRuntime.status.machineOnline,
                        runnerActive: externalSessionRuntime.status.runnerActive,
                        activity: externalSessionRuntime.status.activity,
                        canTakeOverDirect: externalSessionRuntime.status.canTakeOverDirect,
                        canTakeOverPersist: externalSessionRuntime.status.canTakeOverPersist,
                        trustedPid: externalSessionRuntime.status.trustedPid,
                    }
                    : null,
            },
            externalSessionTakeover: {
                takeoverInFlight: externalSessionTakeover.takeoverInFlight,
                takeoverPreflightInFlight: externalSessionTakeover.takeoverPreflightInFlight,
                requestTakeoverPreflight: requestExternalSessionTakeoverPreflight,
            },
            externalSessionMaterialize: {
                materializeInFlight: externalSessionMaterialize.materializeInFlight,
                requestMaterialize: requestExternalSessionMaterialize,
            },
            isHiddenSystemSessionSession,
        }),
        [
            externalSessionIdentityPresentation.agentLabel,
            externalSessionIdentityPresentation.machineLabel,
            externalSessionMaterialize.materializeInFlight,
            externalSessionMaterializeNeeded,
            externalSessionOperationShell.blocksNewOperation,
            externalSessionOperationShell.running,
            externalSessionRuntime.externalSessionLink?.machineId,
            externalSessionRuntime.status?.activity,
            externalSessionRuntime.status?.canTakeOverDirect,
            externalSessionRuntime.status?.canTakeOverPersist,
            externalSessionRuntime.status?.machineOnline,
            externalSessionRuntime.status?.runnerActive,
            externalSessionRuntime.status?.trustedPid,
            externalSessionRuntimePresentation?.externalAgent.labelKey,
            externalSessionRuntimePresentation?.externalAgent.state,
            externalSessionTakeover.takeoverInFlight,
            externalSessionTakeover.takeoverPreflightInFlight,
            hasWriteAccess,
            isHiddenSystemSessionSession,
            requestExternalSessionMaterialize,
            requestExternalSessionTakeoverPreflight,
        ],
    );

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
                nowMs: Date.now,
                chooseDestinationSessionId: openTranscriptSendToSessionModal,
                writeInitialPrompt: async ({ destinationSessionId, serverId, prompt }) => {
                    await sync.patchSessionMetadataWithRetry(destinationSessionId, (metadata) =>
                        writeSessionInitialPromptV1({
                            metadata,
                            text: prompt.text,
                            mode: prompt.mode,
                            createdAtMs: prompt.createdAtMs,
                            sourceMessageIds: prompt.sourceMessageIds,
                            sourceSessionId: prompt.sourceSessionId,
                        }),
                    { serverId });
                },
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
                    const outcome = seedAndOpenNewSession({
                        seed: {
                            prompt: promptText,
                            ...(placement === undefined ? {} : { placement }),
                        },
                        // There are no attachment contributions in this flow;
                        // the canonical seed owner still requires a caller
                        // identity for the same public boundary used by the
                        // Host API.
                        pluginId: 'happier.transcript.selection',
                        scope: sessionAccountScope,
                        isCurrent: () => accountLifetime.isCurrent(),
                        navigateToNewSession: ({
                            dataId,
                            draftId,
                            worktree,
                            spawnServerId,
                            machineId,
                            directory,
                        }) => {
                            router.push({
                                pathname: '/new',
                                params: {
                                    draftId,
                                    ...(dataId === null ? {} : { dataId }),
                                    ...(worktree === undefined ? {} : { worktree }),
                                    ...(spawnServerId === undefined ? {} : { spawnServerId }),
                                    ...(machineId === undefined ? {} : { machineId }),
                                    ...(directory === undefined ? {} : { directory }),
                                },
                            });
                        },
                    });
                    return outcome.kind === 'opened';
                },
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
        router,
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
                          title={t('machineRequester.accessRemoved', { machine: machineName })}
                          body={t('machineRequester.resumeElsewhere', { machine: machineName })}
                          actionTestID="session-requester-continue-elsewhere"
                          actionLabel={t('common.continue')}
                          actionAccessibilityLabel={t('common.continue')}
                          onActionPress={() => { openNewSessionSourceContextNavigation({
                              session,
                              sourceSessionId: sessionId,
                              forkPoint: { type: 'latest' },
                              serverId: sessionRouteServerId ?? null,
                              machineId: null,
                              accountLifetime: sessionAccountLifetime,
                              navigateToNewSession: route => router.push(route),
                          }); }}
                      />
                  </ComposerAuxiliaryFrame>
              ) : null;
      // Retry is the Resume owner and is offered only while it can run, as the status line's own Resume is.
      const startFailureRetry = inactiveUi.shouldShowInput && inactiveUi.noticeKind === 'none'
          && !sessionMachineAccessRemoved && hasWriteAccess
          ? {
              busy: sessionStatus.state === 'resuming',
              run: () => fireAndForget(handleResumeSession(), { tag: 'SessionView.startFailure.retry' }),
          }
          : null;
      const startFailureNotice = resolveSessionStartFailureNotice({ issue: session.lastRuntimeIssue, sessionActive: session.active === true });
      const startFailureRecovery = startFailureNotice?.code === 'plugin_disabled'
          ? resolveResumeFailurePresentation({ errorCode: startFailureNotice.code }, startFailureNotice.message,
              resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })))
          : null;
      const disabledPluginId = startFailureRecovery?.kind === 'plugin_disabled' ? startFailureRecovery.pluginId : null;
      const startFailureBanner = startFailureNotice
          ? <SessionStartFailureBanner notice={startFailureNotice} retry={startFailureRetry}
              {...(disabledPluginId ? { managePlugin: () => {
                  const route = buildPluginDetailRoute('settings', disabledPluginId);
                  router.push({ ...route, params: { ...route.params, ...storeMachineRouteParams(
                      machineId ? { serverId: sessionRouteServerId, machineId } : null,
                  ) } });
              } } : {})} />
          : null;
      const content = (
          <>
              {authSurfaceState && !(inactiveUi.shouldShowInput && !isEncryptedSessionLocked) ? (
                  <View style={{ marginTop: theme.space.s8, marginHorizontal: theme.space.s8 }}>
                      <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                  </View>
              ) : null}
              <SessionTranscriptContent
                  sessionId={sessionId}
                  sessionSurfaceKey={sessionSurfaceKey}
                  session={session}
                  isEncryptedSessionLocked={isEncryptedSessionLocked}
                  isForkedSessionV1={isForkedSessionV1}
                  isLocallyAttached={isLocallyAttached}
                  pendingMessagesCount={pendingMessages.length}
                  // With a composer on screen its status line states this cause once; the notice
                  // speaks only where no composer does (a Session that cannot take input).
                  bottomNotice={shouldShowInput ? null : bottomNotice}
                  controlledByUserOverride={isLocallyAttached}
                  controlSwitchTo={controlSwitchTo}
                  onRequestSwitchToRemote={isHiddenSystemSessionSession || !canReleaseLocalControl ? undefined : handleRequestSwitchToRemote}
                  externalControlFooter={externalControlFooter}
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
            restoreSecretKeyColor={theme.colors.text.primary}
            restoreSecretKeyDescriptionColor={theme.colors.text.secondary}
            restoreButtonBackgroundColor={theme.colors.surface.inset}
            restoreButtonBorderColor={theme.colors.border.default}
            onRestoreSecretKeyPress={embedded ? null : () => router.push('/restore/manual')}
            activityColor={theme.colors.text.secondary}
        />
    );
    useWorkspaceFileOriginReturn(pane.scopeId, surfaceFocused && surfacePresented);

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
    const inputWithTranscriptSelection = transcriptSelectionToolbar || input ? (
        // A session-group tab presented in this column stops at the composer's top (lab AR1 EFv).
        <PaneMainComposerAnchor style={{ gap: theme.space.s8 }}>
            {transcriptSelectionToolbar}
            <SessionPhoneTrackWatchCapsule sessionId={sessionId} serverId={sessionRouteServerId.trim() || null} />
            <TranscriptCodeAskControls sessionId={sessionId} serverId={sessionRouteServerId.trim() || null}
                scopeId={pane.scopeId} active={surfaceFocused && surfacePresented} />
            <FindComposerSlotHost composer={input} />
        </PaneMainComposerAnchor>
    ) : null;

    const openCompanionFullSurface = React.useCallback((): SessionPresentationMutationOutcome => {
        if (routeMobileSurface === 'companion') return { status: 'unchanged' };
        try {
            router.push(resolveSessionRoutePathForSurface(sessionId, 'companion', {
                serverId: routeServerId,
            }));
            return { status: 'applied' };
        } catch {
            return { status: 'unavailable' };
        }
    }, [routeMobileSurface, routeServerId, router, sessionId]);
    const {
        openBoard: openCompanionBoardForPresentation,
        revealBoardItem: revealCompanionBoardItem,
        returnToChat: returnToCompanionChat,
    } = React.useMemo(() => createSessionCompanionPanePresentation({
        readPane: () => presentationPaneRef.current,
        readMainColumn: () => presentationMainColumnRef.current,
        isUndoCurrent: () => boardPresentationUndoCurrentRef.current,
    }), []);
    const revealCompanionBoardItemThroughPresentation = React.useCallback((widgetId: string) => {
        const lifetime = sessionAccountLifetime;
        if (!lifetime?.isCurrent()) return;
        void actionExecutor.execute('session.presentation.apply', {
            intent: { kind: 'board.item.reveal', widgetId },
        }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
            defaultSessionId: sessionId,
        }).then(requireActionSuccess).catch(error => presentSessionActionOutcome(error, lifetime));
    }, [actionExecutor, presentSessionActionOutcome, sessionAccountLifetime, sessionId]);
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
                resolvePrimaryHost={mountedBoard?.resolvePrimaryHost ?? resolveBoardPrimaryHost}
                summaryDestinations={companionSummaryDestinations}
            /> : null}
        </>
    );

    const main = (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {embedded ? null : header}
            {/* The transcript's own positioning context: its floating notices anchor below the header. */}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
            {requesterRecoveryBanner || startFailureBanner ? <PaneMainBody>{requesterRecoveryBanner}{startFailureBanner}</PaneMainBody> : null}
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
                    shouldShowCliWarning={shouldShowCliWarning}
                    onDismissCliWarning={handleDismissCliWarning}
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
            >
                <SessionRightSidebarProvider sessionId={sessionId} scopeId={paneScopeId} paneSurfaceScope={sidebarSurfaceScope} resolveBoardPrimaryHost={resolveBoardPrimaryHost}>
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
        resolveBoardPrimaryHost,
        companionAddress,
        openCompanionFullSurface,
        paneScopeId,
        revealCompanionBoardItemThroughPresentation,
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
            state: sessionStatus.state === 'thinking' || sessionStatus.state === 'archiving' ? 'working' as const
                : sessionStatus.state === 'permission_required' || sessionStatus.state === 'action_required' ? 'attention' as const
                    : undefined,
        },
    }), [headerAgentId, headerMachineId, headerTitle, hideSessionLabel, showSessionLabel,
        sessionRouteServerId, sessionStatus.state, theme.colors.text.secondary]);

    if (embedded) {
        // Embedded in another surface's pane (the peek): the Session's own providers, without its
        // pane columns — the host surface owns the columns this view sits in.
        return (
            <SessionResumeProvider onResumeSession={handleResumeSession}>
                {wrapPaneScopeContent(main)}
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
}
