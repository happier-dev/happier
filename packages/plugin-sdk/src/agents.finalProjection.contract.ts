import type {
  AgentContribution,
  AgentModelConfig,
  AgentModelDescriptor,
  AgentModelOption,
  AgentProfile,
  AgentSessionRuntimeCapabilities,
  AgentSurfaceOperationCatalogV1,
  EnvironmentVariable,
  PluginAgentCapabilitiesV1Schema,
  PluginAgentDefinition,
  buildAgentTargetKeyV2,
} from './agents.js';
import type {
  AgentAccountUsageAdoptProvisionalRecordInput,
  AgentAccountUsageAdoptProvisionalRecordResult,
  AgentAccountUsageAdoptionProof,
  AgentAccountUsageDiagnostic,
  AgentAccountUsageMeter,
  AgentAccountUsageQuotaConfidence,
  AgentAccountUsageQuotaSource,
  AgentAccountUsageRecordKey,
  AgentAccountUsageRecordSnapshotInput,
  AgentAccountUsageRecordSnapshotResult,
  AgentAccountUsageRecoveryCredit,
  AgentAccountUsageRecoveryCredits,
  AgentAccountUsageService,
  AgentAccountUsageSnapshot,
  AgentAccountUsageSourceContext,
  AgentAccountUsageSourceContextInput,
  AgentAuthorRestoreCheckpointResult,
  AgentAcpAuthenticationContext,
  AgentAcpAuthenticationDefinition,
  AgentAcpAuthenticationSelection,
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpExtensionContext,
  AgentAcpHistorySession,
  AgentAcpInFlightSteerDefinition,
  AgentAcpMcpInputPolicy,
  AgentAcpModel,
  AgentAcpModelControls,
  AgentAcpModelOption,
  AgentAcpNotificationExtension,
  AgentAcpPromptUsageDefinition,
  AgentAcpRequestExtension,
  AgentAcpRuntimeComposer,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeExtensions,
  AgentAcpRuntimeOptions,
  AgentAcpStderrMatchRule,
  AgentAcpStderrRules,
  AgentAcpStderrStatusErrorRule,
  AgentAcpTimeouts,
  AgentAcpToolNameInference,
  AgentAcpToolNamePattern,
  AgentAcpToolNameResolver,
  AgentAcpToolUpdateContentSanitizer,
  AgentAcpToolUpdatePolicy,
  AgentAcpTransport,
  AgentConfigurationScalar,
  AgentDaemonResolvedToolV1,
  AgentDaemonRunToolResultV1,
  AgentDaemonSpawnConnectedServiceBindingV1,
  AgentDaemonSpawnConnectedServicesV1,
  AgentDaemonSpawnDiagnosticV1,
  AgentDaemonSpawnHooks,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentDaemonSpawnToolResolutionContextV1,
  AgentDaemonSpawnValidationResult,
  AgentCliAuthCommandResultV1,
  AgentCliAuthContributionV1,
  AgentCliAuthStatusV1,
  AgentCliSessionCommandBuildInputV1,
  AgentCliSessionCommandBuildOptionsResultV1,
  AgentCliSessionCommandDeclarationV1,
  AgentCliSessionCommandOptionsV1,
  AgentCliSessionCommandParsedArgsV1,
  AgentConnectedAccountContinuityV1,
  AgentConnectedAccountCredentialRevisionV1,
  AgentConnectedAccountEnvironmentUseV1,
  AgentConnectedAccountFileEnvironmentUseV1,
  AgentConnectedAccountLaunchContributionV1,
  AgentConnectedAccountNativeAuthCodecInspectInputV1,
  AgentConnectedAccountNativeAuthCodecMaterializeInputV1,
  AgentConnectedAccountNativeAuthCodecV1,
  AgentConnectedAccountNativeHomeV1,
  AgentConnectedAccountProviderOutcomeInputV1,
  AgentConnectedAccountProviderOutcomeSelectionV1,
  AgentConnectedAccountProviderOutcomeTargetV1,
  AgentConnectedAccountProviderOutcomeVerificationResultV1,
  AgentConnectedAccountRequestAuthUseV1,
  AgentConnectedAccountResumeFileCandidateV1,
  AgentConnectedAccountResumeFileLookupV1,
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
  AgentConnectedAccountRuntimeAuthAdapterResultV1,
  AgentConnectedAccountRuntimeAuthAdapterV1,
  AgentConnectedAccountRuntimeAuthFailureKind,
  AgentConnectedAccountRuntimeAuthHotApplyInputV1,
  AgentConnectedAccountRuntimeAuthSelectionV1,
  AgentConnectedAccountRuntimeAuthTargetV1,
  AgentConnectedAccountRuntimeAuthUsageInputV1,
  AgentConnectedAccountRuntimeAuthVerificationInputV1,
  AgentConnectedAccountRuntimeFailureClassificationV1,
  AgentConnectedAccountRuntimeFailureInputV1,
  AgentConnectedAccountStateSharingDescriptorEntryV1,
  AgentConnectedAccountStateSharingDescriptorTransformV1,
  AgentConnectedAccountStateSharingDescriptorV1,
  AgentConnectedAccountStateSharingDynamicEntryPatternV1,
  AgentConnectedAccountSwitchContinuityV1,
  AgentConnectedAccountSwitchTransitionV1,
  AgentConnectedAccountTransitionVerificationResultV1,
  AgentDeferredStartupEligibilityInputV1,
  AgentExecutionRunEvent,
  AgentFiniteExecutionRunHostOptions,
  AgentFiniteExecutionRunProgressEvent,
  AgentFiniteExecutionRunResult,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeFactory,
  AgentExecutionRunSendResult,
  AgentExecutionRunStopResult,
  AgentExperimentalVendorResumeSupportContributionV1,
  AgentExperimentalVendorResumeSupportInputV1,
  AgentFeatureDecisionService,
  AgentLaunchEnvironment,
  AgentPermissionIntent,
  AgentPreflightJsonRpcRequestClientV1,
  AgentPreflightSessionControlsCommandResultV1,
  AgentPreflightSessionControlsCommandV1,
  AgentPreflightSessionControlsContributionV1,
  AgentPreflightSessionControlsModelsV1,
  AgentPreflightSessionControlsProbeContextV1,
  AgentPreflightSessionControlsProbeInputV1,
  AgentProviderBindingAdapter,
  AgentProviderBindingCredential,
  AgentProviderBindingEnvironmentEntry,
  AgentProviderBindingMaterialization,
  AgentProviderBindingMaterializationV1Schema,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingModel,
  AgentProviderBindingPrepareInput,
  AgentProviderBindingPrepared,
  AgentProviderBindingResolvedFacts,
  AgentProviderCliAttachDeclarationV1,
  AgentProviderCliAttachTargetResolutionV1,
  AgentProviderCliAttachTargetV1,
  AgentProviderCredentialTransport,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentRuntimeFactoryContext,
  AgentRuntimeForkSurface,
  AgentRuntimeHandoffSurface,
  AgentRuntimeJsonValueSchema,
  AgentRuntimeProtocolComposers,
  AgentRuntimeRegistrationOptions,
  AgentRuntimeSurfaces,
  AgentSessionActiveInputBinding,
  AgentSessionActiveInputService,
  AgentSessionActiveInputStatus,
  AgentSessionAuthRefreshClassification,
  AgentSessionAuthRefreshError,
  AgentSessionAuthRefreshPayload,
  AgentSessionAuthRefreshRecovery,
  AgentSessionAuthRefreshRequest,
  AgentSessionAuthRefreshResult,
  AgentSessionAuthRefreshSelection,
  AgentSessionCancelResult,
  AgentSessionCatalogControl,
  AgentSessionCatalogRequest,
  AgentSessionCatalogResult,
  AgentSessionCompactRequest,
  AgentSessionCompactResult,
  AgentSessionConfigurationResult,
  AgentSessionConfigurationSnapshot,
  AgentSessionConfigurationUpdate,
  AgentSessionConnectedAccountSelection,
  AgentSessionContinuationControl,
  AgentSessionContinuationProbeResult,
  AgentSessionControlContext,
  AgentSessionControlFailure,
  AgentSessionConversationRollbackControl,
  AgentSessionConversationRollbackReconciliationResult,
  AgentSessionConversationRollbackRequest,
  AgentSessionConversationRollbackResult,
  AgentSessionDisposeReason,
  AgentSessionGoalCommittedResult,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionGoalMutation,
  AgentSessionGoalMutationResult,
  AgentSessionGoalRefreshResult,
  AgentSessionHappierToolsService,
  AgentSessionHookForwarderAssets,
  AgentSessionHookPluginDirCreateRequest,
  AgentSessionHookPluginFile,
  AgentSessionHookProviderPayload,
  AgentSessionHookServerHandle,
  AgentSessionHookServerStartRequest,
  AgentSessionHooksService,
  AgentSessionHostServices,
  AgentSessionInFlightConfigurationOutcome,
  AgentSessionInput,
  AgentSessionMcpLaunchConfig,
  AgentSessionMcpServer,
  AgentSessionMcpService,
  AgentSessionMcpTransport,
  AgentSessionModel,
  AgentSessionModelOption,
  AgentSessionModelOptionChoice,
  AgentSessionModelsService,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
  AgentSessionNativeHomeService,
  AgentSessionNativeToolBridgeConfig,
  AgentSessionNativeToolDescriptor,
  AgentSessionOpenRequest,
  ConnectedServicesProviderStateSharingPolicyV1,
  AgentSessionPreAdmissionBuffer,
  AgentSessionPreAdmissionBufferResult,
  AgentSessionProviderBinding,
  AgentSessionProviderBindingUpstream,
  AgentSessionProviderBindingV1Schema,
  AgentSessionProviderCheckpoint,
  AgentSessionProviderTranscriptPublishRequest,
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeRuntime,
  AgentSessionRealtimeStartInput,
  AgentSessionRealtimeStartRequestV1,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResult,
  AgentSessionRealtimeStartResultV1Schema,
  AgentSessionRealtimeStopResult,
  AgentSessionRunnerFactoryLocatorV1,
  AgentSessionRuntime,
  AgentSessionRuntimeCapabilities as AgentAuthoredSessionRuntimeCapabilities,
  AgentSessionRuntimeAuthApplyRequest,
  AgentSessionRuntimeAuthApplyResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeAuthIdentityRequest,
  AgentSessionRuntimeAuthIdentityResult,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
  AgentSessionRuntimeEventSchema,
  AgentSessionRuntimeFactory,
  AgentSessionRuntimeCapabilitySupportLevel,
  AgentSessionSendRequest,
  AgentSessionSendResult,
  AgentSessionSkillCatalogItem,
  AgentSessionStartupContributionV1,
  AgentSessionStartupInstructions,
  AgentSessionTerminalComposerClearOutcome,
  AgentSessionUsageLimitRecoveryControl,
  AgentSessionUsageLimitRecoveryRequest,
  AgentSessionUsageLimitRecoveryResult,
  AgentSessionVendorPluginCatalogItem,
  AgentSessionWorkflowActivityService,
  AgentTerminalControlPresentation,
  AgentTerminalHostCreateOrAttachRequest,
  AgentTerminalHostDisposeIntent,
  AgentTerminalHostLaunchInput,
  AgentTerminalHostResolutionReason,
  AgentTerminalHostResolveRequest,
  AgentTerminalHostResolveResult,
  AgentTerminalHostService,
  AgentTerminalLaunchMetadata,
  AgentTerminalLaunchPlan,
  AgentTerminalLaunchRequest,
  AgentTerminalPromptSubmitVerificationPolicyV1,
  AgentTerminalSessionIdentityFieldId,
  AgentTerminalSessionStateUpdate,
  AgentTerminalSurface,
  AgentToolExecutionBeforeRequest,
  AgentToolExecutionBeforeResult,
  AgentToolExecutionLifecycle,
  AgentToolExecutionService,
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowInput,
  AgentTranscriptFileFollowLine,
  AgentTranscriptFileFollowService,
  AgentTranscriptSessionEventPublicationResult,
  AgentTranscriptSessionEventPublisher,
  AttachAvailabilityRequest,
  AttachFailureCode,
  AttachRequest,
  AttachSessionMetadata,
  AttachSurface,
  AcpSessionOperationsV1,
  BackendSessionLaunchHintsV1,
  BackendSurfaceAvailabilityV1,
  BackendSurfaceBaseFailureCodeV1,
  BackendSurfaceDiagnosticV1,
  BackendSurfaceOperationReceiptV1,
  BackendSurfaceResultV1,
  CheckpointSurface,
  ForkAvailabilityRequestV1,
  ForkPointV1,
  ForkRequestV1,
  ForkResultV1,
  ForkSessionMetadata,
  ForkSurfaceV1,
  HandoffAvailabilityRequestV1,
  HandoffExportRequestV1,
  HandoffExportResultV1,
  HandoffExportSessionMetadata,
  HandoffFailureCodeV1,
  HandoffImportRequestV1,
  HandoffImportResultV1,
  HandoffMediaScannableRecordsRequestV1,
  HandoffNativeTranscriptPathCandidateRequestV1,
  HandoffNativeTranscriptPathCandidateV1,
  HandoffRuntimeDescriptorV1,
  HandoffRuntimeLocalExternalSessionSourceV1,
  HandoffRuntimeLocalMetadataIdentityV1,
  HandoffRuntimeLocalMetadataRequestV1,
  HandoffRuntimeLocalMetadataV1,
  HandoffSurfaceV1,
  ProviderBoundModelRef,
  ProviderTranscriptDispatchRequestV1,
  RecoverableTurnFailureRetryDecision,
  ReplayForkChildLaunchRequestV1,
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
  RuntimeConfigUpdateOutcomeV1,
  RuntimeDescriptorV1,
  RuntimeOutboundTranscriptToolNormalizationV1,
  RuntimeOutboundTranscriptUsageObservationV1,
  SessionContextUsageSnapshotV1,
  SessionContextUsageSnapshotV1Schema,
  SkillCatalogItemV1,
  SkillCatalogV1,
  TerminalControlCaptureResult,
  TerminalAttachmentId,
  TerminalControlCapture,
  TerminalControlPort,
  TerminalControlSendFailureReason,
  TerminalControlSendResult,
  TerminalControlUnsupportedReason,
  TerminalHostAttachMetadata,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLiveness,
  TerminalHostPreference,
  TerminalInputInjectionResult,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputReadinessV1,
  TerminalInputReadinessStatusV1,
  TerminalInputState,
  TerminalPromptInput,
  TerminalSpecialKey,
  TimestampedAgentValue,
  TranscriptRawAgentEventV1,
  UsageObservationContext,
  UsageObservationContextSchema,
  UsageObservationCost,
  UsageObservationCostSchema,
  UsageObservationEffectV1,
  UsageObservationScope,
  UsageObservationScopeSchema,
  UsageObservationTokens,
  UsageObservationTokensSchema,
  VendorPluginCatalogItemV1,
  VendorPluginCatalogV1,
  AGENT_CONNECTED_ACCOUNT_RUNTIME_AUTH_FAILURE_KINDS,
  assertAgentSessionRealtimeRuntime,
  buildAgentAccountUsageRecordId,
  buildShellCommand,
  buildUsageObservationEffect,
  createAcpToolNameInferencePreset,
  createAgentSessionPreAdmissionBuffer,
  isRuntimeConfigUpdateOutcomeApplied,
  normalizeAcpPermissionIntent,
  parsePermissionIntentAlias,
  resolveAcpToolPermissionPolicy,
  resolveRecoverableTurnFailureRetryDecision,
  resolveRecoverableTurnFailureSecondFailure,
  resolveTerminalPromptWriteTimeoutMs,
} from './agentRuntime/index.js';
import type {
  AttachSessionMetadataV1,
  AgentSessionCapabilitySupportLevel,
  ForkSessionMetadataV1,
  HandoffExportSessionMetadataV1,
  RuntimeCapabilities,
  TerminalHostLivenessV1,
} from '@happier-dev/agents';
import type {
  AIBackendProfile,
  AgentSessionStartupInstructionsV1,
  PluginAgentAcpTransport,
  PluginAgentContributionV2,
} from '@happier-dev/protocol';
import type {
  ExperimentalAgentSessionRealtimeRuntime,
} from './experimental/agentRuntime/realtime.js';
import type {
  AttachSessionMetadata as ProjectedAttachSessionMetadata,
  ForkSessionMetadata as ProjectedForkSessionMetadata,
  HandoffExportSessionMetadata as ProjectedHandoffExportSessionMetadata,
} from './agentRuntime/projections.js';

