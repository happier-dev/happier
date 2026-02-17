export const HAPPY_PROTOCOL_PACKAGE = '@happier-dev/protocol';

export {
  deriveAccountMachineKeyFromRecoverySecret,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedBlobKind,
  type AccountScopedCiphertextFormat,
  type AccountScopedCryptoMaterial,
  type AccountScopedOpenResult,
} from './crypto/accountScopedCipher.js';

export {
  ConnectedServiceCredentialFormatSchema,
  ConnectedServiceCredentialKindSchema,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaMeterV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  ConnectedServiceQuotaUnitV1Schema,
  SealedConnectedServiceCredentialV1Schema,
  SealedConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedServiceCredentialFormat,
  type ConnectedServiceCredentialKind,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type ConnectedServiceProfileId,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceQuotaUnitV1,
  type SealedConnectedServiceCredentialV1,
  type SealedConnectedServiceQuotaSnapshotV1,
} from './connect/connectedServiceSchemas.js';

export {
  openConnectedServiceCredentialCiphertext,
  openConnectedServiceQuotaSnapshotCiphertext,
  sealConnectedServiceCredentialCiphertext,
  sealConnectedServiceQuotaSnapshotCiphertext,
} from './connect/connectedServiceCipher.js';

export {
  CONNECTED_SERVICE_ERROR_CODES,
  ConnectedServiceErrorCodeSchema,
  type ConnectedServiceErrorCode,
} from './connect/connectedServiceErrors.js';

export { buildConnectedServiceCredentialRecord } from './connect/buildConnectedServiceCredentialRecord.js';

export { parseBooleanEnv, parseOptionalBooleanEnv } from './env/parseBooleanEnv.js';

export {
  BOX_BUNDLE_MIN_BYTES,
  BOX_BUNDLE_NONCE_BYTES,
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
  deriveBoxPublicKeyFromSeed,
  deriveBoxSecretKeyFromSeed,
  openBoxBundle,
  sealBoxBundle,
} from './crypto/boxBundle.js';

