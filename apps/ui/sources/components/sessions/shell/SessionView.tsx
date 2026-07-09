import {
    AgentInput,
    type AgentInputAutocompleteSelectionHandler,
    type AgentInputSendOptions } from '@/components/sessions/agentInput';
import {
    computeExistingSessionComposerInputMaxHeight,
    computeExistingSessionComposerPanelMaxHeight,
    } from '@/components/sessions/agentInput/inputMaxHeight';
import {
    useComposerAvailablePanelHeight,
    useComposerKeyboardLayoutContext,
    } from '@/components/sessions/keyboardAvoidance';
import type { AgentInputAttachment,
    AgentInputExtraActionChip,
    AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentFilePickerHandle,
    PickedAttachment } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import { openAttachmentFilePickerFiles,
    openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionAgentInputExtraActionChips } from '@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips';
import { useSessionConnectedServicesAuthSwitch } from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';
import {
    deriveSessionIntentionalRestartSignals,
    resolveSessionIntentionalRestartRecoveryEvidenceAtMs,
    type SessionIntentionalRestartSignal,
    type SessionIntentionalRestartSourceEvent,
    } from '@/components/sessions/agentInput/hooks/sessionIntentionalRestartSignal';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { ChatList,
    type TranscriptViewportChangeState } from '@/components/sessions/transcript/ChatList';