type AssertTrue<T extends true> = T;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false;

type _AgentContributionIdentity = AssertTrue<
  Equal<AgentContribution, PluginAgentContributionV2>
>;
type _AgentProfileIdentity = AssertTrue<Equal<AgentProfile, AIBackendProfile>>;
type _AgentAcpTransportIdentity = AssertTrue<
  Equal<AgentAcpTransport, PluginAgentAcpTransport>
>;
type _AgentSessionStartupInstructionsIdentity = AssertTrue<
  Equal<AgentSessionStartupInstructions, AgentSessionStartupInstructionsV1>
>;
type _AttachSessionMetadataIdentity = AssertTrue<
  Equal<ProjectedAttachSessionMetadata, AttachSessionMetadataV1>
>;
type _AttachSurfaceIdentityUpdates = AssertTrue<
  Equal<
    NonNullable<
      NonNullable<
        Extract<Awaited<ReturnType<AttachSurface['attach']>>, { ok: true }>['receipt']
      >['sessionStateUpdates']
    >[number]['fieldId'],
    'identity.runtimeDescriptor' | 'identity.providerSessionId'
  >
>;
type _CheckpointSurfaceIdentityUpdates = AssertTrue<
  Equal<
    NonNullable<
      NonNullable<
        Awaited<ReturnType<NonNullable<CheckpointSurface['restore']>>>['receipt']
      >['sessionStateUpdates']
    >[number]['fieldId'],
    'identity.runtimeDescriptor' | 'identity.providerSessionId'
  >
