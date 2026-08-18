import Color from 'color';
import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol';

import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { AgentInput, type AgentInputSendOptions } from '@/components/sessions/agentInput';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import {
    computeExistingSessionComposerInputMaxHeight,
    computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import {
    useComposerAvailablePanelHeight,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputExtraActionChip, AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { createGoalActionChip } from '@/components/sessions/agentInput/definitions/createGoalActionChip';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentFilePickerHandle, PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionAgentInputExtraActionChips } from '@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips';
import {
    useSessionConnectedServicesAuthSwitch,
    type SessionConnectedServicesAuthSwitchRestartState,
} from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';
import {
    deriveSessionIntentionalRestartSignals,
    resolveSessionIntentionalRestartRecoveryEvidenceAtMs,
    type SessionIntentionalRestartSignal,
} from '@/components/sessions/agentInput/hooks/sessionIntentionalRestartSignal';
import {
    resolveConnectedServiceDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { SessionHeaderRightSidebarButton } from '@/components/sessions/actions/SessionHeaderRightSidebarButton';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { useOpenAttachedSessionTerminal } from '@/components/sessions/terminal/openAttachedSessionTerminal';
import { SessionHeaderTranscriptNavigationButton, useTranscriptNavigationSurface } from '@/components/sessions/actions/SessionHeaderTranscriptNavigationButton';
import { ChatList, type TranscriptViewportChangeState } from '@/components/sessions/transcript/ChatList';
import { applyTranscriptJumpHighlightForJumpResult } from '@/components/sessions/transcript/navigation/transcriptJumpHighlightStore';
import { TranscriptFirstPaintPlaceholder } from '@/components/sessions/transcript/TranscriptFirstPaintPlaceholder';
import { TranscriptMessageSelectionProvider } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbarController } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbarController';
import type { TranscriptSelectionToolbarMessage } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbar';
import { appendTranscriptSelectionToNewSessionDraft } from '@/components/sessions/transcript/messageSelection/appendTranscriptSelectionToNewSessionDraft';
import { openTranscriptSendToSessionModal } from '@/components/sessions/transcript/messageSelection/openTranscriptSendToSessionModal';
import { sendTranscriptSelectionToSession } from '@/components/sessions/transcript/messageSelection/sendTranscriptSelectionToSession';
import { useTranscriptSelectionEligibleMessageIds } from '@/components/sessions/transcript/messageSelection/useTranscriptSelectionEligibleMessageIds';
import { Deferred } from '@/components/ui/forms/Deferred';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { EmptyMessages } from '@/components/ui/empty/EmptyMessages';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { useDraft } from '@/hooks/session/useDraft';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionAgentInputComposerPersistence } from '@/hooks/session/useSessionAgentInputComposerPersistence';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    captureComposerTransientInputStateForOutboundHandoff,
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from '@/hooks/session/sessionComposerSendCoordinator';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { Modal } from '@/modal';
import { useScmSessionAutoRefresh } from '@/scm/refresh/useScmSessionAutoRefresh';
import { buildNewSessionSourceContextNavigation } from '@/components/sessions/new/navigation/newSessionSourceContextNavigation';
import { sessionAbort, resumeSession } from '@/sync/ops';
import { storage, useActiveServerAccountScope, useEndpointConnectivity, useIsDataReady, useLaunchSelectionMachines, useLocalSetting, useMachine, useOpenApprovalArtifactsForSession, useProfile, useRealtimeStatus, useSessionAutomationsEnabledCount, useSessionConnectedServiceAccountSwitchEvents, useSessionMessages, useSessionOrganizationProjection, useSessionPendingMessages, useSessionTranscriptIds, useSessionUsage, useSessionVisibleReadSeq, useSetting, useSettingMutable, useSettings, useSocketStatus, useSyncError, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { canContinueSessionWithFreshSpawn, canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, buildResumeSessionExtrasFromUiState } from '@/agents/catalog/catalog';
import {
    buildSessionComposerNextMessageMetaOverridesFromUiState,
    getSessionComposerNonSteerablePayloadReasonFromUiState,
    resolveSessionGoalActionCapabilityProfile,
    supportsEditableSessionGoals,
} from '@/agents/registry/registryUiBehavior';
import {
    evaluateAgentSessionCapabilitySupport,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    SPAWN_SESSION_ERROR_CODES,
    buildBackendTargetKey,
    isConnectedServiceCredentialHealthStatusUsable,
    isConnectedServiceResumeUnreachableSpawnErrorDetail,
    isConnectedServiceUxDiagnosticSpawnErrorDetail,
    type ComposerAgentContinuationIntentV1,
    type SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSession } from '@/sync/domains/state/storage';
import { readMessageDisplayText } from '@/sync/domains/messages/messageDisplayText';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import { Session, type Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { computeNextAcpConfigOptionOverrideMetadata } from '@/sync/engine/overrides/acpConfigOptionOverridePublish';
import { readSessionConfigOptionOverridesState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { updateUsageLimitRecoveryRememberedMode } from '@/sync/domains/settings/usageLimitRecoverySettings';
import {
    filterReviewCommentDraftsIncludedInPrompt,
} from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import {
    buildReviewCommentsV1MetaPayload,
    parseReviewCommentsV1,
} from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import {
    clearSessionDraftValue,
    clearSessionDraftValues,
    flushSessionDraftValues,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import type { SessionArmedAgentContinuationSubmission } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import {
    supportsSessionModeOverrides,
} from '@/sync/domains/sessionControl/sessionModeControl';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { shadowLevelStyle } from '@/shadowElevation';
import { t, type TranslationKey } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform/platform';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { getSessionAvatarId, getSessionName, listPendingPermissionRequests, shouldReadTranscriptForPendingRequests, shouldShowAbortButtonForSessionState, useSessionStatus, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { nativeReadClipboardImageAttachment } from '@/utils/files/nativeClipboardImageAttachment';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { getPermissionModeLabelForAgentType, getPermissionModeTitleForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useSessionMachineControlTarget, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import {
    resolveParticipantRoutedSend,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { useReconciledStableRows } from '@/hooks/session/reconcileStableRows';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import type { AgentActivityCounts } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import { hasSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { useSurfaceAnchorPathname } from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
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
    forgetSessionViewContentWidthSurface,
    readSeededSessionViewContentWidth,
    rememberSessionViewContentWidth,
    resolveSessionViewAvailableWidth,
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
} from '@/components/sessions/shell/resolveSessionViewContentBottomSpacing';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { confirmNonSteerableSend } from '@/components/sessions/agentInput/confirmNonSteerableSend';
import { canApplySteerConfigInFlight, decideSessionMessageDelivery, type MessageSendMode } from '@/sync/domains/session/control/submitMode';
import {
    buildArmedAgentContinuationTransitionInput,
    continueSessionWithArmedAgent,
    reconcileArmedAgentContinuationDisposition,
    type ArmedAgentContinuationCanonicalFacts,
    type ArmedAgentContinuationInputCustody,
    type ArmedAgentContinuationLabels,
    type ArmedAgentContinuationNotice,
} from '@/sync/domains/session/input/continueSessionWithArmedAgent';
import {
    resolveSessionComposerSendDestination,
    type SessionComposerSendDestination,
    type SessionComposerSendRoute,
} from '@/sync/domains/session/input/resolveSessionComposerSendDestination';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import { createSyncBackedSubmitPort } from '@/sync/domains/session/input/syncBackedSubmitPort';
import { isSessionLocallyAttached } from '@/sync/domains/session/control/sessionLocalControl';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    selectConnectedServiceSessionProviderUsageGaugeSource,
    type ConnectedServiceQuotaGaugeLabelFormatter,
    type ConnectedServiceQuotaGaugeWindowMode,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import {
    selectProviderUsageDisplaySnapshot,
    type ProviderUsageDisplaySnapshotSource,
} from '@/sync/domains/connectedServices/accountUsage/selectors';
import {
    connectedServiceProfileKey,
    resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { resolveConnectedServiceQuotaProfileRefForSession } from './resolveConnectedServiceQuotaProfileRefForSession';
import { usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { Keyboard, Platform, Pressable, View, type LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
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
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import { sessionGoalClear, sessionGoalSet } from '@/sync/ops/sessionGoals';
import {
    readSessionWorkStateFromMetadata,
    resolveActiveSessionGoalItem,
    SESSION_WORK_STATE_STATUS_BADGE_KEY,
    resolvePrimarySessionWorkStateItem,
} from '@/components/sessions/workState/sessionWorkStatePresentation';
import {
    resolveSessionActivityComposerTranslate,
    resolveSessionActivityStatusBadgePresentation,
    shouldRetainSessionActivityStatusBadge,
} from '@/components/sessions/workState/sessionActivityPresentation';
import { isSessionGoalEditingAvailable } from '@/components/sessions/workState/sessionGoalEditingAvailability';
import { SessionWorkStatePopover } from '@/components/sessions/workState/SessionWorkStatePopover';
import { layout } from '@/components/ui/layout/layout';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import {
    clearSessionAttachmentDrafts,
    readSessionAttachmentDrafts,
    writeSessionAttachmentDrafts,
} from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { buildAttachmentMessageMeta } from '@/components/sessions/attachments/buildAttachmentMessageMeta';
import { mergeMessageMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import { Text } from '@/components/ui/text/Text';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionScreenTestIdsProvider } from './sessionScreenTestIds';
import { useSessionScreenIsFocused } from './useSessionScreenIsFocused';
import { resolveMobileWorkspaceExperienceToggleActionId } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';
import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';
import { useSessionResumeRequestListener } from '@/components/sessions/model/sessionResumeRequests';
import { resolveSessionResumeMachineTarget } from './sessionResumeMachineTarget';
import { useDirectSessionTakeover } from '@/components/sessions/model/useDirectSessionTakeover';
import { useDirectSessionRuntime } from '@/components/sessions/model/useDirectSessionRuntime';
import { SessionWarningActionBanner } from './SessionWarningActionBanner';
import { ComposerAuxiliaryFrame } from './view/ComposerAuxiliaryFrame';
import {
    ComposerBannerCollapseProvider,
    useComposerBannerCollapse,
} from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { buildComposerBannerBadgeAccessibility } from '@/components/sessions/composerBanners/composerBannerCollapse';
import {
    buildStaleSessionRunnerNoticePresentation,
    type StaleSessionRunnerNoticeTranslate,
    type StaleSessionRunnerRestartViewStatus,
} from '@/components/sessions/sessionRunner/staleSessionRunnerNoticePresentation';
import {
    readActionableStaleSessionRunnerStatus,
    SESSION_RUNNER_RUNTIME_STATE_FIELD_ID,
} from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus';
import {
    sessionRunnerRuntimeStatusRetention as sessionRunnerRuntimeStatusRetentionStore,
    type SessionRunnerRuntimeStatusIdentity,
    type SessionRunnerRuntimeStatusSnapshot,
} from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import {
    getSessionRunnerRuntimeStatus,
    restartStaleSessionRunnerWithObserve,
    type RestartStaleSessionRunnerResult,
} from '@/sync/ops/sessionRunnerRestart';
import {
    readConnectedServiceProfileKindFromServices,
    resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useInSessionAgentPickerControls } from '@/components/sessions/agentPicker/useInSessionAgentPickerControls';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

/**
 * Where one submitted localId has got to, canonically — the single reader for
 * both questions the transition asks about it: whether it was admitted at all,
 * and whether anything has carried it yet.
 *
 * They are answered together because they come from the same two store slices,
 * and because a queued-input signal that cannot see `delivered` outlives the
 * message it describes: the armed outcome stays on screen for the life of the
 * Session, so a Session that answers and later idles out would otherwise be
 * reported as one whose message never went.
 */
function selectCanonicalOutboundHandoffForLocalId(
    state: StorageState,
    sessionId: string,
    localId: string | null,
): ArmedAgentContinuationInputCustody {
    if (!localId) return 'absent';

    const sessionMessages = state.sessionMessages[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    // The transcript is checked FIRST: a materialized row is the stronger fact,
    // and a pending row can briefly survive its own materialization.
    const isDelivered = messagesById !== undefined && Object.values(messagesById).some((message) => (
        message.kind === 'user-text'
        && message.localId === localId
        && !isRecoveredHistoryTranscriptObservationProvenance(message.transcriptObservationProvenance)
    ));
    if (isDelivered) return 'delivered';

    const pending = state.sessionPending[sessionId];
    // `discarded` still proves admission, but nothing is waiting on a runtime
    // for it, so it does not count as queued.
    const isQueued = (pending?.messages ?? []).some((message) => (
        message.source === 'server_pending' && message.localId === localId
    ));
    if (isQueued) return 'queued';
    return (pending?.discarded ?? []).some((message) => (
        message.source === 'server_pending' && message.localId === localId
    )) ? 'delivered' : 'absent';
}

/**
 * The same reader sampled once, for the imperative callers that ask at a single
 * instant (a failed outbound handoff deciding whether restoring the composer is
 * safe). A subscriber must use the selector above instead: this answer is stale
 * the moment the pending row or the transcript row lands.
 */
function readCanonicalOutboundHandoffForLocalId(
    sessionId: string,
    localId: string | null,
): ArmedAgentContinuationInputCustody {
    return selectCanonicalOutboundHandoffForLocalId(storage.getState(), sessionId, localId);
}

/** The admission half of the reader above, for callers that only ask that. */
function hasCanonicalOutboundHandoffForLocalId(sessionId: string, localId: string | null): boolean {
    return readCanonicalOutboundHandoffForLocalId(sessionId, localId) !== 'absent';
}
import {
    isHiddenSystemSession,
    ConnectedServiceIdSchema,
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    SessionUsageLimitRecoveryV1Schema,
    readProviderAccountUsageRecordIdsFromMetadata,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type SessionRuntimeIssueV1,
    type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { resolveNextOptimisticAcpConfigOptionOverrides } from './resolveNextOptimisticAcpConfigOptionOverrides';
import { useSessionViewShellSession, useSessionViewShellSessionSeq } from './sessionViewStableSession';
import {
    isEmptyPendingMessageComposerSemanticDraftSnapshot,
    type PendingMessageComposerEditState,
    type PendingMessageComposerSemanticDraftSnapshot as ComposerSemanticDraftSnapshot,
} from './pendingMessageComposerEditSnapshot';
import { useSessionViewedLifecycle } from './view/useSessionViewedLifecycle';
import { useSessionSurfaceActivation } from './view/useSessionSurfaceActivation';
import { resolveSessionAuthSurfaceState, type SessionAuthSurfaceState } from './sessionAuthSurfaceState';
import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    buildSessionUsageLimitRecoveryPresentation,
    buildSessionUsageLimitStatusBadgePresentation,
    type SessionUsageLimitRecoveryActionKind,
    type SessionUsageLimitRecoveryTranslate,
    type UsageLimitRecoveryOperationStatus,
} from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryPresentation';
import { hasMeaningfulActivityAfterRuntimeIssue } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitActivityStaleness';
import {
    buildSessionUsageLimitRecoveryOperationFailureAlert,
    type SessionUsageLimitRecoveryOperationFailureResult,
} from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryOperationFailureAlert';
import { handleReadyUsageLimitRecoveryResult } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryReadyResult';
import {
    sessionUsageLimitCheckNow,
    sessionUsageLimitConsumeResetCredit,
    sessionUsageLimitSwitchAccountNow,
    sessionUsageLimitWaitResumeCancel,
    sessionUsageLimitWaitResumeEnable,
    type SessionUsageLimitRecoveryOperationResult,
} from '@/sync/ops/sessionUsageLimitRecovery';
import { useCredentialScopedAccountModeResolver } from '@/hooks/server/connectedServices/useCredentialScopedAccountModeResolver';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import {
    buildQuotaSnapshotScopeKey,
    consumeQuotaRecoveryCredit,
} from '@/hooks/server/connectedServices/connectedServiceQuotaSnapshotStore';

const sessionSubmitPort = createSyncBackedSubmitPort(sync);
const SESSION_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [
    'file',
    'vendorPlugin',
    // A reference is same-server only (D-8), and this host answers that from its own session.
    // The new-session composer offers `session` too, by declaring its spawn target instead
    // (`useNewSessionScreenModel`); the automation and participant composers do not, because
    // neither carries the composer's `mentions[]` envelope to its send yet.
    'session',
    'skill',
    'slashCommand',
];
const MAX_USAGE_LIMIT_RECOVERY_READY_TIMER_MS = 2_147_483_647;

function isConnectedServiceBoundProviderUsageDisplaySource(
    source: ProviderUsageDisplaySnapshotSource | null | undefined,
): boolean {
    return source?.connectedServiceRefProvenance === 'connected_binding_profile'
        || source?.connectedServiceRefProvenance === 'connected_binding_group';
}

function resolveConnectedServicesAuthSwitchDisabledReason(params: Readonly<{
    isReadOnly: boolean;
    session: Session;
    nowMs: number;
}>): 'read_only' | 'active_turn' | null {
    if (params.isReadOnly) return 'read_only';

    const pendingFlags = derivePendingRequestFlagsFromSession(params.session);
    const inputReadiness = deriveSessionInputReadinessState({
        active: params.session.active,
        activeAt: params.session.activeAt,
        presence: params.session.presence,
        thinking: params.session.thinking,
        thinkingAt: params.session.thinkingAt,
        latestTurnStatus: params.session.latestTurnStatus,
        latestTurnStatusObservedAt: params.session.latestTurnStatusObservedAt,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(params.session),
    }, params.nowMs);

    return inputReadiness.isInputBusy
        ? 'active_turn'
        : null;
}

function useConnectedServicesAuthSwitchDisabledReason(params: Readonly<{
    isReadOnly: boolean;
    session: Session;
}>): 'read_only' | 'active_turn' | null {
    const { isReadOnly, session } = params;
    const sessionId = session.id;
    return storage((state) => {
        const liveSession = state.sessions[sessionId] ?? session;
        return resolveConnectedServicesAuthSwitchDisabledReason({
            isReadOnly,
            session: liveSession,
            nowMs: Date.now(),
        });
    });
}

function normalizePositiveTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readDiagnosticString(
    diagnostics: Readonly<Record<string, string | number | boolean | null>> | undefined,
    keys: ReadonlyArray<string>,
): string | null {
    if (!diagnostics) return null;
    for (const key of keys) {
        const value = diagnostics[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}

function resolveConnectedServiceProviderDisplayName(serviceId: string): string | null {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsed.success) return null;
    return resolveConnectedServiceDisplayName(parsed.data, t);
}

const connectedServiceQuotaGaugeFormatter: ConnectedServiceQuotaGaugeLabelFormatter = {
    remaining: ({ percent }) => t('agentInput.providerUsage.remaining', { percent }),
    remainingWithReset: ({ percent, reset }) => t('agentInput.providerUsage.remainingWithReset', { percent, reset }),
    used: ({ used, limit }) => t('agentInput.providerUsage.usedCount', { used, limit }),
    durationNow: () => t('agentInput.providerUsage.duration.now'),
    durationOutdated: () => t('agentInput.providerUsage.duration.outdated'),
    durationDaysHours: ({ days, hours }) => t('agentInput.providerUsage.duration.daysHours', { days, hours }),
    durationHoursMinutes: ({ hours, minutes }) => t('agentInput.providerUsage.duration.hoursMinutes', { hours, minutes }),
    durationHours: ({ hours }) => t('agentInput.providerUsage.duration.hours', { hours }),
    durationMinutes: ({ minutes }) => t('agentInput.providerUsage.duration.minutes', { minutes }),
};

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

function isOwnedSessionRoutePathname(pathname: string | null | undefined, sessionId: string): boolean {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim().split('?')[0] ?? '' : '';
    if (!normalizedPathname) {
        return false;
    }

    const match = /^\/session\/([^/]+)(?:\/.*)?$/.exec(normalizedPathname);
    if (!match) {
        return false;
    }

    try {
        return decodeURIComponent(match[1] ?? '') === sessionId;
    } catch {
        return false;
    }
}

function readSessionUsageLimitRecovery(metadata: unknown): SessionUsageLimitRecoveryV1 | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
    const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function resolveUsageLimitRecoveryQuotaProfileRef(params: Readonly<{
    recovery: SessionUsageLimitRecoveryV1 | null | undefined;
    issue: SessionRuntimeIssueV1 | null | undefined;
}>): Readonly<{ serviceId: string; profileId: string }> | null {
    const selectedAuth = params.recovery?.selectedAuth;
    if (selectedAuth?.kind === 'profile') {
        return { serviceId: selectedAuth.serviceId, profileId: selectedAuth.profileId };
    }
    if (selectedAuth?.kind === 'group' && selectedAuth.profileId) {
        return { serviceId: selectedAuth.serviceId, profileId: selectedAuth.profileId };
    }

    const connectedService = params.issue?.usageLimit?.connectedService;
    if (connectedService?.serviceId && connectedService.profileId) {
        return {
            serviceId: connectedService.serviceId,
            profileId: connectedService.profileId,
        };
    }
    return null;
}

function formatResumeSessionFailureMessage(result: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
    errorDetail?: unknown;
}>): string {
    // When the daemon fail-closes a resume because the connected-service session state could not be
    // proven reachable (the K1 §2 reachability gate), it carries a STRUCTURED `errorDetail`. Surface
    // its machine-readable reason + agent so the user learns WHY resume cannot continue (and that
    // starting fresh is the remedy) instead of an opaque "Failed to resume session". Recognition is by
    // the structured detail only — never by parsing `errorMessage` copy.
    if (isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
        const presentation = resolveConnectedServiceUxDiagnosticPresentation(result.errorDetail.uxDiagnostic);
        // Reuse the already-translated "switch unavailable" explanation (same K1 §2 reason vocabulary,
        // present in every locale) rather than a generic failure: it names the concrete reason + agent
        // and tells the user that starting fresh is the remedy.
        return t('newSession.connectedServiceSwitchUnavailable.body', {
            reason: presentation?.bodyParams?.reason ?? result.errorDetail.reason,
            agentId: presentation?.bodyParams?.agentId ?? result.errorDetail.agentId,
        });
    }
    if (isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
        const presentation = resolveConnectedServiceUxDiagnosticPresentation(result.errorDetail.uxDiagnostic);
        if (presentation) {
            return t(presentation.bodyKey);
        }
    }

    const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED) {
        return t('session.resumeFailed');
    }

    const message = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
    return message || t('session.resumeFailed');
}

function readFiniteTimestampMs(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsageLimitRecoveryResetAtMs(params: Readonly<{
    issue: unknown;
    recovery: SessionUsageLimitRecoveryV1 | null | undefined;
}>): number | null {
    const recoveryResetAtMs = readFiniteTimestampMs(params.recovery?.resetAtMs);
    if (recoveryResetAtMs !== null) return recoveryResetAtMs;
    const issue = readObjectRecord(params.issue);
    const usageLimit = readObjectRecord(issue?.usageLimit);
    return readFiniteTimestampMs(usageLimit?.resetAtMs);
}

function formatUsageLimitRecoveryOperationError(result: Readonly<{
    error: string;
    errorCode?: string;
}>): string {
    const code = result.errorCode ?? result.error;
    switch (code) {
        case 'session_usage_limit_recovery_control_remote_unavailable':
        case 'session_usage_limit_recovery_control_machine_unavailable':
        case 'session_usage_limit_recovery_control_current_machine_unknown':
        case 'session_usage_limit_recovery_control_session_machine_unknown':
        case 'session_usage_limit_recovery_control_metadata_unavailable':
            return t('errors.daemonUnavailableBody');
        case 'session_usage_limit_recovery_control_inactive':
        case 'session_usage_limit_recovery_control_issue_mismatch':
        case 'session_usage_limit_recovery_control_cwd_unavailable':
            return t('errors.tryAgain');
        default:
            return code.startsWith('session_usage_limit_recovery_control_')
                ? t('errors.operationFailed')
                : result.error;
    }
}

type UsageLimitRecoveryDiagnosticProfileActionRoute = ReturnType<typeof resolveConnectedServiceProfileActionRoute>;

function readUsageLimitRecoveryDiagnosticProfileActionRoute(
    result: SessionUsageLimitRecoveryOperationFailureResult,
    accountProfileConnectedServicesV2: unknown,
): UsageLimitRecoveryDiagnosticProfileActionRoute {
    const rawServiceId = typeof result.uxDiagnostic?.serviceId === 'string'
        ? result.uxDiagnostic.serviceId.trim()
        : '';
    const serviceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
    if (!serviceId.success) return { pathname: '/settings/connected-services' };

    const profileId = typeof result.uxDiagnostic?.profileId === 'string'
        ? result.uxDiagnostic.profileId.trim()
        : '';
    const profileKind = readConnectedServiceProfileKindFromServices({
        connectedServicesV2: accountProfileConnectedServicesV2,
        serviceId: serviceId.data,
        profileId,
    });

    return resolveConnectedServiceProfileActionRoute({
        serviceId: serviceId.data,
        profileId,
        profileKind,
    });
}

function resolveUsageLimitRecoveryStatusFromTypedFailure(
    result: Extract<SessionUsageLimitRecoveryOperationResult, { ok: false }>,
): UsageLimitRecoveryOperationStatus | 'resolved' | null {
    switch (result.status) {
        case 'exhausted':
            return 'exhausted';
        case 'inactive':
        case 'not_found':
            return 'inactive';
        case 'rate_limited':
            return 'waiting';
        case 'cancelled':
            return 'resolved';
        default:
            return null;
    }
}

function isUsageLimitRecoveryCheckAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'check_now'
        || kind === 'retry_temporary_throttle';
}

function isUsageLimitRecoverySwitchAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'switch_fallback_now'
        || kind === 'switch_account_now';
}

function isUsageLimitRecoveryControlAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return isUsageLimitRecoveryCheckAction(kind)
        || isUsageLimitRecoverySwitchAction(kind)
        || kind === 'consume_reset_credit';
}

function resolveStaleSessionRunnerRestartViewStatus(
    result: RestartStaleSessionRunnerResult,
): StaleSessionRunnerRestartViewStatus {
    switch (result.status) {
        case 'restarted':
        case 'already_current':
        case 'runner_identity_changed':
        case 'busy':
        case 'ineligible':
        case 'unsupported_daemon':
        case 'version_unknown':
            return result.status;
        case 'refresh_unsupported':
            return 'ineligible';
        case 'failure':
            return 'failed';
    }
}

function hasSessionWriteAccess(accessLevel: Session['accessLevel']): boolean {
    return !accessLevel || accessLevel === 'edit' || accessLevel === 'admin';
}

function SessionAuthRecoveryBanner({ message, style }: Readonly<{
    message: string;
    style?: React.ComponentProps<typeof SessionWarningActionBanner>['style'];
}>) {
    const router = useRouter();

    return (
        <SessionWarningActionBanner
            testID="session-auth-sync-error"
            actionTestID="session-auth-sync-error-restore"
            title={t('connect.restoreAccount')}
            body={message}
            actionLabel={t('connect.restoreAccount')}
            actionAccessibilityLabel={t('connect.restoreAccount')}
            onActionPress={() => router.push('/restore')}
            style={style}
        />
    );
}

type SessionViewLoadedProps = Readonly<{
    authSurfaceState: SessionAuthSurfaceState | null;
    sessionId: string;
    routeServerId?: string | null;
    session: Session;
    onBackPress: () => void;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    jumpToSeq: number | null;
    participantTargets: readonly SessionParticipantTarget[];
    /** The one activity tally for this session, derived once above and shared with the header. */
    agentActivityCounts: AgentActivityCounts;
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    paneScopeId: string;
    // Stable per-pane-mount id (NOT keyed by session) used to seed the first-frame content width
    // across the `key={sessionId}` remount so the bottom spacing does not flip on switch.
    contentWidthSurfaceId: string;
    pendingMessages: readonly PendingMessage[];
    directSessionRuntime: ReturnType<typeof useDirectSessionRuntime>;
    chatBottomSpacing: 'default' | 'none';
    paneUrlSyncRouteActive: boolean;
    surfaceFocused: boolean;
    routeHydrationPending: boolean;
    sessionRunnerRuntimeStatus: SessionRunnerRuntimeStatusSnapshot | null;
    sessionRunnerRuntimeStatusMachineId: string | null;
    onSessionRunnerRuntimeStatusInvalidated: () => void;
}>;

type SessionViewLoadedWithPendingMessagesProps = Omit<
    SessionViewLoadedProps,
    'agentActivityCounts'
    | 'directSessionRuntime'
    | 'participantTargets'
    | 'pendingMessages'
>;

const MemoizedSessionViewLoaded = React.memo(SessionViewLoaded);

const SessionViewLoadedWithPendingMessages = React.memo(function SessionViewLoadedWithPendingMessages(
    props: SessionViewLoadedWithPendingMessagesProps,
) {
    const { messages: pendingMessages } = useSessionPendingMessages(props.sessionId);
    const directSessionRuntime = useDirectSessionRuntime({
        sessionId: props.sessionId,
        metadata: props.session.metadata ?? null,
    });
    // One roster derivation for this subtree. The composer badge needs a count and the routing
    // controls need the recipient targets, and both come out of the same merged activity — deriving
    // the roster twice here would double the work `useSessionSubagents` does on every subagent-
    // relevant transcript change for a number and a list that must agree anyway (R-8, R-11).
    //
    // This is the NARROW variant deliberately: it reads the subagent-source projection and the
    // headline, and subscribes to nothing that ticks per streamed token. The roster variant's
    // transcript enrichment is the Agents pane's cost to pay, not the composer's.
    const agentActivity = useSessionAgentActivity({
        sessionId: props.sessionId,
        directSessionRuntime,
    });
    const derivedParticipantTargets = React.useMemo(
        () => deriveSessionSubagentRecipients(agentActivity.subagents),
        [agentActivity.subagents],
    );
    const participantTargets = useReconciledStableRows(derivedParticipantTargets, readParticipantTargetKey);

    return (
        <ComposerBannerCollapseProvider>
            <MemoizedSessionViewLoaded
                {...props}
                agentActivityCounts={agentActivity.counts}
                directSessionRuntime={directSessionRuntime}
                participantTargets={participantTargets}
                pendingMessages={pendingMessages}
            />
        </ComposerBannerCollapseProvider>
    );
});

function readParticipantTargetKey(target: SessionParticipantTarget): string {
    return target.key;
}

type SessionHeaderRightElementProps = Readonly<{
    sessionId: string;
    session: Session;
    paneScopeId: string;
    currentSessionRouteServerId: string;
    mobileWorkspaceExperienceToggleActionId: string;
    mobileWorkspaceExperienceToggleLabelKey: TranslationKey | null;
    onToggleWorkspaceExperience: () => void;
    sessionAutomationsEnabledCount: number;
    shouldFoldHeaderIconActions: boolean;
    onOpenSessionInfo: () => void;
    showAutomations: boolean;
    showWorkspaceExperienceToggle: boolean;
}>;

const SessionHeaderRightElement = React.memo(function SessionHeaderRightElement(props: SessionHeaderRightElementProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openAgentRoster = useOpenSessionTarget({
        sessionId: props.sessionId,
        scopeId: props.paneScopeId,
        serverId: props.currentSessionRouteServerId,
    });
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(props.sessionId);
    const transcriptNavigation = useTranscriptNavigationSurface({
        scopeId: props.paneScopeId,
        sessionId: props.sessionId,
    });
    const sessionExecutionRunsSupported = useSessionExecutionRunsSupported(props.sessionId, {
        serverId: props.currentSessionRouteServerId,
    });
    const directSessionRuntime = useDirectSessionRuntime({
        sessionId: props.sessionId,
        metadata: props.session.metadata ?? null,
    });
    // R-8: the header count reads the unified activity model, not a private tally over the raw
    // roster. It is the same `counts` object the composer badge and the Agents pane use, so the
    // glyph beside the composer and the list it opens cannot report different numbers.
    const { counts: agentActivityCounts } = useSessionAgentActivity({
        sessionId: props.sessionId,
        directSessionRuntime,
    });
    // The icon is a live indicator: work that is still open, which includes an agent stopped on a
    // permission prompt. The overflow menu is a destination, so it stays available whenever there is
    // anything to look at, finished agents included.
    const openAgentCount = agentActivityCounts.live;
    const shouldOfferSubagentsMenuItem =
        agentActivityCounts.total > 0
        || sessionExecutionRunsSupported
        || hasSessionSubagentLaunchCards(props.session);

    const buildCurrentSessionHref = React.useCallback((suffix = '') => {
        return buildScopedSessionRouteHref({
            sessionId: props.sessionId,
            serverId: props.currentSessionRouteServerId,
            suffix,
        });
    }, [props.currentSessionRouteServerId, props.sessionId]);

    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === 'header.openAttachedClaudeTerminal') {
            attachedSessionTerminal.open();
            return true;
        }
        if (actionId === props.mobileWorkspaceExperienceToggleActionId) {
            if (actionId === 'header.openMobileWorkspaceCockpit') {
                Keyboard.dismiss();
            }
            props.onToggleWorkspaceExperience();
            return true;
        }
        if (actionId === 'header.openTranscriptNavigation') {
            if (!transcriptNavigation.available) return false;
            transcriptNavigation.open();
            return true;
        }
        if (actionId !== 'header.openSubagents') return false;
        // The SAME decision the header glyph makes, and the one that matters most: below 520pt the
        // glyph is folded away, so on a phone this menu item is the only way into the roster — and
        // it used to open a right pane that is structurally hidden there.
        return openAgentRoster({ kind: 'agentRoster' });
    }, [attachedSessionTerminal, openAgentRoster, transcriptNavigation, props.mobileWorkspaceExperienceToggleActionId, props.onToggleWorkspaceExperience]);

    const headerExtraItems = React.useMemo(() => {
        const items: DropdownMenuItem[] = [];
        if (props.showWorkspaceExperienceToggle && props.mobileWorkspaceExperienceToggleLabelKey) {
            items.push({
                id: props.mobileWorkspaceExperienceToggleActionId,
                title: t(props.mobileWorkspaceExperienceToggleLabelKey),
                icon: <Icon name="device-mobile" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (attachedSessionTerminal.available) {
            items.push({
                id: 'header.openAttachedClaudeTerminal',
                title: t('tools.askUserQuestion.claudeDialogNotice.openTerminal'),
                icon: <Icon name="terminal" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (!props.shouldFoldHeaderIconActions) return items;

        // Offered only where it leads somewhere. Below the fold this menu is the phone's ONLY way to
        // transcript navigation, and navigation exists solely as a right-pane tab or a cockpit
        // surface — so on a classic phone layout there is nothing behind it to open.
        if (transcriptNavigation.available) {
            items.push({
                id: 'header.openTranscriptNavigation',
                title: t('session.openTranscriptNavigation'),
                icon: <Icon name="list" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldOfferSubagentsMenuItem) {
            items.push({
                id: 'header.openSubagents',
                title: t('session.openSubagents', { count: openAgentCount }),
                icon: <Icon name="robot" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
            });
        }
        if (sessionExecutionRunsSupported) {
            items.push({
                id: 'header.openRuns',
                title: t('session.openRuns'),
                icon: <Icon name="play" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (props.showAutomations) {
            items.push({
                id: 'header.openAutomations',
                title: t('session.openAutomations'),
                icon: <Icon name="timer" size={16} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [
        attachedSessionTerminal.available,
        props.mobileWorkspaceExperienceToggleActionId,
        props.mobileWorkspaceExperienceToggleLabelKey,
        props.shouldFoldHeaderIconActions,
        props.showAutomations,
        props.showWorkspaceExperienceToggle,
        sessionExecutionRunsSupported,
        shouldOfferSubagentsMenuItem,
        openAgentCount,
        theme.colors.text.secondary,
        transcriptNavigation.available,
    ]);

    const badgeLabel =
        props.sessionAutomationsEnabledCount > 99 ? '99+' : String(props.sessionAutomationsEnabledCount);

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <ActionOperationActivityButton
                preferredSessionId={props.sessionId}
                testID="session-header-action-operations"
                buttonSize={44}
                iconSize={SESSION_HEADER_ICON_SIZE_PX}
            />
            <SessionHeaderActionMenu
                sessionId={props.sessionId}
                session={props.session}
                extraItems={headerExtraItems.length > 0 ? headerExtraItems : undefined}
                onSelectExtraItem={handleHeaderExtraItemSelect}
            />
            {!props.shouldFoldHeaderIconActions ? (
                <SessionHeaderTranscriptNavigationButton sessionId={props.sessionId} scopeId={props.paneScopeId} />
            ) : null}
            {!props.shouldFoldHeaderIconActions ? (
                <SessionHeaderSubagentsButton
                    sessionId={props.sessionId}
                    scopeId={props.paneScopeId}
                    serverId={props.currentSessionRouteServerId}
                    activeCount={openAgentCount}
                />
            ) : null}
            <SessionHeaderTerminalButton
                sessionId={props.sessionId}
                scopeId={props.paneScopeId}
                serverId={props.currentSessionRouteServerId}
            />
{/* Never folded. Session details used to be reachable by pressing the avatar, which was
                shown on every width; moving that navigation to an icon that folds below 520pt would
                delete the only path to it on phones rather than tidy the row. */}
            <SessionHeaderInfoButton onPress={props.onOpenSessionInfo} />
            {!props.shouldFoldHeaderIconActions && props.showAutomations && props.sessionAutomationsEnabledCount > 0 ? (
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
                    {/* No `badgeColor` override: this count shares `SessionHeaderIconWithCount`
                        with the agent count sitting a few points to its left, and in this row a
                        filled-red count means one thing only — a person is needed. Enabled
                        automations are a configuration fact, not a request for attention, so it
                        takes the primitive's default accent. */}
                    <SessionHeaderIconWithCount count={props.sessionAutomationsEnabledCount}>
                        <Icon
                            name="timer"
                            size={SESSION_HEADER_ICON_SIZE_PX}
                            color={theme.colors.chrome.header.foreground}
                        />
                    </SessionHeaderIconWithCount>
                </Pressable>
            ) : null}
        </View>
    );
});

type SessionAgentInputWithUsageProps = Omit<React.ComponentProps<typeof AgentInput>, 'usageData'> & {
    sessionId: string;
    sessionLatestUsage: Session['latestUsage'] | null | undefined;
    inputComposerClearTransientStateRef: React.MutableRefObject<() => void>;
    inputComposerCaptureTransientStateRef: React.MutableRefObject<() => AgentInputLocalUiStateV1 | null>;
    inputComposerRestoreTransientStateRef: React.MutableRefObject<(state: AgentInputLocalUiStateV1 | null) => void>;
};

const noopInputComposerClearTransientState = () => {};
const noopInputComposerCaptureTransientState = () => null;
const noopInputComposerRestoreTransientState = () => {};

type AgentInputOnSend = NonNullable<React.ComponentProps<typeof AgentInput>['onSend']>;
type AgentInputOnFileViewerPress = NonNullable<React.ComponentProps<typeof AgentInput>['onFileViewerPress']>;

function useStableAgentInputOnSend(handler: AgentInputOnSend): AgentInputOnSend {
    const handlerRef = React.useRef(handler);
    handlerRef.current = handler;

    return React.useCallback<AgentInputOnSend>((sendOptions) => handlerRef.current(sendOptions), []);
}

function useStableAgentInputFileViewerPress(handler: AgentInputOnFileViewerPress): AgentInputOnFileViewerPress {
    const handlerRef = React.useRef(handler);
    handlerRef.current = handler;

    return React.useCallback<AgentInputOnFileViewerPress>(() => handlerRef.current(), []);
}

function areSemanticDraftValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

const EMPTY_AGENT_INPUT_REQUESTS: readonly PendingPermissionRequest[] = Object.freeze([]);

function stringifyAgentInputRequestArguments(value: unknown): string {
    if (typeof value === 'undefined') return '';
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}

function areAgentInputRequestListsEqual(
    left: readonly PendingPermissionRequest[],
    right: readonly PendingPermissionRequest[],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
        const leftRequest = left[i];
        const rightRequest = right[i];
        if (!leftRequest || !rightRequest) return false;
        if (leftRequest.id !== rightRequest.id) return false;
        if (leftRequest.kind !== rightRequest.kind) return false;
        if (leftRequest.tool !== rightRequest.tool) return false;
        if (leftRequest.createdAt !== rightRequest.createdAt) return false;
        if (
            stringifyAgentInputRequestArguments(leftRequest.arguments)
            !== stringifyAgentInputRequestArguments(rightRequest.arguments)
        ) {
            return false;
        }
    }
    return true;
}

function useStableAgentInputRequests(
    requests: readonly PendingPermissionRequest[],
): readonly PendingPermissionRequest[] {
    const previousRef = React.useRef<readonly PendingPermissionRequest[]>(EMPTY_AGENT_INPUT_REQUESTS);
    return React.useMemo(() => {
        const normalized = requests.length === 0 ? EMPTY_AGENT_INPUT_REQUESTS : requests;
        if (areAgentInputRequestListsEqual(previousRef.current, normalized)) {
            return previousRef.current;
        }
        previousRef.current = normalized;
        return normalized;
    }, [requests]);
}

function normalizeComposerKeyboardHeight(height: number | null | undefined): number {
    return typeof height === 'number' && Number.isFinite(height)
        ? Math.max(0, Math.round(height))
        : 0;
}

function useComposerKeyboardHeight(): number {
    const layout = useComposerKeyboardLayoutContext();
    const [keyboardHeight, setKeyboardHeight] = React.useState(
        () => normalizeComposerKeyboardHeight(layout?.getKeyboardHeight?.()),
    );

    React.useEffect(() => {
        if (!layout) {
            setKeyboardHeight(0);
            return undefined;
        }

        setKeyboardHeight(normalizeComposerKeyboardHeight(layout.getKeyboardHeight?.()));
        return layout.subscribeKeyboardHeight?.((nextHeight) => {
            const normalizedHeight = normalizeComposerKeyboardHeight(nextHeight);
            setKeyboardHeight((current) => (current === normalizedHeight ? current : normalizedHeight));
        });
    }, [layout]);

    return keyboardHeight;
}

const SessionAgentInputWithUsage = React.memo(function SessionAgentInputWithUsage({
    sessionId,
    sessionLatestUsage,
    inputComposerClearTransientStateRef,
    inputComposerCaptureTransientStateRef,
    inputComposerRestoreTransientStateRef,
    ...agentInputProps
}: SessionAgentInputWithUsageProps) {
    const sessionUsage = useSessionUsage(sessionId);
    const scaffoldAvailablePanelHeight = useComposerAvailablePanelHeight();
    const keyboardHeight = useComposerKeyboardHeight();
    const { height: windowHeight } = useWindowDimensions();
    const rawUiFontScale = useLocalSetting('uiFontScale');
    const uiFontScale = typeof rawUiFontScale === 'number' ? rawUiFontScale : undefined;
    const inputComposerPersistence = useSessionAgentInputComposerPersistence({
        sessionId,
        text: agentInputProps.value,
        textLength: agentInputProps.value.length,
        fontScale: uiFontScale,
    });
    React.useEffect(() => {
        inputComposerClearTransientStateRef.current = inputComposerPersistence.clearTransientInputState;
        inputComposerCaptureTransientStateRef.current = inputComposerPersistence.captureTransientInputState;
        inputComposerRestoreTransientStateRef.current = inputComposerPersistence.restoreTransientInputState;
        return () => {
            if (inputComposerClearTransientStateRef.current === inputComposerPersistence.clearTransientInputState) {
                inputComposerClearTransientStateRef.current = noopInputComposerClearTransientState;
            }
            if (inputComposerCaptureTransientStateRef.current === inputComposerPersistence.captureTransientInputState) {
                inputComposerCaptureTransientStateRef.current = noopInputComposerCaptureTransientState;
            }
            if (inputComposerRestoreTransientStateRef.current === inputComposerPersistence.restoreTransientInputState) {
                inputComposerRestoreTransientStateRef.current = noopInputComposerRestoreTransientState;
            }
        };
    }, [
        inputComposerCaptureTransientStateRef,
        inputComposerClearTransientStateRef,
        inputComposerPersistence.captureTransientInputState,
        inputComposerPersistence.clearTransientInputState,
        inputComposerPersistence.restoreTransientInputState,
        inputComposerRestoreTransientStateRef,
    ]);
    const isInputExpanded = inputComposerPersistence.expanded;
    const maxPanelHeight = agentInputProps.maxPanelHeight
        ?? computeExistingSessionComposerPanelMaxHeight({
            availablePanelHeight: scaffoldAvailablePanelHeight,
            viewportHeight: windowHeight,
        });
    const collapsedInputMaxHeight = agentInputProps.inputMaxHeight
        ?? computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: scaffoldAvailablePanelHeight,
            expanded: false,
            keyboardHeight,
            viewportHeight: windowHeight,
        });
    const inputMaxHeight = isInputExpanded
        ? agentInputProps.inputMaxHeight
            ?? computeExistingSessionComposerInputMaxHeight({
                availablePanelHeight: scaffoldAvailablePanelHeight,
                expanded: true,
                keyboardHeight,
                viewportHeight: windowHeight,
            })
        : collapsedInputMaxHeight;
    const inputExpansion = React.useMemo(() => ({
        expanded: isInputExpanded,
        collapsedMaxHeight: collapsedInputMaxHeight,
        onToggle: () => {
            inputComposerPersistence.setExpanded((current) => !current);
        },
    }), [collapsedInputMaxHeight, inputComposerPersistence, isInputExpanded]);
    const agentInputUsageData = React.useMemo(() => {
        const usage = sessionUsage ?? sessionLatestUsage ?? null;
        return usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreation: usage.cacheCreation,
            cacheRead: usage.cacheRead,
            contextSize: usage.contextSize,
            ...(typeof usage.contextWindowTokens === 'number'
                ? { contextWindowTokens: usage.contextWindowTokens }
                : {}),
        } : undefined;
    }, [sessionLatestUsage, sessionUsage]);

    return (
        <AgentInput
            {...agentInputProps}
            sessionId={sessionId}
            contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET}
            inputMaxHeight={inputMaxHeight}
            inputExpansion={inputExpansion}
            inputPersistence={inputComposerPersistence.inputPersistence}
            structuredInputMentions={inputComposerPersistence.structuredInputPersistence.mentions}
            onStructuredInputMentionsChange={inputComposerPersistence.structuredInputPersistence.onMentionsChange}
            maxPanelHeight={maxPanelHeight}
            usageData={agentInputUsageData}
        />
    );
});

type SessionAgentInputWithUsageAndRequestsProps = Omit<
    SessionAgentInputWithUsageProps,
    'permissionRequests'
> & {
    session: Session;
};

const SessionAgentInputWithUsageAndRequests = React.memo(function SessionAgentInputWithUsageAndRequests({
    session,
    ...props
}: SessionAgentInputWithUsageAndRequestsProps) {
    const shouldReadTranscript = shouldReadTranscriptForPendingRequests(session);
    const { messages: committedMessages } = useSessionMessages(props.sessionId, { enabled: shouldReadTranscript });
    const pendingPermissionRequests = React.useMemo(
        () => listPendingPermissionRequests(session, shouldReadTranscript ? committedMessages : undefined),
        [committedMessages, session, shouldReadTranscript],
    );
    const stablePendingPermissionRequests = useStableAgentInputRequests(pendingPermissionRequests);

    return (
        <SessionAgentInputWithUsage
            {...props}
            permissionRequests={stablePendingPermissionRequests}
        />
    );
});

type SessionAgentInputRuntimeStatusBoundaryProps = Omit<
    SessionAgentInputWithUsageAndRequestsProps,
    'connectionStatus' | 'showAbortButton'
> & {
    inactiveStatusText: string | null;
    connectedServicesRestartState: SessionConnectedServicesAuthSwitchRestartState;
};

const SessionAgentInputRuntimeStatusBoundary = React.memo(function SessionAgentInputRuntimeStatusBoundary({
    inactiveStatusText,
    connectedServicesRestartState,
    session,
    ...props
}: SessionAgentInputRuntimeStatusBoundaryProps) {
    const sessionRuntimeStatusSource = useSessionRuntimeStatusSource(session);
    const sessionStatus = useSessionStatus(sessionRuntimeStatusSource, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const connectionStatus = React.useMemo(() => ({
        text: connectedServicesRestartState?.status === 'restarting'
            || connectedServicesRestartState?.status === 'pending_confirmation'
            ? t('connectedServices.authSwitch.status.restarting')
            : connectedServicesRestartState?.status === 'failed'
            ? t('connectedServices.authSwitch.switchFailed')
            : sessionStatus.state === 'resuming'
            ? t('session.resuming')
            : (inactiveStatusText || sessionStatus.statusText),
        color: sessionStatus.statusColor,
        dotColor: sessionStatus.statusDotColor,
        isPulsing: connectedServicesRestartState?.status === 'restarting'
            || connectedServicesRestartState?.status === 'pending_confirmation'
            || sessionStatus.isPulsing,
    }), [
        connectedServicesRestartState?.status,
        inactiveStatusText,
        sessionStatus.isPulsing,
        sessionStatus.state,
        sessionStatus.statusColor,
        sessionStatus.statusDotColor,
        sessionStatus.statusText,
    ]);

    return (
        <SessionAgentInputWithUsageAndRequests
            {...props}
            session={session}
            sessionActive={sessionRuntimeStatusSource.active === true}
            connectionStatus={connectionStatus}
            showAbortButton={shouldShowAbortButtonForSessionState(sessionStatus.state)}
        />
    );
});

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

function useSessionRunnerRuntimeStatusRetention(input: Readonly<{
    enabled: boolean;
    serverId: string;
    session: Session | null;
}>): Readonly<{
    machineId: string | null;
    status: SessionRunnerRuntimeStatusSnapshot | null;
    invalidateAndRefresh: () => void;
}> {
    const sessionId = input.session?.id ?? '';
    const controlMachineTarget = useSessionMachineControlTarget(sessionId);
    const reachableMachineTarget = useSessionMachineTarget(sessionId);
    const rawMachineId = controlMachineTarget?.machineId
        ?? reachableMachineTarget?.machineId
        ?? input.session?.metadata?.machineId;
    const machineId = typeof rawMachineId === 'string' && rawMachineId.trim()
        ? rawMachineId.trim()
        : null;
    const identity = React.useMemo<SessionRunnerRuntimeStatusIdentity | null>(() => (
        input.enabled && sessionId && machineId
            ? {
                serverId: input.serverId,
                machineId,
                sessionId,
            }
            : null
    ), [input.enabled, input.serverId, machineId, sessionId]);
    const requestRevisionRef = React.useRef(0);
    const [refreshRevision, setRefreshRevision] = React.useState(0);
    const [, setStatusRevision] = React.useState(0);

    const status = identity ? sessionRunnerRuntimeStatusRetentionStore.read(identity) : null;
    const invalidateAndRefresh = React.useCallback(() => {
        if (!identity) return;
        requestRevisionRef.current += 1;
        setRefreshRevision((revision) => revision + 1);
    }, [identity]);

    React.useEffect(() => {
        if (!identity || !machineId || !sessionId) return;

        let cancelled = false;
        const requestRevision = requestRevisionRef.current;
        const refresh = sessionRunnerRuntimeStatusRetentionStore.beginRefresh(identity);
        void getSessionRunnerRuntimeStatus({
            sessionId,
            machineId,
            serverId: input.serverId,
        }).then((state) => {
            if (cancelled || requestRevision !== requestRevisionRef.current) return;
            sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, state);
            setStatusRevision((revision) => revision + 1);
        });
        return () => {
            cancelled = true;
        };
    }, [
        identity,
        input.serverId,
        machineId,
        refreshRevision,
        sessionId,
    ]);

    return {
        machineId,
        status,
        invalidateAndRefresh,
    };
}

type SessionViewProps = Readonly<{
    id: string;
    routeServerId?: string | null;
    routeHydrationState?: SessionRouteHydrationState | null;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    routeAnchorOverride?: boolean | null;
    contentOverride?: React.ReactNode;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    surfaceFocusedOverride?: boolean | null;
    chatBottomSpacing?: 'default' | 'none';
}>;

export const SessionView = React.memo((props: SessionViewProps) => {
    const sessionId = props.id;
    const router = useRouter();
    const pathname = usePathname();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const auth = useAuth();
    const credentials = auth.credentials;
    const routeHydrationState = props.routeHydrationState ?? null;
    const expectedRouteServerId = routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const session = useSessionViewShellSession(sessionId, expectedRouteServerId);
    const routeHydrationInFlight =
        routeHydrationState?.kind === 'loading' ||
        routeHydrationState?.kind === 'retrying';
    const routeHydrationLoading = !session && routeHydrationState?.kind === 'loading';
    const routeHydrationRetrying = !session && routeHydrationState?.kind === 'retrying';
    const routeHydrationPending = routeHydrationLoading || routeHydrationRetrying;
    const routeHydrationRetryStatusKey = routeHydrationRetrying
        ? resolveRouteHydrationRetryStatusKey(routeHydrationState.cause)
        : null;
    const routeHydrationTerminalMissing = !session && routeHydrationState?.kind === 'missing';
    const stableSessionForLoadedView = session;
    const stableSessionForHeader = session;
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const explicitRouteServerId = (routeHydrationState?.serverId ?? props.routeServerId ?? '').trim();
    const currentSessionRouteServerId =
        explicitRouteServerId
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
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
    const hasAuthCredentials = Boolean(credentials);
    const routeFocused = useSessionScreenIsFocused();
    const surfaceFocused = typeof props.surfaceFocusedOverride === 'boolean'
        ? props.surfaceFocusedOverride
        : routeFocused;
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const isRouteAnchor = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : isOwnedSessionRoutePathname(anchorPathname, sessionId);
    const shouldRenderSessionSurface = surfaceFocused || isRouteAnchor;
    const shouldRetainSessionSurface = Platform.OS === 'web' ? shouldRenderSessionSurface : true;
    const sessionRunnerRuntimeStatusRetention = useSessionRunnerRuntimeStatusRetention({
        enabled: Boolean(session && shouldRenderSessionSurface),
        serverId: currentSessionRouteServerId,
        session,
    });
    useSessionSurfaceActivation({
        sessionId,
        serverId: currentSessionRouteServerId,
        onSessionVisible: stableSessionForLoadedView && shouldRenderSessionSurface
            ? sync.onSessionVisible
            : undefined,
        surfaceFocused,
        surfaceRetained: shouldRetainSessionSurface,
        surfaceVisible: shouldRenderSessionSurface,
    });
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
    const allMachines = useLaunchSelectionMachines();
    const machinesById = React.useMemo(() => {
        const next: Record<string, (typeof allMachines)[number]> = {};
        for (const machine of allMachines) {
            next[machine.id] = machine;
        }
        return next;
    }, [allMachines]);
    const sessionOrganizationProjection = useSessionOrganizationProjection(currentSessionRouteServerId);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: currentSessionRouteServerId,
        projection: sessionOrganizationProjection,
    }), [currentSessionRouteServerId, sessionOrganizationProjection]);
    const workspaceLabelsV1 = organizationListViewState.workspaceLabelsV1;
    const workspacePathDisplayModeV1 = useSetting('workspacePathDisplayModeV1');
    const sessionWorkspacePresentation = React.useMemo(() => {
        if (!stableSessionForHeader) return null;
        return resolveSessionWorkspacePresentation({
            metadata: stableSessionForHeader.metadata ?? null,
            machines: machinesById,
            target: readDisplayMachineTargetForSession({
                sessionId: stableSessionForHeader.id,
                metadata: stableSessionForHeader.metadata ?? null,
            }),
            workspaceLabelsV1,
            workspacePathDisplayModeV1,
        });
    }, [machinesById, stableSessionForHeader, workspaceLabelsV1, workspacePathDisplayModeV1]);
    const sessionEncryptionMode: 'e2ee' | 'plain' = (session?.encryptionMode ?? 'e2ee');
    const isEncryptedSessionLocked = Boolean(session && sessionEncryptionMode === 'e2ee' && !hasAuthCredentials);
    const showTopHeader = !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web');
    const paneUrlSyncRouteActive = surfaceFocused && isOwnedSessionRootPathname(pathname, sessionId);
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
    const routerRef = React.useRef(router);
    routerRef.current = router;

    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const paneScopeId = useRegisterSessionPaneDriver(sessionId);
    const pane = useAppPaneScope(paneScopeId);
    // Stable identity for THIS pane mount (not the session): `useId` is allocated by the outer
    // SessionView, which survives the inner `key={sessionId}` remount, so the seeded content width
    // persists across session switches in the same pane while staying isolated between panes.
    const contentWidthSurfaceId = React.useId();
    // Release the seeded width when this pane mount unmounts (the cleanup only runs when the outer
    // SessionView goes away, not on session switch), so the seed cache does not grow unbounded.
    React.useEffect(() => {
        return () => {
            forgetSessionViewContentWidthSurface(contentWidthSurfaceId);
        };
    }, [contentWidthSurfaceId]);
    const sessionAutomationsEnabledCount = useSessionAutomationsEnabledCount(sessionId, showAutomations);

    const constrainHeaderWidth = !(multiPaneEnabled
        && Platform.OS === 'web'
        && ((pane.scopeState?.right.isOpen ?? false) || (pane.scopeState?.details.isOpen ?? false)));

    const mobileWorkspaceExperienceToggleActionId = React.useMemo(
        () => resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperienceState.mobileWorkspaceExperience),
        [mobileWorkspaceExperienceState.mobileWorkspaceExperience],
    );
    const toggleWorkspaceExperienceRef = React.useRef(mobileWorkspaceExperienceState.toggleWorkspaceExperience);
    toggleWorkspaceExperienceRef.current = mobileWorkspaceExperienceState.toggleWorkspaceExperience;

    const handleToggleWorkspaceExperience = React.useCallback(() => {
        toggleWorkspaceExperienceRef.current();
    }, []);
    const shouldFoldHeaderIconActions = windowWidth < 520;

    // `ChatHeaderView` is memoized, and the header is the one surface that must not repaint on
    // every transcript-driven render of this screen. An element built inline in the JSX below is a
    // new object on every render and defeats that memo on its own, so the gutter element is built
    // here with the only two inputs it has.
    const headerGutterElement = React.useMemo(() => (
        shouldFoldHeaderIconActions
            ? undefined
            : <SessionHeaderRightSidebarButton scopeId={paneScopeId} />
    ), [paneScopeId, shouldFoldHeaderIconActions]);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!shouldRenderSessionSurface) {
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                agentId: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if ((!isDataReady && !session) || routeHydrationPending) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                agentId: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session && (routeHydrationTerminalMissing || !routeHydrationState)) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                agentId: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const headerSession = stableSessionForHeader ?? session;
        if (!headerSession) {
            return {
                title: t('common.loading'),
                subtitle: undefined,
                avatarId: undefined,
                agentId: undefined,
                rightElement: undefined,
                isConnected: false,
                flavor: null
            };
        }
        const isConnected = headerSession.presence === 'online';
        const directSessionLink = readDirectSessionLink(headerSession.metadata);
        const storageBadge = directSessionLink ? t('sessionsList.storageDirectTab') : t('sessionsList.storagePersistedTab');
        const providerBadge = directSessionLink
            ? [
                t(getAgentCore(directSessionLink.providerId).displayNameKey),
                typeof headerSession.metadata?.host === 'string' && headerSession.metadata.host.trim()
                    ? headerSession.metadata.host.trim()
                    : directSessionLink.machineId,
            ].join(' · ')
            : null;
        const openSessionInfo = () => routerRef.current.navigate(buildCurrentSessionHref('/info') as any, {
            dangerouslySingular() {
                return 'session-info';
            },
        } as any);
        const rightElement = (
            <SessionHeaderRightElement
                sessionId={sessionId}
                session={headerSession}
                paneScopeId={paneScopeId}
                currentSessionRouteServerId={currentSessionRouteServerId}
                mobileWorkspaceExperienceToggleActionId={mobileWorkspaceExperienceToggleActionId}
                mobileWorkspaceExperienceToggleLabelKey={mobileWorkspaceExperienceState.workspaceExperienceToggleLabelKey}
                onToggleWorkspaceExperience={handleToggleWorkspaceExperience}
                sessionAutomationsEnabledCount={sessionAutomationsEnabledCount}
                shouldFoldHeaderIconActions={shouldFoldHeaderIconActions}
                onOpenSessionInfo={openSessionInfo}
                showAutomations={showAutomations}
                showWorkspaceExperienceToggle={mobileWorkspaceExperienceState.showWorkspaceExperienceToggle}
            />
        );
        return {
            title: getSessionName(headerSession),
            subtitle: sessionWorkspacePresentation?.displayTitle || undefined,
            subtitleEllipsizeMode: sessionWorkspacePresentation?.displayPath && !sessionWorkspacePresentation.hasCustomLabel ? 'head' as const : undefined,
            avatarId: getSessionAvatarId(headerSession),
            agentId: resolveAgentIdFromSessionMetadata(headerSession.metadata)
                ?? resolveAgentIdFromFlavor(headerSession.metadata?.flavor ?? null),
	            rightElement,
	            badges: providerBadge ? [storageBadge, providerBadge] : [storageBadge],
	            isConnected: isConnected,
	            flavor: headerSession.metadata?.flavor || null,
	        };
	    }, [
        handleToggleWorkspaceExperience,
        isDataReady,
        mobileWorkspaceExperienceState.showWorkspaceExperienceToggle,
        mobileWorkspaceExperienceState.workspaceExperienceToggleLabelKey,
        mobileWorkspaceExperienceToggleActionId,
        paneScopeId,
        routeHydrationPending,
        routeHydrationState,
        routeHydrationTerminalMissing,
        stableSessionForHeader,
        sessionWorkspacePresentation,
        sessionAutomationsEnabledCount,
        sessionId,
        shouldRenderSessionSurface,
        shouldFoldHeaderIconActions,
        showAutomations,
    ]);

    const normalSessionContent = session && shouldRenderSessionSurface
        ? (props.contentOverride ?? (
            <SessionViewLoadedWithPendingMessages
                authSurfaceState={authSurfaceState}
                key={sessionId}
                sessionId={sessionId}
                routeServerId={currentSessionRouteServerId}
                session={stableSessionForLoadedView ?? session}
                onBackPress={handleBackPress}
                isEncryptedSessionLocked={isEncryptedSessionLocked}
                executionRunsEnabled={executionRunsEnabled}
                jumpToSeq={props.jumpToSeq ?? null}
                paneUrlState={props.paneUrlState ?? null}
                initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                paneScopeId={paneScopeId}
                contentWidthSurfaceId={contentWidthSurfaceId}
                chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                paneUrlSyncRouteActive={paneUrlSyncRouteActive}
                surfaceFocused={shouldRenderSessionSurface}
                routeHydrationPending={routeHydrationPending}
                sessionRunnerRuntimeStatus={sessionRunnerRuntimeStatusRetention.status}
                sessionRunnerRuntimeStatusMachineId={sessionRunnerRuntimeStatusRetention.machineId}
                onSessionRunnerRuntimeStatusInvalidated={sessionRunnerRuntimeStatusRetention.invalidateAndRefresh}
            />
        ))
        : null;
    return (
        <SessionScreenTestIdsProvider enabled={surfaceFocused}>
            {session && shouldRenderSessionSurface && props.contentOverride == null ? (
                <SessionPendingMessagesRefresh sessionId={sessionId} />
            ) : null}
            {session && shouldRenderSessionSurface && props.contentOverride != null ? (
                <SessionContentOverrideViewedLifecycle
                    sessionId={sessionId}
                    serverId={session.serverId ?? currentSessionRouteServerId}
                    surfaceFocused={shouldRenderSessionSurface}
                />
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
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface.base,
                    zIndex: 1000,
                    ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {showTopHeader && shouldRenderSessionSurface && (
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
                        showBackButton={!isTablet}
                        gutterElement={headerGutterElement}
                        constrainWidth={constrainHeaderWidth}
                        includeTopInset={headerSafeAreaTopMode !== 'external'}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: showTopHeader ? safeAreaTopInset + headerHeight : 0 }}>
                {!session && authSurfaceState ? (
                    <SessionAuthRecoveryFallback message={authSurfaceState.message} />
                ) : routeHydrationRetrying ? (
                    <View testID="session-route-retrying" style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                        {routeHydrationRetryStatusKey ? (
                            <Text style={{ color: theme.colors.text.secondary, marginTop: 10, textAlign: 'center' }}>
                                {t(routeHydrationRetryStatusKey)}
                            </Text>
                        ) : null}
                    </View>
                ) : ((!isDataReady && !session) || routeHydrationLoading) ? (
                    // Loading state
                    <View testID="session-route-loading" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                ) : !session && (routeHydrationTerminalMissing || !routeHydrationState) ? (
                    // Deleted state
                    <View testID="session-root-unavailable" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Icon name="trash" size={48} color={theme.colors.text.secondary} />
                        <Text style={{ color: theme.colors.text.primary, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                  ) : normalSessionContent}
            </View>
        </SessionScreenTestIdsProvider>
    );
});

function SessionContentOverrideViewedLifecycle({
    sessionId,
    serverId,
    surfaceFocused,
}: Readonly<{
    sessionId: string;
    serverId: string | null;
    surfaceFocused: boolean;
}>) {
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
    useSessionViewedLifecycle({
        sessionId,
        serverId,
        surfaceFocused,
        visibleReadSeq: sessionSeq,
    });
    return null;
}

const SessionPendingMessagesRefresh = React.memo(function SessionPendingMessagesRefresh({
    sessionId,
}: Readonly<{ sessionId: string }>) {
    const pendingVersion = storage((state) => state.sessions[sessionId]?.pendingVersion ?? null);

    React.useEffect(() => {
        return runAfterInteractionsWithFallback(() => {
            fireAndForget(sync.fetchPendingMessages(sessionId), { tag: 'SessionView.fetchPendingMessages' });
        });
    }, [sessionId, pendingVersion]);

    return null;
});

const SessionViewedLifecycle = React.memo(function SessionViewedLifecycle({
    sessionId,
    serverId,
    latestTurnStatus,
    surfaceFocused,
}: Readonly<{
    sessionId: string;
    serverId: string | null;
    latestTurnStatus: Session['latestTurnStatus'];
    surfaceFocused: boolean;
}>) {
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
    const visibleReadSeq = useSessionVisibleReadSeq(sessionId, {
        sessionSeq,
        latestTurnStatus,
    });
    useSessionViewedLifecycle({
        sessionId,
        serverId,
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
    const shouldRenderChatTimeline = React.useMemo(() => {
        if (isEncryptedSessionLocked) return false;
        return shouldRenderChatTimelineForSession({
            committedMessagesCount: committedMessageIds.length,
            pendingMessagesCount,
            controlledByUser: isLocallyAttached,
            // Some sessions can have a non-zero committed transcript seq but end up with 0 visible
            // main-timeline messages (e.g. newest page is sidechain-only). In that case, we must
            // still render the transcript so it can page backwards to find visible messages.
            forceRenderFooter: isForkedSessionV1 || (isLoaded === true && (session.seq ?? 0) > 0 && committedMessageIds.length === 0),
        });
    }, [committedMessageIds.length, isEncryptedSessionLocked, isForkedSessionV1, isLoaded, isLocallyAttached, pendingMessagesCount, session.seq]);

    return {
        committedMessagesCount: committedMessageIds.length,
        isLoaded,
        shouldRenderChatTimeline,
    };
}

type SessionTranscriptAgentContentViewProps = SessionTranscriptRenderStateInput & Readonly<{
    content: React.ReactNode | null;
    input: React.ReactNode | null;
    placeholder: React.ReactNode | null;
    safeAreaBottom?: number;
}>;

const SessionTranscriptAgentContentView = React.memo(function SessionTranscriptAgentContentView({
    content,
    input,
    placeholder,
    safeAreaBottom,
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
}: SessionTranscriptAgentContentViewProps) {
    const { shouldRenderChatTimeline } = useSessionTranscriptRenderState({
        sessionId,
        session,
        isEncryptedSessionLocked,
        isForkedSessionV1,
        isLocallyAttached,
        pendingMessagesCount,
    });

    return (
        <AgentContentView
            content={content}
            input={input}
            placeholder={shouldRenderChatTimeline ? null : placeholder}
            safeAreaBottom={safeAreaBottom}
        />
    );
});

type SessionTranscriptContentProps = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
    reducedMotionPreferred: boolean;
    bottomNotice: ChatListProps['bottomNotice'];
    controlledByUserOverride: ChatListProps['controlledByUserOverride'];
    controlSwitchTo: ChatListProps['controlSwitchTo'];
    onRequestSwitchToRemote: ChatListProps['onRequestSwitchToRemote'];
    directControlFooter: ChatListProps['directControlFooter'];
    approvalRequests: ChatListProps['approvalRequests'];
    jumpToSeq: ChatListProps['jumpToSeq'];
    followBottomIntentKey: ChatListProps['followBottomIntentKey'];
    onViewportChange: ChatListProps['onViewportChange'];
    onEditPendingMessage: ChatListProps['onEditPendingMessage'];
    routeHydrationPending: ChatListProps['routeHydrationPending'];
}>;

const SessionTranscriptContent = React.memo(function SessionTranscriptContent({
    sessionId,
    session,
    isEncryptedSessionLocked,
    isForkedSessionV1,
    isLocallyAttached,
    pendingMessagesCount,
    reducedMotionPreferred,
    bottomNotice,
    controlledByUserOverride,
    controlSwitchTo,
    onRequestSwitchToRemote,
    directControlFooter,
    approvalRequests,
    jumpToSeq,
    followBottomIntentKey,
    onViewportChange,
    onEditPendingMessage,
    routeHydrationPending,
}: SessionTranscriptContentProps) {
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

    const { committedMessagesCount, isLoaded, shouldRenderChatTimeline } = useSessionTranscriptRenderState({
        sessionId,
        session,
        isEncryptedSessionLocked,
        isForkedSessionV1,
        isLocallyAttached,
        pendingMessagesCount,
    });

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
        applyTranscriptJumpHighlightForJumpResult(sessionId, result);
    }, [sessionId]);

    const transcriptDeferredFallback = shouldRenderChatTimeline ? (
        <TranscriptFirstPaintPlaceholder reducedMotion={reducedMotionPreferred} />
    ) : null;
    const transcriptCanMountWithoutDeferredWindow =
        shouldRenderChatTimeline
        && (
            isLoaded === true
            || committedMessagesCount > 0
            || pendingMessagesCount > 0
        );

    return (
        <Deferred enabled={transcriptCanMountWithoutDeferredWindow} fallback={transcriptDeferredFallback}>
            {shouldRenderChatTimeline ? (
                <ChatList
                    session={session}
                    bottomNotice={bottomNotice}
                    controlledByUserOverride={controlledByUserOverride}
                    controlSwitchTo={controlSwitchTo}
                    onRequestSwitchToRemote={onRequestSwitchToRemote}
                    directControlFooter={directControlFooter}
                    approvalRequests={approvalRequests}
                    jumpToSeq={jumpToSeq}
                    followBottomIntentKey={followBottomIntentKey}
                    onJumpLanded={handleTranscriptJumpLanded}
                    onViewportChange={onViewportChange}
                    onEditPendingMessage={onEditPendingMessage}
                    routeHydrationPending={routeHydrationPending}
                />
            ) : null}
        </Deferred>
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
    onRestoreSecretKeyPress: () => void;
    activityColor: string;
}>;

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

    if (shouldRenderChatTimeline) return null;

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
                    <Text style={{ fontSize: 18, color: restoreSecretKeyColor }}>
                        {t('navigation.restoreWithSecretKey')}
                    </Text>
                    <Text style={{ fontSize: 14, color: restoreSecretKeyDescriptionColor, lineHeight: 20 }}>
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

    return isLoaded ? (
        <EmptyMessages session={session} />
    ) : (
        <ActivitySpinner size="small" color={activityColor} />
    );
});

function SessionViewLoaded({
    authSurfaceState,
    sessionId,
    routeServerId,
    session,
    onBackPress,
    isEncryptedSessionLocked,
    executionRunsEnabled,
    jumpToSeq,
    participantTargets,
    agentActivityCounts,
    paneUrlState,
    initialAttachmentDrafts,
    paneScopeId,
    contentWidthSurfaceId,
    pendingMessages,
    directSessionRuntime,
    chatBottomSpacing,
    paneUrlSyncRouteActive,
    surfaceFocused,
    routeHydrationPending,
    sessionRunnerRuntimeStatus,
    sessionRunnerRuntimeStatusMachineId,
    onSessionRunnerRuntimeStatusInvalidated,
}: SessionViewLoadedProps) {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const credentials = auth.credentials;
    const credentialScope = credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });
    const sessionRuntimeStatusSource = useSessionRuntimeStatusSource(session, {
        subscribeToRuntimeActivity: false,
    });
    const applyLocalSettings = useApplyLocalSettings();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const directSessionLink = directSessionRuntime.directSessionLink;
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const { width: windowWidth } = useWindowDimensions();
    const reducedMotionPreferred = useReducedMotionPreference();
    // Seed from the pane-keyed width source so the first frame after a session switch already has the
    // settled content width (no window-width fallback frame -> no bottom-spacing flip). Resize is
    // handled by the seed cache (it invalidates when the window width changes).
    const [measuredContentWidth, setMeasuredContentWidth] = React.useState<number | null>(
        () => readSeededSessionViewContentWidth({ surfaceId: contentWidthSurfaceId, windowWidthPx: windowWidth }),
    );
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const sessionsRightPaneDefaultOpen = useLocalSetting('sessionsRightPaneDefaultOpen');
    const pane = useAppPaneScope(paneScopeId);
    const activeServerId = getActiveServerSnapshot().serverId;
    const sessionRouteServerId = (routeServerId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || activeServerId;
    const capabilityServerId = sessionRouteServerId;
    /**
     * WHERE anything belonging to this session opens — the one decision, asked rather than repeated.
     *
     * Three inline copies of it used to live in this file and its header element: the roster lead-in
     * probed `resolvePaneLayout` itself, the files button probed it again, and the header's agents
     * controls did not probe at all and opened a right pane that a phone never draws.
     */
    const openSessionTarget = useOpenSessionTarget({
        sessionId,
        scopeId: paneScopeId,
        serverId: sessionRouteServerId,
    });
    /**
     * The lead-in from the compact work-state surface to the expanded Agents roster.
     *
     * It used to be `undefined` on every phone, because the right pane is hidden there and an
     * affordance that leads nowhere must not render (A9). The roster now has a screen of its own, so
     * the destination exists on every device and the lead-in is unconditional: the Agents tab where a
     * right pane fits, `/session/<id>/agents` where it does not. The compact surface still expands
     * its own overflow IN PLACE — that cap and this destination are different mechanisms.
     */
    const openAgentActivityRoster = React.useCallback(() => {
        openSessionTarget({ kind: 'agentRoster' });
    }, [openSessionTarget]);
    const accountProfile = useProfile();
    const usageLimitRecoveryFeatureEnabled = useFeatureEnabled('sessions.usageLimitRecovery', {
        scopeKind: 'spawn',
        serverId: capabilityServerId,
    });
    const [usageLimitRecoverySettingsV1, setUsageLimitRecoverySettingsV1] = useSettingMutable('usageLimitRecoverySettingsV1');
    const usageLimitRecovery = React.useMemo(
        () => readSessionUsageLimitRecovery(session.metadata),
        [session.metadata],
    );
    const usageLimitRecoveryQuotaProfileRef = React.useMemo(() => resolveUsageLimitRecoveryQuotaProfileRef({
        recovery: usageLimitRecovery,
        issue: session.lastRuntimeIssue ?? null,
    }), [session.lastRuntimeIssue, usageLimitRecovery]);
    const usageLimitRecoveryQuotaSnapshots = useConnectedServiceQuotaSnapshots(
        usageLimitRecoveryQuotaProfileRef ? [usageLimitRecoveryQuotaProfileRef] : [],
    );
    const usageLimitRecoveryQuotaProfileKey = usageLimitRecoveryQuotaProfileRef
        ? connectedServiceProfileKey(usageLimitRecoveryQuotaProfileRef)
        : null;
    const usageLimitRecoveryQuotaSnapshot = usageLimitRecoveryQuotaProfileKey
        ? usageLimitRecoveryQuotaSnapshots.snapshotsByKey[usageLimitRecoveryQuotaProfileKey] ?? null
        : null;
    const usageLimitRecoveryCredits = React.useMemo<ConnectedServiceQuotaRecoveryCreditsV1 | null>(() => (
        usageLimitRecoveryQuotaSnapshot
            ? usageLimitRecoveryQuotaSnapshot.recoveryCredits ?? null
            : usageLimitRecovery?.recoveryCredits ?? null
    ), [usageLimitRecovery?.recoveryCredits, usageLimitRecoveryQuotaSnapshot]);
    const usageLimitRecoveryResetAtMs = React.useMemo(() => readUsageLimitRecoveryResetAtMs({
        issue: session.lastRuntimeIssue ?? null,
        recovery: usageLimitRecovery,
    }), [session.lastRuntimeIssue, usageLimitRecovery]);
    const [usageLimitRecoveryNowMs, setUsageLimitRecoveryNowMs] = React.useState(() => nowServerMs());
    const [usageLimitRecoveryOperationStatus, setUsageLimitRecoveryOperationStatus] = React.useState<Readonly<{
        issueFingerprint: string;
        status: UsageLimitRecoveryOperationStatus;
        retryAtMs?: number | null;
    }> | null>(null);
    const [usageLimitRecoveryPendingAction, setUsageLimitRecoveryPendingAction] = React.useState<SessionUsageLimitRecoveryActionKind | null>(null);
    const usageLimitRecoveryPendingActionRef = React.useRef(false);
    const usageLimitRecoveryActionsDisabled = usageLimitRecoveryPendingAction !== null;
    const [resolvedUsageLimitRecoveryIssueFingerprint, setResolvedUsageLimitRecoveryIssueFingerprint] = React.useState<string | null>(null);
    const handleUsageLimitRecoveryResumeNowRef = React.useRef<((opts?: { silent?: boolean }) => Promise<boolean>) | null>(null);
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

    React.useEffect(() => {
        const refreshNow = () => setUsageLimitRecoveryNowMs(nowServerMs());
        refreshNow();

        if (usageLimitRecoveryResetAtMs === null) return;
        const delayMs = usageLimitRecoveryResetAtMs - nowServerMs();
        if (delayMs <= 0 || delayMs > MAX_USAGE_LIMIT_RECOVERY_READY_TIMER_MS) return;

        const timer = setTimeout(refreshNow, delayMs);
        return () => {
            clearTimeout(timer);
        };
    }, [sessionId, usageLimitRecoveryResetAtMs]);

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
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptMessageSendToSessionTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const transcriptSelectionEligibleMessageIds = useTranscriptSelectionEligibleMessageIds(sessionId, {
        enabled: transcriptMessageSelectionEnabled === true,
        metadata: session.metadata,
    });
    const navigateToSession = useNavigateToSession();
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const isForkedSessionV1 = React.useMemo(() => {
        const fork = (session.metadata as any)?.forkV1;
        if (!fork || typeof fork !== 'object') return false;
        if ((fork as any).v !== 1) return false;
        const parentSessionId = (fork as any).parentSessionId;
        return typeof parentSessionId === 'string' && parentSessionId.trim().length > 0;
    }, [session.metadata]);
    const reachableMachineTarget = useSessionMachineTarget(sessionId);
    const controlMachineTarget = useSessionMachineControlTarget(sessionId);

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
    const sessionWorkStateSnapshot = React.useMemo(
        () => readSessionWorkStateFromMetadata(session.metadata),
        [session.metadata],
    );
    const primaryWorkStateItem = React.useMemo(
        () => resolvePrimarySessionWorkStateItem(sessionWorkStateSnapshot),
        [sessionWorkStateSnapshot],
    );
    const [activeStatusBadgeKey, setActiveStatusBadgeKey] = React.useState<string | null>(null);
    // Composer banner collapse is owned by ComposerBannerCollapseProvider (mounted above this
    // component) so a banner and the badge that toggles it agree even across subtrees, and so the
    // account-level "remember" preference decides between session-scoped and device-persisted state.
    const [pendingQueueResumeFailed, setPendingQueueResumeFailed] = React.useState(false);
    const usageLimitRecoveryBanner = useComposerBannerCollapse('usageLimitRecovery');
    const staleSessionRunnerBanner = useComposerBannerCollapse('staleSessionRunner');
    const authRecoveryBanner = useComposerBannerCollapse('authRecovery');
    const pendingQueueResumeFailedBanner = useComposerBannerCollapse('pendingQueueResumeFailed');
    const agentTransitionOutcomeBanner = useComposerBannerCollapse('agentTransitionOutcome');
    const activeServerAccountScope = useActiveServerAccountScope();
    const activeServerAccountScopeKey = activeServerAccountScope
        ? serverAccountScopeKeySuffix(activeServerAccountScope)
        : 'local';
    // The last armed-switch outcome that still has something to say.
    //
    // This screen holds the FACT; `continueSessionWithArmedAgent` owns what it
    // MEANS — which recovery is factually safe, whether the draft and the armed
    // row survive, and whether the composer may submit again. A refusal never
    // reaches the daemon at all, so it carries its own already-resolved sentence
    // rather than pretending to be a transition result.
    const [armedContinuationOutcome, setArmedContinuationOutcome] = React.useState<
        | Readonly<{ kind: 'refusal'; message: string; scopeKey: string }>
        | Readonly<{
            kind: 'outcome';
            /**
             * The Session this outcome belongs to. A restored one carries its
             * own, so a screen reused across a route change can never mirror one
             * Session's unsettled switch onto another's composer.
             */
            sessionId: string;
            /** The account/server scope that owned this arm at dispatch time. */
            scopeKey: string;
            result: SessionAgentTransitionResultV1;
            /**
             * The switch that was submitted: the target the banner names, and
             * the identity a restored arm has to match to keep its localId.
             */
            intent: ComposerAgentContinuationIntentV1;
            /**
             * Resolved from that intent against the same catalog the rail
             * offered it from — at send time or at restore, through one helper.
             * Nothing presentational is persisted.
            */
            labels: ArmedAgentContinuationLabels;
            localId: string;
            /** Canonical Session/message facts have been read since the call returned. */
            reconciled: boolean;
        }>
        | null
    >(null);
    const [
        resolvedStaleSessionRunnerFingerprint,
        setResolvedStaleSessionRunnerFingerprint,
    ] = React.useState<string | null>(null);
    const [
        staleSessionRunnerOperationStatus,
        setStaleSessionRunnerOperationStatus,
    ] = React.useState<Readonly<{
        fingerprint: string;
        status: StaleSessionRunnerRestartViewStatus;
    }> | null>(null);
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
    const agentGoalsFeatureEnabled = useFeatureEnabled('agent.goals');
    const enabledAgentIds = useEnabledAgentIds();
    const sessionActionDefaultBackend = React.useMemo(
        () => resolveSessionActionDefaultBackend({
            session: session as any,
            enabledAgentIds,
            fallbackAgentId: agentId,
        }),
        [agentId, enabledAgentIds, session],
    );
    const hasWriteAccess = hasSessionWriteAccess(session.accessLevel);
    const providerSupportsEditableSessionGoals = React.useMemo(
        () => supportsEditableSessionGoals({ agentId, session }),
        [agentId, session],
    );
    const canEditSessionGoals = React.useMemo(
        () => isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: providerSupportsEditableSessionGoals,
            goalsFeatureEnabled: agentGoalsFeatureEnabled,
            // View-only sessions (`accessLevel === 'view'`) may DISPLAY goal/work-state but must not
            // expose enabled goal mutation controls — goal editing requires write access (G5).
            hasWriteAccess,
        }),
        [agentGoalsFeatureEnabled, hasWriteAccess, providerSupportsEditableSessionGoals],
    );
    // Provider goal-action capability profile applied to the set-first-goal form (before any native
    // goal item exists), so a provider like Claude shows only edit/clear with no budget/lifecycle
    // controls. Null = full legacy surface (Codex). Capability-driven; no provider-name branching.
    const sessionGoalActionCapabilityFallback = React.useMemo(
        () => resolveSessionGoalActionCapabilityProfile({ agentId, session }),
        [agentId, session],
    );
    const setSessionGoalForView = React.useCallback(
        (request: Parameters<typeof sessionGoalSet>[1]) => sessionGoalSet(sessionId, request),
        [sessionId],
    );
    const clearSessionGoalForView = React.useCallback(
        () => sessionGoalClear(sessionId),
        [sessionId],
    );
    // Narrow goal-objective selector: the chip "current goal" label reflects ONLY an active goal
    // (H3). Completed, cleared/cancelled, or paused goals are not current, so the chip falls back to
    // "Set goal". The label only changes when the active goal title changes, not when unrelated
    // todo/task work-state items update.
    const sessionGoalObjective = React.useMemo(
        () => resolveActiveSessionGoalItem(sessionWorkStateSnapshot)?.title ?? null,
        [sessionWorkStateSnapshot],
    );
    const sessionGoalActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!canEditSessionGoals) return null;
        return createGoalActionChip({
            sessionId,
            snapshot: sessionWorkStateSnapshot,
            editableGoal: canEditSessionGoals,
            goalActionCapabilityFallback: sessionGoalActionCapabilityFallback,
            currentObjective: sessionGoalObjective,
            onOpenFullRoster: openAgentActivityRoster,
            onSetGoal: setSessionGoalForView,
            onClearGoal: clearSessionGoalForView,
        });
    }, [canEditSessionGoals, clearSessionGoalForView, openAgentActivityRoster, sessionGoalActionCapabilityFallback, sessionGoalObjective, sessionId, sessionWorkStateSnapshot, setSessionGoalForView]);
    // The SINGLE compact above-AgentInput chip. Goal/task/todo priority is delegated to the
    // protocol resolver inside `resolveSessionActivityStatusBadgePresentation`; live work is
    // composed from the ONE unified agent-activity tally this subtree already derives, which is
    // what makes the chip, the popover it opens, the header glyph and the Agents tab badge
    // structurally incapable of reporting different numbers. There is no second badge path.
    const sessionWorkStateBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        const presentation = resolveSessionActivityStatusBadgePresentation({
            workStateSnapshot: sessionWorkStateSnapshot,
            agentActivityCounts,
            activeStatusBadgeKey,
            editableGoal: canEditSessionGoals,
            translateWorkState: t,
            // Resolved by the presentation owner, not spelled here: the session-list row says this
            // same sentence, and two hosts binding their own keys is how the row came to understate
            // a five-agent workflow as "1 agent working" while the chip said something else.
            translateActivity: resolveSessionActivityComposerTranslate(),
        });
        if (!presentation) return [];
        const iconName = presentation.iconKind === 'goal'
            ? 'crosshair'
            : presentation.iconKind === 'agent'
                ? 'robot'
                : 'list';
        return [{
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: presentation.label,
            testID: 'session-work-state-status-badge',
            // The live state, not the name of the surface: `AgentInputStatusBadge` resolves its
            // accessible name as `accessibilityLabel ?? label`, so a static string here REPLACES
            // the visible one and this chip is the only composer carrier of agent activity (R-12).
            accessibilityLabel: presentation.accessibilityLabel,
            tone: presentation.tone,
            emphasis: presentation.emphasis,
            icon: (tint) => <Icon name={iconName} size={14} color={tint} />,
            renderPopover: ({ open, anchorRef, onRequestClose }) => (
                <SessionWorkStatePopover
                    open={open}
                    anchorRef={anchorRef}
                    sessionId={sessionId}
                    snapshot={sessionWorkStateSnapshot}
                    editableGoal={canEditSessionGoals}
                    goalActionCapabilityFallback={sessionGoalActionCapabilityFallback}
                    onOpenFullRoster={openAgentActivityRoster}
                    onRequestClose={onRequestClose}
                    onSetGoal={canEditSessionGoals ? setSessionGoalForView : undefined}
                    onClearGoal={canEditSessionGoals ? clearSessionGoalForView : undefined}
                />
            ),
        }];
    }, [activeStatusBadgeKey, agentActivityCounts, canEditSessionGoals, clearSessionGoalForView, openAgentActivityRoster, sessionGoalActionCapabilityFallback, sessionId, sessionWorkStateSnapshot, setSessionGoalForView]);
    const usageLimitRecoveryCheckNowAgentId = React.useMemo(() => (
        resolveAgentIdFromFlavor(session.lastRuntimeIssue?.provider)
        ?? resolveAgentIdFromSessionMetadata(session.metadata)
        ?? resolveAgentIdFromFlavor(session.metadata?.flavor)
        ?? null
    ), [session.lastRuntimeIssue?.provider, session.metadata]);
    const usageLimitRecoveryCheckNowSupported = React.useMemo(() => (
        usageLimitRecoveryCheckNowAgentId
            ? evaluateAgentSessionCapabilitySupport({
                agentId: usageLimitRecoveryCheckNowAgentId,
                capability: 'usageLimitRecovery.checkNow',
                metadata: session.metadata,
            }) === 'supported'
            : false
    ), [session.metadata, usageLimitRecoveryCheckNowAgentId]);
    const usageLimitRecoveryMode = usageLimitRecoverySettingsV1?.mode === 'auto_wait' ? 'auto_wait' : 'ask';
    const usageLimitRecoveryResumePromptMode =
        usageLimitRecoverySettingsV1?.resumePromptMode === 'off' || usageLimitRecoverySettingsV1?.resumePromptMode === 'custom'
            ? usageLimitRecoverySettingsV1.resumePromptMode
            : 'standard';
    const formatUsageLimitRecoveryTime = React.useCallback((timeMs: number) => new Date(timeMs).toLocaleString(), []);
    const translateUsageLimitRecovery = React.useCallback<SessionUsageLimitRecoveryTranslate>((key, params) => {
        switch (key) {
            case 'session.usageLimitRecovery.resetBody':
                return t(key, { time: params?.time ?? '' });
            case 'session.usageLimitRecovery.statusWaitingUntil':
                return t(key, { time: params?.time ?? '' });
            case 'session.usageLimitRecovery.resetCreditBody':
                return t(key, { count: params?.count ?? 0 });
            case 'session.usageLimitRecovery.resetCreditExpiresBody':
                return t(key, { count: params?.count ?? 0, time: params?.time ?? '' });
            default:
                return t(key);
        }
    }, []);
    const translateStaleSessionRunnerNotice = React.useCallback<StaleSessionRunnerNoticeTranslate>((key) => t(key), []);
    const usageLimitRuntimeState = React.useMemo(() => {
        const pendingFlags = derivePendingRequestFlagsFromSession(sessionRuntimeStatusSource);
        return deriveSessionRuntimePresentationState({
            active: sessionRuntimeStatusSource.active,
            activeAt: sessionRuntimeStatusSource.activeAt,
            presence: sessionRuntimeStatusSource.presence,
            thinking: sessionRuntimeStatusSource.thinking,
            thinkingAt: sessionRuntimeStatusSource.thinkingAt,
            latestTurnStatus: sessionRuntimeStatusSource.latestTurnStatus,
            latestTurnStatusObservedAt: sessionRuntimeStatusSource.latestTurnStatusObservedAt,
            meaningfulActivityAt: sessionRuntimeStatusSource.meaningfulActivityAt,
            hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
            pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(sessionRuntimeStatusSource),
        }, usageLimitRecoveryNowMs);
    }, [
        sessionRuntimeStatusSource,
        usageLimitRecoveryNowMs,
    ]);
    const hasInterruptedWorkToResume = React.useMemo(() => (
        session.active !== true
        || pendingMessages.length > 0
    ), [pendingMessages.length, session.active, session.metadata]);
    const baseUsageLimitRecoveryPresentation = React.useMemo(() => buildSessionUsageLimitRecoveryPresentation({
        featureEnabled: usageLimitRecoveryFeatureEnabled,
        latestTurnStatus: sessionRuntimeStatusSource.latestTurnStatus ?? null,
        issue: sessionRuntimeStatusSource.lastRuntimeIssue ?? null,
        recovery: usageLimitRecovery,
        recoveryCredits: usageLimitRecoveryCredits,
        operationStatus: null,
        runtimeWorking: usageLimitRuntimeState.runtimeActivelyWorking,
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(sessionRuntimeStatusSource),
        hasInterruptedWorkToResume,
        rememberedMode: usageLimitRecoveryMode,
        checkNowSupported: usageLimitRecoveryCheckNowSupported,
        nowMs: usageLimitRecoveryNowMs,
        translate: translateUsageLimitRecovery,
        formatTime: formatUsageLimitRecoveryTime,
    }), [
        formatUsageLimitRecoveryTime,
        sessionRuntimeStatusSource.latestTurnStatus,
        sessionRuntimeStatusSource.latestTurnStatusObservedAt,
        sessionRuntimeStatusSource.lastRuntimeIssue,
        sessionRuntimeStatusSource.meaningfulActivityAt,
        translateUsageLimitRecovery,
        hasInterruptedWorkToResume,
        usageLimitRecovery,
        usageLimitRecoveryCredits,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryFeatureEnabled,
        usageLimitRecoveryMode,
        usageLimitRuntimeState.runtimeActivelyWorking,
        usageLimitRecoveryNowMs,
    ]);
    const usageLimitRecoveryIssueResolved = Boolean(
        resolvedUsageLimitRecoveryIssueFingerprint
        && baseUsageLimitRecoveryPresentation?.issueFingerprint === resolvedUsageLimitRecoveryIssueFingerprint
    );
    React.useEffect(() => {
        if (!resolvedUsageLimitRecoveryIssueFingerprint) return;
        if (baseUsageLimitRecoveryPresentation?.issueFingerprint === resolvedUsageLimitRecoveryIssueFingerprint) return;
        setResolvedUsageLimitRecoveryIssueFingerprint(null);
    }, [baseUsageLimitRecoveryPresentation?.issueFingerprint, resolvedUsageLimitRecoveryIssueFingerprint]);
    const activeUsageLimitRecoveryOperation = usageLimitRecoveryOperationStatus
        && baseUsageLimitRecoveryPresentation?.issueFingerprint === usageLimitRecoveryOperationStatus.issueFingerprint
        ? usageLimitRecoveryOperationStatus
        : null;
    const activeUsageLimitRecoveryOperationStatus = activeUsageLimitRecoveryOperation?.status ?? null;
    const activeUsageLimitRecoveryOperationRetryAtMs = activeUsageLimitRecoveryOperation?.retryAtMs ?? null;
    const usageLimitRecoveryPresentation = React.useMemo(() => buildSessionUsageLimitRecoveryPresentation({
        featureEnabled: usageLimitRecoveryFeatureEnabled && !usageLimitRecoveryIssueResolved,
        latestTurnStatus: sessionRuntimeStatusSource.latestTurnStatus ?? null,
        issue: sessionRuntimeStatusSource.lastRuntimeIssue ?? null,
        recovery: usageLimitRecovery,
        recoveryCredits: usageLimitRecoveryCredits,
        operationStatus: activeUsageLimitRecoveryOperationStatus,
        operationRetryAtMs: activeUsageLimitRecoveryOperationRetryAtMs,
        runtimeWorking: usageLimitRuntimeState.runtimeActivelyWorking,
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(sessionRuntimeStatusSource),
        hasInterruptedWorkToResume,
        rememberedMode: usageLimitRecoveryMode,
        checkNowSupported: usageLimitRecoveryCheckNowSupported,
        nowMs: usageLimitRecoveryNowMs,
        translate: translateUsageLimitRecovery,
        formatTime: formatUsageLimitRecoveryTime,
    }), [
        activeUsageLimitRecoveryOperationRetryAtMs,
        activeUsageLimitRecoveryOperationStatus,
        formatUsageLimitRecoveryTime,
        sessionRuntimeStatusSource.latestTurnStatus,
        sessionRuntimeStatusSource.latestTurnStatusObservedAt,
        sessionRuntimeStatusSource.lastRuntimeIssue,
        sessionRuntimeStatusSource.meaningfulActivityAt,
        translateUsageLimitRecovery,
        hasInterruptedWorkToResume,
        usageLimitRecovery,
        usageLimitRecoveryCredits,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryFeatureEnabled,
        usageLimitRecoveryIssueResolved,
        usageLimitRecoveryMode,
        usageLimitRuntimeState.runtimeActivelyWorking,
        usageLimitRecoveryNowMs,
    ]);
    const visibleUsageLimitRecoveryPresentation = usageLimitRecoveryBanner.collapsed
        ? null
        : usageLimitRecoveryPresentation;
    const usageLimitStatusBadgePresentation = React.useMemo(() => buildSessionUsageLimitStatusBadgePresentation({
        featureEnabled: usageLimitRecoveryFeatureEnabled && !usageLimitRecoveryIssueResolved,
        latestTurnStatus: sessionRuntimeStatusSource.latestTurnStatus ?? null,
        issue: sessionRuntimeStatusSource.lastRuntimeIssue ?? null,
        recovery: usageLimitRecovery,
        operationStatus: activeUsageLimitRecoveryOperationStatus,
        operationRetryAtMs: activeUsageLimitRecoveryOperationRetryAtMs,
        runtimeWorking: usageLimitRuntimeState.runtimeActivelyWorking,
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(sessionRuntimeStatusSource),
        hasInterruptedWorkToResume,
        nowMs: usageLimitRecoveryNowMs,
        translate: translateUsageLimitRecovery,
        formatTime: formatUsageLimitRecoveryTime,
    }), [
        activeUsageLimitRecoveryOperationRetryAtMs,
        activeUsageLimitRecoveryOperationStatus,
        formatUsageLimitRecoveryTime,
        sessionRuntimeStatusSource.latestTurnStatus,
        sessionRuntimeStatusSource.latestTurnStatusObservedAt,
        sessionRuntimeStatusSource.lastRuntimeIssue,
        sessionRuntimeStatusSource.meaningfulActivityAt,
        translateUsageLimitRecovery,
        hasInterruptedWorkToResume,
        usageLimitRecovery,
        usageLimitRecoveryFeatureEnabled,
        usageLimitRecoveryIssueResolved,
        usageLimitRuntimeState.runtimeActivelyWorking,
        usageLimitRecoveryNowMs,
    ]);
    const markUsageLimitRecoveryIssueResolved = React.useCallback(() => {
        const issueFingerprint = usageLimitRecoveryPresentation?.issueFingerprint
            ?? baseUsageLimitRecoveryPresentation?.issueFingerprint
            ?? null;
        if (issueFingerprint) {
            setResolvedUsageLimitRecoveryIssueFingerprint(issueFingerprint);
        }
        setUsageLimitRecoveryOperationStatus(null);
    }, [baseUsageLimitRecoveryPresentation?.issueFingerprint, usageLimitRecoveryPresentation?.issueFingerprint]);
    const markCurrentUsageLimitRecoveryOperationStatus = React.useCallback((
        status: UsageLimitRecoveryOperationStatus,
        options?: Readonly<{ retryAtMs?: number | null }>,
    ) => {
        const issueFingerprint = usageLimitRecoveryPresentation?.issueFingerprint;
        if (!issueFingerprint) return;
        setUsageLimitRecoveryOperationStatus({
            issueFingerprint,
            status,
            ...(typeof options?.retryAtMs === 'number' ? { retryAtMs: options.retryAtMs } : {}),
        });
    }, [usageLimitRecoveryPresentation?.issueFingerprint]);
    const usageLimitRecoveryOperationOptions = React.useMemo(() => ({
        serverId: sessionRouteServerId,
        refreshMachineTargets: () => sync.refreshMachinesThrottled({ staleMs: 0, force: true }),
    }), [sessionRouteServerId]);
    const consumeConnectedServiceRecoveryCreditForProfile = React.useCallback(async (params: Readonly<{
        profileRef: Readonly<{ serviceId: string; profileId: string }>;
        providerCreditId?: string | null;
    }>): Promise<boolean> => {
        const targetMachineId = controlMachineTarget?.machineId ?? (typeof machineId === 'string' ? machineId : null);
        if (!targetMachineId) {
            Modal.alert(t('common.error'), t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return false;
        }
        if (!credentials) {
            Modal.alert(t('common.error'), t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return false;
        }
        const serviceIdResult = ConnectedServiceIdSchema.safeParse(params.profileRef.serviceId);
        if (!serviceIdResult.success) {
            Modal.alert(t('common.error'), t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return false;
        }
        const key = buildQuotaSnapshotScopeKey(credentialScope, serviceIdResult.data, params.profileRef.profileId);
        const result = await consumeQuotaRecoveryCredit(key, {
            credentials,
            credentialScope,
            resolveAccountMode,
            machineId: targetMachineId,
            serverId: sessionRouteServerId,
            serviceId: serviceIdResult.data,
            profileId: params.profileRef.profileId,
            ...(params.providerCreditId
                ? { providerCreditId: params.providerCreditId }
                : {}),
        });
        if (result.ok) {
            const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
            if (noticeKey) await Modal.alert(t('common.info'), t(noticeKey));
            return true;
        }
        Modal.alert(t('common.error'), result.error);
        return false;
    }, [
        controlMachineTarget?.machineId,
        credentialScope,
        credentials,
        machineId,
        resolveAccountMode,
        sessionRouteServerId,
        t,
    ]);
    const staleSessionRunnerMachineId = sessionRunnerRuntimeStatusMachineId;
    const staleSessionRunnerMetadata = React.useMemo(() => {
        const targetMachineId = typeof staleSessionRunnerMachineId === 'string'
            ? staleSessionRunnerMachineId.trim()
            : '';
        const fetchedState = sessionRunnerRuntimeStatus
            && sessionRunnerRuntimeStatus.serverId === sessionRouteServerId
            && sessionRunnerRuntimeStatus.sessionId === sessionId
            && sessionRunnerRuntimeStatus.machineId === targetMachineId
            ? sessionRunnerRuntimeStatus.state
            : null;
        if (!fetchedState) return session.metadata;
        return {
            ...(session.metadata ?? {}),
            [SESSION_RUNNER_RUNTIME_STATE_FIELD_ID]: fetchedState,
        };
    }, [
        session.metadata,
        sessionId,
        sessionRouteServerId,
        sessionRunnerRuntimeStatus,
        staleSessionRunnerMachineId,
    ]);
    const staleSessionRunnerStatus = React.useMemo(() => readActionableStaleSessionRunnerStatus({
        sessionId,
        machineId: staleSessionRunnerMachineId,
        metadata: staleSessionRunnerMetadata,
    }), [
        sessionId,
        staleSessionRunnerMachineId,
        staleSessionRunnerMetadata,
    ]);
    const staleSessionRunnerNoticeResolved = Boolean(
        resolvedStaleSessionRunnerFingerprint
        && staleSessionRunnerStatus?.fingerprint === resolvedStaleSessionRunnerFingerprint
    );
    React.useEffect(() => {
        if (!resolvedStaleSessionRunnerFingerprint) return;
        if (staleSessionRunnerStatus?.fingerprint === resolvedStaleSessionRunnerFingerprint) return;
        setResolvedStaleSessionRunnerFingerprint(null);
    }, [resolvedStaleSessionRunnerFingerprint, staleSessionRunnerStatus?.fingerprint]);
    React.useEffect(() => {
        if (!staleSessionRunnerOperationStatus) return;
        if (staleSessionRunnerOperationStatus.fingerprint === staleSessionRunnerStatus?.fingerprint) return;
        setStaleSessionRunnerOperationStatus(null);
    }, [
        staleSessionRunnerOperationStatus,
        staleSessionRunnerStatus?.fingerprint,
    ]);
    const activeStaleSessionRunnerOperationStatus = staleSessionRunnerOperationStatus
        && staleSessionRunnerStatus?.fingerprint === staleSessionRunnerOperationStatus.fingerprint
        ? { status: staleSessionRunnerOperationStatus.status }
        : null;
    const staleSessionRunnerNoticePresentation = React.useMemo(() => buildStaleSessionRunnerNoticePresentation({
        status: staleSessionRunnerNoticeResolved ? null : staleSessionRunnerStatus,
        operationStatus: activeStaleSessionRunnerOperationStatus,
        translate: translateStaleSessionRunnerNotice,
    }), [
        activeStaleSessionRunnerOperationStatus,
        staleSessionRunnerNoticeResolved,
        staleSessionRunnerStatus,
        translateStaleSessionRunnerNotice,
    ]);
    const visibleStaleSessionRunnerNoticePresentation = staleSessionRunnerBanner.collapsed
        ? null
        : staleSessionRunnerNoticePresentation;
    const handleStaleSessionRunnerRestart = React.useCallback(async () => {
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        if (!staleSessionRunnerStatus) return;
        if (staleSessionRunnerOperationStatus?.status === 'pending') return;

        const fingerprint = staleSessionRunnerStatus.fingerprint;
        setStaleSessionRunnerOperationStatus({ fingerprint, status: 'pending' });
        const result = await restartStaleSessionRunnerWithObserve({
            sessionId: staleSessionRunnerStatus.sessionId,
            machineId: staleSessionRunnerStatus.machineId,
            serverId: sessionRouteServerId,
            expectedRunnerPid: staleSessionRunnerStatus.expectedRunnerPid,
            expectedProcessCommandHash: staleSessionRunnerStatus.expectedProcessCommandHash,
            expectedRunnerEntrypointIdentity: staleSessionRunnerStatus.expectedRunnerEntrypointIdentity,
        });
        const viewStatus = resolveStaleSessionRunnerRestartViewStatus(result);
        setStaleSessionRunnerOperationStatus({ fingerprint, status: viewStatus });

        if (viewStatus === 'restarted' || viewStatus === 'already_current') {
            setResolvedStaleSessionRunnerFingerprint(fingerprint);
            onSessionRunnerRuntimeStatusInvalidated();
            void sync.refreshSessions();
            return;
        }

        Modal.alert(
            t('session.staleRunner.errorTitle'),
            t('session.staleRunner.errorBody'),
        );
    }, [
        hasWriteAccess,
        onSessionRunnerRuntimeStatusInvalidated,
        sessionRouteServerId,
        staleSessionRunnerOperationStatus?.status,
        staleSessionRunnerStatus,
    ]);
    const handleUsageLimitRecoveryAction = React.useCallback(async (kind: SessionUsageLimitRecoveryActionKind) => {
        if (usageLimitRecoveryPendingActionRef.current) return;
        const showUsageLimitRecoveryOperationFailure = (
            result: SessionUsageLimitRecoveryOperationFailureResult,
        ): void => {
            const profileActionRoute = readUsageLimitRecoveryDiagnosticProfileActionRoute(
                result,
                accountProfile?.connectedServicesV2 ?? null,
            );
            const latestForkSessionId = readDiagnosticString(result.uxDiagnostic?.diagnostics, [
                'latestForkSessionId',
                'latestForkId',
                'forkSessionId',
                'childSessionId',
            ]);
            const nativeForkSessionId = readDiagnosticString(result.uxDiagnostic?.diagnostics, [
                'nativeForkSessionId',
                'providerNativeForkSessionId',
                'nativeSessionId',
            ]);
            const diagnosticServerId = readDiagnosticString(result.uxDiagnostic?.diagnostics, [
                'serverId',
                'forkServerId',
            ]);
            const alert = buildSessionUsageLimitRecoveryOperationFailureAlert({
                result,
                fallbackMessage: formatUsageLimitRecoveryOperationError(result),
                translate: t,
                actions: {
                    retry: () => {
                        void handleUsageLimitRecoveryAction(kind);
                    },
                    startFreshUnderSelectedAccount: () => {
                        router.push('/new');
                    },
                    resumeCurrentAccount: () => {},
                    openConnectedAccounts: () => {
                        router.push('/settings/connected-services');
                    },
                    reconnectProfile: () => {
                        if (profileActionRoute) {
                            router.push(profileActionRoute);
                            return;
                        }
                        router.push('/settings/connected-services');
                    },
                    enableStateSharing: () => {
                        router.push('/settings/connected-services/provider-state-sharing');
                    },
                    viewLatestFork: latestForkSessionId
                        ? () => {
                            void navigateToSession(latestForkSessionId, diagnosticServerId ? { serverId: diagnosticServerId } : undefined);
                        }
                        : undefined,
                    viewNativeFork: nativeForkSessionId
                        ? () => {
                            void navigateToSession(nativeForkSessionId, diagnosticServerId ? { serverId: diagnosticServerId } : undefined);
                        }
                        : undefined,
                    dismiss: () => {},
                },
            });
            Modal.alert(alert.title, alert.body, alert.buttons);
        };
        const applyTypedUsageLimitRecoveryFailureStatus = (
            result: Extract<SessionUsageLimitRecoveryOperationResult, { ok: false }>,
        ): boolean => {
            const status = resolveUsageLimitRecoveryStatusFromTypedFailure(result);
            if (!status) return false;
            if (status === 'resolved') {
                markUsageLimitRecoveryIssueResolved();
                return true;
            }
            // Surface probe rate-limit retry timing ("waiting until <time>")
            // instead of an indefinite waiting state.
            const retryAtMs = result.status === 'rate_limited'
                && typeof result.retryAfterMs === 'number'
                && Number.isFinite(result.retryAfterMs)
                && result.retryAfterMs > 0
                ? Date.now() + result.retryAfterMs
                : null;
            markCurrentUsageLimitRecoveryOperationStatus(status, { retryAtMs });
            return true;
        };
        usageLimitRecoveryPendingActionRef.current = true;
        setUsageLimitRecoveryPendingAction(kind);
        try {
            if (kind === 'resume_now') {
                if (usageLimitRecoveryCheckNowSupported) {
                    markCurrentUsageLimitRecoveryOperationStatus('checking');
                    // No per-operation resume-prompt control exists in the session UI, so no
                    // explicit resumePromptMode is sent: the daemon resolves the precedence
                    // (stored intent > account setting > group policy > provider config).
                    const result = await sessionUsageLimitCheckNow(sessionId, {
                        provider: session.lastRuntimeIssue?.provider ?? null,
                        ...usageLimitRecoveryOperationOptions,
                    });
                    if (!result.ok) {
                        setUsageLimitRecoveryOperationStatus(null);
                        if (applyTypedUsageLimitRecoveryFailureStatus(result)) {
                            return;
                        }
                        showUsageLimitRecoveryOperationFailure(result);
                        return;
                    }
                    if (result.status === 'resumed') {
                        markUsageLimitRecoveryIssueResolved();
                        return;
                    }
                    if (result.status === 'ready') {
                        await handleReadyUsageLimitRecoveryResult({
                            sessionActive: session.active === true,
                            resumeInactiveSession: async () => (
                                await handleUsageLimitRecoveryResumeNowRef.current?.({ silent: true }) === true
                            ),
                            markResolved: markUsageLimitRecoveryIssueResolved,
                            markReady: () => markCurrentUsageLimitRecoveryOperationStatus('ready'),
                        });
                        return;
                    }
                    if (result.status === 'waiting') {
                        const issueFingerprint = usageLimitRecoveryPresentation?.issueFingerprint;
                        if (issueFingerprint) {
                            setUsageLimitRecoveryOperationStatus({
                                issueFingerprint,
                                status: result.status,
                            });
                        }
                        return;
                    }
                    if (result.status === 'cancelled') {
                        markUsageLimitRecoveryIssueResolved();
                        return;
                    }
                }

                const resumed = await handleUsageLimitRecoveryResumeNowRef.current?.({ silent: false });
                if (resumed) {
                    markUsageLimitRecoveryIssueResolved();
                }
                return;
            }
            if (kind === 'remember') {
                const result = await sessionUsageLimitWaitResumeEnable(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation?.issueFingerprint,
                    rememberPreference: true,
                }, usageLimitRecoveryOperationOptions);
                if (!result.ok) {
                    if (!applyTypedUsageLimitRecoveryFailureStatus(result)) {
                        showUsageLimitRecoveryOperationFailure(result);
                    }
                } else {
                    setUsageLimitRecoverySettingsV1(updateUsageLimitRecoveryRememberedMode(
                        usageLimitRecoverySettingsV1,
                        'auto_wait',
                    ));
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            if (kind === 'forget') {
                if (!usageLimitRecoveryPresentation) return;
                const result = await sessionUsageLimitWaitResumeCancel(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                    ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                        ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                        : {}),
                }, usageLimitRecoveryOperationOptions);
                if (!result.ok) {
                    if (applyTypedUsageLimitRecoveryFailureStatus(result)) {
                        return;
                    }
                    showUsageLimitRecoveryOperationFailure(result);
                    return;
                }
                setUsageLimitRecoverySettingsV1(updateUsageLimitRecoveryRememberedMode(
                    usageLimitRecoverySettingsV1,
                    'ask',
                ));
                if (result.status === 'cancelled' || result.status === 'resumed' || result.status === 'ready') {
                    markUsageLimitRecoveryIssueResolved();
                } else if (result.status === 'waiting') {
                    markCurrentUsageLimitRecoveryOperationStatus(result.status);
                } else {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }

            if (isUsageLimitRecoveryControlAction(kind)) {
                markCurrentUsageLimitRecoveryOperationStatus('checking');
            }
            if (kind === 'consume_reset_credit' && usageLimitRecoveryQuotaProfileRef && usageLimitRecoveryQuotaProfileKey) {
                const consumed = await consumeConnectedServiceRecoveryCreditForProfile({
                    profileRef: usageLimitRecoveryQuotaProfileRef,
                });
                if (consumed) {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            const result = kind === 'enable'
                ? await sessionUsageLimitWaitResumeEnable(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation?.issueFingerprint,
                    rememberPreference: false,
                }, usageLimitRecoveryOperationOptions)
                : kind === 'cancel'
                    ? usageLimitRecoveryPresentation
                        ? await sessionUsageLimitWaitResumeCancel(sessionId, {
                            issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                            armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                            ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                                ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                                : {}),
                        }, usageLimitRecoveryOperationOptions)
                        : { ok: false as const, error: 'usage_limit_recovery_attempt_identity_required' }
                    : isUsageLimitRecoverySwitchAction(kind)
                        ? await sessionUsageLimitSwitchAccountNow(sessionId, {
                            provider: session.lastRuntimeIssue?.provider ?? null,
                            ...usageLimitRecoveryOperationOptions,
                        })
                        : kind === 'consume_reset_credit'
                            ? await sessionUsageLimitConsumeResetCredit(sessionId, {
                                provider: session.lastRuntimeIssue?.provider ?? null,
                                ...usageLimitRecoveryOperationOptions,
                            })
                            : await sessionUsageLimitCheckNow(sessionId, {
                            provider: session.lastRuntimeIssue?.provider ?? null,
                            ...usageLimitRecoveryOperationOptions,
                            });
            if (!result.ok) {
                if (isUsageLimitRecoveryControlAction(kind)) {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                if (applyTypedUsageLimitRecoveryFailureStatus(result)) {
                    return;
                }
                showUsageLimitRecoveryOperationFailure(result);
                return;
            }
            if (isUsageLimitRecoveryControlAction(kind) && result.status && usageLimitRecoveryPresentation?.issueFingerprint) {
                if (result.status === 'resumed' || result.status === 'ready' || result.status === 'cancelled') {
                    markUsageLimitRecoveryIssueResolved();
                    return;
                }
                setUsageLimitRecoveryOperationStatus({
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    status: result.status,
                });
            } else if (kind === 'enable' || kind === 'cancel') {
                setUsageLimitRecoveryOperationStatus(null);
            }
        } finally {
            usageLimitRecoveryPendingActionRef.current = false;
            setUsageLimitRecoveryPendingAction(null);
        }
    }, [
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        accountProfile?.connectedServicesV2,
        consumeConnectedServiceRecoveryCreditForProfile,
        navigateToSession,
        session.active,
        session.lastRuntimeIssue?.provider,
        sessionId,
        setUsageLimitRecoverySettingsV1,
        router,
        usageLimitRecoveryOperationOptions,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryQuotaProfileKey,
        usageLimitRecoveryQuotaProfileRef,
        usageLimitRecoveryQuotaSnapshot?.fetchedAt,
        usageLimitRecoveryPresentation?.issueFingerprint,
        usageLimitRecoveryResumePromptMode,
    ]);
    // --- Armed-switch outcome: automatic reconciliation from canonical facts ---
    //
    // An `outcome_unknown` is the only arm the daemon could not establish, and it
    // is the only one worth re-deciding here. Reconciliation reads canonical
    // Session and message truth through the owners that already publish it — no
    // status operation of its own, no polling, and no Check-status control handed
    // to the reader — then feeds those facts back through the SAME disposition
    // owner that decided the daemon's answer.
    //
    // Outcomes are mount-local presentation, but still belong to the same
    // account/server scope as the arm that produced them. Do not project a
    // stale scope's notice or custody key while a scope switch settles.
    const activeArmedContinuationOutcome = armedContinuationOutcome?.scopeKey === activeServerAccountScopeKey
        ? armedContinuationOutcome
        : null;
    React.useEffect(() => {
        setArmedContinuationOutcome((current) => {
            if (current === null || current.scopeKey !== activeServerAccountScopeKey) return null;
            return current.kind === 'outcome' && current.sessionId !== sessionId ? null : current;
        });
    }, [activeServerAccountScopeKey, sessionId]);
    const armedContinuationAwaitingReconcile = activeArmedContinuationOutcome?.kind === 'outcome'
        && activeArmedContinuationOutcome.result.type === 'outcome_unknown'
        && !activeArmedContinuationOutcome.reconciled;
    React.useEffect(() => {
        if (!armedContinuationAwaitingReconcile) return;
        let cancelled = false;
        // A refused refresh settles the window too. The composer is held only for
        // the length of the attempt: staying blocked forever on a fact that may
        // never arrive would be a worse failure than the notice this leaves up.
        void Promise.allSettled([
            sync.ensureSessionVisibleForMessageRoute(sessionId, {
                forceRefresh: true,
                ...(sessionRouteServerId ? { serverId: sessionRouteServerId } : {}),
            }),
            sync.refreshSessionMessages(sessionId),
        ]).then(() => {
            if (cancelled) return;
            setArmedContinuationOutcome((current) => (
                current?.kind === 'outcome'
                    && current.scopeKey === activeServerAccountScopeKey
                    && current.sessionId === sessionId
                    && !current.reconciled
                    ? { ...current, reconciled: true }
                    : current
            ));
        });
        return () => { cancelled = true; };
    }, [activeServerAccountScopeKey, armedContinuationAwaitingReconcile, sessionId, sessionRouteServerId]);

    // `sessionRuntimeStatusSource` is the same live runtime-status owner
    // `isSessionActive` reads further down; this is not a second interpretation
    // of it, just an earlier read of the one source.
    //
    // Canonical custody of the submitted localId is SUBSCRIBED here rather than
    // sampled inside the memo below. Both facts it reads — the pending row and
    // the transcript row — land AFTER the transition call returns, so a
    // disposition memoized on the outcome and the liveness flag alone is decided
    // while custody is still `absent` and is never re-decided when it arrives.
    // That is how the one arm that ends with the reader's message queued behind
    // no runtime reached a real Session and said nothing at all.
    //
    // Selected down to the tri-state so the store's own equality check keeps a
    // per-row transcript update off this render path, and short-circuited to
    // `absent` while no armed outcome exists so a Session with no switch in
    // flight pays nothing for it.
    const armedContinuationInputLocalId = activeArmedContinuationOutcome?.kind === 'outcome'
        ? activeArmedContinuationOutcome.localId
        : null;
    const armedContinuationInputCustody = storage(
        React.useCallback(
            (state: StorageState) => selectCanonicalOutboundHandoffForLocalId(
                state,
                sessionId,
                armedContinuationInputLocalId,
            ),
            [armedContinuationInputLocalId, sessionId],
        ),
    );
    const armedContinuationDisposition = React.useMemo(() => {
        if (activeArmedContinuationOutcome === null) return null;
        if (activeArmedContinuationOutcome.kind === 'refusal') return null;
        // A definite arm is the daemon's own account of what it just did, so the
        // Session view beside it is trustworthy. An indeterminate one usually
        // means the transport failed, which is exactly when the local view is
        // suspect — so those facts are withheld until reconciliation refreshed
        // them.
        const factsAreReadable = activeArmedContinuationOutcome.result.type !== 'outcome_unknown'
            || activeArmedContinuationOutcome.reconciled;
        const facts: ArmedAgentContinuationCanonicalFacts | null = factsAreReadable
            ? {
                currentAgentId: liveComposerState.agentId,
                sessionActive: sessionRuntimeStatusSource.active === true,
                input: armedContinuationInputCustody,
            }
            : null;
        return reconcileArmedAgentContinuationDisposition({
            result: activeArmedContinuationOutcome.result,
            labels: activeArmedContinuationOutcome.labels,
            targetAgentId: activeArmedContinuationOutcome.intent.selection.agentId,
            facts,
        });
    }, [
        armedContinuationInputCustody,
        activeArmedContinuationOutcome,
        liveComposerState.agentId,
        sessionRuntimeStatusSource.active,
    ]);
    // Memoized because it feeds the composer badge list: a fresh object every
    // render would invalidate that memo on every turn commit for a banner that
    // changes about twice in a Session's life.
    const armedContinuationNotice = React.useMemo<ArmedAgentContinuationNotice | null>(() => (
        activeArmedContinuationOutcome?.kind === 'refusal'
            ? { tone: 'warning', message: activeArmedContinuationOutcome.message, recovery: 'none' }
            : armedContinuationDisposition?.notice ?? null
    ), [activeArmedContinuationOutcome, armedContinuationDisposition]);
    // The composer's own gate, owned by the send-destination resolver.
    const pendingTransitionOutcome = armedContinuationDisposition?.send === 'block'
        ? 'unreconciled'
        : 'settled';
    const sessionStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        const usageBadge = usageLimitStatusBadgePresentation
            ? [{
                ...usageLimitStatusBadgePresentation,
                ...buildComposerBannerBadgeAccessibility({
                    statusLabel: usageLimitStatusBadgePresentation.label,
                    collapsed: usageLimitRecoveryBanner.collapsed,
                    expandHint: t('session.usageLimitRecovery.showBannerAction'),
                    collapseHint: t('session.usageLimitRecovery.hideBannerAction'),
                }),
                icon: (tint: string) => <Icon name="timer" size={14} color={tint} />,
                onPress: usageLimitRecoveryBanner.toggle,
            } satisfies AgentInputStatusBadge]
            : [];
        const staleRunnerBadge = staleSessionRunnerNoticePresentation
            ? [{
                ...staleSessionRunnerNoticePresentation.badge,
                ...buildComposerBannerBadgeAccessibility({
                    statusLabel: staleSessionRunnerNoticePresentation.badge.label,
                    collapsed: staleSessionRunnerBanner.collapsed,
                    expandHint: t('session.staleRunner.showBannerAction'),
                    collapseHint: t('session.staleRunner.hideBannerAction'),
                }),
                icon: (tint: string) => <Icon name="arrows-clockwise" size={14} color={tint} />,
                onPress: staleSessionRunnerBanner.toggle,
            } satisfies AgentInputStatusBadge]
            : [];
        const authRecoveryBadge = authSurfaceState
            ? [{
                key: 'session-auth-recovery',
                testID: 'session.authRecovery.badge',
                label: t('connect.restoreAccount'),
                tone: 'warning',
                ...buildComposerBannerBadgeAccessibility({
                    statusLabel: t('connect.restoreAccount'),
                    collapsed: authRecoveryBanner.collapsed,
                    expandHint: t('session.composerBanners.showBannerAction'),
                    collapseHint: t('session.composerBanners.hideBannerAction'),
                }),
                icon: (tint: string) => <Icon name="key" size={14} color={tint} />,
                onPress: authRecoveryBanner.toggle,
            } satisfies AgentInputStatusBadge]
            : [];
        const pendingQueueBadge = pendingQueueResumeFailed
            ? [{
                key: 'session-pendingQueue-resumeFailed',
                testID: 'session.pendingQueueResumeFailed.badge',
                label: t('session.pendingQueuedResumeFailedTitle'),
                tone: 'warning',
                ...buildComposerBannerBadgeAccessibility({
                    statusLabel: t('session.pendingQueuedResumeFailedTitle'),
                    collapsed: pendingQueueResumeFailedBanner.collapsed,
                    expandHint: t('session.composerBanners.showBannerAction'),
                    collapseHint: t('session.composerBanners.hideBannerAction'),
                }),
                icon: (tint: string) => <Icon name="warning-circle" size={14} color={tint} />,
                onPress: pendingQueueResumeFailedBanner.toggle,
            } satisfies AgentInputStatusBadge]
            : [];
        const agentTransitionOutcomeBadge = armedContinuationNotice
            ? [{
                key: 'session-agentTransition-outcome',
                testID: 'session.agentTransitionOutcome.badge',
                label: t('session.agentContinuation.transition.badgeLabel'),
                tone: armedContinuationNotice.tone === 'warning' ? 'warning' : 'neutral',
                ...buildComposerBannerBadgeAccessibility({
                    // Collapsing demotes the banner to this badge, so the badge has
                    // to carry the whole sentence to assistive tech.
                    statusLabel: armedContinuationNotice.message,
                    collapsed: agentTransitionOutcomeBanner.collapsed,
                    expandHint: t('session.composerBanners.showBannerAction'),
                    collapseHint: t('session.composerBanners.hideBannerAction'),
                }),
                icon: (tint: string) => (
                    <Icon
                        name={armedContinuationNotice.tone === 'warning' ? 'warning-circle' : 'info'}
                        size={14}
                        color={tint}
                    />
                ),
                onPress: agentTransitionOutcomeBanner.toggle,
            } satisfies AgentInputStatusBadge]
            : [];
        return [
            ...usageBadge,
            ...staleRunnerBadge,
            ...authRecoveryBadge,
            ...pendingQueueBadge,
            ...agentTransitionOutcomeBadge,
            ...sessionWorkStateBadges,
        ];
    }, [
        agentTransitionOutcomeBanner.collapsed,
        agentTransitionOutcomeBanner.toggle,
        armedContinuationNotice,
        authRecoveryBanner.collapsed,
        authRecoveryBanner.toggle,
        authSurfaceState,
        pendingQueueResumeFailed,
        pendingQueueResumeFailedBanner.collapsed,
        pendingQueueResumeFailedBanner.toggle,
        sessionWorkStateBadges,
        staleSessionRunnerBanner.collapsed,
        staleSessionRunnerBanner.toggle,
        staleSessionRunnerNoticePresentation,
        t,
        usageLimitRecoveryBanner.collapsed,
        usageLimitRecoveryBanner.toggle,
        usageLimitStatusBadgePresentation,
    ]);
    React.useEffect(() => {
        // The tally, not a boolean this host derives: `counts.live > 0` here was a SECOND answer to
        // the question the chip above already answers, and on a run whose named agents have all
        // finished the two disagreed — this effect closed the open work-state popover while the chip
        // stayed on screen naming the workflow (FIX-F1).
        if (shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey,
            hasPrimaryWorkStateItem: Boolean(primaryWorkStateItem),
            canShowEmptyGoalControls: canEditSessionGoals,
            agentActivityCounts,
        })) return;
        setActiveStatusBadgeKey(null);
    }, [activeStatusBadgeKey, agentActivityCounts, canEditSessionGoals, primaryWorkStateItem]);
    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(session.metadata ?? null);
    const isHiddenSystemSessionSession = isHiddenSystemSession({ metadata: session.metadata ?? null });
    const modelMode = liveComposerState.modelMode;
    const sessionConfigOptionOverrides = React.useMemo<React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride']>(() => {
        return readSessionConfigOptionOverridesState(session.metadata ?? null);
    }, [session.metadata]);
    const [optimisticSessionConfigOptionOverrides, setOptimisticSessionConfigOptionOverrides] =
        React.useState<React.ComponentProps<typeof AgentInput>['acpConfigOptionOverridesOverride']>(
            sessionConfigOptionOverrides,
        );
    const optimisticSessionConfigOptionOverridesSessionIdRef = React.useRef(sessionId);
    React.useEffect(() => {
        setOptimisticSessionConfigOptionOverrides((current) => {
            const sessionChanged = optimisticSessionConfigOptionOverridesSessionIdRef.current !== sessionId;
            optimisticSessionConfigOptionOverridesSessionIdRef.current = sessionId;
            return resolveNextOptimisticAcpConfigOptionOverrides({
                current,
                incoming: sessionConfigOptionOverrides,
                sessionChanged,
            }) as typeof current;
        });
    }, [sessionConfigOptionOverrides, sessionId]);
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
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads', {
        scopeKind: 'spawn',
        serverId: capabilityServerId,
    });
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(sessionId);
    const attachmentsUploadsEnabled = attachmentsUploadsFeatureEnabled && attachmentsUploadsTransferAvailable;
    const sessionProviderUsageGaugeMode = useSetting('sessionProviderUsageGaugeMode');
    const sessionProviderUsageGaugeWindowModeSetting = useSetting('sessionProviderUsageGaugeWindowMode');
    const sessionProviderUsageGaugeWindowMode: ConnectedServiceQuotaGaugeWindowMode =
        sessionProviderUsageGaugeWindowModeSetting === 'daily'
        || sessionProviderUsageGaugeWindowModeSetting === 'weekly'
        || sessionProviderUsageGaugeWindowModeSetting === 'primary'
        || sessionProviderUsageGaugeWindowModeSetting === 'secondary'
        || sessionProviderUsageGaugeWindowModeSetting === 'session'
            ? sessionProviderUsageGaugeWindowModeSetting
            : 'most_constrained';
    const connectedServiceQuotaProfileRef = React.useMemo(() => (
        resolveConnectedServiceQuotaProfileRefForSession({
            metadata: session.metadata,
            agentId: liveComposerState.agentId,
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
        })
    ), [accountProfile?.connectedServicesV2, liveComposerState.agentId, session.metadata]);
    const sessionAgentCatalogEntries = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }), [enabledAgentIds, settings.acpCatalogSettingsV1, settings.backendEnabledByTargetKey]);
    const sessionAgentCurrentTargetKey = React.useMemo(() => buildBackendTargetKey(
        sessionActionDefaultBackend?.backendTarget
        ?? { kind: 'builtInAgent', agentId: liveComposerState.agentId },
    ), [liveComposerState.agentId, sessionActionDefaultBackend?.backendTarget]);
    const sessionMachineRecord = useMachine(typeof machineId === 'string' ? machineId : '');
    // Each successful connect stamps a new value, which is exactly the lifetime a
    // continuation inspection may be trusted for.
    const socketConnectionGeneration = useSocketStatus().lastConnectedAt;
    const agentContinuationSource = React.useMemo(() => ({
        currentBackendTargetKey: sessionAgentCurrentTargetKey,
        // Whether THIS Session's transcript is Happier's or its Agent's own, from
        // the canonical Session-scoped owner. The Agent-level `sessionStorage.direct`
        // capability is a different question — Claude Code and Codex both declare it
        // — so reading it here would block every ordinary Session.
        storageKind: getSessionStorageKind(session),
        canEditSession: hasWriteAccess,
        machinePresence: sessionMachineRecord
            ? (isMachineOnline(sessionMachineRecord) ? 'online' as const : 'offline' as const)
            : 'unknown' as const,
        // The Session's transcript sequence, which only a written transcript
        // record advances. Zero is therefore the one state in which a switch
        // provably carries nothing — and it is read from the Session row the
        // screen already holds rather than from a transcript page that may not
        // be loaded.
        hasConversationToCarry: session.seq > 0,
    }), [hasWriteAccess, session, sessionAgentCurrentTargetKey, sessionMachineRecord]);
    // `session.continuation.inspect` is answered by the machine hosting the
    // Session, so an answer only holds for as long as BOTH runtimes behind it do:
    // this realtime connection, and the daemon that answered. A daemon that
    // restarts leaves the socket untouched, so its own generation — the machine
    // record's daemon-state version, the same currentness fact CLI detection keys
    // on — has to be part of the scope or the rail keeps offering targets the
    // send path already refuses.
    const agentContinuationMachine = React.useMemo(() => ({
        machineId: typeof machineId === 'string' && machineId.length > 0 ? machineId : null,
        serverId: sessionRouteServerId,
        connectionGeneration: socketConnectionGeneration,
        daemonGeneration: sessionMachineRecord?.daemonStateVersion ?? null,
    }), [machineId, sessionMachineRecord?.daemonStateVersion, sessionRouteServerId, socketConnectionGeneration]);
    // What a target Agent's own model/mode/config detail resolves against. Same
    // machine, server and folder as this Session, so the models offered for the
    // target are the models it would actually run with here.
    const agentContinuationTargetDetail = React.useMemo(() => ({
        settings,
        capabilityServerId,
        machineId: typeof machineId === 'string' && machineId.length > 0 ? machineId : null,
        cwd: (session.metadata?.path as string | undefined) ?? null,
        profileId: liveComposerState.profileId ?? null,
    }), [capabilityServerId, liveComposerState.profileId, machineId, session.metadata?.path, settings]);
    const currentAgentLabel = t(getAgentCore(liveComposerState.agentId).displayNameKey);
    // `sessions.agentSwitching` is server-represented and fails closed. The
    // canonical decision runtime reads the server bit as
    // `readServerEnabledBit(...) === true` and applies the catalog's dependency
    // closure, so this is the gate — not a second interpretation beside it. It is
    // read once, here, and handed to the one owner that can arm a switch.
    //
    // Scoped to THIS Session's server, not the sidebar's selection. The switch
    // runs on the Session's machine against its own server, and neither the
    // daemon nor the server re-gates the transition, so this decision's scope is
    // the whole gate: an aggregate over other selected servers would let an
    // unrelated server's setting decide whether this Session may switch Agent.
    const agentSwitchingDecision = useFeatureDecision('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: capabilityServerId,
    });
    // Read here rather than beside the composer's other draft work because the
    // armed Agent is a Session draft value like the rest, and the picker below is
    // the one owner that writes it.
    const inSessionAgentPicker = useInSessionAgentPickerControls({
        sessionId,
        accountScope: activeServerAccountScope,
        currentAgentId: liveComposerState.agentId,
        currentAgentLabel,
        currentAgentSessionActive: session.active,
        entries: sessionAgentCatalogEntries,
        favoriteBackendTargetKeys: settings.favoriteBackendTargetKeysV1,
        featureDecision: agentSwitchingDecision,
        source: agentContinuationSource,
        machine: agentContinuationMachine,
        detail: agentContinuationTargetDetail,
    });
    // The armed target, resolved once against the same catalog the rail offered
    // it from. The send control names it and the send path carries it, so both
    // read one value rather than each deriving its own label.
    const armedContinuationTarget = React.useMemo(() => {
        const intent = inSessionAgentPicker.armedContinuation;
        if (intent === null) return null;
        const entry = sessionAgentCatalogEntries.find((catalogEntry) => (
            catalogEntry.providerAgentId === intent.selection.agentId
        ));
        return {
            agentId: intent.selection.agentId,
            label: entry?.title ?? intent.selection.agentId,
            // The picker's own words for the chosen model, so the composer's engine
            // chip names it exactly as the row the reader just tapped did.
            modelLabel: inSessionAgentPicker.armedContinuationModelLabel,
        };
    }, [
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.armedContinuationModelLabel,
        sessionAgentCatalogEntries,
    ]);
    // The words the banner uses, resolved from the submitted intent through the
    // same catalog the rail offered the target from. One helper, so a restored
    // outcome names its Agent exactly as the send that created it did — and so
    // nothing presentational has to be persisted and later read back in a
    // language the reader has since changed.
    const buildArmedContinuationLabels = React.useCallback((
        targetAgentId: string,
    ): ArmedAgentContinuationLabels => ({
        sourceAgentLabel: currentAgentLabel,
        targetAgentLabel: sessionAgentCatalogEntries.find((catalogEntry) => (
            catalogEntry.providerAgentId === targetAgentId
        ))?.title ?? targetAgentId,
    }), [currentAgentLabel, sessionAgentCatalogEntries]);
    const restoredArmedContinuationOutcomeKeyRef = React.useRef<string | null>(null);
    React.useLayoutEffect(() => {
        const intent = inSessionAgentPicker.armedContinuation
            ?? inSessionAgentPicker.armedContinuationSubmissionIntent;
        const submission = inSessionAgentPicker.armedContinuationSubmission;
        const localId = inSessionAgentPicker.armedContinuationLocalId ?? submission?.localId ?? null;
        if (intent === null || !submission || localId !== submission.localId) {
            restoredArmedContinuationOutcomeKeyRef.current = null;
            return;
        }
        // A nested submission proves a transition left this mount, but carries no
        // daemon result to replay. Establish the same mount-local unknown outcome
        // the RPC path records before this composer can accept input, so the
        // existing disposition/reconciliation owner holds sends until canonical
        // custody has been read.
        const key = `${activeServerAccountScopeKey}\u0000${sessionId}\u0000${submission.localId}`;
        const outcome = armedContinuationOutcome;
        const outcomeIsCurrent = outcome !== null
            && outcome.scopeKey === activeServerAccountScopeKey
            && (outcome.kind === 'refusal' || outcome.sessionId === sessionId);
        if (outcomeIsCurrent || restoredArmedContinuationOutcomeKeyRef.current === key) return;
        restoredArmedContinuationOutcomeKeyRef.current = key;
        setArmedContinuationOutcome({
            kind: 'outcome',
            sessionId,
            scopeKey: activeServerAccountScopeKey,
            result: { type: 'outcome_unknown', localId: submission.localId },
            intent,
            labels: buildArmedContinuationLabels(intent.selection.agentId),
            localId: submission.localId,
            reconciled: false,
        });
    }, [
        activeServerAccountScopeKey,
        armedContinuationOutcome,
        buildArmedContinuationLabels,
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.armedContinuationLocalId,
        inSessionAgentPicker.armedContinuationSubmission,
        inSessionAgentPicker.armedContinuationSubmissionIntent,
        sessionId,
    ]);

    const connectedServiceQuotaProfileCredentialUsable = React.useMemo(() => {
        if (connectedServiceQuotaProfileRef?.credentialHealthStatus === undefined) return true;
        return isConnectedServiceCredentialHealthStatusUsable(
            resolveConnectedServiceCredentialHealthStatus(connectedServiceQuotaProfileRef.credentialHealthStatus),
        );
    }, [connectedServiceQuotaProfileRef?.credentialHealthStatus]);
    const connectedServiceQuotaSnapshots = useConnectedServiceQuotaSnapshots(
        connectedServiceQuotaProfileRef ? [connectedServiceQuotaProfileRef] : [],
    );
    const connectedServiceQuotaProfileKey = connectedServiceQuotaProfileRef
        ? connectedServiceProfileKey(connectedServiceQuotaProfileRef)
        : null;
    const connectedServiceQuotaSnapshot = connectedServiceQuotaProfileKey
        ? connectedServiceQuotaSnapshots.snapshotsByKey[connectedServiceQuotaProfileKey] ?? null
        : null;
    const providerAccountUsageRecordIds = React.useMemo(
        () => readProviderAccountUsageRecordIdsFromMetadata(session.metadata),
        [session.metadata],
    );
    const providerAccountUsageSnapshotsByRecordId = useProviderAccountUsageSnapshots(providerAccountUsageRecordIds);
    const connectedServiceQuotaActiveAccountLabel = React.useMemo(() => {
        if (!connectedServiceQuotaProfileRef) return connectedServiceQuotaSnapshot?.accountLabel ?? null;
        return resolveConnectedServiceProfileLabel({
            labelsByKey: settings.connectedServicesProfileLabelByKey,
            serviceId: connectedServiceQuotaProfileRef.serviceId,
            profileId: connectedServiceQuotaProfileRef.profileId,
        }) ?? connectedServiceQuotaSnapshot?.accountLabel ?? connectedServiceQuotaProfileRef.profileId;
    }, [
        connectedServiceQuotaProfileRef,
        connectedServiceQuotaSnapshot?.accountLabel,
        settings.connectedServicesProfileLabelByKey,
    ]);
    const providerUsageDisplaySnapshotSource = React.useMemo(() => (
        selectProviderUsageDisplaySnapshot({
            providerId: liveComposerState.agentId,
            metadataRecordIds: providerAccountUsageRecordIds,
            accountUsageSnapshotsByRecordId: providerAccountUsageSnapshotsByRecordId,
            connectedServiceProfileRef: connectedServiceQuotaProfileRef,
            connectedServiceQuotaView: connectedServiceQuotaSnapshot,
        })
    ), [
        connectedServiceQuotaProfileRef,
        connectedServiceQuotaSnapshot,
        liveComposerState.agentId,
        providerAccountUsageRecordIds,
        providerAccountUsageSnapshotsByRecordId,
    ]);
    const providerUsageGaugeSource = React.useMemo(() => {
        if (!connectedServiceQuotasEnabled || sessionProviderUsageGaugeMode === 'hidden') return null;
        if (!connectedServiceQuotaProfileCredentialUsable) return null;
        return selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: liveComposerState.agentId,
            connectedServiceSnapshot: providerUsageDisplaySnapshotSource?.snapshot ?? null,
            connectedServiceRefProvenance: providerUsageDisplaySnapshotSource?.connectedServiceRefProvenance ?? null,
            sessionCheckNowSupported: usageLimitRecoveryCheckNowSupported,
            recoveryCredits: usageLimitRecoveryCredits,
            runtimeIssue: session.lastRuntimeIssue ?? null,
        });
    }, [
        connectedServiceQuotasEnabled,
        connectedServiceQuotaProfileCredentialUsable,
        liveComposerState.agentId,
        providerUsageDisplaySnapshotSource,
        session.lastRuntimeIssue,
        sessionProviderUsageGaugeMode,
        usageLimitRecoveryCredits,
        usageLimitRecoveryCheckNowSupported,
    ]);
    const providerUsageGauge = React.useMemo(() => {
        const gaugeSource = providerUsageGaugeSource;
        if (!gaugeSource) return null;
        return computeConnectedServiceQuotaGaugeViewModel({
            snapshot: gaugeSource.snapshot,
            windowMode: sessionProviderUsageGaugeWindowMode,
            nowMs: nowServerMs(),
            formatter: connectedServiceQuotaGaugeFormatter,
            providerDisplayName: resolveConnectedServiceProviderDisplayName(gaugeSource.snapshot.serviceId),
            activeAccountDisplayLabel: providerUsageDisplaySnapshotSource?.kind === 'connected_service_quota_view'
                && gaugeSource.snapshot === connectedServiceQuotaSnapshot
                ? connectedServiceQuotaActiveAccountLabel
                : gaugeSource.snapshot.accountLabel ?? null,
        });
    }, [
        connectedServiceQuotaActiveAccountLabel,
        connectedServiceQuotaSnapshot,
        providerUsageDisplaySnapshotSource?.kind,
        providerUsageGaugeSource,
        sessionProviderUsageGaugeWindowMode,
    ]);
    const providerUsageGaugeConnectedServiceProfileRef =
        providerUsageGaugeSource
        && isConnectedServiceBoundProviderUsageDisplaySource(providerUsageDisplaySnapshotSource)
            ? connectedServiceQuotaProfileRef
            : null;
    const [providerUsageRecoveryCreditPending, setProviderUsageRecoveryCreditPending] = React.useState(false);
    const handleProviderUsageRecoveryCreditPress = React.useCallback(async () => {
        if (providerUsageRecoveryCreditPending) return;
        if (!providerUsageGauge?.recoveryCreditSummary) return;
        if (providerUsageGaugeConnectedServiceProfileRef && connectedServiceQuotaProfileKey) {
            setProviderUsageRecoveryCreditPending(true);
            try {
                await consumeConnectedServiceRecoveryCreditForProfile({
                    profileRef: providerUsageGaugeConnectedServiceProfileRef,
                });
            } finally {
                setProviderUsageRecoveryCreditPending(false);
            }
            return;
        }

        if (usageLimitRecoveryCheckNowSupported) {
            await handleUsageLimitRecoveryAction('consume_reset_credit');
        }
    }, [
        connectedServiceQuotaProfileKey,
        consumeConnectedServiceRecoveryCreditForProfile,
        handleUsageLimitRecoveryAction,
        providerUsageGaugeConnectedServiceProfileRef,
        providerUsageGauge?.recoveryCreditSummary,
        providerUsageGaugeSource?.snapshot.fetchedAt,
        providerUsageRecoveryCreditPending,
        usageLimitRecoveryCheckNowSupported,
    ]);
    const providerUsageRecoveryCreditAction = providerUsageGauge?.recoveryCreditSummary
        && (providerUsageGaugeConnectedServiceProfileRef || usageLimitRecoveryCheckNowSupported)
        ? handleProviderUsageRecoveryCreditPress
        : undefined;
    const providerUsageRecoveryCreditActionPending = providerUsageRecoveryCreditPending
        || usageLimitRecoveryPendingAction === 'consume_reset_credit';
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
    const initialSessionAttachmentDrafts = React.useMemo(() => {
        if (initialAttachmentDrafts && initialAttachmentDrafts.length > 0) {
            return initialAttachmentDrafts;
        }
        return readSessionAttachmentDrafts(sessionId);
    }, [initialAttachmentDrafts, sessionId]);

    const attachmentDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsEnabled,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
        initialDrafts: initialSessionAttachmentDrafts,
    });
    const filePickerRef = attachmentDraftManager.filePickerRef;
    const attachmentDrafts = attachmentDraftManager.drafts;
    const attachmentDraftsSnapshotRef = React.useRef<readonly AttachmentDraft[]>(initialSessionAttachmentDrafts);
    const agentInputAttachments = attachmentDraftManager.agentInputAttachments;
    const patchAttachmentDraft = attachmentDraftManager.applyDraftPatch;
    const replaceAttachmentManagerDrafts = attachmentDraftManager.replaceDrafts;

    React.useEffect(() => {
        attachmentDraftsSnapshotRef.current = attachmentDrafts;
        writeSessionAttachmentDrafts(sessionId, attachmentDrafts);
    }, [attachmentDrafts, sessionId]);

    // Depend on the stable callback, not the manager object: this callback feeds the
    // transcript onEditPendingMessage chain, whose identity gates row re-renders.
    const replaceSessionAttachmentDrafts = React.useCallback((drafts: readonly AttachmentDraft[]) => {
        attachmentDraftsSnapshotRef.current = drafts;
        writeSessionAttachmentDrafts(sessionId, drafts);
        replaceAttachmentManagerDrafts(drafts);
    }, [replaceAttachmentManagerDrafts, sessionId]);

    const applySessionAttachmentDraftPatch = React.useCallback((
        id: string,
        patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>,
    ) => {
        patchAttachmentDraft(id, patch);
        const nextDrafts = attachmentDraftsSnapshotRef.current.map((draft) => (
            draft.id === id ? ({ ...draft, ...patch } as AttachmentDraft) : draft
        ));
        attachmentDraftsSnapshotRef.current = nextDrafts;
        writeSessionAttachmentDrafts(sessionId, nextDrafts);
    }, [patchAttachmentDraft, sessionId]);
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
    const [isComposerSendPending, setIsComposerSendPending] = React.useState(false);
    const recipientState = useSessionRecipientState({
        targets: participantTargets,
        autoRecipient: null,
        draftPersistence: {
            sessionId,
            surface: 'mainComposer',
        },
    });

    useScmSessionAutoRefresh({ sessionId, intervalMs: scmSessionAutoRefreshIntervalMs });

    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            // The route's own server is the fallback the canonical navigator cannot know about: a
            // child session absent from every list cache still belongs to the server we are on.
            openSession: (sid) => navigateToSession(sid, {
                serverId: resolveServerIdForSessionIdFromLocalCache(sid) ?? sessionRouteServerId,
            }),
        }),
        [navigateToSession, sessionRouteServerId]
    );

    // Inactive session resume state
    // Runtime status is read from the live store subscription rather than the retained shell
    // snapshot, so composer availability follows the latest server/session projection.
    const isSessionActive = sessionRuntimeStatusSource.active === true;
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

    // QA A-F5: a provider session that never started (no vendor resume id persisted)
    // is continuable by a fresh spawn; it must not hit the "doesn't support restoring
    // context" dead-end.
    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)
        || canContinueSessionWithFreshSpawn(session.metadata, resumeCapabilityOptions);
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
    const {
        clearDraft,
        clearDraftForSessionIfCurrentValueMatches,
        restoreDraftForSessionIfCurrentValueMatches,
        setDraftValue,
        restoreDraft,
        restoreComposerSnapshot,
    } = useDraft(sessionId, message, setMessage);
    const messageRef = React.useRef(message);
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);
    const [pendingMessageEdit, setPendingMessageEdit] = React.useState<PendingMessageComposerEditState | null>(null);
    const pendingMessageEditRef = React.useRef(pendingMessageEdit);
    React.useEffect(() => {
        pendingMessageEditRef.current = pendingMessageEdit;
    }, [pendingMessageEdit]);
    const inputComposerClearTransientStateRef = React.useRef<() => void>(noopInputComposerClearTransientState);
    const inputComposerCaptureTransientStateRef = React.useRef<() => AgentInputLocalUiStateV1 | null>(
        noopInputComposerCaptureTransientState,
    );
    const inputComposerRestoreTransientStateRef = React.useRef<(state: AgentInputLocalUiStateV1 | null) => void>(
        noopInputComposerRestoreTransientState,
    );
    const captureComposerSemanticDraftSnapshot = React.useCallback((): ComposerSemanticDraftSnapshot => ({
        recipient: readSessionDraftValue(activeServerAccountScope, sessionId, 'routing.recipient'),
        executionRunDelivery: readSessionDraftValue(activeServerAccountScope, sessionId, 'routing.executionRunDelivery'),
        structuredInputMentions: readSessionDraftValue(activeServerAccountScope, sessionId, 'structuredInput.mentions'),
    }), [activeServerAccountScope, sessionId]);
    const isComposerSemanticDraftSnapshotCurrent = React.useCallback((snapshot: ComposerSemanticDraftSnapshot) => {
        const current = captureComposerSemanticDraftSnapshot();
        return areSemanticDraftValuesEqual(current, snapshot);
    }, [captureComposerSemanticDraftSnapshot]);
    const clearSemanticDraftValuesAfterOutboundHandoff = React.useCallback(() => {
        clearSessionDraftValues(activeServerAccountScope, sessionId, {
            lifecycle: 'outboundHandoff',
        });
    }, [activeServerAccountScope, sessionId]);
    const {
        armedContinuation: liveArmedContinuation,
        armedContinuationLocalId: liveArmedContinuationLocalId,
        armedContinuationSubmission: liveArmedContinuationSubmission,
        clearArmedContinuation,
        clearArmedContinuationSubmissionIfCurrent: clearPersistedArmedContinuationSubmissionIfCurrent,
    } = inSessionAgentPicker;
    // One compare-clear owner consumes both a live transition and the nested
    // pre-RPC snapshot restored after remount. It clears only values that still
    // match the exact submitted input, preserving every newer composer edit.
    const clearArmedContinuationSubmissionIfCurrent = React.useCallback((
        submission: SessionArmedAgentContinuationSubmission,
    ): boolean => {
        const currentness = submission.currentness;
        let didClearSemantic = false;
        const didClearComposer = clearComposerAfterOutboundHandoff({
            snapshot: {
                sessionId,
                text: currentness?.text ?? submission.input.text,
            },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState: inputComposerClearTransientStateRef.current,
            ...(currentness
                ? {
                    clearSemanticDraftValues: () => {
                        for (const [fieldId, expected] of [
                            ['structuredInput.mentions', currentness.mentions],
                        ] as const) {
                            const actual = readSessionDraftValue(activeServerAccountScope, sessionId, fieldId);
                            if (typeof actual === 'undefined' || JSON.stringify(actual) !== JSON.stringify(expected)) {
                                continue;
                            }
                            clearSessionDraftValue(activeServerAccountScope, sessionId, fieldId, { flush: false });
                            didClearSemantic = true;
                        }
                        if (didClearSemantic) flushSessionDraftValues(activeServerAccountScope);
                    },
                }
                : {}),
        });

        let didClearAttachmentDrafts = false;
        if (currentness && currentness.attachmentDraftIds.length > 0) {
            const submittedAttachmentDraftIds = new Set(currentness.attachmentDraftIds);
            const currentAttachmentDrafts = attachmentDraftsSnapshotRef.current;
            const nextAttachmentDrafts = currentAttachmentDrafts.filter((draft) => (
                !submittedAttachmentDraftIds.has(draft.id)
            ));
            if (nextAttachmentDrafts.length !== currentAttachmentDrafts.length) {
                replaceSessionAttachmentDrafts(nextAttachmentDrafts);
                didClearAttachmentDrafts = true;
            }
        }

        let didClearReviewComments = false;
        const happierEnvelope = readObjectRecord(submission.input.meta.happier);
        const submittedReviewComments = happierEnvelope?.kind === 'review_comments.v1'
            ? parseReviewCommentsV1(happierEnvelope.payload)
            : null;
        if (submittedReviewComments !== null) {
            const currentReviewComments = buildReviewCommentsV1MetaPayload({
                sessionId,
                drafts: includedReviewCommentDrafts,
            });
            if (JSON.stringify(currentReviewComments) === JSON.stringify(submittedReviewComments)) {
                clearSentReviewCommentDrafts();
                didClearReviewComments = true;
            }
        }

        return didClearComposer || didClearSemantic || didClearAttachmentDrafts || didClearReviewComments;
    }, [
        activeServerAccountScope,
        clearDraftForSessionIfCurrentValueMatches,
        clearSentReviewCommentDrafts,
        includedReviewCommentDrafts,
        replaceSessionAttachmentDrafts,
        sessionId,
    ]);
    const appliedArmedContinuationDraftClearRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const outcome = activeArmedContinuationOutcome;
        if (outcome === null || outcome.kind !== 'outcome' || outcome.sessionId !== sessionId) return;
        if (armedContinuationDisposition?.draft !== 'clear') return;
        const clearKey = `${activeServerAccountScopeKey}\u0000${outcome.localId}`;
        if (appliedArmedContinuationDraftClearRef.current === clearKey) return;
        const submission = liveArmedContinuationSubmission;
        if (submission?.localId !== outcome.localId) return;
        appliedArmedContinuationDraftClearRef.current = clearKey;
        clearArmedContinuationSubmissionIfCurrent(submission);
        clearPersistedArmedContinuationSubmissionIfCurrent(submission);
        // Draft currentness controls only whether this exact text can be removed.
        // Canonical custody still spends the submitted transition: otherwise a
        // rewritten draft would retain its prior localId and could collide with
        // the message it replaced. A newer arm is distinct even when it happens
        // to name the same target, so fence the clear on both its intent and id.
        if (
            armedContinuationDisposition.arm === 'clear'
            && liveArmedContinuation !== null
            && liveArmedContinuationLocalId === outcome.localId
            && JSON.stringify(liveArmedContinuation) === JSON.stringify(outcome.intent)
        ) {
            clearArmedContinuation();
        }
    }, [
        activeArmedContinuationOutcome,
        activeServerAccountScopeKey,
        armedContinuationDisposition,
        clearArmedContinuation,
        clearPersistedArmedContinuationSubmissionIfCurrent,
        clearArmedContinuationSubmissionIfCurrent,
        liveArmedContinuationLocalId,
        liveArmedContinuation,
        liveArmedContinuationSubmission,
        sessionId,
    ]);
    const armedContinuationSubmissionCustody = storage(
        React.useCallback(
            (state: StorageState) => selectCanonicalOutboundHandoffForLocalId(
                state,
                sessionId,
                liveArmedContinuationSubmission?.localId ?? null,
            ),
            [liveArmedContinuationSubmission?.localId, sessionId],
        ),
    );
    React.useEffect(() => {
        // A remount does not revive a transient outcome. The nested snapshot is
        // sufficient: canonical custody of its localId spends the exact arm.
        if (activeArmedContinuationOutcome?.kind === 'outcome') return;
        const submission = liveArmedContinuationSubmission;
        if (!submission || armedContinuationSubmissionCustody === 'absent') return;
        const clearKey = `${activeServerAccountScopeKey}\u0000${submission.localId}`;
        if (appliedArmedContinuationDraftClearRef.current === clearKey) return;
        appliedArmedContinuationDraftClearRef.current = clearKey;
        clearArmedContinuationSubmissionIfCurrent(submission);
        clearPersistedArmedContinuationSubmissionIfCurrent(submission);
        if (
            liveArmedContinuation !== null
            && liveArmedContinuationLocalId === submission.localId
        ) {
            clearArmedContinuation();
        }
    }, [
        activeArmedContinuationOutcome,
        activeServerAccountScopeKey,
        armedContinuationSubmissionCustody,
        clearArmedContinuation,
        clearPersistedArmedContinuationSubmissionIfCurrent,
        clearArmedContinuationSubmissionIfCurrent,
        liveArmedContinuation,
        liveArmedContinuationLocalId,
        liveArmedContinuationSubmission,
    ]);
    const restoreSemanticDraftValuesFromSnapshot = React.useCallback((snapshot: ComposerSemanticDraftSnapshot) => {
        if (typeof snapshot.recipient === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'routing.recipient', { flush: false });
        } else {
            writeSessionDraftValue(activeServerAccountScope, sessionId, 'routing.recipient', snapshot.recipient, { flush: false });
        }

        if (typeof snapshot.executionRunDelivery === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'routing.executionRunDelivery', { flush: false });
        } else {
            writeSessionDraftValue(
                activeServerAccountScope,
                sessionId,
                'routing.executionRunDelivery',
                snapshot.executionRunDelivery,
                { flush: false },
            );
        }

        if (typeof snapshot.structuredInputMentions === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'structuredInput.mentions', { flush: false });
        } else {
            writeSessionDraftValue(
                activeServerAccountScope,
                sessionId,
                'structuredInput.mentions',
                snapshot.structuredInputMentions,
                { flush: false },
            );
        }

        flushSessionDraftValues(activeServerAccountScope);
    }, [activeServerAccountScope, sessionId]);
    const clearSemanticDraftValuesAfterAcceptedComposerClear = React.useCallback(() => {
        // `composerClear` consumes the whole composer decision. The catalog
        // clears the persisted draft; the picker owns the mounted counterpart.
        if (inSessionAgentPicker.armedContinuation !== null) {
            inSessionAgentPicker.clearArmedContinuation();
        }
        clearSessionDraftValues(activeServerAccountScope, sessionId, {
            lifecycle: 'composerCleared',
        });
    }, [
        activeServerAccountScope,
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.clearArmedContinuation,
        sessionId,
    ]);
    const restorePendingEditAttachmentDraftsIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        if (attachmentDraftsSnapshotRef.current.length !== 0) return;
        replaceSessionAttachmentDrafts(edit.previousAttachmentDrafts);
    }, [replaceSessionAttachmentDrafts]);
    const restorePendingEditSemanticDraftsIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        if (!isEmptyPendingMessageComposerSemanticDraftSnapshot(captureComposerSemanticDraftSnapshot())) return;
        restoreSemanticDraftValuesFromSnapshot(edit.previousSemanticDraftSnapshot);
    }, [captureComposerSemanticDraftSnapshot, restoreSemanticDraftValuesFromSnapshot]);
    const restorePendingEditComposerSnapshotIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        setDraftValue(edit.previousDraftText);
        restorePendingEditAttachmentDraftsIfSafe(edit);
        restorePendingEditSemanticDraftsIfSafe(edit);
        inputComposerRestoreTransientStateRef.current(edit.previousTransientInputState);
    }, [
        restorePendingEditAttachmentDraftsIfSafe,
        restorePendingEditSemanticDraftsIfSafe,
        setDraftValue,
    ]);
    const restorePendingEditNonTextComposerSnapshotIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        restorePendingEditAttachmentDraftsIfSafe(edit);
        restorePendingEditSemanticDraftsIfSafe(edit);
        inputComposerRestoreTransientStateRef.current(edit.previousTransientInputState);
    }, [
        restorePendingEditAttachmentDraftsIfSafe,
        restorePendingEditSemanticDraftsIfSafe,
    ]);
    const restorePendingEditComposerSnapshotIfSafeRef = React.useRef(restorePendingEditComposerSnapshotIfSafe);
    React.useEffect(() => {
        restorePendingEditComposerSnapshotIfSafeRef.current = restorePendingEditComposerSnapshotIfSafe;
    }, [restorePendingEditComposerSnapshotIfSafe]);
    const restorePendingEditNonTextComposerSnapshotIfSafeRef = React.useRef(restorePendingEditNonTextComposerSnapshotIfSafe);
    React.useEffect(() => {
        restorePendingEditNonTextComposerSnapshotIfSafeRef.current = restorePendingEditNonTextComposerSnapshotIfSafe;
    }, [restorePendingEditNonTextComposerSnapshotIfSafe]);
    const cancelPendingMessageEdit = React.useCallback(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        setPendingMessageEdit(null);
        restorePendingEditComposerSnapshotIfSafe(edit);
    }, [restorePendingEditComposerSnapshotIfSafe]);
    const handleEditPendingMessage = React.useCallback<NonNullable<ChatListProps['onEditPendingMessage']>>((request) => {
        // The composer reopens what the reader SAW. A queued turn that expanded
        // review comments, attachments or a template into its transport text
        // kept the typed sentence in `displayText`, and editing the expansion is
        // editing something the user never wrote.
        const editText = readMessageDisplayText(request);
        const previousDraftText = pendingMessageEditRef.current?.previousDraftText ?? messageRef.current;
        const previousAttachmentDrafts = pendingMessageEditRef.current?.previousAttachmentDrafts ?? attachmentDraftsSnapshotRef.current;
        const previousSemanticDraftSnapshot = pendingMessageEditRef.current?.previousSemanticDraftSnapshot
            ?? captureComposerSemanticDraftSnapshot();
        const previousTransientInputState = pendingMessageEditRef.current?.previousTransientInputState
            ?? inputComposerCaptureTransientStateRef.current();
        setPendingMessageEdit({
            pendingId: request.id,
            previousDraftText,
            previousAttachmentDrafts,
            previousSemanticDraftSnapshot,
            previousTransientInputState,
            loadedText: editText,
        });
        replaceSessionAttachmentDrafts([]);
        clearSemanticDraftValuesAfterAcceptedComposerClear();
        inputComposerClearTransientStateRef.current();
        setDraftValue(editText);
    }, [
        captureComposerSemanticDraftSnapshot,
        clearSemanticDraftValuesAfterAcceptedComposerClear,
        replaceSessionAttachmentDrafts,
        setDraftValue,
    ]);
    React.useEffect(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        const stillQueued = pendingMessages.some((pending) =>
            pending.id === edit.pendingId || pending.localId === edit.pendingId
        );
        if (stillQueued) return;

        setPendingMessageEdit(null);
        if (messageRef.current === edit.loadedText) {
            restorePendingEditComposerSnapshotIfSafe(edit);
        } else {
            restorePendingEditNonTextComposerSnapshotIfSafe(edit);
        }
    }, [pendingMessages, restorePendingEditComposerSnapshotIfSafe, restorePendingEditNonTextComposerSnapshotIfSafe]);
    React.useEffect(() => () => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        if (messageRef.current === edit.loadedText) {
            restorePendingEditComposerSnapshotIfSafeRef.current(edit);
        } else {
            restorePendingEditNonTextComposerSnapshotIfSafeRef.current(edit);
        }
    }, []);

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
        const normalized = readNonBlankSessionControlIdentifier(modeId) ?? '';
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

    const updateSessionConfigOptionOverride = React.useCallback((configId: string, valueId: string) => {
        const updatedAt = nowServerMs();
        setOptimisticSessionConfigOptionOverrides((current) => {
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
            return readSessionConfigOptionOverridesState(nextMetadata);
        });
        fireAndForget(sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId,
            configId,
            value: valueId,
            updatedAt,
        }), { tag: 'SessionView.updateSessionConfigOptionOverride' });
    }, [session.metadata, sessionId]);
    const buildNextMessageMetaOverrides = React.useCallback((metaOverrides?: Record<string, unknown>) => {
        return buildSessionComposerNextMessageMetaOverridesFromUiState({
            agentId: liveComposerState.agentId,
            configOptionOverrides: optimisticSessionConfigOptionOverrides,
            metaOverrides,
        });
    }, [liveComposerState.agentId, optimisticSessionConfigOptionOverrides]);

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
    const handleResumeSession = React.useCallback(async (opts?: { silent?: boolean; initialTranscriptAfterSeq?: number }): Promise<boolean> => {
        const silent = opts?.silent === true;
        const initialTranscriptAfterSeq = typeof opts?.initialTranscriptAfterSeq === 'number'
            && Number.isFinite(opts.initialTranscriptAfterSeq)
            && opts.initialTranscriptAfterSeq >= 0
            ? Math.trunc(opts.initialTranscriptAfterSeq)
            : null;
        const resumeMachineTarget = resolveSessionResumeMachineTarget(controlMachineTarget);
        const resumeMachineId = resumeMachineTarget?.machineId ?? null;
        const resumeDirectory = resumeMachineTarget?.directory ?? null;

        const maybeAlert = (message: string) => {
            if (silent) return;
            Modal.alert(t('common.error'), message);
        };

        if (!resumeMachineId || !resumeDirectory || !session.metadata?.flavor) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (
            !canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)
            && !canContinueSessionWithFreshSpawn(session.metadata, resumeCapabilityOptions)
        ) {
            if (silent) return false;

            const replayCfg = resolveHappierReplayConfig(settings);
            if (replayCfg.enabled) {
                if (!resumeMachineTarget) {
                    maybeAlert(t('session.machineOfflineCannotResume'));
                    return false;
                }

                const wantsReplay = await Modal.confirm(
                    t('session.resumeFailed'),
                    t('settingsSession.replayResume.footer'),
                    { confirmText: t('common.continue') },
                );
                if (wantsReplay) {
                    // Continuation is authored through the canonical New Session
                    // screen with this Session attached as source context, so the
                    // one Replay-seeded creation owner creates the child. The
                    // legacy `session.continueWithReplay` RPC stays a
                    // compatibility ingress with no UI product use.
                    try {
                        router.push(buildNewSessionSourceContextNavigation({
                            session,
                            sourceSessionId: sessionId,
                            forkPoint: { type: 'latest' },
                            serverId: capabilityServerId ?? null,
                            machineId: resumeMachineId,
                        }) as any);
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

        if (!resumeMachineTarget) {
            maybeAlert(t('session.machineOfflineCannotResume'));
            return false;
        }

        setIsResuming(true);
        try {
            const permissionOverride = getPermissionModeOverrideForSpawn(session);
            const modelOverride = getModelOverrideForSpawn(session);
            const resumeTarget = resumeMachineTarget;
            const base = buildResumeSessionBaseOptionsFromSession({
                sessionId,
                session,
                resumeCapabilityOptions,
                resumeTargetOverride: resumeTarget
                    ? {
                        machineId: resumeTarget.machineId,
                        directory: resumeTarget.directory,
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
                ...(initialTranscriptAfterSeq !== null ? { initialTranscriptAfterSeq } : {}),
                ...buildResumeSessionExtrasFromUiState({
                    agentId,
                    settings,
                    session: sessionRuntimeStatusSource,
                }),
            });

            if (result.type === 'error') {
                maybeAlert(formatResumeSessionFailureMessage(result));
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
    }, [agentId, capabilityServerId, controlMachineTarget, executionRunsEnabled, resumeCapabilityOptions, router, session, sessionId, settings]);
    handleUsageLimitRecoveryResumeNowRef.current = handleResumeSession;

    // The committed-but-inactive recovery. The banner offers it only once
    // canonical facts say the Session has no live runtime, and it does nothing
    // itself: starting a Session belongs to `handleResumeSession`, which every
    // other inactive-session affordance already uses. A successful start makes
    // the notice untrue, so it goes.
    const handleArmedContinuationResume = React.useCallback(async () => {
        const resumed = await handleResumeSession({ silent: false });
        if (resumed) {
            setArmedContinuationOutcome((current) => (
                current?.scopeKey === activeServerAccountScopeKey && current.kind === 'outcome' && current.sessionId === sessionId
                    ? null
                    : current
            ));
        }
        return resumed;
    }, [activeServerAccountScopeKey, handleResumeSession, sessionId]);

    useSessionResumeRequestListener(
        sessionId,
        React.useCallback(() => handleResumeSession(), [handleResumeSession]),
    );

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

    const isReadOnly = session.accessLevel === 'view';
    const transcriptInteraction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            accessLevel: session.accessLevel,
            canApprovePermissions: session.canApprovePermissions,
            active: session.active,
            presence: session.presence,
        });
    }, [session.accessLevel, session.active, session.canApprovePermissions, session.presence]);
    const openApprovalRequests = useOpenApprovalArtifactsForSession(sessionId);

    // The armed switch's half of "this input is in the queue and nothing is
    // running to take it". The disposition owner decides it; the two effects
    // below only route it, and neither re-decides it.
    const armedContinuationAwaitingRuntime = armedContinuationDisposition?.awaitingRuntime === true;
    const pendingQueueResumeActionLabel = armedContinuationAwaitingRuntime
        ? t('session.agentContinuation.transition.resumeAction')
        : t('common.retry');

    React.useEffect(() => {
        if (!pendingQueueResumeFailed) return;
        if (!isSessionActive) return;
        // A live runtime retracts the ordinary send's signal — but not one the
        // disposition owner is still asserting. `target_start_failed` is the
        // daemon's own proof that the target never started, and letting a
        // client-side liveness read clear it here would both weaken a definite
        // daemon arm and fight the router below for the same boolean. It yields
        // to canonical custody instead: `resolveAwaitingRuntime` stops asserting
        // the moment the message is demonstrably carried.
        if (armedContinuationAwaitingRuntime) return;
        setPendingQueueResumeFailed(false);
    }, [armedContinuationAwaitingRuntime, isSessionActive, pendingQueueResumeFailed]);

    // The armed switch's half of the same fact: this input is in the queue and
    // nothing is running to take it. It is handed to the queued-message owner
    // directly above rather than restated by a second banner, and it is WATCHED
    // rather than sampled once at send time — `accepted` only means the spawn
    // was acknowledged, so the target can die minutes later (the incident that
    // exposed this had the runtime fail 94 seconds after a switch that reported
    // success, and the reader was told nothing at all). The disposition owner
    // decides; this only routes, and the effect above retracts it once canonical
    // custody shows the message was actually carried.
    React.useEffect(() => {
        if (!armedContinuationAwaitingRuntime) return;
        // `isResumable` is a capability of the recovery this banner offers, not a
        // second opinion on whether the message is waiting. Liveness deliberately
        // is NOT re-checked here: the disposition owner already weighed it for the
        // arms decided from client facts, and for the arm the daemon proved
        // (`target_start_failed`) re-checking it would let a stale Session view
        // silence a fact the daemon established — which is exactly how this arm
        // reached a real reader saying nothing.
        if (!isResumable) return;
        setPendingQueueResumeFailed(true);
    }, [armedContinuationAwaitingRuntime, isResumable]);

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

    const [followBottomIntentSeq, setFollowBottomIntentSeq] = React.useState(0);
    const requestMountedTranscriptFollow = React.useCallback(() => {
        // The sync send boundary already established durable own-send tail intent before
        // its optimistic projection. This key is only the mounted physical takeover signal.
        setFollowBottomIntentSeq((current) => current + 1);
    }, []);

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
                appendNewSessionDraft: ({ promptText, sourceServerId }) => {
                    appendTranscriptSelectionToNewSessionDraft({
                        promptText,
                        sourceServerId,
                        scope: activeServerAccountScope,
                    });
                },
                navigateToSession: ({ sessionId: destinationSessionId, serverId }) => {
                    void navigateToSession(destinationSessionId, { serverId });
                },
                navigateToNewSession: () => {
                    router.push('/new');
                },
            });
        } catch {
            Modal.alert(t('common.error'), t('transcript.selection.sendTo.sendFailed'));
        }
    }, [
        activeServerAccountScope,
        navigateToSession,
        router,
        session,
        sessionRouteServerId,
        sessionId,
        transcriptBulkCopyFormat,
        transcriptMessageSendToSessionTemplate,
        transcriptSelectionRoleLabels,
    ]);

    const content = (
        <SessionTranscriptContent
            sessionId={sessionId}
            session={session}
            isEncryptedSessionLocked={isEncryptedSessionLocked}
            isForkedSessionV1={isForkedSessionV1}
            isLocallyAttached={isLocallyAttached}
            pendingMessagesCount={pendingMessages.length}
            reducedMotionPreferred={reducedMotionPreferred}
            bottomNotice={bottomNotice}
            controlledByUserOverride={isLocallyAttached}
            controlSwitchTo={controlSwitchTo}
            onRequestSwitchToRemote={isHiddenSystemSessionSession || !canRequestRemoteControl ? undefined : handleRequestSwitchToRemote}
            directControlFooter={directControlFooter}
            approvalRequests={openApprovalRequests}
            jumpToSeq={jumpToSeq}
            followBottomIntentKey={followBottomIntentSeq}
            onViewportChange={handleTranscriptViewportChange}
            onEditPendingMessage={handleEditPendingMessage}
            routeHydrationPending={routeHydrationPending}
        />
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
            onRestoreSecretKeyPress={() => router.push('/restore/manual')}
            activityColor={theme.colors.text.secondary}
        />
    );

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = inactiveUi.inactiveStatusTextKey ? t(inactiveUi.inactiveStatusTextKey) : null;

      const shouldShowInput = inactiveUi.shouldShowInput && !isEncryptedSessionLocked;
        const handlePickAttachmentFile = React.useCallback(() => {
            openAttachmentFilePickerFiles(filePickerRef.current);
        }, [filePickerRef]);
        const handlePickAttachmentImage = React.useCallback(() => {
            openAttachmentFilePickerImages(filePickerRef.current);
        }, [filePickerRef]);
        const handleAppendLinkedPath = React.useCallback((path: string) => {
            setDraftValue((prev) => {
                const base = prev ?? '';
                const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
                return `${base}${spacer}@${path} `;
            });
        }, [setDraftValue]);
        const extraActionChips = useSessionAgentInputExtraActionChips({
            sessionId,
            attachmentsUploadsEnabled,
            isReadOnly,
            isUploadingAttachments,
            onPickAttachmentFile: handlePickAttachmentFile,
            onPickAttachmentImage: handlePickAttachmentImage,
            onPasteAttachmentImage: pasteAttachmentImage,
            onAppendLinkedPath: handleAppendLinkedPath,
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
        const connectedServicesAuthSwitchDisabledReason = useConnectedServicesAuthSwitchDisabledReason({
            isReadOnly,
            session: sessionRuntimeStatusSource,
        });
        const intentionalRestartSourceEvents = useSessionConnectedServiceAccountSwitchEvents(sessionId);
        const intentionalRestartRecoveryEvidenceAtMs = React.useMemo(() => {
            return resolveSessionIntentionalRestartRecoveryEvidenceAtMs({
                activeAt: session.activeAt,
                latestReadyEventAt: session.latestReadyEventAt,
                latestTurnStatus: session.latestTurnStatus,
                latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
                meaningfulActivityAt: session.meaningfulActivityAt,
            });
        }, [
            session.activeAt,
            session.latestReadyEventAt,
            session.latestTurnStatus,
            session.latestTurnStatusObservedAt,
            session.meaningfulActivityAt,
        ]);
        const intentionalRestartSignals = React.useMemo<ReadonlyArray<SessionIntentionalRestartSignal>>(() => {
            return deriveSessionIntentionalRestartSignals({
                runtimeIssue: session.lastRuntimeIssue ?? null,
                events: intentionalRestartSourceEvents,
                recoveryEvidenceAtMs: intentionalRestartRecoveryEvidenceAtMs,
            });
        }, [
            intentionalRestartRecoveryEvidenceAtMs,
            intentionalRestartSourceEvents,
            session.lastRuntimeIssue,
        ]);
        const sessionConnectedServicesAuthSwitch = useSessionConnectedServicesAuthSwitch({
            sessionId,
            agentId: liveComposerState.agentId,
            machineId: controlMachineTarget?.machineId ?? null,
            serverId: capabilityServerId,
            agentCore: getAgentCore(liveComposerState.agentId),
            sessionMetadata: session.metadata,
            settings: {
                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesProviderStateSharingSettingsV1: settings.connectedServicesProviderStateSharingSettingsV1,
            },
            switchingDisabledReason: connectedServicesAuthSwitchDisabledReason,
            sessionActive: session.active === true,
            intentionalRestartSignals,
        });
        const agentInputStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => [
            ...sessionStatusBadges,
            ...sessionConnectedServicesAuthSwitch.statusBadges,
            ...(pendingMessageEdit
                ? [{
                    key: 'pending-message-edit',
                    label: t('session.pendingMessages.actions.edit'),
                    accessibilityLabel: t('common.cancel'),
                    testID: 'session.pendingMessageEdit.badge',
                    tone: 'active',
                    emphasis: 'prominent',
                    icon: (tint: string) => <Icon name="pencil" size={14} color={tint} />,
                    onPress: cancelPendingMessageEdit,
                } satisfies AgentInputStatusBadge]
                : []),
        ], [
            cancelPendingMessageEdit,
            pendingMessageEdit,
            sessionConnectedServicesAuthSwitch.statusBadges,
            sessionStatusBadges,
        ]);
        const agentInputExtraActionChips = React.useMemo(() => {
            const chips = [
                ...(sessionGoalActionChip ? [sessionGoalActionChip] : []),
                ...(extraActionChips ?? []),
                ...(sessionConnectedServicesAuthSwitch.connectedServicesAuthChip
                    ? [sessionConnectedServicesAuthSwitch.connectedServicesAuthChip]
                    : []),
                ...(routingControls.extraActionChips ?? []),
            ];
            return chips.length > 0 ? chips : undefined;
        }, [extraActionChips, routingControls.extraActionChips, sessionConnectedServicesAuthSwitch.connectedServicesAuthChip, sessionGoalActionChip]);

    const openFileViewer = React.useCallback(() => {
        openSessionTarget({ kind: 'fileBrowser' });
    }, [openSessionTarget]);
    const handleAgentInputFileViewerPress = useStableAgentInputFileViewerPress(openFileViewer);
    const handleAgentInputAbort = React.useCallback(() => {
        return sessionAbort(sessionId);
    }, [sessionId]);
    const handleAutocompleteSuggestions = React.useCallback(
        // Resolved per query, not per render: the machine target is imperative store state,
        // and a session that becomes reachable mid-composition must not need a rerender to
        // start offering files.
        (query: string, signal: AbortSignal) => resolveSessionComposerSuggestions(sessionId, query, {
            kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
            signal,
        }),
        [sessionId],
    );
    const handleAgentInputSend = useStableAgentInputOnSend((sendOptions) => {
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }

        const composerMessage = sendOptions?.inputTextOverride ?? message;
        const activePendingEdit = pendingMessageEditRef.current;
        if (activePendingEdit) {
            const nextText = composerMessage;
            if (nextText.trim().length === 0) {
                return;
            }
            setIsComposerSendPending(true);
            fireAndForget((async () => {
                try {
                    await sync.updatePendingMessage(sessionId, activePendingEdit.pendingId, nextText);
                    if (pendingMessageEditRef.current?.pendingId === activePendingEdit.pendingId) {
                        setPendingMessageEdit(null);
                        restorePendingEditComposerSnapshotIfSafe(activePendingEdit);
                    }
                } catch (e) {
                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.updateFailed'));
                } finally {
                    setIsComposerSendPending(false);
                }
            })(), { tag: 'SessionView.pendingMessageEdit.save' });
            return;
        }

        const sendComposerText = async (
            messageToSend: string,
            composerTextBeforeSend: string,
            sendIntent?: AgentInputSendOptions,
        ) => {
            const configuredMode = storage.getState().settings.sessionMessageSendMode;
            const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
            const permissionModeApplyTiming = storage.getState().settings.sessionPermissionModeApplyTiming;
            const nonSteerableSendPrompt = storage.getState().settings.sessionNonSteerableSendPrompt;
            const forceImmediateSend = sendIntent?.forceImmediate === true;
            const providerNonSteerablePayloadReason = getSessionComposerNonSteerablePayloadReasonFromUiState({
                agentId: liveComposerState.agentId,
                session,
                configOptionOverrides: optimisticSessionConfigOptionOverrides,
                metaOverrides: sendIntent?.structuredInputMetaOverrides,
            });

            const additionalMessage = messageToSend;
            const trimmedText = messageToSend.trim();

            // Lane P stage 3: a busy send whose payload can't steer the active turn offers
            // "Interrupt & send now" (existing interrupt delivery mode) vs "Queue for after turn"
            // (the honest pending default). Explicit intents (force-immediate / explicit pending)
            // and the non-'ask' settings skip the prompt.
            let nonSteerableExplicitMode: MessageSendMode | undefined;
            let nonSteerableApplyConfigAndSteer = false;
            let nonSteerableSteerWithoutConfig = false;
            if (
                nonSteerableSendPrompt === 'ask'
                && !forceImmediateSend
                && sendIntent?.deliveryIntent !== 'server_pending'
            ) {
                const preflight = decideSessionMessageDelivery({
                    configuredMode,
                    busySteerSendPolicy,
                    session: sessionRuntimeStatusSource,
                    text: trimmedText,
                    permissionModeApplyTiming,
                    nonSteerableSendPrompt,
                    providerNonSteerablePayloadReason,
                    nowMs: Date.now(),
                });
                if (preflight.nonSteerablePayloadReason) {
                    // Lane Q: offer "Apply setting & steer now" only when the backend published the
                    // in-flight config-apply capability and the blocker is a mode change.
                    // Lane X (X3): the apply option NAMES the setting and value, and "Steer now
                    // without applying" (Case B) is offered whenever steering itself is safe.
                    const isModeChangeBlocker = preflight.nonSteerablePayloadReason === 'mode_change_refused';
                    const desiredMode = typeof session?.permissionMode === 'string' && session.permissionMode.length > 0
                        ? session.permissionMode
                        : null;
                    const choice = await confirmNonSteerableSend(preflight.nonSteerablePayloadReason, {
                        offerApplyAndSteer: canApplySteerConfigInFlight(session),
                        offerSteerWithoutApplying: isModeChangeBlocker,
                        ...(isModeChangeBlocker && desiredMode
                            ? {
                                settingLabel: getPermissionModeTitleForAgentType(agentId),
                                valueLabel: getPermissionModeLabelForAgentType(agentId, desiredMode),
                            }
                            : {}),
                    });
                    if (choice === 'cancel') {
                        return;
                    }
                    if (choice === 'interrupt_and_send') {
                        nonSteerableExplicitMode = 'interrupt';
                    }
                    if (choice === 'apply_and_steer') {
                        nonSteerableApplyConfigAndSteer = true;
                    }
                    if (choice === 'steer_without_applying') {
                        nonSteerableSteerWithoutConfig = true;
                    }
                }
            }
            // Lane X (X3 Case B): steer the TEXT only — this message rides with the published
            // current mode (no delta), while the desired mode stays local and applies on the next
            // message via the normal path. Honest label, honest behavior.
            const steerWithoutConfigMetaOverrides = nonSteerableSteerWithoutConfig
                ? {
                    permissionMode: typeof session?.metadata?.permissionMode === 'string' && session.metadata.permissionMode.length > 0
                        ? session.metadata.permissionMode
                        : 'default',
                }
                : null;
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
            const sendSnapshot = { sessionId, text: previousMessage };
            const semanticDraftSnapshot = captureComposerSemanticDraftSnapshot();
            let semanticDraftSnapshotAfterHandoffClear: ComposerSemanticDraftSnapshot | null = null;
            const transientInputStateHandoff = captureComposerTransientInputStateForOutboundHandoff({
                captureTransientInputState: inputComposerCaptureTransientStateRef.current,
                clearTransientInputState: inputComposerClearTransientStateRef.current,
                restoreTransientInputState: inputComposerRestoreTransientStateRef.current,
            });
            let didClearAtOutboundHandoff = false;
            let outboundHandoffLocalId: string | null = null;
            let didRecordOutboundAccepted = false;
            const recordOutboundAccepted = () => {
                if (didRecordOutboundAccepted) return;
                didRecordOutboundAccepted = true;
                trackMessageSent();
                requestMountedTranscriptFollow();
            };
            const clearAfterOutboundHandoff = () => {
                // Composer admission ends at the durable/optimistic outbound handoff. Runtime
                // wake and provider delivery continue through their canonical session/Pending
                // projections and must not keep the submit button in a local sending state.
                setIsComposerSendPending(false);
                const didClear = clearComposerAfterOutboundHandoff({
                    snapshot: sendSnapshot,
                    clearDraftForSessionIfCurrentValueMatches,
                    clearTransientInputState: transientInputStateHandoff.clearTransientInputState,
                    isSemanticSnapshotCurrent: () => isComposerSemanticDraftSnapshotCurrent(semanticDraftSnapshot),
                    clearSemanticDraftValues: clearSemanticDraftValuesAfterOutboundHandoff,
                });
                if (didClear) {
                    semanticDraftSnapshotAfterHandoffClear = captureComposerSemanticDraftSnapshot();
                }
                didClearAtOutboundHandoff = didClearAtOutboundHandoff || didClear;
                return didClear;
            };
            const restoreAttachmentDraftsFromSnapshot = (drafts: readonly AttachmentDraft[]) => {
                replaceSessionAttachmentDrafts(drafts);
            };
            const restoreAfterFailedOutboundHandoff = (attachmentDraftsForRestore?: readonly AttachmentDraft[]) => {
                const didRestore = restoreComposerAfterFailedOutboundHandoff({
                    snapshot: sendSnapshot,
                    wasClearedAtHandoff: didClearAtOutboundHandoff,
                    isCanonicalOutboundHandoffPresent: () => hasCanonicalOutboundHandoffForLocalId(
                        sessionId,
                        outboundHandoffLocalId,
                    ),
                    isSemanticRestoreSafe: () =>
                        semanticDraftSnapshotAfterHandoffClear !== null
                        && isComposerSemanticDraftSnapshotCurrent(semanticDraftSnapshotAfterHandoffClear),
                    restoreDraftForSessionIfCurrentValueMatches,
                    restoreTransientInputState: transientInputStateHandoff.restoreTransientInputState,
                    restoreSemanticDraftValues: () => restoreSemanticDraftValuesFromSnapshot(semanticDraftSnapshot),
                });
                if (didRestore && attachmentDraftsForRestore) {
                    restoreAttachmentDraftsFromSnapshot(attachmentDraftsForRestore);
                }
                return didRestore;
            };

            // Destination selection for a true send (section 3.3).
            //
            // An ordinary send reaches `submitSessionUserMessage`, the canonical
            // message owner, and the Session keeps the Agent it has. When the
            // in-session picker armed another Agent, the very same submission goes
            // through `session.agentTransition` instead, which stops the source
            // runtime, commits the target, and admits this exact localId through that
            // same message owner on the far side of the cutover. They are
            // alternatives: an armed send must never quietly reach the current Agent,
            // which is precisely the failure this decision exists to remove.
            //
            // The decision itself lives in `resolveSessionComposerSendDestination`
            // rather than inline here, because inline is exactly where it was missing
            // for the whole program with no test able to see it. This screen keeps only
            // the routing facts each existing resolver already owns.
            //
            // The armed value is produced only behind the `sessions.agentSwitching`
            // gate, so this inherits that decision rather than re-deriving it.
            const armedContinuationTargetLabel = armedContinuationTarget?.label ?? '';
            const resolveSendDestination = (
                route: SessionComposerSendRoute,
            ): SessionComposerSendDestination => resolveSessionComposerSendDestination({
                route,
                armedContinuation: inSessionAgentPicker.armedContinuation,
                armedContinuationLocalId: inSessionAgentPicker.armedContinuationLocalId,
                machineId: typeof machineId === 'string' ? machineId : null,
                pendingTransitionOutcome,
            });
            const presentRefusedArmedSend = (
                refused: Extract<SessionComposerSendDestination, { kind: 'refused' }>,
            ): void => {
                // A refusal is a rejection before any effect: the draft and the armed
                // row both survive, and the ordinary send is the retry once the reader
                // has resolved the conflict. It reaches the same composer banner as
                // every other outcome instead of a modal the reader has to dismiss
                // before they can act on it.
                if (refused.reason !== 'unreconciledTransitionOutcome') {
                    setArmedContinuationOutcome({
                        kind: 'refusal',
                        scopeKey: activeServerAccountScopeKey,
                        message: refused.reason === 'conflictingDestination'
                            ? t('session.agentContinuation.transition.conflictingDestination', {
                                agent: armedContinuationTargetLabel,
                            })
                            : t('session.agentContinuation.transition.rejected.targetUnavailable', {
                                agent: armedContinuationTargetLabel,
                            }),
                    });
                    return;
                }
                // `unreconciledTransitionOutcome` is the banner already on screen
                // saying the previous outcome is unestablished. Overwriting it would
                // replace a live fact with a restatement — but a refused send has to be
                // visible, so a collapsed banner is re-expanded through the same
                // collapse owner rather than given a second announcement channel.
                if (agentTransitionOutcomeBanner.collapsed) agentTransitionOutcomeBanner.toggle();
            };
            const dispatchArmedContinuation = async (
                destination: Extract<SessionComposerSendDestination, { kind: 'armedAgentContinuation' }>,
                outboundForTransition: Readonly<{
                    text: string;
                    displayText?: string;
                    metaOverrides?: Record<string, unknown>;
                }>,
                onAdmitted: () => void,
            ): Promise<void> => {
                const transitionSubmission = {
                    machineId: destination.machineId,
                    serverId: sessionRouteServerId,
                    sessionId,
                    localId: destination.localId,
                    intent: destination.intent,
                    input: {
                        text: outboundForTransition.text,
                        ...(outboundForTransition.displayText !== undefined
                            ? { displayText: outboundForTransition.displayText }
                            : {}),
                        ...(outboundForTransition.metaOverrides
                            ? { meta: outboundForTransition.metaOverrides }
                            : {}),
                    },
                    sourceAgentLabel: currentAgentLabel,
                    targetAgentLabel: armedContinuationTargetLabel,
                };
                // Persist the stable localId and exact wire input before the RPC
                // leaves this process. The nested arm is the only durable owner;
                // a remount can then compare-clear this exact request if custody
                // appears after the call returned.
                const existingSubmission = inSessionAgentPicker.armedContinuationSubmission;
                const transitionInput = existingSubmission?.localId === destination.localId
                    ? existingSubmission.input
                    : buildArmedAgentContinuationTransitionInput(transitionSubmission);
                if (!inSessionAgentPicker.recordArmedContinuationSubmission({
                    localId: destination.localId,
                    input: transitionInput,
                    currentness: {
                        text: previousMessage,
                        mentions: semanticDraftSnapshot.structuredInputMentions ?? [],
                        attachmentDraftIds: attachmentDrafts.map((draft) => draft.id),
                    },
                })) {
                    return;
                }
                // The server's reconciliation path is allowed to update a
                // matching localId, so retrying an edited composer must reuse
                // the arm's first exact wire input rather than trusting localId
                // alone to protect its content.
                const submissionForDispatch = existingSubmission?.localId === destination.localId
                    ? {
                        ...transitionSubmission,
                        input: {
                            text: existingSubmission.input.text,
                            meta: existingSubmission.input.meta,
                        },
                    }
                    : transitionSubmission;
                const { disposition, result } = await continueSessionWithArmedAgent(submissionForDispatch);
                // The armed row is dropped only once it stops being a truthful
                // promise about the next message.
                // A draft clear is consumed by the one compare-clear owner below,
                // which needs the nested snapshot to remain available first.
                if (disposition.arm === 'clear' && disposition.draft !== 'clear') {
                    inSessionAgentPicker.clearArmedContinuation();
                }
                // The outcome itself is recorded, not its rendering: the banner
                // re-derives what to say (and what is safe to offer) through the
                // disposition owner as canonical facts arrive.
                setArmedContinuationOutcome({
                    kind: 'outcome',
                    sessionId,
                    scopeKey: activeServerAccountScopeKey,
                    result,
                    intent: destination.intent,
                    labels: buildArmedContinuationLabels(destination.intent.selection.agentId),
                    localId: destination.localId,
                    reconciled: false,
                });
                // Only canonical admission of this exact localId clears the draft.
                // Every other outcome leaves the composer as the reader left it and
                // has already said why.
                if (disposition.draft !== 'clear') return;
                outboundHandoffLocalId = destination.localId;
                onAdmitted();
            };

            if (hasAttachments) {
                setIsComposerSendPending(true);
                fireAndForget((async () => {
                    const submittedAttachmentDraftIds = new Set(attachmentDrafts.map((draft) => draft.id));
                    const readSubmittedAttachmentDraftsFromCurrent = () => {
                        const currentDraftsById = new Map(attachmentDraftsSnapshotRef.current.map((draft) => [draft.id, draft]));
                        return attachmentDrafts.map((draft) => currentDraftsById.get(draft.id) ?? draft);
                    };
                    const canRestoreFailedAttachmentHandoffSnapshot = () => {
                        const currentDrafts = attachmentDraftsSnapshotRef.current;
                        return currentDrafts.length === 0
                            || currentDrafts.every((draft) => submittedAttachmentDraftIds.has(draft.id));
                    };
                    let attachmentDraftsForRestore = readSubmittedAttachmentDraftsFromCurrent();
                    try {
                        const readyForSend = await directSessionTakeover.ensureReadyForSend();
                        if (!readyForSend) {
                            return;
                        }
                        setIsUploadingAttachments(true);

                        // The destination is decided before anything can start an
                        // Agent. Resuming an inactive Session starts the SOURCE
                        // Agent — the one the reader chose to leave — and that is
                        // not undoable: it spends provider work, can consume queued
                        // input, and can make the transition fail non-idle. So the
                        // one decision owner is consulted first and the resume is a
                        // consequence of it, not a step that runs before it and has
                        // to be lived with.
                        const attachmentSendDestination = resolveSendDestination('sessionAgent');
                        if (attachmentSendDestination.kind === 'refused') {
                            presentRefusedArmedSend(attachmentSendDestination);
                            return;
                        }
                        if (attachmentSendDestination.kind === 'sessionAgent'
                            && !isSessionActive && isResumable) {
                            const resumed = await handleResumeSession();
                            if (!resumed) {
                                throw new Error(t('session.resumeFailed'));
                            }
                        }

                        const { uploaded } = await uploadAttachmentDraftsToSession({
                            sessionId,
                            drafts: attachmentDrafts,
                            config: attachmentsUploadConfig,
                            applyDraftPatch: applySessionAttachmentDraftPatch,
                        });
                        const attachmentsBlock = formatAttachmentsBlock(uploaded);
                        const attachmentsMetaOverrides = buildAttachmentMessageMeta(uploaded);

                        const reviewCommentDraftsForPrompt = shouldSendReviewComments
                            ? await resolveReviewCommentDraftAnchorsForPrompt({
                                drafts: includedReviewCommentDrafts,
                                reviewScope,
                            })
                            : [];
                        const outbound: {
                            text: string;
                            displayText?: string;
                            metaOverrides?: Record<string, unknown>;
                        } = shouldSendReviewComments
                            ? buildReviewCommentsOutboundMessage({
                                sessionId,
                                drafts: reviewCommentDraftsForPrompt,
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
                        outbound.metaOverrides = buildNextMessageMetaOverrides(
                            mergeMessageMetaOverrides(outbound.metaOverrides, sendIntent?.structuredInputMetaOverrides),
                        );

                        attachmentDraftsForRestore = readSubmittedAttachmentDraftsFromCurrent();
                        let didClearForAttachmentHandoff = false;
                        const removeSubmittedAttachmentDraftsFromCurrent = () => {
                            const currentDrafts = attachmentDraftsSnapshotRef.current;
                            const nextDrafts = currentDrafts.filter((draft) => !submittedAttachmentDraftIds.has(draft.id));
                            if (nextDrafts.length === currentDrafts.length) {
                                return;
                            }
                            attachmentDraftsSnapshotRef.current = nextDrafts;
                            writeSessionAttachmentDrafts(sessionId, nextDrafts);
                            attachmentDraftManager.replaceDrafts(nextDrafts);
                        };
                        const areSubmittedAttachmentDraftsStillCurrent = () => {
                            const currentDrafts = attachmentDraftsSnapshotRef.current;
                            if (currentDrafts.length !== submittedAttachmentDraftIds.size) return false;
                            return currentDrafts.every((draft) => submittedAttachmentDraftIds.has(draft.id));
                        };
                        const clearAttachmentsAfterProjectionHandoff = () => {
                            if (didClearForAttachmentHandoff) return;
                            if (!areSubmittedAttachmentDraftsStillCurrent()) {
                                removeSubmittedAttachmentDraftsFromCurrent();
                                didClearForAttachmentHandoff = clearAfterOutboundHandoff();
                                return;
                            }
                            didClearForAttachmentHandoff = clearAfterOutboundHandoff();
                            if (didClearForAttachmentHandoff) {
                                attachmentDraftsSnapshotRef.current = [];
                                clearSessionAttachmentDrafts(sessionId);
                                attachmentDraftManager.clearDrafts();
                            } else {
                                removeSubmittedAttachmentDraftsFromCurrent();
                            }
                        };
                        if (attachmentSendDestination.kind === 'armedAgentContinuation') {
                            await dispatchArmedContinuation(
                                attachmentSendDestination,
                                {
                                    text: outbound.text,
                                    ...(outbound.displayText !== undefined
                                        ? { displayText: outbound.displayText }
                                        : {}),
                                    ...(outbound.metaOverrides ? { metaOverrides: outbound.metaOverrides } : {}),
                                },
                                () => {
                                    clearAttachmentsAfterProjectionHandoff();
                                    if (shouldSendReviewComments) {
                                        clearSentReviewCommentDrafts();
                                    }
                                    recordOutboundAccepted();
                                },
                            );
                            return;
                        }
                        const result = await submitSessionUserMessage(sessionSubmitPort, {
                            sessionId,
                            session: sessionRuntimeStatusSource,
                            text: outbound.text,
                            displayText: outbound.displayText,
                            metaOverrides: steerWithoutConfigMetaOverrides
                                ? { ...outbound.metaOverrides, ...steerWithoutConfigMetaOverrides }
                                : outbound.metaOverrides,
                            configuredMode,
                            busySteerSendPolicy,
                            permissionModeApplyTiming,
                            nonSteerableSendPrompt,
                            providerNonSteerablePayloadReason,
                            ...(nonSteerableApplyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                            ...(nonSteerableSteerWithoutConfig ? { steerWithoutConfig: true } : {}),
                            explicitMode: nonSteerableExplicitMode
                                ?? (!forceImmediateSend && sendIntent?.deliveryIntent === 'server_pending'
                                    ? 'server_pending'
                                    : undefined),
                            forceImmediate: forceImmediateSend,
                            profileId: liveComposerState.profileId,
                            resumeCapabilityOptions,
                            resumeTargetOverride: reachableMachineTarget
                                ? {
                                    machineId: reachableMachineTarget.machineId,
                                    directory: reachableMachineTarget.basePath,
                                }
                                : null,
                            permissionOverride: getPermissionModeOverrideForSpawn(session),
                            serverId: capabilityServerId,
                            requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(session, cliAuthStatus?.state ?? null),
                            callerSurface: shouldSendReviewComments
                                ? 'session_attachment_review_comment_composer'
                                : 'session_attachment_composer',
                            onOutboundHandoff: (handoff) => {
                                outboundHandoffLocalId = handoff.localId ?? outboundHandoffLocalId;
                                clearAttachmentsAfterProjectionHandoff();
                                if (handoff.persistence === 'pending') {
                                    recordOutboundAccepted();
                                }
                            },
                        });
                        if (result.type === 'send_failed' || result.type === 'rejected') {
                            if (result.persistence === 'none' && canRestoreFailedAttachmentHandoffSnapshot()) {
                                restoreAfterFailedOutboundHandoff(attachmentDraftsForRestore);
                            }
                            Modal.alert(t('common.error'), result.errorMessage ?? t('errors.failedToSendMessage'));
                            return;
                        }
                        if ((result.type === 'wake_pending' || result.type === 'wake_failed') && !isSessionActive && isResumable) {
                            setPendingQueueResumeFailed(true);
                        }
                        if (shouldSendReviewComments) {
                            clearSentReviewCommentDrafts();
                        }
                        if (!didClearForAttachmentHandoff) {
                            clearAttachmentsAfterProjectionHandoff();
                        }
                        recordOutboundAccepted();
                    } catch (e) {
                        if (canRestoreFailedAttachmentHandoffSnapshot()) {
                            restoreAfterFailedOutboundHandoff(attachmentDraftsForRestore);
                        }
                        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                    } finally {
                        setIsUploadingAttachments(false);
                        setIsComposerSendPending(false);
                    }
                })(), { tag: 'SessionView.sendMessage.attachments' });
                return;
            }

            const reviewCommentDraftsForPrompt = shouldSendReviewComments
                ? await resolveReviewCommentDraftAnchorsForPrompt({
                    drafts: includedReviewCommentDrafts,
                    reviewScope,
                })
                : [];
            const outbound: {
                text: string;
                displayText?: string;
                metaOverrides?: Record<string, unknown>;
            } | null = shouldSendReviewComments
                ? buildReviewCommentsOutboundMessage({
                    sessionId,
                    drafts: reviewCommentDraftsForPrompt,
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
                // An armed switch is a promise about where the next message goes. A
                // voice adapter is a different destination entirely, so sending here
                // would leave that promise unkept and silent.
                const voiceDestination = resolveSendDestination('voiceAdapter');
                if (voiceDestination.kind === 'refused') {
                    presentRefusedArmedSend(voiceDestination);
                    return;
                }
                setIsComposerSendPending(true);
                fireAndForget((async () => {
                    try {
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
                        clearAfterOutboundHandoff();
                        recordOutboundAccepted();
                        if (shouldSendReviewComments) {
                            clearSentReviewCommentDrafts();
                        }
                    } finally {
                        setIsComposerSendPending(false);
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
            outbound.metaOverrides = buildNextMessageMetaOverrides(
                mergeMessageMetaOverrides(outbound.metaOverrides, sendIntent?.structuredInputMetaOverrides),
            );

            if (executionRunSend) {
                // Same reasoning as the voice route: an execution run is not this
                // Session's Agent, so an armed switch cannot ride along unremarked.
                const executionRunDestination = resolveSendDestination('executionRun');
                if (executionRunDestination.kind === 'refused') {
                    presentRefusedArmedSend(executionRunDestination);
                    return;
                }
                setIsComposerSendPending(true);
                fireAndForget((async () => {
                    try {
                        const readyForSend = await directSessionTakeover.ensureReadyForSend();
                        if (!readyForSend) {
                            return;
                        }

                        const result = await sessionExecutionRunSend(sessionId, executionRunSend);
                        if (!result.ok) {
                            if (isExecutionRunNotRunningSendError(result)) {
                                recipientState.clearPersistedManualRecipient();
                            }
                            Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                            return;
                        }
                        clearAfterOutboundHandoff();
                        recordOutboundAccepted();
                    } finally {
                        setIsComposerSendPending(false);
                    }
                })(), { tag: 'SessionView.sendMessage.participantRouting.executionRun' });
                return;
            }

            setIsComposerSendPending(true);
            fireAndForget((async () => {
                try {
                    const readyForSend = await directSessionTakeover.ensureReadyForSend();
                    if (!readyForSend) {
                        return;
                    }

                    const sendDestination = resolveSendDestination('sessionAgent');
                    if (sendDestination.kind === 'refused') {
                        presentRefusedArmedSend(sendDestination);
                        return;
                    }
                    if (sendDestination.kind === 'armedAgentContinuation') {
                        await dispatchArmedContinuation(
                            sendDestination,
                            {
                                text: outbound.text,
                                ...(outbound.displayText !== undefined
                                    ? { displayText: outbound.displayText }
                                    : {}),
                                ...(outbound.metaOverrides ? { metaOverrides: outbound.metaOverrides } : {}),
                            },
                            () => {
                                clearAfterOutboundHandoff();
                                if (shouldSendReviewComments) {
                                    clearSentReviewCommentDrafts();
                                }
                                recordOutboundAccepted();
                            },
                        );
                        return;
                    }

                    const result = await submitSessionUserMessage(sessionSubmitPort, {
                        sessionId,
                        session: sessionRuntimeStatusSource,
                        text: outbound.text,
                        displayText: outbound.displayText,
                        metaOverrides: steerWithoutConfigMetaOverrides
                            ? { ...outbound.metaOverrides, ...steerWithoutConfigMetaOverrides }
                            : outbound.metaOverrides,
                        configuredMode,
                        busySteerSendPolicy,
                        permissionModeApplyTiming,
                        nonSteerableSendPrompt,
                        providerNonSteerablePayloadReason,
                        ...(nonSteerableApplyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                        ...(nonSteerableSteerWithoutConfig ? { steerWithoutConfig: true } : {}),
                        explicitMode: nonSteerableExplicitMode
                            ?? (!forceImmediateSend && sendIntent?.deliveryIntent === 'server_pending'
                                ? 'server_pending'
                                : undefined),
                        forceImmediate: forceImmediateSend,
                        profileId: liveComposerState.profileId,
                        resumeCapabilityOptions,
                        resumeTargetOverride: reachableMachineTarget
                            ? {
                                machineId: reachableMachineTarget.machineId,
                                directory: reachableMachineTarget.basePath,
                            }
                            : null,
                        permissionOverride: getPermissionModeOverrideForSpawn(session),
                        serverId: capabilityServerId,
                        requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(session, cliAuthStatus?.state ?? null),
                        callerSurface: shouldSendReviewComments
                            ? 'session_review_comment_composer'
                            : 'session_composer',
                        onOutboundHandoff: (handoff) => {
                            outboundHandoffLocalId = handoff.localId ?? outboundHandoffLocalId;
                            clearAfterOutboundHandoff();
                            if (handoff.persistence === 'pending') {
                                recordOutboundAccepted();
                            }
                        },
                    });

                    if (result.type === 'send_failed' || result.type === 'rejected') {
                        if (result.persistence === 'none') {
                            restoreAfterFailedOutboundHandoff();
                        }
                        Modal.alert(t('common.error'), result.errorMessage ?? t('errors.failedToSendMessage'));
                        return;
                    }

                    recordOutboundAccepted();

                    if ((result.type === 'wake_pending' || result.type === 'wake_failed') && !isSessionActive && isResumable) {
                        setPendingQueueResumeFailed(true);
                    }

                    if (shouldSendReviewComments) {
                        clearSentReviewCommentDrafts();
                    }
                } finally {
                    setIsComposerSendPending(false);
                }
            })(), { tag: 'SessionView.sendMessage.submitSessionUserMessage' });
        };

        const promptInvocationsV1 = storage.getState().settings.promptInvocationsV1;
        const resolved = resolveSessionComposerSend({
            input: composerMessage,
            executionRunsEnabled,
            goalControlsAvailable: providerSupportsEditableSessionGoals,
            promptInvocationsV1,
        });
        if (resolved.kind === 'noop') {
            return;
        }

        if (resolved.kind === 'template') {
            const composerTextBeforeSend = composerMessage;
            fireAndForget((async () => {
                try {
                    const expanded = await expandPromptTemplateInvocation({
                        targetArtifactId: resolved.targetArtifactId,
                        argsText: resolved.rest,
                    });

                    if (resolvePromptInvocationComposerSendAction(resolved.behavior) === 'insert') {
                        setDraftValue(expanded);
                        return;
                    }

                    void sendComposerText(expanded, composerTextBeforeSend, sendOptions);
                } catch (e) {
                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                }
            })(), { tag: 'SessionView.sendMessage.template' });
            return;
        }

        if (
            resolved.kind === 'goal'
            || (
                resolved.kind === 'action' &&
                (
                    resolved.actionId === 'ui.voice_global.reset' ||
                    resolved.actionId === 'ui.pet.choose' ||
                    resolved.actionId === 'execution.run.list' ||
                    resolved.actionId === 'review.start' ||
                    resolved.actionId === 'subagents.plan.start' ||
                    resolved.actionId === 'subagents.delegate.start'
                )
            )
        ) {
            const previousMessage = composerMessage;
            void executeSessionComposerResolution({
                resolved,
                sessionId,
                agentId,
                backendTarget: sessionActionDefaultBackend?.backendTarget ?? null,
                permissionMode,
                actionExecutor,
                previousMessage,
                setMessage: setDraftValue,
                clearDraft,
                clearTransientInputState: inputComposerClearTransientStateRef.current,
                clearSemanticDraftValues: clearSemanticDraftValuesAfterAcceptedComposerClear,
                restoreDraft,
                restoreComposerSnapshotIfCurrentValueMatches: restoreDraftForSessionIfCurrentValueMatches,
                restoreComposerSnapshot,
                trackMessageSent,
                navigateToRuns: () => router.push(buildCurrentSessionHref('/runs') as any),
                navigateToPetSettings: () => router.push('/settings/pets' as any),
                openGoalControls: canEditSessionGoals
                    ? () => setActiveStatusBadgeKey(SESSION_WORK_STATE_STATUS_BADGE_KEY)
                    : undefined,
                setSessionGoal: canEditSessionGoals
                    ? (targetSessionId, request) => sessionGoalSet(targetSessionId, request)
                    : undefined,
                clearSessionGoal: canEditSessionGoals
                    ? (targetSessionId) => sessionGoalClear(targetSessionId)
                    : undefined,
                modalAlert: (title, msg) => Modal.alert(title, msg),
            });
            return;
        }

        if (resolved.kind !== 'send') return;
        void sendComposerText(resolved.text, composerMessage, sendOptions);
    });
    const input = shouldShowInput ? (
        <View>
            {voiceEnabled && voiceProviderId !== 'off' && !isHiddenSystemSessionSession ? <VoiceSurface variant="session" sessionId={sessionId} /> : null}
            {authSurfaceState && !authRecoveryBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                </ComposerAuxiliaryFrame>
            ) : null}
            {pendingQueueResumeFailed && !pendingQueueResumeFailedBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
                        testID="session-pendingQueue-resumeFailed"
                        actionTestID="session-pendingQueue-resumeFailed-retry"
                        title={t('session.pendingQueuedResumeFailedTitle')}
                        body={t('session.pendingQueuedResumeFailedBody')}
                        actionLabel={pendingQueueResumeActionLabel}
                        actionAccessibilityLabel={pendingQueueResumeActionLabel}
                        disabled={isResuming}
                        onActionPress={async () => {
                            const ok = armedContinuationAwaitingRuntime
                                ? await handleArmedContinuationResume()
                                : await handleResumeSession({ silent: false });
                            if (ok) {
                                setPendingQueueResumeFailed(false);
                            }
                        }}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {armedContinuationNotice && !agentTransitionOutcomeBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
                        testID="session.agentTransitionOutcome.banner"
                        tone={armedContinuationNotice.tone}
                        title={armedContinuationNotice.message}
                        {...(armedContinuationNotice.recovery === 'resumeSession'
                            ? {
                                actionTestID: 'session.agentTransitionOutcome.resume',
                                actionLabel: t('session.agentContinuation.transition.resumeAction'),
                                actionAccessibilityLabel: t('session.agentContinuation.transition.resumeAction'),
                                actionBusy: isResuming,
                                disabled: isResuming || !hasWriteAccess,
                                // Delegated, never re-implemented: this is the same
                                // resume owner every other inactive-session path uses.
                                onActionPress: async () => {
                                    await handleArmedContinuationResume();
                                },
                            }
                            : {})}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {visibleUsageLimitRecoveryPresentation ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
                        testID={visibleUsageLimitRecoveryPresentation.banner.testID}
                        actionTestID={visibleUsageLimitRecoveryPresentation.banner.primaryAction.testID}
                        title={visibleUsageLimitRecoveryPresentation.banner.title}
                        body={visibleUsageLimitRecoveryPresentation.banner.body}
                        actionLabel={visibleUsageLimitRecoveryPresentation.banner.primaryAction.label}
                        actionAccessibilityLabel={visibleUsageLimitRecoveryPresentation.banner.primaryAction.accessibilityLabel}
                        disabled={usageLimitRecoveryActionsDisabled}
                        onActionPress={() => void handleUsageLimitRecoveryAction(visibleUsageLimitRecoveryPresentation.banner.primaryAction.kind)}
                        secondaryActions={visibleUsageLimitRecoveryPresentation.banner.secondaryActions.map((action) => ({
                            key: action.kind,
                            testID: action.testID,
                            label: action.label,
                            accessibilityLabel: action.accessibilityLabel,
                            disabled: usageLimitRecoveryActionsDisabled,
                            onPress: () => void handleUsageLimitRecoveryAction(action.kind),
                        }))}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {visibleStaleSessionRunnerNoticePresentation ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
                        testID={visibleStaleSessionRunnerNoticePresentation.banner.testID}
                        actionTestID={visibleStaleSessionRunnerNoticePresentation.banner.primaryAction.testID}
                        title={visibleStaleSessionRunnerNoticePresentation.banner.title}
                        body={visibleStaleSessionRunnerNoticePresentation.banner.body}
                        actionLabel={visibleStaleSessionRunnerNoticePresentation.banner.primaryAction.label}
                        actionAccessibilityLabel={visibleStaleSessionRunnerNoticePresentation.banner.primaryAction.accessibilityLabel}
                        disabled={visibleStaleSessionRunnerNoticePresentation.banner.primaryAction.disabled || !hasWriteAccess}
                        onActionPress={() => void handleStaleSessionRunnerRestart()}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            <SessionAgentInputRuntimeStatusBoundary
                session={session}
                sessionLatestUsage={session.latestUsage}
                placeholder={isReadOnly ? t('session.sharing.viewOnlyMode') : t('session.inputPlaceholder')}
                value={message}
                onChangeText={setDraftValue}
                sessionId={sessionId}
                inputComposerClearTransientStateRef={inputComposerClearTransientStateRef}
                inputComposerCaptureTransientStateRef={inputComposerCaptureTransientStateRef}
                inputComposerRestoreTransientStateRef={inputComposerRestoreTransientStateRef}
                agentType={liveComposerState.agentId}
                armedContinuationTarget={armedContinuationTarget}
                composeAgentPickerOptions={inSessionAgentPicker.composeAgentPickerOptions}
                onAgentPickerIntent={inSessionAgentPicker.onAgentPickerIntent}
                onAgentPickerVisibilityChange={inSessionAgentPicker.onAgentPickerVisibilityChange}
                agentPickerSelectedOptionId={inSessionAgentPicker.agentPickerSelectedOptionId}
                attachments={attachmentsUploadsEnabled ? agentInputAttachments : undefined}
                onAttachmentsAdded={attachmentsUploadsEnabled ? addAttachments : undefined}
                hasSendableAttachments={hasIncludedReviewCommentDrafts || (attachmentsUploadsEnabled && attachmentDrafts.length > 0)}
                approvalRequests={openApprovalRequests}
                canApprovePermissions={transcriptInteraction.canApprovePermissions}
                permissionDisabledReason={transcriptInteraction.permissionDisabledReason}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                onAcpSessionModeChange={supportsSessionModeOverrides(liveComposerState.agentId) ? updateAcpSessionModeOverride : undefined}
                onSessionConfigOptionChange={updateSessionConfigOptionOverride}
                acpConfigOptionOverridesOverride={optimisticSessionConfigOptionOverrides}
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
                statusBadges={agentInputStatusBadges}
                providerUsageGauge={providerUsageGauge}
                onProviderUsageRecoveryCreditPress={providerUsageRecoveryCreditAction}
                providerUsageRecoveryCreditPending={providerUsageRecoveryCreditActionPending}
                activeStatusBadgeKey={activeStatusBadgeKey}
                onActiveStatusBadgeKeyChange={setActiveStatusBadgeKey}
                connectedServicesRestartState={sessionConnectedServicesAuthSwitch.restartState}
                onSend={handleAgentInputSend}
                isSendDisabled={!shouldShowInput || isResuming || isReadOnly || isUploadingAttachments}
                isSending={isComposerSendPending}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                onAbort={handleAgentInputAbort}
                inactiveStatusText={inactiveStatusText}
                onFileViewerPress={handleAgentInputFileViewerPress}
                // Autocomplete configuration
                autocompleteKinds={SESSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={handleAutocompleteSuggestions}
                disabled={isReadOnly}
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

    const transcriptSelectionToolbar = transcriptMessageSelectionEnabled === true ? (
        <TranscriptSelectionToolbarController
            sessionId={sessionId}
            metadata={session.metadata}
            bulkCopyFormat={transcriptBulkCopyFormat}
            roleLabels={transcriptSelectionRoleLabels}
            sendToSessionEnabled={transcriptMessageSendToSessionEnabled === true && sessionRouteServerId.trim().length > 0}
            maxWidth={layout.maxWidth}
            onSendToSession={handleSendSelectedTranscriptMessages}
        />
    ) : null;
    const inputWithTranscriptSelection = transcriptSelectionToolbar || input ? (
        <View style={{ gap: 8 }}>
            {transcriptSelectionToolbar}
            {input}
        </View>
    ) : null;

    const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.trunc(event.nativeEvent.layout.width);
        if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
        // Persist the measured width against the stable pane surface so the next session switch can
        // seed its first frame with this settled width instead of falling back to the window width.
        rememberSessionViewContentWidth({
            surfaceId: contentWidthSurfaceId,
            measuredWidthPx: nextWidth,
            windowWidthPx: windowWidth,
        });
        setMeasuredContentWidth((currentWidth) => (
            currentWidth === nextWidth ? currentWidth : nextWidth
        ));
    }, [contentWidthSurfaceId, windowWidth]);
    // On web the browser owns the safe area geometry (the visual viewport already
    // reflects safe-area and keyboard). Re-adding the same safe-area inset to the
    // session's bottom spacing leaves an oversized gap below the composer and corrupts
    // keyboard geometry on mobile web. Native platforms still must clear their insets
    // explicitly at this border.
    const sessionContentSafeAreaBottom = Platform.OS === 'web' ? 0 : safeArea.bottom;
    const contentPaddingBottom = resolveSessionViewContentBottomSpacing({
        chatBottomSpacing,
        safeAreaBottomPx: sessionContentSafeAreaBottom,
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
    const agentContentSafeAreaBottom = chatBottomSpacing === 'none' || Platform.OS === 'web' ? 0 : safeArea.bottom;

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
                        backgroundColor: theme.colors.state.warning.background,
                        borderWidth: 1,
                        borderColor: theme.colors.state.warning.border,
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                    }}
                >
                    <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.state.warning.foreground,
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Icon name="x" size={14} color={theme.colors.state.warning.foreground} style={{ marginLeft: 8 }} />
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
                <TranscriptMessageSelectionProvider
                    sessionId={sessionId}
                    eligibleMessageIdsInOrder={transcriptSelectionEligibleMessageIds}
                    enabled={transcriptMessageSelectionEnabled === true && !isEncryptedSessionLocked}
                >
                    <SessionViewedLifecycle
                        sessionId={sessionId}
                        serverId={session.serverId ?? sessionRouteServerId}
                        latestTurnStatus={session.latestTurnStatus}
                        surfaceFocused={surfaceFocused}
                    />
                    <SessionTranscriptAgentContentView
                        sessionId={sessionId}
                        session={session}
                        isEncryptedSessionLocked={isEncryptedSessionLocked}
                        isForkedSessionV1={isForkedSessionV1}
                        isLocallyAttached={isLocallyAttached}
                        pendingMessagesCount={pendingMessages.length}
                        content={content}
                        input={inputWithTranscriptSelection}
                        placeholder={placeholder}
                        safeAreaBottom={agentContentSafeAreaBottom}
                    />
                </TranscriptMessageSelectionProvider>
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
	                            backgroundColor: Color(theme.colors.chrome.header.background).alpha(0.9).rgb().string(),
	                            alignItems: 'center',
	                            justifyContent: 'center',
	                            ...shadowLevelStyle(theme.colors.shadowLevels[4]),
                        }}
                        hitSlop={15}
                    >
                        <Icon
                            name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.text.primary}
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
