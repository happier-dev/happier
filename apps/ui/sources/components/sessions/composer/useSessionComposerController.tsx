import { providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { readRuntimeDescriptorV1FromMetadata } from "@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat";
import type { CliAuthStatusData } from "@/sync/api/capabilities/capabilitiesProtocol";
import { createStoredReadSchema } from "@happier-dev/protocol/json/storedReadSchema";
import { resolveEffectiveApiTokenPermissionModeV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import { createScmDiffSummaryResultOperations } from "@/sync/ops/scmDiffSummary/results";
import { applySavedScmDiffSummaryResult, getScmDiffSummaryState } from "@/sync/ops/scmDiffSummary/generate";
import { isEmbedWindowContext } from "@/embed/isEmbedWindowContext";
import { SessionModelDiscoveryDetail, type SessionModelDiscoveryContext } from "@/components/sessions/modelPicker/SessionModelDiscoveryDetail";
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from "@/sync/domains/scope/activeServerAccountScope";
import { createWorkflowRunRoute } from "@/sync/domains/workflows/workflowRunRoute";
import { getPromptLibraryCatalogValue } from "@/sync/store/settings/promptLibraryCatalogSnapshot";
import { refreshPromptLibraryCatalog } from "@/sync/engine/settings/promptLibraryCatalogEngine";
import { areServerAccountScopesEqual } from "@/sync/domains/scope/serverAccountScope";
import { mergeOptionPickerProbes } from "@/components/sessions/pickers/mergeOptionPickerProbes";
import { resolveNewSessionOperationalBackendTarget, resolveNewSessionModelCapabilityProbeContext } from "@/components/sessions/new/modules/newSessionCapabilityProbeContext";
import { readSessionConnectedServiceBindings } from "@/sync/domains/connectedServices/readSessionConnectedServiceBindings";
import type { SessionModelOptionsContext } from "@/sync/domains/models/modelOptions";
import { PendingNavigationPill } from "@/components/sessions/pendingNavigation/PendingNavigationPill";
import { PendingNavigationSettledNotice } from "@/components/sessions/pendingNavigation/PendingNavigationSettledNotice";
import { normalizeSessionAddress, type SessionAddress } from "@/sync/domains/session/sessionAddress";
import { resolveWorkspaceTargetForSession } from "@/sync/domains/session/resolveWorkspaceTargetForSession";
import type { AgentInputSendOptions } from "@/components/sessions/agentInput";
import { resolveSessionComposerSendActions } from '@/sync/domains/session/control/submitMode';
import { canUseDirectPendingDeliveryActions } from '@/components/sessions/pending/pendingMessageVisualState';
import { sendPendingMessageWithIntent } from '@/components/sessions/pending/pendingMessageSendActions';
import { useComposerTextStore } from "@/components/sessions/agentInput/composerTextStore";
import { SessionComposerAgentInput } from "@/components/sessions/composer/SessionComposerAgentInput";
import type { SessionInstrumentStripQuota } from "@/components/sessions/agentInput/instrumentStrip";
import { computeExistingSessionComposerInputMaxHeight, computeExistingSessionComposerPanelMaxHeight } from "@/components/sessions/agentInput/inputMaxHeight";
import { useComposerAvailablePanelHeight, useComposerKeyboardLayoutContext } from "@/components/sessions/keyboardAvoidance";
import type { AgentInputExtraActionChip, AgentInputStatusBadge } from "@/components/sessions/agentInput/agentInputContracts";
import { projectAgentInputAttachmentRowItems } from "@/components/sessions/agentInput/agentInputContracts";
import { AttachmentFilePicker } from "@/components/sessions/attachments/AttachmentFilePicker";
import type { AttachmentDraft } from "@/components/sessions/attachments/attachmentDraftModel";
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from "@/components/sessions/attachments/attachmentFilePickerActions";
import { useSessionAgentInputExtraActionChips } from "@/components/sessions/agentInput/sessionActions/useSessionAgentInputExtraActionChips";
import { useSessionWorkflowRunChip } from "@/components/sessions/agents/launch/useSessionWorkflowRunChip";
import { useSessionAccessComposerChip } from "@/components/sessions/access/useSessionAccessComposerChip";
import { openPluginContributedAction, openPluginContributedActionSessionReference } from "@/components/plugins/actions/openPluginContributedAction";
import { type PluginContributedActionController, type PluginContributedActionDescriptor, type PluginContributedActionOpenOutcome } from "@/components/plugins/actions/pluginContributedActionController";
import { useSessionConnectedServicesAuthSwitch } from "@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch";
import { useExistingSessionCapabilitiesChip } from "@/components/sessions/capabilities/useSessionCapabilitiesChip";
import { executeSessionLifecycleAction } from "@/components/sessions/actions/sessionActionExecution";
import { type SessionConnectedServiceAuthSwitchResult, setSessionConnectedServiceAuthBinding } from "@/sync/ops/connectedServices/sessionAuthSwitch";
import { resolveResumeFailurePresentation } from "@/sync/domains/session/resume/resolveResumeFailurePresentation";
import { buildPluginDetailRoute, storeMachineRouteParams } from "@/components/settings/plugins/model/pluginsSurfaceRoutes";
import { resolvePortableServerIdentityForRoutingId } from "@/sync/domains/server/resolvePortableServerIdentityForRoutingId";
import { alertActionFailure } from "@/utils/errors/alertActionFailure";
import { readRpcErrorCode } from "@happier-dev/protocol/rpcErrors";
import { deriveSessionIntentionalRestartSignals, resolveSessionIntentionalRestartRecoveryEvidenceAtMs, type SessionIntentionalRestartSignal } from "@/components/sessions/agentInput/hooks/sessionIntentionalRestartSignal";
import { useSessionIntentionalRestartSourceEvents } from "@/components/sessions/transcript/source/appSessionTranscriptSource";
import { SESSION_COMPOSER_SUGGESTION_KINDS, type ComposerReferenceSearchHost } from "@/components/autocomplete/composerSuggestionKinds";
import { useSessionComposerSuggestions } from "@/components/sessions/agentInput/useSessionComposerSuggestions";
import { resolveReviewCommentDraftAnchorsForPrompt } from "@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt";
import { CurrentSessionPresentationSurface } from "@/components/sessions/presentation/CurrentSessionPresentationSurface";
import { useComposerScopePluginPresentation } from "@/components/sessions/presentation/useComposerScopePluginPresentation";
import { mergeAbortSignals } from "@/utils/runtime/abortSignals";
import { useComposerPresentationInputEffects } from "@/components/sessions/presentation/useComposerPresentationInputEffects";
import { presentSessionTeamCredentialDenial } from "@/components/sessions/presentation/sessionTeamCredentialDenialPresentation";
import { applyComposerPresentationTransaction, flushPendingRegisteredSessionComposerActionChip, flushPendingRegisteredSessionComposerFocus, notifyComposerPresentationTargetChanged, notifySessionComposerPresentationTargetChanged, readComposerPresentationSnapshot, readReleasedComposerStagedMediaHandles, readSessionComposerPresentationTargetAtAddress, registerComposerPresentationTarget, registerSessionComposerPresentationTarget, releaseComposerStagedMedia, useStableComposerPresentationTarget, type ComposerPresentationDocumentMutation } from "@/components/sessions/presentation/sessionComposerPresentationTargets";
import { COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1, composerRefV1Key } from "@happier-dev/protocol/plugins/ui/composerRef";
import { PluginContextualResourceStoreProvider } from "@/components/plugins/surfaces/PluginContextualResourceStoreProvider";
import { projectComposerAttachmentRowItems } from "@/components/sessions/composer/composerAttachmentProjection";
import { createExistingSessionComposerDocumentOwner } from "@/components/sessions/composer/existingSessionComposerDocumentOwner";
import { insertMountedComposerAttachmentReferences, removeMountedComposerAttachmentReferences } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createPendingMessageComposerDocumentOwner, withdrawPendingMessageToComposerWithActionApproval } from "@/components/sessions/composer/pendingMessageComposerDocumentOwner";
import { useActionApprovalContinuation } from "@/components/approvals/useActionApprovalContinuation";
import type { ComposerDraftFieldCurrentness, MutableComposerDocumentOwner } from "@/components/sessions/composer/composerDocumentOwner";
import { createEphemeralComposerDocumentOwner, sameComposerAttachmentViews } from "@/components/sessions/composer/composerDocumentOwner";
import { projectComposerDocumentSnapshot } from "@/components/sessions/composer/composerSnapshotProjection";
import { composerAttachmentDraftToView, composerAttachmentViewToDraft, composerReferencesFromStructuredMentions, composerStructuredMentionsFromReferences, resolveCurrentComposerAttachmentCatalogEntry } from "@/components/sessions/composer/composerScopeAdapters";
import { prepareComposerSubmissionSnapshot, submitComposerSnapshot, type ComposerSubmissionAdmissionHandoff, type ComposerSubmissionAdmissionOutcome, type ComposerSubmissionResult, type ComposerSubmissionSnapshot } from "@/components/sessions/composer/composerSubmissionCoordinator";
import type { PendingMessageEditRequest } from "@/components/sessions/pending/PendingMessagesTranscriptBlock";
import { useDraft } from "@/hooks/session/useDraft";
import { SessionDraftConflictResolution, useSessionDraftConflictComposerBanner } from "@/components/sessions/drafts/SessionDraftConflictResolution";
import { buildSessionDraftSyncStatusBadge } from "@/components/sessions/drafts/sessionDraftStatusPresentation";
import { captureComposerTransientInputStateForOutboundHandoff, clearComposerAfterOutboundHandoff, restoreComposerAfterFailedOutboundHandoff } from "@/hooks/session/sessionComposerSendCoordinator";
import { useSessionAgentInputComposerPersistence } from "@/hooks/session/useSessionAgentInputComposerPersistence";
import { useFeatureEnabled } from "@/hooks/server/useFeatureEnabled";
import { useHomeTeamCredentialModelCatalog } from "@/hooks/teams/useHomeTeamCredentialModelCatalog";
import { teamCredentialDetailPath } from "@/components/settings/teams/teamsRoutes";
import type { TeamCredentialProviderModelSelectionV1 } from "@happier-dev/protocol/teams";
import { useFeatureDecision } from "@/hooks/server/useFeatureDecision";
import { useMaterializedTemporaryComputerSessionRecovery } from "@/components/sessions/shell/useMaterializedTemporaryComputerSessionRecovery";
import { useMachineAgent } from "@/agents/machineAgents/useMachineAgents";
import { useEventCallback } from "@/hooks/ui/useEventCallback";
import { Modal } from "@/modal";
import { useSessionModelUnarm } from "@/providers/session/useSessionModelUnarm";
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from "@/sync/ops/actions/resolveActionExecutionFailureMessage";
import { useTeamCredentialSelectionCoordinator } from "@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator";
import { resourceHasAvailableTeamCredentialProviderModel } from "@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness";
import { useScmSessionAutoRefresh } from "@/scm/refresh/useScmSessionAutoRefresh";
import { storage, useIsMachineListSettled, useLocalSetting, useProfile, useMachine, useServerScopedMachine, useSetting, useSocketStatus, useWorkspaceReviewCommentsDrafts } from "@/sync/domains/state/storage";
import { useSettingsSelector } from "@/sync/store/hooks";
import type { Settings } from "@/sync/domains/settings/settings";
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from "@/sync/domains/scope/serverAccountScope";
import { readMessageDisplayText } from "@happier-dev/session-core/messages";
import { isRecoveredHistoryTranscriptObservation } from "@happier-dev/session-core/messages";
import { useWorkspaceScopeForSession } from "@/sync/domains/session/resolveWorkspaceScopeForSession";
import { canContinueSessionWithFreshSpawn, canResumeSessionWithOptions } from "@/agents/runtime/resumeCapabilities";
import { resolveConnectedServiceProfileActionRoute } from "@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute";
import { getConnectedServiceRegistrySnapshot } from "@/sync/domains/connectedServices/connectedServiceRegistry";
import { getAgentCore, isBundledAgentId, resolveAgentIdFromFlavor } from "@/agents/catalog/catalog";
import { formatAgentLikeIdForDisplay } from "@/agents/catalog/formatAgentLikeIdForDisplay";
import { getResolvedBackendCatalogEntries } from "@/agents/backendCatalog/getResolvedBackendCatalogEntries";
import { useAcpCatalogForServer } from "@/sync/store/useAcpCatalog";
import { resolveBackendTargetKeyV2 } from "@/agents/backendCatalog/backendTargetKeyV2";
import { buildRolesRailPickerOption } from "@/components/roles/rail/buildRolesRailPickerOption";
import { useSessionRolesRailParams } from "@/components/roles/session/sessionRole";
import { useDaemonMergedProjectionInputs } from "@/agents/backendCatalog/useDaemonMergedProjectionInputs";
import { readCurrentProjectedAgentCapabilities, supportsAgentLifecycleCapability } from "@/agents/backendCatalog/currentAgentCapabilities";
import { evaluateAgentSessionCompactionCapability, parsePermissionIntentAlias, readExternalSessionOperationState, resolveAgentIdFromSessionMetadata } from "@happier-dev/agents";
import { useInSessionAgentPickerControls } from "@/components/sessions/agentPicker/useInSessionAgentPickerControls";
import { isAskHappierStatusOfferState } from "@/components/sessions/bots/askHappierEntry";
import { useAskHappierOpener } from "@/components/sessions/bots/useAskHappierOffer";
import { useResumeCapabilityOptions } from "@/agents/hooks/useResumeCapabilityOptions";
import { Session } from "@/sync/domains/state/storageTypes";
import { type Metadata } from "@happier-dev/session-core/state";
import { readSessionOwnerMetadataView } from "@/sync/domains/session/readSessionOwnerMetadataView";
import { getSessionStorageKind } from "@/sync/domains/session/sessionStorageKind";
import { readSessionPresentationAgentId } from "@/sync/domains/session/presentation/readSessionPresentationAgentId";
import { sync } from "@/sync/sync";
import { acceptPendingMessageComposerAdmission, abandonPendingMessageComposerAdmission, preparePendingMessageComposerAdmission } from "@/sync/ops/pendingMessageComposerAdmission";
import { filterReviewCommentDraftsIncludedInPrompt } from "@/sync/domains/input/reviewComments/reviewCommentPrompt";
import { buildReviewCommentsOutboundMessage } from "@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage";
import { buildReviewCommentsV1MetaPayload } from "@happier-dev/protocol/messages/structured/reviewCommentsInput";
import { parseReviewCommentsV1 } from "@/sync/domains/input/reviewComments/reviewCommentMeta";
import { resolveSessionComposerSend } from "@/sync/domains/input/slashCommands/resolveSessionComposerSend";
import { expandPromptTemplateInvocation } from "@/sync/domains/input/slashCommands/expandPromptTemplateInvocation";
import { resolvePromptInvocationComposerSendAction } from "@/sync/domains/input/slashCommands/promptInvocationBehavior";
import type { SessionArmedAgentContinuationSubmission, SessionDraftValueFieldId } from "@/sync/domains/input/draftValues/sessionDraftValueTypes";
import { SESSION_DRAFT_VALUE_SCHEMAS } from "@/sync/domains/input/draftValues/sessionDraftValueTypes";
import { readExecutionRunRequestedAction } from "@/sync/domains/input/participants/executionRunRequestedAction";
import { captureSessionDraftCurrentness, getOrCreateSessionMessagingDraftMutationAttempt, clearSessionMessagingDraftMutationAttempt, flushSessionDraftLocally, clearSessionDraftCurrentnessLocal, flushSessionDraft, getSessionDraftSnapshot, readSessionDiscussionSelectionSourceFromDraft, readSessionNextPromptPermissionModeFromDraft, subscribeSessionDraft, writeExistingSessionDraft, type SessionDraftCurrentness } from "@/sync/ops/sessionDrafts/sessionDraftRepository";
import { applyPermissionModeSelection } from "@/sync/domains/permissions/permissionModeApply";
import { t, tLoose } from "@/text";
import { isSessionAccessOwner } from "@/sync/engine/sessions/normalizeSessionAccessProjection";
import { trackMessageSent } from "@/track";
import { randomUUID } from "@/platform/randomUUID";
import { shouldShowAbortButtonForSessionState, useSessionStatus } from "@/utils/sessions/sessionUtils";
import { useSessionTranscriptSource } from "@/components/sessions/transcript/source/SessionTranscriptSourceContext";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { nativeReadClipboardImageAttachment } from "@/utils/files/nativeClipboardImageAttachment";
import type { ModelMode, PermissionMode } from "@/sync/domains/permissions/permissionTypes";
import { getPermissionModeOverrideForSpawn } from "@/sync/domains/permissions/permissionModeOverride";
import { useSessionRecipientState } from "@/components/sessions/agentInput/routing/useSessionRecipientState";
import { resolveParticipantRoutedSend } from "@/sync/domains/input/participants/resolveParticipantRoutedSend";
import { useSessionAgentInputRoutingControls } from "@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls";
import type { BrowserContextState } from "@/sync/domains/browser/context";
import { mergeBrowserContextMessageMetaOverrides } from "@/sync/domains/session/input/browserContext";
import { type SessionBrowserContextRuntime } from "@/components/sessions/browser/sessionBrowserContextRuntime";
import { tryBuildWorkspaceCacheKey } from "@/sync/domains/workspaces/workspaceScope";
import { nowServerMs } from "@/sync/runtime/time";
import { decidePendingMessageComposerRotation, derivePendingMessageComposerSuccessorEditState, hydratePendingMessageComposerAttachmentDrafts, readPendingMessageComposerSemanticDraftFieldsToRestore, type PendingMessageComposerEditState, type PendingMessageComposerExposedSuccessor, type PendingMessageComposerSemanticDraftSnapshot as ComposerSemanticDraftSnapshot } from "@/components/sessions/shell/pendingMessageComposerEditSnapshot";
import { resolveHappierReplayConfig } from "@/sync/domains/session/resume/happierReplayPrompt";
import { openNewSessionSourceContextNavigation } from "@/components/sessions/new/navigation/newSessionSourceContextNavigation";
import { buildLiveSessionAuthoringContext } from "@/components/sessions/authoring/context/buildLiveSessionAuthoringContext";
import { resolveSessionComposerStateFromAuthoringContext } from "@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext";
import { buildArmedAgentContinuationTransitionInput, continueSessionWithArmedAgent, prepareArmedAgentContinuation, reconcileArmedAgentContinuationDisposition, type ArmedAgentContinuationCanonicalFacts, type ArmedAgentContinuationInputCustody, type ArmedAgentContinuationLabels, type ArmedAgentContinuationNotice } from "@/sync/domains/session/input/continueSessionWithArmedAgent";
import { resolveSessionComposerSendDestination, type SessionComposerSendDestination, type SessionComposerSendRoute } from "@/sync/domains/session/input/resolveSessionComposerSendDestination";
import { submitAppSessionComposerMessage } from "@/components/sessions/transcript/source/appSessionTranscriptActions";
import { requireActionSuccess } from "@/sync/ops/actions/frontDoorRuntimeActionExecutor";
import { HappyError } from "@/utils/errors/errors";
import { getErrorMessage } from "@/utils/errors/getErrorMessage";
import { readGoalOperationResult } from "@/sync/ops/sessionGoalOperationResult";
import { resolveNonSteerableSendPlan, type NonSteerableSendPlan } from "@/components/sessions/agentInput/nonSteerableSendPreflight";
import { createSyncBackedSubmitPort } from "@/sync/domains/session/input/syncBackedSubmitPort";
import { normalizeUsageLimitRecoverySettings } from "@/sync/domains/settings/usageLimitRecoverySettings";
import { SESSION_PROVIDER_LIMITS_SETTINGS } from "@/components/settings/session/sessionProviderLimitsSettings";
import { useMountedActionExecution } from "@/components/approvals/useMountedActionExecution";
import { isSessionLocallyAttached } from "@/sync/domains/session/control/sessionLocalControl";
import { resolveSessionNativeGoalOwner } from "@/sync/domains/session/control/sessionGoalExecutionCapabilities";
import { computeSessionModelConfigOptionControls, findModelOptionForEffectiveModelId, getModelOptionsForSession, isModelSelectableForSession, resolveCanonicalNativeModelSelectionRef, resolveSessionModelLabel } from "@/sync/domains/models/modelOptions";
import { isArmedModelOnlySessionChange } from "@/providers/session/resolveSessionRoutePresentation";
import { readArmedRouteContinuationLabel } from "@/components/sessions/agentInput/components/agentContinuationSubmitPresentation";
import { resolveSessionModelSelectionDisposition } from "@/sync/domains/models/resolveSessionModelSelectionDisposition";
import { useDestinationRouter } from "@/components/appShell/workspace/DestinationInstanceHost";
import * as React from "react";
import { useSessionFilePaneNavigation } from "@/components/sessions/panes/useSessionFileDetailsOpener";
import { Platform, View, useWindowDimensions } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { shouldRequestRemoteControlAfterPendingEnqueue } from "@/sync/domains/session/control/localControlSwitch";
import { readControlSwitchUiTimeoutMsFromEnv } from "@/sync/domains/session/control/controlSwitchUiTimeout";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { getVoiceAdapterRegistry } from "@/voice/session/voiceAdapterRegistry";
import { resolveVoiceSessionComposerRouting } from "@/voice/binding/voiceSessionComposerRouting";
import { sendVoiceSessionComposerText } from "@/voice/binding/sendVoiceSessionComposerText";
import { createDefaultActionExecutor } from "@/sync/ops/actions/defaultActionExecutor";
import { createFrontDoorActionExecute } from "@/sync/ops/actions/frontDoorRuntimeActionExecutor";
import { ActionApprovalRequestCreatedResultSchema } from "@happier-dev/protocol/actions/actionExecutionResult";
import { PendingResetStartSetResultV1Schema } from "@happier-dev/protocol/sessions/pending/pendingRequestedActionV1";
import { usageResetStartFailureMessage } from "@/components/settings/usage/widgets/plans/usageResetStartFailure";
import { executeSessionComposerResolution } from "@/sync/domains/input/slashCommands/executeSessionComposerResolution";
import { SESSION_WORK_STATE_STATUS_BADGE_KEY } from "@/components/sessions/workState/sessionWorkStatePresentation";
import { resolveSessionActivityStatusBadgePresentation, shouldRetainSessionActivityStatusBadge, summarizeSessionManagedWorkflowRuns } from "@/components/sessions/workState/sessionActivityPresentation";
import { EMPTY_SESSION_WORKFLOW_ACTIVITY, IDLE_SESSION_MANAGED_WORKFLOW_RUNS, useSessionWorkSources } from "@/components/sessions/work/sessionWorkSources";
import { STALE_SESSION_RUNNER_STATUS_BADGE_KEY, buildStaleSessionRunnerNoticePresentation, type StaleSessionRunnerOperationStatus } from "@/components/sessions/sessionRunner/staleSessionRunnerNoticePresentation";
import { readStaleSessionRunnerRuntimeState } from "@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatus";
import type { SessionRunnerRuntimeStatusSnapshot } from "@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention";
import { getSessionRunnerRuntimeStatusSnapshot, restartSessionRunnerForProviderBindingChange, restartSessionRunnerOnCurrentRuntime } from "@/sync/ops/sessionRunnerRestart";
import { readSessionWorkStateFromMetadata } from "@/sync/domains/session/workState/readSessionWorkState";
import { SessionWorkStatePopover } from "@/components/sessions/workState/SessionWorkStatePopover";
import type { SessionWorkStateGoalSetRequest, SessionWorkStateOperationResult } from "@/components/sessions/workState/SessionWorkStateContent";
import { isSessionGoalEditingAvailable } from "@/components/sessions/workState/sessionGoalEditingAvailability";
import { createGoalActionChip } from "@/components/sessions/agentInput/definitions/createGoalActionChip";
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget, resolveSessionActionDefaultTargetKey } from "@/sync/domains/session/resolveSessionActionDefaultBackend";
import { resolveSessionActionDefaultBackendTitle } from "@/sync/domains/session/resolveSessionActionDefaultBackendTitle";
import type { OpenApprovalArtifactForSession } from "@/sync/domains/artifacts/approvalArtifacts";
import { resolveServerIdForSessionIdFromLocalCache } from "@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache";
import { narrowSessionModelPickerToAllowedModels, readEffectiveAllowedModelRef, narrowEmbeddedComposerInputLock, resolveEmbeddedComposerControls, type SessionViewEmbeddedPresentation } from "@/components/sessions/shell/embedded/embeddedSessionPresentation";
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from "@/sync/domains/server/serverProfiles";
import { useAttachmentsUploadConfig } from "@/components/sessions/attachments/useAttachmentsUploadConfig";
import { useAttachmentDraftManager } from "@/components/sessions/attachments/useAttachmentDraftManager";
import { sendableAttachmentDrafts } from "@/components/sessions/attachments/attachmentDraftModel";
import { clearSessionAttachmentDrafts, readSessionAttachmentDrafts, type SessionAttachmentDraftScope, writeSessionAttachmentDrafts } from "@/components/sessions/attachments/sessionAttachmentDraftStore";
import { buildAttachmentMessageMeta, uploadAttachmentDraftsToSession } from "@/components/sessions/attachments/uploadAttachmentDraftsToSession";
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';
import { classifyTransferFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { captureSessionMessageAttachmentDrafts, isAttachmentTargetUploadCheckpointFor, recordAttachmentTargetUploadCheckpoint } from "@/components/sessions/attachments/uploadSessionMessageAttachmentDrafts";
import { describeAttachmentUploadSource } from "@/components/sessions/attachments/uploadAttachmentDraftsToSession";
import { formatAttachmentSelectionSummary } from "@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1";
import { buildScopedSessionRouteHref } from "@/hooks/session/sessionRouteServerScope";
import { useSessionResumeRequestListener } from "@/components/sessions/model/sessionResumeRequests";
import { useExternalSessionTakeover } from "@/components/sessions/model/useExternalSessionTakeover";
import { useExternalSessionRuntime } from "@/components/sessions/model/useExternalSessionRuntime";
import { useEnabledAgentIds } from "@/agents/hooks/useEnabledAgentIds";
import { resolveSessionGoalActionCapabilityProfile, supportsEditableSessionGoals } from "@/agents/registry/registryUiBehavior";
import type { SessionParticipantTarget } from "@/sync/domains/session/participants/participantTargets";
import type { PendingMessage } from "@/sync/domains/state/storageTypes";
import { resolvePendingActivationBanner } from "@/components/sessions/pending/resolvePendingActivationBanner";
import { SessionExchangeCheckInBanner } from "@/components/sessions/pending/ExchangeCheckInBanner";
import { useManagedPendingWakeObservation } from "@/components/sessions/pending/useManagedPendingWakeObservation";
import { useMachineListStatusForServer } from "@/sync/domains/state/storage";
import { deriveManagedWakeProjection } from "@/sync/domains/pending/managedWakeProjection";
import { ManagedWakePopover, describeManagedWakeLabel } from "@/components/sessions/pending/ManagedWakePopover";
import { getMachineSentenceName } from "@/utils/sessions/machineDisplayNames";
import { describeMachinePresenceLine } from "@/utils/sessions/machinePresenceLine";
import { resolveHomeDisplayLabel } from "@/components/settings/server/homeDisplayName";
import { machineCollectionHref } from "@/components/settings/machines/collection/machineCollectionModel";
import { publishHomeAccountChange } from "@/sync/runtime/orchestration/homeAccountChange";
import { classifyHomeActionOutcome } from "@/sync/ops/home/homeActionOutcome";
import { createActionApprovalContinuation, resumeActionExecutionResult } from "@/components/approvals/actionApprovalContinuation";
import type { ComposerStructuredInputMention } from "@/sync/domains/input/draftValues/sessionDraftValueTypes";
import type { StorageState } from "@/sync/store/types";
import { readSessionWorkStatePrimaryItemV1 } from "@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary";
import { ConnectedServiceIdSchema, type ConnectedAccountServiceKey } from "@happier-dev/protocol/connect/connected-service-bindings";
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from "@happier-dev/protocol/plugins/contribution-identity";
import { RawIngressStructuredInputV1Schema, hasRawStructuredInputSemanticContentV1 } from "@happier-dev/protocol/runtime/input/structuredInputV1";
import { SessionUpdatePostOutputV1Schema } from "@happier-dev/protocol/sessions/relations/workerUpdateV1";
import { captureSessionComposerMessageAttachments, readSessionComposerMessageIntent, readSessionComposerMessagingOutcome } from "@/components/sessions/composer/sessionComposerMessaging";
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from "@happier-dev/protocol/runtime/input/structuredInputV1";
import { sanitizeSessionUserMessageSendMeta } from "@happier-dev/protocol/sessions/userMessageRpc";
import type { ComposerAttachmentDraftV1, ComposerAttachmentInputV1 } from "@happier-dev/protocol/runtime/input/composerAttachmentV1";
import type { SessionPendingMessageComposerAdmissionAbandonedRequestV1 } from "@happier-dev/protocol/sessions/userMessageRpc";
import type { ComposerRefV1 } from "@happier-dev/protocol/plugins/ui/composerRef";
import type { ComposerSnapshotV1, ComposerTransactionResultV1 } from "@happier-dev/protocol/plugins/ui/composer";
import { SESSION_RUNNER_RUNTIME_METADATA_KEY, SessionRunnerRuntimeStateV1Schema } from "@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1";
import type { ConnectedServiceQuotaSnapshotV1 } from "@happier-dev/protocol/connect/connected-service-schemas";
import { isHiddenSystemSession } from "@happier-dev/protocol/sessions/control/contract";
import { readSessionProviderBindingMetadataV1 } from "@happier-dev/protocol/providers/sessions/bindingMetadataV1";
import { removeSessionPendingQueueHoldV1FromMetadata, writeSessionPendingQueueHoldV1ToMetadata } from "@happier-dev/protocol/sessions/metadata/sessionPendingQueueHoldV1";
import { SessionModelTransitionResultV1Schema } from "@happier-dev/protocol/sessions/control/modelTransitionV1";
import { sameStrictJsonValue, StrictJsonValueSchema } from "@happier-dev/protocol/json/strictJsonValue";
import type { ProviderBoundModelRef } from "@happier-dev/protocol/providers/model-selection";
import { useProviderSettings } from "@/providers/hooks/useProviderSettings";
import { useProviderBindingStatus } from "@/providers/hooks/useProviderBindingStatus";
import { presentSessionProviderBinding } from "@/providers/session/presentation";
import { useProviderModelProjection } from "@/providers/hooks/useProviderModelProjection";
import { useConfirmExperimentalProviderModel } from "@/providers/hooks/useConfirmExperimentalProviderModel";
import { SessionModelPicker } from "@/components/sessions/modelPicker/SessionModelPicker";
import { SessionModelNativeSourceLabelContext } from "@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff";
import { hiddenModelVisibilityKeys, type SessionModelProjectionGroup } from "@/components/sessions/modelPicker/buildSessionModelPickerSections";
import { isTeamCredentialProviderModelPickerValue, sessionModelSelectionKey, type SessionModelPickerOptionValue } from "@/components/sessions/modelPicker/sessionModelSelectionKey";
import { hapticsLight } from "@/components/ui/theme/haptics";
import { useSessionViewBootstrap } from "@/components/sessions/shell/view/useSessionViewBootstrap";
import { type SessionPresentationIntentApplier } from "@/components/sessions/companion/presentation/SessionCompanionPresentationBridge";
import { ComposerAuxiliaryFrame } from "@/components/sessions/shell/view/ComposerAuxiliaryFrame";
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from "@/components/sessions/agentInput/composerContentInset";
import { WarningActionBanner } from "@/components/sessions/shell/view/WarningActionBanner";
import { useComposerBannerCollapse } from "@/components/sessions/composerBanners/ComposerBannerCollapseProvider";
import { buildComposerBannerBadgeAccessibility } from "@/components/sessions/composerBanners/composerBannerCollapse";
import { readExternalSessionLink } from "@/sync/domains/session/external/readExternalSessionLink";
import { createExternalSessionTranscriptLiveSourceKeyFromLink, resolveExternalSessionTranscriptAuthorityState } from "@/sync/runtime/external/externalSessionTranscriptAuthority";
import { formatShortRelativeTimeAt } from "@/utils/time/formatShortRelativeTime";
import { combineSessionViewExtraActionChips } from "@/components/sessions/shell/view/combineSessionViewExtraActionChips";
import { resolveSessionViewModeOptionIds } from "@/components/sessions/shell/view/resolveSessionViewModeOptionIds";
import { readSessionModesState } from "@/sync/domains/sessionControl/readSessionControlMetadata";
import { computeSessionModePickerControl } from "@/sync/domains/sessionControl/sessionModeControl";
import { useSessionListRuntimeNowMs } from "@/hooks/session/sessionListRuntimeClock";
import { type ServerCredentialAccountScopeBinding } from "@/sync/domains/scope/useServerCredentialAccountScopes";
import { presentExternalSessionOperationShell } from "@/components/sessions/shell/../external/progress/externalSessionOperationShellPresentation";
import { readExternalSessionOperationPresentationFromMetadata } from "@/components/sessions/shell/../transcript/items/externalSessionOperationMetadata";
import { resolveSessionViewRuntimeDisplayState } from "@/components/sessions/shell/view/resolveSessionViewRuntimeDisplayState";
import { resolveSessionViewConnectionStatus, type SessionViewPendingQueueAction, type SessionViewPendingQueueLine, type SessionViewProviderBindingLine } from "@/components/sessions/shell/view/resolveSessionViewConnectionStatus";
import { isPendingMessageForRecipient } from "@/sync/domains/pending/pendingMessageRecipient";
import { resolveSessionGuardComposerState } from "@/components/sessions/shell/view/resolveSessionGuardComposerState";
import { readSessionListGuardState } from "@/sync/domains/session/listing/sessionListRenderable";
import { keepMachineGuardWorkRunningViaAction } from "@/sync/domains/machines/guard/machineGuardRpc";
import { useSessionReachableMachineTarget } from "@/components/sessions/shell/../model/useSessionMachineReachability";
import { useSessionMachineControlTarget } from "@/components/sessions/shell/../model/useSessionMachineTarget";
import { buildStructuredInputMetaOverrides, mergeMessageMetaOverrides } from "@/components/sessions/agentInput/structuredInputMentions";
import { type SessionAuthSurfaceState } from "@/components/sessions/shell/sessionAuthSurfaceState";
import { selectSessionViewShellSessionForRouteState } from "@/components/sessions/shell/sessionViewStableSession";
import { useSessionRuntimeStatusSource } from "@/components/sessions/shell/useSessionRuntimeStatusSource";
import { SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY, buildSessionUsageLimitRecoveryPresentation, resolveSessionUsageLimitRecoveryOperationStatus, isSessionUsageLimitRecoveryCheckNowAction, isSessionUsageLimitRecoveryCheckingOperationAction, readSessionUsageLimitRecoveryFromMetadata, type SessionUsageLimitRecoveryActionKind, type SessionUsageLimitRecoveryTranslate, type SessionUsageLimitRecoveryTranslationParams, type SessionUsageLimitRecoveryState, type UsageLimitRecoveryOperationStatus, type UsageLimitRecoverySettings } from "@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryPresentation";
import { hasMeaningfulActivityAfterRuntimeIssue } from "@/components/sessions/usageLimitRecovery/sessionUsageLimitActivityStaleness";
import { SessionUsageLimitRecoveryBanner } from "@/components/sessions/usageLimitRecovery/SessionUsageLimitRecoveryBanner";
import { buildSessionNearLimitPresentation, dismissSessionNearLimit, readDismissedSessionNearLimitKeys } from "@/components/sessions/usageLimitRecovery/sessionNearLimitPresentation";
import { formatResetAtTime } from "@/utils/time/formatResetAtTime";
import { formatUsageLimitRecoveryOperationError } from "@/components/sessions/usageLimitRecovery/formatUsageLimitRecoveryOperationError";
import { buildSessionUsageLimitRecoveryOperationFailureAlert, type SessionUsageLimitRecoveryOperationFailureResult } from "@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryOperationFailureAlert";
import { handleReadyUsageLimitRecoveryResult } from "@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryReadyResult";
import { normalizeSessionUsageLimitRecoveryOperationResultV1, SessionUsageLimitRecoveryOperationResultV1Schema, type SessionUsageLimitRecoveryOperationResultV1 as SessionUsageLimitRecoveryOperationResult } from "@happier-dev/protocol/sessions/control/sessionUsageLimitRecoveryOperationResultV1";
import { ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from "@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc";
import { computeConnectedServiceQuotaGaugeViewModel, selectConnectedServiceSessionProviderUsageSnapshot, type ConnectedServiceQuotaGaugeLabelFormatter, type ConnectedServiceQuotaGaugeWindowMode } from "@/sync/domains/connectedServices/connectedServiceQuotaGauge";
import { resolveQualifiedConnectedAccountProfilePreference } from "@/sync/domains/connectedServices/connectedServiceProfilePreferences";
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from "@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation";
import { useConnectedServiceQuotaSnapshots } from "@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots";
import { useProviderAccountUsageSnapshots } from "@/hooks/server/connectedServices/useProviderAccountUsageSnapshots";
import { resolveConnectedServiceQuotaProfileRefForSession } from "@/components/sessions/shell/resolveConnectedServiceQuotaProfileRefForSession";
import { computeProviderAccountUsageGaugeViewModel, selectProviderUsageDisplaySource } from "@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors";
import { readProviderAccountUsageRecordIdsFromMetadata } from "@happier-dev/protocol/sessions/metadata/providerAccountUsageRefsV1";
import type { ComposerAgentContinuationIntentV1, SessionAgentTransitionResultV1 } from "@happier-dev/protocol/sessions/agentTransition";
import { Icon, type IconName } from "@/components/ui/icons/Icon";
import type { SessionComposerModel } from "./sessionComposerModel";


const MAX_USAGE_LIMIT_RECOVERY_READY_TIMER_MS = 2_147_483_647;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_TTL_MS = 2 * 60 * 1000;
const PENDING_MESSAGE_EDIT_DRAIN_HOLD_REFRESH_MS = 30 * 1000;
const EMPTY_SESSION_MODEL_PROJECTION_GROUPS: readonly SessionModelProjectionGroup[] = [];
const EMPTY_TEAM_CREDENTIAL_RESOURCES: readonly never[] = [];
const EMPTY_SESSION_ROUTE_HIDDEN_SOURCES: readonly never[] = [];

// Full Agent Settings belong to the deferred detail readers. The retained
// Session observes only the Account inputs its visible policy consumes.
const selectSessionViewSettings = (settings: Settings) => ({
    backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    favoriteBackendTargetKeysV1: settings.favoriteBackendTargetKeysV1,
    usageLimitRecoverySettingsV1: settings.usageLimitRecoverySettingsV1,
    sessionPermissionModeApplyTiming: settings.sessionPermissionModeApplyTiming,
    connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    connectedServicesProviderStateSharingSettingsV1: settings.connectedServicesProviderStateSharingSettingsV1,
    connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
    connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
});

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
    composerCurrentness: ComposerDraftFieldCurrentness;
}>;

type ComposerSemanticDraftClearResult = Readonly<{
    clearedFieldIds: readonly SessionDraftValueFieldId[];
    textCleared: boolean;
}>;

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


const EMPTY_AGENT_INPUT_STATUS_BADGES: readonly AgentInputStatusBadge[] = Object.freeze([]);

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

export function SessionAuthRecoveryBanner({ message }: Readonly<{ message: string }>) {
    const router = useDestinationRouter();

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

/**
 * The Session composer input with its live text. Typing re-renders this leaf, never the loaded
 * Session view: the view reads the text when it acts (send, actions, persistence) and follows
 * only what the text means to it. A pending-message edit shows that edit's own text instead.
 */
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

function hasSessionWriteAccess(access: Session['access']): boolean {
    return access?.capabilities.submitAgentInput === true;
}

export type SessionComposerControllerOptions = Readonly<{
    embedded: SessionViewEmbeddedPresentation | null;
    authSurfaceState: SessionAuthSurfaceState | null;
    sessionId: string;
    routeServerId?: string | null;
    accountBinding: ServerCredentialAccountScopeBinding | null;
    session: Session;
    pane: ReturnType<typeof useSessionViewBootstrap>['pane'];
    isMachineReachable: boolean;
    machineReachability: ReturnType<typeof useSessionViewBootstrap>['machineReachability'];
    surfaceFocused: boolean;
    surfacePresented: boolean;
    isEncryptedSessionLocked: boolean;
    executionRunsEnabled: boolean;
    participantTargets: readonly SessionParticipantTarget[];
    approvalRequests: ReadonlyArray<OpenApprovalArtifactForSession>;
    initialAttachmentDrafts: readonly AttachmentDraft[] | null;
    attachmentsUploadsEnabled: boolean;
    attachmentsUploadsAvailable: boolean;
    browserContextStateForComposer: BrowserContextState | null;
    browserContextComposerContext: SessionBrowserContextRuntime['composerContext'] | null;
    pendingMessages: readonly PendingMessage[];
    pendingMessagesLoaded: boolean;
    pendingReadState: 'loading' | 'error' | undefined;
    externalSessionRuntime: ReturnType<typeof useExternalSessionRuntime>;
    sessionRunnerRuntimeStatus: SessionRunnerRuntimeStatusSnapshot | null;
    sessionRunnerRuntimeStatusMachineId: string | null;
    onSessionRunnerRuntimeStatusInvalidated: () => void;
    // The focused surface owns the one collaboration availability/target derivation; the loaded
    // view consumes it so the composer access chip cannot resolve a second answer.
    collaborationTarget: SessionAddress | null;
    collaborationAvailable: boolean;
    foldCollaborationHeaderEntry: boolean;
    openSessionAccess: () => void;
    openWorkStateRequestKey: number | null;
}>;

/** One mounted owner for the Session composer; hosts consume its existing subtree and handlers. */
export function useSessionComposerController({
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
}: SessionComposerControllerOptions) {
    const embeddedComposerControls = React.useMemo(() => resolveEmbeddedComposerControls(embedded), [embedded]);
    const sessionAccountLifetime = accountBinding && (isEmbedWindowContext() || accountBinding.isCurrent())
        ? accountBinding
        : null;
    const sessionAccountScope = sessionAccountLifetime?.scope ?? null;
    const presentSessionActionOutcome = React.useCallback((error: unknown, lifetime: typeof sessionAccountLifetime) => {
        if (!lifetime?.isCurrent() || !composerPresentationMountedRef.current) return;
        const pendingApproval = error instanceof HappyError
            && error.code === 'approval_request_created'
            && ActionApprovalRequestCreatedResultSchema.safeParse(error.details).success;
        Modal.alert(pendingApproval ? t('approvals.title') : t('common.error'),
            getErrorMessage(error) || t('errors.failedToSendMessage'));
    }, []);
    const sessionAccountScopeKey = sessionAccountScope
        ? serverAccountScopeKeySuffix(sessionAccountScope)
        : 'local';
    const companionAddress = React.useMemo(
        () => normalizeSessionAddress(routeServerId ?? null, sessionId),
        [routeServerId, sessionId],
    );
    const [pendingMessageEdit, setPendingMessageEdit] = React.useState<PendingMessageComposerEditState | null>(null);
    const pendingMessageEditRef = React.useRef(pendingMessageEdit);
    pendingMessageEditRef.current = pendingMessageEdit;
    const activeComposerRef = React.useMemo<ComposerRefV1>(() => pendingMessageEdit
        ? { kind: 'pendingMessage', sessionId, localId: pendingMessageEdit.localId }
        : { kind: 'session', sessionId }, [pendingMessageEdit?.localId, sessionId]);
    const activeComposerRefRef = React.useRef<ComposerRefV1>(activeComposerRef);
    activeComposerRefRef.current = activeComposerRef;
    const composerPresentationMountedRef = React.useRef(true);
    const sessionPresentationApplierRef = React.useRef<SessionPresentationIntentApplier | null>(null);
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const promptPickerOpenRequestRef = React.useRef<(() => boolean) | null>(null);
    const composerPresentationAccountLifetime = sessionAccountLifetime;
    const boardPresentationUndoCurrentRef = React.useRef(false);
    boardPresentationUndoCurrentRef.current = composerPresentationMountedRef.current
        && surfaceFocused
        && composerPresentationAccountLifetime !== null
        && composerPresentationAccountLifetime.isCurrent();
    const isActiveComposerPresentationCurrent = React.useCallback(() => (
        composerPresentationMountedRef.current
        && composerRefV1Key(activeComposerRefRef.current)
            === composerRefV1Key(activeComposerRef)
        && composerPresentationAccountLifetime !== null
        && composerPresentationAccountLifetime.isCurrent()
    ), [activeComposerRef, composerPresentationAccountLifetime]);
    const ownedComposerInputEffects = useComposerPresentationInputEffects({
        ref: activeComposerRef,
    });
    const reconnectingInputReason = t('connectionStatus.summary.reconnecting');
    const embeddedPresentationRef = React.useRef(embedded);
    embeddedPresentationRef.current = embedded;
    const readComposerInputLock = React.useCallback(() => narrowEmbeddedComposerInputLock(
        ownedComposerInputEffects.readComposerInputLock(), embeddedPresentationRef.current, reconnectingInputReason,
    ), [ownedComposerInputEffects.readComposerInputLock, reconnectingInputReason]);
    const composerInputEffects = {
        ...ownedComposerInputEffects,
        composerInputLock: narrowEmbeddedComposerInputLock(ownedComposerInputEffects.composerInputLock, embedded, reconnectingInputReason),
        readComposerInputLock,
    };
    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(activeComposerRef);
    }, [activeComposerRef, embedded?.composerInputLocked]);
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
    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!composerPresentationMountedRef.current) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(activeComposerRef);
    }, [activeComposerRef]);
    const { theme } = useUnistyles();
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const composerOptionsInput = session.composerOptionsInput === undefined ? ownerMetadata : session.composerOptionsInput;
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
    const router = useDestinationRouter();
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
    const composerTextStore = useComposerTextStore(() => {
        if (!isEmbedWindowContext() || !sessionAccountScope) return '';
        const draft = getSessionDraftSnapshot(sessionAccountScope, { kind: 'session', sessionId })?.document;
        const text = draft && 'composer' in draft ? draft.composer.text.value : undefined;
        return typeof text === 'string' ? text : '';
    });
    const [composerDocumentRenderEpoch, setComposerDocumentRenderEpoch] = React.useState(0);
    const rawUiFontScale = useLocalSetting('uiFontScale');
    const uiFontScale = typeof rawUiFontScale === 'number' ? rawUiFontScale : undefined;
    const inputComposerPersistence = useSessionAgentInputComposerPersistence({
        sessionId,
        accountLifetime: sessionAccountLifetime,
        textStore: composerTextStore,
        fontScale: uiFontScale,
    });
    const isInputExpanded = inputComposerPersistence.expanded;
    const setInputExpanded = inputComposerPersistence.setExpanded;
    const maxAgentInputTextHeight = isInputExpanded
        ? expandedAgentInputTextHeight
        : collapsedAgentInputTextHeight;
    const inputExpansion = React.useMemo(() => ({
        expanded: isInputExpanded,
        ...(typeof collapsedAgentInputTextHeight === 'number'
            ? { collapsedMaxHeight: collapsedAgentInputTextHeight }
            : {}),
        onToggle: () => {
            setInputExpanded((current) => !current);
        },
    }), [collapsedAgentInputTextHeight, setInputExpanded, isInputExpanded]);
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
    const transcriptSource = useSessionTranscriptSource();
    const pendingRequestLists = transcriptSource.usePendingRequests();
    const pendingPermissionRequests = pendingRequestLists.permissionRequests;
    const intentionalRestartSourceEvents = useSessionIntentionalRestartSourceEvents();
    const reachableMachineTarget = useSessionReachableMachineTarget(sessionId);
    const controlMachineTarget = useSessionMachineControlTarget(sessionId);
    const machineId = reachableMachineTarget?.machineId ?? ownerMetadata?.machineId;
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
    const sessionModeOptionIds = agentId
        ? resolveSessionViewModeOptionIds(
            agentId,
            readSessionModesState(ownerMetadata),
            agentCore?.sessionModes,
        )
        : [];
    const sessionModePickerControl = agentId
        ? computeSessionModePickerControl({ agentId, metadata: ownerMetadata })
        : null;
    const enabledAgentIds = useEnabledAgentIds();
    const sessionActionDefaultBackend = React.useMemo(() => resolveSessionActionDefaultBackend({
        session: {
            metadata: session.metadata,
            metadataLayoutVersion: session.metadataLayoutVersion,
            ownerMetadataView: session.ownerMetadataView,
        },
        enabledAgentIds,
        fallbackAgentId: liveComposerState.agentId && isBundledAgentId(liveComposerState.agentId)
            ? liveComposerState.agentId
            : null,
    }), [session.metadata, session.metadataLayoutVersion, session.ownerMetadataView, enabledAgentIds, liveComposerState.agentId]);
    const agentInputAgentType = agentId ?? sessionActionDefaultBackend?.displayAgentType ?? null;
    const agentInputCore = agentInputAgentType ? getAgentCore(agentInputAgentType) : null;
    const isHiddenSystemSessionSession = isHiddenSystemSession({ metadata: ownerMetadata });
    const modelMode = liveComposerState.modelMode;
    const sessionRuntimeStatusSource = useSessionRuntimeStatusSource(session);
    const sessionStatus = useSessionStatus(sessionRuntimeStatusSource, {
        subscribeToSession: false,
        subscribeToTranscript: false,
    });
    // One derivation of this Session's Home, used for routing and for every
    // capability/feature scope below. `routeServerId` is already the outer view's
    // resolved `currentSessionRouteServerId` (explicit route > local cache >
    // active Home); the fallbacks here only cover a caller that renders this
    // component without one. A second, shorter derivation beside this one could
    // only disagree about which Home a Session belongs to.
    const sessionRouteServerId = (routeServerId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(sessionId)
        || getActiveServerSnapshot().serverId;
    const sessionComposerAddress = React.useMemo(() => ({
        serverId: sessionRouteServerId,
        sessionId,
    }), [sessionId, sessionRouteServerId]);
    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
        if (request) flushPendingRegisteredSessionComposerFocus(sessionComposerAddress);
    }, [sessionComposerAddress]);
    const onPromptPickerOpenRequestChange = React.useCallback((request: (() => boolean) | null) => {
        promptPickerOpenRequestRef.current = request;
    }, []);
    const providersFeatureEnabled = useFeatureEnabled('providers', { scopeKind: 'spawn', serverId: sessionRouteServerId });
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: sessionRouteServerId,
    });
    const providerAgentTargetKey = resolveSessionActionDefaultTargetKey(sessionActionDefaultBackend);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: sessionRouteServerId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const declarationProjection = daemonMergedProjection.phase === 'ready'
        ? daemonMergedProjection.inputs?.pluginProjectionV2 ?? null : null;
    const declarationContext = React.useMemo(() => providerDeclarationContext(machineId, declarationProjection),
        [machineId, declarationProjection]);
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: sessionRouteServerId,
        machineId,
        agentTargetKey: providerAgentTargetKey,
        declarationProjection,
        enabled: teamCredentialResourcesEnabled,
    });
    const coordinateTeamCredentialSelection = useTeamCredentialSelectionCoordinator(sessionRouteServerId);
    const teamCredentialSelectionCatalogRef = React.useRef(teamCredentialCatalog);
    teamCredentialSelectionCatalogRef.current = teamCredentialCatalog;
    const teamCredentialConnectedServiceResources = React.useMemo(() => (
        teamCredentialCatalog.resources.filter((resource) => resource.connectedServiceSelections.length > 0)
    ), [teamCredentialCatalog.resources]);
    const providerLaunchBinding = React.useMemo(
        () => readSessionProviderBindingMetadataV1(ownerMetadata),
        [ownerMetadata],
    );
    const providerModelSelectionIntent = composerOptionsInput?.modelSelectionIntentV1 ?? null;
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
        completedTurnObservedAt: session.latestTurnStatus === 'completed' ? session.latestTurnStatusObservedAt : null,
    });
    const [providerModelPickerDemanded, setProviderModelPickerDemanded] = React.useState(false);
    const providerModelProjection = useProviderModelProjection({
        enabled: providersFeatureEnabled && providerAgentTargetKey !== null,
        active: surfaceFocused && providerModelPickerDemanded,
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
    const passiveProviderRecoveryServiceId = React.useMemo<ConnectedAccountServiceKey | null>(() => {
        const errorCode = providerBindingStatus.error?.code;
        if (
            errorCode !== 'provider_machine_unavailable'
            && errorCode !== 'provider_managed_requires_daemon'
            && errorCode !== 'provider_materialization_failed'
        ) {
            return null;
        }
        const target = providerLaunchBinding?.managedPurposeBindings?.bindings[0]?.target;
        if (!target) return null;
        return buildQualifiedPluginContributionKey(
            target.kind === 'account' ? target.account.service : target.service,
        );
    }, [providerBindingStatus.error?.code, providerLaunchBinding?.managedPurposeBindings]);
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
    // Another surface asking this composer to open one of its action chips (the Work tab opening the
    // Goal control through the presentation-target registry). The keys are this render's chips.
    const [composerActionChipOpenRequest, setComposerActionChipOpenRequest] = React.useState<Readonly<{ chipKey: string; key: string }> | null>(null);
    const composerActionChipKeysRef = React.useRef<ReadonlySet<string>>(new Set());
    /**
     * The one place a selection the Home accepted but the running runner has not
     * adopted is remembered, for personal Provider selections and Team
     * credential selections alike. Both reach the same explicit restart
     * affordance: a committed selection is never silently applied by restarting
     * somebody's running session behind their back, and a runner that cannot be
     * restarted right now is still reported as "restart to use it" rather than
     * as a failed selection.
     */
    const [modelTransitionActionRequired, setModelTransitionActionRequired] = React.useState<Readonly<{
        status: 'armed' | 'restart_required' | 'reconciliation_required';
        requestedSelection: NonNullable<SessionModelPickerOptionValue>;
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
    const selectedTeamCredentialModel = React.useMemo<TeamCredentialProviderModelSelectionV1 | null>(() => {
        const selection = modelSelectionDisposition?.proposedSelectionV2;
        if (selection?.ref.source !== 'team_resource') return null;
        return {
            kind: 'team_credential_provider_model',
            resourceId: selection.ref.resourceId,
            teamId: selection.ref.teamId,
            expectedResourceRevision: selection.ref.expectedResourceRevision,
            deliveryMode: selection.ref.deliveryMode,
            agentTargetKey: selection.ref.agentTargetKey,
            modelId: selection.ref.modelId,
        };
    }, [modelSelectionDisposition?.proposedSelectionV2]);
    const persistedModelTransitionActionRequired = React.useMemo(() => {
        const requestedSelection = selectedTeamCredentialModel
            ?? providerModelSelectionIntent?.selection
            ?? null;
        if (session.active !== true || !requestedSelection) return null;
        if (
            !isTeamCredentialProviderModelPickerValue(requestedSelection)
            &&
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
        selectedTeamCredentialModel,
        session.active,
    ]);
    // A Team credential selection carries no Provider connection of its own, so
    // the Providers feature never decides whether its pending restart is shown.
    const pendingTransitionSelection = modelTransitionActionRequired?.requestedSelection ?? null;
    const pendingTransitionNeedsProvidersFeature = pendingTransitionSelection === null
        || isTeamCredentialProviderModelPickerValue(pendingTransitionSelection)
        ? false
        : pendingTransitionSelection.providerConnectionId !== null;
    const visibleLocalModelTransitionActionRequired =
        pendingTransitionNeedsProvidersFeature && !providersFeatureEnabled
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
    const scmSessionAutoRefreshIntervalMsSetting = useSetting('scmSessionAutoRefreshIntervalMs' as any);
    const scmSessionAutoRefreshIntervalMs =
        typeof scmSessionAutoRefreshIntervalMsSetting === 'number' && Number.isFinite(scmSessionAutoRefreshIntervalMsSetting) && scmSessionAutoRefreshIntervalMsSetting >= 5_000
            ? scmSessionAutoRefreshIntervalMsSetting
            : 5 * 60 * 1000;
    const settings = useSettingsSelector(selectSessionViewSettings);
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
    const pendingComposerDocumentOwnerRef = React.useRef<MutableComposerDocumentOwner | null>(null);
    const sessionComposerRef = React.useMemo<Extract<ComposerRefV1, { kind: 'session' }>>(
        () => ({ kind: 'session', sessionId }),
        [sessionId],
    );
    const existingSessionComposerOwner = React.useMemo(() => sessionAccountScope && sessionAccountLifetime
        ? createExistingSessionComposerDocumentOwner({
            scope: sessionAccountScope,
            ref: sessionComposerRef,
            isCurrent: sessionAccountLifetime.isCurrent,
        })
        : createEphemeralComposerDocumentOwner({
            ref: sessionComposerRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: composerTextStore.getPrompt(),
                structuredInputMentions: [],
                composerAttachments: [],
            },
        }), [composerTextStore, sessionAccountLifetime, sessionAccountScope, sessionComposerRef]);
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
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor({
        currentAgentCapabilities: currentLifecycleAgentCapabilities,
        ...(sessionAccountScope ? { currentSessionPresentationApply: {
            ...sessionAccountScope,
            sessionId,
            isCurrent: () => composerPresentationMountedRef.current
                && 'sessionId' in activeComposerRefRef.current
                && activeComposerRefRef.current.sessionId === sessionId
                && boardPresentationUndoCurrentRef.current
                && sessionAccountLifetime?.isCurrent() === true
                && sessionPresentationApplierRef.current !== null,
            apply: async ({ input, signal }) => {
                signal?.throwIfAborted();
                const composerRef = activeComposerRefRef.current;
                if (!composerPresentationMountedRef.current
                    || !('sessionId' in composerRef) || composerRef.sessionId !== sessionId
                    || !boardPresentationUndoCurrentRef.current
                    || !sessionAccountLifetime?.isCurrent()) {
                    return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                }
                const outcome = sessionPresentationApplierRef.current?.(input.intent);
                if (outcome?.status === 'applied' || outcome?.status === 'unchanged') {
                    return { status: outcome.status, revision: String(readActiveComposerPresentationRevision()) };
                }
                const errorCode = outcome?.status === 'invalidTarget' ? 'current_session_presentation_invalid_target'
                    : outcome?.status === 'notCurrent' ? 'current_session_presentation_not_current'
                    : 'target_unavailable';
                return { ok: false, errorCode, error: errorCode };
            },
        } } : {}),
        resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
        openSession: (sid, options) => {
            router.push(buildScopedSessionRouteHref({
                sessionId: sid,
                serverId: options?.serverId
                    ?? (sid === sessionId ? sessionRouteServerId : resolveServerIdForSessionIdFromLocalCache(sid))
                    ?? sessionRouteServerId,
                query: options?.query,
            }) as any);
        },
    }), [
        currentLifecycleAgentCapabilities,
        readActiveComposerPresentationRevision,
        router,
        sessionAccountScope,
        sessionAccountLifetime,
        sessionId,
        sessionRouteServerId,
    ]);
    // Reference search has no Account data, but it is still daemon work scoped to
    // the active Account. Borrow the incumbent lifetime as a currentness fence.
    const composerReferenceAccountLifetime = sessionAccountLifetime;
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
            serverId: sessionRouteServerId,
            projection,
            pluginUiProjection: daemonMergedProjection.inputs!.pluginUiProjection,
            isCurrent: () => (
                composerReferenceHostRef.current === host
                && composerReferenceAccountLifetime?.isCurrent() !== false
            ),
        };
        return host;
    }, [
        sessionRouteServerId,
        composerReferenceAccountLifetime,
        daemonMergedProjection.inputs?.pluginProjectionV2,
        daemonMergedProjection.inputs?.pluginUiProjection,
        daemonMergedProjection.phase,
        machineId,
        sessionId,
        surfaceFocused,
    ]);
    composerReferenceHostRef.current = composerReferenceHost;
    const composerDropReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const composerDropReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = daemonMergedProjection.inputs?.pluginProjectionV2;
        if (daemonMergedProjection.phase !== 'ready' || !projection || !machineId) return null;
        const host: ComposerReferenceSearchHost = {
            machineId, serverId: sessionRouteServerId, projection, pluginUiProjection: daemonMergedProjection.inputs!.pluginUiProjection,
            isCurrent: () => composerDropReferenceHostRef.current === host
                && isActiveComposerPresentationCurrent() && surfacePresented,
        };
        return host;
    }, [daemonMergedProjection.inputs?.pluginProjectionV2, daemonMergedProjection.inputs?.pluginUiProjection, daemonMergedProjection.phase,
        isActiveComposerPresentationCurrent, machineId, sessionRouteServerId, surfacePresented]);
    composerDropReferenceHostRef.current = composerDropReferenceHost;
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
        physicalTarget: sessionComposerRef,
        resourceContext: sessionComposerRef,
        machineId: machineId ?? null,
        serverId: sessionRouteServerId,
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
    const { snapshot: acpCatalog } = useAcpCatalogForServer(sessionRouteServerId);
    const sessionAgentCatalogEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        });
    }, [
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
        acpCatalog,
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
    // The embedded arm never mounts a voice surface or affordance, whatever the account enables.
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const usageLimitRecoveryFeatureEnabled = useFeatureEnabled('sessions.usageLimitRecovery', { scopeKind: 'spawn', serverId: sessionRouteServerId });
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    // Generalized goal umbrella gate (provider-agnostic). The provider-specific discriminator is the
    // capability gate `supportsEditableSessionGoals` (Codex: app-server mode; Claude: live runner
    // goal-control registration), so this stays a single umbrella flag for all providers.
    const agentGoalsFeatureEnabled = useFeatureEnabled('agents.goals');
    const sessionWorkStateSnapshot = React.useMemo(
        () => readSessionWorkStateFromMetadata(ownerMetadata),
        [ownerMetadata],
    );
    const primaryWorkStateItem = React.useMemo(
        () => readSessionWorkStatePrimaryItemV1(sessionWorkStateSnapshot?.items ?? [], sessionWorkStateSnapshot?.primaryItemId),
        [sessionWorkStateSnapshot],
    );
    const [activeStatusBadgeKey, setActiveStatusBadgeKey] = React.useState<string | null>(null);
    const appliedWorkStateRequestKeyRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (
            openWorkStateRequestKey === null
            || appliedWorkStateRequestKeyRef.current === openWorkStateRequestKey
        ) return;
        appliedWorkStateRequestKeyRef.current = openWorkStateRequestKey;
        setActiveStatusBadgeKey(SESSION_WORK_STATE_STATUS_BADGE_KEY);
    }, [openWorkStateRequestKey]);
    // Composer banner collapse is owned by ComposerBannerCollapseProvider (mounted above this
    // component) so a banner and the badge that toggles it agree even across subtrees, and so the
    // account-level "remember" preference decides between session-scoped and device-persisted state.
    const usageLimitRecoveryBanner = useComposerBannerCollapse('usageLimitRecovery');
    const staleSessionRunnerBanner = useComposerBannerCollapse('staleSessionRunner');
    const authRecoveryBanner = useComposerBannerCollapse('authRecovery');
    const externalTranscriptSnapshotBanner = useComposerBannerCollapse('externalTranscriptSnapshot');
    const agentTransitionOutcomeBanner = useComposerBannerCollapse('agentTransitionOutcome');
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
    const hasWriteAccess = hasSessionWriteAccess(session.access);
    // Changing the model is its own capability: text submission, or an embed credential that grants
    // `session.model.set` on its own (Change model without Send). The server rechecks the exact Action.
    const canSelectModel = hasWriteAccess || (embedded?.modelSelectionGranted === true && embedded.modelPicker === true);
    const sessionMachineRecord = useServerScopedMachine(sessionRouteServerId, typeof machineId === 'string' ? machineId : '');
    const sessionMachineInventorySettled = useIsMachineListSettled(sessionRouteServerId);
    const sessionMachineAccessRemoved = Boolean(isSessionAccessOwner(session.access, session.accessLevel)
        && machineId && sessionMachineInventorySettled && !sessionMachineRecord);
    // Reconnect and the existing exact Home AccountChange edge reread native
    // observations; this does not submit Start or introduce a consumer timer.
    const socketConnectionGeneration = useSocketStatus().lastConnectedAt;
    const managedWakeAuthorization = session.pendingActivationAuthorization
        && session.pendingActivationAuthorization.requestedAt > session.activeAt
        && session.pendingActivationAuthorization.managedWakeTargetV1
        ? session.pendingActivationAuthorization : null;
    const managedPendingObservation = useManagedPendingWakeObservation({
        sessionId, authorization: managedWakeAuthorization,
        accountLifetime: sessionAccountLifetime,
        reconnectSignal: socketConnectionGeneration,
    });
    const managedPendingMachine = managedPendingObservation.machine;
    const managedWakeInventoryStatus = useMachineListStatusForServer(sessionAccountScope?.serverId ?? '');
    const managedWakeController = useServerScopedMachine(sessionAccountScope?.serverId ?? '',
        managedPendingMachine?.controller.machineId ?? managedWakeAuthorization?.managedWakeTargetV1?.controller.machineId ?? '');
    const managedWakeProjection = React.useMemo(() => managedWakeAuthorization
        ? deriveManagedWakeProjection({
            managed: managedPendingMachine, activation: managedWakeAuthorization,
            pending: pendingMessages.find((message) => message.localId === managedWakeAuthorization.requestId) ?? null,
            runtimeResuming: sessionRuntimeStatusSource.resumingAt != null,
            pendingLoaded: pendingMessagesLoaded,
            pendingReadState,
            managedReadState: managedPendingObservation.kind,
            machineInventoryState: managedWakeInventoryStatus === 'loading' ? 'loading' : 'read',
        })
        : null, [managedPendingMachine, managedPendingObservation.kind, managedWakeInventoryStatus, managedWakeAuthorization, pendingMessages, pendingMessagesLoaded, pendingReadState, sessionRuntimeStatusSource.resumingAt]);
    const autoResumeAdmission = resolveSessionAutoResumeAdmissionV1({ metadata: ownerMetadata,
        archivedAt: session.archivedAt, machineAvailable: isMachineReachable, authorityAvailable: ownerMetadata !== null });
    const pendingActivationPresentation = React.useMemo(() => {
        // A Pending row can synchronize before an in-flight Agent transition
        // answers. The composer already owns that live submission and shows its
        // spinner, so the generic inactive-Session recovery must not compete with
        // it or imply that the reader should resume the source Agent. Once the
        // submission settles, the existing pending-activation owner resumes its
        // normal role without any transition-specific recovery path.
        if (isComposerSending) return null;
        return resolvePendingActivationBanner({
            authorization: session.pendingActivationAuthorization,
            activeAt: session.activeAt,
            active: session.active,
            machineReachable: machineReachability === 'unknown' ? null : isMachineReachable,
            canWrite: hasWriteAccess,
            resumingAt: sessionRuntimeStatusSource.resumingAt,
            pendingMessages,
            managedWakeProjection,
            autoResumeAdmission,
        });
    }, [autoResumeAdmission, hasWriteAccess, isComposerSending, isMachineReachable, machineReachability, managedWakeProjection, pendingMessages, session.active, session.activeAt, session.pendingActivationAuthorization, sessionRuntimeStatusSource.resumingAt]);
    const [pendingActivationActionBusy, setPendingActivationActionBusy] = React.useState(false);
    const goalControlMachineId = controlMachineTarget?.machineId ?? machineId;
    const goalControlMachineRecord = useMachine(typeof goalControlMachineId === 'string' ? goalControlMachineId : '');
    const daemonGoalControlsSupported = goalControlMachineRecord?.metadata?.daemonSessionGoalControlsSupported === true;
    // Each successful connect stamps a new value, which is exactly the lifetime a
    // continuation inspection may be trusted for.
    const temporaryComputerRecovery = useMaterializedTemporaryComputerSessionRecovery({
        sessionId,
        serverId: sessionRouteServerId,
        sessionPresent: true,
        retrySignal: socketConnectionGeneration,
    });
    const agentContinuationSource = React.useMemo(() => ({
        currentBackendTargetKey: providerAgentTargetKey,
        // Whether THIS Session's transcript is Happier's or its Agent's own, from
        // the canonical Session-scoped owner. The Agent-level `sessionStorage.direct`
        // capability is a different question — Claude Code and Codex both declare it
        // — so reading it here would block every ordinary Session.
        storageKind: getSessionStorageKind(session),
        canEditSession: hasWriteAccess,
        machinePresence: machineReachability === 'unknown' ? 'unknown' as const
            : machineReachability === 'reachable' ? 'online' as const : 'offline' as const,
        // The Session's transcript sequence, which only a written transcript
        // record advances. Zero is therefore the one state in which a switch
        // provably carries nothing — and it is read from the Session row the
        // screen already holds rather than from a transcript page that may not
        // be loaded.
        hasConversationToCarry: session.seq > 0,
    }), [hasWriteAccess, machineReachability, providerAgentTargetKey, session]);
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
        // The picker's detail contract names this `capabilityServerId`; this
        // Session's Home is the value it takes.
        capabilityServerId: sessionRouteServerId,
        machineId: typeof machineId === 'string' && machineId.length > 0 ? machineId : null,
        cwd: ownerMetadata?.path ?? null,
    }), [sessionRouteServerId, machineId, ownerMetadata?.path]);
    const currentAgentLabel = agentInputCore
        ? t(agentInputCore.displayNameKey)
        : formatAgentLikeIdForDisplay(agentInputAgentType);
    const managedWakeNames = React.useMemo(() => ({
        controllerName: managedWakeController ? getMachineSentenceName(managedWakeController) : t('common.machine'),
        machineName: managedPendingMachine?.launch.name ?? (sessionMachineRecord ? getMachineSentenceName(sessionMachineRecord) : t('common.machine')),
        homeName: resolveHomeDisplayLabel(getServerProfileById(sessionAccountScope?.serverId ?? ''), sessionAccountScope?.serverId ?? ''),
        agentName: currentAgentLabel,
    }), [managedWakeController, managedPendingMachine?.launch.name, sessionMachineRecord, sessionAccountScope?.serverId, currentAgentLabel]);
    // `sessions.agentSwitching` is server-represented and fails closed. The
    // canonical decision runtime reads the server bit as
    // `readServerEnabledBit(...) === true` and applies the catalog's dependency
    // closure, so this is the gate — not a second interpretation beside it. It is
    // read once, here, and handed to the one owner that can arm a switch.
    // Scoped to THIS Session's server, not the sidebar's selection. The switch
    // runs on the Session's machine against its own server; the daemon and
    // server enforce the current decision again before effects. An aggregate
    // over other selected servers would let an
    // unrelated server's setting decide whether this Session may switch Agent.
    const agentSwitchingDecision = useFeatureDecision('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: sessionRouteServerId,
    });
    // Read here rather than beside the composer's other draft work because the
    // armed Agent is a Session draft value like the rest, and the picker below is
    // the one owner that writes it.
    const inSessionAgentPicker = useInSessionAgentPickerControls({
        sessionId,
        accountScope: sessionAccountScope,
        accountScopeRevision: sessionAccountLifetime?.revision ?? null,
        accountScopeIsCurrent: sessionAccountLifetime?.isCurrent ?? null,
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
    const onAgentPickerVisibilityChange = React.useCallback((visible: boolean) => {
        inSessionAgentPicker.onAgentPickerVisibilityChange(visible);
        setProviderModelPickerDemanded(visible);
    }, [inSessionAgentPicker.onAgentPickerVisibilityChange]);
    // The Roles rail leads the engine popover: the session's role is a controlled value, and the
    // running Agent decides which roles "Start a new session" (S-5).
    const sessionRolesRail = useSessionRolesRailParams({ sessionId, serverId: sessionRouteServerId, currentAgentTargetKey: providerAgentTargetKey });
    const { composeAgentPickerOptions: composeInSessionAgentPickerOptions } = inSessionAgentPicker;
    const composeAgentPickerOptionsWithRoles = React.useCallback((
        currentAgentOptions: Parameters<typeof composeInSessionAgentPickerOptions>[0],
    ) => [
        buildRolesRailPickerOption(sessionRolesRail),
        ...composeInSessionAgentPickerOptions(currentAgentOptions),
    ], [composeInSessionAgentPickerOptions, sessionRolesRail]);
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
        // The live same-mount submission writes its durable snapshot before the
        // transition RPC starts. That ordering protects a remount, but it is not
        // evidence that this mount lost the RPC outcome. While the composer owns
        // the live promise, its spinner is the truthful state; only a later mount
        // with no live submission reconstructs outcome_unknown from the snapshot.
        if (isComposerSending) return;
        // A nested submission proves a transition left this mount, but carries no
        // daemon result to replay. Establish the same mount-local unknown outcome
        // the RPC path records before this composer can accept input, so the
        // existing disposition/reconciliation owner holds sends until canonical
        // custody has been read.
        const key = `${sessionAccountScopeKey}\u0000${sessionId}\u0000${submission.localId}`;
        const outcome = armedContinuationOutcome;
        const outcomeIsCurrent = outcome !== null
            && outcome.scopeKey === sessionAccountScopeKey
            && (outcome.kind === 'refusal' || outcome.sessionId === sessionId);
        if (outcomeIsCurrent || restoredArmedContinuationOutcomeKeyRef.current === key) return;
        restoredArmedContinuationOutcomeKeyRef.current = key;
        setArmedContinuationOutcome({
            kind: 'outcome',
            sessionId,
            scopeKey: sessionAccountScopeKey,
            result: { type: 'outcome_unknown', localId: submission.localId },
            intent,
            localId: submission.localId,
            reconciled: false,
        });
    }, [
        sessionAccountScopeKey,
        armedContinuationOutcome,
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.armedContinuationLocalId,
        inSessionAgentPicker.armedContinuationSubmission,
        inSessionAgentPicker.armedContinuationSubmissionIntent,
        isComposerSending,
        sessionId,
    ]);
    // The armed target, resolved once against the same catalog the rail offered
    // it from. The send control names it and the send path carries it, so both
    // read one value rather than each deriving its own label.
    const armedContinuationTarget = React.useMemo(() => {
        const intent = inSessionAgentPicker.armedContinuation;
        if (intent === null) return null;
        const entry = sessionAgentCatalogEntries.find((catalogEntry) => (
            catalogEntry.backendTargetKey === inSessionAgentPicker.agentPickerSelectedOptionId
            && catalogEntry.agentId === intent.selection.agentId
        ));
        const agentCatalogEntry = entry?.agentCatalogEntry;
        const identity = agentCatalogEntry?.identity ?? (agentCatalogEntry ? parseQualifiedPluginContributionKey(agentCatalogEntry.qualifiedId) : null);
        return {
            agentId: intent.selection.agentId,
            authoringTarget: agentCatalogEntry && identity ? {
                agentId: agentCatalogEntry.agentId,
                agentIdentity: identity,
                connectedAccounts: agentCatalogEntry.connectedAccounts,
            } : null,
            backendTargetKey: inSessionAgentPicker.agentPickerSelectedOptionId ?? undefined,
            label: entry?.title ?? intent.selection.agentId,
            agentCatalogEntry: entry?.agentCatalogEntry ?? null,
            agentIdentity: entry?.agentCatalogEntry?.identity ?? null,
            connectedAccounts: entry?.agentCatalogEntry?.connectedAccounts ?? [],
            // The picker's own words for the chosen model, so the composer's engine
            // chip names it exactly as the row the reader just tapped did.
            modelLabel: inSessionAgentPicker.armedContinuationModelLabel,
        };
    }, [
        inSessionAgentPicker.armedContinuation,
        inSessionAgentPicker.armedContinuationModelLabel,
        inSessionAgentPicker.agentPickerSelectedOptionId,
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
    // The Goal control's continuation owner (FIN 04 §5.5): this session, the machine whose daemon owns
    // its triggers, and whether its opened runtime keeps going on its own.
    const sessionNativeGoalOwner = resolveSessionNativeGoalOwner(session);
    const sessionGoalAgentLabel = agentCore ? t(agentCore.displayNameKey) : (agentId ? formatAgentLikeIdForDisplay(agentId) : '');
    const sessionGoalContinuation = React.useMemo(() => ({
        sessionId,
        machineId: typeof goalControlMachineId === 'string' ? goalControlMachineId : null,
        nativeGoalOwner: sessionNativeGoalOwner,
        agentLabel: sessionGoalAgentLabel,
    }), [goalControlMachineId, sessionGoalAgentLabel, sessionId, sessionNativeGoalOwner]);
    const sessionViewCaller = React.useMemo(() => {
        const caller = new AbortController();
        // Retained workspace destinations stay mounted while hidden. Their
        // observers retire with presentation, independently of keyboard focus.
        if (!surfacePresented) caller.abort();
        return caller;
    }, [sessionAccountLifetime, sessionId, surfacePresented]);
    React.useEffect(() => {
        const retirement = sessionAccountLifetime?.onRetire(() => sessionViewCaller.abort());
        return () => {
            retirement?.dispose();
            sessionViewCaller.abort();
        };
    }, [sessionAccountLifetime, sessionViewCaller]);
    const setSessionGoalForView = React.useCallback(
        async (request: SessionWorkStateGoalSetRequest, signal?: AbortSignal): Promise<SessionWorkStateOperationResult> => {
            if (!sessionAccountScope || !sessionAccountLifetime?.isCurrent()) {
                return {
                    ok: false as const,
                    error: 'Session Account authority is unavailable',
                };
            }
            const cancellation = mergeAbortSignals([sessionViewCaller.signal, signal]);
            try {
                const result = await actionExecutor.execute('session.goal.set', { sessionId, ...request }, {
                    surface: 'ui',
                    defaultSessionId: sessionId,
                    serverId: sessionAccountScope.serverId,
                    signal: cancellation.signal,
                });
                return readGoalOperationResult(result.ok ? result.result : result);
            } finally {
                cancellation.dispose();
            }
        },
        [actionExecutor, sessionAccountLifetime, sessionAccountScope, sessionViewCaller, sessionId],
    );
    const clearSessionGoalForView = React.useCallback(
        async (signal?: AbortSignal): Promise<SessionWorkStateOperationResult> => {
            if (!sessionAccountScope || !sessionAccountLifetime?.isCurrent()) {
                return {
                    ok: false as const,
                    error: 'Session Account authority is unavailable',
                };
            }
            const cancellation = mergeAbortSignals([sessionViewCaller.signal, signal]);
            try {
                const result = await actionExecutor.execute('session.goal.clear', { sessionId }, {
                    surface: 'ui',
                    defaultSessionId: sessionId,
                    serverId: sessionAccountScope.serverId,
                    signal: cancellation.signal,
                });
                return readGoalOperationResult(result.ok ? result.result : result);
            } finally {
                cancellation.dispose();
            }
        },
        [actionExecutor, sessionAccountLifetime, sessionAccountScope, sessionViewCaller, sessionId],
    );
    // UIW1 live workflow activity and the managed Workflow Runs whose provenance is this Session
    // (`originSessionId` is the canonical Run-list filter; the Session does not own these Runs and they
    // stay inspectable in Workflows after it ends). Both are read once, by the Work sources owner the
    // focused surface mounts above this view.
    const sessionWorkSources = useSessionWorkSources();
    const sessionWorkflowActivity = sessionWorkSources?.workflowActivity ?? EMPTY_SESSION_WORKFLOW_ACTIVITY;
    const sessionManagedWorkflowRuns = sessionWorkSources?.managedRuns ?? IDLE_SESSION_MANAGED_WORKFLOW_RUNS;
    // The badge's managed half. Observed activity has a headline and managed
    // Runs do not, so a managed-only Session had no badge — and therefore no
    // reachable popover — until this signal existed. The two lifecycles stay
    // two counts; neither owner interprets the other's.
    const sessionManagedWorkflowSignal = React.useMemo(
        () => summarizeSessionManagedWorkflowRuns(sessionManagedWorkflowRuns),
        [sessionManagedWorkflowRuns],
    );
    const openManagedWorkflowRun = React.useCallback((runId: string) => {
        router.push(createWorkflowRunRoute(runId, sessionRouteServerId) as never);
    }, [router, sessionRouteServerId]);
    // UIW2: the SINGLE compact above-AgentInput badge seam. Goal/task/todo priority is delegated to
    // the protocol resolver inside `resolveSessionActivityStatusBadgePresentation`; workflow headline
    // composition is layered on top. There is no second badge path that recomputes priority.
    const sessionWorkStateBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        const presentation = resolveSessionActivityStatusBadgePresentation({
            workStateSnapshot: sessionWorkStateSnapshot,
            workflowHeadline: sessionWorkflowActivity.headline,
            loadedWorkflowRunsById: sessionWorkflowActivity.loadedRunsById,
            managedWorkflowRuns: sessionManagedWorkflowSignal,
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
                // The canonical Workflow attention word, reused verbatim rather
                // than a second phrasing for the same fact.
                managedNeedsYou: () => t('workflows.run.needsYou'),
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
                    managedWorkflowRuns={sessionManagedWorkflowRuns}
                    onOpenManagedWorkflowRun={openManagedWorkflowRun}
                    editableGoal={canEditSessionGoals}
                    goalActionCapabilityProfile={sessionGoalActionCapabilityProfile}
                    onRequestClose={onRequestClose}
                    onSetGoal={canEditSessionGoals ? setSessionGoalForView : undefined}
                    onClearGoal={canEditSessionGoals ? clearSessionGoalForView : undefined}
                />
            ),
        }];
    }, [activeStatusBadgeKey, canEditSessionGoals, clearSessionGoalForView, openManagedWorkflowRun, sessionGoalActionCapabilityProfile, sessionManagedWorkflowRuns, sessionManagedWorkflowSignal, sessionWorkStateSnapshot, sessionWorkflowActivity, setSessionGoalForView]);
    const usageLimitRecoverySettings: UsageLimitRecoverySettings = React.useMemo(() => {
        return normalizeUsageLimitRecoverySettings(settings.usageLimitRecoverySettingsV1);
    }, [settings.usageLimitRecoverySettingsV1]);
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
    const sessionProviderUsageGaugeWindowModes = useSetting('sessionProviderUsageGaugeWindowModes');
    const connectedServicesQuotaPinnedMeterIdsByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
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
            agentId: agentId ?? '',
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
            connectedAccounts: currentSessionAgentCatalogEntry?.connectedAccounts ?? [],
        })
    ), [accountProfile?.connectedServicesV2, agentId, currentSessionAgentCatalogEntry?.connectedAccounts, ownerMetadata]);
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
    const connectedServiceQuotaLimitSelection = React.useMemo(() => {
        if (!connectedServiceQuotaProfileRef?.groupId) return undefined;
        const service = parseQualifiedPluginContributionKey(connectedServiceQuotaProfileRef.serviceKey);
        if (!service) return null;
        const group = accountProfile?.connectedAccountGroupsV4?.find((group) => (
            group.ref.groupId === connectedServiceQuotaProfileRef.groupId
            && group.ref.service.pluginId === service.pluginId
            && group.ref.service.localId === service.localId
        ));
        return group ? group.policy.quotaLimitSelection : null;
    }, [
        accountProfile?.connectedAccountGroupsV4,
        connectedServiceQuotaProfileRef?.groupId,
        connectedServiceQuotaProfileRef?.serviceKey,
    ]);
    const connectedServiceQuotaDisplaySnapshot = connectedServiceQuotaSnapshot;
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
        connectedServiceQuotaView: connectedServiceQuotaDisplaySnapshot,
    }), [
        agentId,
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaDisplaySnapshot,
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
        machineReachable: isMachineReachable,
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
        isMachineReachable,
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
        machineReachable: isMachineReachable,
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
        isMachineReachable,
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
            const sourceAccount = providerUsageConnectedServiceQuotaSnapshot;
            const pinnedService = sourceAccount?.serviceId === connectedServiceQuotaProfileRef.legacyServiceId
                ? parseQualifiedPluginContributionKey(connectedServiceQuotaProfileRef.serviceKey)
                : null;
            const additionalMeterIds = pinnedService && sourceAccount
                ? resolveQualifiedConnectedAccountProfilePreference({
                    valuesByKey: connectedServicesQuotaPinnedMeterIdsByKey,
                    service: pinnedService,
                    legacyServiceId: connectedServiceQuotaProfileRef.legacyServiceId,
                    accountId: sourceAccount.profileId,
                })
                : undefined;
            return computeConnectedServiceQuotaGaugeViewModel({
                snapshot: providerUsageConnectedServiceQuotaSnapshot,
                activeModelId: providerModelSelection?.ref.modelId ?? modelMode,
                additionalMeterIds,
                quotaLimitSelection: connectedServiceQuotaLimitSelection,
                windowMode: sessionProviderUsageGaugeWindowMode,
                windowModes: sessionProviderUsageGaugeWindowModes,
                nowMs: Date.now(),
                formatter: connectedServiceQuotaGaugeFormatter,
            });
        }
        const connectedServiceGauge = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: providerUsageConnectedServiceQuotaSnapshot,
            activeModelId: providerModelSelection?.ref.modelId ?? modelMode,
            quotaLimitSelection: connectedServiceQuotaLimitSelection,
            windowMode: sessionProviderUsageGaugeWindowMode,
            windowModes: sessionProviderUsageGaugeWindowModes,
            nowMs: Date.now(),
            formatter: connectedServiceQuotaGaugeFormatter,
        });
        if (connectedServiceGauge) return connectedServiceGauge;
        return computeProviderAccountUsageGaugeViewModel({
            snapshot: providerAccountUsageSnapshot,
            activeModelId: providerModelSelection?.ref.modelId ?? modelMode,
            // The snapshots hook already resolved this record's state, including the
            // failed-refresh case its retained snapshot cannot express on its own.
            state: providerAccountUsageSnapshot
                ? providerAccountUsageSnapshotStateByRecordId[providerAccountUsageSnapshot.recordId]
                    ?? 'not_loaded'
                : 'not_loaded',
            windowMode: sessionProviderUsageGaugeWindowMode,
            windowModes: sessionProviderUsageGaugeWindowModes,
            nowMs: Date.now(),
            formatter: connectedServiceQuotaGaugeFormatter,
        });
    }, [
        modelMode,
        providerModelSelection?.ref.modelId,
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaProfileRef,
        connectedServiceQuotasEnabled,
        connectedServiceQuotaLimitSelection,
        connectedServicesQuotaPinnedMeterIdsByKey,
        sessionProviderUsageGaugeWindowModes,
        providerUsageConnectedServiceQuotaProfileRef,
        providerUsageDisplaySource?.kind,
        providerUsageConnectedServiceQuotaSnapshot,
        providerAccountUsageSnapshot,
        providerAccountUsageSnapshotStateByRecordId,
        sessionProviderUsageGaugeMode,
        sessionProviderUsageGaugeWindowMode,
    ]);
    const sessionStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        const badges = [...usageLimitRecoveryBadges, ...staleSessionRunnerBadges, ...sessionWorkStateBadges];
        return badges.length > 0 ? badges : EMPTY_AGENT_INPUT_STATUS_BADGES;
    }, [sessionWorkStateBadges, staleSessionRunnerBadges, usageLimitRecoveryBadges]);
    React.useEffect(() => {
        if (shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey,
            hasPrimaryWorkStateItem: Boolean(primaryWorkStateItem),
            canShowEmptyGoalControls: canEditSessionGoals,
            hasActiveWorkflowRuns: sessionWorkflowActivity.activeRuns.length > 0,
            // Without this the popover the person just opened on a managed-only
            // Session closed under them on the next render.
            hasManagedWorkflowRuns: sessionManagedWorkflowSignal.activeCount > 0
                || sessionManagedWorkflowSignal.attentionCount > 0,
        })) return;
        if (usageLimitRecoveryPresentation && activeStatusBadgeKey === SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY) return;
        if (staleSessionRunnerPresentation && activeStatusBadgeKey === STALE_SESSION_RUNNER_STATUS_BADGE_KEY) return;
        setActiveStatusBadgeKey(null);
    }, [
        activeStatusBadgeKey,
        canEditSessionGoals,
        primaryWorkStateItem,
        sessionManagedWorkflowSignal,
        sessionWorkflowActivity.activeRuns.length,
        staleSessionRunnerPresentation,
        usageLimitRecoveryPresentation,
    ]);
    const handleStaleSessionRunnerRestart = React.useCallback(async () => {
        if (sessionViewCaller.signal.aborted) return;
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        if (!staleSessionRunnerRuntimeState || !staleSessionRunnerPresentation) return;
        setStaleSessionRunnerOperationStatus({
            fingerprint: staleSessionRunnerPresentation.fingerprint,
            status: { kind: 'pending' },
        });
        let result: Awaited<ReturnType<typeof restartSessionRunnerOnCurrentRuntime>>;
        try {
            result = await restartSessionRunnerOnCurrentRuntime({
                runtimeState: staleSessionRunnerRuntimeState,
                serverId: sessionRouteServerId,
                signal: sessionViewCaller.signal,
            });
        } catch (error) {
            if (sessionViewCaller.signal.aborted) return;
            throw error;
        }
        if (sessionViewCaller.signal.aborted) return;
        if (!result) {
            setStaleSessionRunnerOperationStatus(null);
            return;
        }
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
        sessionViewCaller,
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
    const applyUsageLimitRecoveryOperationStatus = React.useCallback((result: SessionUsageLimitRecoveryOperationResult): boolean => {
        const status = resolveSessionUsageLimitRecoveryOperationStatus(result.status);
        if (status === 'cancelled') {
            if (!result.ok) return false;
            markUsageLimitRecoveryIssueResolved();
            return true;
        }
        if (!status) return false;
        markCurrentUsageLimitRecoveryOperationStatus(status);
        return true;
    }, [markCurrentUsageLimitRecoveryOperationStatus, markUsageLimitRecoveryIssueResolved]);
    const { execute: executeRecoveryAction } = useMountedActionExecution(sessionAccountScope, { openOnRequest: true });
    const executeUsageLimitRecoveryAction = React.useCallback(async (
        actionId: 'session.usageLimit.checkNow' | 'session.usageLimit.waitResume.enable'
            | 'session.usageLimit.waitResume.cancel' | 'session.usageLimit.consumeResetCredit',
        input: unknown,
    ): Promise<SessionUsageLimitRecoveryOperationResult> => {
        const execution = await executeRecoveryAction(actionId, input, { defaultSessionId: sessionId, signal: sessionViewCaller.signal });
        const failure = !execution.ok ? SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(execution.details) : null;
        return normalizeSessionUsageLimitRecoveryOperationResultV1(execution.ok ? execution.result
            : failure?.success ? failure.data : execution, { sessionId });
    }, [executeRecoveryAction, sessionId, sessionViewCaller]);
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

        const execution = await executeRecoveryAction('connectedServices.quota.reset', {
            machineId: targetMachineId,
            serviceId: serviceId.data,
            profileId: params.profileRef.profileId,
            sourceSnapshotFetchedAtMs: params.snapshotFetchedAtMs,
            ...(params.providerCreditId ? { providerCreditId: params.providerCreditId } : {}),
        }, { defaultSessionId: sessionId, signal: sessionViewCaller.signal });
        if (sessionViewCaller.signal.aborted) return false;
        if (!execution.ok) {
            await Modal.alert(t('common.error'), execution.error || execution.errorCode);
            return false;
        }
        const result = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse(execution.result);
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
        sessionViewCaller,
        executeRecoveryAction,
        t,
    ]);
    const handleUsageLimitRecoveryAction = React.useCallback(async (kind: SessionUsageLimitRecoveryActionKind = usageLimitRecoveryPresentation?.banner.mode ?? 'enable') => {
        if (!usageLimitRecoveryPresentation) return;
        if (usageLimitRecoveryPendingActionRef.current) return;
        const showUsageLimitRecoveryOperationFailure = async (
            result: SessionUsageLimitRecoveryOperationFailureResult,
        ): Promise<void> => {
            if (sessionViewCaller.signal.aborted) return;
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
                    const result = await executeUsageLimitRecoveryAction('session.usageLimit.checkNow', {
                        sessionId,
                        ...(session.lastRuntimeIssue?.agentId ? { agentId: session.lastRuntimeIssue.agentId } : {}),
                        resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                    });
                    if (!result.ok) {
                        setUsageLimitRecoveryOperationStatus(null);
                        if (!applyUsageLimitRecoveryOperationStatus(result)) await showUsageLimitRecoveryOperationFailure(result);
                        return;
                    }
                    if (resolveSessionUsageLimitRecoveryOperationStatus(result.status) === 'ready') {
                        await handleReadyUsageLimitRecoveryResult({
                            sessionActive: session.active === true,
                            resumeInactiveSession: async () => (
                                await handleUsageLimitRecoveryResumeNowRef.current?.({ silent: true }) === true
                            ),
                            markReady: () => markCurrentUsageLimitRecoveryOperationStatus('ready'),
                        });
                        return;
                    }
                    if (!applyUsageLimitRecoveryOperationStatus(result)) setUsageLimitRecoveryOperationStatus(null);
                    return;
                }

                const resumed = await handleUsageLimitRecoveryResumeNowRef.current?.({ silent: false });
                if (resumed) {
                    markCurrentUsageLimitRecoveryOperationStatus('waiting');
                } else {
                    setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            if (kind === 'remember') {
                const result = await executeUsageLimitRecoveryAction('session.usageLimit.waitResume.enable', {
                    sessionId,
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    remember: true,
                    resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                });
                if (!result.ok) {
                    setUsageLimitRecoveryOperationStatus(null);
                    if (!applyUsageLimitRecoveryOperationStatus(result)) await showUsageLimitRecoveryOperationFailure(result);
                } else {
                    const saved = await executeRecoveryAction('settings.set', {
                        anchor: SESSION_PROVIDER_LIMITS_SETTINGS.settings.autoWait.anchor, value: true,
                    }, { defaultSessionId: sessionId, signal: sessionViewCaller.signal });
                    if (!saved.ok) await showUsageLimitRecoveryOperationFailure(saved);
                    if (!applyUsageLimitRecoveryOperationStatus(result)) setUsageLimitRecoveryOperationStatus(null);
                }
                return;
            }
            if (kind === 'forget') {
                const result = await executeUsageLimitRecoveryAction('session.usageLimit.waitResume.cancel', {
                    sessionId,
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                    ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                        ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                        : {}),
                });
                if (!result.ok) {
                    setUsageLimitRecoveryOperationStatus(null);
                    if (!applyUsageLimitRecoveryOperationStatus(result)) await showUsageLimitRecoveryOperationFailure(result);
                    return;
                }
                const saved = await executeRecoveryAction('settings.set', {
                    anchor: SESSION_PROVIDER_LIMITS_SETTINGS.settings.autoWait.anchor, value: false,
                }, { defaultSessionId: sessionId, signal: sessionViewCaller.signal });
                if (!saved.ok) {
                    setUsageLimitRecoveryOperationStatus(null);
                    await showUsageLimitRecoveryOperationFailure(saved);
                    return;
                }
                if (!applyUsageLimitRecoveryOperationStatus(result)) setUsageLimitRecoveryOperationStatus(null);
                return;
            }

            if (kind === 'consume_reset_credit' && connectedServiceQuotaProfileIdentity && connectedServiceQuotaProfileKey) {
                await consumeConnectedServiceRecoveryCreditForProfile({
                    profileRef: connectedServiceQuotaProfileIdentity,
                    profileKey: connectedServiceQuotaProfileKey,
                    snapshotFetchedAtMs: connectedServiceQuotaSnapshot?.fetchedAt ?? null,
                });
                return;
            }

            const result = kind === 'cancel'
                ? await executeUsageLimitRecoveryAction('session.usageLimit.waitResume.cancel', {
                    sessionId,
                    issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    armedAtMs: usageLimitRecoveryPresentation.armedAtMs,
                    ...(usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId
                        ? { runtimeAuthRecoveryAttemptId: usageLimitRecoveryPresentation.runtimeAuthRecoveryAttemptId }
                        : {}),
                })
                : kind === 'consume_reset_credit'
                    ? await executeUsageLimitRecoveryAction('session.usageLimit.consumeResetCredit', {
                        sessionId,
                        ...(session.lastRuntimeIssue?.agentId ? { agentId: session.lastRuntimeIssue.agentId } : {}),
                        issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                    })
                    : isUsageLimitRecoverySwitchAction(kind)
                        ? await executeUsageLimitRecoveryAction('session.usageLimit.checkNow', {
                            sessionId, operation: 'switch_account_now',
                            ...(session.lastRuntimeIssue?.agentId ? { agentId: session.lastRuntimeIssue.agentId } : {}),
                        })
                        : isSessionUsageLimitRecoveryCheckNowAction(kind)
                            ? await executeUsageLimitRecoveryAction('session.usageLimit.checkNow', {
                                sessionId,
                                ...(session.lastRuntimeIssue?.agentId ? { agentId: session.lastRuntimeIssue.agentId } : {}),
                                resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                            })
                            : await executeUsageLimitRecoveryAction('session.usageLimit.waitResume.enable', {
                                sessionId,
                                issueFingerprint: usageLimitRecoveryPresentation.issueFingerprint,
                                remember: usageLimitRecoverySettings.mode === 'auto_wait',
                                resumePromptMode: usageLimitRecoverySettings.resumePromptMode ?? 'standard',
                            });
            if (!result.ok) {
                setUsageLimitRecoveryOperationStatus(null);
                if (!applyUsageLimitRecoveryOperationStatus(result)) await showUsageLimitRecoveryOperationFailure(result);
                return;
            }
            if (usageLimitRecoveryPresentation.banner.temporaryThrottle) {
                // Dispatch/cancellation acknowledgements do not prove provider recovery.
                setUsageLimitRecoveryOperationStatus(null);
                return;
            }
            if (!applyUsageLimitRecoveryOperationStatus(result)) setUsageLimitRecoveryOperationStatus(null);
        } finally {
            setUsageLimitRecoveryOperationStatus((current) => current?.status === 'checking' ? null : current);
            usageLimitRecoveryPendingActionRef.current = false;
            setUsageLimitRecoveryPendingAction(null);
        }
    }, [
        accountProfile?.connectedServicesV2,
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        applyUsageLimitRecoveryOperationStatus,
        connectedServiceQuotaProfileKey,
        connectedServiceQuotaProfileIdentity,
        connectedServiceQuotaSnapshot?.fetchedAt,
        consumeConnectedServiceRecoveryCreditForProfile,
        session.active,
        session.lastRuntimeIssue?.agentId,
        sessionId,
        executeRecoveryAction,
        executeUsageLimitRecoveryAction,
        router,
        sessionViewCaller,
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

            const recoveryAgentId = session.lastRuntimeIssue?.agentId ?? providerAccountUsageSnapshot?.providerId;
            const result = await executeUsageLimitRecoveryAction('session.usageLimit.consumeResetCredit', {
                sessionId,
                ...(recoveryAgentId ? { agentId: recoveryAgentId } : {}),
                ...(baseUsageLimitRecoveryPresentation?.issueFingerprint
                    ? { issueFingerprint: baseUsageLimitRecoveryPresentation.issueFingerprint } : {}),
            });
            if (!result.ok) {
                await Modal.alert(t('common.error'), formatUsageLimitRecoveryOperationError(result));
                return;
            }
            applyUsageLimitRecoveryOperationStatus(result);
        } finally {
            setProviderUsageRecoveryCreditPending(false);
        }
    }, [
        connectedServiceQuotaProfileKey,
        consumeConnectedServiceRecoveryCreditForProfile,
        handleUsageLimitRecoveryAction,
        markCurrentUsageLimitRecoveryOperationStatus,
        markUsageLimitRecoveryIssueResolved,
        applyUsageLimitRecoveryOperationStatus,
        providerAccountUsageSnapshot?.providerId,
        providerUsageConnectedServiceQuotaProfileRef,
        providerUsageGauge?.recoveryCreditSummary,
        providerUsageRecoveryCreditPending,
        session.lastRuntimeIssue?.agentId,
        sessionId,
        executeUsageLimitRecoveryAction,
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
    // Near-limit banner (lab csvc G1): at danger, with a known usage reset to apply, once per window.
    const [nearLimitDismissedKeys, setNearLimitDismissedKeys] = React.useState(readDismissedSessionNearLimitKeys);
    const nearLimitPresentation = buildSessionNearLimitPresentation({
        accountKey: connectedServiceQuotaProfileKey ?? null,
        accountLabel: providerUsageGauge?.activeAccountDisplayLabel ?? null,
        remainingPct: providerUsageGauge?.remainingPct ?? null,
        meter: providerUsageGauge
            ? {
                meterId: providerUsageGauge.effectiveMeter.meterId,
                label: providerUsageGauge.effectiveMeter.label,
                resetsAt: providerUsageGauge.effectiveMeter.resetsAt ?? null,
            }
            : null,
        resetAvailable: Boolean(providerUsageRecoveryCreditAction && providerUsageGauge?.recoveryCreditSummary),
        limitReached: Boolean(usageLimitRecoveryPresentation),
        dismissedKeys: nearLimitDismissedKeys,
    });
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
    const reviewScope = useWorkspaceScopeForSession(sessionId, sessionRouteServerId);
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
                store.deleteWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draft.id, draft);
            } else {
                store.deleteSessionReviewCommentDraft(sessionId, draft.id, draft);
            }
        }
    }, [includedReviewCommentDrafts, reviewWorkspaceCacheKey, sessionId]);

    const attachmentsUploadConfig = useAttachmentsUploadConfig();
    const mainAttachmentDraftAccountId = sessionAccountScope
        && areServerProfileIdentifiersEquivalent(sessionAccountScope.serverId, sessionRouteServerId)
        ? sessionAccountScope.accountId
        : null;
    const mainAttachmentDraftScope = React.useMemo<SessionAttachmentDraftScope | null>(() => (
        mainAttachmentDraftAccountId
            ? {
                serverId: sessionRouteServerId,
                accountId: mainAttachmentDraftAccountId,
                sessionId,
                occurrenceId: composerRefV1Key({ kind: 'session', sessionId }),
            }
            : null
    ), [mainAttachmentDraftAccountId, sessionId, sessionRouteServerId]);
    const readMainAttachmentDrafts = React.useCallback(() => (
        mainAttachmentDraftScope && sessionAccountLifetime?.isCurrent()
            ? readSessionAttachmentDrafts(mainAttachmentDraftScope)
            : []
    ), [mainAttachmentDraftScope, sessionAccountLifetime]);
    const writeMainAttachmentDrafts = React.useCallback((drafts: readonly AttachmentDraft[]) => {
        if (mainAttachmentDraftScope && sessionAccountLifetime?.isCurrent()) {
            writeSessionAttachmentDrafts(mainAttachmentDraftScope, drafts);
        }
    }, [mainAttachmentDraftScope, sessionAccountLifetime]);
    const clearMainAttachmentDrafts = React.useCallback(() => {
        if (mainAttachmentDraftScope && sessionAccountLifetime?.isCurrent()) {
            clearSessionAttachmentDrafts(mainAttachmentDraftScope);
        }
    }, [mainAttachmentDraftScope, sessionAccountLifetime]);
    const initialSessionAttachmentDrafts = React.useMemo(() => {
        if (initialAttachmentDrafts && initialAttachmentDrafts.length > 0) {
            return initialAttachmentDrafts;
        }
        return readMainAttachmentDrafts();
    }, [initialAttachmentDrafts, readMainAttachmentDrafts]);

    const attachmentDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsAvailable,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
        initialDrafts: initialSessionAttachmentDrafts,
        eagerUpload: { sessionId, config: attachmentsUploadConfig },
        onPickedDrafts: (drafts) => {
            if (!sessionAccountLifetime?.isCurrent()) return;
            insertMountedComposerAttachmentReferences({ ref: activeComposerRefRef.current,
                scope: sessionAccountLifetime.scope, drafts });
        },
        onRemoveDraft: (attachmentId) => {
            if (!sessionAccountLifetime?.isCurrent()) return;
            removeMountedComposerAttachmentReferences({ ref: activeComposerRefRef.current,
                scope: sessionAccountLifetime.scope, attachmentId });
        },
    });
    const filePickerRef = attachmentDraftManager.filePickerRef;
    const attachmentDrafts = attachmentDraftManager.drafts;
    const getAttachmentDraftsSnapshot = attachmentDraftManager.getDraftsSnapshot;
    const agentInputAttachments = attachmentDraftManager.agentInputAttachments;
    const addAttachments = attachmentDraftManager.addWebFiles;
    const addPickedAttachments = attachmentDraftManager.addPickedAttachments;
    const patchAttachmentDraft = attachmentDraftManager.applyDraftPatch;
    // Stable callback: feeds the transcript onEditPendingMessage chain, whose identity
    // gates ChatList/view-holder re-renders.
    const replaceAttachmentManagerDrafts = attachmentDraftManager.replaceDrafts;
    const activeAttachmentDraftScopeRef = React.useRef(mainAttachmentDraftScope);

    React.useEffect(() => {
        // A SessionView can be retained while its qualified route changes. Do
        // not project the previous Home's still-rendered drafts into the new
        // scope during that transition; the following effect hydrates the
        // manager from the new owner first.
        if (activeAttachmentDraftScopeRef.current !== mainAttachmentDraftScope) return;
        writeMainAttachmentDrafts(attachmentDrafts);
    }, [attachmentDrafts, mainAttachmentDraftScope, writeMainAttachmentDrafts]);
    React.useEffect(() => {
        if (activeAttachmentDraftScopeRef.current === mainAttachmentDraftScope) return;
        activeAttachmentDraftScopeRef.current = mainAttachmentDraftScope;
        replaceAttachmentManagerDrafts(readMainAttachmentDrafts());
    }, [mainAttachmentDraftScope, readMainAttachmentDrafts, replaceAttachmentManagerDrafts]);
    const applyAttachmentDraftPatch = React.useCallback((
        draftId: string,
        patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>,
        expectedSource?: AttachmentDraft['source'],
    ) => {
        patchAttachmentDraft(draftId, patch, expectedSource);
        writeMainAttachmentDrafts(getAttachmentDraftsSnapshot());
    }, [getAttachmentDraftsSnapshot, patchAttachmentDraft, writeMainAttachmentDrafts]);
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
        accountLifetime: sessionAccountLifetime,
        draftPersistence: {
            sessionId,
            surface: 'mainComposer',
        },
    });

    useScmSessionAutoRefresh({ sessionId, serverId: sessionRouteServerId, intervalMs: scmSessionAutoRefreshIntervalMs });

    // This view already holds its own Session's exact Home-qualified identity.
    // Only a different, genuinely unqualified target consults the fail-closed
    // bare resolver, which stays ambiguity-safe by returning null.
    const resolveNavigationServerIdForSessionId = React.useCallback((sid: string) => (
        sid === sessionId
            ? sessionRouteServerId
            : resolveServerIdForSessionIdFromLocalCache(sid) ?? sessionRouteServerId
    ), [sessionId, sessionRouteServerId]);
    const buildSessionHref = React.useCallback((sid: string, suffix = '') => {
        return buildScopedSessionRouteHref({
            sessionId: sid,
            serverId: resolveNavigationServerIdForSessionId(sid),
            suffix,
        });
    }, [resolveNavigationServerIdForSessionId]);
    const buildCurrentSessionHref = React.useCallback((suffix = '') => {
        return buildSessionHref(sessionId, suffix);
    }, [buildSessionHref, sessionId]);

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
    const activeArmedContinuationOutcome = armedContinuationOutcome?.scopeKey === sessionAccountScopeKey
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
            if (current === null || current.scopeKey !== sessionAccountScopeKey) return null;
            return current.kind === 'outcome' && current.sessionId !== sessionId ? null : current;
        });
    }, [sessionAccountScopeKey, sessionId]);
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
                    && current.scopeKey === sessionAccountScopeKey
                    && current.sessionId === sessionId
                    && !current.reconciled
                    ? { ...current, reconciled: true }
                    : current
            ));
        });
        return () => { cancelled = true; };
    }, [sessionAccountScopeKey, armedContinuationAwaitingReconcile, sessionId, sessionRouteServerId]);

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
        serverId: sessionRouteServerId,
        settings,
        enabled: !isSessionActive || supportsLocalControl,
    });

    // A pre-start death (no vendor resume id ever persisted) stays continuable by fresh
    // spawn instead of dead-ending in a "can't restore context" notice (QA A-F5).
    const isResumable = React.useMemo(
        () => canResumeSessionWithOptions(ownerMetadata, resumeCapabilityOptions)
            || canContinueSessionWithFreshSpawn(ownerMetadata, resumeCapabilityOptions),
        [ownerMetadata, resumeCapabilityOptions],
    );
    const isResuming = sessionStatus.state === 'resuming';
    const sessionSubmitPort = React.useMemo(() => createSyncBackedSubmitPort(sync), []);
    const readLatestSessionForSubmit = React.useCallback(() => {
        const state = storage.getState();
        return selectSessionViewShellSessionForRouteState({
            sessions: state.sessions,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
        }, sessionId, routeServerId) ?? session;
    }, [routeServerId, session, sessionId]);
    const persistedVoiceComposerRouting = resolveVoiceSessionComposerRouting({
        conversationSessionId: sessionId,
        sessionMetadata: ownerMetadata,
    });

    const pendingComposerEditExposedSuccessorRef = React.useRef<PendingMessageComposerExposedSuccessor | null>(null);
    const {
        clearDraft,
        clearDraftForSessionIfCurrentValueMatches,
        readLatestDraftValue,
        restoreDraftForSessionIfCurrentValueMatches,
        setDraftValue,
        restoreDraft,
        restoreComposerSnapshot,
    } = useDraft(sessionId, composerTextStore, {
        accountLifetime: sessionAccountLifetime,
        retainProjectionOnAccountRetirement: isEmbedWindowContext(),
        session,
        active: surfacePresented,
    });
    const sessionDraftAddress = React.useMemo(() => ({
        kind: 'session' as const,
        sessionId,
    }), [sessionId]);
    const subscribeCurrentSessionDraft = React.useCallback((listener: () => void) => (
        sessionAccountScope && sessionAccountLifetime?.isCurrent()
            ? subscribeSessionDraft(sessionAccountScope, sessionDraftAddress, listener)
            : () => undefined
    ), [sessionAccountLifetime, sessionAccountScope, sessionDraftAddress]);
    const getCurrentSessionDraftSnapshot = React.useCallback(() => (
        sessionAccountScope && sessionAccountLifetime?.isCurrent()
            ? getSessionDraftSnapshot(sessionAccountScope, sessionDraftAddress)
            : null
    ), [sessionAccountLifetime, sessionAccountScope, sessionDraftAddress]);
    // The view shows the draft's sync status and conflict, not its text: select those, so the
    // repository write behind every keystroke does not re-render the whole view.
    const readCurrentSessionDraftConflict = React.useCallback(
        () => getCurrentSessionDraftSnapshot()?.conflict ?? null,
        [getCurrentSessionDraftSnapshot],
    );
    const readCurrentSessionDraftStatus = React.useCallback(
        () => getCurrentSessionDraftSnapshot()?.status ?? 'clean',
        [getCurrentSessionDraftSnapshot],
    );
    const currentSessionDraftConflict = React.useSyncExternalStore(
        subscribeCurrentSessionDraft,
        readCurrentSessionDraftConflict,
        readCurrentSessionDraftConflict,
    );
    const currentSessionDraftStatus = React.useSyncExternalStore(
        subscribeCurrentSessionDraft,
        readCurrentSessionDraftStatus,
        readCurrentSessionDraftStatus,
    );
    const readNextPromptPermissionMode = React.useCallback(() => readSessionNextPromptPermissionModeFromDraft(
        getCurrentSessionDraftSnapshot()?.document,
    ), [getCurrentSessionDraftSnapshot]);
    const nextPromptPermissionMode = React.useSyncExternalStore(
        subscribeCurrentSessionDraft, readNextPromptPermissionMode, readNextPromptPermissionMode,
    );
    const selectedPermissionMode = nextPromptPermissionMode ?? liveComposerState.permissionMode;
    const permissionMode = embedded?.permissionModePicker
        ? resolveEffectiveApiTokenPermissionModeV1({ permissionModes: [...embedded.permissionModePicker] }, selectedPermissionMode)
            ?? selectedPermissionMode
        : selectedPermissionMode;
    const draftConflictBanner = useSessionDraftConflictComposerBanner(currentSessionDraftConflict);
    const draftSyncStatusBadge = React.useMemo(
        () => buildSessionDraftSyncStatusBadge(currentSessionDraftStatus),
        [currentSessionDraftStatus],
    );
    const setComposerDraftValue = React.useCallback((nextValueOrUpdater: React.SetStateAction<string>) => {
        setDraftValue((currentValue) => {
            const nextValue = typeof nextValueOrUpdater === 'function'
                ? (nextValueOrUpdater as (value: string) => string)(currentValue)
                : nextValueOrUpdater;
            if (!sessionAccountScope || !sessionAccountLifetime?.isCurrent()) {
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
            return nextValue;
        });
    }, [
        sessionAccountLifetime,
        sessionAccountScope,
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
        accountLifetime: ServerAccountScopeLifetime | null,
    ) => {
        if (accountLifetime && !accountLifetime.isCurrent()) return;
        const run = pendingMessageEditHoldPatchRef.current
            .catch(() => undefined)
            .then(() => {
                if (accountLifetime && !accountLifetime.isCurrent()) return;
                return sync.patchSessionMetadataWithRetry(sessionId, updater, {
                    serverId: routeServerId,
                    ...(accountLifetime ? { accountLifetime } : {}),
                });
            });
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
            edit.accountLifetime,
        );
    }, [patchPendingMessageEditHoldMetadata]);
    const clearPendingMessageEditDrainHold = React.useCallback((edit: PendingMessageComposerEditState) => {
        if (edit.holdId.trim().length === 0) return;
        patchPendingMessageEditHoldMetadata(
            (metadata) => removeSessionPendingQueueHoldV1FromMetadata(metadata, edit.holdId) as Metadata,
            'SessionView.pendingMessageEdit.hold.clear',
            edit.accountLifetime,
        );
    }, [patchPendingMessageEditHoldMetadata]);
    const captureComposerSemanticDraftSnapshot = React.useCallback((): ComposerSemanticDraftSnapshot => {
        const snapshot = {} as {
            [FieldId in SessionDraftValueFieldId]: ComposerSemanticDraftSnapshot[FieldId];
        };
        const document = existingSessionComposerOwner.read().document;
        snapshot['structuredInput.mentions'] = document.structuredInputMentions;
        snapshot['structuredInput.composerAttachments'] = document.composerAttachments;
        if (sessionAccountScope && sessionAccountLifetime?.isCurrent()) {
            const stored = getSessionDraftSnapshot(
                sessionAccountScope,
                { kind: 'session', sessionId },
            );
            if (stored?.document.target.kind === 'session') {
                const routing = stored.document.target.routing;
                const recipientValue = routing.recipient.value;
                const recipient = recipientValue && typeof recipientValue === 'object' && !Array.isArray(recipientValue)
                    && 'mode' in recipientValue && recipientValue.mode === 'manual'
                    ? createStoredReadSchema(SESSION_DRAFT_VALUE_SCHEMAS['routing.recipient']).safeParse(recipientValue.recipient)
                    : null;
                if (recipient?.success) snapshot['routing.recipient'] = recipient.data;
                const continuation = createStoredReadSchema(SESSION_DRAFT_VALUE_SCHEMAS['routing.agentContinuation'])
                    .safeParse(routing.agentContinuation.value);
                if (continuation.success) snapshot['routing.agentContinuation'] = continuation.data;
                snapshot['routing.executionRunRequestedAction'] = readExecutionRunRequestedAction(
                    routing.executionRunDelivery.value,
                );
                const selectionSource = readSessionDiscussionSelectionSourceFromDraft(stored.document);
                if (selectionSource && areServerProfileIdentifiersEquivalent(selectionSource.serverId, sessionAccountScope.serverId)) {
                    snapshot['structuredInput.sessionDiscussionSelectionSourceV1'] = selectionSource;
                }
            }
        }
        return snapshot;
    }, [existingSessionComposerOwner, sessionAccountLifetime, sessionAccountScope, sessionId]);
    const captureComposerSemanticDraftCurrentnessSnapshot = React.useCallback((): ComposerSemanticDraftCurrentnessSnapshot => ({
        values: captureComposerSemanticDraftSnapshot(),
        repositoryCurrentness: sessionAccountScope && sessionAccountLifetime?.isCurrent()
            ? captureSessionDraftCurrentness({
                scope: sessionAccountScope,
                address: { kind: 'session', sessionId },
            })
            : { address: { kind: 'session', sessionId }, mutationIds: {} },
        composerCurrentness: existingSessionComposerOwner.captureCurrentness(),
    }), [captureComposerSemanticDraftSnapshot, existingSessionComposerOwner, sessionAccountLifetime, sessionAccountScope, sessionId]);
    const clearSemanticDraftValuesAfterOutboundHandoff = React.useCallback((
        snapshot: ComposerSemanticDraftCurrentnessSnapshot,
        options?: Readonly<{ repositoryFieldIds: readonly string[] }>,
    ): ComposerSemanticDraftClearResult => {
        const composerClear = existingSessionComposerOwner.clearAccepted(snapshot.composerCurrentness);
        const changed = sessionAccountScope && sessionAccountLifetime?.isCurrent()
            ? clearSessionDraftCurrentnessLocal({
                scope: sessionAccountScope,
                address: { kind: 'session', sessionId },
                currentness: snapshot.repositoryCurrentness,
                fieldIds: options?.repositoryFieldIds ?? [
                    'target.routing.recipient',
                    'target.routing.agentContinuation',
                    'target.routing.executionRunDelivery',
                    'extensions.happier.sessionDiscussionSelectionSourceV1',
                    'extensions.happier.nextPromptPermissionModeV1',
                ],
            })
            : false;
        if (changed && sessionAccountScope && sessionAccountLifetime?.isCurrent()) {
            void flushSessionDraft({
                scope: sessionAccountScope,
                address: { kind: 'session', sessionId },
            });
        }
        const afterValues = captureComposerSemanticDraftSnapshot();
        const cleared: SessionDraftValueFieldId[] = [];
        if (composerClear.changes.structuredInputMentions) cleared.push('structuredInput.mentions');
        if (composerClear.changes.composerAttachments) cleared.push('structuredInput.composerAttachments');
        if (changed) {
            for (const fieldId of [
                'routing.recipient',
                'routing.agentContinuation',
                'routing.executionRunRequestedAction',
                'structuredInput.sessionDiscussionSelectionSourceV1',
            ] as const) {
                if (!sameStrictJsonValue(
                    snapshot.values[fieldId] ?? null,
                    afterValues[fieldId] ?? null,
                )) {
                    cleared.push(fieldId);
                }
            }
        }
        if (cleared.includes('structuredInput.composerAttachments')) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return { clearedFieldIds: cleared, textCleared: composerClear.changes.text };
    }, [captureComposerSemanticDraftSnapshot, existingSessionComposerOwner, sessionAccountLifetime, sessionAccountScope, sessionId]);
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
        if (!sessionAccountScope || !sessionAccountLifetime?.isCurrent()) return [];
        const currentness = captureSessionDraftCurrentness({
            scope: sessionAccountScope,
            address: { kind: 'session', sessionId },
        });
        const pathByField: Readonly<Record<SessionDraftValueFieldId, string>> = {
            'structuredInput.mentions': 'composer.mentions',
            'structuredInput.composerAttachments': 'composer.attachments',
            'routing.recipient': 'target.routing.recipient',
            'routing.agentContinuation': 'target.routing.agentContinuation',
            'routing.executionRunRequestedAction': 'target.routing.executionRunDelivery',
            'structuredInput.sessionDiscussionSelectionSourceV1': 'extensions.happier.sessionDiscussionSelectionSourceV1',
        };
        const fieldsToRestore = candidateFields.filter((fieldId) => {
            const path = pathByField[fieldId];
            return currentness.mutationIds[path] === input.clearedSnapshot.repositoryCurrentness.mutationIds[path];
        });
        const values = input.snapshot.values;
        const restoreMentions = fieldsToRestore.includes('structuredInput.mentions');
        const restoreAttachments = fieldsToRestore.includes('structuredInput.composerAttachments');
        if (restoreMentions || restoreAttachments) {
            const currentOwner = existingSessionComposerOwner.read();
            existingSessionComposerOwner.apply(currentOwner.revision, {
                text: currentOwner.document.text,
                references: restoreMentions
                    ? [...composerReferencesFromStructuredMentions({
                        text: currentOwner.document.text,
                        mentions: (values['structuredInput.mentions'] ?? []) as ComposerStructuredInputMention[],
                    })]
                    : [...composerReferencesFromStructuredMentions({
                        text: currentOwner.document.text,
                        mentions: currentOwner.document.structuredInputMentions,
                    })],
                attachments: (restoreAttachments
                    ? (values['structuredInput.composerAttachments'] ?? [])
                    : currentOwner.document.composerAttachments)
                    .map((attachment) => composerAttachmentDraftToView(attachment as ComposerAttachmentDraftV1, {
                        entriesById: composerAttachmentAvailabilityEntriesById,
                    })),
            });
        }
        writeExistingSessionDraft({
            scope: sessionAccountScope,
            sessionId,
            patch: {
                ...(fieldsToRestore.includes('structuredInput.sessionDiscussionSelectionSourceV1')
                    ? {
                        sessionDiscussionSelectionSourceV1:
                            values['structuredInput.sessionDiscussionSelectionSourceV1'] ?? null,
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
                    ...(fieldsToRestore.includes('routing.executionRunRequestedAction')
                        ? {
                            executionRunRequestedAction: StrictJsonValueSchema.parse(
                                values['routing.executionRunRequestedAction'] ?? null,
                            ),
                        }
                        : {}),
                },
            },
        });
        if (fieldsToRestore.includes('structuredInput.composerAttachments')) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return fieldsToRestore;
    }, [
        sessionAccountLifetime,
        sessionAccountScope,
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
        armedContinuationSubmission: liveArmedContinuationSubmission,
        clearArmedContinuationSubmissionIfCurrent: clearPersistedArmedContinuationSubmissionIfCurrent,
    } = inSessionAgentPicker;
    const { clearTransientInputState } = inputComposerPersistence;
    const clearArmedContinuationSubmissionIfCurrent = React.useCallback((
        submission: SessionArmedAgentContinuationSubmission,
    ): boolean => {
        if (!sessionAccountLifetime?.isCurrent()) return false;
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

        const modeMutationId = currentness?.nextPromptPermissionModeMutationId;
        const didClearNextPromptPermissionMode = modeMutationId !== undefined && sessionAccountScope !== null
            ? clearSessionDraftCurrentnessLocal({
                scope: sessionAccountScope,
                address: { kind: 'session', sessionId },
                currentness: {
                    address: { kind: 'session', sessionId },
                    mutationIds: { 'extensions.happier.nextPromptPermissionModeV1': modeMutationId },
                },
                fieldIds: ['extensions.happier.nextPromptPermissionModeV1'],
            })
            : false;
        if (didClearNextPromptPermissionMode && sessionAccountScope) {
            void flushSessionDraft({ scope: sessionAccountScope, address: { kind: 'session', sessionId } });
        }

        let didClearAttachmentDrafts = false;
        if (currentness && currentness.attachmentDraftIds.length > 0) {
            const submittedAttachmentDraftIds = new Set(currentness.attachmentDraftIds);
            const currentAttachmentDrafts = getAttachmentDraftsSnapshot();
            const nextAttachmentDrafts = currentAttachmentDrafts.filter((draft) => (
                !submittedAttachmentDraftIds.has(draft.id)
            ));
            if (nextAttachmentDrafts.length !== currentAttachmentDrafts.length) {
                if (nextAttachmentDrafts.length === 0) {
                    clearMainAttachmentDrafts();
                } else {
                    writeMainAttachmentDrafts(nextAttachmentDrafts);
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

        return didClearComposer || didClearNextPromptPermissionMode || didClearAttachmentDrafts || didClearReviewComments;
    }, [
        sessionAccountLifetime,
        sessionAccountScope,
        composerAttachmentAvailabilityEntriesById,
        existingSessionComposerOwner,
        clearDraftForSessionIfCurrentValueMatches,
        clearMainAttachmentDrafts,
        clearSentReviewCommentDrafts,
        clearTransientInputState,
        getAttachmentDraftsSnapshot,
        includedReviewCommentDrafts,
        replaceAttachmentManagerDrafts,
        sessionId,
        writeMainAttachmentDrafts,
    ]);
    const appliedArmedContinuationDraftClearRef = React.useRef<string | null>(null);
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
        // Immediate admission and delayed/remounted custody consume the same
        // exact snapshot. Draft currentness controls which composer values can
        // be removed; the picker spends its matching live and persisted arm.
        const submission = liveArmedContinuationSubmission;
        if (!submission) return;
        const outcome = activeArmedContinuationOutcome;
        const admitted = outcome?.kind === 'outcome'
            && outcome.sessionId === sessionId
            && outcome.localId === submission.localId
            && armedContinuationDisposition?.draft === 'clear';
        if (!admitted && armedContinuationSubmissionCustody === 'absent') return;
        const clearKey = `${sessionAccountScopeKey}\u0000${submission.localId}`;
        if (appliedArmedContinuationDraftClearRef.current === clearKey) return;
        appliedArmedContinuationDraftClearRef.current = clearKey;
        clearArmedContinuationSubmissionIfCurrent(submission);
        clearPersistedArmedContinuationSubmissionIfCurrent(submission);
    }, [
        activeArmedContinuationOutcome,
        sessionAccountScopeKey,
        armedContinuationDisposition,
        armedContinuationSubmissionCustody,
        clearPersistedArmedContinuationSubmissionIfCurrent,
        clearArmedContinuationSubmissionIfCurrent,
        liveArmedContinuationSubmission,
        sessionId,
    ]);
    const isPendingMessageEditAccountCurrent = React.useCallback((edit: PendingMessageComposerEditState): boolean => {
        if (edit.accountLifetime) return edit.accountLifetime.isCurrent();
        return edit.accountScope === null && sessionAccountScope === null;
    }, [sessionAccountScope]);
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
            composerTextStore.setPrompt(next.text);
        }
        if (!sameStrictJsonValue(previous.structuredInputMentions, next.structuredInputMentions)) {
            inputComposerPersistence.structuredInputPersistence.onMentionsChange(next.structuredInputMentions);
        }
        if (!sameStrictJsonValue(previous.composerAttachments, next.composerAttachments)) {
            setComposerDocumentRenderEpoch((current) => current + 1);
        }
        return result;
    }, [
        composerTextStore,
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
        clearPendingMessageEditDrainHold(edit);
    }, [clearPendingMessageEditDrainHold]);
    const pendingWithdrawalControllersRef = React.useRef(new Set<AbortController>());
    React.useEffect(() => () => {
        for (const controller of pendingWithdrawalControllersRef.current) controller.abort();
        pendingWithdrawalControllersRef.current.clear();
    }, [activeComposerRef, sessionAccountLifetime, sessionId]);
    const pendingRecoveryApproval = useActionApprovalContinuation({
        scopeKey: `${sessionAccountScopeKey}:${sessionId}`,
        serverId: sessionAccountScope?.serverId ?? sessionRouteServerId ?? '',
        onExecuted: () => {},
    });
    const handleEditPendingMessage = React.useCallback(async (request: PendingMessageEditRequest) => {
        if (externalSessionOperationShell.blocksNewOperation) return;
        // A row its Session reader hasn't opened holds a placeholder; the composer never takes it as text.
        if (request.message.pendingDecryption?.kind === 'loading') return;
        // The composer reopens what the reader SAW. A queued turn that expanded
        // review comments, attachments or a template into its transport text
        // kept the typed sentence in `displayText`, and editing the expansion is
        // editing something the user never wrote. The mention admission below
        // reads the same text, so a chip can never outlive its token.
        let editText = readMessageDisplayText(request);
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
        editText = attachmentHydration.text ?? editText;

        const accountLifetime = sessionAccountLifetime;
        const hydratedComposerMentions = composerStructuredMentionsFromReferences({
            references: attachmentHydration.mentions ?? [],
            existing: [],
        });
        if (request.mode === 'withdraw') {
            if (!accountLifetime || !accountLifetime.isCurrent()) return;
            const cancellation = new AbortController();
            pendingWithdrawalControllersRef.current.add(cancellation);
            const retirement = accountLifetime.onRetire(() => cancellation.abort());
            let recovery;
            try { recovery = await withdrawPendingMessageToComposerWithActionApproval({
                composer: existingSessionComposerOwner,
                document: {
                    text: editText,
                    structuredInputMentions: hydratedComposerMentions,
                    composerAttachments: attachmentHydration.attachments,
                },
                isCurrent: isActiveComposerPresentationCurrent,
                actionExecutor,
                scope: accountLifetime.scope,
                signal: cancellation.signal,
                registerApproval: pendingRecoveryApproval.requestApproval,
                withdrawInput: {
                        sessionId,
                        localId: request.message.localId ?? request.id,
                        ...(sessionRouteServerId ? { serverId: sessionRouteServerId } : {}),
                        ...(request.message.recipient ? { targetExecutionRunId: request.message.recipient.runId } : {}),
                },
                context: {
                        surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId,
                        ...(sessionAccountScope ? { expectedAccountId: sessionAccountScope.accountId } : {}),
                        ...(request.withdrawalConfirmed ? { presentUserConfirmation: { actionId: 'session.pending.withdraw' as const } } : {}),
                },
            }); } finally {
                retirement.dispose();
                pendingWithdrawalControllersRef.current.delete(cancellation);
            }
            if (recovery.status === 'restored') {
                cancelPendingMessageEdit();
                if (!sessionAccountScope) composerTextStore.setPrompt(editText);
                setComposerDocumentRenderEpoch((current) => current + 1);
                notifyComposerPresentationTargetChanged({ kind: 'session', sessionId });
                composerFocusRequestRef.current?.();
            }
            return recovery;
        }
        const previousEdit = pendingMessageEditRef.current;
        if (previousEdit && previousEdit.pendingId !== request.id) {
            clearPendingMessageEditDrainHold(previousEdit);
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
        actionExecutor,
        cancelPendingMessageEdit,
        composerTextStore,
        existingSessionComposerOwner,
        isActiveComposerPresentationCurrent,
        pendingRecoveryApproval.requestApproval,
        sessionAccountLifetime,
        sessionAccountScope,
        sessionRouteServerId,
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
        clearPendingMessageEditDrainHold(edit);
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
        clearPendingMessageEditDrainHold(edit);
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

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        fireAndForget(applyPermissionModeSelection({
            sessionId,
            serverId: sessionRouteServerId,
            mode,
            applyTiming: settings.sessionPermissionModeApplyTiming === 'next_prompt' ? 'next_prompt' : 'immediate',
            draftScope: sessionAccountLifetime?.isCurrent() ? sessionAccountScope : null,
            executeAction: actionExecutor.execute,
        }).catch((error: unknown) => presentSessionActionOutcome(error, sessionAccountLifetime)), { tag: 'SessionView.updatePermissionMode' });
    }, [actionExecutor, presentSessionActionOutcome, sessionAccountLifetime, sessionAccountScope, sessionId, sessionRouteServerId, settings.sessionPermissionModeApplyTiming]);

    const updateAcpSessionModeOverride = React.useCallback((modeId: string) => {
        const normalized = typeof modeId === 'string' ? modeId.trim() : '';
        const publishModeId =
            normalized === 'default' && !sessionModeOptionIds.includes('default')
                ? ''
                : normalized;
        fireAndForget(actionExecutor.execute('session.mode.set', {
            sessionId,
            modeId: publishModeId,
        }, {
            surface: 'ui',
            defaultSessionId: sessionId,
            serverId: sessionRouteServerId,
        }).then(requireActionSuccess).catch((error: unknown) => presentSessionActionOutcome(error, sessionAccountLifetime)), { tag: 'SessionView.updateAcpSessionModeOverride' });
    }, [actionExecutor, presentSessionActionOutcome, sessionAccountLifetime, sessionId, sessionModeOptionIds, sessionRouteServerId]);

    const updateAcpConfigOptionOverride = React.useCallback((configId: string, valueId: string) => {
        fireAndForget(actionExecutor.execute('session.config_option.set', {
            sessionId,
            configId,
            valueId,
        }, {
            surface: 'ui',
            defaultSessionId: sessionId,
            serverId: sessionRouteServerId,
        }).then(requireActionSuccess).catch((error: unknown) => presentSessionActionOutcome(error, sessionAccountLifetime)), { tag: 'SessionView.updateAcpConfigOptionOverride' });
    }, [actionExecutor, presentSessionActionOutcome, sessionAccountLifetime, sessionId, sessionRouteServerId]);

    const publishModelSelection = React.useCallback(async (ref: ProviderBoundModelRef | null, modelOptionsContext?: SessionModelOptionsContext) => {
        if (!agentId || !canSelectModel) return;
        const failureFallback = t(ref?.providerConnectionId
            ? 'settingsProviders.models.connectionUnavailable'
            : 'common.requestFailed');
        const mode = ref?.modelId ?? 'default';
        const intentBaselineUpdatedAt =
            providerModelSelectionIntent?.updatedAt ?? 0;
        if (ref?.providerConnectionId === null
            && !isModelSelectableForSession(agentId, composerOptionsInput, mode, modelOptionsContext)) return;
        try {
            const result = await actionExecutor.execute('session.model.set', {
                sessionId,
                modelId: mode,
                providerConnectionId: ref?.providerConnectionId ?? null,
                applyTiming: session.active === true ? 'next_prompt' : 'immediate',
            }, {
                surface: 'ui',
                defaultSessionId: sessionId,
                serverId: sessionRouteServerId,
            });
            if (result.ok) {
                const value = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
                    ? result.result : null;
                const transition = SessionModelTransitionResultV1Schema.safeParse(value && 'status' in value && value.status === 'armed'
                    ? { ok: true, status: value.status,
                        activeSelection: 'activeSelection' in value ? value.activeSelection : null,
                        requestedSelection: 'requestedSelection' in value ? value.requestedSelection : null }
                    : null);
                if (transition.success && transition.data.status === 'armed') {
                    setModelTransitionActionRequired({ status: 'armed', requestedSelection: transition.data.requestedSelection, intentBaselineUpdatedAt });
                    return;
                }
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
            Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(result, failureFallback) ?? failureFallback);
        } catch (error) {
            setModelTransitionActionRequired(null);
            Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, failureFallback));
        }
    }, [
        actionExecutor,
        agentId,
        hasWriteAccess,
        providerModelSelectionIntent?.updatedAt,
        sessionId,
        session.active,
        ownerMetadata,
        sessionRouteServerId,
        composerOptionsInput,
    ]);
    const publishTeamCredentialModelSelection = React.useCallback(async (
        teamCredentialModel: TeamCredentialProviderModelSelectionV1,
    ) => {
        const resourceKey = `${teamCredentialModel.teamId}:${teamCredentialModel.resourceId}`;
        const selectedResource = teamCredentialCatalog.resources.find((resource) => (
            resource.id === teamCredentialModel.resourceId
            && resource.teamId === teamCredentialModel.teamId
            && resource.resourceRevision === teamCredentialModel.expectedResourceRevision
        ));
        if (teamCredentialResourcesEnabled && (!selectedResource
            || !teamCredentialCatalog.currentResourceKeys.has(resourceKey)
            || !resourceHasAvailableTeamCredentialProviderModel(selectedResource, teamCredentialModel))) {
            Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
            return;
        }
        const selectionOutcome = selectedResource
            ? await coordinateTeamCredentialSelection({
                resource: selectedResource,
                deliveryMode: teamCredentialModel.deliveryMode,
                selection: teamCredentialModel,
                isCurrent: () => !teamCredentialResourcesEnabled || (teamCredentialSelectionCatalogRef.current.currentResourceKeys.has(resourceKey)
                    && teamCredentialSelectionCatalogRef.current.resources.some((resource) => (
                        resource.id === teamCredentialModel.resourceId
                        && resource.teamId === teamCredentialModel.teamId
                        && resourceHasAvailableTeamCredentialProviderModel(resource, teamCredentialModel)
                    ))),
            })
            : { kind: 'continue' as const, selection: teamCredentialModel };
        if (selectionOutcome.kind !== 'continue') return;
        if (selectedResource?.sessionUsePolicy === 'team_visibility_required') {
            const confirmed = await Modal.confirm(
                t('teams.credentials.usePolicy.label'),
                t('teams.credentials.usePolicy.visibilityNote'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (!confirmed) return;
        }
        const stillCurrent = !teamCredentialResourcesEnabled || (teamCredentialSelectionCatalogRef.current.currentResourceKeys.has(resourceKey)
            && teamCredentialSelectionCatalogRef.current.resources.some((resource) => (
                resource.id === teamCredentialModel.resourceId
                && resource.teamId === teamCredentialModel.teamId
                && resourceHasAvailableTeamCredentialProviderModel(resource, teamCredentialModel)
            )));
        if (!stillCurrent) return;
        const model = selectedResource?.providerModels.find(candidate => (
            sessionModelSelectionKey(candidate.selection) === sessionModelSelectionKey(selectionOutcome.selection)
        ));
        if (!model) return;
        await confirmExperimentalProviderModel.confirm({ kind: 'team-model', model }, async () => {
            if (!teamCredentialSelectionCatalogRef.current.currentResourceKeys.has(resourceKey)
                || !teamCredentialSelectionCatalogRef.current.resources.some(resource => (
                    resourceHasAvailableTeamCredentialProviderModel(resource, selectionOutcome.selection)
                ))) return;
            try {
                const result = await actionExecutor.execute('session.model.set', {
                    sessionId,
                    teamCredentialModel: selectionOutcome.selection,
                    ...(selectedResource?.sessionUsePolicy === 'team_visibility_required'
                        ? { teamVisibilityGrantConsent: { teamId: teamCredentialModel.teamId } }
                        : {}),
                }, {
                    surface: 'ui',
                    defaultSessionId: sessionId,
                    serverId: sessionRouteServerId,
                });
                if (result.ok) {
                    setModelTransitionActionRequired(null);
                    return;
                }
                const details = result.details && typeof result.details === 'object'
                    ? result.details as Record<string, unknown>
                    : null;
                if (details?.status === 'restart_required') {
                    // The Home committed this Team selection; only the process that
                    // is already running has not adopted it. That is the same fact
                    // a personal Provider transition reports, so it reaches the same
                    // explicit restart affordance instead of silently restarting
                    // somebody's running session or being reported as a failure.
                    setModelTransitionActionRequired({
                        status: 'restart_required',
                        requestedSelection: selectionOutcome.selection,
                        intentBaselineUpdatedAt: providerModelSelectionIntent?.updatedAt ?? 0,
                    });
                    return;
                }
                setModelTransitionActionRequired(null);
                if (details?.status === 'team_resource_active_transition_unsupported') {
                    // Nothing was saved: the session started running between the
                    // read and the write. Saying the connection is unavailable would
                    // describe a different, unrecoverable problem.
                    Modal.alert(t('common.error'), t('teams.credentials.selection.activeTransitionUnsupported'));
                    return;
                }
                Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
            } catch {
                setModelTransitionActionRequired(null);
                Modal.alert(t('common.error'), t('settingsProviders.models.connectionUnavailable'));
            }
        });
    }, [actionExecutor, canSelectModel, confirmExperimentalProviderModel, coordinateTeamCredentialSelection, providerModelSelectionIntent?.updatedAt, sessionId, sessionRouteServerId, teamCredentialCatalog, teamCredentialResourcesEnabled]);

    // Function to update a native model mode (only for agents that expose model selection in the UI).
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (!providerAgentTargetKey) return;
        void publishModelSelection(mode === 'default'
            ? null
            : { agentTargetKey: providerAgentTargetKey, providerConnectionId: null, modelId: mode });
    }, [providerAgentTargetKey, publishModelSelection]);
    const existingSessionNativeModels = React.useMemo(() => (
        agentId ? getModelOptionsForSession(agentId, composerOptionsInput) : []
    ), [agentId, composerOptionsInput]);
    const existingSessionSelectedModelRef = React.useMemo<ProviderBoundModelRef | null>(() => (
        providerModelSelection?.ref
        ?? (providerAgentTargetKey && modelMode !== 'default'
            ? { agentTargetKey: providerAgentTargetKey, providerConnectionId: null, modelId: modelMode }
            : null)
    ), [modelMode, providerAgentTargetKey, providerModelSelection?.ref]);
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
    const providerSettings = useProviderSettings(sessionAccountScope);
    const existingSessionHiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        providerSettings,
        { providersFeatureEnabled },
    ), [providersFeatureEnabled, providerSettings]);
    const modelPickerPresentation = React.useMemo(() => (
        providersFeatureEnabled && providerAgentTargetKey && existingSessionSelectedModelRef?.providerConnectionId
            ? {
                agentTargetKey: providerAgentTargetKey,
                declarationContext,
                nativeModels: existingSessionNativeModels,
                providerGroups: providerModelProjection.data?.groups ?? EMPTY_SESSION_MODEL_PROJECTION_GROUPS,
                hiddenNativeModelKeys: existingSessionHiddenNativeModelKeys,
                providerProjectionAuthoritative: providerModelProjection.status === 'success',
                selected: existingSessionSelectedModelRef,
                currentSelectionRecovery: providerModelProjection.data?.currentSelectionRecovery,
                fallbackLabel: t('agentInput.model.unavailable'),
                fieldLabel: t('newSession.selectModelTitle'),
            }
            : undefined
    ), [declarationContext, existingSessionHiddenNativeModelKeys, existingSessionNativeModels, existingSessionSelectedModelRef,
        providerAgentTargetKey, providerModelProjection.data, providerModelProjection.status, providersFeatureEnabled]);
    const resolveSessionModelDiscoveryContext = React.useCallback((settings: Settings): SessionModelDiscoveryContext => {
        const target = resolveSessionActionDefaultTarget(sessionActionDefaultBackend);
        const backendTarget = target ? resolveNewSessionOperationalBackendTarget({
            backendTarget: target, runtimeCarrierAgentId: agentId,
        }) : null;
        const selectedMachineId = controlMachineTarget?.machineId ?? machineId ?? null;
        return {
            backendTarget,
            runtimeCarrierAgentId: agentId,
            selectedMachineId,
            capabilityServerId: sessionRouteServerId,
            cwd: liveAuthoringContext.snapshot.directory,
            enabled: canSelectModel,
            probeContext: target ? resolveNewSessionModelCapabilityProbeContext({
                backendTarget: target,
                runtimeCarrierAgentId: agentId,
                settings,
                selectedProfileId: liveComposerState.profileId,
                runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(ownerMetadata),
                machineId: selectedMachineId,
                connectedServices: agentId ? readSessionConnectedServiceBindings({ metadata: ownerMetadata, agentId }) : null,
            }) : null,
        };
    }, [sessionActionDefaultBackend, agentId, controlMachineTarget?.machineId, machineId, sessionRouteServerId,
        liveAuthoringContext.snapshot.directory, liveComposerState.profileId, canSelectModel, ownerMetadata]);
    const existingSessionSourceBrowse = React.useMemo(() => ({
        machineId: typeof machineId === 'string' ? machineId : null,
        serverId: sessionRouteServerId,
    }), [machineId, sessionRouteServerId]);
    const existingSessionModelPicker = React.useMemo(() => {
        if (!agentId || !providerAgentTargetKey) return undefined;
        return <SessionModelDiscoveryDetail
            agentId={agentId}
            composerOptionsInput={composerOptionsInput}
            discovery={resolveSessionModelDiscoveryContext}
            selectedModelId={existingSessionSelectedModelRef?.providerConnectionId ? undefined : existingSessionSelectedModelRef?.modelId ?? 'default'}
            renderDetail={({ modelOptions: existingSessionNativeModels, modelOptionsContext, canEnterCustomModel, probe }) => {
                const existingSessionSelectedModelOptionControls = (() => {
                    if (!agentId) return null;
                    if (existingSessionSelectedModelRef?.providerConnectionId) return null;
                    return computeSessionModelConfigOptionControls({
                        agentId,
                        metadata: composerOptionsInput,
                        modelId: existingSessionSelectedModelRef?.modelId ?? 'default',
                        modelOptions: existingSessionNativeModels,
                    });
                })();
                const projectedProviderGroups = providersFeatureEnabled
                    ? (providerModelProjection.data?.groups ?? EMPTY_SESSION_MODEL_PROJECTION_GROUPS)
                    : EMPTY_SESSION_MODEL_PROJECTION_GROUPS;
                // The embedded arm's `allowedModels` narrows the picker through the same model hide
                // keys the picker already applies; it never adds a model.
                const embeddedModelNarrowing = narrowSessionModelPickerToAllowedModels({
                    allowedModels: embedded?.allowedModels,
                    agentTargetKey: providerAgentTargetKey,
                    nativeModels: existingSessionNativeModels,
                    providerGroups: projectedProviderGroups,
                    hiddenNativeModelKeys: existingSessionHiddenNativeModelKeys,
                });
                const providerGroups = embeddedModelNarrowing?.providerGroups ?? projectedProviderGroups;
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
                        declarationContext={declarationContext}
                        nativeModels={existingSessionNativeModels}
                        providerGroups={providerGroups}
                        teamCredentialResources={embeddedModelNarrowing ? EMPTY_TEAM_CREDENTIAL_RESOURCES : teamCredentialCatalog.resources}
                        teamNameById={teamCredentialCatalog.teamNameById}
                        homeNameByTeamId={teamCredentialCatalog.homeNameByTeamId}
                        currentTeamCredentialResourceKeys={teamCredentialCatalog.currentResourceKeys}
                        providerProjectionAuthoritative={providerModelProjection.status === 'success'}
                        projectionError={providersFeatureEnabled ? providerModelProjection.error : null}
                        projectionFailures={providersFeatureEnabled ? providerModelProjection.refreshFailures : []}
                        retryProjection={providersFeatureEnabled ? providerModelProjection.refresh : null}
                        currentSelectionRecovery={providersFeatureEnabled
                            ? providerModelProjection.data?.currentSelectionRecovery ?? null
                            : null}
                        hiddenNativeModelKeys={embeddedModelNarrowing?.hiddenNativeModelKeys ?? existingSessionHiddenNativeModelKeys}
                        // A model-restricted embed offers only its allowed models, so it names no other source.
                        hiddenSources={providersFeatureEnabled && !embeddedModelNarrowing
                            ? providerModelProjection.data?.hiddenSources
                            : undefined}
                        sourceBrowse={providersFeatureEnabled && !embeddedModelNarrowing
                            ? existingSessionSourceBrowse
                            : undefined}
                        // A model-restricted embed refuses the automatic choice, so it is not offered, and an
                        // automatic selection shows the first allowed model (plan 04 §4.6).
                        allowAutomatic={embeddedModelNarrowing?.allowAutomatic ?? true}
                        canEnterCustomValue={embeddedModelNarrowing?.canEnterCustomValue}
                        selected={embeddedModelNarrowing && embedded?.allowedModels
                            // The model the next message runs on: the Session's own when allowed, else the
                            // first allowed one (the outgoing record applies the same protocol rule).
                            ? providerAgentTargetKey
                                ? readEffectiveAllowedModelRef(embedded.allowedModels, selectedRef, providerAgentTargetKey)
                                : null
                            : selectedRef ?? null}
                        selectedTeamCredentialModel={selectedTeamCredentialModel}
                        effectiveLabel={selectedProviderRow?.descriptor.name ?? nativeLabel}
                        reportedModel={existingSessionReportedModel}
                        canEnterCustomNativeValue={canEnterCustomModel}
                        // Model options (Thinking, effort) are Session settings, not the model grant.
                        selectedOptionControls={hasWriteAccess ? existingSessionSelectedModelOptionControls ?? undefined : undefined}
                        onSelectOptionControlValue={updateAcpConfigOptionOverride}
                        probe={mergeOptionPickerProbes([probe, providersFeatureEnabled
                            ? providerModelProjection.loading
                                ? { phase: 'loading' }
                                : { phase: 'idle', onRefresh: () => { void providerModelProjection.refresh(); } }
                            : undefined])}
                        experimentalConfirmation={confirmExperimentalProviderModel}
                        onSelect={(ref) => {
                            hapticsLight();
                            const canonicalRef = resolveCanonicalNativeModelSelectionRef(existingSessionNativeModels, ref);
                            void publishModelSelection(canonicalRef, modelOptionsContext);
                        }}
                        onSelectTeamCredentialModel={(selection) => {
                            hapticsLight();
                            void publishTeamCredentialModelSelection(selection);
                        }}
                        onRecoverTeamCredentialResource={(resource) => {
                            router.push(teamCredentialDetailPath({
                                serverId: sessionRouteServerId,
                                teamId: resource.teamId,
                            }, resource.id));
                        }}
                    />
                );
            }}
        />;
    }, [
        agentId,
        declarationContext,
        resolveSessionModelDiscoveryContext,
        confirmExperimentalProviderModel,
        existingSessionHiddenNativeModelKeys,
        existingSessionNativeModels,
        existingSessionReportedModel,
        existingSessionSelectedModelRef,
        existingSessionSourceBrowse,
        selectedTeamCredentialModel,
        modelMode,
        providerAgentTargetKey,
        providerModelProjection.data,
        providerModelProjection.error,
        providerModelProjection.loading,
        providerModelProjection.refresh,
        providerModelProjection.status,
        providerModelSelection?.ref,
        providersFeatureEnabled,
        router,
        sessionRouteServerId,
        publishTeamCredentialModelSelection,
        publishModelSelection,
        teamCredentialCatalog.currentResourceKeys,
        teamCredentialCatalog.homeNameByTeamId,
        teamCredentialCatalog.resources,
        teamCredentialCatalog.teamNameById,
        updateAcpConfigOptionOverride,
        ownerMetadata,
        embedded,
        composerOptionsInput,
        hasWriteAccess,
    ]);

    const [directoryRecovery, setDirectoryRecovery] = React.useState<Readonly<{ scopeKey: string; busy: boolean }> | null>(null);
    const currentDirectoryRecovery = directoryRecovery?.scopeKey === sessionAccountScopeKey ? directoryRecovery : null;

    // Both explicit Resume and the queue control consume the banner owner's
    // current decision and rearm the same admitted input through its normal owner.
    const handlePendingActivationRequest = React.useCallback(async (action: 'process_when_online' | 'keep_queued'): Promise<boolean> => {
        const lifetime = sessionAccountLifetime;
        const presentation = pendingActivationPresentation;
        const row = presentation?.row;
        if (!lifetime?.isCurrent() || !presentation || !row?.localId || pendingActivationActionBusy
            || (action === 'process_when_online' ? presentation.primaryAction !== action : presentation.secondaryAction !== action)) return false;
        setPendingActivationActionBusy(true);
        const cancellation = new AbortController();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        try {
            const requestedAction = row.pendingRequestedAction;
            const input = { sessionId, localId: row.localId, serverId: lifetime.scope.serverId,
                requestedAction: action === 'keep_queued' && requestedAction?.kind === 'send_now'
                    ? { v: 1, kind: 'enqueue' } : requestedAction ?? { v: 1, kind: 'enqueue' },
                resumeWhenAvailable: action === 'process_when_online' };
            const initial = await actionExecutor.execute('session.pending.action.set', input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: cancellation.signal,
            });
            if (!lifetime.isCurrent()) return false;
            requireActionSuccess(await resumeActionExecutionResult({ result: initial, actionId: 'session.pending.action.set',
                actionInput: input, scope: lifetime.scope, signal: cancellation.signal,
                onApprovalPending: pendingRecoveryApproval.requestApproval }));
            return lifetime.isCurrent();
        } catch (error) {
            if (lifetime.isCurrent()) Modal.alert(t('common.error'), error instanceof Error ? error.message
                : t(action === 'keep_queued' ? 'session.pendingMessages.errors.updateFailed' : 'session.pendingMessages.errors.sendFailed'));
            return false;
        } finally {
            retirement.dispose();
            if (lifetime.isCurrent()) setPendingActivationActionBusy(false);
        }
    }, [actionExecutor, pendingActivationActionBusy, pendingActivationPresentation, pendingRecoveryApproval.requestApproval, sessionAccountLifetime, sessionId]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async (opts?: { silent?: boolean; approvedNewDirectoryCreation?: boolean }): Promise<boolean> => {
        const silent = opts?.silent === true;
        const resumeMachineId = reachableMachineTarget?.machineId ?? ownerMetadata?.machineId ?? null;
        const resumeDirectory = reachableMachineTarget?.basePath ?? ownerMetadata?.path ?? null;
        // Capture the attempted Home before asynchronous admission can change the selected profile.
        const targetHome = resolvePortableServerIdentityForRoutingId(sessionRouteServerId);

        const maybeAlert = (message: string, code: string | null = null) => {
            if (silent) return;
            alertActionFailure({ reason: message, code, context: { phase: 'session.open', targetHome } });
        };

        if (sessionMachineAccessRemoved) return false;

        if (!resumeMachineId || !resumeDirectory || !agentId) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (!agentId) {
            maybeAlert(t('session.resumeFailed'));
            return false;
        }

        if (!isResumable) {
            if (silent) return false;

            const replayCfg = resolveHappierReplayConfig(storage.getState().settings);
            if (replayCfg.enabled) {
                if (!isMachineReachable) {
                    maybeAlert(t(machineReachability === 'unknown' ? 'newSession.machineUnavailableStatus' : 'session.machineOfflineCannotResume'));
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
                        const outcome = openNewSessionSourceContextNavigation({
                            session,
                            sourceSessionId: sessionId,
                            forkPoint: { type: 'latest' },
                            serverId: sessionRouteServerId ?? null,
                            machineId: resumeMachineId,
                            accountLifetime: sessionAccountLifetime,
                            navigateToNewSession: route => router.push(route),
                        });
                        return outcome.kind === 'opened';
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
            if (pendingActivationPresentation?.primaryAction === 'process_when_online') {
                return await handlePendingActivationRequest('process_when_online');
            }
            maybeAlert(t(pendingActivationPresentation?.titleKey ?? (machineReachability === 'unknown'
                ? 'newSession.machineUnavailableStatus' : 'session.machineOfflineCannotResume')));
            return false;
        }

        try {
            if (!sessionAccountLifetime?.isCurrent() || !sessionRouteServerId) return false;
            const result = await actionExecutor.execute('session.open', {
                sessionId,
                serverId: sessionRouteServerId,
                intent: 'resume',
                ...(opts?.approvedNewDirectoryCreation === true ? {
                    approvedNewDirectoryCreation: true,
                } : {}),
            }, {
                serverId: sessionRouteServerId,
                expectedAccountId: sessionAccountLifetime.scope.accountId,
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            });

            if (!result.ok) {
                const presentation = resolveResumeFailurePresentation({ errorCode: result.errorCode, errorMessage: result.error },
                    t('session.resumeFailed'), resolveSessionActionDefaultTarget(sessionActionDefaultBackend));
                if (presentation.kind === 'directory_missing') {
                    setDirectoryRecovery({ scopeKey: sessionAccountScopeKey, busy: false });
                } else if (presentation.kind === 'plugin_disabled' && presentation.pluginId) {
                    const pluginId = presentation.pluginId;
                    if (!silent) alertActionFailure({ reason: presentation.message, code: presentation.errorCode,
                        context: { phase: 'session.open', targetHome },
                        recovery: { label: t('settingsPlugins.managePlugin'),
                            onPress: () => {
                                const route = buildPluginDetailRoute('settings', pluginId);
                                router.push({ ...route, params: { ...route.params, ...storeMachineRouteParams(
                                    resumeMachineId ? { serverId: sessionRouteServerId, machineId: resumeMachineId } : null,
                                ) } });
                            } },
                    });
                } else {
                    maybeAlert(presentation.message, presentation.errorCode ?? null);
                }
                return false;
            }
            if (typeof result.result !== 'object' || result.result === null
                || !('status' in result.result) || result.result.status !== 'opened') return false;
            setDirectoryRecovery((current) => current?.scopeKey === sessionAccountScopeKey ? null : current);
            // On success, the session will become active and UI will update automatically
            return true;
        } catch (error) {
            maybeAlert(t('session.resumeFailed'), readRpcErrorCode(error));
            return false;
        }
    }, [actionExecutor, agentId, handlePendingActivationRequest, pendingActivationPresentation, sessionAccountLifetime, sessionAccountScopeKey, sessionRouteServerId, executionRunsEnabled, isMachineReachable, machineReachability, isResumable, reachableMachineTarget, router, session, sessionActionDefaultBackend, sessionId, sessionMachineAccessRemoved]);
    handleUsageLimitRecoveryResumeNowRef.current = handleResumeSession;

    const handleManagedWakeRecovery = React.useCallback(async (action: 'inspect' | 'retry' | 'resume' | 'withdraw') => {
        const lifetime = sessionAccountLifetime;
        const presentation = pendingActivationPresentation;
        const projection = presentation?.managedWakeProjection;
        const target = managedWakeAuthorization?.managedWakeTargetV1;
        if (!lifetime?.isCurrent() || !presentation || !projection || !target || pendingActivationActionBusy) return;
        const cancellation = new AbortController();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        setPendingActivationActionBusy(true);
        try {
            if (action === 'retry') {
                if ((presentation.primaryAction === 'retry' || presentation.primaryAction === 'process_when_online') && presentation.row) await handleResumeSession();
            } else if (action === 'resume') {
                if (projection.canResumeRuntime && presentation.row) await handleResumeSession();
            } else if (action === 'withdraw') {
                const row = presentation.row;
                if (projection.canWithdraw && row) await handleEditPendingMessage({ id: row.id, text: row.text,
                    displayText: row.displayText, message: row, mode: 'withdraw' });
            } else {
                const inspectInput = {
                    homeId: target.homeId, managedId: target.managedId,
                };
                const result = await actionExecutor.execute('machines.managed.inspect', inspectInput,
                    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                    signal: cancellation.signal });
                if (!lifetime.isCurrent() || cancellation.signal.aborted) return;
                const refresh = () => {
                    if (lifetime.isCurrent() && !cancellation.signal.aborted) publishHomeAccountChange(lifetime.scope.serverId, [target.managedId]);
                };
                const fail = () => {
                    if (lifetime.isCurrent() && !cancellation.signal.aborted) Modal.alert(t('common.error'), t('managedMachines.detail.loadFailed'));
                };
                const outcome = classifyHomeActionOutcome(result);
                if (outcome.kind === 'completed') refresh();
                else if (outcome.kind === 'failed') fail();
                else pendingRecoveryApproval.requestApproval(createActionApprovalContinuation<unknown, 'machines.managed.inspect'>({
                    artifactId: outcome.artifactId, actionId: 'machines.managed.inspect', scope: lifetime.scope,
                    expectedInput: inspectInput, signal: cancellation.signal, onSucceeded: refresh, onFailed: fail,
                }));
            }
        } catch (error) {
            if (lifetime.isCurrent() && !cancellation.signal.aborted) Modal.alert(t('common.error'),
                error instanceof Error ? error.message : t('managedMachines.detail.loadFailed'));
        } finally {
            retirement.dispose();
            if (lifetime.isCurrent()) setPendingActivationActionBusy(false);
        }
    }, [actionExecutor, handleEditPendingMessage, handleResumeSession, managedWakeAuthorization,
        pendingActivationActionBusy, pendingActivationPresentation, pendingRecoveryApproval.requestApproval, sessionAccountLifetime]);

    const handleContinueInFreshFolder = React.useCallback(async () => {
        setDirectoryRecovery({ scopeKey: sessionAccountScopeKey, busy: true });
        try {
            await handleResumeSession({ approvedNewDirectoryCreation: true });
        } finally {
            setDirectoryRecovery((current) => current?.scopeKey === sessionAccountScopeKey ? { ...current, busy: false } : current);
        }
    }, [handleResumeSession, sessionAccountScopeKey]);

    // The committed-but-inactive recovery. The banner offers it only once
    // canonical facts say the Session has no live runtime, and it does nothing
    // itself: starting a Session belongs to `handleResumeSession`, which every
    // other inactive-session affordance already uses. A successful start makes
    // the notice untrue, so it goes.
    const handleArmedContinuationResume = React.useCallback(async () => {
        const resumed = await handleResumeSession({ silent: false });
        if (!resumed) return;
        setArmedContinuationOutcome((current) => (
            current?.scopeKey === sessionAccountScopeKey ? null : current
        ));
    }, [sessionAccountScopeKey, handleResumeSession]);

    useSessionResumeRequestListener(
        sessionId,
        React.useCallback(() => handleResumeSession(), [handleResumeSession]),
        sessionRouteServerId,
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
        machineReachability,
        allowInputWhileInactive: persistedVoiceComposerRouting?.kind === 'adapter_text',
        providerName,
        machineName,
    });
    const inactiveUi = runtimeDisplayState.inactiveUi;
    const bottomNotice = runtimeDisplayState.bottomNotice;

    const isReadOnly = session.access?.capabilities.submitAgentInput !== true;
    // An embedded arm that cannot send but may change the model keeps the composer's controls only:
    // no text field or send that could never succeed.
    const embeddedComposerControlsOnly = embedded !== null && isReadOnly && canSelectModel;
    const shouldShowInput = inactiveUi.shouldShowInput
        && !sessionMachineAccessRemoved
        && !isEncryptedSessionLocked
        // Register only the input presentation that the render branch actually mounts.
        && (embedded === null || (embedded.composer !== 'none' && (!isReadOnly || embeddedComposerControlsOnly)));
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
    // PEP owns the current-UI command transport; Lane 08 only publishes this
    // mounted Session's local Board/Companion port through the incumbent target.
    const applySessionPresentationIntentFromCommand = React.useCallback(
        (intent: Parameters<SessionPresentationIntentApplier>[0], onCompanionMutation?: Parameters<SessionPresentationIntentApplier>[1]) => (
            sessionPresentationApplierRef.current?.(intent, onCompanionMutation) ?? { status: 'unavailable' as const }
        ),
        [],
    );
    // Opens a chip only on the composer the person is looking at; otherwise the registry keeps the
    // request until this surface is focused and presented again.
    const requestComposerActionChipOpen = (chipKey: string): boolean => {
        if (!surfaceFocused || !surfacePresented || !composerActionChipKeysRef.current.has(chipKey)) return false;
        setComposerActionChipOpenRequest((current) => ({
            chipKey,
            key: String((Number.parseInt(current?.key ?? '0', 10) || 0) + 1),
        }));
        return true;
    };
    const activeComposerPresentationTarget = useStableComposerPresentationTarget(activeComposerRef, {
        readScope: () => composerPresentationAccountLifetime?.scope ?? null,
        readReferenceWorkspace: () => companionAddress ? resolveWorkspaceTargetForSession(companionAddress) : null,
        readAttachmentComposition: () => !composerPluginActionScopeSignal.aborted && composerAttachmentAvailabilityEntriesById
            ? { composerAttachmentsById: composerAttachmentAvailabilityEntriesById, localize: composerPluginPresentation.localizePluginText } : null,
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
        applySessionPresentationIntent: applySessionPresentationIntentFromCommand,
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => shouldShowInput && isActiveComposerPresentationCurrent(),
        // A retained hidden surface stays registered but yields command targeting to a presented one.
        isPresented: () => shouldShowInput && surfacePresented,
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
        openActionChip: requestComposerActionChipOpen,
        openPromptPicker: () => promptPickerOpenRequestRef.current?.() ?? false,
        openAttachmentPicker: () => {
            if (!attachmentsUploadsAvailable || isUploadingAttachments || activeComposerRefRef.current.kind !== 'session' || !filePickerRef.current) return false;
            openAttachmentFilePickerFiles(filePickerRef.current);
            return true;
        },
        hasActionChip: (chipKey) => composerActionChipKeysRef.current.has(chipKey),
    });
    const sessionComposerPresentationTarget = useStableComposerPresentationTarget(sessionComposerRef, {
        readScope: () => composerPresentationAccountLifetime?.scope ?? null,
        readReferenceWorkspace: () => companionAddress ? resolveWorkspaceTargetForSession(companionAddress) : null,
        readAttachmentComposition: () => !composerPluginActionScopeSignal.aborted && composerAttachmentAvailabilityEntriesById
            ? { composerAttachmentsById: composerAttachmentAvailabilityEntriesById, localize: composerPluginPresentation.localizePluginText } : null,
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
        applySessionPresentationIntent: applySessionPresentationIntentFromCommand,
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            composerPresentationMountedRef.current
            && shouldShowInput
            && composerPresentationAccountLifetime !== null
            && composerPresentationAccountLifetime.isCurrent()
        ),
        isPresented: () => shouldShowInput && surfacePresented,
        focusComposer: () => {
            if (!surfaceFocused || activeComposerRefRef.current.kind !== 'session') return false;
            const focus = composerFocusRequestRef.current;
            if (!focus) return false;
            focus();
            return true;
        },
        openActionChip: requestComposerActionChipOpen,
        openPromptPicker: () => activeComposerRefRef.current.kind === 'session'
            && (promptPickerOpenRequestRef.current?.() ?? false),
        openAttachmentPicker: () => {
            if (!attachmentsUploadsAvailable || isUploadingAttachments || activeComposerRefRef.current.kind !== 'session' || !filePickerRef.current) return false;
            openAttachmentFilePickerFiles(filePickerRef.current);
            return true;
        },
        hasActionChip: (chipKey) => composerActionChipKeysRef.current.has(chipKey),
    });
    React.useEffect(() => !shouldShowInput ? undefined : activeComposerRef.kind === 'session'
        ? registerSessionComposerPresentationTarget(sessionComposerAddress, activeComposerPresentationTarget)
        : registerComposerPresentationTarget(activeComposerRef, activeComposerPresentationTarget), [
        activeComposerPresentationTarget,
        activeComposerRef,
        sessionComposerAddress,
        shouldShowInput,
    ]);
    React.useEffect(() => {
        if (!shouldShowInput || activeComposerRef.kind === 'session') return;
        return registerSessionComposerPresentationTarget(sessionComposerAddress, sessionComposerPresentationTarget);
    }, [activeComposerRef.kind, sessionComposerAddress, sessionComposerPresentationTarget, shouldShowInput]);
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
        if (shouldShowInput && surfaceFocused) flushPendingRegisteredSessionComposerFocus(sessionComposerAddress);
        if (shouldShowInput && surfaceFocused && surfacePresented) flushPendingRegisteredSessionComposerActionChip(sessionComposerAddress);
    }, [activeComposerRef, composerAttachmentAvailabilityEntriesById, sessionComposerAddress, sessionComposerRef, shouldShowInput, surfaceFocused, surfacePresented]);
    const transcriptInteraction = transcriptSource.useInteraction();

    const isLocallyAttached = !isHiddenSystemSessionSession && isSessionLocallyAttached(session);
    const machineAgent = useMachineAgent({
        machineId,
        agentId: agentId ?? '',
        enabled: Boolean(agentId),
        load: isLocallyAttached,
        serverId: sessionRouteServerId,
    });
    const cliAuthState: CliAuthStatusData['state'] | null = machineAgent?.signIn.status === 'signedIn' ? 'logged_in'
        : machineAgent?.signIn.status === 'signedOut' ? 'logged_out'
            : machineAgent ? 'unknown' : null;
    const [controlSwitchTo, setControlSwitchTo] = React.useState<'remote' | null>(null);
    const controlSwitchAttemptIdRef = React.useRef(0);
    const controlSwitchCallerRef = React.useRef<AbortController | null>(null);
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
            controlSwitchCallerRef.current?.abort();
            setControlSwitchTo(null);
            controlSwitchAttemptIdRef.current = 0;
            Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
        }, timeoutMs);
        return () => clearTimeout(timeoutId);
    }, [controlSwitchTo]);
    const targetMachineHomeDir = typeof ownerMetadata?.homeDir === 'string'
        ? ownerMetadata.homeDir
        : null;
    const targetMachinePlatform = typeof ownerMetadata?.platform === 'string'
        ? ownerMetadata.platform
        : null;
    const externalSessionTakeover = useExternalSessionTakeover({
        sessionId,
        accountLifetime: sessionAccountLifetime,
        hasWriteAccess,
        externalSessionRuntime,
        targetMachineHomeDir,
        // The linked session path may describe provider/remote source context.
        // Takeover always starts from a user-confirmed local target on this
        // fixed machine, so only its local home directory seeds the picker.
        targetDirectorySuggestion: targetMachineHomeDir,
        targetMachinePlatform,
    });

    const [followBottomIntentSeq, setFollowBottomIntentSeq] = React.useState(0);
    const requestMountedTranscriptFollow = React.useCallback(() => {
        // The sync send boundary already established durable own-send tail intent before
        // optimistic projection. This key is only the mounted physical takeover command.
        setFollowBottomIntentSeq((current) => current + 1);
    }, []);

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = inactiveUi.inactiveStatusTextKey ? t(inactiveUi.inactiveStatusTextKey) : null;

        const pendingComposerDocument = pendingMessageEdit?.document ?? null;
        const readVisibleComposerText = React.useCallback(() => (
            pendingMessageEditRef.current?.document.text ?? composerTextStore.getPrompt()
        ), [composerTextStore]);
        const sessionAccessChip = useSessionAccessComposerChip({
            target: collaborationTarget,
            // Compact summary input only; the roster is loaded by the mounted editor.
            access: session.access ?? null,
            // Anchoring the compact editor to the chip needs pointer geometry the
            // narrow and native hosts do not have, so those hand off to the
            // Collaboration surface instead. A Home whose Collaboration destination
            // is not admitted keeps the anchored editor, which explains why.
            onOpen: collaborationAvailable && (Platform.OS !== 'web' || foldCollaborationHeaderEntry)
                ? openSessionAccess
                : null,
            // The anchored compact editor keeps its own way out to the full
            // Collaboration surface with Access focused.
            onOpenFullSurface: collaborationAvailable ? openSessionAccess : null,
        });
        // Run… (C4): the shared Workflow picker and start composer, started from this Session.
        const sessionWorkflowRunChip = useSessionWorkflowRunChip({
            sessionId,
            serverId: sessionRouteServerId || null,
            readDraft: readVisibleComposerText,
            disabled: isReadOnly,
        });
        const sessionWorkflowRunChips = React.useMemo(() => [sessionWorkflowRunChip], [sessionWorkflowRunChip]);
        const pickComposerAttachmentFile = React.useCallback(() => {
            openAttachmentFilePickerFiles(filePickerRef.current);
        }, [filePickerRef]);
        const pickComposerAttachmentImage = React.useCallback(() => {
            openAttachmentFilePickerImages(filePickerRef.current);
        }, [filePickerRef]);
        const appendComposerLinkedPath = React.useCallback((path: string) => {
            setVisibleComposerDraftValue((prev) => {
                const base = prev ?? '';
                const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
                return `${base}${spacer}@${path} `;
            });
        }, [setVisibleComposerDraftValue]);
        const sessionExtraActionPresentation = useSessionAgentInputExtraActionChips({
            sessionId,
            sessionAddress: companionAddress,
            accountScope: sessionAccountScope,
            accountScopeIsCurrent: sessionAccountLifetime?.isCurrent ?? null,
            // Collaboration is a primary-presentation entry; an embedded composer has none.
            sessionAccess: embedded ? null : sessionAccessChip,
            attachmentsUploadsEnabled,
            attachmentsUploadsAvailable,
            isReadOnly,
            isUploadingAttachments,
            onPickAttachmentFile: pickComposerAttachmentFile,
            onPickAttachmentImage: pickComposerAttachmentImage,
            onPasteAttachmentImage: pasteAttachmentImage,
            onAppendLinkedPath: appendComposerLinkedPath,
            reviewCommentsEnabled,
            reviewScope,
            reviewCommentDrafts,
            defaultBackendTarget: resolveSessionActionDefaultTarget(sessionActionDefaultBackend),
            defaultBackendId: sessionActionDefaultBackend?.defaultBackendId ?? null,
            readInstructionsText: readVisibleComposerText,
            browserContext: browserContextComposerContext,
        });
        const removeComposerAttachment = React.useCallback((instanceId: string) => {
            const ref = activeComposerRef;
            if (ref.kind !== 'session') {
                const snapshot = readComposerPresentationSnapshot(ref);
                if (!snapshot) return;
                applyComposerPresentationTransaction({
                    ref,
                    transaction: {
                        expectedRevision: snapshot.revision,
                        operations: [{ kind: 'attachment.remove', instanceId }],
                    },
                });
                return;
            }
            const exactTarget = sessionRouteServerId
                ? readSessionComposerPresentationTargetAtAddress({
                    serverId: sessionRouteServerId,
                    sessionId: ref.sessionId,
                })
                : null;
            if (!exactTarget) return;
            const snapshot = exactTarget?.readSnapshot?.();
            if (!snapshot) return;
            exactTarget.applyTransaction({
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId }],
            });
        }, [activeComposerRef, sessionRouteServerId]);
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
        const openComposerPluginAction = React.useCallback((action: PluginContributedActionDescriptor) => {
            return openSessionComposerContributedAction({
                controller: composerPluginActionController,
                action,
                signal: composerPluginActionScopeSignal,
            });
        }, [composerPluginActionController, composerPluginActionScopeSignal, openSessionComposerContributedAction]);
        const composerPluginActionChips = composerPluginPresentation.extraActionChips;
        const sessionTalk = React.useMemo(() => ({
            sessionId, serverId: sessionRouteServerId ?? null,
            intent: recipientState.sessionMessage, onIntentChange: recipientState.setSessionMessage,
        }), [sessionId, sessionRouteServerId, recipientState.sessionMessage, recipientState.setSessionMessage]);
        const routingControls = useSessionAgentInputRoutingControls({
            isReadOnly,
            participantTargets,
            recipientState,
            sessionTalk,
        });
        const sessionAttachmentRowItems = React.useMemo(() => (
            projectAgentInputAttachmentRowItems({
                items: [
                    ...(pendingComposerDocument ? [] : routingControls.attachmentRowItems),
                    ...(pendingComposerDocument ? [] : sessionExtraActionPresentation.attachmentRowItems),
                    ...composerAttachmentRowItems,
                ],
                transferAttachments: !pendingComposerDocument ? agentInputAttachments : undefined,
            })
        ), [
            agentInputAttachments,
            composerAttachmentRowItems,
            pendingComposerDocument,
            routingControls.attachmentRowItems,
            sessionExtraActionPresentation.attachmentRowItems,
        ]);
        const isRuntimeFreshActiveTurn =
            sessionStatus.state === 'thinking'
            || sessionStatus.state === 'permission_required'
            || sessionStatus.state === 'action_required';
        // "This session gets" (P8 U8.3): the capabilities chip and its one apply line share one P2 owner.
        const sessionCapabilitiesTarget = React.useMemo(() => ({
            kind: 'session' as const, sessionId, serverId: sessionRouteServerId ?? null, readOnly: isReadOnly,
        }), [sessionId, sessionRouteServerId, isReadOnly]);
        const stopSessionForCapabilities = React.useCallback(async () => (
            await executeSessionLifecycleAction('session.stop', sessionId, { serverId: sessionRouteServerId })
        ).success, [sessionId, sessionRouteServerId]);
        const resumeSessionForCapabilities = React.useCallback(() => handleResumeSession({ silent: true }), [handleResumeSession]);
        const sessionCapabilities = useExistingSessionCapabilitiesChip({
            target: sessionCapabilitiesTarget,
            machineName: sessionMachineRecord ? getMachineSentenceName(sessionMachineRecord) : t('common.machine'),
            machineOnline: machineReachability === 'unknown' ? null : isMachineReachable,
            turnSettled: !isRuntimeFreshActiveTurn,
            stop: stopSessionForCapabilities,
            resume: resumeSessionForCapabilities,
        });
        const sessionCapabilitiesChip = agentId ? sessionCapabilities.chip : null;
        const sessionComposerSkillSource = sessionCapabilities.skillSource;
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
        // The "Runs through" popover names this Agent's Gateways and Providers from the picker's own
        // projection; a model-restricted embed names no other source.
        const sessionRouteSources = React.useMemo(() => providersFeatureEnabled && !embedded?.allowedModels && providerAgentTargetKey ? {
            ...existingSessionSourceBrowse,
            agentTargetKey: providerAgentTargetKey,
            shownSources: providerModelProjection.data?.groups ?? EMPTY_SESSION_MODEL_PROJECTION_GROUPS,
            hiddenSources: providerModelProjection.data?.hiddenSources ?? EMPTY_SESSION_ROUTE_HIDDEN_SOURCES,
        } : undefined, [embedded?.allowedModels, existingSessionSourceBrowse, providerAgentTargetKey, providerModelProjection.data, providersFeatureEnabled]);
        const applySessionConnectedServicesAuthBinding = React.useCallback(async (
            input: Parameters<typeof setSessionConnectedServiceAuthBinding>[0],
        ): Promise<SessionConnectedServiceAuthSwitchResult> => {
            const initial = await actionExecutor.execute('session.connected_services_auth.set', input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                defaultSessionId: sessionId, serverId: sessionRouteServerId,
            });
            if (!sessionAccountScope || !sessionAccountLifetime?.isCurrent()) {
                throw new Error('action_account_scope_changed');
            }
            const settled = await resumeActionExecutionResult({
                result: initial,
                actionId: 'session.connected_services_auth.set',
                actionInput: input,
                scope: sessionAccountScope,
                onApprovalPending: pendingRecoveryApproval.requestApproval,
            });
            if (!settled.ok) throw new Error(settled.error);
            return settled.result as SessionConnectedServiceAuthSwitchResult;
        }, [actionExecutor, pendingRecoveryApproval.requestApproval, sessionAccountLifetime, sessionAccountScope, sessionId, sessionRouteServerId]);
        const requestedRouteSelection = React.useMemo(() => {
            const requested = effectiveModelTransitionActionRequired?.requestedSelection;
            if (!requested) return null;
            if (!isTeamCredentialProviderModelPickerValue(requested)) return requested;
            const { kind: _kind, ...ref } = requested;
            return { source: 'team_resource' as const, ...ref };
        }, [effectiveModelTransitionActionRequired?.requestedSelection]);
        const sessionAuthRoute = React.useMemo<Parameters<typeof useSessionConnectedServicesAuthSwitch>[0]['route']>(() => ({
                phase: session.active === true || (!modelSelectionDisposition?.proposedSelectionV2 && !modelSelectionDisposition?.contextSelection)
                    ? 'running' : 'draft',
                selection: requestedRouteSelection ?? modelSelectionDisposition?.proposedSelectionV2?.ref ?? modelSelectionDisposition?.contextRouteSelection ?? null,
                appliedSelection: modelSelectionDisposition?.activeRouteSelection ?? null,
                reportedSelection: modelSelectionDisposition?.lastAppliedRouteSelection ?? null,
                appliedProviderSource: providerLaunchBinding ? {
                    connectionId: providerLaunchBinding.connectionId, ...providerLaunchBinding.displaySnapshot,
                } : null,
                transitionPending: Boolean(requestedRouteSelection) || (modelSelectionDisposition?.selectionTransitionPending ?? false),
                sources: providerModelProjection.data?.groups,
                teamSources: teamCredentialCatalog.resources.map(resource => ({
                    teamId: resource.teamId, resourceId: resource.id, displayName: resource.displayName,
                })),
        }), [session.active, modelSelectionDisposition, requestedRouteSelection, providerLaunchBinding,
            providerModelProjection.data?.groups, teamCredentialCatalog.resources]);
        const sessionConnectedServicesAuthSwitch = useSessionConnectedServicesAuthSwitch({
            sessionConfiguration: session,
            routeSources: sessionRouteSources,
            nativeAgentTargetKey: providerAgentTargetKey,
            route: sessionAuthRoute,
            sessionId,
            agentId,
            machineId: controlMachineTarget?.machineId ?? null,
            serverId: sessionRouteServerId,
            connectedAccounts: currentSessionAgentCatalogEntry?.connectedAccounts ?? [],
            armedAuthoringTarget: armedContinuationTarget ? armedContinuationTarget.authoringTarget : undefined,
            agentIdentity: currentSessionAgentCatalogEntry
                ? parseQualifiedPluginContributionKey(currentSessionAgentCatalogEntry.qualifiedId)
                : null,
            teamCredentialResources: teamCredentialConnectedServiceResources,
            teamCredentialResourceCurrentKeys: teamCredentialCatalog.currentResourceKeys,
            teamNameById: teamCredentialCatalog.teamNameById,
            sessionMetadata: ownerMetadata,
            settings: {
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesProviderStateSharingSettingsV1: settings.connectedServicesProviderStateSharingSettingsV1,
                connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
            },
            switchingDisabledReason: isReadOnly
                ? 'read_only'
                : isRuntimeFreshActiveTurn
                    ? 'active_turn'
                    : null,
            sessionActive: session.active === true,
            intentionalRestartSignals,
            passiveProviderRecoveryServiceId,
            applyBinding: applySessionConnectedServicesAuthBinding,
        });
        const connectedServicesRestartState = sessionConnectedServicesAuthSwitch.restartState;
        const sessionStatusResuming = sessionStatus.state === 'resuming';
        const providerBindingBanner = React.useMemo(() => {
            const requestedTransitionSelection = effectiveModelTransitionActionRequired?.requestedSelection ?? null;
            // A Team resource is named by the Team's own resource, never by the
            // personal Provider connection this session happens to be launched
            // with: naming that connection here would attribute the pending
            // change to a credential nobody chose.
            const requestedTeamSelection = requestedTransitionSelection !== null
                && isTeamCredentialProviderModelPickerValue(requestedTransitionSelection)
                ? requestedTransitionSelection
                : null;
            const requestedProviderSelection = requestedTransitionSelection !== null
                && !isTeamCredentialProviderModelPickerValue(requestedTransitionSelection)
                ? requestedTransitionSelection
                : null;
            const requestedProviderGroup = requestedProviderSelection?.providerConnectionId
                ? providerModelProjection.data?.groups.find(
                    (group) => group.connectionId === requestedProviderSelection.providerConnectionId,
                ) ?? null
                : null;
            const requestedTeamResourceName = requestedTeamSelection
                ? teamCredentialCatalog.resources.find((resource) => (
                    resource.id === requestedTeamSelection.resourceId
                    && resource.teamId === requestedTeamSelection.teamId
                ))?.displayName ?? null
                : null;
            // Active Sessions already present this exact selection as the D15 arm.
            // Binding drift and unavailable bindings retain their own recovery below.
            const transitionBanner = requestedTransitionSelection && session.active !== true
                ? {
                    kind: 'changed' as const,
                    action: 'restart' as const,
                    providerName: requestedTeamSelection
                        ? requestedTeamResourceName ?? requestedTeamSelection.agentTargetKey
                        : requestedProviderGroup?.providerName
                            ?? providerLaunchBinding?.displaySnapshot.providerName
                            ?? agentId
                            ?? requestedTransitionSelection.agentTargetKey,
                    connectionName: requestedTeamSelection
                        ? requestedTeamSelection.modelId
                        : requestedProviderGroup?.connectionName
                            ?? providerLaunchBinding?.displaySnapshot.connectionName
                            ?? requestedTransitionSelection.modelId,
                }
                : null;
            // A shared Team credential that refused this request is the most
            // specific current fact about the binding, so it outranks the
            // binding's own static states — but never a change the person just
            // asked for, which is still waiting on them.
            // Staleness is the usage-limit owner's rule, reused rather than
            // re-decided: once the runtime has done meaningful work after the
            // refusal, the refusal is history and its banner must go.
            if (transitionBanner === null && !hasMeaningfulActivityAfterRuntimeIssue(sessionRuntimeStatusSource)) {
                const teamCredentialDenial = presentSessionTeamCredentialDenial({
                    issue: sessionRuntimeStatusSource.lastRuntimeIssue ?? null,
                    resolveResourceDisplayName: (resourceId) => teamCredentialCatalog.resources.find(
                        (resource) => resource.id === resourceId,
                    )?.displayName ?? null,
                });
                if (teamCredentialDenial) return teamCredentialDenial;
            }
            const banner = transitionBanner
                ?? providerBindingPresentation?.banner
                ?? (requestedRouteSelection && session.active === true ? null : pendingProviderSwitchBanner);
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
                        title: t(banner.errorPresentation.titleKey),
                        body: t(banner.errorPresentation.descriptionKey),
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
            requestedRouteSelection,
            session.active,
            sessionRuntimeStatusSource.lastRuntimeIssue,
            sessionRuntimeStatusSource.latestTurnStatus,
            sessionRuntimeStatusSource.latestTurnStatusObservedAt,
            sessionRuntimeStatusSource.meaningfulActivityAt,
            teamCredentialCatalog.resources,
        ]);
        // The binding family speaks on the composer's one status line, never as a card: its short state,
        // its one recovery when the viewer can take it, and its body as the line's detail.
        const providerBindingLine = React.useMemo<SessionViewProviderBindingLine | null>(() => providerBindingBanner
            ? {
                text: providerBindingBanner.title,
                ...(providerBindingBanner.body ? { detail: providerBindingBanner.body } : {}),
                action: providerBindingBanner.action === 'restart' && (!hasWriteAccess || isRuntimeFreshActiveTurn)
                    ? null
                    : providerBindingBanner.action,
                color: theme.colors.state.attention.textForeground,
            }
            : null, [hasWriteAccess, isRuntimeFreshActiveTurn, providerBindingBanner, theme.colors.state.attention.textForeground]);
        // Queued input waiting on this Session to start speaks on the same line, never as a card: the
        // producer (`resolvePendingActivationBanner`) keeps the fact; the line states it with one recovery.
        // A managed wake keeps its own badge and popover, which own its observed stages.
        const pendingQueueLine = React.useMemo<SessionViewPendingQueueLine | null>(() => {
            const presentation = pendingActivationPresentation;
            if (!presentation || presentation.managedWakeProjection) return null;
            const action: SessionViewPendingQueueAction | null = presentation.primaryAction && presentation.row
                ? presentation.primaryAction
                : presentation.secondaryAction && presentation.row?.localId ? 'keep_queued' : null;
            return {
                text: t(presentation.titleKey ?? `session.pendingActivation.${presentation.kind}.title`),
                detail: presentation.holdReason === 'managed_power_required'
                    ? t('managedWake.refusedDetail')
                    : t(`session.pendingActivation.${presentation.kind}.body`),
                action,
                color: presentation.kind === 'failed' || presentation.holdReason === 'managed_power_required'
                    ? theme.colors.state.attention.textForeground : sessionStatus.statusColor,
            };
        }, [pendingActivationPresentation, sessionStatus.statusColor, theme.colors.state.attention.textForeground]);
        // An agent exchange paused for the person (lab T1): the held input carries its exact original root.
        const exchangeCheckInRoot = React.useMemo(() => pendingMessages.find((message) =>
            message.pendingDeliveryBlockedReason === 'autonomous_check_in')?.pendingAutonomousExchangeRoot ?? null, [pendingMessages]);
        // The main transcript's queue size, said once on the line instead of a header over the queue.
        const mainPendingCount = React.useMemo(
            () => pendingMessages.filter((message) => isPendingMessageForRecipient(message, undefined)).length,
            [pendingMessages],
        );
        const handlePendingQueueAction = React.useCallback(async (action: SessionViewPendingQueueAction) => {
            if (action === 'resume' || action === 'retry') await handleResumeSession();
            else await handlePendingActivationRequest(action);
        }, [handlePendingActivationRequest, handleResumeSession]);
        // The machine's guard is about to stop this Session, stopped it, or the next message is waking it.
        const guardPresentationKey = JSON.stringify(ownerMetadata?.sessionGuardStateV1 ?? null);
        const guardComposerState = React.useMemo(() => resolveSessionGuardComposerState({
            guard: autoResumeAdmission === 'held_by_person' ? null : readSessionListGuardState(JSON.parse(guardPresentationKey)),
            sessionActive: session.active === true,
            resuming: sessionStatusResuming,
            nowMs: Date.now(),
        }), [autoResumeAdmission, guardPresentationKey, session.active, sessionStatusResuming]);
        const guardMachineId = controlMachineTarget?.machineId ?? null;
        const keepGuardedSessionRunning = React.useCallback(() => {
            if (!guardMachineId) return;
            fireAndForget((async () => {
                const kept = await keepMachineGuardWorkRunningViaAction({ machineId: guardMachineId, serverId: sessionRouteServerId || null,
                    expectedAccountId: null, sessionId });
                if (!kept.ok) Modal.alert(t('machineGuard.session.keepRunning'), t('machineGuard.session.keepRunningFailed'));
            })(), { tag: 'SessionView.guardKeepRunning' });
        }, [guardMachineId, sessionId, sessionRouteServerId]);
        const connectionStatus = React.useMemo(() => resolveSessionViewConnectionStatus({
            connectedServicesRestartState,
            restartingText: t('connectedServices.authSwitch.status.restarting'),
            switchFailedText: t('connectedServices.authSwitch.switchFailed'),
            inactiveStatusText,
            inactiveResumeAvailable: !isSessionActive && isResumable && isMachineReachable
                && hasWriteAccess && !sessionMachineAccessRemoved,
            // The inactive cause's explanation rides the line while the composer shows it.
            inactiveDetail: shouldShowInput ? bottomNotice?.body ?? null : null,
            sessionStatusResuming,
            sessionStatusState: sessionStatus.state,
            sessionStatusText: sessionStatus.statusText,
            sessionStatusColor: sessionStatus.statusColor,
            sessionStatusDotColor: sessionStatus.statusDotColor,
            sessionStatusPulsing: sessionStatus.isPulsing === true,
            guard: { state: guardComposerState, attentionColor: theme.colors.state.attention.textForeground, quietColor: theme.colors.text.tertiary },
            sessionUnservable: isAskHappierStatusOfferState(sessionStatus.state),
            providerBinding: providerBindingLine,
            pendingQueue: {
                line: pendingQueueLine,
                countText: mainPendingCount > 0 ? t('session.pendingMessages.indicator', { count: mainPendingCount }) : null,
            },
        }), [
            providerBindingLine,
            pendingQueueLine,
            mainPendingCount,
            guardComposerState,
            theme.colors.state.attention.textForeground,
            theme.colors.text.tertiary,
            connectedServicesRestartState,
            inactiveStatusText,
            isSessionActive,
            isResumable,
            isMachineReachable,
            hasWriteAccess,
            sessionMachineAccessRemoved,
            shouldShowInput,
            bottomNotice?.body,
            sessionStatus.isPulsing,
            sessionStatus.statusColor,
            sessionStatus.statusDotColor,
            sessionStatusResuming,
            sessionStatus.state,
            sessionStatus.statusText,
        ]);
        // A Session in trouble offers one contextual Ask Happier beside its status (D33); the
        // visible screen travels as safe context, and nothing starts before Send.
        const openAskHappier = useAskHappierOpener();
        // It is the status line's own recovery, so it ends that sentence (lab `b-ask E`).
        const askHappierStatusAction = React.useMemo(() => (
            !embedded && isAskHappierStatusOfferState(sessionStatus.state)
                ? { label: t('bots.guide.offer'), onPress: () => { openAskHappier(); } }
                : null
        ), [embedded, openAskHappier, sessionStatus.state]);
        const askHappierConnectionStatus = React.useMemo(() => (
            connectionStatus && askHappierStatusAction ? { ...connectionStatus, action: askHappierStatusAction } : null
        ), [askHappierStatusAction, connectionStatus]);
        const openSessionModelPicker = React.useCallback(() => {
            setSessionModelPickerRequestKey((current) => String((Number.parseInt(current ?? '0', 10) || 0) + 1));
        }, []);
        // Applies through the transition owner, restarting only when required:
        // the binding banner's Restart and the next-Send armed route (D15).
        // True only once the requested selection is ready; failures are presented.
        const restartSessionRunnerOnRequestedRoute = React.useCallback(async (): Promise<boolean> => {
            if (sessionViewCaller.signal.aborted) return false;
            try {
                // Ask the same transition owner to apply at Send. Live model changes
                // settle here; only its actual restart refusal enters runner restart.
                const requested = effectiveModelTransitionActionRequired?.requestedSelection;
                if (requested && !isTeamCredentialProviderModelPickerValue(requested)) {
                    const result = await actionExecutor.execute('session.model.set', {
                        sessionId, modelId: requested.modelId, providerConnectionId: requested.providerConnectionId,
                        applyTiming: 'immediate',
                    }, { surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId, signal: sessionViewCaller.signal });
                    if (sessionViewCaller.signal.aborted) return false;
                    if (result.ok) { setModelTransitionActionRequired(null); return true; }
                    const transition = SessionModelTransitionResultV1Schema.safeParse({ ok: false,
                        ...(result.details && typeof result.details === 'object' ? result.details : {}) });
                    if (!transition.success || transition.data.status !== 'restart_required') {
                        Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'));
                        return false;
                    }
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
                                signal: sessionViewCaller.signal,
                            })
                            : null
                    );
                if (sessionViewCaller.signal.aborted) return false;
                if (!runtimeStatus) {
                    if (effectiveModelTransitionActionRequired) {
                        Modal.alert(t('common.error'), t('common.requestFailed'));
                    } else {
                        openSessionModelPicker();
                    }
                    return false;
                }
                const exactBindingChange = providerBindingStatus.status?.status === 'changed'
                    ? providerBindingStatus.status
                    : null;
                const result = await restartSessionRunnerForProviderBindingChange({
                    runtimeState: SessionRunnerRuntimeStateV1Schema.parse(runtimeStatus.state),
                    runnerProcessIdentity: runtimeStatus.runnerProcessIdentity,
                    serverId: sessionRouteServerId,
                    signal: sessionViewCaller.signal,
                    ...(exactBindingChange && providerLaunchBinding ? {
                        launchBinding: providerLaunchBinding,
                        nextBindingSecurityFingerprint: exactBindingChange.nextBindingSecurityFingerprint,
                    } : {}),
                });
                if (sessionViewCaller.signal.aborted) return false;
                if (!result) return false;
                if (result.status === 'restarted') {
                    setModelTransitionActionRequired(null);
                    return true;
                }
                Modal.alert(t('common.error'), t('common.requestFailed'));
                return false;
            } catch (error) {
                if (sessionViewCaller.signal.aborted) return false;
                throw error;
            }
        }, [
            actionExecutor,
            effectiveModelTransitionActionRequired,
            openSessionModelPicker,
            providerBindingStatus.status,
            providerLaunchBinding,
            sessionRouteServerId,
            sessionRunnerRuntimeStatus,
            sessionViewCaller,
            sessionId,
            staleSessionRunnerMachineId,
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
            await restartSessionRunnerOnRequestedRoute();
        }, [
            hasWriteAccess,
            openSessionModelPicker,
            providerBindingBanner,
            providerBindingStatus.refresh,
            restartSessionRunnerOnRequestedRoute,
        ]);
        // D15: a route or model picked while the session runs is armed for the next message, exactly
        // like an Agent switch — the send control names it and the send applies it before dispatch.
        // The arm IS the session's pending model selection; its explicit cancel is the un-arm Action below.
        const routeChangeArmed = Boolean(effectiveModelTransitionActionRequired) && session.active === true;
        // A model picked from the source the session already runs through changes only the model:
        // the send control names that model, never the unchanged source as if it were switching.
        const armedRequestedSelection = effectiveModelTransitionActionRequired?.requestedSelection ?? null;
        const armedModelOnly = routeChangeArmed
            && sessionConnectedServicesAuthSwitch.routePresentation != null
            && isArmedModelOnlySessionChange(sessionConnectedServicesAuthSwitch.routePresentation);
        const armedModelLabel = React.useMemo(() => {
            if (!routeChangeArmed || !armedRequestedSelection) return null;
            const modelId = armedRequestedSelection.modelId;
            if (isTeamCredentialProviderModelPickerValue(armedRequestedSelection)) return modelId;
            if (armedRequestedSelection.providerConnectionId !== null) {
                return providerModelProjection.data?.groups
                    .find(group => group.connectionId === armedRequestedSelection.providerConnectionId)
                    ?.rows.find(row => row.ref.modelId === modelId)?.descriptor.name || modelId;
            }
            return (agentId ? resolveSessionModelLabel(agentId, composerOptionsInput, modelId) : null) ?? modelId;
        }, [agentId, routeChangeArmed, armedRequestedSelection, composerOptionsInput, providerModelProjection.data?.groups]);
        const armedRouteSourceLabel = routeChangeArmed && !armedModelOnly
            ? sessionConnectedServicesAuthSwitch.armedRouteSourceLabel
            : null;
        const armedRouteContinuation = React.useMemo(
            () => armedRouteSourceLabel ? { sourceLabel: armedRouteSourceLabel }
                : armedModelLabel ? { modelLabel: armedModelLabel } : null,
            [armedModelLabel, armedRouteSourceLabel],
        );
        // D15's explicit cancel: the Session's own un-arm Action restores the applied route and model;
        // nothing is sent and the draft stays. A refusal is said, never swallowed.
        const { unarm: unarmSessionModel } = useSessionModelUnarm({ sessionId, serverId: sessionRouteServerId });
        const [unarmRoutePending, setUnarmRoutePending] = React.useState(false);
        const unarmRoute = React.useCallback(() => {
            setUnarmRoutePending(true);
            void unarmSessionModel().then((result) => {
                if (!result.ok) {
                    Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'));
                }
            }).finally(() => setUnarmRoutePending(false));
        }, [unarmSessionModel]);
        // The picker is built before this hook resolves the Agent's own account, so its heading reads it here.
        const sessionNativeSourceLabel = sessionConnectedServicesAuthSwitch.nativeSourceLabel;
        const existingSessionModelPickerWithNativeSource = React.useMemo(() => existingSessionModelPicker ? (
            <SessionModelNativeSourceLabelContext.Provider value={sessionNativeSourceLabel}>
                {existingSessionModelPicker}
            </SessionModelNativeSourceLabelContext.Provider>
        ) : undefined, [existingSessionModelPicker, sessionNativeSourceLabel]);
        const sessionCapabilitiesApplyBadge = sessionCapabilities.applyBadge;
        const managedWakeStatusBadge = React.useMemo<AgentInputStatusBadge | null>(() => {
            if (!pendingActivationPresentation?.managedWakeProjection) return null;
            return {
                key: 'session-managedWake',
                testID: `session.managedWake.${pendingActivationPresentation.managedWakeProjection.kind}.badge`,
                label: describeManagedWakeLabel(pendingActivationPresentation.managedWakeProjection, managedWakeNames),
                labelNumberOfLines: 0,
                accessibilityLabel: describeManagedWakeLabel(pendingActivationPresentation.managedWakeProjection, managedWakeNames),
                tone: ['agentStartFailed', 'resourceAbsent', 'storageLost', 'unavailable', 'deliveryUnknown'].includes(pendingActivationPresentation.managedWakeProjection.kind)
                    ? 'warning' : 'neutral',
                icon: (tint: string) => <Icon name="desktop" size={14} color={tint} />,
                renderPopover: ({ open, anchorRef, onRequestClose }) => <ManagedWakePopover open={open} anchorRef={anchorRef}
                    onRequestClose={onRequestClose} projection={pendingActivationPresentation.managedWakeProjection!}
                    {...managedWakeNames} busy={pendingActivationActionBusy || pendingRecoveryApproval.approvalPending}
                    controllerPresence={managedWakeController ? describeMachinePresenceLine(managedWakeController, undefined, undefined, sessionAccountScope).label : t('status.unknown')}
                    onOpenMachine={() => { const target = managedWakeAuthorization?.managedWakeTargetV1;
                        if (target && sessionAccountScope) router.push(machineCollectionHref({ serverId: sessionAccountScope.serverId,
                            machineId: target.enrolledMachineId })); }}
                    onOpenController={() => { const controller = managedPendingMachine?.controller ?? managedWakeAuthorization?.managedWakeTargetV1?.controller;
                        if (controller && sessionAccountScope) router.push(machineCollectionHref({ serverId: sessionAccountScope.serverId,
                            machineId: controller.machineId })); }}
                    onCheckNow={() => fireAndForget(handleManagedWakeRecovery('inspect'), { tag: 'SessionView.managedWake.inspect' })}
                    {...((pendingActivationPresentation.primaryAction === 'retry' || pendingActivationPresentation.primaryAction === 'process_when_online') && pendingActivationPresentation.row
                        ? { onRetry: () => fireAndForget(handleManagedWakeRecovery('retry'), { tag: 'SessionView.managedWake.retry' }) } : {})}
                    {...(pendingActivationPresentation.managedWakeProjection?.canResumeRuntime && pendingActivationPresentation.row
                        ? { onResume: () => fireAndForget(handleManagedWakeRecovery('resume'), { tag: 'SessionView.managedWake.resume' }) } : {})}
                    {...(pendingActivationPresentation.managedWakeProjection?.canWithdraw && pendingActivationPresentation.row
                        && pendingActivationPresentation.row.pendingDecryption?.kind !== 'loading'
                        ? { onWithdraw: () => fireAndForget(handleManagedWakeRecovery('withdraw'), { tag: 'SessionView.managedWake.withdraw' }) } : {})}
                />,
            };
        }, [pendingActivationPresentation, managedWakeNames, pendingActivationActionBusy, pendingRecoveryApproval.approvalPending,
            managedWakeController, sessionAccountScope, managedWakeAuthorization, managedPendingMachine,
            router, handleManagedWakeRecovery, t]);
        const hasConnectedServicesAuthChip = Boolean(sessionConnectedServicesAuthSwitch.connectedServicesAuthChip);
        const agentInputStatusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
            const badges: AgentInputStatusBadge[] = [
            ...(sessionCapabilitiesApplyBadge ? [sessionCapabilitiesApplyBadge] : []),
            ...sessionConnectedServicesAuthSwitch.statusBadges,
            ...(draftSyncStatusBadge ? [draftSyncStatusBadge] : []),
            ...(draftConflictBanner.statusBadge ? [draftConflictBanner.statusBadge] : []),
            // The "Runs through" chip already names this Provider; the badge names it only where the Agent
            // has no route chip. A binding problem is the status line's cause, never said again here.
            ...(providerLaunchBinding && providerBindingPresentation
                && !hasConnectedServicesAuthChip
                ? [{
                    key: 'provider-binding',
                    label: providerBindingLaunchLabel ?? providerBindingPresentation.launchLabel,
                    accessibilityLabel: providerBindingLaunchLabel ?? providerBindingPresentation.launchLabel,
                    testID: 'session.providerBinding.badge',
                    tone: 'neutral' as const,
                    emphasis: 'quiet' as const,
                    icon: (tint: string) => <Icon name="cube" size={14} color={tint} />,
                    onPress: openSessionModelPicker,
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
            ...(managedWakeStatusBadge ? [managedWakeStatusBadge] : []),
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
            ];
            return badges.length > 0 ? [...sessionStatusBadges, ...badges] : sessionStatusBadges;
        }, [
            agentTransitionOutcomeBanner.collapsed,
            agentTransitionOutcomeBanner.toggle,
            armedContinuationNotice,
            authRecoveryBanner.collapsed,
            authRecoveryBanner.toggle,
            authSurfaceState,
            cancelPendingMessageEdit,
            draftConflictBanner.statusBadge,
            draftSyncStatusBadge,
            externalTranscriptAuthority?.kind,
            externalTranscriptSnapshotBanner.collapsed,
            externalTranscriptSnapshotBanner.toggle,
            pendingMessageEdit,
            managedWakeStatusBadge,
            openSessionModelPicker,
            providerBindingPresentation,
            providerBindingLaunchLabel,
            providerLaunchBinding,
            hasConnectedServicesAuthChip,
            sessionConnectedServicesAuthSwitch.statusBadges,
            sessionStatusBadges,
            sessionCapabilitiesApplyBadge,
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
                continuation: sessionGoalContinuation,
            })];
        }, [
            canEditSessionGoals,
            clearSessionGoalForView,
            sessionGoalContinuation,
            sessionGoalActionCapabilityProfile,
            sessionWorkStateSnapshot,
            setSessionGoalForView,
        ]);
        // Memoized so the chips prop keeps a stable identity across SessionView
        // re-renders (each combine call allocates a fresh array); an unstable
        // array would defeat AgentInput's memo on every turn-state commit (R1).
        const agentInputExtraActionChips = React.useMemo(
            // Plugin/embed mounts stay minimal; the trusted app peek retains the Session's controls.
            () => embedded && embedded.composerControls !== 'session' ? sessionExtraActionPresentation.actionChips : combineSessionViewExtraActionChips(
                combineSessionViewExtraActionChips(
                    combineSessionViewExtraActionChips(
                        combineSessionViewExtraActionChips(
                            combineSessionViewExtraActionChips(
                                combineSessionViewExtraActionChips(sessionExtraActionPresentation.actionChips, sessionWorkflowRunChips),
                                sessionGoalActionChips,
                            ),
                            composerPluginActionChips,
                        ),
                        !armedContinuationTarget && sessionCapabilitiesChip ? [sessionCapabilitiesChip] : undefined,
                    ),
                    sessionConnectedServicesAuthSwitch.connectedServicesAuthChip
                        ? [sessionConnectedServicesAuthSwitch.connectedServicesAuthChip]
                        : undefined,
                ),
                routingControls.extraActionChips,
            ),
            [
                sessionExtraActionPresentation.actionChips,
                sessionWorkflowRunChips,
                sessionGoalActionChips,
                composerPluginActionChips,
                armedContinuationTarget,
                sessionCapabilitiesChip,
                sessionConnectedServicesAuthSwitch.connectedServicesAuthChip,
                routingControls.extraActionChips,
                embedded,
            ],
        );
        // The chips another surface may ask this composer to open (the Goal control). A change wakes
        // the registry's readers ("+" › Keep going until done…) and delivers a waiting request.
        // Keyed by the chip keys, not the chip objects, which change with every work-state update.
        const composerActionChipKeySignature = (agentInputExtraActionChips ?? []).map((chip) => chip.key).join('\n');
        const composerActionChipKeys = React.useMemo(
            () => new Set(composerActionChipKeySignature ? composerActionChipKeySignature.split('\n') : []),
            [composerActionChipKeySignature],
        );
        composerActionChipKeysRef.current = composerActionChipKeys;
        React.useEffect(() => {
            notifySessionComposerPresentationTargetChanged(sessionId);
            if (surfaceFocused && surfacePresented) flushPendingRegisteredSessionComposerActionChip(sessionComposerAddress);
        }, [composerActionChipKeys, sessionComposerAddress, sessionId, surfaceFocused, surfacePresented]);

    const { openFiles: openFileViewer } = useSessionFilePaneNavigation({
        scopeId: pane.scopeId,
        sessionId,
        serverId: sessionRouteServerId,
    });

    const publishedRuntimeCapabilities = ownerMetadata?.agentRuntimeCapabilitiesV1;
    const sessionCompactionCapability = React.useMemo(() => lifecycleAgentId ? evaluateAgentSessionCompactionCapability({
        agentId: lifecycleAgentId,
        metadata: { agentRuntimeCapabilitiesV1: publishedRuntimeCapabilities },
        declaredCapability: null,
    }) : null, [lifecycleAgentId, publishedRuntimeCapabilities]);
    const getAutocompleteSuggestions = useSessionComposerSuggestions({
        sessionId,
        kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
        composerReferenceHost,
        actionController: composerPluginActionController,
        skillSource: sessionComposerSkillSource,
        compaction: sessionCompactionCapability,
    });

    // Stable identities for the memoized AgentInput (R1 churn fix). SessionView
    // re-renders on every turn-state commit; inline callback props would defeat
    // AgentInput's React.memo and re-execute the 3k-line composer body each time.
    // The send handler closes over a lot of per-render state, so a ref is pointed
    // at the freshest closure (refreshed in render, just below) and AgentInput is
    // handed a permanently stable wrapper that forwards to it.
    const composerSendMode = useSetting('sessionMessageSendMode');
    const composerBusySteerSendPolicy = useSetting('sessionBusySteerSendPolicy');
    const composerSendActions = resolveSessionComposerSendActions({
        configuredMode: composerSendMode, busySteerSendPolicy: composerBusySteerSendPolicy, session,
    });
    const canChooseComposerSendActions = !pendingMessageEdit && !pendingComposerDocument
        && !recipientState.recipient && !recipientState.scmDiffSummaryDiscussion
        && !armedContinuationTarget && !armedRouteContinuation
        && resolveVoiceSessionComposerRouting({ conversationSessionId: sessionId, sessionMetadata: ownerMetadata })?.kind !== 'adapter_text';
    const agentInputSendRef = React.useRef<(options?: AgentInputSendOptions) => void>(() => {});
    const handleAgentInputSend = React.useCallback(
        (options?: AgentInputSendOptions) => { agentInputSendRef.current(options); },
        [],
    );
    const handleAgentInputAbort = useEventCallback(async () => {
        const lifetime = sessionAccountLifetime;
        try {
            requireActionSuccess(await actionExecutor.execute('session.turn.cancel', { sessionId }, {
                surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId,
            }));
        } catch (error) {
            presentSessionActionOutcome(error, lifetime);
        }
    });

    const sessionTypingPresence = React.useMemo(() => ({
        serverId: sessionRouteServerId,
        canSubmitAgentInput: session.access?.capabilities.submitAgentInput === true,
    }), [sessionRouteServerId, session.access?.capabilities.submitAgentInput]);
    const agentCatalogMachineId = controlMachineTarget?.machineId ?? machineId ?? null;
    const agentCatalogCurrent = daemonMergedProjection.phase === 'ready';
    const agentCatalogIdentity = React.useMemo(() => currentSessionAgentCatalogEntry ? {
        entry: currentSessionAgentCatalogEntry,
        machineId: agentCatalogMachineId,
        serverId: sessionRouteServerId,
        current: agentCatalogCurrent,
    } : undefined, [currentSessionAgentCatalogEntry, agentCatalogMachineId, sessionRouteServerId, agentCatalogCurrent]);
    const input = shouldShowInput ? (
        <PluginContextualResourceStoreProvider>
            <View>
            {authSurfaceState && !authRecoveryBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionAuthRecoveryBanner message={authSurfaceState.message} />
                </ComposerAuxiliaryFrame>
            ) : null}
            {temporaryComputerRecovery.status === 'failed' ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-temporaryComputer-initialAttachmentRecovery"
                        tone="warning"
                        title={t('newSession.temporaryComputer.status.failed')}
                        body={t('inbox.actionOperations.followUpNeedsAttention')}
                        actionTestID="session-temporaryComputer-initialAttachmentRecovery-retry"
                        actionLabel={t('common.retry')}
                        actionAccessibilityLabel={t('common.retry')}
                        onActionPress={temporaryComputerRecovery.retry}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {exchangeCheckInRoot && sessionRouteServerId && hasWriteAccess ? (
                <ComposerAuxiliaryFrame>
                    <SessionExchangeCheckInBanner serverId={sessionRouteServerId} root={exchangeCheckInRoot} />
                </ComposerAuxiliaryFrame>
            ) : null}
            {currentDirectoryRecovery ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-directory-missing"
                        tone="warning"
                        title={t('sessionDirectoryRecovery.title', { machine: machineName })}
                        body={t('sessionDirectoryRecovery.body')}
                        actionTestID="session-directory-missing-continue"
                        actionLabel={t('sessionDirectoryRecovery.continue')}
                        actionAccessibilityLabel={t('sessionDirectoryRecovery.continue')}
                        onActionPress={handleContinueInFreshFolder}
                        actionBusy={currentDirectoryRecovery.busy}
                        disabled={currentDirectoryRecovery.busy}
                        secondaryActions={[{
                            key: 'not-now', testID: 'session-directory-missing-not-now',
                            label: t('sessionDirectoryRecovery.notNow'), variant: 'quiet',
                            accessibilityLabel: t('sessionDirectoryRecovery.notNow'),
                            disabled: currentDirectoryRecovery.busy,
                            onPress: () => setDirectoryRecovery(null),
                        }]}
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
            {visibleUsageLimitRecoveryPresentation ? (
                <ComposerAuxiliaryFrame>
                    <SessionUsageLimitRecoveryBanner
                        temporaryThrottle={visibleUsageLimitRecoveryPresentation.banner.temporaryThrottle}
                        surfaceFocused={surfaceFocused}
                        testID={visibleUsageLimitRecoveryPresentation.banner.testID}
                        actionTestID={visibleUsageLimitRecoveryPresentation.banner.actionTestID}
                        title={visibleUsageLimitRecoveryPresentation.banner.title}
                        body={visibleUsageLimitRecoveryPresentation.banner.body}
                        actionLabel={visibleUsageLimitRecoveryPresentation.banner.actionLabel}
                        actionAccessibilityLabel={visibleUsageLimitRecoveryPresentation.banner.actionAccessibilityLabel}
                        disabled={usageLimitRecoveryActionsDisabled || !hasWriteAccess || visibleUsageLimitRecoveryPresentation.banner.actionsDisabled}
                        onActionPress={() => handleUsageLimitRecoveryAction(visibleUsageLimitRecoveryPresentation.banner.mode)}
                        secondaryActions={visibleUsageLimitRecoveryPresentation.banner.secondaryActions.map((action) => ({
                            key: action.kind,
                            accessibilityLabel: action.accessibilityLabel,
                            label: action.label,
                            testID: action.testID,
                            disabled: usageLimitRecoveryActionsDisabled || !hasWriteAccess || visibleUsageLimitRecoveryPresentation.banner.actionsDisabled,
                            onPress: () => handleUsageLimitRecoveryAction(action.kind),
                        }))}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            {nearLimitPresentation && providerUsageRecoveryCreditAction ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-near-limit-banner"
                        actionTestID="session-near-limit-banner:apply-reset"
                        title={nearLimitPresentation.accountLabel
                            ? t('connectedServicesSettings.nearLimitTitle', {
                                account: nearLimitPresentation.accountLabel,
                                percent: nearLimitPresentation.remainingPct,
                                window: nearLimitPresentation.windowLabel,
                            })
                            : t('connectedServicesSettings.nearLimitTitleNoAccount', {
                                percent: nearLimitPresentation.remainingPct,
                                window: nearLimitPresentation.windowLabel,
                            })}
                        body={nearLimitPresentation.resetsAt !== null
                            ? t('connectedServicesSettings.nearLimitBodyWithReset', {
                                time: formatResetAtTime(nearLimitPresentation.resetsAt),
                            })
                            : t('connectedServicesSettings.nearLimitBody')}
                        actionLabel={t('connectedServicesSettings.nearLimitApplyReset')}
                        actionAccessibilityLabel={t('connectedServicesSettings.nearLimitApplyReset')}
                        actionBusy={providerUsageRecoveryCreditActionPending}
                        disabled={!hasWriteAccess || providerUsageRecoveryCreditActionPending}
                        onActionPress={providerUsageRecoveryCreditAction}
                        secondaryActions={[{
                            key: 'dismiss',
                            label: t('connectedServicesSettings.notNow'),
                            accessibilityLabel: t('connectedServicesSettings.notNow'),
                            testID: 'session-near-limit-banner:dismiss',
                            variant: 'quiet',
                            onPress: () => setNearLimitDismissedKeys(dismissSessionNearLimit(nearLimitPresentation.key)),
                        }]}
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
            {sessionAccountScope
                && sessionAccountLifetime?.isCurrent()
                && currentSessionDraftConflict
                && !draftConflictBanner.collapsed ? (
                <ComposerAuxiliaryFrame>
                    <SessionDraftConflictResolution
                        scope={sessionAccountScope}
                        address={sessionDraftAddress}
                        conflict={currentSessionDraftConflict}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
            <PendingNavigationSettledNotice address={companionAddress} />
            <PendingNavigationPill address={companionAddress} presentation="composer" composerText={composerTextStore} />
            <SessionComposerAgentInput
                composerRef={activeComposerRef}
                composerReferenceHost={composerDropReferenceHost}
                composerFileScope={companionAddress ? reviewScope : null}
                textStore={composerTextStore}
                structuredInputPersistence={inputComposerPersistence.structuredInputPersistence}
                pendingText={pendingComposerDocument?.text ?? null}
                placeholder={isReadOnly
                    ? t('session.sharing.viewOnlyMode')
                    : guardComposerState?.kind === 'stopped'
                        ? guardComposerState.placeholder
                    : externalSessionOperationShell.composerPlaceholderKey
                        ? t(externalSessionOperationShell.composerPlaceholderKey)
                        : t('session.inputPlaceholder')}
                onChangeText={setVisibleComposerDraftValue}
                onComposerFocusChange={onComposerFocusChange}
                onComposerFocusRequestChange={onComposerFocusRequestChange}
                onPromptPickerOpenRequestChange={onPromptPickerOpenRequestChange}
                onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
                composerDecorations={composerInputEffects.composerDecorations}
                composerInputLock={composerInputEffects.composerInputLock}
                sessionId={sessionId}
                sessionAddress={companionAddress}
                resetStartEnabled={hasWriteAccess && !pendingComposerDocument
                    && !recipientState.recipient && !recipientState.scmDiffSummaryDiscussion
                    && resolveVoiceSessionComposerRouting({ conversationSessionId: sessionId, sessionMetadata: ownerMetadata })?.kind !== 'adapter_text'}
                surfacePresented={surfacePresented}
                sessionTypingPresence={sessionTypingPresence}
                contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET}
                agentType={agentInputAgentType ?? undefined}
                agentLabel={agentInputAgentType ? resolveSessionActionDefaultBackendTitle({
                    session,
                    sessionActionDefaultBackendEntryTitle: sessionActionDefaultBackendEntry?.title ?? null,
                }) || undefined : undefined}
                agentCatalogIdentity={agentCatalogIdentity}
                armedContinuationTarget={armedContinuationTarget}
                sendMenuModes={canChooseComposerSendActions ? composerSendActions.modes : undefined}
                alternateSendMode={composerSendActions.alternateMode}
                canSendNextQueued={canChooseComposerSendActions}
                armedRouteContinuation={armedRouteContinuation}
                onUnarmRoute={armedRouteContinuation && hasWriteAccess ? unarmRoute : null}
                unarmRoutePending={unarmRoutePending}
                composeAgentPickerOptions={embedded ? undefined : composeAgentPickerOptionsWithRoles}
                inputPresentation={embeddedComposerControlsOnly ? 'controlsOnly' : undefined}
                {...(embeddedComposerControls ? {
                    voiceAffordance: embeddedComposerControls.voiceAffordance,
                    engineControls: embeddedComposerControls.engineControls,
                } : {})}
                onAgentPickerVisibilityChange={onAgentPickerVisibilityChange}
                agentPickerSelectedOptionId={inSessionAgentPicker.agentPickerSelectedOptionId}
                onAttachmentsAdded={attachmentsUploadsAvailable && !pendingComposerDocument ? addAttachments : undefined}
                hasSendableAttachments={
                    (!pendingComposerDocument && hasIncludedReviewCommentDrafts)
                    || (!pendingComposerDocument && sendableAttachmentDrafts(attachmentDrafts).length > 0)
                    || composerAttachmentViews.some((attachment) => attachment.availability.status === 'ready')
                }
                permissionRequests={pendingPermissionRequests}
                approvalRequests={approvalRequests}
                canApprovePermissions={transcriptInteraction.canApprovePermissions}
                permissionDisabledReason={transcriptInteraction.permissionDisabledReason}
                permissionMode={permissionMode}
                allowedPermissionModes={embedded?.permissionModePicker ?? null}
                // Embedded: the mode stays a label unless the embed allows more than one mode (plan 04 §4.6).
                // A controls-only composer offers only the granted model control.
                onPermissionModeChange={!embeddedComposerControlsOnly && (!embedded || (embedded.permissionModePicker?.length ?? 0) > 1) ? updatePermissionMode : undefined}
                onAcpSessionModeChange={!embedded && sessionModePickerControl ? updateAcpSessionModeOverride : undefined}
                onAcpConfigOptionChange={embeddedComposerControlsOnly ? undefined : updateAcpConfigOptionOverride}
                modelMode={modelMode}
                modelPickerPresentation={modelPickerPresentation}
                sessionActive={isSessionActive}
                agentTargetKey={providerAgentTargetKey}
                currentRunnerProcessIdentity={currentRunnerProcessIdentity}
                onModelModeChange={updateModelMode}
                modelContentOverride={existingSessionModelPickerWithNativeSource}
                openModelPickerRequestKey={sessionModelPickerRequestKey}
                openActionChipRequest={composerActionChipOpenRequest}
                metadata={ownerMetadata}
                composerOptionsInput={composerOptionsInput}
                profileId={liveComposerState.profileId ?? undefined}
                onProfileClick={!embedded && liveComposerState.profileId !== null ? () => {
                    const profileId = liveComposerState.profileId;
                    const profileInfo = (profileId === null || (typeof profileId === 'string' && profileId.trim() === ''))
                        ? t('profiles.noProfile')
                        : (typeof profileId === 'string' ? profileId : t('status.unknown'));
                    Modal.alert(
                        t('profiles.title'),
                        `${t('profiles.sessionUses', { profile: profileInfo })}\n\n${t('profiles.profilesFixedPerSession')}`,
                    );
                } : undefined}
                connectionStatus={connectionStatus
                    ? connectionStatus.guardAction === 'keep_running' && guardMachineId
                        ? { ...connectionStatus, action: { label: t('machineGuard.session.keepRunning'), onPress: keepGuardedSessionRunning } }
                        : connectionStatus.providerBindingAction && providerBindingBanner
                            ? { ...connectionStatus, action: { label: providerBindingBanner.actionLabel, onPress: handleProviderBindingAction } }
                            : connectionStatus.pendingQueueAction
                                ? { ...connectionStatus, action: {
                                    label: t(`session.pendingActivation.actions.${connectionStatus.pendingQueueAction === 'keep_queued' ? 'keepQueued' : connectionStatus.pendingQueueAction}`),
                                    onPress: () => fireAndForget(handlePendingQueueAction(connectionStatus.pendingQueueAction!), { tag: 'SessionView.pendingQueueAction' }),
                                } }
                                : connectionStatus.inactiveAction === 'resume'
                                    ? { ...connectionStatus, action: {
                                        label: t('session.pendingActivation.actions.resume'),
                                        onPress: () => fireAndForget(handleResumeSession(), { tag: 'SessionView.resume' }),
                                    } }
                                    : askHappierConnectionStatus ?? connectionStatus
                    : undefined}
                // Stable wrapper (handleAgentInputSend) so AgentInput's memo holds;
                // the assignment refreshes the latest-send ref with this render's
                // closure, then the expression evaluates to the stable wrapper (R1).
                onSend={(agentInputSendRef.current = (sendOptions) => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }
                    const outboundAccountLifetime = sessionAccountLifetime;
                    if (!outboundAccountLifetime?.isCurrent()) return;
                    if (externalSessionOperationShell.blocksNewOperation) return;
                    if (composerInputEffects.readComposerInputLock() !== null) return;

                    fireAndForget(runWithSessionComposerAdmissionReservation(async () => {
                    const activePendingEdit = pendingMessageEditRef.current;
                    if (sendOptions?.resetStart && activePendingEdit) return;
                    const composerMessage = activePendingEdit?.document.text
                        ?? sendOptions?.inputTextOverride
                        ?? readLatestDraftValue();
                    if (sendOptions?.sendNextQueued) {
                        const message = pendingMessages[0];
                        if (!canChooseComposerSendActions || activePendingEdit || composerMessage.trim()
                            || sendableAttachmentDrafts(getAttachmentDraftsSnapshot()).length > 0 || hasIncludedReviewCommentDrafts
                            || !message || !canUseDirectPendingDeliveryActions(message)
                            || (sendOptions.deliveryIntent !== 'agent_queue' && sendOptions.deliveryIntent !== 'interrupt')) return;
                        setIsComposerSending(true);
                        try {
                            await sendPendingMessageWithIntent({ sessionId, serverId: sessionRouteServerId ?? undefined, session, message,
                                deliveryIntent: sendOptions.deliveryIntent === 'interrupt' ? 'interrupt_and_send' : 'steer_now',
                                isCurrent: () => outboundAccountLifetime.isCurrent(),
                            });
                        } finally { if (outboundAccountLifetime.isCurrent()) setIsComposerSending(false); }
                        return;
                    }
                    if (activePendingEdit) {
                        const pendingAccountLifetime = activePendingEdit.accountLifetime;
                        const pendingComposerSnapshot = readPendingMessageComposerSnapshot(activePendingEdit);
                        setIsComposerSending(true);
                        try {
                                let acceptedReplacementLocalId: string | null = null;
                                let acceptedPreparedAttachments: readonly ComposerAttachmentInputV1[] | null = null;
                                let postAcceptanceError: unknown = null;
                                const result = await submitComposerSnapshot({
                                    snapshot: pendingComposerSnapshot,
                                    signal: composerPluginActionScopeSignal,
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
                                                if (composerPluginActionScopeSignal.aborted) return false;
                                                const currentEdit = pendingMessageEditRef.current;
                                                return currentEdit !== null
                                                    && currentEdit.pendingId === activePendingEdit.pendingId
                                                    && currentEdit.localId === activePendingEdit.localId
                                                    && isPendingMessageEditAccountCurrent(activePendingEdit)
                                                    && isPendingMessageComposerSubmissionSnapshotCurrent(currentEdit, pendingComposerSnapshot);
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
                                            let preparedForAbandon: Extract<
                                                import('@happier-dev/protocol').SessionPendingMessageComposerAdmissionPrepareResponseV1,
                                                { ok: true }
                                            > | null = null;
                                            let pendingPatchAccepted = false;
                                            let preparedAbandoned = false;
                                            const abandonPrepared = async (): Promise<void> => {
                                                if (preparedAbandoned || !preparedForAbandon?.sessionMediaCleanup) return;
                                                if (pendingAccountLifetime && !pendingAccountLifetime.isCurrent()) return;
                                                const abandonment: SessionPendingMessageComposerAdmissionAbandonedRequestV1 = {
                                                    sessionId,
                                                    localId: candidate.localId,
                                                    structuredInput: preparedForAbandon.structuredInput,
                                                    stagedMediaHandles: preparedForAbandon.stagedMediaHandles ?? [],
                                                    ...(preparedForAbandon.stagedMediaReleaseIntents
                                                        ? { stagedMediaReleaseIntents: preparedForAbandon.stagedMediaReleaseIntents }
                                                        : {}),
                                                    sessionMediaCleanup: preparedForAbandon.sessionMediaCleanup,
                                                };
                                                await abandonPendingMessageComposerAdmission(sessionId, abandonment, {
                                                    serverId: sessionRouteServerId,
                                                    ...(pendingAccountLifetime ? { accountLifetime: pendingAccountLifetime } : {}),
                                                });
                                                preparedAbandoned = true;
                                            };
                                            try {
                                                const prepared = await preparePendingMessageComposerAdmission(sessionId, {
                                                    localId: candidate.localId,
                                                    text: snapshot.text,
                                                    structuredInput: rawStructuredInput,
                                                    sourceComposerRef: snapshot.ref,
                                                }, {
                                                    serverId: sessionRouteServerId,
                                                    signal: composerPluginActionScopeSignal,
                                                    ...(pendingAccountLifetime ? { accountLifetime: pendingAccountLifetime } : {}),
                                                });
                                                if (prepared.ok) preparedForAbandon = prepared;
                                                if (!prepared.ok || !isStructuredInputCurrent()) {
                                                    await abandonPrepared();
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
                                                            ...(prepared.stagedMediaReleaseIntents
                                                                ? { stagedMediaReleaseIntents: prepared.stagedMediaReleaseIntents }
                                                                : {}),
                                                            ...(prepared.sessionMediaMetadata
                                                                ? { sessionMediaMetadata: prepared.sessionMediaMetadata }
                                                                : {}),
                                                        },
                                                        serverId: sessionRouteServerId,
                                                        ...(pendingAccountLifetime ? {
                                                            accountLifetime: pendingAccountLifetime,
                                                            session,
                                                        } : {}),
                                                    },
                                                );
                                                if (!acceptedComposerAdmission) {
                                                    await abandonPrepared();
                                                    throw new Error('Pending Composer PATCH accepted without its canonical admission fact');
                                                }
                                                pendingPatchAccepted = true;
                                                acceptedReplacementLocalId = acceptedComposerAdmission.localId === activePendingEdit.localId
                                                    ? null
                                                    : acceptedComposerAdmission.localId;
                                                acceptedPreparedAttachments = acceptedComposerAdmission.structuredInput.composerAttachments ?? [];
                                                try {
                                                    if (pendingAccountLifetime && !pendingAccountLifetime.isCurrent()) {
                                                        return { status: 'accepted' };
                                                    }
                                                    await acceptPendingMessageComposerAdmission(sessionId, acceptedComposerAdmission, {
                                                        serverId: sessionRouteServerId,
                                                        ...(pendingAccountLifetime ? { accountLifetime: pendingAccountLifetime } : {}),
                                                    });
                                                } catch (error) {
                                                    // The Pending PATCH is already authoritative. Keep
                                                    // the accepted outcome while surfacing settlement/
                                                    // notification failure to the user below.
                                                    postAcceptanceError = error;
                                                }
                                                return { status: 'accepted' };
                                            } catch (error) {
                                                if (!pendingPatchAccepted) {
                                                    await abandonPrepared().catch(() => undefined);
                                                }
                                                throw error;
                                            }
                                        },
                                    },
                                    clearAcceptedSnapshot: (snapshot) => {
                                        const currentEdit = pendingMessageEditRef.current;
                                        if (!currentEdit || currentEdit.pendingId !== activePendingEdit.pendingId) return false;
                                        if (pendingAccountLifetime && !pendingAccountLifetime.isCurrent()) return false;
                                        if (isPendingMessageComposerSubmissionSnapshotCurrent(currentEdit, snapshot)) {
                                            pendingMessageEditRef.current = null;
                                            pendingComposerDocumentOwnerRef.current = null;
                                            setPendingMessageEdit(null);
                                            clearPendingMessageEditDrainHold(currentEdit);
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
                        const resetStart = sendIntent?.resetStart;
                        if (resetStart && (recipientState.recipient || recipientState.scmDiffSummaryDiscussion)) {
                            Modal.alert(t('common.error'), t('usage.board.plans.resetStartFailed'));
                            return;
                        }
                        const configuredMode = storage.getState().settings.sessionMessageSendMode;
                        const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
                        const sessionInactiveResumePolicy = storage.getState().settings.sessionInactiveResumePolicy;
                        const nonSteerableSendPrompt = storage.getState().settings.sessionNonSteerableSendPrompt;
                        const submittedPermissionMode = readSessionNextPromptPermissionModeFromDraft(
                            getCurrentSessionDraftSnapshot()?.document,
                        );
                        const permissionModeApplyTiming = submittedPermissionMode !== null || storage.getState().settings.sessionPermissionModeApplyTiming === 'next_prompt'
                            ? 'next_prompt' as const
                            : 'current_turn' as const;
                        const forceImmediateSend = sendIntent?.forceImmediate === true;
                        const explicitSubmitMode = !forceImmediateSend ? sendIntent?.deliveryIntent : undefined;

                        // Capture all semantic fields before an asynchronous send-choice prompt.
                        // The canonical draft owner later clears only this exact value/revision snapshot.
                        const semanticDraftSnapshot = captureComposerSemanticDraftCurrentnessSnapshot();
                        const submittedAttachmentDrafts = sendableAttachmentDrafts(getAttachmentDraftsSnapshot());
                        if (submittedAttachmentDrafts.length > 0 && !attachmentsUploadsAvailable) {
                            Modal.alert(t('common.error'), describeUploadFailure(
                                classifyTransferFailure({ errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE }), t('common.machine'),
                            ));
                            return;
                        }
                        const sourceComposerSubmissionSnapshot = readSessionComposerSubmissionSnapshot(composerTextBeforeSend);
                        const composerSubmissionSnapshot = prepareComposerSubmissionSnapshot(
                            sourceComposerSubmissionSnapshot, submittedAttachmentDrafts.map(draft => draft.id),
                        );
                        if (messageToSend === sourceComposerSubmissionSnapshot.text) messageToSend = composerSubmissionSnapshot.text;
                        const additionalMessage = messageToSend;
                        const trimmedText = messageToSend.trim();
                        const composerAttachmentsForSubmit = semanticDraftSnapshot.values['structuredInput.composerAttachments'] ?? [];
                        const hasComposerAttachments = composerAttachmentsForSubmit.length > 0;
                        const scmDiscussion = recipientState.scmDiffSummaryDiscussion;
                        if (scmDiscussion) {
                            // A pending seeded conversation has no Run recipient yet. Its first
                            // message belongs to saved-result admission and can never fall through
                            // to the parent Agent, including slash-command text.
                            if (!trimmedText) return;
                            if (hasComposerAttachments || composerSubmissionSnapshot.references.length > 0
                                || getAttachmentDraftsSnapshot().length > 0 || hasIncludedReviewCommentDrafts) {
                                Modal.alert(t('common.error'), t('session.participants.unsupportedAttachmentsOrReviewComments'));
                                return;
                            }
                            const operations = createScmDiffSummaryResultOperations({
                                sessionId, serverId: sessionRouteServerId,
                                accountId: outboundAccountLifetime.scope.accountId,
                                shouldContinue: () => outboundAccountLifetime.isCurrent(),
                                composerDraft: { scope: outboundAccountLifetime.scope },
                            });
                            setIsComposerSending(true);
                            try {
                                const response = await operations.discuss({ ...scmDiscussion, message: messageToSend });
                                if (!outboundAccountLifetime.isCurrent()) return;
                                if (!response.success) {
                                    Modal.alert(t('common.error'), response.error);
                                    return;
                                }
                                const scopeKey = serverAccountScopeKeySuffix(outboundAccountLifetime.scope);
                                for (const entry of Object.values(getScmDiffSummaryState().entriesByKey)) {
                                    if (entry.scopeKey === scopeKey && entry.sessionId === sessionId
                                        && (entry.latestOutput?.resultId ?? entry.finalSummary?.output.resultId) === response.result.resultId) {
                                        applySavedScmDiffSummaryResult(entry.key, response.result);
                                    }
                                }
                                clearSemanticDraftValuesAfterOutboundHandoff(semanticDraftSnapshot);
                                trackMessageSent();
                                requestMountedTranscriptFollow();
                            } finally {
                                setIsComposerSending(false);
                            }
                            return;
                        }
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
                                ...(semanticDraftSnapshot.values['structuredInput.sessionDiscussionSelectionSourceV1']
                                    ? {
                                        sessionDiscussionSelectionSourceV1:
                                            semanticDraftSnapshot.values['structuredInput.sessionDiscussionSelectionSourceV1'],
                                    }
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
                                {
                                    ...(Object.keys(snapshotMetaOverrides).length > 0 ? snapshotMetaOverrides : {}),
                                    [COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1]: snapshot.ref,
                                },
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

                        const shouldSendReviewComments = hasIncludedReviewCommentDrafts;
                        const hasAttachments = submittedAttachmentDrafts.length > 0;
                        const participantRecipient = recipientState.recipient;
                        const sessionMessaging = readSessionComposerMessageIntent(composerSubmissionSnapshot,
                            sendIntent?.sessionMessage ?? recipientState.sessionMessage ?? undefined);
                        if (sessionMessaging) {
                            if (resetStart || (sessionMessaging.kind === 'post_update' && (hasAttachments || hasIncludedReviewCommentDrafts))) {
                                Modal.alert(t('common.error'), t('common.unavailable'));
                                return;
                            }
                            const capturedLegacyDrafts = hasAttachments ? captureSessionMessageAttachmentDrafts(submittedAttachmentDrafts) : [];
                            const browserContextMeta = mergeBrowserContextMessageMetaOverrides({
                                state: browserContextStateForComposer, metaOverrides: structuredInputMetaOverrides,
                            });
                            if (!browserContextMeta.ok) {
                                Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                                return;
                            }
                            const rawStructuredInput = sanitizeSessionUserMessageSendMeta(browserContextMeta.metaOverrides ?? {}, {
                                text: composerSubmissionSnapshot.text,
                            })[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
                            const baseStructuredInput = rawStructuredInput === undefined ? undefined
                                : RawIngressStructuredInputV1Schema.parse(rawStructuredInput);
                            const resolvedReviewDrafts = shouldSendReviewComments
                                ? await resolveReviewCommentDraftAnchorsForPrompt({ drafts: includedReviewCommentDrafts, reviewScope, signal: sessionViewCaller.signal })
                                : null;
                            const structuredInput = resolvedReviewDrafts || hasAttachments ? {
                                v: 1 as const,
                                ...baseStructuredInput,
                                ...(resolvedReviewDrafts ? { reviewComments: buildReviewCommentsV1MetaPayload({ sessionId, drafts: resolvedReviewDrafts }) } : {}),
                                ...(hasAttachments ? { sessionAttachments: [] } : {}),
                            } : baseStructuredInput;
                            const outboundMessage = resolvedReviewDrafts ? buildReviewCommentsOutboundMessage({
                                sessionId, drafts: resolvedReviewDrafts, additionalMessage: composerSubmissionSnapshot.text,
                            }).text : composerSubmissionSnapshot.text;
                            const attachmentSelectionSummary = formatAttachmentSelectionSummary(capturedLegacyDrafts.map(draft => describeAttachmentUploadSource(draft.source)));
                            const reviewedMessage = attachmentSelectionSummary ? [outboundMessage.trim(), attachmentSelectionSummary].filter(Boolean).join('\n\n') : outboundMessage;
                            if (sessionMessaging.kind === 'post_update' && structuredInput && hasRawStructuredInputSemanticContentV1({
                                happierStructuredInputV1: structuredInput,
                            })) {
                                Modal.alert(t('common.error'), t('common.unavailable'));
                                return;
                            }
                            const transient = captureComposerTransientInputStateForOutboundHandoff({
                                captureTransientInputState: inputComposerPersistence.captureTransientInputState,
                                clearTransientInputState: inputComposerPersistence.clearTransientInputState,
                                restoreTransientInputState: inputComposerPersistence.restoreTransientInputState,
                            });
                            setIsComposerSending(true);
                            try {
                                const attempt = sessionMessaging.kind === 'post_update' ? null : getOrCreateSessionMessagingDraftMutationAttempt({
                                    scope: outboundAccountLifetime.scope, sessionId,
                                    currentness: semanticDraftSnapshot.repositoryCurrentness, intent: sessionMessaging,
                                });
                                if (sessionMessaging.kind !== 'post_update' && !attempt) return;
                                await flushSessionDraftLocally({ scope: outboundAccountLifetime.scope });
                                if (!outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) return;
                                await submitComposerSnapshot({
                                    snapshot: sourceComposerSubmissionSnapshot,
                                    attachmentDraftIds: submittedAttachmentDrafts.map(draft => draft.id),
                                    signal: composerPluginActionScopeSignal,
                                    additionalSendableContent: hasAttachments || shouldSendReviewComments,
                                    route: { kind: 'session', ref: { kind: 'session', sessionId },
                                        readCurrentExecutionTarget: () => composerPluginActionScopeSignal.aborted
                                            ? null : { serverId: sessionRouteServerId, machineId },
                                        admit: async (snapshot, handoff) => {
                                            if (!outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) {
                                                return { status: 'rejected' };
                                            }
                                            const captured = attempt ? await captureSessionComposerMessageAttachments({
                                                structuredInput, sourceComposerRef: snapshot.ref, messageLocalId: attempt.localId,
                                                signal: composerPluginActionScopeSignal, isCurrent: outboundAccountLifetime.isCurrent,
                                            }) : null;
                                            if (attempt && !captured) return { status: 'rejected' };
                                            try {
                                            const targetedExecutor = hasAttachments || captured?.structuredInput?.composerAttachments?.length
                                                ? createDefaultActionExecutor({ sessionMessageComposerSubmission: {
                                                    sourceComposerRef: snapshot.ref, isCurrent: outboundAccountLifetime.isCurrent,
                                                    ...(hasAttachments ? { legacyAttachments: { drafts: capturedLegacyDrafts,
                                                        config: attachmentsUploadConfig, originalMessage: outboundMessage,
                                                        onUploadedDraftCheckpoint: checkpoint => {
                                                            if (!outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) return;
                                                            const submitted = submittedAttachmentDrafts.find(draft => draft.id === checkpoint.id);
                                                            const current = getAttachmentDraftsSnapshot().find(draft => draft.id === checkpoint.id);
                                                            if (!submitted || !current || submitted.source !== current.source) return;
                                                            applyAttachmentDraftPatch(checkpoint.id, { targetUploadedCheckpoints:
                                                                recordAttachmentTargetUploadCheckpoint(current.targetUploadedCheckpoints, checkpoint),
                                                            }, submitted.source);
                                                        },
                                                        onUploadedDraftCheckpointStale: stale => {
                                                            if (!outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) return;
                                                            const attemptedIds = new Set(stale.handles.map(handle => handle.id));
                                                            for (const submitted of submittedAttachmentDrafts) {
                                                                const current = getAttachmentDraftsSnapshot().find(draft => draft.id === submitted.id);
                                                                if (!current || current.source !== submitted.source) continue;
                                                                const previous = current.targetUploadedCheckpoints ?? [];
                                                                const retained = previous.filter(checkpoint =>
                                                                    !isAttachmentTargetUploadCheckpointFor(checkpoint, stale.target, stale.messageLocalId, stale.executionTarget)
                                                                    || !checkpoint.attachmentHandle || !attemptedIds.has(checkpoint.attachmentHandle.id));
                                                                if (retained.length !== previous.length) {
                                                                    applyAttachmentDraftPatch(submitted.id, { targetUploadedCheckpoints: retained }, submitted.source);
                                                                }
                                                            }
                                                        },
                                                    } } : {}),
                                                }, hostActionApprovalLifetime: { actionId: 'session.message.send',
                                                    signal: composerPluginActionScopeSignal, surface: 'ui' } }) : actionExecutor;
                                            const result = sessionMessaging.kind === 'post_update'
                                                ? await createFrontDoorActionExecute(actionExecutor)('session.update.post', { summary: snapshot.text }, {
                                                    surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId,
                                                    expectedAccountId: outboundAccountLifetime.scope.accountId, signal: composerPluginActionScopeSignal,
                                                })
                                                : await createFrontDoorActionExecute(targetedExecutor)('session.message.send', {
                                                    sessionId: sessionMessaging.target, message: reviewedMessage,
                                                    ...(attempt ? { localId: attempt.localId } : {}),
                                                    requestedAction: { v: 1, kind: 'send_now' },
                                                    ...(submittedPermissionMode ? { permissionModeOverride: submittedPermissionMode } : {}),
                                                    ...(captured?.structuredInput ? { structuredInput: captured.structuredInput } : {}),
                                                    ...(sessionMessaging.kind === 'ask' ? {
                                                        reply: sessionMessaging.reply ?? 'return',
                                                        ...((sessionMessaging.reply ?? 'return') === 'return' ? { returnToSessionId: sessionId } : {}),
                                                        ...(sessionMessaging.timeoutSeconds ? { timeoutSeconds: sessionMessaging.timeoutSeconds } : {}),
                                                    } : { reply: 'none' }),
                                                }, { surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId,
                                                    expectedAccountId: outboundAccountLifetime.scope.accountId, signal: composerPluginActionScopeSignal });
                                            if (!outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) return { status: 'rejected' };
                                            const outcome = sessionMessaging.kind === 'post_update' ? null : readSessionComposerMessagingOutcome(result);
                                            const admitted = outcome === null
                                                ? result.ok && SessionUpdatePostOutputV1Schema.safeParse(result.result).success
                                                : outcome.kind === 'accepted';
                                            if (!admitted) {
                                                // The draft and its retry identity stay; say what actually happened.
                                                if (outcome?.kind === 'partial') {
                                                    Modal.alert(t('session.participants.talk.partialTitle'), t('session.participants.talk.partialBody', {
                                                        accepted: outcome.accepted, total: outcome.total }));
                                                } else if (outcome?.kind === 'approval_pending') {
                                                    Modal.alert(t('session.participants.talk.approvalTitle'), t('session.participants.talk.approvalBody'));
                                                } else {
                                                    Modal.alert(t('common.error'), !result.ok ? result.error : t('common.unavailable'));
                                                }
                                                return { status: 'rejected' };
                                            }
                                            handoff.accept();
                                            if (attempt) clearSessionMessagingDraftMutationAttempt({ scope: outboundAccountLifetime.scope,
                                                sessionId, localId: attempt.localId });
                                            trackMessageSent();
                                            requestMountedTranscriptFollow();
                                            return { status: 'accepted' };
                                            } finally { await captured?.releaseSnapshots(); }
                                        },
                                    },
                                    clearAcceptedSnapshot: (acceptedSnapshot) => {
                                        if (!outboundAccountLifetime.isCurrent()) return false;
                                        const cleared = clearSemanticDraftValuesAfterOutboundHandoff(semanticDraftSnapshot, {
                                            repositoryFieldIds: sessionMessaging.kind !== 'post_update' && submittedPermissionMode !== null
                                                ? ['extensions.happier.nextPromptPermissionModeV1'] : [],
                                        });
                                        if (cleared.clearedFieldIds.includes('structuredInput.composerAttachments')) {
                                            for (const released of readReleasedComposerStagedMediaHandles({
                                                composer: acceptedSnapshot.ref,
                                                previous: acceptedSnapshot.attachments,
                                                next: [],
                                            })) {
                                                releaseComposerStagedMedia(released.handle, released.claimant);
                                            }
                                        }
                                        if (cleared.textCleared) transient.clearTransientInputState();
                                        if (shouldSendReviewComments) clearSentReviewCommentDrafts();
                                        let clearedLegacyAttachments = false;
                                        if (hasAttachments) {
                                            const before = getAttachmentDraftsSnapshot();
                                            const remaining = attachmentDraftManager.removeSubmittedDrafts(submittedAttachmentDrafts);
                                            clearedLegacyAttachments = remaining.length !== before.length;
                                            if (remaining.length === 0) clearMainAttachmentDrafts();
                                            else writeMainAttachmentDrafts(remaining);
                                        }
                                        return clearedLegacyAttachments || cleared.textCleared || cleared.clearedFieldIds.length > 0;
                                    },
                                });
                            } finally { setIsComposerSending(false); }
                            return;
                        }

                        const outboundBase = shouldSendReviewComments
                            ? { kind: 'review_comments' as const }
                            : { kind: 'plain' as const };
                        // One destination fact for both the attachment and the plain send path.
                        // Recomputing it per branch is how the attachment branch silently kept
                        // addressing the parent Session's Agent.
                        const executionRunRecipient =
                            participantRecipient?.kind === 'execution_run'
                                ? participantRecipient
                                : null;

                        const voiceComposerRouting =
                            outboundBase.kind === 'plain' && !participantRecipient && !hasComposerAttachments
                                ? resolveVoiceSessionComposerRouting({
                                    conversationSessionId: sessionId,
                                    sessionMetadata: ownerMetadata,
                                })
                                : null;

                        const armedContinuationTargetLabel = armedContinuationTarget?.label
                            ?? (armedRouteContinuation ? readArmedRouteContinuationLabel(armedRouteContinuation) : null)
                            ?? '';
                        const resolveSendDestination = (
                            route: SessionComposerSendRoute,
                        ): SessionComposerSendDestination => resolveSessionComposerSendDestination({
                            route,
                            armedContinuation: inSessionAgentPicker.armedContinuation,
                            armedRoute: armedRouteContinuation ? { turnActive: isRuntimeFreshActiveTurn } : null,
                            armedContinuationLocalId: inSessionAgentPicker.armedContinuationLocalId,
                            machineId: typeof machineId === 'string' ? machineId : null,
                            pendingTransitionOutcome,
                        });
                        const outboundDestination = resolveSendDestination(
                            executionRunRecipient ? 'executionRun'
                                : voiceComposerRouting?.kind === 'adapter_text' ? 'voiceAdapter' : 'sessionAgent',
                        );
                        if (resetStart && (outboundDestination.kind !== 'sessionAgent'
                            || voiceComposerRouting?.kind === 'adapter_text')) {
                            Modal.alert(t('common.error'), t('usage.board.plans.resetStartFailed'));
                            return;
                        }

                        // G4 busy-send honesty: when the payload can't steer the active turn, ask the
                        // user (apply & steer / steer without applying / queue / interrupt) before any
                        // composer state is touched. Explicit intents and the 'off' setting skip this.
                        const nonSteerablePlan: NonSteerableSendPlan = resetStart || outboundDestination.kind === 'armedAgentContinuation'
                            || outboundDestination.kind === 'armedRouteContinuation'
                            ? { kind: 'proceed' as const }
                            : await resolveNonSteerableSendPlan({
                                session,
                                agentId,
                                text: trimmedText,
                                configuredMode,
                                busySteerSendPolicy,
                                permissionModeApplyTiming,
                                nonSteerableSendPrompt,
                                forceImmediate: forceImmediateSend,
                                explicitPendingIntent: explicitSubmitMode === 'server_pending',
                                explicitMode: explicitSubmitMode,
                                structuredInputMetaOverrides: structuredInputMetaOverrides ?? null,
                                agentTargetKey: providerAgentTargetKey,
                                currentRunnerProcessIdentity,
                            });
                        if (!outboundAccountLifetime.isCurrent()) return;
                        if (nonSteerablePlan.kind === 'cancelled') {
                            return;
                        }
                        const nonSteerableExplicitMode = nonSteerablePlan.explicitMode;
                        const applyConfigAndSteer = nonSteerablePlan.applyConfigAndSteer === true;
                        const steerWithoutConfig = nonSteerablePlan.steerWithoutConfig === true;
                        const steerWithoutConfigMetaOverrides = nonSteerablePlan.steerWithoutConfigMetaOverrides ?? null;
                        // A Session-owned Execution Run is an ordinary target of canonical Session
                        // input admission, so files reach it through the parent Session's own
                        // encrypted media path with the same upload, meta and settlement owners as
                        // main input. The refusal below existed because the removed direct
                        // `execution.run.send` route had no attachment or metadata channel of its
                        // own. Agent-team recipients stay parent-runtime participant metadata rather
                        // than independent runtime targets and keep their existing refusal.
                        const participantAcceptsContext = participantRecipient?.kind === 'execution_run';

                        if (
                            participantRecipient
                            && (shouldSendReviewComments || hasAttachments)
                            && !participantAcceptsContext
                        ) {
                            Modal.alert(t('common.error'), t('session.participants.unsupportedAttachmentsOrReviewComments'));
                            return;
                        }

                        // A run target does not consume the parent Session's Agent, so parent
                        // liveness is not a precondition for it. Only a main-Session attachment
                        // send still needs a resumable or active Session.
                        if (!resetStart && hasAttachments && !executionRunRecipient && !isSessionActive && !isResumable) {
                            Modal.alert(t('common.error'), t('session.inactiveNotResumableNoticeTitle'));
                            return;
                        }

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
                                metaOverrides: submittedPermissionMode
                                    ? { ...metaOverrides, permissionMode: submittedPermissionMode }
                                    : metaOverrides,
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
                        let semanticDraftSnapshotAfterHandoffClear: ComposerSemanticDraftCurrentnessSnapshot | null = null;
                        let semanticDraftFieldsClearedAtHandoff: readonly SessionDraftValueFieldId[] = [];
                        const transientInputStateHandoff = captureComposerTransientInputStateForOutboundHandoff({
                            captureTransientInputState: inputComposerPersistence.captureTransientInputState,
                            clearTransientInputState: inputComposerPersistence.clearTransientInputState,
                            restoreTransientInputState: inputComposerPersistence.restoreTransientInputState,
                        });
                        let didClearAtOutboundHandoff = false;
                        let didClearTextAtOutboundHandoff = false;
                        let outboundHandoffLocalId: string | null = null;
                        let didRecordOutboundAccepted = false;
                        const recordOutboundAccepted = () => {
                            if (didRecordOutboundAccepted) return;
                            didRecordOutboundAccepted = true;
                            trackMessageSent();
                            requestMountedTranscriptFollow();
                        };
                        const clearAfterOutboundHandoff = () => {
                            if (!outboundAccountLifetime.isCurrent()) return false;
                            // Composer admission ends at the durable outbound handoff. Runtime
                            // wake and provider delivery continue through their canonical session/Pending
                            // projections and must not keep the submit button in a local sending state.
                            setIsComposerSending(false);
                            const clearResult = clearSemanticDraftValuesAfterOutboundHandoff(semanticDraftSnapshot);
                            semanticDraftFieldsClearedAtHandoff = clearResult.clearedFieldIds;
                            didClearTextAtOutboundHandoff = clearResult.textCleared;
                            if (clearResult.textCleared) {
                                transientInputStateHandoff.clearTransientInputState();
                            }
                            const didClear = clearResult.textCleared
                                || clearResult.clearedFieldIds.length > 0;
                            if (didClear) {
                                semanticDraftSnapshotAfterHandoffClear = captureComposerSemanticDraftCurrentnessSnapshot();
                            }
                            didClearAtOutboundHandoff = didClearAtOutboundHandoff || didClear;
                            return didClear;
                        };
                        const admitResetStart = async (
                            outbound: Readonly<{ text: string; displayText?: string; metaOverrides?: Record<string, unknown> }>,
                            onAccepted: () => void,
                        ): Promise<ComposerSubmissionAdmissionOutcome> => {
                            if (!resetStart || !outboundAccountLifetime.isCurrent() || composerPluginActionScopeSignal.aborted) {
                                return { status: 'rejected' };
                            }
                            const cancellation = new AbortController();
                            const retirement = outboundAccountLifetime.onRetire(() => cancellation.abort());
                            const abort = () => cancellation.abort();
                            composerPluginActionScopeSignal.addEventListener('abort', abort, { once: true });
                            try {
                                const prepared = await sync.preparePendingResetStartInput(sessionId, outbound.text,
                                    outbound.displayText, outbound.metaOverrides, {
                                        serverId: sessionRouteServerId, accountLifetime: outboundAccountLifetime,
                                        allowedModels: embedded?.allowedModels ?? null,
                                        allowedPermissionModes: embedded?.permissionModePicker ?? null,
                                    });
                                if (!outboundAccountLifetime.isCurrent() || cancellation.signal.aborted) return { status: 'rejected' };
                                const result = await createFrontDoorActionExecute(actionExecutor)('session.pending.resetStart.set', {
                                    sessionId, localId: prepared.localId, reset: resetStart,
                                    initialInput: prepared.initialInput, serverId: sessionRouteServerId,
                                }, {
                                    surface: 'ui', defaultSessionId: sessionId, serverId: sessionRouteServerId,
                                    expectedAccountId: outboundAccountLifetime.scope.accountId, signal: cancellation.signal,
                                });
                                if (!outboundAccountLifetime.isCurrent() || cancellation.signal.aborted) return { status: 'rejected' };
                                if (result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
                                    Modal.alert(t('usage.board.plans.resetStartTitle'), t('usage.board.plans.waitingApproval'));
                                    return { status: 'rejected' };
                                }
                                const applied = result.ok ? PendingResetStartSetResultV1Schema.safeParse(result.result) : null;
                                if (!applied?.success || applied.data.requestedAction.kind !== 'reset_start'
                                    || !sameStrictJsonValue(applied.data.requestedAction.reset, resetStart)) {
                                    Modal.alert(t('common.error'), result.ok ? t('usage.board.plans.resetStartFailed') : usageResetStartFailureMessage(result));
                                    return { status: 'rejected' };
                                }
                                outboundHandoffLocalId = prepared.localId;
                                onAccepted();
                                recordOutboundAccepted();
                                return { status: 'accepted' };
                            } catch (error) {
                                if (outboundAccountLifetime.isCurrent() && !cancellation.signal.aborted) {
                                    Modal.alert(t('common.error'), error instanceof Error ? error.message : t('usage.board.plans.resetStartFailed'));
                                }
                                return { status: 'rejected' };
                            } finally {
                                retirement.dispose();
                                composerPluginActionScopeSignal.removeEventListener('abort', abort);
                            }
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
                                snapshot: sourceComposerSubmissionSnapshot,
                                attachmentDraftIds: submittedAttachmentDrafts.map(draft => draft.id),
                                signal: composerPluginActionScopeSignal,
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
                                        || acceptedSnapshot.revision !== sourceComposerSubmissionSnapshot.revision
                                        || acceptedSnapshot.text !== sourceComposerSubmissionSnapshot.text
                                        || !sameStrictJsonValue(acceptedSnapshot.references, sourceComposerSubmissionSnapshot.references)
                                        || !sameComposerAttachmentViews(acceptedSnapshot.attachments, sourceComposerSubmissionSnapshot.attachments)
                                    ) {
                                        return false;
                                    }
                                    return clearAfterOutboundHandoff();
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
                            attachmentDraftManager.replaceDrafts(drafts);
                            writeMainAttachmentDrafts(drafts);
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
                                restoreDraftText: didClearTextAtOutboundHandoff,
                                restoreTransientInputState: transientInputStateHandoff.restoreTransientInputState,
                                restoreSemanticDraftValuesMatchingClearedSnapshot: () => {
                                    if (!semanticDraftSnapshotAfterHandoffClear) return false;
                                    return restoreSemanticDraftValuesFromSnapshot({
                                        snapshot: semanticDraftSnapshot,
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
                        const acceptCanonicalOutboundHandoff = (
                            localId: string | null | undefined,
                            onAdmitted: () => void,
                        ) => {
                            if (!outboundAccountLifetime.isCurrent()
                                || !hasCanonicalOutboundHandoffForLocalId(sessionId, localId ?? null)) {
                                return false;
                            }
                            outboundHandoffLocalId = localId ?? null;
                            onAdmitted();
                            recordOutboundAccepted();
                            return true;
                        };
                        const clearReviewDraftsAfterSubmit = (result: Awaited<ReturnType<typeof submitAppSessionComposerMessage>>) => {
                            // Custody belongs to the Account's accepted submission, even when the phone Ask host
                            // has hidden/frozen its composer before the receipt arrives. Unaccepted drafts stay put.
                            if (shouldSendReviewComments && (result.persistence !== 'none'
                                || hasCanonicalOutboundHandoffForLocalId(sessionId, result.localId ?? null))) {
                                clearSentReviewCommentDrafts();
                            }
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
                                    scopeKey: sessionAccountScopeKey,
                                    message: refused.reason === 'conflictingDestination'
                                        ? t('session.agentContinuation.transition.conflictingDestination', {
                                            agent: armedContinuationTargetLabel,
                                        })
                                        : refused.reason === 'sourceNotIdle'
                                            // Applying an armed route restarts the running Agent.
                                            ? t('session.agentContinuation.transition.rejected.sourceNotIdle', {
                                                agent: currentAgentLabel,
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
                            if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
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
                                    meta: {
                                        ...outboundForTransition.metaOverrides,
                                        permissionMode: parsePermissionIntentAlias(submittedPermissionMode ?? permissionMode) ?? 'default',
                                    },
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
                            // A retry uses the retained input, not newly authored
                            // composer values. Preparation must precede first custody.
                            const submissionForDispatch = existingSubmission?.localId === destination.localId
                                ? {
                                    ...transitionSubmission,
                                    input: {
                                        text: existingSubmission.input.text,
                                        meta: existingSubmission.input.meta,
                                    },
                                }
                                : transitionSubmission;
                            const prepared = await prepareArmedAgentContinuation(submissionForDispatch, readSessionOwnerMetadataView(storage.getState().sessions[sessionId]), { signal: sessionViewCaller.signal });
                            if (!outboundAccountLifetime.isCurrent() || sessionViewCaller.signal.aborted) return { status: 'rejected' };
                            if (prepared.status === 'refused') {
                                setArmedContinuationOutcome({
                                    kind: 'refusal',
                                    scopeKey: sessionAccountScopeKey,
                                    message: prepared.notice.message,
                                });
                                return { status: 'rejected' };
                            }
                            // A matching localId is not content protection: the
                            // server may reconcile it onto a later payload. A
                            // retry therefore dispatches the first exact nested
                            // input rather than an edited composer projection.
                            if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
                            const { disposition, result } = await continueSessionWithArmedAgent(prepared, {
                                signal: sessionViewCaller.signal,
                                isCurrent: () => outboundAccountLifetime.isCurrent(),
                                onBeforeTransitionDispatch: () => inSessionAgentPicker.recordArmedContinuationSubmission({
                                    localId: destination.localId,
                                    input: transitionInput,
                                    currentness: {
                                        text: submittedComposerText,
                                        mentions: semanticDraftSnapshot.values['structuredInput.mentions'] ?? [],
                                        composerAttachments: semanticDraftSnapshot.values['structuredInput.composerAttachments'] ?? [],
                                        attachmentDraftIds: hasAttachments
                                            ? submittedAttachmentDrafts.map((draft) => draft.id)
                                            : [],
                                        nextPromptPermissionModeMutationId: semanticDraftSnapshot.repositoryCurrentness
                                            .mutationIds['extensions.happier.nextPromptPermissionModeV1'],
                                    },
                                }),
                            });
                            if (!outboundAccountLifetime.isCurrent() || sessionViewCaller.signal.aborted) return { status: 'rejected' };
                            if (result === null) {
                                if (disposition.notice) setArmedContinuationOutcome({
                                    kind: 'refusal', scopeKey: sessionAccountScopeKey, message: disposition.notice.message,
                                });
                                return { status: 'rejected' };
                            }
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
                                scopeKey: sessionAccountScopeKey,
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
                                if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
                                setIsComposerSending(true);
                                const admissionStructuredInputMetaOverrides = shouldUseComposerSubmissionCoordinator
                                    ? buildDetachedComposerSubmissionMetaOverrides(submittedSnapshot)
                                    : structuredInputMetaOverrides;
                                const submittedAttachmentDraftIds = new Set(submittedAttachmentDrafts.map((draft) => draft.id));
                                const readSubmittedAttachmentDraftsFromCurrent = () => {
                                    const currentDraftsById = new Map(getAttachmentDraftsSnapshot().map((draft) => [draft.id, draft]));
                                    return submittedAttachmentDrafts.map((draft) => currentDraftsById.get(draft.id) ?? draft);
                                };
                                const canRestoreFailedAttachmentHandoffSnapshot = () => {
                                    const currentDrafts = getAttachmentDraftsSnapshot();
                                    return currentDrafts.length === 0
                                        || currentDrafts.every((draft) => submittedAttachmentDraftIds.has(draft.id));
                                };
                                let attachmentDraftsForRestore = readSubmittedAttachmentDraftsFromCurrent();
                                try {
                                    const readyForSend = resetStart ? true : await externalSessionTakeover.ensureReadyForSend();
                                    if (!readyForSend || !outboundAccountLifetime.isCurrent()) {
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
                                    const attachmentSendDestination = resolveSendDestination(
                                        executionRunRecipient ? 'executionRun' : 'sessionAgent',
                                    );
                                    if (attachmentSendDestination.kind === 'refused') {
                                        return presentRefusedArmedSend(attachmentSendDestination);
                                    }
                                    // D15: apply the armed selection (restart only if required), then dispatch.
                                    if (attachmentSendDestination.kind === 'armedRouteContinuation'
                                        && (!(await restartSessionRunnerOnRequestedRoute()) || !outboundAccountLifetime.isCurrent())) {
                                        return { status: 'rejected' };
                                    }
                                    if (!resetStart && attachmentSendDestination.kind === 'sessionAgent'
                                        && !isSessionActive && isResumable) {
                                        const resumed = await handleResumeSession();
                                        if (!resumed || !outboundAccountLifetime.isCurrent()) {
                                            throw new Error(t('session.resumeFailed'));
                                        }
                                    }

                                    const { uploaded } = await uploadAttachmentDraftsToSession({
                                        sessionId,
                                        signal: composerPluginActionScopeSignal,
                                        drafts: submittedAttachmentDrafts,
                                        config: attachmentsUploadConfig,
                                        applyDraftPatch: (id, patch) => {
                                            const submitted = submittedAttachmentDrafts.find((draft) => draft.id === id);
                                            if (submitted) applyAttachmentDraftPatch(id, patch, submitted.source);
                                        },
                                    });
                                    if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
                                    const attachmentsMetaOverrides = buildAttachmentMessageMeta(uploaded);

                                    const outbound = shouldSendReviewComments
                                        ? buildReviewCommentsOutboundMessage({
                                            sessionId,
                                            drafts: await resolveReviewCommentDraftAnchorsForPrompt({
                                                drafts: includedReviewCommentDrafts,
                                                reviewScope,
                                                signal: sessionViewCaller.signal,
                                            }),
                                            additionalMessage,
                                            metaOverrides: attachmentsMetaOverrides,
                                        })
                                        : {
                                            text: trimmedText,
                                            displayText: undefined,
                                            metaOverrides: attachmentsMetaOverrides,
                                        };
                                    // The run destination travels as the canonical `recipient` on
                                    // Session input admission, not as authored `happier` metadata:
                                    // this envelope already carries `attachments.v1`, and the
                                    // recipient's own envelope occupies the same single slot. The
                                    // durable target is the one routing fact, exactly as the
                                    // settlement owner derives sidechain provenance from it.
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
                                        const nextDrafts = attachmentDraftManager.removeSubmittedDrafts(submittedAttachmentDrafts);
                                        writeMainAttachmentDrafts(nextDrafts);
                                    };
                                    const clearAttachmentsAfterProjectionHandoff = () => {
                                        if (!outboundAccountLifetime.isCurrent()) return;
                                        if (didClearForAttachmentHandoff) return;
                                        removeSubmittedAttachmentDraftsFromCurrent();
                                        didClearForAttachmentHandoff = handoff.accept();
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
                                    if (resetStart) {
                                        return await admitResetStart({ ...outbound, metaOverrides: outboundMetaOverridesWithBrowserContext }, () => {
                                            clearAttachmentsAfterProjectionHandoff();
                                            if (shouldSendReviewComments) clearSentReviewCommentDrafts();
                                        });
                                    }
                                    const callerSurface = shouldSendReviewComments
                                        ? 'session_attachment_review_comment_composer' as const
                                        : 'session_attachment_composer' as const;
                                    const result = await submitAppSessionComposerMessage(sessionSubmitPort, {
                                        sessionId,
                                        session: sessionForSubmit,
                                        // Omitting the recipient keeps the main Session's exact fast
                                        // path; an attached run is the same canonical admission with
                                        // one extra destination fact.
                                        ...(executionRunRecipient
                                            ? {
                                                recipient: executionRunRecipient,
                                                requestedAction: recipientState.executionRunRequestedAction,
                                            }
                                            : {}),
                                        // A model-restricted arm sends on the first allowed model when the Session is on
                                        // Automatic or a refused model (plan 04 §4.6); the outgoing record owns that choice.
                                        allowedModels: embedded?.allowedModels ?? null,
                                        allowedPermissionModes: embedded?.permissionModePicker ?? null,
                                        text: outbound.text,
                                        displayText: outbound.displayText,
                                        metaOverrides: steerWithoutConfigMetaOverrides
                                            ? { ...outboundMetaOverridesWithBrowserContext, ...steerWithoutConfigMetaOverrides }
                                            : outboundMetaOverridesWithBrowserContext,
                                        configuredMode,
                                        busySteerSendPolicy,
                                        sessionInactiveResumePolicy,
                                        agentTargetKey: providerAgentTargetKey,
                                        currentRunnerProcessIdentity,
                                        nonSteerableSendPrompt,
                                        permissionModeApplyTiming,
                                        ...(applyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                                        ...(steerWithoutConfig ? { steerWithoutConfig: true } : {}),
                                        explicitMode: nonSteerableExplicitMode ?? explicitSubmitMode,
                                        forceImmediate: forceImmediateSend,
                                        profileId: liveComposerState.profileId ?? null,
                                        resumeCapabilityOptions: {
                                            ...resumeCapabilityOptions,
                                            accountSettings: storage.getState().settings,
                                        },
                                        resumeTargetOverride: reachableMachineTarget
                                            ? {
                                                machineId: reachableMachineTarget.machineId,
                                                directory: reachableMachineTarget.basePath,
                                            }
                                            : null,
                                        permissionOverride: getPermissionModeOverrideForSpawn(sessionForSubmit),
                                        serverId: sessionRouteServerId,
                                        accountLifetime: outboundAccountLifetime,
                                        requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(sessionForSubmit, cliAuthState),
                                        callerSurface,
                                        onOutboundHandoff: (handoff) => {
                                            outboundHandoffLocalId = handoff.localId ?? outboundHandoffLocalId;
                                            clearAttachmentsAfterProjectionHandoff();
                                            if (handoff.persistence === 'pending') {
                                                recordOutboundAccepted();
                                            }
                                        },
                                    });
                                    if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
                                    clearReviewDraftsAfterSubmit(result);
                                    if (!composerPresentationMountedRef.current) return { status: 'rejected' };
                                    if (result.type === 'wake_failed' && resolveResumeFailurePresentation(result, t('session.resumeFailed')).kind === 'directory_missing') {
                                        setDirectoryRecovery({ scopeKey: sessionAccountScopeKey, busy: false });
                                    }
                                    if (result.type === 'send_failed' || result.type === 'rejected') {
                                        // An unavailable ACK does not revoke custody already
                                        // published by canonical Pending or the transcript.
                                        if (acceptCanonicalOutboundHandoff(result.localId, clearAttachmentsAfterProjectionHandoff)) {
                                            Modal.alert(t('common.error'), result.errorMessage ?? t('common.unavailable'));
                                            return { status: 'accepted' };
                                        }
                                        if (result.persistence === 'none' && canRestoreFailedAttachmentHandoffSnapshot()) {
                                            restoreAfterFailedOutboundHandoff(attachmentDraftsForRestore);
                                        }
                                        Modal.alert(t('common.error'), result.errorMessage ?? t('errors.failedToSendMessage'));
                                        return {
                                            status: 'rejected',
                                            reason: {
                                                type: result.type,
                                                ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
                                                ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
                                                callerSurface,
                                                destination: attachmentSendDestination.kind,
                                            },
                                        };
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
                                    presentSessionActionOutcome(e, outboundAccountLifetime);
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
                            if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
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
                                            signal: sessionViewCaller.signal,
                                        }),
                                        additionalMessage,
                                    }) }
                                    : (trimmedText.length > 0 || hasComposerAttachments
                                        ? { text: trimmedText, displayText: undefined, metaOverrides: undefined }
                                        : null);

                                if (!outbound) return { status: 'rejected' };

                                const readyForSend = resetStart ? true : await externalSessionTakeover.ensureReadyForSend();
                                if (!readyForSend || !outboundAccountLifetime.isCurrent()) {
                                    return { status: 'rejected' };
                                }

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
                                    if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
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

                                // A Session-owned Execution Run is an ordinary target of canonical
                                // Session input admission. It carries the same text, attachments,
                                // browser/source context, delivery selection and permissions as the
                                // main Session; only the destination differs. `executionRunRecipient`
                                // is resolved once for this send so the attachment and plain paths
                                // cannot disagree about the destination.
                                if (participantRecipient) {
                                    const routed = resolveParticipantRoutedSend({
                                        text: outbound.text,
                                        displayText: outbound.displayText,
                                        metaOverrides: outbound.metaOverrides,
                                        recipient: participantRecipient,
                                        ...(executionRunRecipient
                                            ? {
                                                requestedAction: recipientState.executionRunRequestedAction,
                                            }
                                            : {}),
                                    });
                                    outbound.text = routed.text;
                                    outbound.displayText = routed.displayText;
                                    outbound.metaOverrides = routed.metaOverrides;
                                }
                                outbound.metaOverrides = mergeMessageMetaOverrides(
                                    outbound.metaOverrides,
                                    admissionStructuredInputMetaOverrides,
                                );

                                const outboundMetaOverridesWithBrowserContext = mergeBrowserContextMetaForSend(outbound.metaOverrides);
                                if (outboundMetaOverridesWithBrowserContext === null) {
                                    return { status: 'rejected' };
                                }
                                outbound.metaOverrides = outboundMetaOverridesWithBrowserContext;

                                if (executionRunRecipient) {
                                    // Same reasoning as the voice route above: an
                                    // execution run is not this Session's Agent, so an
                                    // armed switch cannot ride along unremarked.
                                    const executionRunDestination = resolveSendDestination('executionRun');
                                    if (executionRunDestination.kind === 'refused') {
                                        return presentRefusedArmedSend(executionRunDestination);
                                    }
                                }

                                const sendDestination = executionRunRecipient
                                    ? null
                                    : resolveSendDestination('sessionAgent');
                                if (sendDestination?.kind === 'refused') {
                                    return presentRefusedArmedSend(sendDestination);
                                }
                                // D15: apply the armed selection, then send through the ordinary path below.
                                if (sendDestination?.kind === 'armedRouteContinuation'
                                    && (!(await restartSessionRunnerOnRequestedRoute()) || !outboundAccountLifetime.isCurrent())) {
                                    return { status: 'rejected' };
                                }
                                if (sendDestination?.kind === 'armedAgentContinuation') {
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
                                if (resetStart) {
                                    return await admitResetStart(outbound, () => {
                                        admissionHandoff.accept();
                                        if (shouldSendReviewComments) clearSentReviewCommentDrafts();
                                    });
                                }
                                const callerSurface = shouldSendReviewComments
                                    ? 'session_review_comment_composer' as const
                                    : 'session_composer' as const;
                                const result = await submitAppSessionComposerMessage(sessionSubmitPort, {
                                    sessionId,
                                    session: sessionForSubmit,
                                    // Omitting the recipient keeps the main Session's exact fast
                                    // path: no target object, target query, or capability check.
                                    ...(executionRunRecipient
                                        ? {
                                            recipient: executionRunRecipient,
                                            requestedAction: recipientState.executionRunRequestedAction,
                                        }
                                        : {}),
                                    // A model-restricted arm sends on the first allowed model when the Session is on
                                    // Automatic or a refused model (plan 04 §4.6); the outgoing record owns that choice.
                                    allowedModels: embedded?.allowedModels ?? null,
                                    allowedPermissionModes: embedded?.permissionModePicker ?? null,
                                    text: outbound.text,
                                    displayText: outbound.displayText,
                                    metaOverrides: steerWithoutConfigMetaOverrides
                                        ? { ...outbound.metaOverrides, ...steerWithoutConfigMetaOverrides }
                                        : outbound.metaOverrides,
                                    configuredMode,
                                    busySteerSendPolicy,
                                    sessionInactiveResumePolicy,
                                    agentTargetKey: providerAgentTargetKey,
                                    currentRunnerProcessIdentity,
                                    nonSteerableSendPrompt,
                                    permissionModeApplyTiming,
                                    ...(applyConfigAndSteer ? { applyConfigAndSteer: true } : {}),
                                    ...(steerWithoutConfig ? { steerWithoutConfig: true } : {}),
                                    explicitMode: nonSteerableExplicitMode ?? explicitSubmitMode,
                                    forceImmediate: forceImmediateSend,
                                    profileId: liveComposerState.profileId ?? null,
                                    resumeCapabilityOptions: {
                                        ...resumeCapabilityOptions,
                                        accountSettings: storage.getState().settings,
                                    },
                                    resumeTargetOverride: reachableMachineTarget
                                        ? {
                                            machineId: reachableMachineTarget.machineId,
                                            directory: reachableMachineTarget.basePath,
                                        }
                                        : null,
                                    permissionOverride: getPermissionModeOverrideForSpawn(sessionForSubmit),
                                    serverId: sessionRouteServerId,
                                    accountLifetime: outboundAccountLifetime,
                                    requestRemoteControlAfterPendingEnqueue: shouldRequestRemoteControlAfterPendingEnqueue(sessionForSubmit, cliAuthState),
                                    callerSurface,
                                    onOutboundHandoff: (handoff) => {
                                        outboundHandoffLocalId = handoff.localId ?? outboundHandoffLocalId;
                                        admissionHandoff.accept();
                                        if (handoff.persistence === 'pending') {
                                            recordOutboundAccepted();
                                        }
                                    },
                                });

                                if (!outboundAccountLifetime.isCurrent()) return { status: 'rejected' };
                                clearReviewDraftsAfterSubmit(result);
                                if (!composerPresentationMountedRef.current) return { status: 'rejected' };

                                if (result.type === 'wake_failed' && resolveResumeFailurePresentation(result, t('session.resumeFailed')).kind === 'directory_missing') {
                                    setDirectoryRecovery({ scopeKey: sessionAccountScopeKey, busy: false });
                                }
                                if (result.type === 'send_failed' || result.type === 'rejected') {
                                    if (acceptCanonicalOutboundHandoff(result.localId, () => admissionHandoff.accept())) {
                                        Modal.alert(t('common.error'), result.errorMessage ?? t('common.unavailable'));
                                        return { status: 'accepted' };
                                    }
                                    if (result.persistence === 'none') {
                                        restoreAfterFailedOutboundHandoff();
                                    }
                                    Modal.alert(t('common.error'), result.errorMessage ?? t('errors.failedToSendMessage'));
                                    return {
                                        status: 'rejected',
                                        reason: {
                                            type: result.type,
                                            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
                                            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
                                            callerSurface,
                                            destination: sendDestination?.kind ?? 'executionRun',
                                        },
                                    };
                                }

                                recordOutboundAccepted();

                                return { status: 'accepted' };
                            } finally {
                                setIsComposerSending(false);
                            }
                        };
                        const sessionAdmissionResult = await startSessionComposerAdmission(admit);
                        presentBlockedSessionComposerSubmission(sessionAdmissionResult);
                    };

                    // Resolve commands/templates from the cleaned authoring text, before
                    // expansion moves its ranges. Custody still compares the original draft.
                    const messageForResolution = prepareComposerSubmissionSnapshot(
                        readSessionComposerSubmissionSnapshot(composerMessage),
                        getAttachmentDraftsSnapshot().map(draft => draft.id),
                    ).text;
                    if (sendOptions?.resetStart) {
                        await sendComposerText(messageForResolution, composerMessage, sendOptions);
                        return;
                    }
                    if (recipientState.scmDiffSummaryDiscussion) {
                        await sendComposerText(messageForResolution, composerMessage, sendOptions);
                        return;
                    }
                    const invocationScope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), sessionRouteServerId);
                    if (invocationScope) await refreshPromptLibraryCatalog(invocationScope);
                    if (invocationScope && !areServerAccountScopesEqual(invocationScope, getActiveServerAccountScope())) return;
                    const invocationCatalog = getPromptLibraryCatalogValue(invocationScope, 'invocations');
                    const promptInvocationsV1 = invocationCatalog.status === 'ready' && !invocationCatalog.stale ? invocationCatalog.value : null;
                    const resolved = resolveSessionComposerSend({
                        input: messageForResolution,
                        sessionId,
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
                                    serverId: resolved.targetServerId ?? invocationScope?.serverId,
                                });

                                if (resolvePromptInvocationComposerSendAction(resolved.behavior) === 'insert') {
                                    setComposerDraftValue(expanded);
                                    return;
                                }

                                await sendComposerText(expanded, composerTextBeforeSend, sendOptions);
                        } catch (e) {
                            presentSessionActionOutcome(e, outboundAccountLifetime);
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
                            accountLifetime: sessionAccountLifetime,
                            accountScope: sessionAccountScope,
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
                            openGoalControls: () => setActiveStatusBadgeKey(SESSION_WORK_STATE_STATUS_BADGE_KEY),
                            setSessionGoal: canEditSessionGoals
                                ? (_targetSessionId, request) => setSessionGoalForView(request)
                                : undefined,
                            clearSessionGoal: canEditSessionGoals
                                ? () => clearSessionGoalForView()
                                : undefined,
                            modalAlert: (_title, msg) => Modal.alert(t('common.error'), msg),
                        });
                        return;
                    }

                    if (resolved.kind !== 'send') return;
                    await sendComposerText(resolved.text, composerMessage, sendOptions);
                    }).catch((error: unknown) => presentSessionActionOutcome(error, outboundAccountLifetime)), { tag: 'SessionView.composer.dispatch' });
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
                structuredInputMentions={pendingComposerDocument?.mentions}
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
    const focusComposer = React.useCallback(() => {
        activeComposerPresentationTarget.focusComposer?.();
    }, [activeComposerPresentationTarget]);
    const composer: SessionComposerModel = {
        content: input,
        ref: activeComposerRef,
        address: sessionComposerAddress,
        sending: isComposerSending,
        focus: focusComposer,
    };
    return { composer, view: {
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
    } };
}