>;
type _ForkSessionMetadataIdentity = AssertTrue<
  Equal<ProjectedForkSessionMetadata, ForkSessionMetadataV1>
>;
type _HandoffExportSessionMetadataIdentity = AssertTrue<
  Equal<ProjectedHandoffExportSessionMetadata, HandoffExportSessionMetadataV1>
>;
type _TerminalHostLivenessIdentity = AssertTrue<
  Equal<TerminalHostLiveness, TerminalHostLivenessV1>
>;
type _AgentSessionRealtimeRuntimeIdentity = AssertTrue<
  Equal<AgentSessionRealtimeRuntime, ExperimentalAgentSessionRealtimeRuntime>
>;
type _AgentSessionProviderBindingUpstreamIdentity = AssertTrue<
  Equal<AgentSessionProviderBinding['upstream'], AgentSessionProviderBindingUpstream>
>;
type _AgentSessionRuntimeCapabilitiesIdentity = AssertTrue<
  Equal<AgentSessionRuntimeCapabilities, RuntimeCapabilities>
>;
type _AgentSessionRuntimeCapabilitySupportLevelIdentity = AssertTrue<
  Equal<AgentSessionRuntimeCapabilitySupportLevel, AgentSessionCapabilitySupportLevel>
>;

// Binding-plan negatives: these names belong to another domain or are replaced by
// a canonical owner. Keeping the fences here catches a stale-map mechanical copy.
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-8:4oCUIG1vZGVsIGludmVudG9yaWVzIGFyZSBnZW5lcmF0ZWQgZnJvbSBwbHVnaW4tb3duZWQgZGVmaW5pdGlvbnMgYW5kIHJlbWFpbiBob3N0LWludGVybmFsLg:aW1wb3J0IHR5cGUgeyBBR0VOVF9NT0RFTF9DT05GSUcgfSBmcm9tICcuL2FnZW50cy5qcyc7 */
type AGENT_MODEL_CONFIG = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-9:4oCUIEFHRU5UU19DT1JFIGlzIGEgaG9zdC1vbmx5IHN5bm9ueW0gZm9yIHRoZSBnZW5lcmF0ZWQgY2Fub25pY2FsIHJlZ2lzdHJ5Lg:aW1wb3J0IHR5cGUgeyBBR0VOVFNfQ09SRSB9IGZyb20gJy4vYWdlbnRzLmpzJzs */
type AGENTS_CORE = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-10:4oCUIGF1dGgtcHJvYmUgaW52ZW50b3JpZXMgYXJlIGhvc3QgcG9saWN5LCBub3QgYW4gYXV0aG9yIGRlY2xhcmF0aW9uIHByaW1pdGl2ZS4:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRfQVVUSF9QUk9CRV9DT05GSUcgfSBmcm9tICcuL2FnZW50cy5qcyc7 */
type CANONICAL_AGENT_AUTH_PROBE_CONFIG = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-11:4oCUIENMSSBydW50aW1lIGludmVudG9yaWVzIGFyZSBob3N0IGV4ZWN1dGlvbiBwb2xpY3ksIG5vdCBhbiBhdXRob3IgZGVjbGFyYXRpb24gcHJpbWl0aXZlLg:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRfQ0xJX1JVTlRJTUVfU1BFQ1MgfSBmcm9tICcuL2FnZW50cy5qcyc7 */
type CANONICAL_AGENT_CLI_RUNTIME_SPECS = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-12:4oCUIGxvY2FsIENMSSBpbnZlbnRvcmllcyBhcmUgaG9zdCBleGVjdXRpb24gcG9saWN5LCBub3QgYW4gYXV0aG9yIGRlY2xhcmF0aW9uIHByaW1pdGl2ZS4:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRfTE9DQUxfQ0xJX0NPTkZJRyB9IGZyb20gJy4vYWdlbnRzLmpzJzs */
type CANONICAL_AGENT_LOCAL_CLI_CONFIG = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-13:4oCUIHNlc3Npb24tbW9kZSBpbnZlbnRvcmllcyBhcmUgZ2VuZXJhdGVkIGZyb20gcGx1Z2luLW93bmVkIGRlZmluaXRpb25zIGFuZCByZW1haW4gaG9zdC1pbnRlcm5hbC4:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRfU0VTU0lPTl9NT0RFX0RFU0NSSVBUT1JTIH0gZnJvbSAnLi9hZ2VudHMuanMnOw */
type CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-14:4oCUIHNlc3Npb24tbW9kZSBpbnZlbnRvcmllcyBhcmUgZ2VuZXJhdGVkIGZyb20gcGx1Z2luLW93bmVkIGRlZmluaXRpb25zIGFuZCByZW1haW4gaG9zdC1pbnRlcm5hbC4:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRfU0VTU0lPTl9NT0RFUyB9IGZyb20gJy4vYWdlbnRzLmpzJzs */
type CANONICAL_AGENT_SESSION_MODES = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-15:4oCUIEFnZW50IGNvcmUgaW52ZW50b3JpZXMgYXJlIGdlbmVyYXRlZCBmcm9tIHBsdWdpbi1vd25lZCBkZWZpbml0aW9ucyBhbmQgcmVtYWluIGhvc3QtaW50ZXJuYWwu:aW1wb3J0IHR5cGUgeyBDQU5PTklDQUxfQUdFTlRTX0NPUkUgfSBmcm9tICcuL2FnZW50cy5qcyc7 */
type CANONICAL_AGENTS_CORE = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-16:4oCUIEFnZW50Q29yZSBkZXNjcmliZXMgdGhlIGhvc3QtZ2VuZXJhdGVkIGJ1aWx0LWluIHJlZ2lzdHJ5LCBub3QgcGx1Z2luIGF1dGhvcmluZyBpbnB1dC4:aW1wb3J0IHR5cGUgeyBBZ2VudENvcmUgfSBmcm9tICcuL2FnZW50cy5qcyc7 */
type AgentCore = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-17:4oCUIHRoZSBDTEkgcnVudGltZSBoZWxwZXIgaXMgYW4gZXhlY3V0aW9uIGNvbmNlcm4sIG5vdCBgL2FnZW50c2Au:aW1wb3J0IHR5cGUgeyBnZXRBZ2VudENsaVJ1bnRpbWVTcGVjIH0gZnJvbSAnLi9hZ2VudHMuanMnOw */
type getAgentCliRuntimeSpec = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-18:4oCUIHByb3ZpZGVyIHdpcmUgdm9jYWJ1bGFyeSBiZWxvbmdzIHRvIGAvcHJvdmlkZXJzYC4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyV2lyZVByb3RvY29sIH0gZnJvbSAnLi9hZ2VudFJ1bnRpbWUvaW5kZXguanMnOw */
type AgentProviderWireProtocol = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-19:4oCUIHRoZSBTREstbG9jYWwgbGl2ZW5lc3MgY29weSBpcyByZXBsYWNlZCBieSBUZXJtaW5hbEhvc3RMaXZlbmVzcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFRlcm1pbmFsSG9zdExpdmVuZXNzIH0gZnJvbSAnLi9hZ2VudFJ1bnRpbWUvaW5kZXguanMnOw */
type AgentTerminalHostLiveness = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-20:4oCUIHRoZSBwcmVkZWNlc3NvciBjbG9zZWQgc3lzdGVtLXJlY29yZCBwb3J0IG11c3Qgbm90IGJlIHJlcHVibGlzaGVkLg:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25TeXN0ZW1SZWNvcmRzU2VydmljZSB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type AgentSessionSystemRecordsService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-21:4oCUIHRoZSBjdXJyZW50IGFjY291bnQtdXNhZ2Ugb3duZXIgYWNjZXB0cyBzZW1hbnRpYyBzZXJ2aWNlIGlkcywgbm90IGEgc3RhbGUgY2xvc2VkIGFsaWFzLg:aW1wb3J0IHR5cGUgeyBBZ2VudENvbm5lY3RlZFNlcnZpY2VJZCB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type AgentConnectedServiceId = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-22:4oCUIFNlc3Npb24gYXV0aCBpcyBjb25zdW1lZCB0aHJvdWdoIHRoZSBjb21tb24gU2Vzc2lvbkhhbmRsZSBvd25lci4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25BdXRoU2VydmljZSB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type AgentSessionAuthService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-23:4oCUIHN0YWJpbGl0eSBpcyBjYXJyaWVkIGJ5IHRoZSBwYXRoLCBub3QgYW4gRXhwZXJpbWVudGFsIHByZWZpeC4:aW1wb3J0IHR5cGUgeyBFeHBlcmltZW50YWxBZ2VudFNlc3Npb25SZWFsdGltZVJ1bnRpbWUgYXMgUmV0aXJlZFJlYWx0aW1lUnVudGltZSB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type RetiredRealtimeRuntime = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-24:4oCUIHRoZSBmaW5hbCBBQ1AgdHJhbnNwb3J0IG5hbWUgaXMgZG9tYWluLXNjb3BlZCBhbmQgdW5zdWZmaXhlZC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5BZ2VudEFjcFRyYW5zcG9ydCBhcyBSZXRpcmVkQWNwVHJhbnNwb3J0IH0gZnJvbSAnLi9hZ2VudFJ1bnRpbWUvaW5kZXguanMnOw */
type RetiredAcpTransport = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-25:4oCUIHRoZSBmaW5hbCBzdGFydHVwIGNhcnJpZXIgbmFtZSBpcyB1bnN1ZmZpeGVkIG9uIHRoaXMgcGF0aC4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25TdGFydHVwSW5zdHJ1Y3Rpb25zVjEgYXMgUmV0aXJlZFN0YXJ0dXBJbnN0cnVjdGlvbnMgfSBmcm9tICcuL2FnZW50UnVudGltZS9pbmRleC5qcyc7 */
type RetiredStartupInstructions = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-26:4oCUIGNhbm9uaWNhbCBWMSBzb3VyY2UgaWRlbnRpdHkgaXMgY3VyYXRlZCB1bmRlciB0aGUgZmluYWwgbmFtZS4:aW1wb3J0IHR5cGUgeyBBdHRhY2hTZXNzaW9uTWV0YWRhdGFWMSBhcyBSZXRpcmVkQXR0YWNoTWV0YWRhdGEgfSBmcm9tICcuL2FnZW50UnVudGltZS9pbmRleC5qcyc7 */
type RetiredAttachMetadata = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-27:4oCUIGNhbm9uaWNhbCBWMSBzb3VyY2UgaWRlbnRpdHkgaXMgY3VyYXRlZCB1bmRlciB0aGUgZmluYWwgbmFtZS4:aW1wb3J0IHR5cGUgeyBGb3JrU2Vzc2lvbk1ldGFkYXRhVjEgYXMgUmV0aXJlZEZvcmtNZXRhZGF0YSB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type RetiredForkMetadata = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agents-finalProjection-contract-ts-28:4oCUIGNhbm9uaWNhbCBWMSBzb3VyY2UgaWRlbnRpdHkgaXMgY3VyYXRlZCB1bmRlciB0aGUgZmluYWwgbmFtZS4:aW1wb3J0IHR5cGUgeyBIYW5kb2ZmRXhwb3J0U2Vzc2lvbk1ldGFkYXRhVjEgYXMgUmV0aXJlZEhhbmRvZmZNZXRhZGF0YSB9IGZyb20gJy4vYWdlbnRSdW50aW1lL2luZGV4LmpzJzs */
type RetiredHandoffMetadata = never; /* @sdk-negative-type-case-end */

export {};
