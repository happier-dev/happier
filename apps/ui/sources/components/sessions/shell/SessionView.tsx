import {
    AgentInput,
    type AgentInputSendOptions,
} from '@/components/sessions/agentInput';
import type { SessionInstrumentStripQuota } from '@/components/sessions/agentInput/instrumentStrip';
import {
    computeExistingSessionComposerInputMaxHeight,
    computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import {
    useComposerAvailablePanelHeight,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';
import type {
    AgentInputExtraActionChip,
    AgentInputStatusBadge,
} from '@/components/sessions/agentInput/agentInputContracts';
import { projectAgentInputAttachmentRowItems } from '@/components/sessions/agentInput/agentInputContracts';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type {
    AttachmentFilePickerHandle,
    PickedAttachment,
} from '@/components/sessions/attachments/AttachmentFilePicker.types';
import {
    openAttachmentFilePickerFiles,
    openAttachmentFilePickerImages,
} from '@/components/sessions/attachments/attachmentFilePickerActions';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionAgentInputExtraActionChips } from '@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips';
import {
    openPluginContributedAction,
    openPluginContributedActionSessionReference,
} from '@/components/plugins/actions/openPluginContributedAction';
import {
    type PluginContributedActionController,
    type PluginContributedActionDescriptor,
    type PluginContributedActionOpenOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';
import { useSessionConnectedServicesAuthSwitch } from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';
import {
    deriveSessionIntentionalRestartSignals,
    resolveSessionIntentionalRestartRecoveryEvidenceAtMs,
    type SessionIntentionalRestartSignal,
    type SessionIntentionalRestartSourceEvent,
} from '@/components/sessions/agentInput/hooks/sessionIntentionalRestartSignal';
import {
    SESSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerReferenceSearchHost,
} from '@/components/autocomplete/composerSuggestionKinds';
import type { AutocompleteSuggestionUpdate } from '@/components/autocomplete/autocompleteTypes';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { CurrentSessionPresentationSurface } from '@/components/sessions/presentation/CurrentSessionPresentationSurface';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import {
    applyComposerPresentationTransaction,
    notifyComposerPresentationTargetChanged,
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    subscribeComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import {
    PluginContextualResourceStoreProvider,
} from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import {
    projectComposerAttachmentRowItems,
} from '@/components/sessions/composer/composerAttachmentProjection';
import { createExistingSessionComposerDocumentOwner } from '@/components/sessions/composer/existingSessionComposerDocumentOwner';
import { createPendingMessageComposerDocumentOwner } from '@/components/sessions/composer/pendingMessageComposerDocumentOwner';
import type { MutableComposerDocumentOwner } from '@/components/sessions/composer/composerDocumentOwner';
import {
    createEphemeralComposerDocumentOwner,
    sameComposerAttachmentViews,
} from '@/components/sessions/composer/composerDocumentOwner';
import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import {
    composerAttachmentDraftToView,
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    resolveCurrentComposerAttachmentCatalogEntry,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    readComposerSubmissionFieldCurrentness,
    submitComposerSnapshot,
    type ComposerSubmissionAdmissionHandoff,
    type ComposerSubmissionAdmissionOutcome,
    type ComposerSubmissionFieldCurrentness,
    type ComposerSubmissionResult,
    type ComposerSubmissionSnapshot,
} from '@/components/sessions/composer/composerSubmissionCoordinator';
import { useOpenAttachedSessionTerminal } from '@/components/sessions/terminal/openAttachedSessionTerminal';
import {
    ChatList,
    type TranscriptViewportChangeState,
} from '@/components/sessions/transcript/ChatList';
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
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { useDraft } from '@/hooks/session/useDraft';
import {
    SessionDraftConflictResolution,
    useSessionDraftConflictComposerBanner,
} from '@/components/sessions/drafts/SessionDraftConflictResolution';
import {
    captureComposerTransientInputStateForOutboundHandoff,
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from '@/hooks/session/sessionComposerSendCoordinator';
import { useSessionAgentInputComposerPersistence } from '@/hooks/session/useSessionAgentInputComposerPersistence';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useSessionExecutionRunsSupported } from '@/hooks/server/useSessionExecutionRunsSupported';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { useScmSessionAutoRefresh } from '@/scm/refresh/useScmSessionAutoRefresh';
import {
    sessionAbort,
    resumeSession,
} from '@/sync/ops';
import {
    storage,
    useActiveServerAccountScope,
    useEnabledAutomationsCountForSession,
    useEndpointConnectivity,
    useIsDataReady,
    useLocalSetting,
    useOpenApprovalArtifactsForSession,
    useProfile,
    useSessionMessages,
    useMachine,
    useSessionPendingMessages,
    useSessionTranscriptIds,
    useSessionVisibleReadSeq,
    useSetting,
    useSocketStatus,
    useSettingMutable,
    useSettings,
    useSyncError,
    useWorkspaceReviewCommentsDrafts,
} from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { readMessageDisplayText } from '@/sync/domains/messages/messageDisplayText';
import { isRecoveredHistoryTranscriptObservation } from '@/sync/domains/messages/transcriptObservationProvenance';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import {
    canContinueSessionWithFreshSpawn,
    canResumeSessionWithOptions,
} from '@/agents/runtime/resumeCapabilities';
import {
    resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    getAgentCore,
    isBundledAgentId,
    resolveAgentIdFromFlavor,
    buildResumeSessionExtrasFromUiState,
} from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    readCurrentProjectedAgentCapabilities,
    supportsAgentLifecycleCapability,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import {
    readExternalSessionOperationState,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { useInSessionAgentPickerControls } from '@/components/sessions/agentPicker/useInSessionAgentPickerControls';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { writeSessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import { Session, type Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { sync } from '@/sync/sync';
import {
    acceptPendingMessageComposerAdmission,
    preparePendingMessageComposerAdmission,
} from '@/sync/ops/pendingMessageComposerAdmission';
import type { SessionTranscriptLoadIssue } from '@/sync/store/domains/transcriptLoading';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import {
    buildReviewCommentsV1MetaPayload,
    parseReviewCommentsV1,
} from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { resolveSessionComposerSend } from '@/sync/domains/input/slashCommands/resolveSessionComposerSend';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { resolvePromptInvocationComposerSendAction } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';
import { SESSION_DRAFT_VALUE_FIELD_CATALOG } from '@/sync/domains/input/draftValues/sessionDraftValueFieldCatalog';
import type {
    SessionArmedAgentContinuationSubmission,
    SessionDraftValueFieldId,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { SESSION_DRAFT_VALUE_SCHEMAS } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    flushSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import { t, tLoose, type TranslationKey } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { getSessionName, getSessionStatus, listPendingPermissionRequests, shouldReadTranscriptForPendingRequests, shouldShowAbortButtonForSessionState, useSessionStatus } from '@/utils/sessions/sessionUtils';
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
    resolveParticipantRoutedSend,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
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
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { hasSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { nowServerMs } from '@/sync/runtime/time';
import { readSessionUiTelemetryNowMs } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import {
    decidePendingMessageComposerRotation,
    derivePendingMessageComposerSuccessorEditState,
    hydratePendingMessageComposerAttachmentDrafts,
    readPendingMessageComposerSemanticDraftFieldsToRestore,
    type PendingMessageComposerEditState,
    type PendingMessageComposerExposedSuccessor,
    type PendingMessageComposerSemanticDraftSnapshot as ComposerSemanticDraftSnapshot,
} from './pendingMessageComposerEditSnapshot';
import { resolveHappierReplayConfig } from '@/sync/domains/session/resume/happierReplayPrompt';
import { buildNewSessionSourceContextNavigation } from '@/components/sessions/new/navigation/newSessionSourceContextNavigation';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
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
import { resolveNonSteerableSendPlan } from '@/components/sessions/agentInput/nonSteerableSendPreflight';
import { createSyncBackedSubmitPort } from '@/sync/domains/session/input/syncBackedSubmitPort';
import {
    normalizeUsageLimitRecoverySettings,
    updateUsageLimitRecoveryRememberedMode,
} from '@/sync/domains/settings/usageLimitRecoverySettings';
import { isSessionLocallyAttached } from '@/sync/domains/session/control/sessionLocalControl';
import {
    findModelOptionForEffectiveModelId,
    getModelOptionsForSession,
    isModelSelectableForSession,
    resolveCanonicalNativeModelSelectionRef,
    supportsFreeformModelSelectionForSession,
} from '@/sync/domains/models/modelOptions';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import {
    computeAcpConfigOptionControlsFromOverride,
    resolveSessionConfigOptionOverridesFromMetadata,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { layout } from '@/components/ui/layout/layout';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useUnistyles } from 'react-native-unistyles';
import { sessionSwitch } from '@/sync/ops';
import { shouldRenderChatTimelineForSession, shouldRequestRemoteControl, shouldRequestRemoteControlAfterPendingEnqueue } from '@/sync/domains/session/control/localControlSwitch';
import { readControlSwitchUiTimeoutMsFromEnv } from '@/sync/domains/session/control/controlSwitchUiTimeout';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { shadowLevelStyle } from '@/shadowElevation';
import { resolveVoiceSessionComposerRouting } from '@/voice/binding/voiceSessionComposerRouting';
import { sendVoiceSessionComposerText } from '@/voice/binding/sendVoiceSessionComposerText';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import {
    buildExactTurnAutomationRouteParams,
    readExactActiveParentTurn,
} from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
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
import { readStaleSessionRunnerRuntimeState } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus';
import {
    sessionRunnerRuntimeStatusRetention as sessionRunnerRuntimeStatusRetentionStore,
    type SessionRunnerRuntimeStatusIdentity,
    type SessionRunnerRuntimeStatusSnapshot,
} from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import {
    getSessionRunnerRuntimeStatusSnapshot,
    restartSessionRunnerForProviderBindingChange,
    restartSessionRunnerOnCurrentRuntime,
} from '@/sync/ops/sessionRunnerRestart';
import {
    readSessionWorkStateFromMetadata,
    resolvePrimarySessionWorkStateItem,
} from '@/sync/domains/session/workState/readSessionWorkState';
import { SessionWorkStatePopover } from '@/components/sessions/workState/SessionWorkStatePopover';
import { isSessionGoalEditingAvailable } from '@/components/sessions/workState/sessionGoalEditingAvailability';
import { createGoalActionChip } from '@/components/sessions/agentInput/definitions/createGoalActionChip';
import {
    resolveSessionActionDefaultBackend,
    resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
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
import { useExternalSessionMaterialize } from '@/components/sessions/model/useExternalSessionMaterialize';
import { useExternalSessionRuntime } from '@/components/sessions/model/useExternalSessionRuntime';
import { SessionExternalSessionRuntimeProvider } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useAuth } from '@/auth/context/AuthContext';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { resolveSessionGoalActionCapabilityProfile, supportsEditableSessionGoals } from '@/agents/registry/registryUiBehavior';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import {
    ConnectedServiceIdSchema,
    RawIngressStructuredInputV1Schema,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentInputV1,
    type ComposerRefV1,
    type ComposerSnapshotV1,
    type ComposerTransactionResultV1,
    type PluginContributionIdentityV1,
    SESSION_RUNNER_RUNTIME_METADATA_KEY,
    type ConnectedServiceQuotaSnapshotV1,
    isHiddenSystemSession,
    readSessionProviderBindingMetadataV1,
    removeSessionPendingQueueHoldV1FromMetadata,
    SessionModelTransitionResultV1Schema,
    SessionRunnerRuntimeStateV1Schema,
    sameStrictJsonValue,
    StrictJsonValueSchema,
    type ProviderBoundModelRef,
    readProviderSettingsFromAccountSettingsV1,
    writeSessionPendingQueueHoldV1ToMetadata,
} from '@happier-dev/protocol';
import { useProviderBindingStatus } from '@/providers/hooks/useProviderBindingStatus';
import { presentSessionProviderBinding } from '@/providers/session/presentation';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import {
    hiddenModelVisibilityKeys,
    type SessionModelProjectionGroup,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { hapticsLight } from '@/components/ui/theme/haptics';
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
import {
    ComposerBannerCollapseProvider,
    useComposerBannerCollapse,
} from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { buildComposerBannerBadgeAccessibility } from '@/components/sessions/composerBanners/composerBannerCollapse';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    createExternalSessionTranscriptLiveSourceKeyFromLink,
    resolveExternalSessionTranscriptAuthorityState,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { combineSessionViewExtraActionChips } from './view/combineSessionViewExtraActionChips';
import { resolveSessionViewModeOptionIds } from './view/resolveSessionViewModeOptionIds';
import { resolveSessionViewHeaderProps } from './view/resolveSessionViewHeaderProps';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalSessionRuntimePresentation,
} from '../presentation/externalSessionRuntimePresentation';
import { resolveExternalSessionIdentityPresentation } from '../presentation/externalSessionIdentityPresentation';
import {
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from '@/hooks/session/sessionListRuntimeClock';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import {
    PluginSurfacePaneLaunchScope,
    stagePluginSurfacePaneLaunch,
    type PluginSurfaceDestinationOpenResolution,
    type PluginSurfaceDestinationNavigationBinding,
    usePluginSurfacePaneLaunchScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from '@/components/plugins/surfaces/openPluginSurface';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveSessionViewExternalControlFooter } from './view/resolveSessionViewExternalControlFooter';
import { presentExternalSessionOperationShell } from '../external/progress/externalSessionOperationShellPresentation';
import {
    readExternalSessionOperationPresentationFromMetadata,
} from '../transcript/items/externalSessionOperationMetadata';
import { resolveSessionViewRuntimeDisplayState } from './view/resolveSessionViewRuntimeDisplayState';
import { resolveSessionViewConnectionStatus } from './view/resolveSessionViewConnectionStatus';
import { isSessionRootRoutePathActive, isSessionRoutePathActive } from './view/isSessionRoutePathActive';
import { useSurfaceAnchorPathname } from './surface/sessionSurfaceAnchorPathname';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { useSessionReachableMachineTarget } from '../model/useSessionMachineReachability';
import { useSessionMachineControlTarget } from '../model/useSessionMachineTarget';
import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
} from '@/components/sessions/agentInput/structuredInputMentions';
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
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import {
    resolveConnectedServiceQuotaProfileRefForSession,
} from './resolveConnectedServiceQuotaProfileRefForSession';
import {
    computeProviderAccountUsageGaugeViewModel,
    selectProviderUsageDisplaySource,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors';
import {
    SPAWN_SESSION_ERROR_CODES,
    readProviderAccountUsageRecordIdsFromMetadata,
    type ComposerAgentContinuationIntentV1,
    type SessionAgentTransitionResultV1,
} from '@happier-dev/protocol';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export { resolveSessionAuthSurfaceState } from './sessionAuthSurfaceState';

const MAX_USAGE_LIMIT_RECOVERY_READY_TIMER_MS = 2_147_483_647;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS = 2 * 60 * 1000;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_REFRESH_MS = 30 * 1000;
const EMPTY_SESSION_MODEL_PROJECTION_GROUPS: readonly SessionModelProjectionGroup[] = [];

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
        && !isRecoveredHistoryTranscriptObservation(message)
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

type ComposerSemanticDraftCurrentnessSnapshot = Readonly<{
    values: ComposerSemanticDraftSnapshot;
    repositoryCurrentness: SessionDraftCurrentness;
}>;

const SESSION_COMPOSER_DRAFT_FIELD_IDS = Object.keys(
    SESSION_DRAFT_VALUE_FIELD_CATALOG,
) as SessionDraftValueFieldId[];

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

function readUsageLimitRecoveryDiagnosticProfileActionRoute(
    result: SessionUsageLimitRecoveryOperationFailureResult,
): ReturnType<typeof resolveConnectedServiceProfileActionRoute> {
    const rawServiceId = typeof result.uxDiagnostic?.serviceId === 'string'
        ? result.uxDiagnostic.serviceId.trim()
        : '';
    const rawProfileId = typeof result.uxDiagnostic?.profileId === 'string'
        ? result.uxDiagnostic.profileId.trim()
        : '';
    return resolveConnectedServiceProfileActionRoute(
        {
            serviceId: rawServiceId,
            ...(rawProfileId ? { profileId: rawProfileId } : {}),
        },
        getConnectedServiceRegistrySnapshot().entries,
    );
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

function useSessionRunnerRuntimeStatusRetention(input: Readonly<{
    enabled: boolean;
    serverId: string;
    sessionId: string;
    machineId?: string | null;
    activeSelectionRunnerKey?: string | null;
}>): Readonly<{
    machineId: string | null;
    status: SessionRunnerRuntimeStatusSnapshot | null;
    invalidateAndRefresh: () => void;
}> {
    const machineId = typeof input.machineId === 'string' && input.machineId.trim()
        ? input.machineId.trim()
        : null;
    const identity = React.useMemo<SessionRunnerRuntimeStatusIdentity | null>(() => (
        input.enabled && input.sessionId && machineId
            ? {
                serverId: input.serverId,
                machineId,
                sessionId: input.sessionId,
            }
            : null
    ), [input.enabled, input.serverId, input.sessionId, machineId]);
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
        if (!identity || !machineId || !input.sessionId) return;

        let cancelled = false;
        const requestRevision = requestRevisionRef.current;
        const refresh = sessionRunnerRuntimeStatusRetentionStore.beginRefresh(identity);
        setStatusRevision((revision) => revision + 1);
        void getSessionRunnerRuntimeStatusSnapshot({
            sessionId: input.sessionId,
            machineId,
            serverId: input.serverId,
        }).then((state) => {
            if (cancelled || requestRevision !== requestRevisionRef.current) return;
            sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, state);
            setStatusRevision((revision) => revision + 1);
        });
        return () => {
            cancelled = true;
            sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, null);
        };
    }, [
        identity,
        input.serverId,
        input.sessionId,
        machineId,
        refreshRevision,
        input.activeSelectionRunnerKey,
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
    externalControlFooter: ChatListProps['externalControlFooter'];
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
    externalControlFooter,
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
            {shouldRenderChatTimeline ? (
                <ExternalTranscriptLoadIssueBanner sessionId={sessionId} retainedTranscriptVisible />
            ) : null}
            {shouldRenderChatTimeline && shouldRenderChatTimelineImmediately ? (
                <ChatList
                    session={session}
                    bottomNotice={bottomNotice}
                    controlledByUserOverride={controlledByUserOverride}
                    controlSwitchTo={controlSwitchTo}
                    onRequestSwitchToRemote={onRequestSwitchToRemote}
                    externalControlFooter={externalControlFooter}
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
            await sync.refreshSessionMessages(sessionId);
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
    const routeFocused = useSessionScreenIsFocused();
    const pathname = usePathname();
    const isFocused = typeof props.surfaceFocusedOverride === 'boolean'
        ? props.surfaceFocusedOverride
        : routeFocused;
    const isSurfaceVisible = typeof props.surfaceVisibleOverride === 'boolean'
        ? props.surfaceVisibleOverride
        : true;
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const isRouteAnchor = typeof props.routeAnchorOverride === 'boolean'
        ? props.routeAnchorOverride
        : isSessionRoutePathActive(anchorPathname, sessionId);

    return (
        <SessionViewRetainedSurface
            key={sessionId}
            {...props}
            sessionId={sessionId}
            isFocused={isFocused}
            isSurfaceVisible={isSurfaceVisible}
            isRouteAnchor={isRouteAnchor}
        />
    );
});

const SessionViewRetainedSurface = React.memo((props: SessionViewProps & {
    sessionId: string;
    isFocused: boolean;
    isSurfaceVisible: boolean;
    isRouteAnchor: boolean;
}) => {
    const isPresented = (props.isFocused || props.isRouteAnchor) && props.isSurfaceVisible;
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
            <PluginSurfacePaneLaunchScope>
                <SessionViewFocusedSurface
                    {...props}
                    isPresented={isPresented}
                />
            </PluginSurfacePaneLaunchScope>
        </View>
    );
});

const SessionViewFocusedSurface = React.memo((props: SessionViewProps & {
    sessionId: string;
    isFocused: boolean;
    isSurfaceVisible: boolean;
    isPresented: boolean;
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
    const ownerMetadata = session
        ? readSessionOwnerMetadataView(session)
        : null;
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
    const statusControlMachineTarget = useSessionMachineControlTarget(sessionId);
    const currentSessionMachineId = statusControlMachineTarget?.machineId
        ?? headerMachineTarget?.machineId
        ?? null;
    const sessionRunnerRuntimeStatusRetention = useSessionRunnerRuntimeStatusRetention({
        enabled: Boolean(session && shouldRenderSessionSurface),
        serverId: currentSessionRouteServerId,
        sessionId,
        machineId: statusControlMachineTarget?.machineId
            ?? headerMachineTarget?.machineId
            ?? ownerMetadata?.machineId,
        activeSelectionRunnerKey: ownerMetadata?.sessionModelsV1?.activeSelectionV1
            ? JSON.stringify(ownerMetadata.sessionModelsV1.activeSelectionV1.runner)
            : null,
    });
    const paneScopeId = useRegisterSessionPaneDriver(sessionId);
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
    });
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const stableSessionForLoadedView = session;
    const stableSessionForHeader = stableSessionForLoadedView ?? session;
    const externalSessionRuntime = useExternalSessionRuntime({
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
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntime({
        enabled: browserContextFeatureEnabled && isSurfaceFocused && session != null,
        scopeKey: acceptedSessionId,
        nowMs: nowServerMs,
        onAttachUnavailable: React.useCallback(() => {
            Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
        }, []),
    });
    // The narrow width: this shell needs the numbers and the recipient list, not the transcript
    // detail the Agents pane pays for. The counts come from the ONE owner, so the header glyph and
    // the pane it opens cannot report different amounts of work.
    const { counts: subagentCounts, participantTargets } = useSessionAgentActivity({
        sessionId: acceptedSessionId,
        session,
        externalSessionRuntime,
    });
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
    const attachedSessionTerminal = useOpenAttachedSessionTerminal(session ? sessionId : null);
    const routerRef = React.useRef(router);
    routerRef.current = router;
    const toggleWorkspaceExperienceRef = React.useRef(toggleWorkspaceExperience);
    toggleWorkspaceExperienceRef.current = toggleWorkspaceExperience;

    const constrainHeaderWidth = !(multiPaneEnabled
        && Platform.OS === 'web'
        && ((pane.scopeState?.right.isOpen ?? false) || (pane.scopeState?.details.isOpen ?? false)));

    const handleHeaderExtraItemSelect = React.useCallback((actionId: string) => {
        if (actionId === 'header.openAttachedSessionTerminal') {
            attachedSessionTerminal.open();
            return true;
        }
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
        if (actionId === 'header.automateExactTurnCompletion') {
            const observed = readExactActiveParentTurn(storage.getState().sessions[sessionId]);
            if (!observed) return true;
            navigateWithBlurOnWeb(() => routerRef.current.push({
                pathname: `/session/${sessionId}/automations/when-turn-finishes` as any,
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
        attachedSessionTerminal,
        buildCurrentSessionHref,
        mobileWorkspaceExperience,
        pathname,
        sessionId,
        showWorkspaceExperienceToggle,
    ]);

    const headerMenuExtraItems = React.useMemo(() => {
        const items: DropdownMenuItem[] = [];
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
    }, [attachedSessionTerminal.available, mobileWorkspaceExperience, showAutomations, showWorkspaceExperienceToggle, stableSessionForHeader, theme.colors.text.secondary, workspaceExperienceToggleLabelKey]);

    const headerWorkspaceDisplay = React.useMemo(() => resolveSessionWorkspaceDisplayPresentation({
        serverId: currentSessionRouteServerId,
        metadata: stableSessionForHeader
            ? readSessionOwnerMetadataView(stableSessionForHeader)
            : null,
        machineTarget: headerMachineTarget,
        workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
    }), [currentSessionRouteServerId, headerMachineTarget, stableSessionForHeader, workspaceRefsV1]);

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
    const headerAccountLifetime = captureActiveServerAccountScopeLifetime();
    const headerScopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: headerPluginProjection.serverId ?? null,
        machineId: headerPluginProjection.machineId ?? null,
        generation: headerPluginProjection.pluginUiProjection?.generation ?? null,
        interactionEnabled: headerPluginProjection.phase === 'current'
            && headerPluginProjection.interactionEnabled === true,
    }), [
        headerPluginProjection.interactionEnabled,
        headerPluginProjection.phase,
        headerPluginProjection.machineId,
        headerPluginProjection.pluginUiProjection?.generation,
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

    // Compute header props based on session state
    const headerProps = React.useMemo(() => resolveSessionViewHeaderProps({
        isDataReady,
        routeHydrationState,
        session: stableSessionForHeader,
        currentMachineId: currentSessionMachineId,
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
        subagentActiveCount: subagentCounts.live,
        navigateWithBlurOnWeb,
        handleHeaderExtraItemSelect,
        headerMenuExtraItems,
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
        onOpenPluginSurface: handleOpenSessionPluginSurface,
    }), [
        buildCurrentSessionHref,
        clientExecutableRegistrationRevision,
        currentSessionMachineId,
        handleHeaderExtraItemSelect,
        handleOpenSessionPluginSurface,
        headerPluginScopeIsCurrent,
        headerScopedLaunchFacts,
        headerPluginProjection.pluginUiProjection,
        headerWorkspaceDisplay.displayTitle,
        headerWorkspaceDisplay.subtitleEllipsizeMode,
        externalSessionRuntimePresentation,
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
        subagentCounts.live,
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
            {showTopHeader && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }} {...pane.overlayFocusReturnCaptureProps}>
                    <ChatHeaderView
                        {...headerProps}
                        agentIdentity={headerProps.agentId ? (
                            <SessionAgentCatalogIdentityIcon
                                agentId={headerProps.agentId}
                                machineId={headerMachineTarget?.machineId ?? null}
                                serverId={currentSessionRouteServerId}
                                color={theme.colors.chrome.header.foreground}
                                size={26}
                            />
                        ) : null}
                        onBackPress={handleBackPress}
                        showBackButton={!isTablet}
                        constrainWidth={constrainHeaderWidth}
                        includeTopInset={headerSafeAreaTopMode !== 'external'}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View
                style={{ flex: 1, paddingTop: showTopHeader ? safeAreaTopInset + headerHeight : 0 }}
                {...pane.overlayFocusReturnCaptureProps}
            >
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
                  ) : props.contentOverride ? (
                      props.contentOverride
                  ) : !session ? (
                      null
                  ) : (
                      // Normal session view
                       <ComposerBannerCollapseProvider key={sessionId}>
                       <MemoizedSessionViewLoaded
                           authSurfaceState={authSurfaceState}
                           key={sessionId}
                           sessionId={sessionId}
                           routeServerId={currentSessionRouteServerId}
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
                           participantTargets={participantTargets}
                           approvalRequests={approvalRequests}
                           paneUrlState={props.paneUrlState ?? null}
                           initialAttachmentDrafts={props.initialAttachmentDrafts ?? null}
                           browserContextStateForComposer={browserContextStateForComposer}
                           browserContextComposerContext={browserContextComposerContext}
                           paneScopeId={paneScopeId}
                           pendingMessages={pendingMessages}
                           externalSessionRuntime={externalSessionRuntime}
                           externalSessionRuntimePresentation={externalSessionRuntimePresentation}
                           externalSessionIdentityPresentation={externalSessionIdentityPresentation}
                           chatBottomSpacing={props.chatBottomSpacing ?? 'default'}
                           routeHydrationPending={routeHydrationPending}
                           sessionRunnerRuntimeStatus={sessionRunnerRuntimeStatusRetention.status}
                           sessionRunnerRuntimeStatusMachineId={sessionRunnerRuntimeStatusRetention.machineId}
                           onSessionRunnerRuntimeStatusInvalidated={sessionRunnerRuntimeStatusRetention.invalidateAndRefresh}
                           onAppPanePluginSurfaceNavigationBindingChange={handleAppPanePluginSurfaceNavigationBindingChange}
                       />
                       </ComposerBannerCollapseProvider>
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
    machineReachability,
    surfaceFocused,
    surfacePresented,
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
    externalSessionRuntimePresentation,
    externalSessionIdentityPresentation,
    chatBottomSpacing,
    routeHydrationPending,
    sessionRunnerRuntimeStatus,
    sessionRunnerRuntimeStatusMachineId,
    onSessionRunnerRuntimeStatusInvalidated,
    onAppPanePluginSurfaceNavigationBindingChange,
}: {
    authSurfaceState: SessionAuthSurfaceState | null;
    sessionId: string;
    routeServerId?: string | null;
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
    participantTargets: readonly SessionParticipantTarget[];
    approvalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    paneUrlState: SessionPaneUrlState | null;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    browserContextStateForComposer: BrowserContextState | null;
    browserContextComposerContext: SessionBrowserContextRuntime['composerContext'] | null;
    paneScopeId: string;
    pendingMessages: readonly PendingMessage[];
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
}) {
    const [pendingMessageEdit, setPendingMessageEdit] = React.useState<PendingMessageComposerEditState | null>(null);
    const pendingMessageEditRef = React.useRef(pendingMessageEdit);
    pendingMessageEditRef.current = pendingMessageEdit;
    const activeComposerRef = React.useMemo<ComposerRefV1>(() => pendingMessageEdit
        ? { kind: 'pendingMessage', sessionId, localId: pendingMessageEdit.localId }
        : { kind: 'session', sessionId }, [pendingMessageEdit?.localId, sessionId]);
    const activeComposerRefRef = React.useRef<ComposerRefV1>(activeComposerRef);
    activeComposerRefRef.current = activeComposerRef;
    const composerPresentationMountedRef = React.useRef(true);
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const composerPresentationAccountLifetime = captureActiveServerAccountScopeLifetime();
    const isActiveComposerPresentationCurrent = React.useCallback(() => (
        composerPresentationMountedRef.current
        && composerRefV1Key(activeComposerRefRef.current)
            === composerRefV1Key(activeComposerRef)
        && (composerPresentationAccountLifetime === null || composerPresentationAccountLifetime.isCurrent())
    ), [activeComposerRef, composerPresentationAccountLifetime]);
    const composerInputEffects = useComposerPresentationInputEffects({
        ref: activeComposerRef,
    });
    React.useLayoutEffect(() => {
        composerPresentationMountedRef.current = true;
        return () => {
            composerPresentationMountedRef.current = false;
        };
    }, []);
    React.useEffect(() => {
        const retirement = composerPresentationAccountLifetime?.onRetire(() => {
            composerInputEffects.retire();
        });
        return () => retirement?.dispose();
    }, [composerInputEffects.retire, composerPresentationAccountLifetime]);
    const onComposerFocusChange = React.useCallback((focused: boolean) => {
        if (!composerPresentationMountedRef.current) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(activeComposerRef);
    }, [activeComposerRef]);
    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);
    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!composerPresentationMountedRef.current) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(activeComposerRef);
    }, [activeComposerRef]);
    const { theme } = useUnistyles();
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const externalSessionOperationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(
            session.metadata,
        ),
        [session.metadata],
    );
    const externalSessionOperationShell = React.useMemo(
        () => presentExternalSessionOperationShell(
            externalSessionOperationPresentation,
        ),
        [externalSessionOperationPresentation],
    );
    const externalTranscriptAuthorityState = React.useMemo(() => {
        const link = readExternalSessionLink(ownerMetadata);
        return resolveExternalSessionTranscriptAuthorityState({
            linked: link !== null,
            agentReachable: link === null
                ? false
                : machineReachability === 'unknown'
                    ? null
                    : machineReachability === 'reachable',
            liveSourceKey: link
                ? createExternalSessionTranscriptLiveSourceKeyFromLink(link)
                : null,
            currentStorageState: session.currentStorageState
                ?? (link ? 'legacy_external_unknown' : 'hosted'),
            acceptedThroughServerSeq: session.acceptedThroughServerSeq ?? null,
            publishedThroughServerSeq: session.publishedThroughServerSeq ?? null,
            materializedThroughSourceAt: session.materializedThroughSourceAt ?? null,
            transcriptShareable: session.transcriptShareable ?? null,
            operationPresentation: externalSessionOperationPresentation,
            operationProgress:
                readExternalSessionOperationState(ownerMetadata ?? {}).value?.progress
                ?? null,
        });
    }, [externalSessionOperationPresentation, machineReachability, ownerMetadata, session]);
    const externalTranscriptAuthority = externalTranscriptAuthorityState.authority;
    const externalTranscriptPresentationNowMs = useSessionListRuntimeNowMs(
        externalTranscriptAuthority.kind === 'server_snapshot',
    );
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
    const [composerDocumentRenderEpoch, setComposerDocumentRenderEpoch] = React.useState(0);
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
    const sessionComposerAdmissionReservationsRef = React.useRef(new Set<string>());
    const runWithSessionComposerAdmissionReservation = React.useCallback(<T,>(
        submit: () => Promise<T>,
    ): Promise<T | undefined> => {
        const reservations = sessionComposerAdmissionReservationsRef.current;
        if (reservations.has(sessionId)) return Promise.resolve(undefined);

        reservations.add(sessionId);
        try {
            return submit().finally(() => {
                reservations.delete(sessionId);
            });
        } catch (error) {
            reservations.delete(sessionId);
            throw error;
        }
    }, [sessionId]);
    const shouldReadTranscript = shouldReadTranscriptForPendingRequests(session);
    const { messages: committedMessages } = useSessionMessages(sessionId, { enabled: shouldReadTranscript });
    const pendingPermissionRequests = React.useMemo(
        () => listPendingPermissionRequests(session, shouldReadTranscript ? committedMessages : undefined),
        [committedMessages, session, shouldReadTranscript],
    );
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const forkV1 = ownerMetadata?.forkV1;
    const isForkedSessionV1 =
        forkV1?.v === 1 &&
        typeof forkV1.parentSessionId === 'string' &&
        forkV1.parentSessionId.trim().length > 0;
    const reachableMachineTarget = useSessionReachableMachineTarget(sessionId);
    const controlMachineTarget = useSessionMachineControlTarget(sessionId);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = ownerMetadata?.version;
    const machineId = reachableMachineTarget?.machineId ?? ownerMetadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = Boolean(isCliOutdated && !isAcknowledged);
    const sessionAgentId = readSessionPresentationAgentId(session);
    const liveAuthoringContext = buildLiveSessionAuthoringContext({
        session,
    });
    const liveComposerState = resolveSessionComposerStateFromAuthoringContext(liveAuthoringContext, {
        fallbackAgentId: sessionAgentId,
    });
    const agentId = liveComposerState.agentId ?? sessionAgentId;
    // A dynamic Agent's lifecycle identity is persisted with its runtime, not
    // inferred from the presentation/catalog projection used for labels.
    const lifecycleAgentId = resolveAgentIdFromSessionMetadata(ownerMetadata)
        ?? (agentId && isBundledAgentId(agentId) ? agentId : null);
    const agentCore = agentId ? getAgentCore(agentId) : null;
    const permissionMode = liveComposerState.permissionMode;
    const sessionModeOptionIds = agentId
        ? resolveSessionViewModeOptionIds(
            agentId,
            (ownerMetadata as any)?.sessionModesV1
                ?? (ownerMetadata as any)?.acpSessionModesV1
                ?? null,
            agentCore?.sessionModes,
        )
        : [];
    const enabledAgentIds = useEnabledAgentIds();
    const sessionActionDefaultBackend = resolveSessionActionDefaultBackend({
        session: session as any,
        enabledAgentIds,
        fallbackAgentId: liveComposerState.agentId && isBundledAgentId(liveComposerState.agentId)
            ? liveComposerState.agentId
            : null,
    });
    const agentInputAgentType = agentId ?? sessionActionDefaultBackend?.displayAgentType ?? null;
    const agentInputCore = agentInputAgentType ? getAgentCore(agentInputAgentType) : null;
    const isVoiceConversationSession = isVoiceConversationSystemSessionMetadata(ownerMetadata);
    const isHiddenSystemSessionSession = isHiddenSystemSession({ metadata: ownerMetadata });
    const modelMode = liveComposerState.modelMode;
    const sessionRuntimeStatusSource = useSessionRuntimeStatusSource(session);
    const sessionStatus = useSessionStatus(sessionRuntimeStatusSource, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    const activeServerId = getActiveServerSnapshot().serverId;
    const capabilityServerId = (routeServerId ?? '').trim() || activeServerId;
    const sessionRouteServerId = (routeServerId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || activeServerId;
    const providersFeatureEnabled = useFeatureEnabled('providers', { scopeKind: 'spawn', serverId: capabilityServerId });
    const providerLaunchBinding = React.useMemo(
        () => readSessionProviderBindingMetadataV1(ownerMetadata),
        [ownerMetadata],
    );
    const providerModelSelectionIntent = ownerMetadata?.modelSelectionIntentV1 ?? null;
    const providerModelSelection = providerModelSelectionIntent?.selection
        ? { v: 1 as const, updatedAt: providerModelSelectionIntent.updatedAt, ref: providerModelSelectionIntent.selection }
        : null;
    const providerBindingStatus = useProviderBindingStatus({
        enabled: providersFeatureEnabled && surfaceFocused,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: sessionRouteServerId,
        selection: providerModelSelection,
        selectionIntentPresent: providerModelSelectionIntent !== null,
        launchBinding: providerLaunchBinding,
    });
    const providerAgentTargetKey = agentId
        ? resolveBackendTargetKeyV2(resolveSessionActionDefaultTarget(sessionActionDefaultBackend) ?? { kind: 'builtInAgent', agentId })
        : null;
    const providerModelProjection = useProviderModelProjection({
        enabled: providersFeatureEnabled && surfaceFocused && providerAgentTargetKey !== null,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: sessionRouteServerId,
        agentTargetKey: providerAgentTargetKey,
        ...(providerModelSelection ? { currentSelection: providerModelSelection.ref } : {}),
    });
    const confirmExperimentalProviderModel = useConfirmExperimentalProviderModel({
        enabled: providersFeatureEnabled,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: sessionRouteServerId,
        agentTargetKey: providerAgentTargetKey,
        refresh: providerModelProjection.refresh,
    });
    const selectedProviderProjectionGroup = providersFeatureEnabled && providerModelSelection?.ref.providerConnectionId
        ? providerModelProjection.data?.groups.find(
            (group) => group.connectionId === providerModelSelection.ref.providerConnectionId,
        ) ?? null
        : null;
    const providerBindingPresentation = React.useMemo(() => providerLaunchBinding
        ? presentSessionProviderBinding({
            binding: providerLaunchBinding,
            status: providerBindingStatus.status,
            error: providerBindingStatus.error,
            ...(selectedProviderProjectionGroup ? {
                proposedDisplay: {
                    providerName: selectedProviderProjectionGroup.providerName,
                    connectionName: selectedProviderProjectionGroup.connectionName,
                },
            } : {}),
        })
        : null, [providerBindingStatus.error, providerBindingStatus.status, providerLaunchBinding, selectedProviderProjectionGroup]);
    const pendingProviderSwitchBanner = !providerLaunchBinding && selectedProviderProjectionGroup
        ? {
            kind: 'changed' as const,
            action: 'restart' as const,
            providerName: selectedProviderProjectionGroup.providerName,
            connectionName: selectedProviderProjectionGroup.connectionName,
        }
        : null;
    const providerBindingLaunchLabel = React.useMemo(() => {
        const snapshot = providerLaunchBinding?.displaySnapshot;
        if (!snapshot) return null;
        return snapshot.connectionRole === 'default' && snapshot.connectionDisplayNameMode === 'automatic'
            ? t('session.providerBinding.launchDefaultLabel', { provider: snapshot.providerName })
            : t('session.providerBinding.launchNamedLabel', {
                provider: snapshot.providerName,
                connection: snapshot.connectionName,
            });
    }, [providerLaunchBinding]);
    const [sessionModelPickerRequestKey, setSessionModelPickerRequestKey] = React.useState<string | null>(null);
    const [modelTransitionActionRequired, setModelTransitionActionRequired] = React.useState<Readonly<{
        status: 'restart_required' | 'reconciliation_required';
        requestedSelection: ProviderBoundModelRef;
        intentBaselineUpdatedAt: number;
    }> | null>(null);
    const currentSessionRunnerRuntimeStatus = React.useMemo(() => {
        const targetMachineId = typeof sessionRunnerRuntimeStatusMachineId === 'string'
            ? sessionRunnerRuntimeStatusMachineId.trim()
            : '';
        return sessionRunnerRuntimeStatus
            && sessionRunnerRuntimeStatus.serverId === sessionRouteServerId
            && sessionRunnerRuntimeStatus.sessionId === sessionId
            && sessionRunnerRuntimeStatus.machineId === targetMachineId
            ? sessionRunnerRuntimeStatus
            : null;
    }, [
        sessionId,
        sessionRouteServerId,
        sessionRunnerRuntimeStatus,
        sessionRunnerRuntimeStatusMachineId,
    ]);
    const currentRunnerProcessIdentity = currentSessionRunnerRuntimeStatus?.runnerProcessIdentity ?? null;
    const modelSelectionDisposition = React.useMemo(() => (
        agentId && providerAgentTargetKey
            ? resolveSessionModelSelectionDisposition({
                agentId,
                agentTargetKey: providerAgentTargetKey,
                metadata: ownerMetadata,
                sessionActive: session.active === true,
                currentRunnerProcessIdentity,
            })
            : null
    ), [
        agentId,
        currentRunnerProcessIdentity,
        ownerMetadata,
        providerAgentTargetKey,
        session.active,
    ]);
    const persistedModelTransitionActionRequired = React.useMemo(() => {
        const requestedSelection = providerModelSelectionIntent?.selection ?? null;
        if (session.active !== true || !requestedSelection) return null;
        if (
            requestedSelection.providerConnectionId !== null
            && !providersFeatureEnabled
        ) {
            return null;
        }
        if (!modelSelectionDisposition?.selectionTransitionPending) return null;
        return {
            status: 'restart_required' as const,
            requestedSelection,
        };
    }, [
        modelSelectionDisposition,
        providerModelSelectionIntent?.selection,
        providersFeatureEnabled,
        session.active,
    ]);
    const visibleLocalModelTransitionActionRequired =
        modelTransitionActionRequired?.requestedSelection.providerConnectionId !== null
        && !providersFeatureEnabled
            ? null
            : modelTransitionActionRequired;
    const effectiveModelTransitionActionRequired =
        visibleLocalModelTransitionActionRequired
        ?? persistedModelTransitionActionRequired;
    React.useEffect(() => {
        setModelTransitionActionRequired(null);
    }, [sessionId]);
    React.useEffect(() => {
        if (!modelTransitionActionRequired) return;
        const durableIntent = providerModelSelectionIntent;
        if (
            !durableIntent
            || durableIntent.updatedAt
                <= modelTransitionActionRequired.intentBaselineUpdatedAt
            || !durableIntent.selection
            || sessionModelSelectionKey(durableIntent.selection)
                === sessionModelSelectionKey(
                    modelTransitionActionRequired.requestedSelection,
                )
        ) {
            return;
        }
        setModelTransitionActionRequired(null);
    }, [modelTransitionActionRequired, providerModelSelectionIntent]);
    React.useEffect(() => {
        const requested = modelTransitionActionRequired?.requestedSelection;
        if (!requested) return;
        const activeSelection = modelSelectionDisposition?.activeSelection ?? null;
        if (
            activeSelection
            && sessionModelSelectionKey(activeSelection)
                === sessionModelSelectionKey(requested)
        ) {
            setModelTransitionActionRequired(null);
        }
    }, [
        modelSelectionDisposition,
        modelTransitionActionRequired?.requestedSelection,
    ]);
    const transcriptMessageSelectionEnabled = useSetting('transcriptMessageSelectionEnabled');
    const transcriptMessageSendToSessionEnabled = useSetting('transcriptMessageSendToSessionEnabled');
    const transcriptMessageSendToSessionTemplate = useSetting('transcriptMessageSendToSessionTemplate');
    const transcriptBulkCopyFormat = useSetting('transcriptBulkCopyFormat');
    const transcriptSelectionEligibleMessageIds = useTranscriptSelectionEligibleMessageIds(sessionId, {
        enabled: transcriptMessageSelectionEnabled === true,
        metadata: ownerMetadata,
    });
    const navigateToSession = useNavigateToSession();
    const scmSessionAutoRefreshIntervalMsSetting = useSetting('scmSessionAutoRefreshIntervalMs' as any);
    const scmSessionAutoRefreshIntervalMs =
        typeof scmSessionAutoRefreshIntervalMsSetting === 'number' && Number.isFinite(scmSessionAutoRefreshIntervalMsSetting) && scmSessionAutoRefreshIntervalMsSetting >= 5_000
            ? scmSessionAutoRefreshIntervalMsSetting
            : 5 * 60 * 1000;
    const settings = useSettings();
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: capabilityServerId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const currentLifecycleAgentCapabilities = React.useMemo(() => (
        daemonMergedProjection.phase === 'ready'
            ? readCurrentProjectedAgentCapabilities({
                projection: daemonMergedProjection.inputs?.pluginProjectionV2,
                agentId: lifecycleAgentId,
            })
            : null
    ), [
        daemonMergedProjection.inputs?.pluginProjectionV2,
        daemonMergedProjection.phase,
        lifecycleAgentId,
    ]);
    // Reference search has no Account data, but it is still daemon work scoped to
    // the active Account. Borrow the incumbent lifetime as a currentness fence.
    const composerReferenceAccountLifetime = captureActiveServerAccountScopeLifetime();
    // The picker consumes raw lifecycle records only while this mounted composer
    // owns a ready projection. Its query AbortSignal cancels daemon work; this
    // identity fence rejects a result that arrives between projection/focus change
    // and the effect cleanup that supersedes the active query.
    const composerReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const composerReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = daemonMergedProjection.inputs?.pluginProjectionV2;
        if (
            !surfaceFocused
            || daemonMergedProjection.phase !== 'ready'
            || !projection
            || !machineId
        ) {
            return null;
        }
        let host!: ComposerReferenceSearchHost;
        host = {
            machineId,
            serverId: capabilityServerId,
            projection,
            isCurrent: () => (
                composerReferenceHostRef.current === host
                && composerReferenceAccountLifetime?.isCurrent() !== false
            ),
        };
        return host;
    }, [
        capabilityServerId,
        composerReferenceAccountLifetime,
        daemonMergedProjection.inputs?.pluginProjectionV2,
        daemonMergedProjection.phase,
        machineId,
        sessionId,
        surfaceFocused,
    ]);
    composerReferenceHostRef.current = composerReferenceHost;
    const isSessionComposerPluginScopeCurrent = React.useCallback(() => (
        composerPresentationMountedRef.current
        && composerRefV1Key(activeComposerRefRef.current)
            === composerRefV1Key(activeComposerRef)
        && surfaceFocused
        && (composerPresentationAccountLifetime === null || composerPresentationAccountLifetime.isCurrent())
    ), [activeComposerRef, composerPresentationAccountLifetime, surfaceFocused]);
    const openSessionComposerControlAction = React.useCallback((input: Readonly<{
        controller: PluginContributedActionController;
        action: PluginContributionIdentityV1;
        input?: unknown;
        signal: AbortSignal;
    }>) => {
        fireAndForget(runWithSessionComposerAdmissionReservation(() => (
            openPluginContributedActionSessionReference({
                controller: input.controller,
                action: input.action,
                ...(input.input === undefined ? {} : { input: input.input }),
                signal: input.signal,
            })
        )), { tag: 'SessionView.openComposerControlAction' });
    }, [runWithSessionComposerAdmissionReservation]);
    const openSessionComposerContributedAction = React.useCallback(async (input: Readonly<{
        controller: PluginContributedActionController;
        action: PluginContributedActionDescriptor;
        signal: AbortSignal;
    }>): Promise<PluginContributedActionOpenOutcome> => {
        const outcome = await runWithSessionComposerAdmissionReservation(() => (
            openPluginContributedAction({
                controller: input.controller,
                action: input.action,
                signal: input.signal,
            })
        ));
        return outcome ?? { kind: 'unavailable', reason: 'submission_in_flight' };
    }, [runWithSessionComposerAdmissionReservation]);
    const composerPluginPresentation = useComposerScopePluginPresentation({
        composer: activeComposerRef,
        physicalTarget: { kind: 'session', sessionId },
        resourceContext: { kind: 'session', sessionId },
        machineId: machineId ?? null,
        serverId: capabilityServerId,
        projectionPhase: daemonMergedProjection.phase,
        projectionInputs: daemonMergedProjection.inputs,
        accountLifetime: composerPresentationAccountLifetime,
        isScopeCurrent: isSessionComposerPluginScopeCurrent,
        attachmentsEnabled: true,
        includeSessionActions: true,
        onOpenControlAction: openSessionComposerControlAction,
        onOpenContributedAction: openSessionComposerContributedAction,
    });
    const composerPluginActionController = composerPluginPresentation.actionController;
    const composerPluginActionScopeSignal = composerPluginPresentation.scopeSignal;
    // Pending drafts retain semantic values only; availability remains projected
    // by the shared current Composer scope.
    const composerAttachmentAvailabilityEntriesById = composerPluginPresentation.attachmentEntriesById;
    const sessionAgentCatalogEntries = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
        mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
    }), [
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const currentSessionAgentCatalogEntry = React.useMemo(() => (
        agentId === null
            ? null
            : sessionAgentCatalogEntries.find((entry) => (
                entry.agentId === agentId
                || entry.agentCatalogEntry.qualifiedId === agentId
            ))?.agentCatalogEntry ?? null
    ), [agentId, sessionAgentCatalogEntries]);
    const sessionActionDefaultBackendEntry = React.useMemo(() => {
        const target = resolveSessionActionDefaultTarget(sessionActionDefaultBackend);
        if (!target) return null;
        const selectedTargetKey = resolveBackendTargetKeyV2(target);
        return sessionAgentCatalogEntries.find((entry) => entry.backendTargetKey === selectedTargetKey) ?? null;
    }, [sessionActionDefaultBackend, sessionAgentCatalogEntries]);
    const voiceEnabled = useFeatureEnabled('voice');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads');
    const usageLimitRecoveryFeatureEnabled = useFeatureEnabled('sessions.usageLimitRecovery', { scopeKind: 'spawn', serverId: capabilityServerId });
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(sessionId);
    const attachmentsUploadsEnabled = attachmentsUploadsFeatureEnabled && attachmentsUploadsTransferAvailable;
    // Generalized goal umbrella gate (provider-agnostic). The provider-specific discriminator is the
    // capability gate `supportsEditableSessionGoals` (Codex: app-server mode; Claude: live runner
    // goal-control registration), so this stays a single umbrella flag for all providers.
    const agentGoalsFeatureEnabled = useFeatureEnabled('agents.goals');
    const sessionWorkStateSnapshot = React.useMemo(
        () => readSessionWorkStateFromMetadata(ownerMetadata),
        [ownerMetadata],
    );
    const primaryWorkStateItem = React.useMemo(
        () => resolvePrimarySessionWorkStateItem(sessionWorkStateSnapshot),
        [sessionWorkStateSnapshot],
    );
    const [activeStatusBadgeKey, setActiveStatusBadgeKey] = React.useState<string | null>(null);
    // Composer banner collapse is owned by ComposerBannerCollapseProvider (mounted above this
    // component) so a banner and the badge that toggles it agree even across subtrees, and so the
    // account-level "remember" preference decides between session-scoped and device-persisted state.
    const usageLimitRecoveryBanner = useComposerBannerCollapse('usageLimitRecovery');
    const staleSessionRunnerBanner = useComposerBannerCollapse('staleSessionRunner');
    const authRecoveryBanner = useComposerBannerCollapse('authRecovery');
    const pendingQueueResumeFailedBanner = useComposerBannerCollapse('pendingQueueResumeFailed');
    const providerBindingBannerCollapse = useComposerBannerCollapse('providerBinding');
    const externalTranscriptSnapshotBanner = useComposerBannerCollapse('externalTranscriptSnapshot');
    const agentTransitionOutcomeBanner = useComposerBannerCollapse('agentTransitionOutcome');
    const [pendingQueueResumeFailed, setPendingQueueResumeFailed] = React.useState(false);
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
            /** The account/server scope that owned the arm at dispatch time. */
            scopeKey: string;
            result: SessionAgentTransitionResultV1;
            /**
             * The switch that was submitted. Nothing presentational is stored:
             * the labels the banner reads are derived from this and from the
             * Session's current Agent, so a restored outcome cannot come back
             * naming an Agent by a word from an older locale.
             */
            intent: ComposerAgentContinuationIntentV1;
            localId: string;
            /** Canonical Session/message facts have been read since the call returned. */
            reconciled: boolean;
        }>
        | null
    >(null);
    const [resolvedStaleSessionRunnerFingerprint, setResolvedStaleSessionRunnerFingerprint] = React.useState<string | null>(null);
    const [staleSessionRunnerOperationStatus, setStaleSessionRunnerOperationStatus] = React.useState<Readonly<{
        fingerprint: string;
        status: StaleSessionRunnerOperationStatus;
    }> | null>(null);
    const hasWriteAccess = hasSessionWriteAccess(session.accessLevel);
    const sessionMachineRecord = useMachine(typeof machineId === 'string' ? machineId : '');
    const goalControlMachineId = controlMachineTarget?.machineId ?? machineId;
    const goalControlMachineRecord = useMachine(typeof goalControlMachineId === 'string' ? goalControlMachineId : '');
    const daemonGoalControlsSupported = goalControlMachineRecord?.metadata?.daemonSessionGoalControlsSupported === true;
    // Each successful connect stamps a new value, which is exactly the lifetime a
    // continuation inspection may be trusted for.
    const socketConnectionGeneration = useSocketStatus().lastConnectedAt;
    const agentContinuationSource = React.useMemo(() => ({
        currentBackendTargetKey: providerAgentTargetKey,
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
    }), [hasWriteAccess, providerAgentTargetKey, session, sessionMachineRecord]);
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
        cwd: ownerMetadata?.path ?? null,
    }), [capabilityServerId, machineId, ownerMetadata?.path, settings]);
    const currentAgentLabel = agentInputCore
        ? t(agentInputCore.displayNameKey)
        : formatAgentLikeIdForDisplay(agentInputAgentType);
    // `sessions.agentSwitching` is server-represented and fails closed. The
    // canonical decision runtime reads the server bit as
    // `readServerEnabledBit(...) === true` and applies the catalog's dependency
    // closure, so this is the gate — not a second interpretation beside it. It is
    // read once, here, and handed to the one owner that can arm a switch.
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
    const activeServerAccountScope = useActiveServerAccountScope();
    const activeServerAccountScopeKey = activeServerAccountScope
        ? serverAccountScopeKeySuffix(activeServerAccountScope)
        : 'local';
    const inSessionAgentPicker = useInSessionAgentPickerControls({
        sessionId,
        accountScope: activeServerAccountScope,
        currentAgentId: agentInputAgentType,
        currentAgentLabel,
        currentAgentSessionActive: session.active,
        entries: sessionAgentCatalogEntries,
        favoriteBackendTargetKeys: settings.favoriteBackendTargetKeysV1,
        featureDecision: agentSwitchingDecision,
        source: agentContinuationSource,
        machine: agentContinuationMachine,
        projectionCurrent: daemonMergedProjection.phase === 'ready',
        detail: agentContinuationTargetDetail,
    });
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
            localId: submission.localId,
            reconciled: false,
        });
    }, [
        activeServerAccountScopeKey,
        armedContinuationOutcome,
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.armedContinuationLocalId,
        inSessionAgentPicker.armedContinuationSubmission,
        inSessionAgentPicker.armedContinuationSubmissionIntent,
        sessionId,
    ]);
    // The armed target, resolved once against the same catalog the rail offered
    // it from. The send control names it and the send path carries it, so both
    // read one value rather than each deriving its own label.
    const armedContinuationTarget = React.useMemo(() => {
        const intent = inSessionAgentPicker.armedContinuation;
        if (intent === null) return null;
        const entry = sessionAgentCatalogEntries.find((catalogEntry) => (
            catalogEntry.agentId === intent.selection.agentId
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
    const providerSupportsEditableSessionGoals = React.useMemo(
        () => agentId ? supportsEditableSessionGoals({ agentId, session, daemonGoalControlsSupported }) : false,
        [agentId, daemonGoalControlsSupported, session],
    );
    const canEditSessionGoals = React.useMemo(
        () => !externalSessionOperationShell.blocksNewOperation && isSessionGoalEditingAvailable({
            providerSupportsEditableGoals: providerSupportsEditableSessionGoals,
            goalsFeatureEnabled: agentGoalsFeatureEnabled,
            hasWriteAccess,
        }),
        [agentGoalsFeatureEnabled, externalSessionOperationShell.blocksNewOperation, hasWriteAccess, providerSupportsEditableSessionGoals],
    );
    // Provider goal-action capability profile for the "Set goal" form (no goal item yet). Lets a
    // provider (e.g. Claude) restrict the control surface to edit/clear, hiding the Codex-only budget
    // editor before any native goal exists (QA-CHIP-2). The registry has already intersected
    // provider semantics with runtime reachability.
    const sessionGoalActionCapabilityProfile = React.useMemo(
        () => (agentId
            ? resolveSessionGoalActionCapabilityProfile({ agentId, session, daemonGoalControlsSupported })
            : null),
        [agentId, daemonGoalControlsSupported, session],
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
        metadata: ownerMetadata,
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
        const iconName: IconName = presentation.iconKind === 'goal'
            ? 'crosshair'
            : presentation.iconKind === 'workflow'
                ? 'graph'
                : presentation.iconKind === 'permission'
                    ? 'warning-circle'
                    : 'list';
        return [{
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: presentation.label,
            testID: 'session-work-state-status-badge',
            accessibilityLabel: t('session.workState.accessibilityLabel'),
            tone: presentation.tone,
            emphasis: presentation.emphasis,
            icon: (tint) => <Icon name={iconName} size={14} color={tint} />,
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
        () => readSessionUsageLimitRecoveryFromMetadata(ownerMetadata),
        [ownerMetadata],
    );
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
        if (!fetchedState) return ownerMetadata;
        return {
            ...(ownerMetadata ?? {}),
            [SESSION_RUNNER_RUNTIME_METADATA_KEY]: fetchedState,
        };
    }, [
        ownerMetadata,
        sessionId,
        sessionRouteServerId,
        sessionRunnerRuntimeStatus,
        staleSessionRunnerMachineId,
    ]);
    const staleSessionRunnerRuntimeState = React.useMemo(
        () => readStaleSessionRunnerRuntimeState({
            metadata: staleSessionRunnerMetadata,
            sessionId,
            machineId: staleSessionRunnerMachineId,
        }),
        [sessionId, staleSessionRunnerMachineId, staleSessionRunnerMetadata],
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
        resolveAgentIdFromFlavor(session.lastRuntimeIssue?.agentId)
        ?? lifecycleAgentId
        ?? null
    ), [lifecycleAgentId, session.lastRuntimeIssue?.agentId]);
    const usageLimitRecoveryCheckNowSupported = React.useMemo(() => (
        supportsAgentLifecycleCapability({
            agentId: usageLimitRecoveryCheckNowAgentId,
            capability: 'usageLimitRecovery.checkNow',
            metadata: ownerMetadata,
            sessionActive: session.active === true,
            currentAgentCapabilities: currentLifecycleAgentCapabilities,
        })
    ), [
        currentLifecycleAgentCapabilities,
        ownerMetadata,
        session.active,
        usageLimitRecoveryCheckNowAgentId,
    ]);
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
    ), [pendingMessages.length, session.active]);
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
            metadata: ownerMetadata,
            agentId: liveComposerState.agentId ?? '',
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
            connectedAccounts: currentSessionAgentCatalogEntry?.connectedAccounts ?? [],
        })
    ), [accountProfile?.connectedServicesV2, currentSessionAgentCatalogEntry?.connectedAccounts, liveComposerState.agentId, ownerMetadata]);
    const connectedServiceQuotaSnapshots = useConnectedServiceQuotaSnapshots(
        connectedServiceQuotaProfileRef
            ? [{
                serviceId: connectedServiceQuotaProfileRef.legacyServiceId,
                profileId: connectedServiceQuotaProfileRef.profileId,
            }]
            : [],
    );
    /**
     * The released scalar identity the session quota corridor consumes (V2/V3
     * quota transports, the recovery-credit consume wire, V2 group facts). The
     * resolver's canonical resolution is qualified; this is its typed local
     * projection for the legacy quota surfaces.
     */
    const connectedServiceQuotaProfileIdentity = React.useMemo(() => (
        connectedServiceQuotaProfileRef
            ? {
                serviceId: connectedServiceQuotaProfileRef.legacyServiceId,
                profileId: connectedServiceQuotaProfileRef.profileId,
            }
            : null
    ), [connectedServiceQuotaProfileRef]);
    const connectedServiceQuotaProfileKey = connectedServiceQuotaSnapshots.profiles[0]?.key ?? null;
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
        () => readProviderAccountUsageRecordIdsFromMetadata(ownerMetadata),
        [ownerMetadata],
    );
    const providerAccountUsageSnapshots = useProviderAccountUsageSnapshots(providerAccountUsageRecordIds);
    const providerUsageDisplaySource = React.useMemo(() => selectProviderUsageDisplaySource({
        providerId: agentId,
        metadataRecordIds: providerAccountUsageRecordIds,
        accountUsageSnapshotsByRecordId: providerAccountUsageSnapshots.snapshotsByRecordId,
        connectedServiceProfileRef: connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaView: connectedServiceQuotaSnapshot,
    }), [
        agentId,
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaSnapshot,
        providerAccountUsageRecordIds,
        providerAccountUsageSnapshots.snapshotsByRecordId,
    ]);
    const providerAccountUsageSnapshot = providerUsageDisplaySource?.kind === 'account_usage'
        ? providerUsageDisplaySource.snapshot
        : null;
    const providerAccountUsageSnapshotStateByRecordId = providerAccountUsageSnapshots.stateByRecordId;
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
    const visibleUsageLimitRecoveryPresentation = usageLimitRecoveryBanner.collapsed
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
    const visibleStaleSessionRunnerPresentation = staleSessionRunnerBanner.collapsed
        ? null
        : staleSessionRunnerPresentation;
    const staleSessionRunnerBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        if (!staleSessionRunnerPresentation) return [];
        return [{
            ...staleSessionRunnerPresentation.statusBadge,
            ...buildComposerBannerBadgeAccessibility({
                statusLabel: staleSessionRunnerPresentation.statusBadge.label,
                collapsed: staleSessionRunnerBanner.collapsed,
                expandHint: t('session.staleRunner.actions.showBanner'),
                collapseHint: t('session.staleRunner.actions.hideBanner'),
            }),
            icon: (tint) => <Icon name="arrow-clockwise" size={14} color={tint} />,
            onPress: staleSessionRunnerBanner.toggle,
        }];
    }, [
        staleSessionRunnerBanner.collapsed,
        staleSessionRunnerBanner.toggle,
        staleSessionRunnerPresentation,
        t,
    ]);
    const usageLimitRecoveryBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        if (!usageLimitRecoveryPresentation) return [];
        return [{
            ...usageLimitRecoveryPresentation.statusBadge,
            ...buildComposerBannerBadgeAccessibility({
                statusLabel: usageLimitRecoveryPresentation.statusBadge.label,
                collapsed: usageLimitRecoveryBanner.collapsed,
                expandHint: t('session.usageLimitRecovery.actions.showBanner'),
                collapseHint: t('session.usageLimitRecovery.actions.hideBanner'),
            }),
            icon: (tint) => <Icon name="clock" size={14} color={tint} />,
            onPress: usageLimitRecoveryBanner.toggle,
        }];
    }, [
        t,
        usageLimitRecoveryBanner.collapsed,
        usageLimitRecoveryBanner.toggle,
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
            connectedServiceQuotaProfileIdentity,
        )
        ? connectedServiceQuotaProfileIdentity
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
            // The snapshots hook already resolved this record's state, including the
            // failed-refresh case its retained snapshot cannot express on its own.
            state: providerAccountUsageSnapshot
                ? providerAccountUsageSnapshotStateByRecordId[providerAccountUsageSnapshot.recordId]
                    ?? 'not_loaded'
                : 'not_loaded',
            windowMode: sessionProviderUsageGaugeWindowMode,
            nowMs: Date.now(),
            formatter: connectedServiceQuotaGaugeFormatter,
        });
    }, [
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaProfileRef,
        connectedServiceQuotasEnabled,
        providerUsageDisplaySource?.kind,
        providerUsageConnectedServiceQuotaSnapshot,
        providerAccountUsageSnapshot,
        providerAccountUsageSnapshotStateByRecordId,
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
            // Resolving the issue removes the banner on its own. Collapse is a remembered user
            // preference per banner kind, so a successful restart must not silently re-expand it.
            setResolvedStaleSessionRunnerFingerprint(staleSessionRunnerPresentation.fingerprint);
            setStaleSessionRunnerOperationStatus(null);
            onSessionRunnerRuntimeStatusInvalidated();
            return;
        }
        setStaleSessionRunnerOperationStatus({
            fingerprint: staleSessionRunnerPresentation.fingerprint,
            status: { kind: 'result', result },
        });
    }, [
        hasWriteAccess,
        onSessionRunnerRuntimeStatusInvalidated,
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
        const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
        if (noticeKey) await Modal.alert(t('common.info'), t(noticeKey));
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
            const profileActionRoute = readUsageLimitRecoveryDiagnosticProfileActionRoute(
                result,
            );
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
                        provider: session.lastRuntimeIssue?.agentId ?? null,
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
                    armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                    ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                        ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                        : {}),
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
                    profileRef: connectedServiceQuotaProfileIdentity,
                    profileKey: connectedServiceQuotaProfileKey,
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
                    armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                    ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                        ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                        : {}),
                }, usageLimitRecoveryOperationOptions)
                : kind === 'consume_reset_credit'
                    ? await sessionUsageLimitConsumeResetCredit(sessionId, {
                        provider: session.lastRuntimeIssue?.agentId ?? null,
                        issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                        ...usageLimitRecoveryOperationOptions,
                    })
                    : isUsageLimitRecoverySwitchAction(kind)
                        ? await sessionUsageLimitSwitchAccountNow(sessionId, {
                            provider: session.lastRuntimeIssue?.agentId ?? null,
                            ...usageLimitRecoveryOperationOptions,
                        })
                        : isSessionUsageLimitRecoveryCheckNowAction(kind)
                            ? await sessionUsageLimitCheckNow(sessionId, {
                                provider: session.lastRuntimeIssue?.agentId ?? null,
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
        accountProfile?.connectedServicesV2,
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        connectedServiceQuotaProfileKey,
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaSnapshot?.fetchedAt,
        consumeConnectedServiceRecoveryCreditForProfile,
        session.active,
        session.lastRuntimeIssue?.agentId,
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
                provider: session.lastRuntimeIssue?.agentId ?? providerAccountUsageSnapshot?.providerId ?? null,
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
        session.lastRuntimeIssue?.agentId,
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
    // Quota bundle handed to the session instrument strip. System-B data path is
    // untouched (SessionView still owns the view model + recovery orchestration);
    // the strip restyles the trigger only.
    const instrumentQuota = React.useMemo<SessionInstrumentStripQuota | null>(() => (
        providerUsageGauge
            ? {
                viewModel: providerUsageGauge,
                onRecoveryCreditPress: providerUsageRecoveryCreditAction,
                recoveryCreditPending: providerUsageRecoveryCreditActionPending,
            }
            : null
    ), [providerUsageGauge, providerUsageRecoveryCreditAction, providerUsageRecoveryCreditActionPending]);
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
    const getAttachmentDraftRevisionSnapshot = attachmentDraftManager.getDraftRevisionSnapshot;
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

    useScmSessionAutoRefresh({ sessionId, intervalMs: scmSessionAutoRefreshIntervalMs });

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
        openSession: (sid, options) => {
            router.push(buildScopedSessionRouteHref({
                sessionId: sid,
                serverId: options?.serverId
                    ?? resolveServerIdForSessionIdFromLocalCache(sid)
                    ?? sessionRouteServerId,
            }) as any);
        },
    });

    // Inactive session resume state
    // Use `session.active` as the source of truth for whether the provider process is running.
    // `presence` is derived from server snapshots and can drift if a partial update lands.
    const isSessionActive = session.active === true;

    // --- Armed-switch outcome: automatic reconciliation from canonical facts ---
    //
    // An `outcome_unknown` is the only arm the daemon could not establish, and it
    // is the only one worth re-deciding here. Reconciliation reads canonical
    // Session and message truth through the owners that already publish it — no
    // status operation of its own, no polling, and no Check-status control handed
    // to the reader — then feeds those facts back through the SAME disposition
    // owner that decided the daemon's answer.
    // The words the banner uses, derived rather than stored.
    //
    // The source is whatever Agent this Session runs now, which is the truthful
    // subject of every depth that names one: `rejected` and `source_stopped`
    // both leave the Session on the source, and the depths that do not leave it
    // there name only the target. The target is resolved from the submitted
    // intent against the same catalog the rail offered it from, so it survives
    // the arm being spent — and so a restored outcome names it in the reader's
    // CURRENT language instead of a word frozen into storage.
    // Outcomes are mount-local presentation, but they still belong to the same
    // Account/server scope as the arm that produced them. Gate reads during an
    // Account switch so neither a notice nor its custody key can leak across
    // the scope boundary before the cleanup effect below runs.
    const activeArmedContinuationOutcome = armedContinuationOutcome?.scopeKey === activeServerAccountScopeKey
        ? armedContinuationOutcome
        : null;
    const armedContinuationOutcomeTargetAgentId = activeArmedContinuationOutcome?.kind === 'outcome'
        ? activeArmedContinuationOutcome.intent.selection.agentId
        : null;
    const armedContinuationOutcomeLabels = React.useMemo<ArmedAgentContinuationLabels>(() => ({
        sourceAgentLabel: currentAgentLabel,
        targetAgentLabel: armedContinuationOutcomeTargetAgentId === null
            ? ''
            : sessionAgentCatalogEntries.find((entry) => (
                entry.agentId === armedContinuationOutcomeTargetAgentId
            ))?.title ?? formatAgentLikeIdForDisplay(armedContinuationOutcomeTargetAgentId),
    }), [armedContinuationOutcomeTargetAgentId, currentAgentLabel, sessionAgentCatalogEntries]);

    // A transition outcome is live presentation state, not a second persisted
    // submission owner. Route reuse must therefore drop an old Session's notice
    // instead of projecting it onto the next composer.
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

    // Canonical facts are read at the moment reconciliation reports them settled,
    // which is exactly when they can have changed. Reading canonical admission
    // imperatively keeps this off a transcript-wide subscription that would
    // re-derive on every streamed row for a banner that changes about twice.
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
    // `absent` while neither a live outcome nor a persisted pre-RPC submission
    // exists, so an ordinary Session pays nothing for it.
    const armedContinuationInputLocalId = activeArmedContinuationOutcome?.kind === 'outcome'
        ? activeArmedContinuationOutcome.localId
        : inSessionAgentPicker.armedContinuationSubmission?.localId ?? null;
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
                currentAgentId: agentInputAgentType ?? null,
                sessionActive: isSessionActive,
                input: armedContinuationInputCustody,
            }
            : null;
        return reconcileArmedAgentContinuationDisposition({
            result: activeArmedContinuationOutcome.result,
            labels: armedContinuationOutcomeLabels,
            targetAgentId: activeArmedContinuationOutcome.intent.selection.agentId,
            facts,
        });
    }, [
        agentInputAgentType,
        armedContinuationInputCustody,
        activeArmedContinuationOutcome,
        armedContinuationOutcomeLabels,
        isSessionActive,
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
    const supportsLocalControl = !isHiddenSystemSessionSession
        && supportsAgentLifecycleCapability({
            agentId: lifecycleAgentId,
            capability: 'surface.terminal',
            metadata: ownerMetadata,
            currentAgentCapabilities: currentLifecycleAgentCapabilities,
        });
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId: lifecycleAgentId,
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: capabilityServerId,
        settings,
        enabled: !isSessionActive || supportsLocalControl,
    });

    // A pre-start death (no vendor resume id ever persisted) stays continuable by fresh
    // spawn instead of dead-ending in a "can't restore context" notice (QA A-F5).
    const isResumable = canResumeSessionWithOptions(ownerMetadata, resumeCapabilityOptions)
        || canContinueSessionWithFreshSpawn(ownerMetadata, resumeCapabilityOptions);
    const isResuming = sessionStatus.state === 'resuming';
    const sessionSubmitPort = React.useMemo(() => createSyncBackedSubmitPort(sync), []);
    const readLatestSessionForSubmit = React.useCallback(() => {
        return storage.getState().sessions[sessionId] ?? session;
    }, [session, sessionId]);
    const persistedVoiceComposerRouting = resolveVoiceSessionComposerRouting({
        conversationSessionId: sessionId,
        sessionMetadata: ownerMetadata,
    });

    const messageRef = React.useRef(message);
    const pendingComposerDocumentOwnerRef = React.useRef<MutableComposerDocumentOwner | null>(null);
    const pendingComposerEditExposedSuccessorRef = React.useRef<PendingMessageComposerExposedSuccessor | null>(null);
    const {
        clearDraft,
        clearDraftForSessionIfCurrentValueMatches,
        readLatestDraftValue,
        restoreDraftForSessionIfCurrentValueMatches,
        setDraftValue,
        restoreDraft,
        restoreComposerSnapshot,
    } = useDraft(sessionId, message, setMessage);
    const sessionDraftAddress = React.useMemo(() => ({
        kind: 'session' as const,
        sessionId,
    }), [sessionId]);
    const subscribeCurrentSessionDraft = React.useCallback((listener: () => void) => (
        activeServerAccountScope
            ? subscribeSessionDraft(activeServerAccountScope, sessionDraftAddress, listener)
            : () => undefined
    ), [activeServerAccountScope, sessionDraftAddress]);
    const getCurrentSessionDraftSnapshot = React.useCallback(() => (
        activeServerAccountScope
            ? getSessionDraftSnapshot(activeServerAccountScope, sessionDraftAddress)
            : null
    ), [activeServerAccountScope, sessionDraftAddress]);
    const currentSessionDraftSnapshot = React.useSyncExternalStore(
        subscribeCurrentSessionDraft,
        getCurrentSessionDraftSnapshot,
        getCurrentSessionDraftSnapshot,
    );
    const draftConflictBanner = useSessionDraftConflictComposerBanner(
        currentSessionDraftSnapshot?.conflict ?? null,
    );
    const sessionComposerRef = React.useMemo<Extract<ComposerRefV1, { kind: 'session' }>>(
        () => ({ kind: 'session', sessionId }),
        [sessionId],
    );
    const existingSessionComposerOwner = React.useMemo(() => activeServerAccountScope
        ? createExistingSessionComposerDocumentOwner({
            scope: activeServerAccountScope,
            ref: sessionComposerRef,
        })
        : createEphemeralComposerDocumentOwner({
            ref: sessionComposerRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: messageRef.current,
                structuredInputMentions: [],
                composerAttachments: [],
            },
        }), [activeServerAccountScope, sessionComposerRef]);
    const readActiveComposerPresentationRevision = React.useCallback(() => {
        const ref = activeComposerRefRef.current;
        const pendingEdit = pendingMessageEditRef.current;
        if (
            ref.kind === 'pendingMessage'
            && ref.sessionId === sessionId
            && pendingEdit?.localId === ref.localId
        ) {
            return pendingComposerDocumentOwnerRef.current?.read().revision
                ?? pendingEdit.document.revision;
        }
        return existingSessionComposerOwner.read().revision;
    }, [existingSessionComposerOwner, sessionId]);
    const setComposerDraftValue = React.useCallback((nextValueOrUpdater: React.SetStateAction<string>) => {
        setDraftValue((currentValue) => {
            const nextValue = typeof nextValueOrUpdater === 'function'
                ? (nextValueOrUpdater as (value: string) => string)(currentValue)
                : nextValueOrUpdater;
            if (!activeServerAccountScope) {
                const snapshot = existingSessionComposerOwner.read();
                existingSessionComposerOwner.apply(snapshot.revision, {
                    text: nextValue,
                    references: composerReferencesFromStructuredMentions({
                        text: nextValue,
                        mentions: snapshot.document.structuredInputMentions,
                    }),
                    attachments: snapshot.document.composerAttachments.map((attachment) => (
                        composerAttachmentDraftToView(attachment, {
                            entriesById: composerAttachmentAvailabilityEntriesById,
                        })
                    )),
                });
            }
            messageRef.current = nextValue;
            return nextValue;
        });
    }, [
        activeServerAccountScope,
        composerAttachmentAvailabilityEntriesById,
        existingSessionComposerOwner,
        setDraftValue,
    ]);
    const updatePendingMessageComposerDocument = React.useCallback((
        updater: (document: PendingMessageComposerEditState['document']) => PendingMessageComposerEditState['document'],
    ): PendingMessageComposerEditState | null => {
        const current = pendingMessageEditRef.current;
        if (!current) return null;
        const candidate = updater(current.document);
        if (candidate === current.document) return current;
        const owner = pendingComposerDocumentOwnerRef.current;
        const revision = owner?.replaceDocument({
            text: candidate.text,
            structuredInputMentions: candidate.mentions,
            composerAttachments: candidate.attachments,
        }) ?? candidate.revision;
        const document = { ...candidate, revision };
        const next = { ...current, document };
        pendingMessageEditRef.current = next;
        setPendingMessageEdit(next);
        notifyComposerPresentationTargetChanged({
            kind: 'pendingMessage',
            sessionId,
            localId: next.localId,
        });
        return next;
    }, [sessionId]);
    const setVisibleComposerDraftValue = React.useCallback((nextValueOrUpdater: React.SetStateAction<string>) => {
        const pendingEdit = pendingMessageEditRef.current;
        if (!pendingEdit) {
            setComposerDraftValue(nextValueOrUpdater);
            return;
        }
        updatePendingMessageComposerDocument((document) => {
            const text = typeof nextValueOrUpdater === 'function'
                ? (nextValueOrUpdater as (value: string) => string)(document.text)
                : nextValueOrUpdater;
            if (text === document.text) return document;
            return { ...document, text, revision: document.revision + 1 };
        });
    }, [setComposerDraftValue, updatePendingMessageComposerDocument]);
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);
    React.useEffect(() => {
        return existingSessionComposerOwner.observe(() => {
            // useDraft is the single repository-to-text bridge. This observer
            // only invalidates semantic Composer presentations (references,
            // attachments, and transaction revisions).
            notifyComposerPresentationTargetChanged({ kind: 'session', sessionId });
        });
    }, [existingSessionComposerOwner, sessionId]);
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
    const captureComposerSemanticDraftSnapshot = React.useCallback((): ComposerSemanticDraftSnapshot => {
        const snapshot = {} as {
            [FieldId in SessionDraftValueFieldId]: ComposerSemanticDraftSnapshot[FieldId];
        };
        const document = existingSessionComposerOwner.read().document;
        snapshot['structuredInput.mentions'] = document.structuredInputMentions;
        snapshot['structuredInput.composerAttachments'] = document.composerAttachments;
        if (activeServerAccountScope) {
            const stored = getSessionDraftSnapshot(
                activeServerAccountScope,
                { kind: 'session', sessionId },
            );
            if (stored?.document.target.kind === 'session') {
                const routing = stored.document.target.routing;
                const recipientValue = routing.recipient.value;
                const recipient = recipientValue && typeof recipientValue === 'object' && !Array.isArray(recipientValue)
                    && 'mode' in recipientValue && recipientValue.mode === 'manual'
                    ? SESSION_DRAFT_VALUE_SCHEMAS['routing.recipient'].safeParse(recipientValue.recipient)
                    : null;
                if (recipient?.success) snapshot['routing.recipient'] = recipient.data;
                const continuation = SESSION_DRAFT_VALUE_SCHEMAS['routing.agentContinuation']
                    .safeParse(routing.agentContinuation.value);
                if (continuation.success) snapshot['routing.agentContinuation'] = continuation.data;
                const delivery = SESSION_DRAFT_VALUE_SCHEMAS['routing.executionRunDelivery']
                    .safeParse(routing.executionRunDelivery.value);
                if (delivery.success) snapshot['routing.executionRunDelivery'] = delivery.data;
            }
        }
        return snapshot;
    }, [activeServerAccountScope, existingSessionComposerOwner, sessionId]);
    const captureComposerSemanticDraftCurrentnessSnapshot = React.useCallback((): ComposerSemanticDraftCurrentnessSnapshot => ({
        values: captureComposerSemanticDraftSnapshot(),
        repositoryCurrentness: activeServerAccountScope
            ? captureSessionDraftCurrentness({
                scope: activeServerAccountScope,
                address: { kind: 'session', sessionId },
            })
            : { address: { kind: 'session', sessionId }, mutationIds: {} },
    }), [activeServerAccountScope, captureComposerSemanticDraftSnapshot, sessionId]);
    const clearSemanticDraftValuesAfterOutboundHandoff = React.useCallback((
        snapshot: ComposerSemanticDraftCurrentnessSnapshot,
    ): readonly SessionDraftValueFieldId[] => {
        if (!activeServerAccountScope) return [];
        const changed = clearSessionDraftCurrentnessLocal({
            scope: activeServerAccountScope,
            address: { kind: 'session', sessionId },
            currentness: snapshot.repositoryCurrentness,
        });
        if (!changed) return [];
        void flushSessionDraft({
            scope: activeServerAccountScope,
            address: { kind: 'session', sessionId },
        });
        const cleared = [...SESSION_COMPOSER_DRAFT_FIELD_IDS];
        if (cleared.includes('structuredInput.composerAttachments')) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return cleared;
    }, [activeServerAccountScope, sessionId]);
    const restoreSemanticDraftValuesFromSnapshot = React.useCallback((input: Readonly<{
        snapshot: ComposerSemanticDraftCurrentnessSnapshot;
        clearedSnapshot: ComposerSemanticDraftCurrentnessSnapshot;
        clearedFieldIds: readonly SessionDraftValueFieldId[];
    }>): readonly SessionDraftValueFieldId[] => {
        const candidateFields = readPendingMessageComposerSemanticDraftFieldsToRestore(
            input.snapshot.values,
            captureComposerSemanticDraftSnapshot(),
            input.clearedFieldIds,
            input.clearedSnapshot.values,
        );
        if (!activeServerAccountScope) return [];
        const currentness = captureSessionDraftCurrentness({
            scope: activeServerAccountScope,
            address: { kind: 'session', sessionId },
        });
        const pathByField: Readonly<Record<SessionDraftValueFieldId, string>> = {
            'structuredInput.mentions': 'composer.mentions',
            'structuredInput.composerAttachments': 'composer.attachments',
            'routing.recipient': 'target.routing.recipient',
            'routing.agentContinuation': 'target.routing.agentContinuation',
            'routing.executionRunDelivery': 'target.routing.executionRunDelivery',
        };
        const fieldsToRestore = candidateFields.filter((fieldId) => {
            const path = pathByField[fieldId];
            return currentness.mutationIds[path] === input.clearedSnapshot.repositoryCurrentness.mutationIds[path];
        });
        const values = input.snapshot.values;
        writeExistingSessionDraft({
            scope: activeServerAccountScope,
            sessionId,
            patch: {
                ...(fieldsToRestore.includes('structuredInput.mentions')
                    ? {
                        mentions: (values['structuredInput.mentions'] ?? [])
                            .map((value) => StrictJsonValueSchema.parse(value)),
                    }
                    : {}),
                ...(fieldsToRestore.includes('structuredInput.composerAttachments')
                    ? {
                        attachments: (values['structuredInput.composerAttachments'] ?? [])
                            .map((value) => StrictJsonValueSchema.parse(value)),
                    }
                    : {}),
                routing: {
                    ...(fieldsToRestore.includes('routing.recipient')
                        ? {
                            recipient: StrictJsonValueSchema.parse({
                                mode: 'manual',
                                recipient: values['routing.recipient'] ?? null,
                            }),
                        }
                        : {}),
                    ...(fieldsToRestore.includes('routing.agentContinuation')
                        ? {
                            agentContinuation: StrictJsonValueSchema.parse(
                                values['routing.agentContinuation'] ?? null,
                            ),
                        }
                        : {}),
                    ...(fieldsToRestore.includes('routing.executionRunDelivery')
                        ? { executionRunDelivery: values['routing.executionRunDelivery'] ?? null }
                        : {}),
                },
            },
        });
        if (fieldsToRestore.includes('structuredInput.composerAttachments')) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return fieldsToRestore;
    }, [
        activeServerAccountScope,
        captureComposerSemanticDraftSnapshot,
        sessionId,
    ]);
    const clearSemanticDraftValuesAfterAcceptedComposerClear = React.useCallback(() => {
        // `composerClear` consumes the whole composer decision. The catalog
        // clears the persisted draft; the picker owns the mounted counterpart.
        if (inSessionAgentPicker.armedContinuation !== null) {
            inSessionAgentPicker.clearArmedContinuation();
        }
        existingSessionComposerOwner.clear('discarded');
    }, [
        existingSessionComposerOwner,
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.clearArmedContinuation,
        sessionId,
    ]);
    // A transition input can cross a remount before its canonical custody is
    // visible. This is the one compare-clear path for both a live outcome and
    // the nested pre-RPC snapshot restored by the arm: each composer-facing
    // value is removed only while it still equals what that exact request used.
    const {
        armedContinuation: liveArmedContinuation,
        armedContinuationLocalId: liveArmedContinuationLocalId,
        armedContinuationSubmission: liveArmedContinuationSubmission,
        clearArmedContinuation,
        clearArmedContinuationSubmissionIfCurrent: clearPersistedArmedContinuationSubmissionIfCurrent,
    } = inSessionAgentPicker;
    const { clearTransientInputState } = inputComposerPersistence;
    const clearArmedContinuationSubmissionIfCurrent = React.useCallback((
        submission: SessionArmedAgentContinuationSubmission,
    ): boolean => {
        const currentness = submission.currentness;
        let clearedComposerAttachments = false;
        const didClearComposer = clearComposerAfterOutboundHandoff({
            snapshot: {
                sessionId,
                // Older retained arms did not carry the raw composer text. Their
                // expanded wire input is a conservative fallback; new arms always
                // use `currentness.text`.
                text: currentness?.text ?? submission.input.text,
            },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            ...(currentness
                ? {
                    clearSemanticDraftValuesMatchingSnapshot: () => {
                        const ownerSnapshot = existingSessionComposerOwner.read();
                        const clearMentions = sameStrictJsonValue(
                            ownerSnapshot.document.structuredInputMentions,
                            currentness.mentions,
                        );
                        const clearAttachments = sameStrictJsonValue(
                            ownerSnapshot.document.composerAttachments,
                            currentness.composerAttachments,
                        );
                        const didClear = clearMentions || clearAttachments;
                        if (didClear) {
                            const result = existingSessionComposerOwner.apply(ownerSnapshot.revision, {
                                text: ownerSnapshot.document.text,
                                references: [...composerReferencesFromStructuredMentions({
                                    text: ownerSnapshot.document.text,
                                    mentions: clearMentions ? [] : ownerSnapshot.document.structuredInputMentions,
                                })],
                                attachments: (clearAttachments ? [] : ownerSnapshot.document.composerAttachments)
                                    .map((attachment) => composerAttachmentDraftToView(attachment, {
                                        entriesById: composerAttachmentAvailabilityEntriesById,
                                    })),
                            });
                            clearedComposerAttachments = clearAttachments && result.status === 'applied';
                        }
                        if (clearedComposerAttachments) {
                            setComposerDocumentRenderEpoch((current) => current + 1);
                        }
                        return didClear;
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
                attachmentDraftsSnapshotRef.current = nextAttachmentDrafts;
                if (nextAttachmentDrafts.length === 0) {
                    clearSessionAttachmentDrafts(sessionId);
                } else {
                    writeSessionAttachmentDrafts(sessionId, nextAttachmentDrafts);
                }
                replaceAttachmentManagerDrafts(nextAttachmentDrafts);
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

        return didClearComposer || didClearAttachmentDrafts || didClearReviewComments;
    }, [
        activeServerAccountScope,
        composerAttachmentAvailabilityEntriesById,
        existingSessionComposerOwner,
        clearDraftForSessionIfCurrentValueMatches,
        clearSentReviewCommentDrafts,
        clearTransientInputState,
        includedReviewCommentDrafts,
        replaceAttachmentManagerDrafts,
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
    React.useEffect(() => {
        // A live outcome owns its own reconciliation. A remounted arm has no
        // persisted result to replay; canonical custody alone is enough to
        // consume the exact pre-RPC snapshot without inventing status state.
        if (activeArmedContinuationOutcome?.kind === 'outcome') return;
        const submission = liveArmedContinuationSubmission;
        if (!submission || armedContinuationInputCustody === 'absent') return;
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
        armedContinuationInputCustody,
        clearArmedContinuation,
        clearPersistedArmedContinuationSubmissionIfCurrent,
        clearArmedContinuationSubmissionIfCurrent,
        liveArmedContinuation,
        liveArmedContinuationLocalId,
        liveArmedContinuationSubmission,
    ]);
    const isPendingMessageEditAccountCurrent = React.useCallback((edit: PendingMessageComposerEditState): boolean => {
        if (edit.accountLifetime) return edit.accountLifetime.isCurrent();
        return edit.accountScope === null && activeServerAccountScope === null;
    }, [activeServerAccountScope]);
    const readSessionComposerSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        return projectComposerDocumentSnapshot({
            owner: existingSessionComposerOwner,
            attachmentCatalog: { entriesById: composerAttachmentAvailabilityEntriesById },
            presentation: {
                layout: composerActionBarLayoutRef.current,
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            },
        });
    }, [composerAttachmentAvailabilityEntriesById, existingSessionComposerOwner]);
    const readSessionComposerSubmissionSnapshot = React.useCallback((text: string): ComposerSnapshotV1 => {
        const snapshot = readSessionComposerSnapshot();
        if (snapshot.text === text) return snapshot;
        const mentions = existingSessionComposerOwner.read().document.structuredInputMentions;
        return {
            ...snapshot,
            text,
            references: [...composerReferencesFromStructuredMentions({ text, mentions })],
        };
    }, [existingSessionComposerOwner, readSessionComposerSnapshot]);
    const readPendingMessageComposerSnapshot = React.useCallback((
        edit: PendingMessageComposerEditState,
    ): ComposerSnapshotV1 => {
        const snapshot = readSessionComposerSnapshot();
        return {
            ...snapshot,
            revision: edit.document.revision,
            ref: { kind: 'pendingMessage', sessionId, localId: edit.localId },
            text: edit.document.text,
            references: [...composerReferencesFromStructuredMentions({
                text: edit.document.text,
                mentions: edit.document.mentions,
            })],
            attachments: edit.document.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
                entriesById: composerAttachmentAvailabilityEntriesById,
            })),
        };
    }, [composerAttachmentAvailabilityEntriesById, readSessionComposerSnapshot, sessionId]);
    const isPendingMessageComposerSubmissionSnapshotCurrent = React.useCallback((
        edit: PendingMessageComposerEditState,
        snapshot: ComposerSubmissionSnapshot,
    ): boolean => {
        if (
            snapshot.ref.kind !== 'pendingMessage'
            || snapshot.ref.sessionId !== sessionId
            || snapshot.ref.localId !== edit.localId
        ) {
            return false;
        }
        const current = readPendingMessageComposerSnapshot(edit);
        return current.revision === snapshot.revision
            && current.ref.kind === snapshot.ref.kind
            && current.ref.sessionId === snapshot.ref.sessionId
            && current.ref.localId === snapshot.ref.localId
            && current.text === snapshot.text
            && sameStrictJsonValue(current.references, snapshot.references)
            && sameComposerAttachmentViews(current.attachments, snapshot.attachments);
    }, [readPendingMessageComposerSnapshot, sessionId]);
    const commitSessionComposerDocument = React.useCallback((
        input: Readonly<{
            expectedRevision: number;
            mutation: ComposerPresentationDocumentMutation;
        }>,
        targetRef: ComposerRefV1 = activeComposerRefRef.current,
    ): ComposerTransactionResultV1 => {
        if (targetRef.kind === 'pendingMessage') {
            const edit = pendingMessageEditRef.current;
            if (
                !edit
                || edit.localId !== targetRef.localId
                || targetRef.sessionId !== sessionId
            ) {
                return { status: 'conflict', currentRevision: 0 };
            }
            const owner = pendingComposerDocumentOwnerRef.current;
            if (!owner) return { status: 'composerUnavailable' };
            const previous = owner.read().document;
            const result = owner.apply(input.expectedRevision, input.mutation);
            if (result.status !== 'applied') return result;
            const next = owner.read().document;
            const attachmentsChanged = !sameStrictJsonValue(
                previous.composerAttachments,
                next.composerAttachments,
            );
            const nextDocument = {
                text: next.text,
                mentions: next.structuredInputMentions,
                attachments: next.composerAttachments,
                revision: result.revision,
            } satisfies PendingMessageComposerEditState['document'];
            updatePendingMessageComposerDocument(() => nextDocument);
            if (attachmentsChanged) {
                setComposerDocumentRenderEpoch((current) => current + 1);
            }
            return result;
        }

        const previous = existingSessionComposerOwner.read().document;
        const result = existingSessionComposerOwner.apply(input.expectedRevision, input.mutation);
        if (result.status !== 'applied') return result;
        const next = existingSessionComposerOwner.read().document;
        if (previous.text !== next.text) {
            messageRef.current = next.text;
            setMessage(next.text);
        }
        if (!sameStrictJsonValue(previous.structuredInputMentions, next.structuredInputMentions)) {
            inputComposerPersistence.structuredInputPersistence.onMentionsChange(next.structuredInputMentions);
        }
        if (!sameStrictJsonValue(previous.composerAttachments, next.composerAttachments)) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return result;
    }, [
        existingSessionComposerOwner,
        inputComposerPersistence.structuredInputPersistence,
        sessionId,
        updatePendingMessageComposerDocument,
    ]);
    const cancelPendingMessageEdit = React.useCallback(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        pendingMessageEditRef.current = null;
        pendingComposerDocumentOwnerRef.current = null;
        setPendingMessageEdit(null);
        clearPendingMessageEditDrainHold(edit.holdId);
    }, [clearPendingMessageEditDrainHold]);
    const handleEditPendingMessage = React.useCallback((request: PendingMessageEditRequest) => {
        if (externalSessionOperationShell.blocksNewOperation) return;
        // The composer reopens what the reader SAW. A queued turn that expanded
        // review comments, attachments or a template into its transport text
        // kept the typed sentence in `displayText`, and editing the expansion is
        // editing something the user never wrote. The mention admission below
        // reads the same text, so a chip can never outlive its token.
        const editText = readMessageDisplayText(request);
        const attachmentHydration = hydratePendingMessageComposerAttachmentDrafts(
            readObjectRecord(request.message.rawRecord)?.meta,
            editText,
        );
        if (attachmentHydration.status !== 'ready') {
            Modal.alert(
                t('common.error'),
                tLoose('session.pendingMessages.errors.editStructuredInputUnsupported'),
            );
            return;
        }

        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const hydratedComposerMentions = composerStructuredMentionsFromReferences({
            references: attachmentHydration.mentions ?? [],
            existing: [],
        });
        const previousEdit = pendingMessageEditRef.current;
        if (previousEdit && previousEdit.pendingId !== request.id) {
            clearPendingMessageEditDrainHold(previousEdit.holdId);
        }
        if (previousEdit?.pendingId !== request.id) {
            // A successor identity belongs to the row that exposed it.
            pendingComposerEditExposedSuccessorRef.current = null;
        }
        const localId = request.message.localId ?? request.id;
        const pendingRef = { kind: 'pendingMessage' as const, sessionId, localId };
        const pendingOwner = createPendingMessageComposerDocumentOwner({
            ref: pendingRef,
            initialDocument: {
                text: editText,
                structuredInputMentions: hydratedComposerMentions,
                composerAttachments: attachmentHydration.attachments,
            },
            isCurrent: () => {
                const current = pendingMessageEditRef.current;
                return current?.localId === localId
                    && (accountLifetime === null || accountLifetime.isCurrent());
            },
        });
        const document = {
            text: editText,
            mentions: hydratedComposerMentions,
            attachments: attachmentHydration.attachments,
            revision: pendingOwner.read().revision,
        } satisfies PendingMessageComposerEditState['document'];
        const nextEdit: PendingMessageComposerEditState = {
            pendingId: request.id,
            localId,
            holdId: previousEdit?.pendingId === request.id ? previousEdit.holdId : randomUUID(),
            accountScope: accountLifetime?.scope ?? null,
            accountLifetime,
            document,
            admittedDocument: document,
        };
        pendingComposerDocumentOwnerRef.current = pendingOwner;
        pendingMessageEditRef.current = nextEdit;
        setPendingMessageEdit(nextEdit);
        notifyComposerPresentationTargetChanged({
            kind: 'pendingMessage',
            sessionId,
            localId: nextEdit.localId,
        });
    }, [
        captureActiveServerAccountScopeLifetime,
        clearPendingMessageEditDrainHold,
        externalSessionOperationShell.blocksNewOperation,
        sessionId,
    ]);
    React.useEffect(() => {
        const edit = pendingMessageEditRef.current;
        if (!edit) return;
        const stillQueued = pendingMessages.some((pending) =>
            pending.id === edit.pendingId || pending.localId === edit.pendingId
        );
        if (stillQueued) return;

        pendingMessageEditRef.current = null;
        pendingComposerDocumentOwnerRef.current = null;
        pendingComposerEditExposedSuccessorRef.current = null;
        setPendingMessageEdit(null);
        clearPendingMessageEditDrainHold(edit.holdId);
    }, [clearPendingMessageEditDrainHold, pendingMessages]);
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
    }, [clearPendingMessageEditDrainHold]);
    const preparePendingComposerAdmissionCandidate = React.useCallback((
        edit: PendingMessageComposerEditState,
        snapshot: ComposerSubmissionSnapshot,
    ): Readonly<{
        attachments: readonly ComposerAttachmentDraftV1[];
        localId: string;
        replacementLocalId?: string;
    }> => {
        const attachments = snapshot.attachments.map(composerAttachmentViewToDraft);
        const admittedByInstanceId = new Map(
            edit.admittedDocument.attachments.map((attachment) => [attachment.instanceId, attachment]),
        );
        const requiresPreparation = attachments.some((attachment) => {
            const admitted = admittedByInstanceId.get(attachment.instanceId);
            if (sameStrictJsonValue(admitted, attachment)) return false;
            const entry = resolveCurrentComposerAttachmentCatalogEntry(
                attachment,
                composerAttachmentAvailabilityEntriesById,
            );
            return entry?.definition.runtime?.prepareForSend === true;
        });
        const fingerprint = StrictJsonValueSchema.parse({
            text: snapshot.text,
            references: snapshot.references,
            attachments,
        });
        // One owner decides rotation. Preparation exposes the Message local id to
        // the contributor, so every later differing payload — text-only included —
        // must rotate rather than reuse an identity a plugin already saw.
        const rotation = decidePendingMessageComposerRotation({
            pendingId: edit.pendingId,
            fingerprint,
            requiresPreparation,
            exposed: pendingComposerEditExposedSuccessorRef.current,
            allocateLocalId: () => randomUUID(),
        });
        // Record the identity before any daemon callback; retried identical
        // snapshots keep it, while a changed payload gets a new candidate rather
        // than reusing a potentially admitted one.
        pendingComposerEditExposedSuccessorRef.current = rotation.exposed;
        return {
            localId: rotation.replacementLocalId ?? edit.pendingId,
            ...(rotation.replacementLocalId ? { replacementLocalId: rotation.replacementLocalId } : {}),
            attachments,
        };
    }, [
        composerAttachmentAvailabilityEntriesById,
    ]);

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

    const publishModelSelection = React.useCallback(async (ref: ProviderBoundModelRef | null) => {
        if (!agentId) return;
        const mode = ref?.modelId ?? 'default';
        const intentBaselineUpdatedAt =
            providerModelSelectionIntent?.updatedAt ?? 0;
        if (ref?.providerConnectionId === null
            && !isModelSelectableForSession(agentId, ownerMetadata, mode)) return;
        try {
            const result = await actionExecutor.execute('session.model.set', {
                sessionId,
                modelId: mode,
                providerConnectionId: ref?.providerConnectionId ?? null,
            }, {
                surface: 'ui',
                defaultSessionId: sessionId,
                serverId: sessionRouteServerId,
            });
            if (result.ok) {
                setModelTransitionActionRequired(null);
                return;
            }
            const transition = SessionModelTransitionResultV1Schema.safeParse({
                ok: false,
                ...(result.details && typeof result.details === 'object'
                    ? result.details
                    : {}),
            });
            if (
                transition.success
                && (
                    transition.data.status === 'restart_required'
                    || transition.data.status === 'reconciliation_required'
                )
            ) {
                setModelTransitionActionRequired({
                    status: transition.data.status,
                    requestedSelection: transition.data.requestedSelection,
                    intentBaselineUpdatedAt,
                });
                return;
            }
            setModelTransitionActionRequired(null);
            Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
        } catch {
            setModelTransitionActionRequired(null);
            Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
        }
    }, [
        actionExecutor,
        agentId,
        providerModelSelectionIntent?.updatedAt,
        sessionId,
        ownerMetadata,
        sessionRouteServerId,
    ]);

    // Function to update a native model mode (only for agents that expose model selection in the UI).
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (!providerAgentTargetKey) return;
        void publishModelSelection(mode === 'default'
            ? null
            : { agentTargetKey: providerAgentTargetKey, providerConnectionId: null, modelId: mode });
    }, [providerAgentTargetKey, publishModelSelection]);
    const existingSessionNativeModels = React.useMemo(() => (
        agentId ? getModelOptionsForSession(agentId, ownerMetadata) : []
    ), [agentId, ownerMetadata]);
    const existingSessionSelectedModelRef = React.useMemo<ProviderBoundModelRef | null>(() => (
        providerModelSelection?.ref
        ?? (providerAgentTargetKey && modelMode !== 'default'
            ? { agentTargetKey: providerAgentTargetKey, providerConnectionId: null, modelId: modelMode }
            : null)
    ), [modelMode, providerAgentTargetKey, providerModelSelection?.ref]);
    const existingSessionSelectedModelOptionControls = React.useMemo(() => {
        if (!agentId) return null;
        if (existingSessionSelectedModelRef?.providerConnectionId) return null;
        const selectedModel = findModelOptionForEffectiveModelId(
            existingSessionNativeModels,
            existingSessionSelectedModelRef?.modelId ?? 'default',
        );
        const configOptions = selectedModel?.modelOptions ?? null;
        return computeAcpConfigOptionControlsFromOverride({
            agentId,
            configOptions,
            // The session's published overrides are the only owner of these values. Without them
            // every model-scoped control (Thinking, Ultracode) renders the agent's catalog default
            // and every toggle snaps back on the next metadata tick.
            overrides: resolveSessionConfigOptionOverridesFromMetadata({
                metadata: ownerMetadata,
                configOptions,
            }),
        });
    }, [agentId, existingSessionNativeModels, existingSessionSelectedModelRef, ownerMetadata]);
    const existingSessionReportedModel = React.useMemo(() => {
        const reportedSelection = modelSelectionDisposition?.reportedSelection ?? null;
        const reportedStatus = modelSelectionDisposition?.reportedSelectionStatus ?? null;
        if (!reportedSelection || !reportedStatus) return null;
        const canonicalReportedSelection = resolveCanonicalNativeModelSelectionRef(
            existingSessionNativeModels,
            reportedSelection,
        );
        return {
            ref: canonicalReportedSelection,
            ...(reportedSelection.providerConnectionId === providerLaunchBinding?.connectionId
                && providerLaunchBinding?.model?.id === reportedSelection.modelId
                && providerLaunchBinding.model.name
                ? { label: providerLaunchBinding.model.name }
                : {}),
            status: reportedStatus,
        };
    }, [
        existingSessionNativeModels,
        modelSelectionDisposition,
        providerLaunchBinding,
    ]);
    const existingSessionHiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        readProviderSettingsFromAccountSettingsV1(settings).settings,
        { providersFeatureEnabled },
    ), [providersFeatureEnabled, settings]);
    const existingSessionModelPicker = React.useMemo(() => {
        if (!agentId || !providerAgentTargetKey) return undefined;
        const providerGroups = providersFeatureEnabled
            ? (providerModelProjection.data?.groups ?? EMPTY_SESSION_MODEL_PROJECTION_GROUPS)
            : EMPTY_SESSION_MODEL_PROJECTION_GROUPS;
        const selectedRef = resolveCanonicalNativeModelSelectionRef(
            existingSessionNativeModels,
            existingSessionSelectedModelRef,
        );
        const selectedProviderRow = selectedRef?.providerConnectionId
            ? providerGroups.flatMap((group) => group.rows)
                .find((row) => sessionModelSelectionKey(row.ref) === sessionModelSelectionKey(selectedRef))
            : null;
        const selectedModelId = selectedRef?.modelId ?? 'default';
        const nativeLabel = findModelOptionForEffectiveModelId(existingSessionNativeModels, selectedModelId)?.label
            ?? selectedModelId;
        return (
            <SessionModelPicker
                multiColumn
                agentTargetKey={providerAgentTargetKey}
                nativeModels={existingSessionNativeModels}
                providerGroups={providerGroups}
                providerProjectionAuthoritative={providerModelProjection.status === 'success'}
                projectionError={providersFeatureEnabled ? providerModelProjection.error : null}
                retryProjection={providersFeatureEnabled ? providerModelProjection.refresh : null}
                currentSelectionRecovery={providersFeatureEnabled
                    ? providerModelProjection.data?.currentSelectionRecovery ?? null
                    : null}
                hiddenNativeModelKeys={existingSessionHiddenNativeModelKeys}
                selected={selectedRef}
                effectiveLabel={selectedProviderRow?.descriptor.name ?? nativeLabel}
                reportedModel={existingSessionReportedModel}
                canEnterCustomNativeValue={supportsFreeformModelSelectionForSession(agentId, ownerMetadata)}
                selectedOptionControls={existingSessionSelectedModelOptionControls ?? undefined}
                onSelectOptionControlValue={updateAcpConfigOptionOverride}
                probe={providersFeatureEnabled
                    ? providerModelProjection.loading
                        ? { phase: 'loading' }
                        : { phase: 'idle', onRefresh: () => { void providerModelProjection.refresh(); } }
                    : undefined}
                experimentalConfirmation={confirmExperimentalProviderModel}
                onSelect={(ref) => {
                    hapticsLight();
                    const canonicalRef = resolveCanonicalNativeModelSelectionRef(existingSessionNativeModels, ref);
                    void publishModelSelection(canonicalRef);
                }}
            />
        );
    }, [
        agentId,
        confirmExperimentalProviderModel,
        existingSessionHiddenNativeModelKeys,
        existingSessionNativeModels,
        existingSessionReportedModel,
        existingSessionSelectedModelRef,
        existingSessionSelectedModelOptionControls,
        modelMode,
        providerAgentTargetKey,
        providerModelProjection.data,
        providerModelProjection.error,
        providerModelProjection.loading,
        providerModelProjection.refresh,
        providerModelProjection.status,
        providerModelSelection?.ref,
        providersFeatureEnabled,
        publishModelSelection,
        updateAcpConfigOptionOverride,
        ownerMetadata,
    ]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
        const silent = opts?.silent === true;
        const resumeMachineId = reachableMachineTarget?.machineId ?? ownerMetadata?.machineId ?? null;
        const resumeDirectory = reachableMachineTarget?.basePath ?? ownerMetadata?.path ?? null;

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
            !canResumeSessionWithOptions(ownerMetadata, resumeCapabilityOptions)
            && !canContinueSessionWithFreshSpawn(ownerMetadata, resumeCapabilityOptions)
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
                    // Continuation is authored through the canonical New Session
                    // screen with this Session attached as source context, so the
                    // one Replay-seeded creation owner (`session.spawn_new`)
                    // creates the child. The legacy `session.continueWithReplay`
                    // RPC stays a compatibility ingress with no UI product use.
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

        if (!isMachineReachable) {
            maybeAlert(t('session.machineOfflineCannotResume'));
            return false;
        }

        try {
            const permissionOverride = getPermissionModeOverrideForSpawn(session);
            const modelOverride = getModelOverrideForSpawn(
                session,
                resolveBackendTargetKeyV2(resolveSessionActionDefaultTarget(sessionActionDefaultBackend) ?? { kind: 'builtInAgent', agentId }),
            );
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
        }
    }, [agentId, capabilityServerId, executionRunsEnabled, isMachineReachable, reachableMachineTarget, resumeCapabilityOptions, router, session, sessionActionDefaultBackend, sessionId, settings]);
    handleUsageLimitRecoveryResumeNowRef.current = handleResumeSession;

    // The committed-but-inactive recovery. The banner offers it only once
    // canonical facts say the Session has no live runtime, and it does nothing
    // itself: starting a Session belongs to `handleResumeSession`, which every
    // other inactive-session affordance already uses. A successful start makes
    // the notice untrue, so it goes.
    const handleArmedContinuationResume = React.useCallback(async () => {
        const resumed = await handleResumeSession({ silent: false });
        if (!resumed) return;
        setArmedContinuationOutcome((current) => (
            current?.scopeKey === activeServerAccountScopeKey ? null : current
        ));
    }, [activeServerAccountScopeKey, handleResumeSession]);

    useSessionResumeRequestListener(
        sessionId,
        React.useCallback(() => handleResumeSession(), [handleResumeSession]),
    );

    const providerName = sessionActionDefaultBackendEntry?.title
        ?? resolveSessionActionDefaultBackendTitle({
            session,
            sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
            fallbackTitle: agentCore
                ? t(agentCore.uiConnectedService.labelKey)
                : formatAgentLikeIdForDisplay(agentId),
        })
        ?? t('status.unknown');
    const machineName = ownerMetadata?.host ?? t('status.unknown');

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
    /**
     * The one Composer mutability rule for this Session screen. Both public
     * snapshots and the host attachment row's mutation affordances read it, so
     * a read-only Session, a blocked external operation, or an `editAndSubmit`
     * lock cannot leave an enabled control whose transaction the owner refuses.
     */
    const isComposerMutationEditable = React.useCallback(
        (inputLock: Readonly<{ mode?: string }> | null): boolean => (
            !isReadOnly
            && !externalSessionOperationShell.blocksNewOperation
            && inputLock?.mode !== 'editAndSubmit'
        ),
        [externalSessionOperationShell.blocksNewOperation, isReadOnly],
    );
    const activeComposerPresentationTarget = useStableComposerPresentationTarget(activeComposerRef, {
        readRevision: readActiveComposerPresentationRevision,
        replace: (text, expectedRevision) => {
            const currentRevision = readActiveComposerPresentationRevision();
            if (currentRevision !== expectedRevision) {
                return currentRevision;
            }
            setVisibleComposerDraftValue(text);
            return readActiveComposerPresentationRevision();
        },
        readSnapshot: () => {
            const edit = pendingMessageEditRef.current;
            const snapshot = activeComposerRef.kind === 'pendingMessage' && edit?.localId === activeComposerRef.localId
                ? readPendingMessageComposerSnapshot(edit)
                : readSessionComposerSnapshot();
            const inputLock = composerInputEffects.readComposerInputLock();
            return {
                ...snapshot,
                state: {
                    focused: surfaceFocused && composerInputFocusedRef.current,
                    editable: isComposerMutationEditable(inputLock),
                    submittable: !isReadOnly && !externalSessionOperationShell.blocksNewOperation && !isComposerSending && inputLock === null,
                    submitting: isComposerSending,
                    running: isSessionActive,
                    ...(inputLock ? { inputLock } : {}),
                },
            };
        },
        commitDocument: (input) => commitSessionComposerDocument(input, activeComposerRef),
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: isActiveComposerPresentationCurrent,
        focusComposer: () => {
            if (
                !surfaceFocused
                || !composerPresentationMountedRef.current
                || composerRefV1Key(activeComposerRefRef.current)
                    !== composerRefV1Key(activeComposerRef)
                || (composerPresentationAccountLifetime !== null && !composerPresentationAccountLifetime.isCurrent())
            ) {
                return false;
            }
            const focus = composerFocusRequestRef.current;
            if (!focus) return false;
            focus();
            return true;
        },
    });
    const sessionComposerPresentationTarget = useStableComposerPresentationTarget(sessionComposerRef, {
        readRevision: () => existingSessionComposerOwner.read().revision,
        replace: (text, expectedRevision) => {
            const snapshot = readSessionComposerSnapshot();
            if (snapshot.revision !== expectedRevision) return snapshot.revision;
            const result = commitSessionComposerDocument({
                expectedRevision,
                mutation: {
                    text,
                    references: snapshot.references,
                    attachments: snapshot.attachments,
                },
            }, sessionComposerRef);
            return result.status === 'applied'
                ? result.revision
                : existingSessionComposerOwner?.read().revision ?? snapshot.revision;
        },
        readSnapshot: () => {
            const inputLock = composerInputEffects.readComposerInputLock();
            return {
                ...readSessionComposerSnapshot(),
                state: {
                    focused: surfaceFocused
                        && activeComposerRefRef.current.kind === 'session'
                        && composerInputFocusedRef.current,
                    editable: isComposerMutationEditable(inputLock),
                    submittable: !isReadOnly && !externalSessionOperationShell.blocksNewOperation && !isComposerSending && inputLock === null,
                    submitting: isComposerSending,
                    running: isSessionActive,
                    ...(inputLock ? { inputLock } : {}),
                },
            };
        },
        commitDocument: (input) => commitSessionComposerDocument(input, sessionComposerRef),
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            composerPresentationMountedRef.current
            && composerPresentationAccountLifetime?.isCurrent() !== false
        ),
        focusComposer: () => {
            if (!surfaceFocused || activeComposerRefRef.current.kind !== 'session') return false;
            const focus = composerFocusRequestRef.current;
            if (!focus) return false;
            focus();
            return true;
        },
    });
    React.useEffect(
        () => registerComposerPresentationTarget(activeComposerRef, activeComposerPresentationTarget),
        [activeComposerPresentationTarget, activeComposerRef],
    );
    React.useEffect(() => {
        if (activeComposerRef.kind === 'session') return;
        return registerComposerPresentationTarget(sessionComposerRef, sessionComposerPresentationTarget);
    }, [activeComposerRef.kind, sessionComposerPresentationTarget, sessionComposerRef]);
    // Catalog replacement and surface-focus transitions change the derived
    // view without changing the persisted document revision. Notify
    // presentation readers so an external composer transaction cannot observe
    // a stale ready view, and so an observer sees this Composer stop being
    // focused when its mounted surface is no longer the focused one.
    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(activeComposerRef);
        if (activeComposerRef.kind === 'pendingMessage') {
            notifyComposerPresentationTargetChanged(sessionComposerRef);
        }
    }, [activeComposerRef, composerAttachmentAvailabilityEntriesById, sessionComposerRef, surfaceFocused]);
    const transcriptInteraction = runtimeDisplayState.transcriptInteraction;

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
    const targetMachineHomeDir = typeof ownerMetadata?.homeDir === 'string'
        ? ownerMetadata.homeDir
        : null;
    const targetMachinePlatform = typeof ownerMetadata?.platform === 'string'
        ? ownerMetadata.platform
        : null;
    const externalSessionTakeover = useExternalSessionTakeover({
        sessionId,
        hasWriteAccess,
        externalSessionRuntime,
        targetMachineHomeDir,
        // The linked session path may describe provider/remote source context.
        // Takeover always starts from a user-confirmed local target on this
        // fixed machine, so only its local home directory seeds the picker.
        targetDirectorySuggestion: targetMachineHomeDir,
        targetMachinePlatform,
    });
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

    const [followBottomIntentSeq, setFollowBottomIntentSeq] = React.useState(0);
    const requestMountedTranscriptFollow = React.useCallback(() => {
        // The sync send boundary already established durable own-send tail intent before
        // optimistic projection. This key is only the mounted physical takeover command.
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
                    return appendTranscriptSelectionToNewSessionDraft({
                        promptText,
                        sourceServerId,
                        scope: activeServerAccountScope,
                    });
                },
                navigateToSession: ({ sessionId: destinationSessionId, serverId }) => {
                    void navigateToSession(destinationSessionId, { serverId });
                },
                navigateToNewSession: (draftId) => {
                    router.push({ pathname: '/new', params: { draftId } });
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
                  externalControlFooter={externalControlFooter}
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
        const pendingComposerDocument = pendingMessageEdit?.document ?? null;
        const visibleComposerText = pendingComposerDocument?.text ?? message;
        const sessionExtraActionPresentation = useSessionAgentInputExtraActionChips({
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
                setVisibleComposerDraftValue((prev) => {
                    const base = prev ?? '';
                    const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
                    return `${base}${spacer}@${path} `;
                });
            },
            reviewCommentsEnabled,
            reviewScope,
            reviewCommentDrafts,
            defaultBackendTarget: resolveSessionActionDefaultTarget(sessionActionDefaultBackend),
            defaultBackendId: sessionActionDefaultBackend?.defaultBackendId ?? null,
            instructionsText: visibleComposerText,
            browserContext: browserContextComposerContext,
        });
        const removeComposerAttachment = React.useCallback((instanceId: string) => {
            const ref = activeComposerRef;
            const snapshot = readComposerPresentationSnapshot(ref);
            if (!snapshot) return;
            applyComposerPresentationTransaction({
                ref,
                transaction: {
                    expectedRevision: snapshot.revision,
                    operations: [{ kind: 'attachment.remove', instanceId }],
                },
            });
        }, [activeComposerRef]);
        const composerAttachmentDrafts = React.useMemo(() => (
            pendingComposerDocument?.attachments
            ?? existingSessionComposerOwner.read().document.composerAttachments
        ), [
            composerDocumentRenderEpoch,
            existingSessionComposerOwner,
            pendingComposerDocument?.attachments,
        ]);
        const composerAttachmentViews = React.useMemo(
            () => composerAttachmentDrafts.map((attachment) => composerAttachmentDraftToView(attachment, {
                entriesById: composerAttachmentAvailabilityEntriesById,
            })),
            [composerAttachmentAvailabilityEntriesById, composerAttachmentDrafts],
        );
        const composerAttachmentRowItems = React.useMemo(() => {
            return projectComposerAttachmentRowItems({
                attachments: composerAttachmentViews,
                // Removal is a Composer mutation; a read-only or locked scope
                // gets preview and picker access without a control the
                // transaction owner would refuse.
                ...(isComposerMutationEditable(composerInputEffects.composerInputLock)
                    ? { onRemove: removeComposerAttachment }
                    : {}),
                entriesById: composerAttachmentAvailabilityEntriesById ?? undefined,
                renderSurface: composerPluginPresentation.renderAttachmentSurface,
                resolveInteraction: composerPluginPresentation.resolveAttachmentInteraction,
            });
        }, [
            composerAttachmentViews,
            composerAttachmentAvailabilityEntriesById,
            composerInputEffects.composerInputLock,
            composerPluginPresentation.renderAttachmentSurface,
            composerPluginPresentation.resolveAttachmentInteraction,
            isComposerMutationEditable,
            removeComposerAttachment,
        ]);
        const sessionAttachmentRowItems = React.useMemo(() => (
            projectAgentInputAttachmentRowItems({
                items: [
                    ...(pendingComposerDocument ? [] : sessionExtraActionPresentation.attachmentRowItems),
                    ...composerAttachmentRowItems,
                ],
                transferAttachments: attachmentsUploadsEnabled && !pendingComposerDocument ? agentInputAttachments : undefined,
            })
        ), [
            agentInputAttachments,
            attachmentsUploadsEnabled,
            composerAttachmentRowItems,
            pendingComposerDocument,
            sessionExtraActionPresentation.attachmentRowItems,
        ]);
        const openComposerPluginAction = React.useCallback((action: PluginContributedActionDescriptor) => {
            return openSessionComposerContributedAction({
                controller: composerPluginActionController,
                action,
                signal: composerPluginActionScopeSignal,
            });
        }, [composerPluginActionController, composerPluginActionScopeSignal, openSessionComposerContributedAction]);
        const composerPluginActionChips = composerPluginPresentation.extraActionChips;
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
            connectedAccounts: currentSessionAgentCatalogEntry?.connectedAccounts ?? [],
            sessionMetadata: ownerMetadata,
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
        const sessionStatusResuming = sessionStatus.state === 'resuming';
        const connectionStatus = React.useMemo(() => resolveSessionViewConnectionStatus({
            connectedServicesRestartState,
            restartingText: t('connectedServices.authSwitch.status.restarting'),
            switchFailedText: t('connectedServices.authSwitch.switchFailed'),
            inactiveStatusText,
            sessionStatusResuming,
            sessionStatusText: sessionStatus.statusText,
            sessionStatusColor: sessionStatus.statusColor,
            sessionStatusDotColor: sessionStatus.statusDotColor,
            sessionStatusPulsing: sessionStatus.isPulsing === true,
        }), [
            connectedServicesRestartState,
            inactiveStatusText,
            sessionStatus.isPulsing,
            sessionStatus.statusColor,
            sessionStatus.statusDotColor,
            sessionStatusResuming,
            sessionStatus.statusText,
        ]);
        const openSessionModelPicker = React.useCallback(() => {
            setSessionModelPickerRequestKey((current) => String((Number.parseInt(current ?? '0', 10) || 0) + 1));
        }, []);
        const providerBindingBanner = React.useMemo(() => {
            const requestedProviderGroup = effectiveModelTransitionActionRequired?.requestedSelection.providerConnectionId
                ? providerModelProjection.data?.groups.find(
                    (group) => group.connectionId
                        === effectiveModelTransitionActionRequired.requestedSelection.providerConnectionId,
                ) ?? null
                : null;
            const transitionBanner = effectiveModelTransitionActionRequired
                ? {
                    kind: 'changed' as const,
                    action: 'restart' as const,
                    providerName: requestedProviderGroup?.providerName
                        ?? providerLaunchBinding?.displaySnapshot.providerName
                        ?? agentId
                        ?? effectiveModelTransitionActionRequired.requestedSelection.agentTargetKey,
                    connectionName: requestedProviderGroup?.connectionName
                        ?? providerLaunchBinding?.displaySnapshot.connectionName
                        ?? effectiveModelTransitionActionRequired.requestedSelection.modelId,
                }
                : null;
            const banner = transitionBanner
                ?? providerBindingPresentation?.banner
                ?? pendingProviderSwitchBanner;
            if (!banner) return null;
            const params = { provider: banner.providerName, connection: banner.connectionName };
            switch (banner.kind) {
                case 'changed':
                    return {
                        ...banner,
                        title: t('session.providerBinding.changedTitle'),
                        body: t('session.providerBinding.changedBody', params),
                        actionLabel: t('session.providerBinding.restartAction'),
                    };
                case 'unavailable':
                    return {
                        ...banner,
                        title: t('session.providerBinding.unavailableTitle'),
                        body: t('session.providerBinding.unavailableBody', params),
                        actionLabel: t('session.providerBinding.chooseModelAction'),
                    };
                case 'disabled':
                    return {
                        ...banner,
                        title: t('session.providerBinding.disabledTitle'),
                        body: t('session.providerBinding.disabledBody', params),
                        actionLabel: t('session.providerBinding.chooseModelAction'),
                    };
                case 'incompatible':
                    return {
                        ...banner,
                        title: t('session.providerBinding.incompatibleTitle'),
                        body: t('session.providerBinding.incompatibleBody', params),
                        actionLabel: t('session.providerBinding.chooseModelAction'),
                    };
                case 'status-error':
                    return {
                        ...banner,
                        title: t('settingsProviders.errors.unreachableTitle'),
                        body: t('settingsProviders.errors.unreachableDescription'),
                        actionLabel: t('settingsProviders.errors.actions.retry'),
                    };
            }
        }, [
            agentId,
            effectiveModelTransitionActionRequired,
            pendingProviderSwitchBanner,
            providerBindingPresentation?.banner,
            providerLaunchBinding?.displaySnapshot.connectionName,
            providerLaunchBinding?.displaySnapshot.providerName,
            providerModelProjection.data?.groups,
        ]);
        const handleProviderBindingAction = React.useCallback(async () => {
            if (!providerBindingBanner) return;
            if (providerBindingBanner.action === 'retry') {
                await providerBindingStatus.refresh();
                return;
            }
            if (providerBindingBanner.action === 'choose-model') {
                openSessionModelPicker();
                return;
            }
            if (!hasWriteAccess) {
                Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                return;
            }
            const restartMachineId = typeof staleSessionRunnerMachineId === 'string'
                ? staleSessionRunnerMachineId.trim()
                : '';
            const cachedRuntimeStatus = sessionRunnerRuntimeStatus
                && sessionRunnerRuntimeStatus.serverId === sessionRouteServerId
                && sessionRunnerRuntimeStatus.sessionId === sessionId
                && sessionRunnerRuntimeStatus.machineId === restartMachineId
                ? sessionRunnerRuntimeStatus
                : null;
            const runtimeStatus = cachedRuntimeStatus
                ?? (
                    restartMachineId
                        ? await getSessionRunnerRuntimeStatusSnapshot({
                            sessionId,
                            machineId: restartMachineId,
                            serverId: sessionRouteServerId,
                        })
                        : null
                );
            if (!runtimeStatus) {
                if (effectiveModelTransitionActionRequired) {
                    Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
                } else {
                    openSessionModelPicker();
                }
                return;
            }
            const exactBindingChange = providerBindingStatus.status?.status === 'changed'
                ? providerBindingStatus.status
                : null;
            const result = await restartSessionRunnerForProviderBindingChange({
                runtimeState: SessionRunnerRuntimeStateV1Schema.parse(runtimeStatus.state),
                runnerProcessIdentity: runtimeStatus.runnerProcessIdentity,
                serverId: sessionRouteServerId,
                ...(exactBindingChange && providerLaunchBinding ? {
                    launchBinding: providerLaunchBinding,
                    nextBindingSecurityFingerprint: exactBindingChange.nextBindingSecurityFingerprint,
                } : {}),
            });
            if (result.status === 'restarted') {
                setModelTransitionActionRequired(null);
            } else {
                Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
            }
        }, [
            hasWriteAccess,
            effectiveModelTransitionActionRequired,
            openSessionModelPicker,
            providerBindingBanner,
            providerBindingStatus.status,
            providerBindingStatus.refresh,
            providerLaunchBinding,
            sessionRouteServerId,
            sessionRunnerRuntimeStatus,
            sessionId,
            staleSessionRunnerMachineId,
        ]);
        const agentInputStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => [
            ...sessionStatusBadges,
            ...sessionConnectedServicesAuthSwitch.statusBadges,
            ...(draftConflictBanner.statusBadge ? [draftConflictBanner.statusBadge] : []),
            ...(providerLaunchBinding && providerBindingPresentation
                ? [{
                    key: 'provider-binding',
                    label: providerBindingLaunchLabel ?? providerBindingPresentation.launchLabel,
                    accessibilityLabel: providerBindingLaunchLabel ?? providerBindingPresentation.launchLabel,
                    testID: 'session.providerBinding.badge',
                    tone: providerBindingPresentation.banner ? 'warning' as const : 'neutral' as const,
                    emphasis: providerBindingPresentation.banner ? 'prominent' as const : 'quiet' as const,
                    icon: (tint: string) => <Icon name="cube" size={14} color={tint} />,
                    // With a banner present the badge is that banner's show/hide affordance; with no
                    // banner there is nothing to collapse, so the chip keeps its model-picker action.
                    ...(providerBindingPresentation.banner
                        ? {
                            ...buildComposerBannerBadgeAccessibility({
                                statusLabel: providerBindingLaunchLabel ?? providerBindingPresentation.launchLabel,
                                collapsed: providerBindingBannerCollapse.collapsed,
                                expandHint: t('session.composerBanners.showBannerAction'),
                                collapseHint: t('session.composerBanners.hideBannerAction'),
                            }),
                            onPress: providerBindingBannerCollapse.toggle,
                        }
                        : { onPress: openSessionModelPicker }),
                } satisfies AgentInputStatusBadge]
                : []),
            ...(authSurfaceState
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
                : []),
            ...(pendingQueueResumeFailed
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
                : []),
            ...(armedContinuationNotice
                ? [{
                    key: 'session-agentTransition-outcome',
                    testID: 'session.agentTransitionOutcome.badge',
                    label: t('session.agentContinuation.transition.badgeLabel'),
                    tone: armedContinuationNotice.tone === 'warning' ? 'warning' : 'neutral',
                    ...buildComposerBannerBadgeAccessibility({
                        // Collapsing demotes the banner to this badge, so the badge
                        // has to carry the whole sentence to assistive tech.
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
                : []),
            ...(externalTranscriptAuthority?.kind === 'server_snapshot'
                ? [{
                    key: 'session-externalTranscript-snapshot',
                    testID: 'session.externalTranscript.snapshot.badge',
                    label: t('externalSessions.sharingUpdateSharedCopy'),
                    tone: 'neutral',
                    emphasis: 'quiet',
                    ...buildComposerBannerBadgeAccessibility({
                        statusLabel: t('externalSessions.sharingUpdateSharedCopy'),
                        collapsed: externalTranscriptSnapshotBanner.collapsed,
                        expandHint: t('session.composerBanners.showBannerAction'),
                        collapseHint: t('session.composerBanners.hideBannerAction'),
                    }),
                    icon: (tint: string) => <Icon name="cloud-arrow-down" size={14} color={tint} />,
                    onPress: externalTranscriptSnapshotBanner.toggle,
                } satisfies AgentInputStatusBadge]
                : []),
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
            agentTransitionOutcomeBanner.collapsed,
            agentTransitionOutcomeBanner.toggle,
            armedContinuationNotice,
            authRecoveryBanner.collapsed,
            authRecoveryBanner.toggle,
            authSurfaceState,
            cancelPendingMessageEdit,
            draftConflictBanner.statusBadge,
            externalTranscriptAuthority?.kind,
            externalTranscriptSnapshotBanner.collapsed,
            externalTranscriptSnapshotBanner.toggle,
            pendingMessageEdit,
            pendingQueueResumeFailed,
            pendingQueueResumeFailedBanner.collapsed,
            pendingQueueResumeFailedBanner.toggle,
            openSessionModelPicker,
            providerBindingBannerCollapse.collapsed,
            providerBindingBannerCollapse.toggle,
            providerBindingPresentation,
            providerBindingLaunchLabel,
            providerLaunchBinding,
            sessionConnectedServicesAuthSwitch.statusBadges,
            sessionStatusBadges,
            t,
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
        // Memoized so the chips prop keeps a stable identity across SessionView
        // re-renders (each combine call allocates a fresh array); an unstable
        // array would defeat AgentInput's memo on every turn-state commit (R1).
        const agentInputExtraActionChips = React.useMemo(
            () => combineSessionViewExtraActionChips(
                combineSessionViewExtraActionChips(
                    combineSessionViewExtraActionChips(
                        combineSessionViewExtraActionChips(
                            sessionExtraActionPresentation.actionChips,
                            sessionGoalActionChips,
                        ),
                        composerPluginActionChips,
                    ),
                    sessionConnectedServicesAuthSwitch.connectedServicesAuthChip
                        ? [sessionConnectedServicesAuthSwitch.connectedServicesAuthChip]
                        : undefined,
                ),
                routingControls.extraActionChips,
            ),
            [
                sessionExtraActionPresentation.actionChips,
                sessionGoalActionChips,
                composerPluginActionChips,
                sessionConnectedServicesAuthSwitch.connectedServicesAuthChip,
                routingControls.extraActionChips,
            ],
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

    const getAutocompleteSuggestions = React.useCallback(
        (query: string, signal: AbortSignal, onUpdate: AutocompleteSuggestionUpdate) => resolveSessionComposerSuggestions(sessionId, query, {
            kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
            signal,
            composerReferenceHost,
            contributedActions: composerPluginActionController.listSlashCommands(),
            onUpdate,
        }),
        [composerPluginActionController, composerReferenceHost, sessionId],
    );

    // Stable identities for the memoized AgentInput (R1 churn fix). SessionView
    // re-renders on every turn-state commit; inline callback props would defeat
    // AgentInput's React.memo and re-execute the 3k-line composer body each time.
    // The send handler closes over a lot of per-render state, so a ref is pointed
    // at the freshest closure (refreshed in render, just below) and AgentInput is
    // handed a permanently stable wrapper that forwards to it.
    const agentInputSendRef = React.useRef<(options?: AgentInputSendOptions) => void>(() => {});
    const handleAgentInputSend = React.useCallback(
        (options?: AgentInputSendOptions) => { agentInputSendRef.current(options); },
        [],
    );
    const handleAgentInputAbort = useEventCallback(() => sessionAbort(sessionId));

    const input = shouldShowInput ? (
        <PluginContextualResourceStoreProvider>
            <View>
            {/*
              * Feature gate and hidden-system-session exclusion only. Which
              * provider the surface presents — and whether it presents at all —
              * belongs to `resolveVoicePresentedProviderId`, which follows the
              * RUNNING attempt rather than the configured next-start provider.
              * Re-deriving that here from the configured provider unmounted a
              * live attempt's transport the moment the user selected Off.
              */}
            {voiceEnabled && !isHiddenSystemSessionSession ? (
                <VoiceSurface variant="session" sessionId={sessionId} isPresented={surfacePresented} />
            ) : null}
            {authSurfaceState && !authRecoveryBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                </ComposerAuxiliaryFrame>
            ) : null}
            {pendingQueueResumeFailed && !pendingQueueResumeFailedBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-pendingQueue-resumeFailed"
                        actionTestID="session-pendingQueue-resumeFailed-retry"
                        title={t('session.pendingQueuedResumeFailedTitle')}
                        body={t('session.pendingQueuedResumeFailedBody')}
                        actionLabel={pendingQueueResumeActionLabel}
                        actionAccessibilityLabel={pendingQueueResumeActionLabel}
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
            {armedContinuationNotice && !agentTransitionOutcomeBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
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
                                onActionPress: handleArmedContinuationResume,
                            }
                            : {})}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {providerBindingBanner && !providerBindingBannerCollapse.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session.providerBinding.banner"
                        actionTestID="session.providerBinding.action"
                        title={providerBindingBanner.title}
                        body={providerBindingBanner.body}
                        actionLabel={providerBindingBanner.actionLabel}
                        actionAccessibilityLabel={providerBindingBanner.actionLabel}
                        disabled={providerBindingBanner.action === 'restart' && (!hasWriteAccess || isRuntimeFreshActiveTurn)}
                        onActionPress={handleProviderBindingAction}
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
                        actionBusy={visibleStaleSessionRunnerPresentation.banner.actionBusy}
                        disabled={visibleStaleSessionRunnerPresentation.banner.disabled || !hasWriteAccess}
                        onActionPress={handleStaleSessionRunnerRestart}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {externalTranscriptAuthority?.kind === 'server_snapshot' && !externalTranscriptSnapshotBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session.externalTranscript.snapshot"
                        tone="neutral"
                        title={t('externalSessions.sharingSnapshotFrom', {
                            time: formatShortRelativeTimeAt(
                                externalTranscriptAuthority.materializedThroughSourceAt,
                                externalTranscriptPresentationNowMs,
                            ),
                        })}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            <CurrentSessionPresentationSurface
                session={session}
                placement="beforeComposer"
                composerRegions={composerPluginPresentation.composerRegions}
                renderComposerRegion={composerPluginPresentation.renderComposerRegion}
            />
            {activeServerAccountScope
                && currentSessionDraftSnapshot?.conflict
                && !draftConflictBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionDraftConflictResolution
                        scope={activeServerAccountScope}
                        address={sessionDraftAddress}
                        conflict={currentSessionDraftSnapshot.conflict}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            <AgentInput
                placeholder={isReadOnly
                    ? t('session.sharing.viewOnlyMode')
                    : externalSessionOperationShell.composerPlaceholderKey
                        ? t(externalSessionOperationShell.composerPlaceholderKey)
                        : t('session.inputPlaceholder')}
                value={visibleComposerText}
                onChangeText={setVisibleComposerDraftValue}
                onComposerFocusChange={onComposerFocusChange}
                onComposerFocusRequestChange={onComposerFocusRequestChange}
                onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
                composerDecorations={composerInputEffects.composerDecorations}
                composerInputLock={composerInputEffects.composerInputLock}
                sessionId={sessionId}
                surfacePresented={surfacePresented}
                contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET}
                agentType={agentInputAgentType ?? undefined}
                agentLabel={agentInputAgentType ? resolveSessionActionDefaultBackendTitle({
                    session,
                    sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
                }) || undefined : undefined}
                armedContinuationTarget={armedContinuationTarget}
                composeAgentPickerOptions={inSessionAgentPicker.composeAgentPickerOptions}
                onAgentPickerIntent={inSessionAgentPicker.onAgentPickerIntent}
                onAgentPickerVisibilityChange={inSessionAgentPicker.onAgentPickerVisibilityChange}
                agentPickerSelectedOptionId={inSessionAgentPicker.agentPickerSelectedOptionId}
                onAttachmentsAdded={attachmentsUploadsEnabled && !pendingComposerDocument ? addAttachments : undefined}
                hasSendableAttachments={
                    (!pendingComposerDocument && hasIncludedReviewCommentDrafts)
                    || (!pendingComposerDocument && attachmentsUploadsEnabled && attachmentDrafts.length > 0)
                    || composerAttachmentViews.some((attachment) => attachment.availability.status === 'ready')
                }
                permissionRequests={pendingPermissionRequests}
                approvalRequests={approvalRequests}
                canApprovePermissions={transcriptInteraction.canApprovePermissions}
                permissionDisabledReason={transcriptInteraction.permissionDisabledReason}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                onAcpSessionModeChange={sessionModeOptionIds.length > 0 ? updateAcpSessionModeOverride : undefined}
                onAcpConfigOptionChange={updateAcpConfigOptionOverride}
                modelMode={modelMode}
                sessionActive={isSessionActive}
                agentTargetKey={providerAgentTargetKey}
                currentRunnerProcessIdentity={currentRunnerProcessIdentity}
                onModelModeChange={updateModelMode}
                modelContentOverride={existingSessionModelPicker}
                openModelPickerRequestKey={sessionModelPickerRequestKey}
                metadata={ownerMetadata}
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
                // Stable wrapper (handleAgentInputSend) so AgentInput's memo holds;
                // the assignment refreshes the latest-send ref with this render's
                // closure, then the expression evaluates to the stable wrapper (R1).
                onSend={(agentInputSendRef.current = (sendOptions) => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }
                    if (externalSessionOperationShell.blocksNewOperation) return;

                    fireAndForget(runWithSessionComposerAdmissionReservation(async () => {
                    const activePendingEdit = pendingMessageEditRef.current;
                    const composerMessage = activePendingEdit?.document.text
                        ?? sendOptions?.inputTextOverride
                        ?? readLatestDraftValue();
                    if (activePendingEdit) {
                        const pendingComposerSnapshot = readPendingMessageComposerSnapshot(activePendingEdit);
                        setIsComposerSending(true);
                        try {
                                let acceptedReplacementLocalId: string | null = null;
                                let acceptedPreparedAttachments: readonly ComposerAttachmentInputV1[] | null = null;
                                let postAcceptanceError: unknown = null;
                                const result = await submitComposerSnapshot({
                                    snapshot: pendingComposerSnapshot,
                                    route: {
                                        kind: 'pendingMessage',
                                        ref: {
                                            kind: 'pendingMessage',
                                            sessionId,
                                            localId: activePendingEdit.localId,
                                        },
                                        readCurrentExecutionTarget: () => (
                                            composerPluginActionScopeSignal.aborted
                                                ? null
                                                : { serverId: sessionRouteServerId, machineId }
                                        ),
                                        admit: async (snapshot) => {
                                            const isStructuredInputCurrent = (): boolean => {
                                                const currentEdit = pendingMessageEditRef.current;
                                                return currentEdit !== null
                                                    && currentEdit.pendingId === activePendingEdit.pendingId
                                                    && currentEdit.localId === activePendingEdit.localId
                                                    && isPendingMessageEditAccountCurrent(activePendingEdit)
                                                    && isPendingMessageComposerSubmissionSnapshotCurrent(currentEdit, snapshot);
                                            };
                                            if (snapshot.ref.kind !== 'pendingMessage' || !isStructuredInputCurrent()) {
                                                return { status: 'rejected' };
                                            }
                                            const candidate = preparePendingComposerAdmissionCandidate(
                                                activePendingEdit,
                                                snapshot,
                                            );
                                            if (!isStructuredInputCurrent()) {
                                                return { status: 'rejected' };
                                            }
                                            const rawStructuredInput = RawIngressStructuredInputV1Schema.parse({
                                                v: 1,
                                                mentions: snapshot.references,
                                                composerAttachments: candidate.attachments,
                                            });
                                            const prepared = await preparePendingMessageComposerAdmission(sessionId, {
                                                localId: candidate.localId,
                                                text: snapshot.text,
                                                structuredInput: rawStructuredInput,
                                            }, {
                                                serverId: sessionRouteServerId,
                                                signal: composerPluginActionScopeSignal,
                                            });
                                            if (!prepared.ok || !isStructuredInputCurrent()) {
                                                return { status: 'rejected' };
                                            }
                                            const acceptedComposerAdmission = await sync.updatePendingMessage(
                                                sessionId,
                                                activePendingEdit.pendingId,
                                                prepared.text,
                                                prepared.structuredInput,
                                                {
                                                    ...(candidate.replacementLocalId
                                                        ? { replacementLocalId: candidate.replacementLocalId }
                                                        : {}),
                                                    preparedComposerAdmission: {
                                                        stagedMediaHandles: prepared.stagedMediaHandles ?? [],
                                                    },
                                                },
                                            );
                                            if (!acceptedComposerAdmission) {
                                                throw new Error('Pending Composer PATCH accepted without its canonical admission fact');
                                            }
                                            acceptedReplacementLocalId = acceptedComposerAdmission.localId === activePendingEdit.localId
                                                ? null
                                                : acceptedComposerAdmission.localId;
                                            acceptedPreparedAttachments = acceptedComposerAdmission.structuredInput.composerAttachments ?? [];
                                            try {
                                                await acceptPendingMessageComposerAdmission(sessionId, acceptedComposerAdmission, {
                                                    serverId: sessionRouteServerId,
                                                });
                                            } catch (error) {
                                                // The Pending PATCH is already authoritative. Keep
                                                // the accepted outcome while surfacing settlement/
                                                // notification failure to the user below.
                                                postAcceptanceError = error;
                                            }
                                            return { status: 'accepted' };
                                        },
                                    },
                                    clearAcceptedSnapshot: (snapshot) => {
                                        const currentEdit = pendingMessageEditRef.current;
                                        if (!currentEdit || currentEdit.pendingId !== activePendingEdit.pendingId) return false;
                                        if (isPendingMessageComposerSubmissionSnapshotCurrent(currentEdit, snapshot)) {
                                            pendingMessageEditRef.current = null;
                                            pendingComposerDocumentOwnerRef.current = null;
                                            setPendingMessageEdit(null);
                                            clearPendingMessageEditDrainHold(currentEdit.holdId);
                                            return true;
                                        }
                                        if (acceptedReplacementLocalId && acceptedPreparedAttachments) {
                                            // The successor row is a new document owner, so the
                                            // edit state publishes ITS canonical snapshot; carrying
                                            // the retired owner's revision across would make the
                                            // presentation revision, the submission currentness
                                            // compare and the owner's own CAS disagree.
                                            const successor = derivePendingMessageComposerSuccessorEditState({
                                                current: currentEdit,
                                                sessionId,
                                                successorLocalId: acceptedReplacementLocalId,
                                                admitted: {
                                                    text: snapshot.text,
                                                    mentions: composerStructuredMentionsFromReferences({
                                                        references: snapshot.references,
                                                        existing: currentEdit.admittedDocument.mentions,
                                                    }),
                                                    attachments: acceptedPreparedAttachments,
                                                },
                                                readMountedEditLocalId: () => pendingMessageEditRef.current?.localId ?? null,
                                            });
                                            const nextEdit = successor.edit;
                                            pendingComposerDocumentOwnerRef.current = successor.owner;
                                            pendingMessageEditRef.current = nextEdit;
                                            setPendingMessageEdit(nextEdit);
                                            notifyComposerPresentationTargetChanged({
                                                kind: 'pendingMessage',
                                                sessionId,
                                                localId: nextEdit.localId,
                                            });
                                        }
                                        return false;
                                    },
                                });
                                if (result.status === 'blocked') {
                                    Modal.alert(
                                        t('common.error'),
                                        result.reason === 'mediaContentUnavailable'
                                            ? t('common.unavailable')
                                            : tLoose('session.pendingMessages.errors.editStructuredInputUnsupported'),
                                    );
                                } else if (result.status === 'rejected') {
                                    Modal.alert(t('common.error'), t('session.pendingMessages.errors.updateFailed'));
                                } else if (postAcceptanceError) {
                                    Modal.alert(
                                        t('common.error'),
                                        postAcceptanceError instanceof Error
                                            ? postAcceptanceError.message
                                            : t('session.pendingMessages.errors.updateFailed'),
                                    );
                                }
                        } catch (e) {
                            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.updateFailed'));
                        } finally {
                            setIsComposerSending(false);
                        }
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
                        // Capture all semantic fields before an asynchronous send-choice prompt.
                        // The canonical draft owner later clears only this exact value/revision snapshot.
                        const semanticDraftSnapshot = captureComposerSemanticDraftCurrentnessSnapshot();
                        const composerSubmissionSnapshot = readSessionComposerSubmissionSnapshot(composerTextBeforeSend);
                        const composerAttachmentsForSubmit = semanticDraftSnapshot.values['structuredInput.composerAttachments'] ?? [];
                        const hasComposerAttachments = composerAttachmentsForSubmit.length > 0;
                        const shouldUseComposerSubmissionCoordinator = (
                            composerSubmissionSnapshot.text.trim().length > 0
                            || composerSubmissionSnapshot.references.length > 0
                            || composerSubmissionSnapshot.attachments.length > 0
                        );
                        const buildDetachedComposerSubmissionMetaOverrides = (
                            snapshot: ComposerSubmissionSnapshot,
                        ): Record<string, unknown> | undefined => {
                            const snapshotMetaOverrides = buildStructuredInputMetaOverrides({
                                mentions: composerStructuredMentionsFromReferences({
                                    references: snapshot.references,
                                    existing: semanticDraftSnapshot.values['structuredInput.mentions'] ?? [],
                                }),
                                text: snapshot.text,
                                ...(snapshot.attachments.length > 0
                                    ? { composerAttachments: snapshot.attachments.map(composerAttachmentViewToDraft) }
                                    : {}),
                            });
                            const {
                                // The exact document snapshot owns generic references and attachments.
                                // Do not retain an AgentInput envelope captured from a newer live edit.
                                happierStructuredInputV1: _liveComposerSemanticMeta,
                                ...preservedSendIntentMetaOverrides
                            } = sendIntent?.structuredInputMetaOverrides ?? {};
                            return mergeMessageMetaOverrides(
                                Object.keys(preservedSendIntentMetaOverrides).length > 0
                                    ? preservedSendIntentMetaOverrides
                                    : undefined,
                                Object.keys(snapshotMetaOverrides).length > 0 ? snapshotMetaOverrides : undefined,
                            );
                        };
                        const structuredInputMetaOverrides = shouldUseComposerSubmissionCoordinator
                            ? buildDetachedComposerSubmissionMetaOverrides(composerSubmissionSnapshot)
                            : mergeMessageMetaOverrides(
                                sendIntent?.structuredInputMetaOverrides,
                                hasComposerAttachments
                                    ? buildStructuredInputMetaOverrides({ composerAttachments: composerAttachmentsForSubmit })
                                    : undefined,
                            );

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
                            structuredInputMetaOverrides: structuredInputMetaOverrides ?? null,
                            agentTargetKey: providerAgentTargetKey,
                            currentRunnerProcessIdentity,
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

                        if (
                            outboundBase.kind === 'plain'
                            && trimmedText.length === 0
                            && !hasAttachments
                            && !hasComposerAttachments
                        ) {
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
                        let semanticDraftSnapshotForFailedHandoffRestore = semanticDraftSnapshot;
                        let semanticDraftSnapshotAfterHandoffClear: ComposerSemanticDraftCurrentnessSnapshot | null = null;
                        let semanticDraftFieldsClearedAtHandoff: readonly SessionDraftValueFieldId[] = [];
                        const transientInputStateHandoff = captureComposerTransientInputStateForOutboundHandoff({
                            captureTransientInputState: inputComposerPersistence.captureTransientInputState,
                            clearTransientInputState: inputComposerPersistence.clearTransientInputState,
                            restoreTransientInputState: inputComposerPersistence.restoreTransientInputState,
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
                        const clearAfterOutboundHandoff = (
                            currentness?: ComposerSubmissionFieldCurrentness,
                        ) => {
                            // Composer admission ends at the durable outbound handoff. Runtime
                            // wake and provider delivery continue through their canonical session/Pending
                            // projections and must not keep the submit button in a local sending state.
                            setIsComposerSending(false);
                            const mentionsBeforeClear = currentness
                                ? existingSessionComposerOwner.read().document.structuredInputMentions
                                : undefined;
                            let didClear = clearComposerAfterOutboundHandoff({
                                snapshot: sendSnapshot,
                                clearDraftForSessionIfCurrentValueMatches,
                                clearTransientInputState: transientInputStateHandoff.clearTransientInputState,
                                clearSemanticDraftValuesMatchingSnapshot: () => {
                                    semanticDraftFieldsClearedAtHandoff = clearSemanticDraftValuesAfterOutboundHandoff(
                                        semanticDraftSnapshot,
                                    );
                                    return semanticDraftFieldsClearedAtHandoff.length > 0;
                                },
                            });
                            if (currentness) {
                                const reconciledMentions = composerStructuredMentionsFromReferences({
                                    references: currentness.reconciledReferences,
                                    existing: mentionsBeforeClear ?? [],
                                });
                                const currentOwnerSnapshot = existingSessionComposerOwner.read();
                                const currentMentions = currentOwnerSnapshot.document.structuredInputMentions;
                                if (!sameStrictJsonValue(currentMentions, reconciledMentions)) {
                                    semanticDraftSnapshotForFailedHandoffRestore = {
                                        ...semanticDraftSnapshot,
                                        values: {
                                            ...semanticDraftSnapshot.values,
                                            'structuredInput.mentions': mentionsBeforeClear,
                                        },
                                    };
                                    existingSessionComposerOwner.apply(currentOwnerSnapshot.revision, {
                                        text: currentOwnerSnapshot.document.text,
                                        references: [...composerReferencesFromStructuredMentions({
                                            text: currentOwnerSnapshot.document.text,
                                            mentions: reconciledMentions,
                                        })],
                                        attachments: currentOwnerSnapshot.document.composerAttachments
                                            .map((attachment) => composerAttachmentDraftToView(attachment, {
                                                entriesById: composerAttachmentAvailabilityEntriesById,
                                            })),
                                    });
                                    if (!semanticDraftFieldsClearedAtHandoff.includes('structuredInput.mentions')) {
                                        semanticDraftFieldsClearedAtHandoff = [
                                            ...semanticDraftFieldsClearedAtHandoff,
                                            'structuredInput.mentions',
                                        ];
                                    }
                                    didClear = true;
                                }
                            }
                            if (didClear) {
                                semanticDraftSnapshotAfterHandoffClear = captureComposerSemanticDraftCurrentnessSnapshot();
                            }
                            didClearAtOutboundHandoff = didClearAtOutboundHandoff || didClear;
                            return didClear;
                        };
                        const startSessionComposerAdmission = (
                            admit: (
                                snapshot: ComposerSubmissionSnapshot,
                                handoff: ComposerSubmissionAdmissionHandoff,
                            ) => Promise<ComposerSubmissionAdmissionOutcome>,
                        ) => {
                            const directHandoff: ComposerSubmissionAdmissionHandoff = {
                                accept: clearAfterOutboundHandoff,
                            };
                            if (!shouldUseComposerSubmissionCoordinator) {
                                return admit(composerSubmissionSnapshot, directHandoff);
                            }
                            return submitComposerSnapshot({
                                snapshot: composerSubmissionSnapshot,
                                route: {
                                    kind: 'session',
                                    ref: { kind: 'session', sessionId },
                                    readCurrentExecutionTarget: () => (
                                        composerPluginActionScopeSignal.aborted
                                            ? null
                                            : { serverId: sessionRouteServerId, machineId }
                                    ),
                                    admit,
                                },
                                clearAcceptedSnapshot: (acceptedSnapshot) => {
                                    if (
                                        acceptedSnapshot.ref.kind !== 'session'
                                        || acceptedSnapshot.ref.sessionId !== sessionId
                                        || acceptedSnapshot.revision !== composerSubmissionSnapshot.revision
                                        || acceptedSnapshot.text !== composerSubmissionSnapshot.text
                                        || !sameStrictJsonValue(acceptedSnapshot.references, composerSubmissionSnapshot.references)
                                        || !sameComposerAttachmentViews(acceptedSnapshot.attachments, composerSubmissionSnapshot.attachments)
                                    ) {
                                        return false;
                                    }
                                    const currentness = readComposerSubmissionFieldCurrentness(
                                        readSessionComposerSubmissionSnapshot(
                                            readLatestDraftValue(),
                                        ),
                                        acceptedSnapshot,
                                    );
                                    if (!currentness) return false;
                                    return clearAfterOutboundHandoff(currentness);
                                },
                            });
                        };
                        const presentBlockedSessionComposerSubmission = (
                            result: ComposerSubmissionAdmissionOutcome | ComposerSubmissionResult,
                        ): void => {
                            if (
                                result.status === 'blocked'
                                && (result.reason === 'attachmentUnavailable' || result.reason === 'mediaContentUnavailable')
                            ) {
                                Modal.alert(t('common.error'), t('common.unavailable'));
                            }
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
                                isCanonicalOutboundHandoffPresent: () => hasCanonicalOutboundHandoffForLocalId(
                                    sessionId,
                                    outboundHandoffLocalId,
                                ),
                                restoreDraftForSessionIfCurrentValueMatches,
                                restoreTransientInputState: transientInputStateHandoff.restoreTransientInputState,
                                restoreSemanticDraftValuesMatchingClearedSnapshot: () => {
                                    if (!semanticDraftSnapshotAfterHandoffClear) return false;
                                    return restoreSemanticDraftValuesFromSnapshot({
                                        snapshot: semanticDraftSnapshotForFailedHandoffRestore,
                                        clearedSnapshot: semanticDraftSnapshotAfterHandoffClear,
                                        clearedFieldIds: semanticDraftFieldsClearedAtHandoff,
                                    }).length > 0;
                                },
                            });
                            if (didRestore && attachmentDraftsForRestore) {
                                restoreAttachmentDraftsFromSnapshot(attachmentDraftsForRestore);
                            }
                            return didRestore;
                        };

                        // Destination selection for a true send (section 3.3).
                        //
                        // An ordinary send reaches `submitSessionUserMessage`, the
                        // canonical message owner, and the Session keeps the Agent it
                        // has. When the in-session picker armed another Agent, the very
                        // same submission goes through `session.agentTransition`
                        // instead, which stops the source runtime, commits the target,
                        // and admits this exact localId through that same message owner
                        // on the far side of the cutover. They are alternatives: an
                        // armed send must never quietly reach the current Agent, which
                        // is precisely the failure this decision exists to remove.
                        //
                        // The decision itself lives in
                        // `resolveSessionComposerSendDestination` rather than inline
                        // here, because inline is exactly where it was missing for the
                        // whole program with no test able to see it. This screen keeps
                        // only the routing facts each existing resolver already owns.
                        //
                        // The armed value is produced only behind the
                        // `sessions.agentSwitching` gate, so this inherits that decision
                        // rather than re-deriving it.
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
                        ): ComposerSubmissionAdmissionOutcome => {
                            // A refusal is a rejection before any effect: the draft and
                            // the armed row both survive, and the ordinary send is the
                            // retry once the reader has resolved the conflict. It reaches
                            // the same composer banner as every other outcome instead of
                            // a modal the reader has to dismiss before they can act on it.
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
                            }
                            // `unreconciledTransitionOutcome` is the banner already on
                            // screen saying the previous outcome is unestablished.
                            // Overwriting it would replace a live fact with a
                            // restatement — but a refused send has to be visible, so a
                            // collapsed banner is re-expanded through the same collapse
                            // owner rather than given a second announcement channel.
                            if (
                                refused.reason === 'unreconciledTransitionOutcome'
                                && agentTransitionOutcomeBanner.collapsed
                            ) {
                                agentTransitionOutcomeBanner.toggle();
                            }
                            return { status: 'rejected' };
                        };
                        const dispatchArmedContinuation = async (
                            destination: Extract<
                                SessionComposerSendDestination,
                                { kind: 'armedAgentContinuation' }
                            >,
                            outboundForTransition: Readonly<{
                                text: string;
                                displayText?: string;
                                metaOverrides?: Record<string, unknown>;
                            }>,
                            onAdmitted: () => void,
                        ): Promise<ComposerSubmissionAdmissionOutcome> => {
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
                            // The arm owns this input before the RPC is allowed to
                            // leave the process. A remount can therefore retry the
                            // same logical transition under its original localId,
                            // and compare-clear only these exact composer values if
                            // canonical custody appears later.
                            const existingSubmission = inSessionAgentPicker.armedContinuationSubmission;
                            const transitionInput = existingSubmission?.localId === destination.localId
                                ? existingSubmission.input
                                : buildArmedAgentContinuationTransitionInput(transitionSubmission);
                            if (!inSessionAgentPicker.recordArmedContinuationSubmission({
                                localId: destination.localId,
                                input: transitionInput,
                                currentness: {
                                    text: submittedComposerText,
                                    mentions: semanticDraftSnapshot.values['structuredInput.mentions'] ?? [],
                                    composerAttachments: semanticDraftSnapshot.values['structuredInput.composerAttachments'] ?? [],
                                    attachmentDraftIds: hasAttachments
                                        ? attachmentDrafts.map((draft) => draft.id)
                                        : [],
                                },
                            })) {
                                return { status: 'rejected' };
                            }
                            // A matching localId is not content protection: the
                            // server may reconcile it onto a later payload. A
                            // retry therefore dispatches the first exact nested
                            // input rather than an edited composer projection.
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
                            // The armed row is dropped only once it stops being a
                            // truthful promise about the next message.
                            // Where canonical admission also clears the draft, keep
                            // the nested snapshot through the next effect so the one
                            // compare-clear owner can consume it before the arm goes.
                            if (disposition.arm === 'clear' && disposition.draft !== 'clear') {
                                inSessionAgentPicker.clearArmedContinuation();
                            }
                            // The outcome itself is recorded, not its rendering: the
                            // banner re-derives what to say (and what is safe to offer)
                            // through the disposition owner as canonical facts arrive.
                            setArmedContinuationOutcome({
                                kind: 'outcome',
                                sessionId,
                                scopeKey: activeServerAccountScopeKey,
                                result,
                                intent: destination.intent,
                                localId: destination.localId,
                                reconciled: false,
                            });
                            // Only canonical admission of this exact localId clears
                            // the draft. Every other outcome leaves the composer as
                            // the reader left it and has already said why.
                            if (disposition.draft !== 'clear') return { status: 'rejected' };
                            outboundHandoffLocalId = destination.localId;
                            onAdmitted();
                            return { status: 'accepted' };
                        };

                        if (hasAttachments) {
                            const admit = async (
                                submittedSnapshot: ComposerSubmissionSnapshot,
                                handoff: ComposerSubmissionAdmissionHandoff,
                            ): Promise<ComposerSubmissionAdmissionOutcome> => {
                                setIsComposerSending(true);
                                const admissionStructuredInputMetaOverrides = shouldUseComposerSubmissionCoordinator
                                    ? buildDetachedComposerSubmissionMetaOverrides(submittedSnapshot)
                                    : structuredInputMetaOverrides;
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
                                        return { status: 'rejected' };
                                    }
                                    const sessionForSubmit = readLatestSessionForSubmit();
                                    setIsUploadingAttachments(true);

                                    // The destination is decided before anything can
                                    // start an Agent. Resuming an inactive Session
                                    // starts the SOURCE Agent — the one the reader
                                    // chose to leave — and that is not undoable: it
                                    // spends provider work, can consume queued input,
                                    // and can make the transition fail non-idle. So the
                                    // one decision owner is consulted first and the
                                    // resume is a consequence of it, not a step that
                                    // runs before it and has to be lived with.
                                    const attachmentSendDestination = resolveSendDestination('sessionAgent');
                                    if (attachmentSendDestination.kind === 'refused') {
                                        return presentRefusedArmedSend(attachmentSendDestination);
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
                                        admissionStructuredInputMetaOverrides,
                                    );
                                    const outboundMetaOverridesWithBrowserContext = mergeBrowserContextMetaForSend(outboundMetaOverrides);
                                    if (outboundMetaOverridesWithBrowserContext === null) {
                                        return { status: 'rejected' };
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
                                            didClearForAttachmentHandoff = handoff.accept();
                                            return;
                                        }
                                        didClearForAttachmentHandoff = handoff.accept();
                                        if (didClearForAttachmentHandoff) {
                                            attachmentDraftsSnapshotRef.current = [];
                                            clearSessionAttachmentDrafts(sessionId);
                                            attachmentDraftManager.clearDrafts();
                                        } else {
                                            removeSubmittedAttachmentDraftsFromCurrent();
                                        }
                                    };
                                    if (attachmentSendDestination.kind === 'armedAgentContinuation') {
                                        return await dispatchArmedContinuation(
                                            attachmentSendDestination,
                                            {
                                                text: outbound.text,
                                                ...(outbound.displayText !== undefined
                                                    ? { displayText: outbound.displayText }
                                                    : {}),
                                                ...(outboundMetaOverridesWithBrowserContext
                                                    ? { metaOverrides: outboundMetaOverridesWithBrowserContext }
                                                    : {}),
                                            },
                                            () => {
                                                clearAttachmentsAfterProjectionHandoff();
                                                if (shouldSendReviewComments) {
                                                    clearSentReviewCommentDrafts();
                                                }
                                                recordOutboundAccepted();
                                            },
                                        );
                                    }
                                    const result = await submitSessionUserMessage(sessionSubmitPort, {
                                        sessionId,
                                        session: sessionForSubmit,
                                        text: outbound.text,
                                        displayText: outbound.displayText,
                                        metaOverrides: steerWithoutConfigMetaOverrides
                                            ? { ...outboundMetaOverridesWithBrowserContext, ...steerWithoutConfigMetaOverrides }
                                            : outboundMetaOverridesWithBrowserContext,
                                        configuredMode,
                                        busySteerSendPolicy,
                                        agentTargetKey: providerAgentTargetKey,
                                        currentRunnerProcessIdentity,
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
                                        return { status: 'rejected' };
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
                                    return { status: 'accepted' };
                                } catch (e) {
                                    if (canRestoreFailedAttachmentHandoffSnapshot()) {
                                        restoreAfterFailedOutboundHandoff(attachmentDraftsForRestore);
                                    }
                                    Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                                    return { status: 'rejected' };
                                } finally {
                                    setIsUploadingAttachments(false);
                                    setIsComposerSending(false);
                                }
                            };
                            const sessionAdmissionResult = await startSessionComposerAdmission(admit);
                            presentBlockedSessionComposerSubmission(sessionAdmissionResult);
                            return;
                        }

                        const admit = async (
                            submittedSnapshot: ComposerSubmissionSnapshot,
                            admissionHandoff: ComposerSubmissionAdmissionHandoff,
                        ): Promise<ComposerSubmissionAdmissionOutcome> => {
                            setIsComposerSending(true);
                            const admissionStructuredInputMetaOverrides = shouldUseComposerSubmissionCoordinator
                                ? buildDetachedComposerSubmissionMetaOverrides(submittedSnapshot)
                                : structuredInputMetaOverrides;
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
                                    : (trimmedText.length > 0 || hasComposerAttachments
                                        ? { text: trimmedText, displayText: undefined, metaOverrides: undefined }
                                        : null);

                                if (!outbound) return { status: 'rejected' };

                                const readyForSend = await externalSessionTakeover.ensureReadyForSend();
                                if (!readyForSend) {
                                    return { status: 'rejected' };
                                }

                                const voiceComposerRouting =
                                    outboundBase.kind === 'plain' && !participantRecipient && !hasComposerAttachments
                                        ? resolveVoiceSessionComposerRouting({
                                            conversationSessionId: sessionId,
                                            sessionMetadata: ownerMetadata,
                                        })
                                        : null;

                                if (voiceComposerRouting?.kind === 'adapter_text') {
                                    // An armed switch is a promise about where the next
                                    // message goes. A voice adapter is a different
                                    // destination entirely, so sending here would keep
                                    // the promise unkept and silent.
                                    const voiceDestination = resolveSendDestination('voiceAdapter');
                                    if (voiceDestination.kind === 'refused') {
                                        return presentRefusedArmedSend(voiceDestination);
                                    }
                                    const voiceSend = await sendVoiceSessionComposerText({
                                        conversationSessionId: sessionId,
                                        text: outbound.text,
                                        sessionMetadata: ownerMetadata,
                                        getAdapter: (adapterId) => getVoiceAdapterRegistry().get(adapterId),
                                    });
                                    if (!voiceSend.ok) {
                                        Modal.alert(
                                            t('common.error'),
                                            voiceSend.reason === 'send_failed' && voiceSend.message
                                                ? voiceSend.message
                                                : t('errors.voiceServiceUnavailable'),
                                        );
                                        return { status: 'rejected' };
                                    }
                                    if (voiceSend.disposition === 'pending') return { status: 'rejected' };
                                    if (voiceSend.disposition === 'ambiguous') {
                                        Modal.alert(
                                            t('common.error'),
                                            voiceSend.message ?? t('errors.voiceServiceUnavailable'),
                                        );
                                        return { status: 'rejected' };
                                    }
                                    admissionHandoff.accept();
                                    recordOutboundAccepted();
                                    if (shouldSendReviewComments) {
                                        clearSentReviewCommentDrafts();
                                    }
                                    return { status: 'accepted' };
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
                                    admissionStructuredInputMetaOverrides,
                                );
                                if (executionRunSend && hasComposerAttachments) {
                                    Modal.alert(t('common.error'), t('session.participants.unsupportedAttachmentsOrReviewComments'));
                                    return { status: 'rejected' };
                                }
                                if (executionRunSend && hasBrowserContextComposerAttachments(browserContextStateForComposer)) {
                                    Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                                    return { status: 'rejected' };
                                }

                                const outboundMetaOverridesWithBrowserContext = mergeBrowserContextMetaForSend(outbound.metaOverrides);
                                if (outboundMetaOverridesWithBrowserContext === null) {
                                    return { status: 'rejected' };
                                }
                                outbound.metaOverrides = outboundMetaOverridesWithBrowserContext;

                                if (executionRunSend) {
                                    // Same reasoning as the voice route above: an
                                    // execution run is not this Session's Agent, so an
                                    // armed switch cannot ride along unremarked.
                                    const executionRunDestination = resolveSendDestination('executionRun');
                                    if (executionRunDestination.kind === 'refused') {
                                        return presentRefusedArmedSend(executionRunDestination);
                                    }
                                    const result = await sessionExecutionRunSend(sessionId, executionRunSend);
                                    if (!result.ok) {
                                        if (isExecutionRunNotRunningSendError(result)) {
                                            recipientState.clearPersistedManualRecipient();
                                        }
                                        Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                                        return { status: 'rejected' };
                                    }
                                    admissionHandoff.accept();
                                    recordOutboundAccepted();
                                    return { status: 'accepted' };
                                }

                                const sendDestination = resolveSendDestination('sessionAgent');
                                if (sendDestination.kind === 'refused') {
                                    return presentRefusedArmedSend(sendDestination);
                                }
                                if (sendDestination.kind === 'armedAgentContinuation') {
                                    return await dispatchArmedContinuation(
                                        sendDestination,
                                        {
                                            text: outbound.text,
                                            ...(outbound.displayText !== undefined
                                                ? { displayText: outbound.displayText }
                                                : {}),
                                            ...(outbound.metaOverrides ? { metaOverrides: outbound.metaOverrides } : {}),
                                        },
                                        () => {
                                            admissionHandoff.accept();
                                            if (shouldSendReviewComments) {
                                                clearSentReviewCommentDrafts();
                                            }
                                            recordOutboundAccepted();
                                        },
                                    );
                                }

                                const sessionForSubmit = readLatestSessionForSubmit();

                                const result = await submitSessionUserMessage(sessionSubmitPort, {
                                    sessionId,
                                    session: sessionForSubmit,
                                    text: outbound.text,
                                    displayText: outbound.displayText,
                                    metaOverrides: steerWithoutConfigMetaOverrides
                                        ? { ...outbound.metaOverrides, ...steerWithoutConfigMetaOverrides }
                                        : outbound.metaOverrides,
                                    configuredMode,
                                    busySteerSendPolicy,
                                    agentTargetKey: providerAgentTargetKey,
                                    currentRunnerProcessIdentity,
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
                                        outboundHandoffLocalId = handoff.localId ?? outboundHandoffLocalId;
                                        admissionHandoff.accept();
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
                                    return { status: 'rejected' };
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
                                }
                                return { status: 'accepted' };
                            } finally {
                                setIsComposerSending(false);
                            }
                        };
                        const sessionAdmissionResult = await startSessionComposerAdmission(admit);
                        presentBlockedSessionComposerSubmission(sessionAdmissionResult);
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
                        await executeSessionComposerResolution({
                            resolved,
                            sessionId,
                            agentId: agentId ?? '',
                            backendTarget: resolveSessionActionDefaultTarget(sessionActionDefaultBackend),
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
                    await sendComposerText(resolved.text, composerMessage, sendOptions);
                    }), { tag: 'SessionView.composer.dispatch' });
                }, handleAgentInputSend)}
                isSendDisabled={
                    !shouldShowInput
                    || isResuming
                    || isReadOnly
                    || isUploadingAttachments
                    || externalSessionOperationShell.blocksNewOperation
                    || composerInputEffects.composerInputLock !== null
                }
                onAbort={handleAgentInputAbort}
                showAbortButton={shouldShowAbortButtonForSessionState(sessionStatus.state)}
                onFileViewerPress={openFileViewer}
                // Autocomplete configuration
                autocompleteKinds={SESSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={getAutocompleteSuggestions}
                onContributedActionSuggestionSelect={openComposerPluginAction}
                disabled={
                    isReadOnly
                    || externalSessionOperationShell.blocksNewOperation
                    || composerInputEffects.composerInputLock?.mode === 'editAndSubmit'
                }
                instrumentQuota={instrumentQuota}
                statusBadges={agentInputStatusBadges}
                activeStatusBadgeKey={activeStatusBadgeKey}
                onActiveStatusBadgeKeyChange={setActiveStatusBadgeKey}
                extraActionChips={agentInputExtraActionChips}
                attachmentRowItems={sessionAttachmentRowItems}
                isSending={isComposerSending}
                inputMaxHeight={maxAgentInputTextHeight}
                inputExpansion={inputExpansion}
                inputPersistence={inputComposerPersistence.inputPersistence}
                structuredInputMentions={pendingComposerDocument?.mentions ?? inputComposerPersistence.structuredInputPersistence.mentions}
                onStructuredInputMentionsChange={pendingComposerDocument
                    ? (mentions) => {
                        updatePendingMessageComposerDocument((document) => (
                            sameStrictJsonValue(document.mentions, mentions)
                                ? document
                                : { ...document, mentions, revision: document.revision + 1 }
                        ));
                    }
                    : inputComposerPersistence.structuredInputPersistence.onMentionsChange}
                maxPanelHeight={maxAgentInputPanelHeight}
            />
            <CurrentSessionPresentationSurface
                session={session}
                placement="afterComposer"
                composerRegions={composerPluginPresentation.composerRegions}
                renderComposerRegion={composerPluginPresentation.renderComposerRegion}
            />
            {attachmentsUploadsEnabled ? (
                <AttachmentFilePicker
                    ref={filePickerRef}
                    onAttachmentsPicked={addPickedAttachments}
                    multiple
                />
            ) : null}
            </View>
        </PluginContextualResourceStoreProvider>
    ) : null;

    const transcriptSelectionToolbar = transcriptMessageSelectionEnabled === true ? (
        <TranscriptSelectionToolbarController
            sessionId={sessionId}
            metadata={ownerMetadata}
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
                onPluginSurfaceNavigationBindingChange={onAppPanePluginSurfaceNavigationBindingChange}
                // Keep the real session tree mounted; the pane host is responsible for hiding
                // the main region in pane focus mode so focus toggles don't accidentally
                // render an empty placeholder region.
                main={main}
            />
        </SessionResumeProvider>
    );
}