export {
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from './crypto/encryptedDataKeyEnvelopeV1.js';

export {
  TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES,
  TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES,
  TERMINAL_PROVISIONING_V2_VERSION_BYTE,
  openTerminalProvisioningV2Payload,
  sealTerminalProvisioningV2Payload,
} from './crypto/terminalProvisioningV2.js';

export { decodeBase64, encodeBase64, type Base64Variant } from './crypto/base64.js';

export { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorCode, type SpawnSessionResult } from './spawnSession.js';
export {
  HappierReplayDialogItemSchema,
  HappierReplayStrategySchema,
  SessionContinueWithReplayRequestSchema,
  SessionContinueWithReplayRpcParamsSchema,
  SessionContinueWithReplayRpcResultSchema,
  type HappierReplayDialogItem,
  type HappierReplayStrategy,
  type SessionContinueWithReplayRequest,
  type SessionContinueWithReplayRpcParams,
  type SessionContinueWithReplayRpcResult,
} from './sessionContinueWithReplay.js';
export {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  isRpcMethodNotFoundResult,
  type RpcErrorCode,
  type RpcMethod,
} from './rpc.js';
export {
  createRpcCallError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
  type RpcErrorCarrier,
} from './rpcErrors.js';
export { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklists.js';
export { SOCKET_RPC_EVENTS, type SocketRpcEvent } from './socketRpc.js';
export {
  ChangeEntrySchema,
  ChangeKindSchema,
  ChangesResponseSchema,
  CursorGoneErrorSchema,
  type ChangeEntry,
  type ChangeKind,
  type ChangesResponse,
  type CursorGoneError,
} from './changes.js';
export {
  type CapabilitiesDescribeResponse,
  type CapabilitiesDetectRequest,
  type CapabilitiesDetectResponse,
  type CapabilitiesInvokeRequest,
  type CapabilitiesInvokeResponse,
  type CapabilityDescriptor,
  type CapabilityDetectRequest,
  type CapabilityDetectResult,
  type CapabilityId,
  type CapabilityKind,
} from './capabilities.js';

export {
  EphemeralUpdateSchema,
  MessageAckResponseSchema,
  SessionBroadcastBodySchema,
  SessionBroadcastContainerSchema,
  UpdateBodySchema,
  UpdateContainerSchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
  type EphemeralUpdate,
  type MessageAckResponse,
  type SessionBroadcastBody,
  type SessionBroadcastContainer,
  type UpdateBody,
  type UpdateContainer,
  type UpdateMetadataAckResponse,
  type UpdateStateAckResponse,
} from './updates.js';

export { SENT_FROM_VALUES, SentFromSchema, type SentFrom } from './sentFrom.js';
export {
  SessionControlEnvelopeBaseSchema,
  SessionControlEnvelopeErrorSchema,
  SessionControlEnvelopeSuccessSchema,
  SessionControlErrorCodeSchema,
  SessionControlErrorSchema,
  SessionCreateResultSchema,
  SessionCreateEnvelopeSchema,
  SessionHistoryEnvelopeSchema,
  SessionHistoryResultSchema,
  SessionListEnvelopeSchema,
  SessionListResultSchema,
  SessionRunActionResultSchema,
  SessionRunActionEnvelopeSchema,
  SessionRunGetEnvelopeSchema,
  SessionRunGetResultSchema,
  SessionRunListEnvelopeSchema,
  SessionRunListResultSchema,
  SessionRunSendEnvelopeSchema,
  SessionRunSendResultSchema,
  SessionRunStartEnvelopeSchema,
  SessionRunStartResultSchema,
  SessionRunStopEnvelopeSchema,
  SessionRunStopResultSchema,
  SessionRunWaitEnvelopeSchema,
  SessionRunWaitResultSchema,
  SessionSendEnvelopeSchema,
  SessionSendResultSchema,
  SessionStatusEnvelopeSchema,
  SessionStatusResultSchema,
  SessionStopEnvelopeSchema,
  SessionStopResultSchema,
  SessionSummarySchema,
  SessionWaitEnvelopeSchema,
  SessionWaitResultSchema,
  type SessionControlErrorCode,
  type SessionControlError,
  type SessionControlEnvelopeBase,
  type SessionControlEnvelopeError,
  type SessionControlEnvelopeSuccess,
  type SessionCreateResult,
  type SessionHistoryResult,
  type SessionListResult,
  type SessionRunActionResult,
  type SessionRunGetResult,
  type SessionRunListResult,
  type SessionRunSendResult,
  type SessionRunStartResult,
  type SessionRunStopResult,
  type SessionRunWaitResult,
  type SessionSendResult,
  type SessionStatusResult,
  type SessionStopResult,
  type SessionSummary,
  type SessionWaitResult,
} from './sessionControl/contract.js';
export {
  ServerCurrentEnvelopeSchema,
  ServerCurrentResultSchema,
  ServerListEnvelopeSchema,
  ServerListResultSchema,
  ServerProfileSummarySchema,
  type ServerCurrentResult,
  type ServerListResult,
  type ServerProfileSummary,
} from './serverControl/contract.js';
export {
  SCM_COMMIT_MESSAGE_MAX_LENGTH,
  SCM_COMMIT_PATCH_MAX_COUNT,
  SCM_COMMIT_PATCH_MAX_LENGTH,
  SCM_OPERATION_ERROR_CODES,
  ScmBackendDescribeRequestSchema,
  ScmBackendDescribeResponseSchema,
  ScmBackendIdSchema,
  ScmBackendPreferenceSchema,
  ScmCapabilitiesSchema,
  ScmChangeApplyRequestSchema,
  ScmChangeApplyResponseSchema,
  ScmCommitBackoutRequestSchema,
  ScmCommitBackoutResponseSchema,
  ScmCommitPatchSchema,
  ScmCommitCreateRequestSchema,
  ScmCommitCreateResponseSchema,
  ScmDiffAreaSchema,
  ScmDiffCommitRequestSchema,
  ScmDiffCommitResponseSchema,
  ScmDiffFileRequestSchema,
  ScmDiffFileResponseSchema,
  ScmEntryKindSchema,
  ScmLogEntrySchema,
  ScmLogListRequestSchema,
  ScmLogListResponseSchema,
  ScmOperationErrorCodeSchema,
  ScmPathStatsSchema,
  ScmRemoteRequestSchema,
  ScmRemoteResponseSchema,
  classifyScmOperationErrorCode,
  evaluateScmRemoteMutationPolicy,
  hasAnyPendingScmChanges,
  inferScmRemoteTarget,
  isScmPatchBoundToPath,
  mapGitScmErrorCode,
  mapSaplingScmErrorCode,
  normalizeScmRemoteRequest,
  parseScmPatchPaths,
  parseScmUpstreamRef,
  ScmRepoModeSchema,
  ScmRequestBaseSchema,
  ScmStatusSnapshotRequestSchema,
  ScmStatusSnapshotResponseSchema,
  ScmWorkingEntrySchema,
  ScmWorkingSnapshotSchema,
  type ScmBackendDescribeRequest,
  type ScmBackendDescribeResponse,
  type ScmBackendId,
  type ScmBackendPreference,
  type ScmCapabilities,
  type ScmChangeApplyRequest,
  type ScmChangeApplyResponse,
  type ScmCommitBackoutRequest,
  type ScmCommitBackoutResponse,
  type ScmCommitPatch,
  type ScmCommitCreateRequest,
  type ScmCommitCreateResponse,
  type ScmDiffArea,
  type ScmDiffCommitRequest,
  type ScmDiffCommitResponse,
  type ScmDiffFileRequest,
  type ScmDiffFileResponse,
  type ScmEntryKind,
  type ScmLogEntry,
  type ScmLogListRequest,
  type ScmLogListResponse,
  type ScmOperationErrorCode,
  type ScmOperationErrorCategory,
  type ScmPathStats,
  type ScmRemoteMutationKind,
  type ScmRemoteMutationPolicy,
  type ScmRemoteMutationReason,
  type ScmRemoteMutationResult,
  type ScmRemoteMutationSnapshot,
  type ScmRemoteRequest,
  type ScmRemoteResponse,
  type ScmRemoteTarget,
  type ScmRepoMode,
  type ScmRequestBase,
  type ScmStatusSnapshotRequest,
  type ScmStatusSnapshotResponse,
  type ScmWorkingEntry,
  type ScmWorkingSnapshot,
} from './scm.js';
export {
  resolveScmScopedChangedPaths,
  scmPathMatchesScopePath,
} from './scmPathScope.js';
export {
  createGitScmCapabilities,
  createSaplingScmCapabilities,
  createScmCapabilities,
} from './scmCapabilities.js';

export {
  VOICE_ACTIONS_BLOCK,
  VoiceAssistantActionSchema,
  extractVoiceActionsFromAssistantText,
  type VoiceAssistantAction,
} from './voiceActions.js';

export {
  ExecutionRunIntentSchema,
  ExecutionRunTransportErrorCodeSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunPublicStateSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunClassSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunResumeHandleSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunSendRequestSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStopRequestSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunEnsureRequestSchema,
  ExecutionRunEnsureResponseSchema,
  ExecutionRunEnsureOrStartRequestSchema,
  ExecutionRunEnsureOrStartResponseSchema,
  ExecutionRunActionRequestSchema,
  ExecutionRunActionResponseSchema,
  ExecutionRunTurnStreamStartRequestSchema,
  ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelRequestSchema,
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamEventSchema,
  ExecutionRunTurnStreamEventDeltaSchema,
  ExecutionRunTurnStreamEventDoneSchema,
  ExecutionRunTurnStreamEventErrorSchema,
  ExecutionRunStatusSchema,
  type ExecutionRunIntent,
  type ExecutionRunTransportErrorCode,
  type ExecutionRunDisplay,
  type ExecutionRunPublicState,
  type ExecutionRunStartRequest,
  type ExecutionRunStartResponse,
  type ExecutionRunRetentionPolicy,
  type ExecutionRunClass,
  type ExecutionRunIoMode,
  type ExecutionRunResumeHandle,
  type ExecutionRunListRequest,
  type ExecutionRunListResponse,
  type ExecutionRunGetRequest,
  type ExecutionRunGetResponse,
  type ExecutionRunSendRequest,
  type ExecutionRunSendResponse,
  type ExecutionRunStopRequest,
  type ExecutionRunStopResponse,
  type ExecutionRunEnsureRequest,
  type ExecutionRunEnsureResponse,
  type ExecutionRunEnsureOrStartRequest,
  type ExecutionRunEnsureOrStartResponse,
  type ExecutionRunActionRequest,
  type ExecutionRunActionResponse,
  type ExecutionRunTurnStreamStartRequest,
  type ExecutionRunTurnStreamStartResponse,
  type ExecutionRunTurnStreamReadRequest,
  type ExecutionRunTurnStreamReadResponse,
  type ExecutionRunTurnStreamCancelRequest,
  type ExecutionRunTurnStreamCancelResponse,
  type ExecutionRunTurnStreamEvent,
  type ExecutionRunTurnStreamEventDelta,
  type ExecutionRunTurnStreamEventDone,
  type ExecutionRunTurnStreamEventError,
  type ExecutionRunStatus,
} from './executionRuns.js';

export {
  DaemonExecutionRunMarkerSchema,
  DaemonExecutionRunProcessInfoSchema,
  DaemonExecutionRunEntrySchema,
  DaemonExecutionRunListRequestSchema,
  DaemonExecutionRunListResponseSchema,
  type DaemonExecutionRunMarker,
  type DaemonExecutionRunProcessInfo,
  type DaemonExecutionRunEntry,
  type DaemonExecutionRunListRequest,
  type DaemonExecutionRunListResponse,
} from './daemonExecutionRuns.js';

export {
  EphemeralTaskKindSchema,
  EphemeralTaskPermissionModeSchema,
  EphemeralTaskRunRequestSchema,
  EphemeralTaskRunResponseSchema,
  type EphemeralTaskKind,
  type EphemeralTaskPermissionMode,
  type EphemeralTaskRunRequest,
  type EphemeralTaskRunResponse,
} from './ephemeralTasks.js';

export {
  ReviewFindingSchema,
  type ReviewFinding,
  type ReviewFindingId,
} from './reviews/ReviewFinding.js';

export {
  ReviewChangeTypeSchema,
  ReviewBaseSchema,
  ReviewEngineIdSchema,
  CodeRabbitReviewEngineInputSchema,
  ReviewEngineInputsSchema,
  ReviewStartInputSchema,
  type ReviewChangeType,
  type ReviewBase,
  type ReviewEngineId,
  type CodeRabbitReviewEngineInput,
  type ReviewEngineInputs,
  type ReviewStartInput,
} from './reviews/reviewStart.js';

export {
  NativeReviewEngineIdSchema,
  NativeReviewEngineSpecSchema,
  listNativeReviewEngines,
  getNativeReviewEngine,
  type NativeReviewEngineId,
  type NativeReviewEngineSpec,
} from './reviews/reviewEngines.js';

export {
  HappierMetaEnvelopeSchema,
  type HappierMetaEnvelope,
} from './structuredMessages/HappierMetaEnvelope.js';

export {
  ReviewFindingsV1Schema,
  ReviewTriageStatusSchema,
  ReviewTriageOverlaySchema,
  parseReviewFindingsV1,
  type ReviewFindingsV1,
  type ReviewTriageStatus,
  type ReviewTriageOverlay,
} from './structuredMessages/reviewFindingsV1.js';

export {
  PlanOutputV1Schema,
  parsePlanOutputV1,
  type PlanOutputV1,
  type PlanOutputSectionV1,
  type PlanOutputMilestoneV1,
} from './structuredMessages/planOutputV1.js';

export {
  DelegateOutputV1Schema,
  parseDelegateOutputV1,
  type DelegateOutputV1,
  type DelegateDeliverableV1,
} from './structuredMessages/delegateOutputV1.js';

export {
  VoiceAgentTurnV1Schema,
  type VoiceAgentTurnV1,
} from './structuredMessages/voiceAgentTurnV1.js';

export {
  SessionSynopsisV1Schema,
  type SessionSynopsisV1,
} from './structuredMessages/sessionSynopsisV1.js';

export {
  SessionSummaryShardV1Schema,
  type SessionSummaryShardV1,
} from './structuredMessages/sessionSummaryShardV1.js';

export {
  MemoryCitationV1Schema,
  MemorySearchErrorCodeSchema,
  MemorySearchHitV1Schema,
  MemorySearchModeSchema,
  MemorySearchQueryV1Schema,
  MemorySearchResultV1Schema,
  MemorySearchScopeSchema,
  type MemoryCitationV1,
  type MemorySearchErrorCode,
  type MemorySearchHitV1,
  type MemorySearchMode,
  type MemorySearchQueryV1,
  type MemorySearchResultV1,
  type MemorySearchScope,
} from './memory/memorySearch.js';

export {
  MemorySnippetV1Schema,
  MemoryWindowV1Schema,
  type MemorySnippetV1,
  type MemoryWindowV1,
} from './memory/memoryWindow.js';

export {
  DEFAULT_MEMORY_SETTINGS,
  MemoryBudgetsSettingsV1Schema,
  MemoryDeepSettingsV1Schema,
  MemoryEmbeddingsSettingsV1Schema,
  MemoryHintsSettingsV1Schema,
  MemorySettingsV1Schema,
  MemoryWorkerSettingsV1Schema,
  normalizeMemorySettings,
  type MemoryBudgetsSettingsV1,
  type MemoryDeepSettingsV1,
  type MemoryEmbeddingsSettingsV1,
  type MemoryHintsSettingsV1,
  type MemorySettingsV1,
  type MemoryWorkerSettingsV1,
} from './memory/memorySettings.js';

export * from './actions/index.js';

// Tool normalization (V2)
export * from './tools/v2/index.js';

// Provider E2E specs (used by `@happier-dev/tests` to run real provider contract matrix)
export { E2eCliProviderSpecV1Schema, type E2eCliProviderSpecV1 } from './e2e/providerSpec.js';
export {
  E2eCliProviderScenarioRegistryV1Schema,
  type E2eCliProviderScenarioRegistryV1,
} from './e2e/providerScenarios.js';

// Diff helpers
export { splitUnifiedDiffByFile } from './diff/splitUnifiedDiffByFile.js';

// Happier server feature discovery + social contracts
export {
  BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS,
  BugReportsCapabilitiesSchema,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  FeatureGateSchema,
  FeatureGatesSchema,
  FeaturesResponseSchema,
  OAuthProviderStatusSchema,
  coerceBugReportsCapabilitiesFromFeaturesPayload,
  type BugReportsCapabilities,
  type Capabilities,
  type FeatureGate,
  type FeatureGates,
  type FeaturesResponse,
  type OAuthProviderStatus,
} from './features.js';
export {
  FEATURE_CATALOG,
  FEATURE_IDS,
  featureRequiresServerSnapshot,
  getFeatureDefinition,
  getFeatureDependencies,
  getFeatureRepresentation,
  isFeatureServerRepresented,
  isFeatureId,
  type FeatureFailMode,
  type FeatureId,
} from './features/catalog.js';
export {
  readServerEnabledBit,
  resolveServerEnabledBitPath,
  tryWriteServerEnabledBitInPlace,
} from './features/serverEnabledBit.js';
export {
  FeatureAxisSchema,
  FeatureBlockerCodeSchema,
  FeatureDecisionSchema,
  FeatureDecisionScopeSchema,
  FeatureStateSchema,
  createFeatureDecision,
  type FeatureAxis,
  type FeatureBlockerCode,
  type FeatureDecision,
  type FeatureDecisionScope,
  type FeatureState,
} from './features/decision.js';
export {
  evaluateFeatureBuildPolicy,
  parseFeatureBuildPolicy,
  type FeatureBuildPolicy,
  type FeatureBuildPolicyEvaluation,
} from './features/buildPolicy.js';
export {
  applyFeatureDependencies,
  evaluateFeatureDecisionBase,
  type FeatureDecisionBaseInput,
} from './features/featureDecisionEngine.js';
export {
  mergeFeatureBuildPolicies,
  resolveEmbeddedFeatureBuildPolicy,
  resolveEmbeddedFeaturePolicyEnv,
  resolveFeatureBuildPolicyFromEnvOrEmbedded,
  type EmbeddedFeaturePolicyEnv,
} from './features/embeddedFeaturePolicy.js';
export {
  RelationshipStatusSchema,
  type RelationshipStatus,
  UserProfileSchema,
  type UserProfile,
  UserResponseSchema,
  type UserResponse,
  FriendsResponseSchema,
  type FriendsResponse,
  UsersSearchResponseSchema,
  type UsersSearchResponse,
  RelationshipUpdatedEventSchema,
  type RelationshipUpdatedEvent,
} from './social/friends.js';

export {
  AccountProfileSchema,
  AccountProfileResponseSchema,
  LinkedProviderSchema,
  type AccountProfile,
  type AccountProfileResponse,
  type LinkedProvider,
} from './account/profile.js';

export {
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  AccountSettingsSchema,
  NotificationsSettingsV1Schema,
  DEFAULT_ACTIONS_SETTINGS_V1,
  DEFAULT_NOTIFICATIONS_SETTINGS_V1,
  accountSettingsParse,
  getNotificationsSettingsV1FromAccountSettings,
  type AccountSettings,
  type NotificationsSettingsV1,
} from './account/settings/index.js';

export { ProfileBadgeSchema, type ProfileBadge } from './common/profileBadge.js';

// Auth provider registry + shared auth error codes
export { AuthProviderIdSchema, type AuthProviderId } from './auth/providers.js';
export { AUTH_ERROR_CODES, AuthErrorCodeSchema, type AuthErrorCode } from './auth/errors.js';
export {
  ExternalOAuthErrorResponseSchema,
  ExternalOAuthFinalizeAuthRequestSchema,
  ExternalOAuthFinalizeAuthSuccessResponseSchema,
  ExternalOAuthFinalizeConnectRequestSchema,
  ExternalOAuthFinalizeConnectSuccessResponseSchema,
  ExternalOAuthParamsResponseSchema,
  type ExternalOAuthErrorResponse,
  type ExternalOAuthFinalizeAuthRequest,
  type ExternalOAuthFinalizeAuthSuccessResponse,
  type ExternalOAuthFinalizeConnectRequest,
  type ExternalOAuthFinalizeConnectSuccessResponse,
  type ExternalOAuthParamsResponse,
} from './auth/externalOAuth.js';

export {
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  BUG_REPORT_DEFAULT_ISSUE_LABELS,
  BUG_REPORT_FALLBACK_BODY_TRUNCATION_SUFFIX,
  BUG_REPORT_FALLBACK_ISSUE_URL_MAX_LENGTH,
  BUG_REPORT_FALLBACK_MAX_LABELS,
  BUG_REPORT_FALLBACK_MAX_LABEL_LENGTH,
  buildBugReportFallbackIssueUrl,
  formatBugReportFallbackIssueBody,
  appendBugReportReporterToSummary,
  hasAcceptedBugReportArtifactKind,
  inferBugReportDeploymentTypeFromServerUrl,
  normalizeBugReportGithubUsername,
  normalizeBugReportIssueSlug,
  normalizeBugReportIssueTarget,
  normalizeBugReportProviderUrl,
  normalizeBugReportReproductionSteps,
  pushBugReportArtifact,
  redactBugReportSensitiveText,
  resolveBugReportIssueTargetWithDefaults,
  resolveBugReportServerDiagnosticsLines,
  sanitizeBugReportArtifactFileSegment,
  sanitizeBugReportArtifactPath,
  sanitizeBugReportDaemonDiagnosticsPayload,
  sanitizeBugReportStackContextPayload,
  sanitizeBugReportUrl,
  searchBugReportSimilarIssues,
  submitBugReportToService,
  trimBugReportTextToMaxBytes,
  type BugReportArtifactPayload,
  type BugReportDeploymentType,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
  type BugReportFrequency,
  type BugReportSimilarIssue,
  type BugReportMachineDaemonLogLike,
  type BugReportMachineDaemonStateLike,
  type BugReportMachineDiagnosticsLike,
  type BugReportMachineRuntimeLike,
  type BugReportMachineStackContextLike,
  type BugReportServiceSubmitInput,
  type BugReportSeverity,
} from './bugReports.js';