import { applyTranscriptJumpHighlightForJumpResult } from '@/components/sessions/transcript/navigation/transcriptJumpHighlightStore';
import type { PendingMessageEditRequest } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { TranscriptMessageSelectionProvider } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbarController } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbarController';
import type { TranscriptSelectionToolbarMessage } from '@/components/sessions/transcript/messageSelection/TranscriptSelectionToolbar';
import { appendTranscriptSelectionToNewSessionDraft } from '@/components/sessions/transcript/messageSelection/appendTranscriptSelectionToNewSessionDraft';
import { openTranscriptSendToSessionModal } from '@/components/sessions/transcript/messageSelection/openTranscriptSendToSessionModal';
import { sendTranscriptSelectionToSession } from '@/components/sessions/transcript/messageSelection/sendTranscriptSelectionToSession';
import { useTranscriptSelectionEligibleMessageIds } from '@/components/sessions/transcript/messageSelection/useTranscriptSelectionEligibleMessageIds';
import { EmptyMessages } from '@/components/ui/empty/EmptyMessages';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { useDraft } from '@/hooks/session/useDraft';
import {
    captureComposerTransientInputStateForOutboundHandoff,
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from '@/hooks/session/sessionComposerSendCoordinator';
import { useSessionAgentInputComposerPersistence } from '@/hooks/session/useSessionAgentInputComposerPersistence';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { continueSessionWithReplay,
    sessionAbort,
    resumeSession } from '@/sync/ops';
import { storage,
    useActiveServerAccountScope,
    useEnabledAutomationsCountForSession,
    useEndpointConnectivity,
    useIsDataReady,
    useLocalSetting,
    useOpenApprovalArtifactsForSession,
    useProfile,
    useRealtimeStatus,
    useSessionMessages,
    useSessionPendingMessages,
    useSessionSubagentSourceMessages,
    useSessionTranscriptIds,
    useSessionUsage,
    useSessionVisibleReadSeq,
    useSetting,
    useSettingMutable,
    useSettings,
    useSyncError,
    useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { canContinueSessionWithFreshSpawn,
    canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { getAgentCore,
    resolveAgentIdFromFlavor,
    buildResumeSessionExtrasFromUiState,
    } from '@/agents/catalog/catalog';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    evaluateAgentSessionCapabilitySupport,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import { Session, type Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { resolvePromptInvocationAutocompleteSelection } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import {
    clearSessionDraftValue,
    clearSessionDraftValuesForSession,
    flushSessionDraftValues,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import {
    supportsSessionModeOverrides, } from '@/sync/domains/sessionControl/sessionModeControl';
import { t, tLoose, type TranslationKey } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { getSessionName, listPendingPermissionRequests, shouldReadTranscriptForPendingRequests, shouldShowAbortButtonForSessionState, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { nativeReadClipboardImageAttachment } from '@/utils/files/nativeClipboardImageAttachment';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { useSessionRecipientState } from '@/components/sessions/agentInput/routing/useSessionRecipientState';
import {
    resolveParticipantRoutedSend, } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { useSessionAgentInputRoutingControls } from '@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import {
    hasBrowserContextComposerAttachments,
    mergeBrowserContextMessageMetaOverrides,
} from '@/sync/domains/session/input/browserContext';
import {
    SessionBrowserContextRuntimeProvider,
    type SessionBrowserContextRuntime,
    useSessionBrowserContextRuntime,
} from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { hasSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { nowServerMs } from '@/sync/runtime/time';
import { readSessionUiTelemetryNowMs } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import {
    isEmptyPendingMessageComposerSemanticDraftSnapshot,
    type PendingMessageComposerEditState,
    type PendingMessageComposerSemanticDraftSnapshot as ComposerSemanticDraftSnapshot,
} from './pendingMessageComposerEditSnapshot';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import { resolveNonSteerableSendPlan } from '@/components/sessions/agentInput/nonSteerableSendPreflight';
import { createSyncBackedSubmitPort } from '@/sync/domains/session/input/syncBackedSubmitPort';
import type { SessionSubmitPort } from '@/sync/domains/session/input/types';
import {
    normalizeUsageLimitRecoverySettings,
    updateUsageLimitRecoveryRememberedMode,
} from '@/sync/domains/settings/usageLimitRecoverySettings';
import { isSessionLocallyAttached } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionSubagentCounts } from '@/sync/domains/session/subagents/deriveSessionSubagentCounts';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useUnistyles } from 'react-native-unistyles';
import { sessionSwitch } from '@/sync/ops';
import { shouldRenderChatTimelineForSession, shouldRequestRemoteControl, shouldRequestRemoteControlAfterPendingEnqueue } from '@/sync/domains/session/control/localControlSwitch';
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
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { executeSessionComposerResolution } from '@/sync/domains/input/slashCommands/executeSessionComposerResolution';
import {
    SESSION_WORK_STATE_STATUS_BADGE_KEY,
} from '@/components/sessions/workState/sessionWorkStatePresentation';
import {
    resolveSessionActivityStatusBadgePresentation,
    shouldRetainSessionActivityStatusBadge,
} from '@/components/sessions/workState/sessionActivityPresentation';
import { useSessionWorkflowActivity } from '@/components/sessions/workState/useSessionWorkflowActivity';
import {
    STALE_SESSION_RUNNER_STATUS_BADGE_KEY,
    buildStaleSessionRunnerNoticePresentation,
    type StaleSessionRunnerOperationStatus,
} from '@/components/sessions/sessionRunner/staleSessionRunnerNoticePresentation';
import { readActionableStaleSessionRunnerRuntimeState } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus';
import {
    getSessionRunnerRuntimeStatus,
    restartSessionRunnerOnCurrentRuntime,
} from '@/sync/ops/sessionRunnerRestart';
import {
    readSessionWorkStateFromMetadata,
    resolvePrimarySessionWorkStateItem,
} from '@/sync/domains/session/workState/readSessionWorkState';
import { SessionWorkStatePopover } from '@/components/sessions/workState/SessionWorkStatePopover';
import { isSessionGoalEditingAvailable } from '@/components/sessions/workState/sessionGoalEditingAvailability';
import { createGoalActionChip } from '@/components/sessions/agentInput/definitions/createGoalActionChip';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveSessionActionDefaultBackendTitle } from '@/sync/domains/session/resolveSessionActionDefaultBackendTitle';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import {
    clearSessionAttachmentDrafts,
    readSessionAttachmentDrafts,
    writeSessionAttachmentDrafts,
} from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { buildAttachmentMessageMeta, formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { Text } from '@/components/ui/text/Text';
import { sessionGoalClear, sessionGoalSet } from '@/sync/ops/sessionGoals';
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
import { resolveSessionGoalActionCapabilityProfile, supportsEditableSessionGoals } from '@/agents/registry/registryUiBehavior';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import {
    ConnectedServiceIdSchema,
    SESSION_RUNNER_RUNTIME_METADATA_KEY,
    type ConnectedServiceQuotaSnapshotV1,
    isHiddenSystemSession,
    removeSessionPendingQueueHoldV1FromMetadata,
    type SessionRunnerRuntimeStateV1,
    writeSessionPendingQueueHoldV1ToMetadata,
} from '@happier-dev/protocol';
import { useSessionViewBootstrap } from './view/useSessionViewBootstrap';
import { useSessionViewedLifecycle } from './view/useSessionViewedLifecycle';
import {
    resolveMobileWorkspaceExperienceToggleActionId,
} from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { SessionViewLayout, type SessionViewLayoutProps } from './view/SessionViewLayout';
import { ComposerAuxiliaryFrame } from './view/ComposerAuxiliaryFrame';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { WarningActionBanner } from './view/WarningActionBanner';
import { combineSessionViewExtraActionChips } from './view/combineSessionViewExtraActionChips';
import { resolveSessionViewModeOptionIds } from './view/resolveSessionViewModeOptionIds';
import { resolveSessionViewHeaderProps } from './view/resolveSessionViewHeaderProps';
import { useScopedPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveSessionPluginSurfaceRightTabId } from '@/components/sessions/actions/pluginHeaderActions';
import { resolveSessionViewDirectControlFooter } from './view/resolveSessionViewDirectControlFooter';
import { resolveSessionViewRuntimeDisplayState } from './view/resolveSessionViewRuntimeDisplayState';
import { resolveSessionViewConnectionStatus } from './view/resolveSessionViewConnectionStatus';
import { resolveSessionViewMicButtonState } from './view/resolveSessionViewMicButtonState';
import { isSessionRootRoutePathActive, isSessionRoutePathActive } from './view/isSessionRoutePathActive';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { useSessionReachableMachineTarget } from '../model/useSessionMachineReachability';
import { useSessionMachineControlTarget } from '../model/useSessionMachineTarget';
import { mergeMessageMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import {
    resolveSessionAuthSurfaceState,
    type SessionAuthSurfaceState,
} from './sessionAuthSurfaceState';
import { useSessionViewShellSession, useSessionViewShellSessionSeq } from './sessionViewStableSession';
import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY,
    buildSessionUsageLimitRecoveryPresentation,
    isSessionUsageLimitRecoveryCheckNowAction,
    isSessionUsageLimitRecoveryCheckingOperationAction,
    readSessionUsageLimitRecoveryFromMetadata,
    type SessionUsageLimitRecoveryActionKind,
    type SessionUsageLimitRecoveryTranslate,
    type SessionUsageLimitRecoveryTranslationParams,
    type SessionUsageLimitRecoveryState,
    type UsageLimitRecoveryOperationStatus,
    type UsageLimitRecoverySettings,
} from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryPresentation';
import { hasMeaningfulActivityAfterRuntimeIssue } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitActivityStaleness';
import { formatUsageLimitRecoveryOperationError } from '@/components/sessions/usageLimitRecovery/formatUsageLimitRecoveryOperationError';
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
import {
    connectedServiceQuotaRecoveryCreditConsume,
} from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    selectConnectedServiceSessionProviderUsageSnapshot,
    summarizeConnectedServiceQuotaRecoveryCredits,
    type ConnectedServiceQuotaGaugeLabelFormatter,
    type ConnectedServiceQuotaGaugeWindowMode,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    computeProviderAccountUsageGaugeViewModel,
    selectProviderUsageDisplaySource,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors';
import {
    SPAWN_SESSION_ERROR_CODES,
    readProviderAccountUsageRecordIdsFromMetadata,
    readSessionContinuationRecoveryFromMetadata,
} from '@happier-dev/protocol';
import { resolveConnectedServiceQuotaProfileRefForSession } from './resolveConnectedServiceQuotaProfileRefForSession';

export { resolveSessionAuthSurfaceState } from './sessionAuthSurfaceState';

const SESSION_COMPOSER_AUTOCOMPLETE_PREFIXES: string[] = ['@', '/', '$'];
const MAX_USAGE_LIMIT_RECOVERY_READY_TIMER_MS = 2_147_483_647;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS = 2 * 60 * 1000;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_REFRESH_MS = 30 * 1000;

function areSemanticDraftValuesEqual(
    left: ComposerSemanticDraftSnapshot,
    right: ComposerSemanticDraftSnapshot,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsageLimitRecoveryResetAtMs(params: Readonly<{
    issue: unknown;
    recoveryState: SessionUsageLimitRecoveryState | null;
}>): number | null {
    const recoveryResetAtMs = readFiniteNumber(params.recoveryState?.resetAtMs);
    if (recoveryResetAtMs !== null) return recoveryResetAtMs;
    const issue = readObjectRecord(params.issue);
    const usageLimit = readObjectRecord(issue?.usageLimit);
    return readFiniteNumber(usageLimit?.resetAtMs);
}

function connectedServiceQuotaSnapshotMatchesProfileRef(
    snapshot: ConnectedServiceQuotaSnapshotV1 | null | undefined,
    profileRef: Readonly<{ serviceId: string; profileId: string }> | null | undefined,
): boolean {
    return Boolean(
        snapshot
        && profileRef
        && snapshot.serviceId === profileRef.serviceId
        && snapshot.profileId === profileRef.profileId,
    );
}

const translateUsageLimitRecoveryPresentationKey: SessionUsageLimitRecoveryTranslate = (key, ...params) => {
    if (key === 'session.usageLimitRecovery.banner.resetCreditSummary') {
        const [resetCreditSummaryParams] = params as [
            SessionUsageLimitRecoveryTranslationParams['session.usageLimitRecovery.banner.resetCreditSummary'],
        ];
        return t('session.usageLimitRecovery.banner.resetCreditSummary', resetCreditSummaryParams);
    }
    return tLoose(key);
};

function isUsageLimitRecoverySwitchAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'switch_fallback_now'
        || kind === 'switch_account_now';
}

function formatResumeSessionFailureMessage(result: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
}>): string {
    const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
    if (errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED) {
        return t('session.resumeFailed');
    }

    const message = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
    return message || t('session.resumeFailed');
}

function hasContinuationRecoveryWorkToResume(metadata: unknown): boolean {
    const recovery = readSessionContinuationRecoveryFromMetadata(metadata);
    if (!recovery) return false;
    return Object.values(recovery.attemptsById).some((attempt) => {
        if (attempt.continuationRequired === false) return false;
        return attempt.status !== 'suppressed_no_interrupted_turn'
            && attempt.status !== 'suppressed_newer_user_input';
    });
}

type UsageLimitRecoveryDiagnosticProfileActionRoute = Readonly<{
    pathname: '/settings/connected-services/oauth';
    params: Readonly<{
        serviceId: string;
        profileId: string;
    }>;
}>;

function readUsageLimitRecoveryDiagnosticProfileActionRoute(
    result: SessionUsageLimitRecoveryOperationFailureResult,
): UsageLimitRecoveryDiagnosticProfileActionRoute | null {
    const rawServiceId = typeof result.uxDiagnostic?.serviceId === 'string'
        ? result.uxDiagnostic.serviceId.trim()
        : '';
    const serviceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
    if (!serviceId.success) return null;

    const profileId = typeof result.uxDiagnostic?.profileId === 'string'
        ? result.uxDiagnostic.profileId.trim()
        : '';
    if (!profileId) return null;

    return {
        pathname: '/settings/connected-services/oauth',
        params: {
            serviceId: serviceId.data,
            profileId,
        },
    };
}

function isUsageLimitRecoveryResolvedStatus(
    status: SessionUsageLimitRecoveryOperationResult['status'] | undefined,
): boolean {
    return status === 'ready'
        || status === 'resumed'
        || status === 'cancelled'
        || status === 'already_ready'
        || status === 'no_recovery_needed'
        || status === 'switch_applied'
        || status === 'switch_observed';
}

function readUsageLimitRecoveryDisplayStatus(
    status: SessionUsageLimitRecoveryOperationResult['status'] | undefined,
): UsageLimitRecoveryOperationStatus | null {
    if (status === 'waiting'
        || status === 'exhausted'
        || status === 'inactive'
    ) {
        return status;
    }
    if (status === 'rate_limited') return 'waiting';
    return null;
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

function SessionAuthRecoveryBanner({ message }: Readonly<{ message: string }>) {
    const router = useRouter();

    return (
        <WarningActionBanner
            testID="session-auth-sync-error"
            actionTestID="session-auth-sync-error-restore"
            title={t('connect.restoreAccount')}
            body={message}
            actionLabel={t('connect.restoreAccount')}
            actionAccessibilityLabel={t('connect.restoreAccount')}
            onActionPress={() => router.push('/restore')}
        />
    );
}

const MemoizedSessionViewLoaded = React.memo(SessionViewLoaded);

type SessionViewProps = Readonly<{
    id: string;
    routeServerId?: string | null;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocusedOverride?: boolean | null;
    surfaceVisibleOverride?: boolean | null;
    routeAnchorOverride?: boolean | null;
    routeHydrationState?: SessionRouteHydrationState | null;
    contentOverride?: React.ReactNode;
    safeAreaTopMode?: 'internal' | 'external';
    headerSafeAreaTopMode?: 'internal' | 'external';
    chatBottomSpacing?: 'default' | 'none';
    browserContextStateForComposer?: BrowserContextState | null;
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

const SessionContentOverrideViewedLifecycle = React.memo(function SessionContentOverrideViewedLifecycle({
    sessionId,
    surfaceFocused,
}: Readonly<{
    sessionId: string;
    surfaceFocused: boolean;
}>) {
    const sessionSeq = useSessionViewShellSessionSeq(sessionId);
    useSessionViewedLifecycle({
        sessionId,
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
    sessionId,
    latestTurnStatus,
    surfaceFocused,
}: Readonly<{
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
        sessionId,
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
        isForkedSessionV1 || ((session.seq ?? 0) > 0 && committedMessageIds.length === 0);
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

type SessionTranscriptContentProps = Readonly<{
    sessionId: string;
    session: Session;
    isEncryptedSessionLocked: boolean;
    isForkedSessionV1: boolean;
    isLocallyAttached: boolean;
    pendingMessagesCount: number;
    loadingColor: string;
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
    loadingColor,
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
    const shouldRenderChatTimelineImmediately = shouldRenderChatTimeline
        && (
            isLoaded === true
            || committedMessagesCount > 0
            || pendingMessagesCount > 0
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

    return (
        <>
            {shouldRenderChatTimeline && shouldRenderChatTimelineImmediately ? (
                <ChatList
                    session={session}
                    bottomNotice={bottomNotice}
                    controlledByUserOverride={controlledByUserOverride}
                    controlSwitchTo={controlSwitchTo}
                    onRequestSwitchToRemote={onRequestSwitchToRemote}
                    directControlFooter={directControlFooter}
                    jumpToSeq={jumpToSeq}
                    followBottomIntentKey={followBottomIntentKey}
                    approvalRequests={approvalRequests}
                    onViewportChange={onViewportChange}
                    onEditPendingMessage={onEditPendingMessage}
                    onJumpLanded={handleTranscriptJumpLanded}
                    routeHydrationPending={routeHydrationPending}
                />
            ) : null}
            {shouldShowDeferredTranscriptPlaceholder ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner size="small" color={loadingColor} />
                </View>
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

export const SessionView = React.memo((props: SessionViewProps) => {
    const sessionId = normalizeSessionId(props.id);
    const routeFocused = useSessionScreenIsFocused();
    const pathname = usePathname();
    const isFocused = typeof props.surfaceFocusedOverride === 'boolean'
        ? props.surfaceFocusedOverride
        : routeFocused;
    const isSurfaceVisible = typeof props.surfaceVisibleOverride === 'boolean'
        ? props.surfaceVisibleOverride
        : true;
    const isRouteAnchor = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : isSessionRoutePathActive(pathname, sessionId);

    if ((!isFocused && !isRouteAnchor) || !isSurfaceVisible) {
        return <View style={{ flex: 1 }} />;
    }

    return (
        <SessionViewFocusedSurface
            {...props}
            sessionId={sessionId}
            isFocused={isFocused}
            isSurfaceVisible={isSurfaceVisible}
        />
    );
});

const SessionViewFocusedSurface = React.memo((props: SessionViewProps & {
    sessionId: string;
    isFocused: boolean;
    isSurfaceVisible: boolean;
}) => {
    const sessionId = props.sessionId;
    const isFocused = props.isFocused;
    const isSurfaceVisible = props.isSurfaceVisible;
    const router = useRouter();
    const pathname = usePathname();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const auth = useAuth();
    const routeHydrationState = props.routeHydrationState ?? null;
    const expectedRouteServerId = routeHydrationState?.serverId ?? props.routeServerId ?? null;
    const session = useSessionViewShellSession(sessionId, expectedRouteServerId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
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
        session?.serverId ?? null,
    );
    const approvalRequests = useOpenApprovalArtifactsForSession(sessionId);
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
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeSessionRoute = isSessionRoutePathActive(pathname, sessionId);
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
    const shouldRenderSessionSurface = (isFocused || isActiveSessionRoute) && isSurfaceVisible;
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
        serverId: session?.serverId ?? currentSessionRouteServerId,
        paneScopeId,
        paneUrlState: props.paneUrlState ?? null,
        multiPaneEnabled,
        sessionsRightPaneDefaultOpen: sessionsRightPaneDefaultOpen === true,
        deviceType,
        sessionPath: session?.metadata?.path ?? null,
        sessionAccepted: session != null,
        surfaceFocused: isFocused,
        surfaceRetained: shouldRetainSessionSurface,
        surfaceVisible: isSurfaceVisible,
        routeAnchor: isActiveSessionRoute,
        paneUrlSyncRouteActive: isPaneUrlSyncRouteActive,
    });
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const subagentSourceMessages = useSessionSubagentSourceMessages(acceptedSessionId);
    const stableSessionForLoadedView = session;
    const stableSessionForHeader = stableSessionForLoadedView ?? session;
    const externalSessionRuntime = useExternalSessionRuntime({
        sessionId: acceptedSessionId,
        metadata: session?.metadata ?? null,
        enabled: isSurfaceFocused && session != null,
    });
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntime({
        enabled: browserContextFeatureEnabled && isSurfaceFocused && session != null,
        scopeKey: acceptedSessionId,
        nowMs: nowServerMs,
        onAttachUnavailable: React.useCallback(() => {
            Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
        }, []),
    });
    const { subagents, participantTargets } = useSessionSubagents({
        sessionId: acceptedSessionId,
        session,
        messages: session ? subagentSourceMessages : [],
        externalSessionRuntime,
    });
    const subagentCounts = deriveSessionSubagentCounts(subagents);
    const shouldShowSubagentsButton = subagentCounts.total > 0 || sessionExecutionRunsSupported || hasSessionSubagentLaunchCards(session);

    const sessionAutomationsEnabledCount = useEnabledAutomationsCountForSession(sessionId, {
        enabled: showAutomations,
    });
    const paneRef = React.useRef(pane);
    paneRef.current = pane;
    const routerRef = React.useRef(router);
    routerRef.current = router;
    const toggleWorkspaceExperienceRef = React.useRef(toggleWorkspaceExperience);
    toggleWorkspaceExperienceRef.current = toggleWorkspaceExperience;

    const constrainHeaderWidth = !(multiPaneEnabled
        && Platform.OS === 'web'
        && ((pane.scopeState?.right.isOpen ?? false) || (pane.scopeState?.details.isOpen ?? false)));

    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === 'header.openSubagents') {
            paneRef.current.openRight({ tabId: 'agents' });
            paneRef.current.setRightTab('agents');
            return true;
        }
        if (actionId === 'header.openRuns') {
            routerRef.current.push(buildCurrentSessionHref('/runs') as any);
            return true;
        }
        if (actionId === 'header.openAutomations') {
            navigateWithBlurOnWeb(() => routerRef.current.push(buildCurrentSessionHref('/automations') as any));
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
    }, [buildCurrentSessionHref, mobileWorkspaceExperience, pathname, sessionId, showWorkspaceExperienceToggle]);

    const headerMenuExtraItems = React.useMemo(() => {
        if (!showWorkspaceExperienceToggle) {
            return undefined;
        }
        return [{
            id: resolveMobileWorkspaceExperienceToggleActionId(mobileWorkspaceExperience),
            title: t(workspaceExperienceToggleLabelKey),
            icon: <Ionicons name="swap-horizontal-outline" size={18} color={theme.colors.text.secondary} />,
        }];
    }, [mobileWorkspaceExperience, showWorkspaceExperienceToggle, theme.colors.text.secondary, workspaceExperienceToggleLabelKey]);

    const headerWorkspaceDisplay = React.useMemo(() => resolveSessionWorkspaceDisplayPresentation({
        serverId: currentSessionRouteServerId,
        metadata: stableSessionForHeader?.metadata ?? null,
        machineTarget: headerMachineTarget,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
    }), [currentSessionRouteServerId, headerMachineTarget, stableSessionForHeader?.metadata, workspaceRefsV1]);

    // Phase 2.2 — plugin-UI projection + open handler for the session header
    // action menu (closing finding #11; the header action menu was previously
    // mounted without a projection so plugin-contributed header actions were
    // inert). Scoped to the session's reachable machine, matching the right
    // sidebar's plugin projection scope.
    const headerPluginProjection = useScopedPluginUiProjection({
        machineId: headerMachineTarget?.machineId ?? null,
        serverId: currentSessionRouteServerId,
    });
    const handleOpenSessionPluginSurface = React.useCallback((surfaceId: string) => {
        const tabId = resolveSessionPluginSurfaceRightTabId({
            projection: headerPluginProjection.pluginUiProjection,
            surfaceId,
        });
        if (!tabId) {
            return;
        }
        paneRef.current.openRight({ tabId });
        paneRef.current.setRightTab(tabId);
    }, [headerPluginProjection.pluginUiProjection]);

    // Compute header props based on session state
    const headerProps = React.useMemo(() => resolveSessionViewHeaderProps({
        isDataReady,
        routeHydrationState,
        session: stableSessionForHeader,
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
        router: routerRef.current,
        actionIconColor: theme.colors.text.secondary,
        headerTintColor: theme.colors.chrome.header.foreground,
        statusErrorColor: theme.colors.status.error,
        workspaceSubtitle: headerWorkspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: headerWorkspaceDisplay.subtitleEllipsizeMode,
        pluginUiProjection: headerPluginProjection.pluginUiProjection,
        onOpenPluginSurface: handleOpenSessionPluginSurface,
    }), [
        buildCurrentSessionHref,
        handleHeaderExtraItemSelect,
        handleOpenSessionPluginSurface,
        headerPluginProjection.pluginUiProjection,
        headerWorkspaceDisplay.displayTitle,
        headerWorkspaceDisplay.subtitleEllipsizeMode,
        headerMenuExtraItems,
        isDataReady,
        paneScopeId,
        routeHydrationState,
        stableSessionForHeader,
        sessionAutomationsEnabledCount,
        sessionExecutionRunsSupported,
        sessionId,
        shouldShowSubagentsButton,
        showAutomations,
        subagentCounts.active,
        theme.colors.chrome.header.foreground,
        theme.colors.status.error,
        theme.colors.text.secondary,
        windowWidth,
    ]);

    const browserContextStateForComposer = props.browserContextStateForComposer
        ?? sessionBrowserContextRuntime?.state
        ?? null;
    const browserContextComposerContext = props.browserContextStateForComposer == null
        ? sessionBrowserContextRuntime?.composerContext ?? null
        : null;

    return (
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
                        sessionId={sessionId}
                        surfaceFocused={isSurfaceVisible && isFocused}
                    />
                ) : (
                    <SessionTranscriptViewedLifecycle
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
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeAreaTopInset,
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
                        constrainWidth={constrainHeaderWidth}
                        includeTopInset={headerSafeAreaTopMode !== 'external'}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: showTopHeader && shouldRenderSessionSurface ? safeAreaTopInset + headerHeight : 0 }}>
                {!shouldRenderSessionSurface ? null : !session && authSurfaceState ? (
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
                        <Ionicons name="trash-outline" size={48} color={theme.colors.text.secondary} />
                        <Text style={{ color: theme.colors.text.primary, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.text.secondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                  ) : props.contentOverride ? (
                      props.contentOverride
                  ) : !session ? (
                      null
                  ) : (
                      // Normal session view
                       <MemoizedSessionViewLoaded
                           authSurfaceState={authSurfaceState}
                           key={sessionId}
                           sessionId={sessionId}
                           routeServerId={currentSessionRouteServerId}
                           session={stableSessionForLoadedView ?? session}
                           pane={pane}
                           isMachineReachable={isMachineReachable}
                           onBackPress={handleBackPress}
                           isEncryptedSessionLocked={isEncryptedSessionLocked}
                           executionRunsEnabled={executionRunsEnabled}
                           jumpToSeq={props.jumpToSeq ?? null}
                           participantTargets={participantTargets}
                           approvalRequests={approvalRequests}
                           paneUrlState={props.paneUrlState ?? null}
                           initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                           browserContextStateForComposer={browserContextStateForComposer}
                           browserContextComposerContext={browserContextComposerContext}
                           paneScopeId={paneScopeId}
                           pendingMessages={pendingMessages}
                           externalSessionRuntime={externalSessionRuntime}
                           chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                           routeHydrationPending={routeHydrationPending}
                       />
                  )}
            </View>
        </SessionScreenTestIdsProvider>
        </SessionExternalSessionRuntimeProvider>
        </SessionBrowserContextRuntimeProvider>
    );
});

function hasSessionWriteAccess(accessLevel: Session['accessLevel']): boolean {
    return !accessLevel || accessLevel === 'edit' || accessLevel === 'admin';
}

function SessionViewLoaded({
    authSurfaceState,
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
    approvalRequests,
    paneUrlState,
    initialAttachmentDrafts,
    browserContextStateForComposer,
    browserContextComposerContext,
    paneScopeId,
    pendingMessages,
    externalSessionRuntime,
    chatBottomSpacing,
    routeHydrationPending,
}: {
    authSurfaceState: SessionAuthSurfaceState | null;
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
    approvalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    browserContextStateForComposer: BrowserContextState | null;
    browserContextComposerContext: SessionBrowserContextRuntime['composerContext'] | null;
    paneScopeId: string;
    pendingMessages: readonly PendingMessage[];
    externalSessionRuntime: ReturnType<typeof useExternalSessionRuntime>;
    chatBottomSpacing: 'default' | 'none';
    routeHydrationPending: boolean;
}) {
    const { theme } = useUnistyles();
    const applyLocalSettings = useApplyLocalSettings();
    const router = useRouter();
    const pathname = usePathname();
    const safeArea = useChromeSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const scaffoldAvailablePanelHeight = useComposerAvailablePanelHeight();
    const keyboardHeight = useComposerKeyboardHeight();
    const composerAvailablePanelHeight = scaffoldAvailablePanelHeight ?? windowHeight;
    const maxAgentInputPanelHeight = React.useMemo(
        () => computeExistingSessionComposerPanelMaxHeight({
            availablePanelHeight: composerAvailablePanelHeight,
            viewportHeight: windowHeight,
        }),
        [composerAvailablePanelHeight, windowHeight],
    );
    const collapsedAgentInputTextHeight = React.useMemo(
        () => computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: composerAvailablePanelHeight,
            expanded: false,
            keyboardHeight,
            viewportHeight: windowHeight,
        }),
        [composerAvailablePanelHeight, keyboardHeight, windowHeight],
    );
    const expandedAgentInputTextHeight = React.useMemo(
        () => computeExistingSessionComposerInputMaxHeight({
            availablePanelHeight: composerAvailablePanelHeight,
            expanded: true,
            keyboardHeight,
            viewportHeight: windowHeight,
        }),
        [composerAvailablePanelHeight, keyboardHeight, windowHeight],
    );
    // Treat multi-pane panels as enabled unless explicitly disabled. `useLocalSetting` can return
    // `undefined` during hydration; failing closed here causes deep links like `?right=git` to be
    // ignored and makes the UI feel broken on first load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const [message, setMessage] = React.useState('');
    const rawUiFontScale = useLocalSetting('uiFontScale');
    const uiFontScale = typeof rawUiFontScale === 'number' ? rawUiFontScale : undefined;
    const inputComposerPersistence = useSessionAgentInputComposerPersistence({
        sessionId,
        text: message,
        textLength: message.length,
        fontScale: uiFontScale,
    });
    const isInputExpanded = inputComposerPersistence.expanded;
    const maxAgentInputTextHeight = isInputExpanded
        ? expandedAgentInputTextHeight
        : collapsedAgentInputTextHeight;
    const inputExpansion = React.useMemo(() => ({
        expanded: isInputExpanded,
        ...(typeof collapsedAgentInputTextHeight === 'number'
            ? { collapsedMaxHeight: collapsedAgentInputTextHeight }
            : {}),
        onToggle: () => {
            inputComposerPersistence.setExpanded((current) => !current);
        },
    }), [collapsedAgentInputTextHeight, inputComposerPersistence, isInputExpanded]);
    const [isComposerSending, setIsComposerSending] = React.useState(false);
    const realtimeStatus = useRealtimeStatus();
    const shouldReadTranscript = shouldReadTranscriptForPendingRequests(session);
    const { messages: committedMessages } = useSessionMessages(sessionId, { enabled: shouldReadTranscript });
    const pendingPermissionRequests = React.useMemo(
        () => listPendingPermissionRequests(session, shouldReadTranscript ? committedMessages : undefined),
        [committedMessages, session, shouldReadTranscript],
    );
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const forkV1 = session.metadata?.forkV1;
    const isForkedSessionV1 =
        forkV1?.v === 1 &&
        typeof forkV1.parentSessionId === 'string' &&
        forkV1.parentSessionId.trim().length > 0;
    const reachableMachineTarget = useSessionReachableMachineTarget(sessionId);
    const controlMachineTarget = useSessionMachineControlTarget(sessionId);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = reachableMachineTarget?.machineId ?? session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = Boolean(isCliOutdated && !isAcknowledged);
    const sessionAgentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? null;
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
    const sessionRuntimeStatusSource = useSessionRuntimeStatusSource(session);
    const sessionStatus = useSessionStatus(sessionRuntimeStatusSource, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const sessionUsage = useSessionUsage(sessionId);
    const sessionUsageWithContextWindowTokens = sessionUsage as (typeof sessionUsage & { contextWindowTokens?: number }) | null;
    const latestUsageWithContextWindowTokens = session.latestUsage as (typeof session.latestUsage & { contextWindowTokens?: number }) | null;
    const activeServerId = getActiveServerSnapshot().serverId;
    const capabilityServerId = (routeServerId ?? '').trim() || activeServerId;
    const sessionRouteServerId = (routeServerId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || activeServerId;
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptMessageSendToSessionTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const transcriptSelectionEligibleMessageIds = useTranscriptSelectionEligibleMessageIds(sessionId, {
        enabled: transcriptMessageSelectionEnabled === true,
        metadata: session.metadata,
    });
    const navigateToSession = useNavigateToSession();
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
    const usageLimitRecoveryFeatureEnabled = useFeatureEnabled('sessions.usageLimitRecovery', { scopeKind: 'spawn', serverId: capabilityServerId });
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(sessionId);
    const attachmentsUploadsEnabled = attachmentsUploadsFeatureEnabled && attachmentsUploadsTransferAvailable;
    // Generalized goal umbrella gate (provider-agnostic). The provider-specific discriminator is the
    // capability gate `supportsEditableSessionGoals` (Codex: app-server mode; Claude: observed
    // goal_status + /goal capability), so this stays a single umbrella flag for all providers.
    const agentGoalsFeatureEnabled = useFeatureEnabled('agent.goals');
    const sessionWorkStateSnapshot = React.useMemo(
        () => readSessionWorkStateFromMetadata(session.metadata),
        [session.metadata],
    );
    const primaryWorkStateItem = React.useMemo(
        () => resolvePrimarySessionWorkStateItem(sessionWorkStateSnapshot),
        [sessionWorkStateSnapshot],
    );
    const [activeStatusBadgeKey, setActiveStatusBadgeKey] = React.useState<string | null>(null);
    const [
        collapsedUsageLimitRecoveryIssueFingerprint,
        setCollapsedUsageLimitRecoveryIssueFingerprint,
    ] = React.useState<string | null>(null);
    const [
        collapsedStaleSessionRunnerFingerprint,
        setCollapsedStaleSessionRunnerFingerprint,
    ] = React.useState<string | null>(null);
    const [resolvedStaleSessionRunnerFingerprint, setResolvedStaleSessionRunnerFingerprint] = React.useState<string | null>(null);
    const [staleSessionRunnerOperationStatus, setStaleSessionRunnerOperationStatus] = React.useState<Readonly<{
        fingerprint: string;
        status: StaleSessionRunnerOperationStatus;
    }> | null>(null);
    const hasWriteAccess = hasSessionWriteAccess(session.accessLevel);
    const canEditSessionGoals = React.useMemo(
        () => isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: agentId ? supportsEditableSessionGoals({ agentId, session }) : false,
            goalsFeatureEnabled: agentGoalsFeatureEnabled,
            hasWriteAccess,
        }),
        [agentId, agentGoalsFeatureEnabled, hasWriteAccess, session],
    );
    // Provider goal-action capability profile for the "Set goal" form (no goal item yet). Lets a
    // provider (e.g. Claude) restrict the control surface to edit/clear, hiding the Codex-only budget
    // editor before any native goal exists (QA-CHIP-2). Null → full legacy surface.
    const sessionGoalActionCapabilityProfile = React.useMemo(
        () => (agentId ? resolveSessionGoalActionCapabilityProfile({ agentId, session }) : null),
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
    // UIW1: live workflow activity reader (headline from metadata + durable record detail).
    const sessionWorkflowActivity = useSessionWorkflowActivity({
        sessionId,
        metadata: session.metadata,
    });
    // UIW2: the SINGLE compact above-AgentInput badge seam. Goal/task/todo priority is delegated to
    // the protocol resolver inside `resolveSessionActivityStatusBadgePresentation`; workflow headline
    // composition is layered on top. There is no second badge path that recomputes priority.
    const sessionWorkStateBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        const presentation = resolveSessionActivityStatusBadgePresentation({
            workStateSnapshot: sessionWorkStateSnapshot,
            workflowHeadline: sessionWorkflowActivity.headline,
            loadedWorkflowRunsById: sessionWorkflowActivity.loadedRunsById,
            activeStatusBadgeKey,
            editableGoal: canEditSessionGoals,
            translateWorkState: t,
            translateWorkflow: {
                goalActive: () => t('session.workState.workflow.goalActive'),
                goalLabel: (params) => t('session.workState.workflow.goalLabel', params),
                workflowAgentsFallback: (params) => t('session.workState.workflow.agentsFallback', params),
                workflowBare: () => t('session.workState.workflow.bare'),
                workflowPhaseLabel: (params) => t('session.workState.workflow.phaseLabel', params),
                workflowsPlural: (params) => t('session.workState.workflow.plural', params),
                workflowsPluralWithAgents: (params) => t('session.workState.workflow.pluralWithAgents', params),
                join: (params) => t('session.workState.workflow.join', params),
            },
        });
        if (!presentation) return [];
        const iconName = presentation.iconKind === 'goal'
            ? 'flag-outline'
            : presentation.iconKind === 'workflow'
                ? 'git-network-outline'
                : presentation.iconKind === 'permission'
                    ? 'alert-circle-outline'
                    : 'list-outline';
        return [{
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: presentation.label,
            testID: 'session-work-state-status-badge',
            accessibilityLabel: t('session.workState.accessibilityLabel'),
            tone: presentation.tone,
            emphasis: presentation.emphasis,
            icon: (tint) => <Ionicons name={iconName} size={12} color={tint} />,
            renderPopover: ({ open, anchorRef, onRequestClose }) => (
                <SessionWorkStatePopover
                    open={open}
                    anchorRef={anchorRef}
                    snapshot={sessionWorkStateSnapshot}
                    workflowActivity={sessionWorkflowActivity}
                    editableGoal={canEditSessionGoals}
                    goalActionCapabilityProfile={sessionGoalActionCapabilityProfile}
                    onRequestClose={onRequestClose}
                    onSetGoal={canEditSessionGoals ? setSessionGoalForView : undefined}
                    onClearGoal={canEditSessionGoals ? clearSessionGoalForView : undefined}
                />
            ),
        }];
    }, [activeStatusBadgeKey, canEditSessionGoals, clearSessionGoalForView, sessionGoalActionCapabilityProfile, sessionWorkStateSnapshot, sessionWorkflowActivity, setSessionGoalForView]);
    const usageLimitRecoverySettings: UsageLimitRecoverySettings = React.useMemo(() => {
        const raw = (settings as { usageLimitRecoverySettingsV1?: UsageLimitRecoverySettings }).usageLimitRecoverySettingsV1;
        return normalizeUsageLimitRecoverySettings(raw);
    }, [settings]);
    const [, setUsageLimitRecoverySettings] = useSettingMutable('usageLimitRecoverySettingsV1');
    const usageLimitRecoveryState = React.useMemo(
        () => readSessionUsageLimitRecoveryFromMetadata(session.metadata),
        [session.metadata],
    );
    const staleSessionRunnerMachineId = controlMachineTarget?.machineId ?? machineId ?? null;
    const [fetchedSessionRunnerRuntimeState, setFetchedSessionRunnerRuntimeState] = React.useState<Readonly<{
        sessionId: string;
        machineId: string;
        state: SessionRunnerRuntimeStateV1 | null;
    }> | null>(null);
    React.useEffect(() => {
        const targetMachineId = typeof staleSessionRunnerMachineId === 'string'
            ? staleSessionRunnerMachineId.trim()
            : '';
        if (session.active !== true || !sessionId || !targetMachineId) {
            setFetchedSessionRunnerRuntimeState(null);
            return;
        }

        let cancelled = false;
        void getSessionRunnerRuntimeStatus({
            sessionId,
            machineId: targetMachineId,
            serverId: sessionRouteServerId,
        }).then((state) => {
            if (cancelled) return;
            setFetchedSessionRunnerRuntimeState({
                sessionId,
                machineId: targetMachineId,
                state,
            });
        });
        return () => {
            cancelled = true;
        };
    }, [
        session.active,
        sessionRouteServerId,
        sessionId,
        staleSessionRunnerMachineId,
    ]);
    const staleSessionRunnerMetadata = React.useMemo(() => {
        const targetMachineId = typeof staleSessionRunnerMachineId === 'string'
            ? staleSessionRunnerMachineId.trim()
            : '';
        const fetchedState = fetchedSessionRunnerRuntimeState
            && fetchedSessionRunnerRuntimeState.sessionId === sessionId
            && fetchedSessionRunnerRuntimeState.machineId === targetMachineId
            ? fetchedSessionRunnerRuntimeState.state
            : null;
        if (!fetchedState) return session.metadata;
        return {
            ...(session.metadata ?? {}),
            [SESSION_RUNNER_RUNTIME_METADATA_KEY]: fetchedState,
        };
    }, [
        fetchedSessionRunnerRuntimeState,
        session.metadata,
        sessionId,
        staleSessionRunnerMachineId,
    ]);
    const staleSessionRunnerRuntimeState = React.useMemo(
        () => readActionableStaleSessionRunnerRuntimeState({
            metadata: staleSessionRunnerMetadata,
            sessionActive: session.active === true,
            sessionId,
            machineId: staleSessionRunnerMachineId,
        }),
        [session.active, sessionId, staleSessionRunnerMachineId, staleSessionRunnerMetadata],
    );
    const usageLimitRecoveryResetAtMs = React.useMemo(() => readUsageLimitRecoveryResetAtMs({
        issue: session.lastRuntimeIssue ?? null,
        recoveryState: usageLimitRecoveryState,
    }), [session.lastRuntimeIssue, usageLimitRecoveryState]);
    const [usageLimitRecoveryNowMs, setUsageLimitRecoveryNowMs] = React.useState(() => nowServerMs());
    const [usageLimitRecoveryOperationStatus, setUsageLimitRecoveryOperationStatus] = React.useState<Readonly<{
        issueFingerprint: string;
        status: UsageLimitRecoveryOperationStatus;
    }> | null>(null);
    const [usageLimitRecoveryPendingAction, setUsageLimitRecoveryPendingAction] = React.useState<SessionUsageLimitRecoveryActionKind | null>(null);
    const usageLimitRecoveryPendingActionRef = React.useRef(false);
    const usageLimitRecoveryActionsDisabled = usageLimitRecoveryPendingAction !== null;
    const [resolvedUsageLimitRecoveryIssueFingerprint, setResolvedUsageLimitRecoveryIssueFingerprint] = React.useState<string | null>(null);
    const handleUsageLimitRecoveryResumeNowRef = React.useRef<((opts?: { silent?: boolean }) => Promise<boolean>) | null>(null);
    const usageLimitRecoveryCheckNowAgentId = React.useMemo(() => (
        resolveAgentIdFromFlavor(session.lastRuntimeIssue?.provider)
        ?? resolveAgentIdFromSessionMetadata(session.metadata)
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
    const hasInterruptedWorkToResume = React.useMemo(() => (
        session.active !== true
        || pendingMessages.length > 0
        || hasContinuationRecoveryWorkToResume(session.metadata)
    ), [pendingMessages.length, session.active, session.metadata]);
    const accountProfile = useProfile();
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
            agentId: liveComposerState.agentId ?? '',
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
        })
    ), [accountProfile?.connectedServicesV2, liveComposerState.agentId, session.metadata]);
    const connectedServiceQuotaSnapshots = useConnectedServiceQuotaSnapshots(
        connectedServiceQuotaProfileRef ? [connectedServiceQuotaProfileRef] : [],
    );
    const connectedServiceQuotaProfileKey = connectedServiceQuotaProfileRef
        ? connectedServiceProfileKey(connectedServiceQuotaProfileRef)
        : null;
    const connectedServiceQuotaPolledSnapshot = connectedServiceQuotaProfileKey
        ? connectedServiceQuotaSnapshots.snapshotsByKey[connectedServiceQuotaProfileKey] ?? null
        : null;
    const [connectedServiceQuotaSnapshotOverride, setConnectedServiceQuotaSnapshotOverride] = React.useState<Readonly<{
        profileKey: string;
        snapshot: ConnectedServiceQuotaSnapshotV1;
    }> | null>(null);
    const connectedServiceQuotaSnapshot = connectedServiceQuotaSnapshotOverride
        && connectedServiceQuotaSnapshotOverride.profileKey === connectedServiceQuotaProfileKey
        && (!connectedServiceQuotaPolledSnapshot || connectedServiceQuotaSnapshotOverride.snapshot.fetchedAt >= connectedServiceQuotaPolledSnapshot.fetchedAt)
        ? connectedServiceQuotaSnapshotOverride.snapshot
        : connectedServiceQuotaPolledSnapshot;
    React.useEffect(() => {
        if (!connectedServiceQuotaSnapshotOverride) return;
        if (connectedServiceQuotaSnapshotOverride.profileKey !== connectedServiceQuotaProfileKey) {
            setConnectedServiceQuotaSnapshotOverride(null);
            return;
        }
        if (connectedServiceQuotaPolledSnapshot && connectedServiceQuotaPolledSnapshot.fetchedAt >= connectedServiceQuotaSnapshotOverride.snapshot.fetchedAt) {
            setConnectedServiceQuotaSnapshotOverride(null);
        }
    }, [
        connectedServiceQuotaPolledSnapshot,
        connectedServiceQuotaProfileKey,
        connectedServiceQuotaSnapshotOverride,
    ]);
    const providerAccountUsageRecordIds = React.useMemo(
        () => readProviderAccountUsageRecordIdsFromMetadata(session.metadata),
        [session.metadata],
    );
    const providerAccountUsageSnapshots = useProviderAccountUsageSnapshots(providerAccountUsageRecordIds);
    const providerUsageDisplaySource = React.useMemo(() => selectProviderUsageDisplaySource({
        providerId: agentId,
        metadataRecordIds: providerAccountUsageRecordIds,
        accountUsageSnapshotsByRecordId: providerAccountUsageSnapshots.snapshotsByRecordId,
        connectedServiceProfileRef: connectedServiceQuotaProfileRef,
        connectedServiceQuotaView: connectedServiceQuotaSnapshot,
    }), [
        agentId,
        connectedServiceQuotaProfileRef,
        connectedServiceQuotaSnapshot,
        providerAccountUsageRecordIds,
        providerAccountUsageSnapshots.snapshotsByRecordId,
    ]);
    const providerAccountUsageSnapshot = providerUsageDisplaySource?.kind === 'account_usage'
        ? providerUsageDisplaySource.snapshot
        : null;
    const usageLimitRecoveryCredits = connectedServiceQuotaProfileRef
        ? connectedServiceQuotaSnapshot?.recoveryCredits ?? null
        : providerAccountUsageSnapshot?.recoveryCredits
            ?? usageLimitRecoveryState?.recoveryCredits
            ?? null;
    const baseUsageLimitRecoveryPresentation = React.useMemo(() => buildSessionUsageLimitRecoveryPresentation({
        featureEnabled: usageLimitRecoveryFeatureEnabled,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        recoveryState: usageLimitRecoveryState,
        operationStatus: null,
        checkNowSupported: usageLimitRecoveryCheckNowSupported,
        recoveryCredits: usageLimitRecoveryCredits,
        runtimeWorking: sessionStatus.state === 'thinking',
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(session),
        hasInterruptedWorkToResume,
        nowMs: usageLimitRecoveryNowMs,
        settings: usageLimitRecoverySettings,
        translate: translateUsageLimitRecoveryPresentationKey,
    }), [
        session.lastRuntimeIssue,
        session.latestTurnStatus,
        session.latestTurnStatusObservedAt,
        session.meaningfulActivityAt,
        sessionStatus.state,
        hasInterruptedWorkToResume,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryFeatureEnabled,
        usageLimitRecoveryNowMs,
        usageLimitRecoveryCredits,
        usageLimitRecoverySettings,
        usageLimitRecoveryState,
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
    const usageLimitRecoveryBannerCollapsed = Boolean(
        collapsedUsageLimitRecoveryIssueFingerprint
        && baseUsageLimitRecoveryPresentation?.issueFingerprint === collapsedUsageLimitRecoveryIssueFingerprint
    );
    React.useEffect(() => {
        if (!collapsedUsageLimitRecoveryIssueFingerprint) return;
        if (baseUsageLimitRecoveryPresentation?.issueFingerprint === collapsedUsageLimitRecoveryIssueFingerprint) return;
        setCollapsedUsageLimitRecoveryIssueFingerprint(null);
    }, [
        baseUsageLimitRecoveryPresentation?.issueFingerprint,
        collapsedUsageLimitRecoveryIssueFingerprint,
    ]);
    const activeUsageLimitRecoveryOperationStatus = usageLimitRecoveryOperationStatus
        && baseUsageLimitRecoveryPresentation?.issueFingerprint === usageLimitRecoveryOperationStatus.issueFingerprint
        ? usageLimitRecoveryOperationStatus.status
        : null;
    const usageLimitRecoveryPresentation = React.useMemo(() => buildSessionUsageLimitRecoveryPresentation({
        featureEnabled: usageLimitRecoveryFeatureEnabled && !usageLimitRecoveryIssueResolved,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        recoveryState: usageLimitRecoveryState,
        operationStatus: activeUsageLimitRecoveryOperationStatus,
        checkNowSupported: usageLimitRecoveryCheckNowSupported,
        recoveryCredits: usageLimitRecoveryCredits,
        runtimeWorking: sessionStatus.state === 'thinking',
        hasActivityAfterRuntimeIssue: hasMeaningfulActivityAfterRuntimeIssue(session),
        hasInterruptedWorkToResume,
        nowMs: usageLimitRecoveryNowMs,
        settings: usageLimitRecoverySettings,
        translate: translateUsageLimitRecoveryPresentationKey,
    }), [
        activeUsageLimitRecoveryOperationStatus,
        session.lastRuntimeIssue,
        session.latestTurnStatus,
        session.latestTurnStatusObservedAt,
        session.meaningfulActivityAt,
        sessionStatus.state,
        hasInterruptedWorkToResume,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryFeatureEnabled,
        usageLimitRecoveryIssueResolved,
        usageLimitRecoveryNowMs,
        usageLimitRecoveryCredits,
        usageLimitRecoverySettings,
        usageLimitRecoveryState,
    ]);
    const visibleUsageLimitRecoveryPresentation = usageLimitRecoveryBannerCollapsed
        ? null
        : usageLimitRecoveryPresentation;
    const staleSessionRunnerBasePresentation = React.useMemo(() => (
        staleSessionRunnerRuntimeState
            ? buildStaleSessionRunnerNoticePresentation({
                runtimeState: staleSessionRunnerRuntimeState,
                operationStatus: null,
                translate: tLoose,
            })
            : null
    ), [staleSessionRunnerRuntimeState]);
    const staleSessionRunnerFingerprint = staleSessionRunnerBasePresentation?.fingerprint ?? null;
    const staleSessionRunnerNoticeResolved = Boolean(
        resolvedStaleSessionRunnerFingerprint
        && resolvedStaleSessionRunnerFingerprint === staleSessionRunnerFingerprint
    );
    React.useEffect(() => {
        if (!resolvedStaleSessionRunnerFingerprint) return;
        if (resolvedStaleSessionRunnerFingerprint === staleSessionRunnerFingerprint) return;
        setResolvedStaleSessionRunnerFingerprint(null);
    }, [resolvedStaleSessionRunnerFingerprint, staleSessionRunnerFingerprint]);
    React.useEffect(() => {
        if (!collapsedStaleSessionRunnerFingerprint) return;
        if (collapsedStaleSessionRunnerFingerprint === staleSessionRunnerFingerprint) return;
        setCollapsedStaleSessionRunnerFingerprint(null);
    }, [collapsedStaleSessionRunnerFingerprint, staleSessionRunnerFingerprint]);
    const activeStaleSessionRunnerOperationStatus = staleSessionRunnerOperationStatus
        && staleSessionRunnerOperationStatus.fingerprint === staleSessionRunnerFingerprint
        ? staleSessionRunnerOperationStatus.status
        : null;
    const staleSessionRunnerPresentation = React.useMemo(() => (
        staleSessionRunnerRuntimeState && !staleSessionRunnerNoticeResolved
            ? buildStaleSessionRunnerNoticePresentation({
                runtimeState: staleSessionRunnerRuntimeState,
                operationStatus: activeStaleSessionRunnerOperationStatus,
                translate: tLoose,
            })
            : null
    ), [
        activeStaleSessionRunnerOperationStatus,
        staleSessionRunnerNoticeResolved,
        staleSessionRunnerRuntimeState,
    ]);
    const visibleStaleSessionRunnerPresentation = collapsedStaleSessionRunnerFingerprint
        && collapsedStaleSessionRunnerFingerprint === staleSessionRunnerPresentation?.fingerprint
        ? null
        : staleSessionRunnerPresentation;
    const toggleStaleSessionRunnerBannerCollapsed = React.useCallback(() => {
        const fingerprint = staleSessionRunnerPresentation?.fingerprint
            ?? staleSessionRunnerFingerprint
            ?? null;
        if (!fingerprint) return;
        setCollapsedStaleSessionRunnerFingerprint((current) => (
            current === fingerprint ? null : fingerprint
        ));
    }, [staleSessionRunnerFingerprint, staleSessionRunnerPresentation?.fingerprint]);
    const staleSessionRunnerBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        if (!staleSessionRunnerPresentation) return [];
        return [{
            ...staleSessionRunnerPresentation.statusBadge,
            accessibilityLabel: visibleStaleSessionRunnerPresentation
                ? t('session.staleRunner.actions.hideBanner')
                : t('session.staleRunner.actions.showBanner'),
            icon: (tint) => <Ionicons name="refresh-outline" size={12} color={tint} />,
            onPress: toggleStaleSessionRunnerBannerCollapsed,
        }];
    }, [
        staleSessionRunnerPresentation,
        toggleStaleSessionRunnerBannerCollapsed,
        visibleStaleSessionRunnerPresentation,
    ]);
    const toggleUsageLimitRecoveryBannerCollapsed = React.useCallback(() => {
        const issueFingerprint = usageLimitRecoveryPresentation?.issueFingerprint
            ?? baseUsageLimitRecoveryPresentation?.issueFingerprint
            ?? null;
        if (!issueFingerprint) return;
        setCollapsedUsageLimitRecoveryIssueFingerprint((current) => (
            current === issueFingerprint ? null : issueFingerprint
        ));
    }, [
        baseUsageLimitRecoveryPresentation?.issueFingerprint,
        usageLimitRecoveryPresentation?.issueFingerprint,
    ]);
    const usageLimitRecoveryBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        if (!usageLimitRecoveryPresentation) return [];
        return [{
            ...usageLimitRecoveryPresentation.statusBadge,
            accessibilityLabel: usageLimitRecoveryBannerCollapsed
                ? t('session.usageLimitRecovery.actions.showBanner')
                : t('session.usageLimitRecovery.actions.hideBanner'),
            icon: (tint) => <Ionicons name="time-outline" size={12} color={tint} />,
            onPress: toggleUsageLimitRecoveryBannerCollapsed,
        }];
    }, [
        t,
        toggleUsageLimitRecoveryBannerCollapsed,
        usageLimitRecoveryBannerCollapsed,
        usageLimitRecoveryPresentation,
    ]);
    const providerUsageConnectedServiceQuotaSnapshot = connectedServiceQuotaProfileRef
        ? providerUsageDisplaySource?.kind === 'connected_service_quota_view'
            ? selectConnectedServiceSessionProviderUsageSnapshot({
                connectedServiceSnapshot: providerUsageDisplaySource.snapshot,
                recoveryCredits: usageLimitRecoveryCredits,
                runtimeIssue: session.lastRuntimeIssue ?? null,
            })
            : null
        : selectConnectedServiceSessionProviderUsageSnapshot({
            connectedServiceSnapshot: connectedServiceQuotaSnapshot,
            recoveryCredits: usageLimitRecoveryCredits,
            runtimeIssue: session.lastRuntimeIssue ?? null,
        });
    const providerUsageConnectedServiceQuotaProfileRef = providerUsageDisplaySource?.kind === 'connected_service_quota_view'
        && providerUsageConnectedServiceQuotaSnapshot
        && connectedServiceQuotaSnapshotMatchesProfileRef(
            providerUsageConnectedServiceQuotaSnapshot,
            connectedServiceQuotaProfileRef,
        )
        ? connectedServiceQuotaProfileRef
        : null;
    const providerUsageGauge = React.useMemo(() => {
        if (!connectedServiceQuotasEnabled || sessionProviderUsageGaugeMode === 'hidden') return null;
        if (connectedServiceQuotaProfileRef) {
            if (providerUsageDisplaySource?.kind !== 'connected_service_quota_view') {
                return null;
            }
            return computeConnectedServiceQuotaGaugeViewModel({
                snapshot: providerUsageConnectedServiceQuotaSnapshot,
                windowMode: sessionProviderUsageGaugeWindowMode,
                nowMs: Date.now(),
                formatter: connectedServiceQuotaGaugeFormatter,
            });
        }
        const connectedServiceGauge = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: providerUsageConnectedServiceQuotaSnapshot,
            windowMode: sessionProviderUsageGaugeWindowMode,
            nowMs: Date.now(),
            formatter: connectedServiceQuotaGaugeFormatter,
        });
        if (connectedServiceGauge) return connectedServiceGauge;
        return computeProviderAccountUsageGaugeViewModel({
            snapshot: providerAccountUsageSnapshot,
            windowMode: sessionProviderUsageGaugeWindowMode,
            nowMs: Date.now(),
            formatter: connectedServiceQuotaGaugeFormatter,
        });
    }, [
        connectedServiceQuotaProfileRef,
        connectedServiceQuotasEnabled,
        providerUsageDisplaySource?.kind,
        providerUsageConnectedServiceQuotaSnapshot,
        providerAccountUsageSnapshot,
        sessionProviderUsageGaugeMode,
        sessionProviderUsageGaugeWindowMode,
    ]);
    const sessionStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => [
        ...usageLimitRecoveryBadges,
        ...staleSessionRunnerBadges,
        ...sessionWorkStateBadges,
    ], [sessionWorkStateBadges, staleSessionRunnerBadges, usageLimitRecoveryBadges]);
    React.useEffect(() => {
        if (shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey,
            hasPrimaryWorkStateItem: Boolean(primaryWorkStateItem),
            canShowEmptyGoalControls: canEditSessionGoals,
            hasActiveWorkflowRuns: sessionWorkflowActivity.activeRuns.length > 0,
        })) return;
        if (usageLimitRecoveryPresentation && activeStatusBadgeKey === SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY) return;
        if (staleSessionRunnerPresentation && activeStatusBadgeKey === STALE_SESSION_RUNNER_STATUS_BADGE_KEY) return;
        setActiveStatusBadgeKey(null);
    }, [
        activeStatusBadgeKey,
        canEditSessionGoals,
        primaryWorkStateItem,
        sessionWorkflowActivity.activeRuns.length,
        staleSessionRunnerPresentation,
        usageLimitRecoveryPresentation,
    ]);
    const handleStaleSessionRunnerRestart = React.useCallback(async () => {
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        if (!staleSessionRunnerRuntimeState || !staleSessionRunnerPresentation) return;
        setStaleSessionRunnerOperationStatus({
            fingerprint: staleSessionRunnerPresentation.fingerprint,
            status: { kind: 'pending' },
        });
        const result = await restartSessionRunnerOnCurrentRuntime({
            runtimeState: staleSessionRunnerRuntimeState,
            serverId: sessionRouteServerId,
        });
        if (result.status === 'restarted' || result.status === 'already_current') {
            setResolvedStaleSessionRunnerFingerprint(staleSessionRunnerPresentation.fingerprint);
            setCollapsedStaleSessionRunnerFingerprint(null);
            setStaleSessionRunnerOperationStatus(null);
            return;
        }
        setStaleSessionRunnerOperationStatus({
            fingerprint: staleSessionRunnerPresentation.fingerprint,
            status: { kind: 'result', result },
        });
    }, [
        hasWriteAccess,
        sessionRouteServerId,
        staleSessionRunnerPresentation,
        staleSessionRunnerRuntimeState,
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
    const markCurrentUsageLimitRecoveryOperationStatus = React.useCallback((status: UsageLimitRecoveryOperationStatus) => {
        if (!usageLimitRecoveryPresentation) return;
        setUsageLimitRecoveryOperationStatus({
            issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
            status,
        });
    }, [usageLimitRecoveryPresentation]);
    const usageLimitRecoveryOperationOptions = React.useMemo(() => ({
        serverId: sessionRouteServerId,
        refreshMachineTargets: () => sync.refreshMachinesThrottled({ staleMs: 0, force: true }),
    }), [sessionRouteServerId]);
    const consumeConnectedServiceRecoveryCreditForProfile = React.useCallback(async (params: Readonly<{
        profileRef: Readonly<{ serviceId: string; profileId: string }>;
        profileKey: string;
        providerCreditId?: string | null;
        snapshotFetchedAtMs: number | null;
    }>): Promise<boolean> => {
        const targetMachineId = controlMachineTarget?.machineId
            ?? (typeof machineId === 'string' ? machineId : null);
        if (!targetMachineId) {
            await Modal.alert(
                t('common.error'),
                t('connectedServices.quota.recoveryCreditMachineUnavailable'),
            );
            return false;
        }

        const serviceId = ConnectedServiceIdSchema.safeParse(params.profileRef.serviceId);
        if (!serviceId.success) {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
            return false;
        }

        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: targetMachineId,
            serverId: sessionRouteServerId,
            serviceId: serviceId.data,
            profileId: params.profileRef.profileId,
            sourceSnapshotFetchedAtMs: params.snapshotFetchedAtMs,
            ...(params.providerCreditId ? { providerCreditId: params.providerCreditId } : {}),
        });
        if (!result.ok) {
            await Modal.alert(t('common.error'), result.error || result.errorCode);
            return false;
        }
        if (result.snapshot) {
            setConnectedServiceQuotaSnapshotOverride({
                profileKey: params.profileKey,
                snapshot: result.snapshot,
            });
        } else {
            setConnectedServiceQuotaSnapshotOverride((current) => (
                current?.profileKey === params.profileKey ? null : current
            ));
        }
        return true;
    }, [
        controlMachineTarget?.machineId,
        machineId,
        sessionId,
        sessionRouteServerId,
        t,
    ]);
    const handleUsageLimitRecoveryAction = React.useCallback(async (kind: SessionUsageLimitRecoveryActionKind = usageLimitRecoveryPresentation?.banner.mode ?? 'enable') => {
        if (!usageLimitRecoveryPresentation) return;
        if (usageLimitRecoveryPendingActionRef.current) return;
        const showUsageLimitRecoveryOperationFailure = async (
            result: SessionUsageLimitRecoveryOperationFailureResult,
        ): Promise<void> => {
            const profileActionRoute = readUsageLimitRecoveryDiagnosticProfileActionRoute(result);
            const alert = buildSessionUsageLimitRecoveryOperationFailureAlert({
                result,
                fallbackMessage: formatUsageLimitRecoveryOperationError(result),
                translate: t,
                actions: {
                    retry: () => {
                        void handleUsageLimitRecoveryAction(kind);
                    },
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
                    dismiss: () => {},
                },
            });
            await Modal.alert(alert.title, alert.body, alert.buttons);
        };
        usageLimitRecoveryPendingActionRef.current = true;
        setUsageLimitRecoveryPendingAction(kind);
        try {
            if (isSessionUsageLimitRecoveryCheckingOperationAction(kind)) {
                markCurrentUsageLimitRecoveryOperationStatus('checking');
            }
            if (kind === 'resume_now') {
                if (usageLimitRecoveryCheckNowSupported) {
                    const result = await sessionUsageLimitCheckNow(sessionId, {
                        provider: session.lastRuntimeIssue?.provider ?? null,
                        resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                        ...usageLimitRecoveryOperationOptions,
                    });
                    if (!result.ok) {
                        setUsageLimitRecoveryOperationStatus(null);
                        await showUsageLimitRecoveryOperationFailure(result);
                        return;
                    }
                    if (isUsageLimitRecoveryResolvedStatus(result.status)) {
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
                        markUsageLimitRecoveryIssueResolved();
                        return;
                    }
                    const displayStatus = readUsageLimitRecoveryDisplayStatus(result.status);
                    if (displayStatus) {
                        markCurrentUsageLimitRecoveryOperationStatus(displayStatus);
                    }
                    return;
                }

                const resumed = await handleUsageLimitRecoveryResumeNowRef.current?.({ silent: false });
                if (resumed) {
                    markUsageLimitRecoveryIssueResolved();
                } else {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            if (kind === 'remember') {
                const result = await sessionUsageLimitWaitResumeEnable(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    remember: true,
                    resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                }, usageLimitRecoveryOperationOptions);
                if (!result.ok) {
                    setUsageLimitRecoveryOperationStatus(null);
                    await showUsageLimitRecoveryOperationFailure(result);
                } else {
                    setUsageLimitRecoverySettings(updateUsageLimitRecoveryRememberedMode(
                        usageLimitRecoverySettings,
                        'auto_wait',
                    ));
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            if (kind === 'forget') {
                const result = await sessionUsageLimitWaitResumeCancel(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                }, usageLimitRecoveryOperationOptions);
                if (!result.ok) {
                    setUsageLimitRecoveryOperationStatus(null);
                    await showUsageLimitRecoveryOperationFailure(result);
                    return;
                }
                setUsageLimitRecoverySettings(updateUsageLimitRecoveryRememberedMode(
                    usageLimitRecoverySettings,
                    'ask',
                ));
                if (isUsageLimitRecoveryResolvedStatus(result.status)) {
                    markUsageLimitRecoveryIssueResolved();
                } else {
                    const displayStatus = readUsageLimitRecoveryDisplayStatus(result.status);
                    if (displayStatus) {
                        markCurrentUsageLimitRecoveryOperationStatus(displayStatus);
                    } else {
                        setUsageLimitRecoveryOperationStatus(null);
                    }
                }
                return;
            }

            if (kind === 'consume_reset_credit' && connectedServiceQuotaProfileRef && connectedServiceQuotaProfileKey) {
                const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(
                    usageLimitRecoveryCredits,
                    nowServerMs(),
                );
                const consumed = await consumeConnectedServiceRecoveryCreditForProfile({
                    profileRef: connectedServiceQuotaProfileRef,
                    profileKey: connectedServiceQuotaProfileKey,
                    providerCreditId: recoveryCreditSummary?.providerCreditId,
                    snapshotFetchedAtMs: connectedServiceQuotaSnapshot?.fetchedAt ?? null,
                });
                if (consumed) {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }

            const result = kind === 'cancel'
                ? await sessionUsageLimitWaitResumeCancel(sessionId, {
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                }, usageLimitRecoveryOperationOptions)
                : kind === 'consume_reset_credit'
                    ? await sessionUsageLimitConsumeResetCredit(sessionId, {
                        provider: session.lastRuntimeIssue?.provider ?? null,
                        issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                        ...usageLimitRecoveryOperationOptions,
                    })
                    : isUsageLimitRecoverySwitchAction(kind)
                        ? await sessionUsageLimitSwitchAccountNow(sessionId, {
                            provider: session.lastRuntimeIssue?.provider ?? null,
                            ...usageLimitRecoveryOperationOptions,
                        })
                        : isSessionUsageLimitRecoveryCheckNowAction(kind)
                            ? await sessionUsageLimitCheckNow(sessionId, {
                                provider: session.lastRuntimeIssue?.provider ?? null,
                                resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                                ...usageLimitRecoveryOperationOptions,
                            })
                            : await sessionUsageLimitWaitResumeEnable(sessionId, {
                                issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                                remember: usageLimitRecoverySettings.mode === 'auto_wait',
                                resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                            }, usageLimitRecoveryOperationOptions);
            if (!result.ok) {
                setUsageLimitRecoveryOperationStatus(null);
                await showUsageLimitRecoveryOperationFailure(result);
                return;
            }
            if ((isSessionUsageLimitRecoveryCheckNowAction(kind) || isUsageLimitRecoverySwitchAction(kind)) && result.status) {
                if (isUsageLimitRecoveryResolvedStatus(result.status)) {
                    markUsageLimitRecoveryIssueResolved();
                    return;
                }
                const displayStatus = readUsageLimitRecoveryDisplayStatus(result.status);
                if (displayStatus) {
                    markCurrentUsageLimitRecoveryOperationStatus(displayStatus);
                }
            } else if (kind === 'cancel' || kind === 'enable') {
                if (isUsageLimitRecoveryResolvedStatus(result.status)) {
                    markUsageLimitRecoveryIssueResolved();
                } else {
                    const displayStatus = readUsageLimitRecoveryDisplayStatus(result.status);
                    if (displayStatus) {
                        markCurrentUsageLimitRecoveryOperationStatus(displayStatus);
                    } else {
                        setUsageLimitRecoveryOperationStatus(null);
                    }
                }
            }
        } finally {
            usageLimitRecoveryPendingActionRef.current = false;
            setUsageLimitRecoveryPendingAction(null);
        }
    }, [
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        connectedServiceQuotaProfileKey,
        connectedServiceQuotaProfileRef,
        connectedServiceQuotaSnapshot?.fetchedAt,
        consumeConnectedServiceRecoveryCreditForProfile,
        session.active,
        session.lastRuntimeIssue?.provider,
        sessionId,
        setUsageLimitRecoverySettings,
        router,
        usageLimitRecoveryOperationOptions,
        usageLimitRecoveryCredits,
        usageLimitRecoveryCheckNowSupported,
        usageLimitRecoveryPresentation,
        usageLimitRecoverySettings.mode,
        usageLimitRecoverySettings.resumePromptMode,
        usageLimitRecoverySettings.customResumePrompt,
    ]);
    const [providerUsageRecoveryCreditPending, setProviderUsageRecoveryCreditPending] = React.useState(false);
    const handleProviderUsageRecoveryCreditPress = React.useCallback(async () => {
        if (!providerUsageGauge?.recoveryCreditSummary) return;
        if (providerUsageRecoveryCreditPending) return;

        const connectedProfileRef = providerUsageConnectedServiceQuotaProfileRef;
        if (connectedProfileRef && connectedServiceQuotaProfileKey) {
            setProviderUsageRecoveryCreditPending(true);
            try {
                await consumeConnectedServiceRecoveryCreditForProfile({
                    profileRef: connectedProfileRef,
                    profileKey: connectedServiceQuotaProfileKey,
                    providerCreditId: providerUsageGauge.recoveryCreditSummary.providerCreditId,
                    snapshotFetchedAtMs: providerUsageConnectedServiceQuotaSnapshot?.fetchedAt ?? null,
                });
            } finally {
                setProviderUsageRecoveryCreditPending(false);
            }
            return;
        }

        setProviderUsageRecoveryCreditPending(true);
        try {
            if (usageLimitRecoveryPresentation) {
                await handleUsageLimitRecoveryAction('consume_reset_credit');
                return;
            }

            const result = await sessionUsageLimitConsumeResetCredit(sessionId, {
                provider: session.lastRuntimeIssue?.provider ?? providerAccountUsageSnapshot?.providerId ?? null,
                issueFingerprint: baseUsageLimitRecoveryPresentation?.issueFingerprint ?? null,
                ...usageLimitRecoveryOperationOptions,
            });
            if (!result.ok) {
                await Modal.alert(t('common.error'), formatUsageLimitRecoveryOperationError(result));
                return;
            }
            if (isUsageLimitRecoveryResolvedStatus(result.status)) {
                markUsageLimitRecoveryIssueResolved();
                return;
            }
            const displayStatus = readUsageLimitRecoveryDisplayStatus(result.status);
            if (displayStatus) {
                markCurrentUsageLimitRecoveryOperationStatus(displayStatus);
            }
        } finally {
            setProviderUsageRecoveryCreditPending(false);
        }
    }, [
        connectedServiceQuotaProfileKey,
        consumeConnectedServiceRecoveryCreditForProfile,
        handleUsageLimitRecoveryAction,
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        providerAccountUsageSnapshot?.providerId,
        providerUsageConnectedServiceQuotaProfileRef,
        providerUsageGauge?.recoveryCreditSummary,
        providerUsageRecoveryCreditPending,
        session.lastRuntimeIssue?.provider,
        sessionId,
        usageLimitRecoveryOperationOptions,
        baseUsageLimitRecoveryPresentation?.issueFingerprint,
        usageLimitRecoveryPresentation,
    ]);
    const providerUsageRecoveryCreditAction = providerUsageGauge?.recoveryCreditSummary
        && (providerUsageConnectedServiceQuotaProfileRef || usageLimitRecoveryCheckNowSupported)
        ? handleProviderUsageRecoveryCreditPress
        : undefined;
    const providerUsageRecoveryCreditActionPending =
        providerUsageRecoveryCreditPending
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
    const addAttachments = attachmentDraftManager.addWebFiles;
    const addPickedAttachments = attachmentDraftManager.addPickedAttachments;
    const patchAttachmentDraft = attachmentDraftManager.applyDraftPatch;
    // Stable callback: feeds the transcript onEditPendingMessage chain, whose identity
    // gates ChatList/view-holder re-renders.
    const replaceAttachmentManagerDrafts = attachmentDraftManager.replaceDrafts;

    React.useEffect(() => {
        attachmentDraftsSnapshotRef.current = attachmentDrafts;
        if (!attachmentsUploadsEnabled) return;
        writeSessionAttachmentDrafts(sessionId, attachmentDrafts);
    }, [attachmentsUploadsEnabled, attachmentDrafts, sessionId]);
    const applyAttachmentDraftPatch = React.useCallback((
        draftId: string,
        patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>,
    ) => {
        patchAttachmentDraft(draftId, patch);
        const nextDrafts = attachmentDraftsSnapshotRef.current.map((draft) => (
            draft.id === draftId
                ? ({ ...draft, ...patch } as AttachmentDraft)
                : draft
        ));
        attachmentDraftsSnapshotRef.current = nextDrafts;
        writeSessionAttachmentDrafts(sessionId, nextDrafts);
    }, [patchAttachmentDraft, sessionId]);
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
    const recipientState = useSessionRecipientState({
        targets: participantTargets,
        autoRecipient: null,
        draftPersistence: {
            sessionId,
            surface: 'mainComposer',
        },
    });

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

    // A pre-start death (no vendor resume id ever persisted) stays continuable by fresh
    // spawn instead of dead-ending in a "can't restore context" notice (QA A-F5).
    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)
        || canContinueSessionWithFreshSpawn(session.metadata, resumeCapabilityOptions);
    const [isResuming, setIsResuming] = React.useState(false);
    const [isPendingQueueWakeResuming, setIsPendingQueueWakeResuming] = React.useState(false);
    const sessionSubmitPort = React.useMemo(() => createSyncBackedSubmitPort(sync), []);
    const sessionSubmitPortWithWakeState = React.useMemo<SessionSubmitPort>(() => ({
        ...sessionSubmitPort,
        resumeSession: async (options) => {
            setIsPendingQueueWakeResuming(true);
            try {
                return await sessionSubmitPort.resumeSession(options);
            } finally {
                setIsPendingQueueWakeResuming(false);
            }
        },
    }), [sessionSubmitPort]);
    const readLatestSessionForSubmit = React.useCallback(() => {
        return storage.getState().sessions[sessionId] ?? session;
    }, [session, sessionId]);
    const persistedVoiceComposerRouting = resolveVoiceSessionComposerRouting({
        conversationSessionId: sessionId,
        sessionMetadata: session.metadata,
    });

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
    const setComposerDraftValue = React.useCallback((nextValueOrUpdater: React.SetStateAction<string>) => {
        setDraftValue((currentValue) => {
            const nextValue = typeof nextValueOrUpdater === 'function'
                ? (nextValueOrUpdater as (value: string) => string)(currentValue)
                : nextValueOrUpdater;
            messageRef.current = nextValue;
            return nextValue;
        });
    }, [setDraftValue]);
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);
    const [pendingMessageEdit, setPendingMessageEdit] = React.useState<PendingMessageComposerEditState | null>(null);
    const pendingMessageEditRef = React.useRef(pendingMessageEdit);
    React.useEffect(() => {
        pendingMessageEditRef.current = pendingMessageEdit;
    }, [pendingMessageEdit]);
    const pendingMessageEditHoldPatchRef = React.useRef<Promise<unknown>>(Promise.resolve());
    const patchPendingMessageEditHoldMetadata = React.useCallback((
        updater: (metadata: Metadata) => Metadata,
        tag: string,
    ) => {
        const run = pendingMessageEditHoldPatchRef.current
            .catch(() => undefined)
            .then(() => sync.patchSessionMetadataWithRetry(sessionId, updater, { serverId: routeServerId }));
        pendingMessageEditHoldPatchRef.current = run;
        fireAndForget(run, { tag });
    }, [routeServerId, sessionId]);
    const publishPendingMessageEditDrainHold = React.useCallback((edit: PendingMessageComposerEditState) => {
        const nowMs = Date.now();
        patchPendingMessageEditHoldMetadata(
            (metadata) => writeSessionPendingQueueHoldV1ToMetadata(metadata, {
                holdId: edit.holdId,
                localId: edit.pendingId,
                updatedAtMs: nowMs,
                expiresAtMs: nowMs + PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS,
            }) as Metadata,
            'SessionView.pendingMessageEdit.hold.publish',
        );
    }, [patchPendingMessageEditHoldMetadata]);
    const clearPendingMessageEditDrainHold = React.useCallback((holdId: string) => {
        if (holdId.trim().length === 0) return;
        patchPendingMessageEditHoldMetadata(
            (metadata) => removeSessionPendingQueueHoldV1FromMetadata(metadata, holdId) as Metadata,
            'SessionView.pendingMessageEdit.hold.clear',
        );
    }, [patchPendingMessageEditHoldMetadata]);
    const activeServerAccountScope = useActiveServerAccountScope();
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
        clearSessionDraftValuesForSession(activeServerAccountScope, sessionId, { reason: 'send' });
        flushSessionDraftValues(activeServerAccountScope);
    }, [activeServerAccountScope, sessionId]);
    const restoreSemanticDraftValuesFromSnapshot = React.useCallback((snapshot: ComposerSemanticDraftSnapshot) => {
        if (typeof snapshot.recipient === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'routing.recipient');
        } else {
            writeSessionDraftValue(activeServerAccountScope, sessionId, 'routing.recipient', snapshot.recipient);
        }

        if (typeof snapshot.executionRunDelivery === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'routing.executionRunDelivery');
        } else {
            writeSessionDraftValue(
                activeServerAccountScope,
                sessionId,
                'routing.executionRunDelivery',
                snapshot.executionRunDelivery,
            );
        }

        if (typeof snapshot.structuredInputMentions === 'undefined') {
            clearSessionDraftValue(activeServerAccountScope, sessionId, 'structuredInput.mentions');
        } else {
            writeSessionDraftValue(
                activeServerAccountScope,
                sessionId,
                'structuredInput.mentions',
                snapshot.structuredInputMentions,
            );
        }

        flushSessionDraftValues(activeServerAccountScope);
    }, [activeServerAccountScope, sessionId]);
    const clearSemanticDraftValuesAfterAcceptedComposerClear = React.useCallback(() => {
        clearSessionDraftValuesForSession(activeServerAccountScope, sessionId, { reason: 'composerClear' });
        flushSessionDraftValues(activeServerAccountScope);
    }, [activeServerAccountScope, sessionId]);
    const restorePendingEditAttachmentDraftsIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        if (attachmentDraftsSnapshotRef.current.length !== 0) return;
        attachmentDraftsSnapshotRef.current = edit.previousAttachmentDrafts;
        writeSessionAttachmentDrafts(sessionId, edit.previousAttachmentDrafts);
        replaceAttachmentManagerDrafts(edit.previousAttachmentDrafts);
    }, [replaceAttachmentManagerDrafts, sessionId]);
    const restorePendingEditSemanticDraftsIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
        if (!isEmptyPendingMessageComposerSemanticDraftSnapshot(captureComposerSemanticDraftSnapshot())) return;
        restoreSemanticDraftValuesFromSnapshot(edit.previousSemanticDraftSnapshot);
    }, [captureComposerSemanticDraftSnapshot, restoreSemanticDraftValuesFromSnapshot]);
	    const restorePendingEditComposerSnapshotIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
	        setComposerDraftValue(edit.previousDraftText);
	        restorePendingEditAttachmentDraftsIfSafe(edit);
	        restorePendingEditSemanticDraftsIfSafe(edit);
	        inputComposerPersistence.restoreTransientInputState(edit.previousTransientInputState);
    }, [
        inputComposerPersistence,
        restorePendingEditAttachmentDraftsIfSafe,
        restorePendingEditSemanticDraftsIfSafe,
        setComposerDraftValue,
    ]);
    const restorePendingEditComposerSnapshotIfSafeRef = React.useRef(restorePendingEditComposerSnapshotIfSafe);
	    React.useEffect(() => {
	        restorePendingEditComposerSnapshotIfSafeRef.current = restorePendingEditComposerSnapshotIfSafe;
	    }, [restorePendingEditComposerSnapshotIfSafe]);
	    const restorePendingEditNonTextComposerSnapshotIfSafe = React.useCallback((edit: PendingMessageComposerEditState) => {
	        restorePendingEditAttachmentDraftsIfSafe(edit);
	        restorePendingEditSemanticDraftsIfSafe(edit);
	        inputComposerPersistence.restoreTransientInputState(edit.previousTransientInputState);
	    }, [
	        inputComposerPersistence,
	        restorePendingEditAttachmentDraftsIfSafe,
	        restorePendingEditSemanticDraftsIfSafe,
	    ]);
	    const restorePendingEditNonTextComposerSnapshotIfSafeRef = React.useRef(restorePendingEditNonTextComposerSnapshotIfSafe);
	    React.useEffect(() => {
	        restorePendingEditNonTextComposerSnapshotIfSafeRef.current = restorePendingEditNonTextComposerSnapshotIfSafe;
	    }, [restorePendingEditNonTextComposerSnapshotIfSafe]);
	    const cancelPendingMessageEdit = React.useCallback(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        setPendingMessageEdit(null);
        clearPendingMessageEditDrainHold(edit.holdId);
        restorePendingEditComposerSnapshotIfSafe(edit);
    }, [clearPendingMessageEditDrainHold, restorePendingEditComposerSnapshotIfSafe]);
    const handleEditPendingMessage = React.useCallback((request: PendingMessageEditRequest) => {
        const previousDraftText = pendingMessageEditRef.current?.previousDraftText ?? messageRef.current;
        const previousAttachmentDrafts = pendingMessageEditRef.current?.previousAttachmentDrafts ?? attachmentDraftsSnapshotRef.current;
        const previousSemanticDraftSnapshot = pendingMessageEditRef.current?.previousSemanticDraftSnapshot
            ?? captureComposerSemanticDraftSnapshot();
        const previousTransientInputState = pendingMessageEditRef.current?.previousTransientInputState
            ?? inputComposerPersistence.captureTransientInputState();
        setPendingMessageEdit({
            pendingId: request.id,
            holdId: pendingMessageEditRef.current?.holdId ?? randomUUID(),
            previousDraftText,
            previousAttachmentDrafts,
            previousSemanticDraftSnapshot,
            previousTransientInputState,
            loadedText: request.text,
        });
        attachmentDraftsSnapshotRef.current = [];
        writeSessionAttachmentDrafts(sessionId, []);
        replaceAttachmentManagerDrafts([]);
        clearSemanticDraftValuesAfterAcceptedComposerClear();
        inputComposerPersistence.clearTransientInputState();
        setComposerDraftValue(request.text);
    }, [
        replaceAttachmentManagerDrafts,
        captureComposerSemanticDraftSnapshot,
        clearSemanticDraftValuesAfterAcceptedComposerClear,
        inputComposerPersistence,
        sessionId,
        setComposerDraftValue,
    ]);
    React.useEffect(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        const stillQueued = pendingMessages.some((pending) =>
            pending.id === edit.pendingId || pending.localId === edit.pendingId
        );
        if (stillQueued) return;

        setPendingMessageEdit(null);
	        clearPendingMessageEditDrainHold(edit.holdId);
	        if (messageRef.current === edit.loadedText) {
	            restorePendingEditComposerSnapshotIfSafe(edit);
	        } else {
	            restorePendingEditNonTextComposerSnapshotIfSafe(edit);
	        }
	    }, [
	        clearPendingMessageEditDrainHold,
	        pendingMessages,
	        restorePendingEditComposerSnapshotIfSafe,
	        restorePendingEditNonTextComposerSnapshotIfSafe,
	    ]);
    React.useEffect(() => {
        if (!pendingMessageEdit) return;
        publishPendingMessageEditDrainHold(pendingMessageEdit);
        const timer = setInterval(() => {
            const edit = pendingMessageEditRef.current;
            if (edit) publishPendingMessageEditDrainHold(edit);
        }, PENDING_MESSAGE_EDIT_DRAIN_HOLD_REFRESH_MS);
        return () => clearInterval(timer);
    }, [pendingMessageEdit?.holdId, pendingMessageEdit?.pendingId, publishPendingMessageEditDrainHold]);
    React.useEffect(() => () => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
	        clearPendingMessageEditDrainHold(edit.holdId);
	        if (messageRef.current === edit.loadedText) {
	            restorePendingEditComposerSnapshotIfSafeRef.current(edit);
	        } else {
	            restorePendingEditNonTextComposerSnapshotIfSafeRef.current(edit);
	        }
	    }, [clearPendingMessageEditDrainHold]);

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

        if (!resumeMachineId || !resumeDirectory || !agentId) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (!agentId) {
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
    }, [agentId, capabilityServerId, executionRunsEnabled, isMachineReachable, reachableMachineTarget, resumeCapabilityOptions, router, session, sessionActionDefaultBackend, sessionId, settings]);
    handleUsageLimitRecoveryResumeNowRef.current = handleResumeSession;

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

    const [followBottomIntentSeq, setFollowBottomIntentSeq] = React.useState(0);
    const markTranscriptLiveTailIntent = React.useCallback(() => {
        sync.markSessionLiveTailIntent(sessionId);
        setFollowBottomIntentSeq((current) => current + 1);
    }, [sessionId]);

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
          <>
              {authSurfaceState && !(inactiveUi.shouldShowInput && !isEncryptedSessionLocked) ? (
                  <View style={{ marginTop: 8, marginHorizontal: 8 }}>
                      <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                  </View>
              ) : null}
              <SessionTranscriptContent
                  sessionId={sessionId}
                  session={session}
                  isEncryptedSessionLocked={isEncryptedSessionLocked}
                  isForkedSessionV1={isForkedSessionV1}
                  isLocallyAttached={isLocallyAttached}
                  pendingMessagesCount={pendingMessages.length}
                  loadingColor={theme.colors.text.secondary}
                  bottomNotice={bottomNotice}
                  controlledByUserOverride={isLocallyAttached}
                  controlSwitchTo={controlSwitchTo}
                  onRequestSwitchToRemote={isHiddenSystemSessionSession || !canRequestRemoteControl ? undefined : handleRequestSwitchToRemote}
                  directControlFooter={directControlFooter}
                  jumpToSeq={jumpToSeq}
                  followBottomIntentKey={followBottomIntentSeq}
                  approvalRequests={approvalRequests}
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
            onRestoreSecretKeyPress={() => router.push('/restore/manual')}
            activityColor={theme.colors.text.secondary}
        />
    );

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
                setComposerDraftValue((prev) => {
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
            browserContext: browserContextComposerContext,
        });
        const routingControls = useSessionAgentInputRoutingControls({
            isReadOnly,
            participantTargets,
            recipientState,
        });
        const isRuntimeFreshActiveTurn =
            sessionStatus.state === 'thinking'
            || sessionStatus.state === 'permission_required'
            || sessionStatus.state === 'action_required';
        const intentionalRestartSourceEvents = React.useMemo<ReadonlyArray<SessionIntentionalRestartSourceEvent>>(() => {
            const events: SessionIntentionalRestartSourceEvent[] = [];
            for (const message of committedMessages) {
                if (message.kind !== 'agent-event') continue;
                if (message.event.type !== 'connected-service-account-switch') continue;
                events.push({
                    event: message.event,
                    createdAtMs: message.createdAt,
                });
            }
            return events;
        }, [committedMessages]);
        const intentionalRestartRecoveryEvidenceAtMs = React.useMemo(() => (
            resolveSessionIntentionalRestartRecoveryEvidenceAtMs({
                activeAt: sessionRuntimeStatusSource.activeAt,
                latestReadyEventAt: sessionRuntimeStatusSource.latestReadyEventAt,
                latestTurnStatus: sessionRuntimeStatusSource.latestTurnStatus,
                latestTurnStatusObservedAt: sessionRuntimeStatusSource.latestTurnStatusObservedAt,
                meaningfulActivityAt: sessionRuntimeStatusSource.meaningfulActivityAt,
            })
        ), [
            sessionRuntimeStatusSource.activeAt,
            sessionRuntimeStatusSource.latestReadyEventAt,
            sessionRuntimeStatusSource.latestTurnStatus,
            sessionRuntimeStatusSource.latestTurnStatusObservedAt,
            sessionRuntimeStatusSource.meaningfulActivityAt,
        ]);
        const intentionalRestartSignals = React.useMemo<ReadonlyArray<SessionIntentionalRestartSignal>>(() => (
            deriveSessionIntentionalRestartSignals({
                runtimeIssue: sessionRuntimeStatusSource.lastRuntimeIssue ?? null,
                events: intentionalRestartSourceEvents,
                recoveryEvidenceAtMs: intentionalRestartRecoveryEvidenceAtMs,
            })
        ), [
            intentionalRestartRecoveryEvidenceAtMs,
            intentionalRestartSourceEvents,
            sessionRuntimeStatusSource.lastRuntimeIssue,
        ]);
        const sessionConnectedServicesAuthSwitch = useSessionConnectedServicesAuthSwitch({
            sessionId,
            agentId,
            machineId: controlMachineTarget?.machineId ?? null,
            serverId: capabilityServerId,
            agentCore: agentId ? getAgentCore(agentId) : null,
            sessionMetadata: session.metadata,
            settings: {
                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesProviderStateSharingSettingsV1: settings.connectedServicesProviderStateSharingSettingsV1,
            },
            switchingDisabledReason: isReadOnly
                ? 'read_only'
                : isRuntimeFreshActiveTurn
                    ? 'active_turn'
                    : null,
            sessionActive: session.active === true,
            intentionalRestartSignals,
        });
        const connectedServicesRestartState = sessionConnectedServicesAuthSwitch.restartState;
        const connectionStatus = React.useMemo(() => resolveSessionViewConnectionStatus({
            connectedServicesRestartState,
            restartingText: t('connectedServices.authSwitch.status.restarting'),
            switchFailedText: t('connectedServices.authSwitch.switchFailed'),
            resumingText: t('session.resuming'),
            inactiveStatusText,
            sessionStatusText: sessionStatus.statusText,
            sessionStatusColor: sessionStatus.statusColor,
            sessionStatusDotColor: sessionStatus.statusDotColor,
            sessionStatusPulsing: sessionStatus.isPulsing === true,
            isResuming,
            isPendingQueueWakeResuming,
            isSessionStatusResuming: sessionStatus.state === 'resuming',
        }), [
            connectedServicesRestartState,
            inactiveStatusText,
            isPendingQueueWakeResuming,
            isResuming,
            sessionStatus.isPulsing,
            sessionStatus.state,
            sessionStatus.statusColor,
            sessionStatus.statusDotColor,
            sessionStatus.statusText,
        ]);
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
                    icon: (tint: string) => <Ionicons name="pencil-outline" size={13} color={tint} />,
                    onPress: cancelPendingMessageEdit,
                } satisfies AgentInputStatusBadge]
                : []),
        ], [
            cancelPendingMessageEdit,
            pendingMessageEdit,
            sessionConnectedServicesAuthSwitch.statusBadges,
            sessionStatusBadges,
        ]);
        // AgentInput goal chip (D4): the first-goal entry point on a fresh active goal-capable session
        // (present BEFORE any goal item exists — QA-CHIP-1) and an additional entry point alongside the
        // above-input work-state badge. Capability-gated via `canEditSessionGoals` (which already
        // requires write access — G5/D4 — so read-only sessions get no mutation chip). Stable array
        // reference so the chip-combine cache stays referentially stable.
        const sessionGoalActionChips = React.useMemo<ReadonlyArray<AgentInputExtraActionChip> | undefined>(() => {
            if (!canEditSessionGoals) return undefined;
            const activeGoalItem = sessionWorkStateSnapshot?.items.find(
                (item) => item.kind === 'goal' && item.status === 'active',
            ) ?? null;
            return [createGoalActionChip({
                snapshot: sessionWorkStateSnapshot,
                editableGoal: canEditSessionGoals,
                goalActionCapabilityProfile: sessionGoalActionCapabilityProfile,
                currentObjective: activeGoalItem?.title ?? null,
                onSetGoal: setSessionGoalForView,
                onClearGoal: clearSessionGoalForView,
            })];
        }, [
            canEditSessionGoals,
            clearSessionGoalForView,
            sessionGoalActionCapabilityProfile,
            sessionWorkStateSnapshot,
            setSessionGoalForView,
        ]);
        const agentInputExtraActionChips = combineSessionViewExtraActionChips(
            combineSessionViewExtraActionChips(
                combineSessionViewExtraActionChips(
                    extraActionChips,
                    sessionGoalActionChips,
                ),
                sessionConnectedServicesAuthSwitch.connectedServicesAuthChip
                    ? [sessionConnectedServicesAuthSwitch.connectedServicesAuthChip]
                    : undefined,
            ),
            routingControls.extraActionChips,
        );

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
            router.push(href);
            return;
        }

        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [multiPaneDeviceType, multiPaneEnabled, pane, pathname, router, sessionId, windowWidth]);

    const getAutocompleteSuggestions = React.useCallback((query: string) => {
        return getSuggestions(sessionId, query);
    }, [sessionId]);

    const handleAutocompleteSuggestionSelect = React.useCallback<AgentInputAutocompleteSelectionHandler>(async (args) => {
        try {
            return await resolvePromptInvocationAutocompleteSelection(args);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
            return { handled: true };
        }
    }, []);

    const input = shouldShowInput ? (
        <View>
            {voiceEnabled && voiceProviderId !== 'off' && !isHiddenSystemSessionSession ? <VoiceSurface variant="session" sessionId={sessionId} /> : null}
            {authSurfaceState ? (
                <ComposerAuxiliaryFrame>
                    <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                </ComposerAuxiliaryFrame>
            ) : null}
            {pendingQueueResumeFailed ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-pendingQueue-resumeFailed"
                        actionTestID="session-pendingQueue-resumeFailed-retry"
                        title={t('session.pendingQueuedResumeFailedTitle')}
                        body={t('session.pendingQueuedResumeFailedBody')}
                        actionLabel={t('common.retry')}
                        actionAccessibilityLabel={t('common.retry')}
                        disabled={isResuming}
                        onActionPress={async () => {
                            const ok = await handleResumeSession({ silent: false });
                            if (ok) {
                                setPendingQueueResumeFailed(false);
                            }
                        }}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {visibleUsageLimitRecoveryPresentation ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID={visibleUsageLimitRecoveryPresentation.banner.testID}
                        actionTestID={visibleUsageLimitRecoveryPresentation.banner.actionTestID}
                        title={visibleUsageLimitRecoveryPresentation.banner.title}
                        body={visibleUsageLimitRecoveryPresentation.banner.body}
                        actionLabel={visibleUsageLimitRecoveryPresentation.banner.actionLabel}
                        actionAccessibilityLabel={visibleUsageLimitRecoveryPresentation.banner.actionAccessibilityLabel}
                        disabled={usageLimitRecoveryActionsDisabled}
                        onActionPress={() => handleUsageLimitRecoveryAction(visibleUsageLimitRecoveryPresentation.banner.mode)}
                        secondaryActions={visibleUsageLimitRecoveryPresentation.banner.secondaryActions.map((action) => ({
                            key: action.kind,
                            accessibilityLabel: action.accessibilityLabel,
                            label: action.label,
                            testID: action.testID,
                            disabled: usageLimitRecoveryActionsDisabled,
                            onPress: () => handleUsageLimitRecoveryAction(action.kind),
                        }))}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {visibleStaleSessionRunnerPresentation ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID={visibleStaleSessionRunnerPresentation.banner.testID}
                        actionTestID={visibleStaleSessionRunnerPresentation.banner.actionTestID}
                        title={visibleStaleSessionRunnerPresentation.banner.title}
                        body={visibleStaleSessionRunnerPresentation.banner.body}
                        actionLabel={visibleStaleSessionRunnerPresentation.banner.actionLabel}
                        actionAccessibilityLabel={visibleStaleSessionRunnerPresentation.banner.actionAccessibilityLabel}
                        disabled={visibleStaleSessionRunnerPresentation.banner.disabled || !hasWriteAccess}
                        onActionPress={handleStaleSessionRunnerRestart}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            <AgentInput
                placeholder={isReadOnly ? t('session.sharing.viewOnlyMode') : t('session.inputPlaceholder')}
                value={message}
                onChangeText={setComposerDraftValue}
                sessionId={sessionId}
                contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET}
                agentType={agentInputAgentType ?? undefined}
                agentLabel={agentInputAgentType ? resolveSessionActionDefaultBackendTitle({
                    session,
                    sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
                }) || undefined : undefined}
                attachments={attachmentsUploadsEnabled ? agentInputAttachments : undefined}
                onAttachmentsAdded={attachmentsUploadsEnabled ? addAttachments : undefined}
                hasSendableAttachments={hasIncludedReviewCommentDrafts || (attachmentsUploadsEnabled && attachmentDrafts.length > 0)}
                permissionRequests={pendingPermissionRequests}
                approvalRequests={approvalRequests}
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
                connectionStatus={connectionStatus}
                onSend={(sendOptions) => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }

                    const composerMessage = sendOptions?.inputTextOverride ?? messageRef.current;
                    const activePendingEdit = pendingMessageEditRef.current;
                    if (activePendingEdit) {
                        const nextText = composerMessage;
                        if (nextText.trim().length === 0) {
                            return;
                        }
                        setIsComposerSending(true);
                        fireAndForget((async () => {
                            try {
                                await sync.updatePendingMessage(sessionId, activePendingEdit.pendingId, nextText);
                                if (pendingMessageEditRef.current?.pendingId === activePendingEdit.pendingId) {
                                    setPendingMessageEdit(null);
                                    clearPendingMessageEditDrainHold(activePendingEdit.holdId);
                                    restorePendingEditComposerSnapshotIfSafe(activePendingEdit);
                                }
                            } catch (e) {
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.updateFailed'));
                            } finally {
                                setIsComposerSending(false);
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
                        const nonSteerableSendPrompt = storage.getState().settings.sessionNonSteerableSendPrompt;
                        const permissionModeApplyTiming = storage.getState().settings.sessionPermissionModeApplyTiming === 'next_prompt'
                            ? 'next_prompt' as const
                            : 'current_turn' as const;
                        const forceImmediateSend = sendIntent?.forceImmediate === true;
                        const explicitSubmitMode = sendIntent?.deliveryIntent === 'server_pending' && !forceImmediateSend
                            ? 'server_pending' as const
                            : undefined;

                        const additionalMessage = messageToSend;
                        const trimmedText = messageToSend.trim();

                        // G4 busy-send honesty: when the payload can't steer the active turn, ask the
                        // user (apply & steer / steer without applying / queue / interrupt) before any
                        // composer state is touched. Explicit intents and the 'off' setting skip this.
                        const nonSteerablePlan = await resolveNonSteerableSendPlan({
                            session,
                            agentId,
                            text: trimmedText,
                            configuredMode,
                            busySteerSendPolicy,
                            permissionModeApplyTiming,
                            nonSteerableSendPrompt,
                            forceImmediate: forceImmediateSend,
                            explicitPendingIntent: explicitSubmitMode === 'server_pending',
                            structuredInputMetaOverrides: sendIntent?.structuredInputMetaOverrides ?? null,
                        });
                        if (nonSteerablePlan.kind === 'cancelled') {
                            return;
                        }
                        const nonSteerableExplicitMode = nonSteerablePlan.explicitMode;
                        const applyConfigAndSteer = nonSteerablePlan.applyConfigAndSteer === true;
                        const steerWithoutConfig = nonSteerablePlan.steerWithoutConfig === true;
                        const steerWithoutConfigMetaOverrides = nonSteerablePlan.steerWithoutConfigMetaOverrides ?? null;
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

                        const mergeBrowserContextMetaForSend = (
                            metaOverrides?: Record<string, unknown>,
                        ): Record<string, unknown> | undefined | null => {
                            const result = mergeBrowserContextMessageMetaOverrides({
                                state: browserContextStateForComposer,
                                metaOverrides,
                            });
                            if (result.ok) {
                                return result.metaOverrides;
                            }
                            Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                            return null;
                        };
                        if (mergeBrowserContextMetaForSend() === null) {
                            return;
                        }

                        const submittedComposerText = composerTextBeforeSend;
                        const sendSnapshot = { sessionId, text: submittedComposerText };
                        const semanticDraftSnapshot = captureComposerSemanticDraftSnapshot();
                        let semanticDraftSnapshotAfterHandoffClear: ComposerSemanticDraftSnapshot | null = null;
                        const transientInputStateHandoff = captureComposerTransientInputStateForOutboundHandoff({
                            captureTransientInputState: inputComposerPersistence.captureTransientInputState,
                            clearTransientInputState: inputComposerPersistence.clearTransientInputState,
                            restoreTransientInputState: inputComposerPersistence.restoreTransientInputState,
                        });
                        let didClearAtOutboundHandoff = false;
                        let didRecordOutboundAccepted = false;
                        const recordOutboundAccepted = () => {
                            if (didRecordOutboundAccepted) return;
                            didRecordOutboundAccepted = true;
                            trackMessageSent();
                            markTranscriptLiveTailIntent();
                        };
                        const clearAfterOutboundHandoff = () => {
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
                            attachmentDraftsSnapshotRef.current = drafts;
                            writeSessionAttachmentDrafts(sessionId, drafts);
                            attachmentDraftManager.replaceDrafts(drafts);
                        };
                        const restoreAfterFailedOutboundHandoff = (attachmentDraftsForRestore?: readonly AttachmentDraft[]) => {
                            const didRestore = restoreComposerAfterFailedOutboundHandoff({
                                snapshot: sendSnapshot,
                                wasClearedAtHandoff: didClearAtOutboundHandoff,
                                isSemanticRestoreSafe: () =>
                                    semanticDraftSnapshotAfterHandoffClear !== null
                                    && isComposerSemanticDraftSnapshotCurrent(semanticDraftSnapshotAfterHandoffClear),
                                restoreDraftForSessionIfCurrentValueMatches,
                                restoreTransientInputState: transientInputStateHandoff.restoreTransientInputState,
                                restoreSemanticDraftValues: () => {
                                    restoreSemanticDraftValuesFromSnapshot(semanticDraftSnapshot);
                                },
                            });
                            if (didRestore && attachmentDraftsForRestore) {
                                restoreAttachmentDraftsFromSnapshot(attachmentDraftsForRestore);
                            }
                            return didRestore;
                        };

                        if (hasAttachments) {
                            setIsComposerSending(true);
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
                                    const readyForSend = await externalSessionTakeover.ensureReadyForSend();
                                    if (!readyForSend) {
                                        return;
                                    }
                                    const sessionForSubmit = readLatestSessionForSubmit();
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
                                        applyDraftPatch: applyAttachmentDraftPatch,
                                    });
                                    const attachmentsBlock = formatAttachmentsBlock(uploaded);
                                    const attachmentsMetaOverrides = buildAttachmentMessageMeta(uploaded);

                                    const outbound = shouldSendReviewComments
                                        ? buildReviewCommentsOutboundMessage({
                                            sessionId,
                                            drafts: await resolveReviewCommentDraftAnchorsForPrompt({
                                                drafts: includedReviewCommentDrafts,
                                                reviewScope,
                                            }),
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
                                    const outboundMetaOverrides = mergeMessageMetaOverrides(
                                        outbound.metaOverrides,
                                        sendIntent?.structuredInputMetaOverrides,
                                    );
                                    const outboundMetaOverridesWithBrowserContext = mergeBrowserContextMetaForSend(outboundMetaOverrides);
                                    if (outboundMetaOverridesWithBrowserContext === null) {
                                        return;
                                    }

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
                                    const result = await submitSessionUserMessage(sessionSubmitPortWithWakeState, {
                                        sessionId,
                                        session: sessionForSubmit,
                                        text: outbound.text,
                                        displayText: outbound.displayText,
                                        metaOverrides: steerWithoutConfigMetaOverrides
                                            ? { ...outboundMetaOverridesWithBrowserContext, ...steerWithoutConfigMetaOverrides }
                                            : outboundMetaOverridesWithBrowserContext,
                                        configuredMode,
                                        busySteerSendPolicy,
                                        nonSteerableSendPrompt,
                                        permissionModeApplyTiming,
                                        ...(applyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                                        ...(steerWithoutConfig ? { steerWithoutConfig: true } : {}),
                                        explicitMode: nonSteerableExplicitMode ?? explicitSubmitMode,
                                        forceImmediate: forceImmediateSend,
                                        profileId: liveComposerState.profileId ?? null,
                                        resumeCapabilityOptions,
                                        resumeTargetOverride: reachableMachineTarget
                                            ? {
                                                machineId: reachableMachineTarget.machineId,
                                                directory: reachableMachineTarget.basePath,
                                            }
                                            : null,
                                        permissionOverride: getPermissionModeOverrideForSpawn(sessionForSubmit),
                                        serverId: capabilityServerId,
                                        requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(sessionForSubmit, cliAuthStatus?.state ?? null),
                                        callerSurface: shouldSendReviewComments
                                            ? 'session_attachment_review_comment_composer'
                                            : 'session_attachment_composer',
                                        onOutboundHandoff: (handoff) => {
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
                                    setIsComposerSending(false);
                                }
                            })(), { tag: 'SessionView.sendMessage.attachments' });
                            return;
                        }

                        setIsComposerSending(true);
                        fireAndForget((async () => {
                            try {
                                let outbound: {
                                    text: string;
                                    displayText?: string;
                                    metaOverrides?: Record<string, unknown>;
                                } | null = shouldSendReviewComments
                                    ? { ...buildReviewCommentsOutboundMessage({
                                        sessionId,
                                        drafts: await resolveReviewCommentDraftAnchorsForPrompt({
                                            drafts: includedReviewCommentDrafts,
                                            reviewScope,
                                        }),
                                        additionalMessage,
                                    }) }
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
                                outbound.metaOverrides = mergeMessageMetaOverrides(
                                    outbound.metaOverrides,
                                    sendIntent?.structuredInputMetaOverrides,
                                );
                                if (executionRunSend && hasBrowserContextComposerAttachments(browserContextStateForComposer)) {
                                    Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                                    return;
                                }

                                const outboundMetaOverridesWithBrowserContext = mergeBrowserContextMetaForSend(outbound.metaOverrides);
                                if (outboundMetaOverridesWithBrowserContext === null) {
                                    return;
                                }
                                outbound.metaOverrides = outboundMetaOverridesWithBrowserContext;

                                if (executionRunSend) {
                                    const readyForSend = await externalSessionTakeover.ensureReadyForSend();
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
                                    return;
                                }

                                const readyForSend = await externalSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    return;
                                }
                                const sessionForSubmit = readLatestSessionForSubmit();

                                const result = await submitSessionUserMessage(sessionSubmitPortWithWakeState, {
                                    sessionId,
                                    session: sessionForSubmit,
                                    text: outbound.text,
                                    displayText: outbound.displayText,
                                    metaOverrides: steerWithoutConfigMetaOverrides
                                        ? { ...outbound.metaOverrides, ...steerWithoutConfigMetaOverrides }
                                        : outbound.metaOverrides,
                                    configuredMode,
                                    busySteerSendPolicy,
                                    nonSteerableSendPrompt,
                                    permissionModeApplyTiming,
                                    ...(applyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                                    ...(steerWithoutConfig ? { steerWithoutConfig: true } : {}),
                                    explicitMode: nonSteerableExplicitMode ?? explicitSubmitMode,
                                    forceImmediate: forceImmediateSend,
                                    profileId: liveComposerState.profileId ?? null,
                                    resumeCapabilityOptions,
                                    resumeTargetOverride: reachableMachineTarget
                                        ? {
                                            machineId: reachableMachineTarget.machineId,
                                            directory: reachableMachineTarget.basePath,
                                        }
                                        : null,
                                    permissionOverride: getPermissionModeOverrideForSpawn(sessionForSubmit),
                                    serverId: capabilityServerId,
                                    requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(sessionForSubmit, cliAuthStatus?.state ?? null),
                                    callerSurface: shouldSendReviewComments
                                        ? 'session_review_comment_composer'
                                        : 'session_composer',
                                    onOutboundHandoff: (handoff) => {
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

                                if (result.persistence !== 'none') {
                                    if (shouldSendReviewComments) {
                                        clearSentReviewCommentDrafts();
                                    }
                                }

                                if (result.type === 'wake_pending' || result.type === 'wake_failed') {
                                    if (!isSessionActive && isResumable) {
                                        setPendingQueueResumeFailed(true);
                                    }
                                    return;
                                }
                            } finally {
                                setIsComposerSending(false);
                            }
                        })(), { tag: 'SessionView.sendMessage.submitMessage' });
                    };

                    const promptInvocationsV1 = storage.getState().settings.promptInvocationsV1;
                    const resolved = resolveSessionComposerSend({ input: composerMessage, executionRunsEnabled, promptInvocationsV1 });
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
                                    setComposerDraftValue(expanded);
                                    return;
                                }

                                await sendComposerText(expanded, composerTextBeforeSend, sendOptions);
                            } catch (e) {
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                            }
                        })(), { tag: 'SessionView.sendMessage.template' });
                        return;
                    }

                    if (
                        resolved.kind === 'goal' ||
                        (
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
                        if (!agentId && resolved.kind === 'action' && resolved.actionId !== 'ui.pet.choose') {
                            Modal.alert(t('common.error'), t('session.resumeFailed'));
                            return;
                        }
                        const previousMessage = composerMessage;
                        void executeSessionComposerResolution({
                            resolved,
                            sessionId,
                            agentId: agentId ?? '',
                            backendTarget: sessionActionDefaultBackend?.backendTarget ?? null,
                            permissionMode,
                            actionExecutor,
                            previousMessage,
                            setMessage: setComposerDraftValue,
                            clearDraft,
                            clearTransientInputState: inputComposerPersistence.clearTransientInputState,
                            clearSemanticDraftValues: clearSemanticDraftValuesAfterAcceptedComposerClear,
                            restoreDraft,
                            restoreComposerSnapshotIfCurrentValueMatches: restoreDraftForSessionIfCurrentValueMatches,
                            restoreComposerSnapshot,
                            trackMessageSent,
                            navigateToRuns: () => router.push(buildCurrentSessionHref('/runs') as any),
                            navigateToPetSettings: () => router.push('/settings/pets' as any),
                            openGoalControls: () => setActiveStatusBadgeKey(SESSION_WORK_STATE_STATUS_BADGE_KEY),
                            setSessionGoal: canEditSessionGoals
                                ? (targetSessionId, request) => sessionGoalSet(targetSessionId, request)
                                : undefined,
                            clearSessionGoal: canEditSessionGoals
                                ? (targetSessionId) => sessionGoalClear(targetSessionId)
                                : undefined,
                            modalAlert: (_title, msg) => Modal.alert(t('common.error'), msg),
                        });
                        return;
                    }

                    if (resolved.kind !== 'send') return;
                    fireAndForget(sendComposerText(resolved.text, composerMessage, sendOptions), { tag: 'SessionView.sendMessage.composerText' });
                }}
                isSendDisabled={!shouldShowInput || isResuming || isReadOnly || isUploadingAttachments}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                onAbort={() => sessionAbort(sessionId)}
                showAbortButton={shouldShowAbortButtonForSessionState(sessionStatus.state)}
                onFileViewerPress={openFileViewer}
                // Autocomplete configuration
                autocompletePrefixes={SESSION_COMPOSER_AUTOCOMPLETE_PREFIXES}
                autocompleteSuggestions={getAutocompleteSuggestions}
                onAutocompleteSuggestionSelect={handleAutocompleteSuggestionSelect}
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
                    contextSnapshot: sessionUsageWithContextWindowTokens.contextSnapshot,
                    contextSnapshotStale: sessionUsageWithContextWindowTokens.contextSnapshotStale,
                } : latestUsageWithContextWindowTokens ? {
                    inputTokens: latestUsageWithContextWindowTokens.inputTokens,
                    outputTokens: latestUsageWithContextWindowTokens.outputTokens,
                    cacheCreation: latestUsageWithContextWindowTokens.cacheCreation,
                    cacheRead: latestUsageWithContextWindowTokens.cacheRead,
                    contextSize: latestUsageWithContextWindowTokens.contextSize,
                    ...(typeof latestUsageWithContextWindowTokens.contextWindowTokens === 'number'
                        ? { contextWindowTokens: latestUsageWithContextWindowTokens.contextWindowTokens }
                        : {}),
                    contextSnapshot: latestUsageWithContextWindowTokens.contextSnapshot,
                    contextSnapshotStale: latestUsageWithContextWindowTokens.contextSnapshotStale,
                } : undefined}
                alwaysShowContextSize={alwaysShowContextSize}
                providerUsageGauge={providerUsageGauge}
                onProviderUsageRecoveryCreditPress={providerUsageRecoveryCreditAction}
                providerUsageRecoveryCreditPending={providerUsageRecoveryCreditActionPending}
                statusBadges={agentInputStatusBadges}
                activeStatusBadgeKey={activeStatusBadgeKey}
                onActiveStatusBadgeKeyChange={setActiveStatusBadgeKey}
                extraActionChips={agentInputExtraActionChips}
                isSending={isComposerSending}
                inputMaxHeight={maxAgentInputTextHeight}
                inputExpansion={inputExpansion}
                inputPersistence={inputComposerPersistence.inputPersistence}
                structuredInputMentions={inputComposerPersistence.structuredInputPersistence.mentions}
                onStructuredInputMentionsChange={inputComposerPersistence.structuredInputPersistence.onMentionsChange}
                maxPanelHeight={maxAgentInputPanelHeight}
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

    const main = (
        <TranscriptMessageSelectionProvider
            sessionId={sessionId}
            eligibleMessageIdsInOrder={transcriptSelectionEligibleMessageIds}
            enabled={transcriptMessageSelectionEnabled === true && !isEncryptedSessionLocked}
        >
            <SessionTranscriptViewLayout
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
            />
        </TranscriptMessageSelectionProvider>
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
