export const HAPPY_PROTOCOL_PACKAGE = '@happier-dev/protocol';

export type {
  SettingAnalyticsIdentityScope,
  SettingAnalyticsMetadata,
  SettingAnalyticsPrivacy,
  SettingAnalyticsStructuredScalars,
  SettingDefinition,
  SettingDefinitionMap,
  SettingStorageScope,
  SettingValueKind,
} from './settingsRegistry/settingDefinition.js';
export { buildSettingArtifacts } from './settingsRegistry/buildSettingArtifacts.js';
export type { SettingArtifacts } from './settingsRegistry/buildSettingArtifacts.js';
export { defineSettingDefinitions } from './settingsRegistry/settingDefinition.js';
export {
  BackendTargetKeySchema,
  BackendTargetKindSchema,
  BackendTargetRefSchema,
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
  parseBackendTargetKey,
  type BackendTargetKey,
  type BackendTargetKind,
  type BackendTargetRefV1,
} from './backendTargets/backendTargetRef.js';

export {
  AcpBackendAuthConfigV1Schema,
  AcpBackendCapabilitiesV1Schema,
  AcpBackendDefinitionV1Schema,
  AcpCatalogAuthParserV1Schema,
  AcpCatalogAuthSupportV1Schema,
  AcpCatalogCommandV1Schema,
  AcpCatalogSettingsV1Schema,
  AcpCatalogSupportHintV1Schema,
  AcpCatalogTransportProfileV1Schema,
  type AcpBackendAuthConfigV1,
  type AcpBackendCapabilitiesV1,
  type AcpBackendDefinitionV1,
  type AcpCatalogAuthParserV1,
  type AcpCatalogAuthSupportV1,
  type AcpCatalogCommandV1,
  type AcpCatalogEnvValueRefV1,
  type AcpCatalogSettingsV1,
  type AcpCatalogSupportHintV1,
  type AcpCatalogTransportProfileV1,
} from './acpCatalog/settingsV1.js';

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
  EncryptedStringV1Schema,
  SecretStringV1Schema,
  decryptSecretStringV1,
  decryptSecretStringWithKeysV1,
  decryptSecretValueV1,
  decryptSecretValueWithKeysV1,
  deriveSettingsSecretsKeySetV1,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resealSecretsDeepV1,
  sealSecretsDeepV1,
  unsealSecretsDeepV1,
  unsealSecretsDeepWithKeysV1,
  type EncryptedStringV1,
  type ResealSecretsDeepV1Result,
  type SecretStringV1,
  type SettingsSecretsKeySetV1,
} from './crypto/settingsSecretStringsV1.js';

export {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
  ExpoPushNotificationChannelV1Schema,
  hasConfiguredSecretStringValue,
  NotificationChannelsV1Schema,
  NotificationChannelTopicsV1Schema,
  NotificationChannelV1Schema,
  WebhookNotificationChannelV1Schema,
  deriveExpoPushNotificationChannelFromLegacySettings,
  type ExpoPushNotificationChannelV1,
  type NotificationChannelsV1,
  type NotificationChannelTopicsV1,
  type NotificationChannelV1,
  type WebhookNotificationChannelV1,
} from './account/settings/notificationChannels.js';

export {
  resolveNotificationChannelsV1FromAccountSettings,
} from './account/settings/accountSettings.js';

export {
  collectExpoPushTokensMarkedUnregistered,
} from './push/expoPushDelivery.js';

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
export type { ServerRetentionCapabilities } from './features/payload/capabilities/serverRetentionCapabilities.js';

export {
  buildReadyNotificationContent,
} from './push/readyNotificationContent.js';

export {
  ActivityWebhookPayloadV1Schema,
  ActivityWebhookTopicSchema,
  buildActivityWebhookPayload,
  type ActivityWebhookPayloadV1,
  type ActivityWebhookTopic,
} from './activity/webhookPayload.js';

export {
  WorkspaceCheckoutKindSchema,
  WorkspaceCheckoutSchema,
  WorkspaceCheckoutStatusSchema,
  WorkspaceCheckoutSyncPolicySchema,
  WorkspaceConflictKindSchema,
  WorkspaceConflictResolutionSchema,
  WorkspaceConflictSchema,
  WorkspaceConflictStatusSchema,
  WorkspaceConflictVersionSchema,
  WorkspaceLocationCapabilitiesSchema,
  WorkspaceLocationSchema,
  WorkspaceSchema,
  WorkspaceSyncConfigSchema,
  WorkspaceSyncModeSchema,
  type Workspace,
  type WorkspaceCheckout,
  type WorkspaceCheckoutKind,
  type WorkspaceCheckoutStatus,
  type WorkspaceCheckoutSyncPolicy,
  type WorkspaceConflict,
  type WorkspaceConflictKind,
  type WorkspaceConflictResolution,
  type WorkspaceConflictStatus,
  type WorkspaceConflictVersion,
  type WorkspaceLocation,
  type WorkspaceLocationCapabilities,
  type WorkspaceSyncConfig,
  type WorkspaceSyncMode,
} from './workspaceReplication/index.js';

export {
  SessionStoredMessageContentSchema,
  type SessionStoredMessageContent,
} from './sessionMessages/sessionStoredMessageContent.js';

export {
  StoredJsonContentEnvelopeSchema,
  type StoredJsonContentEnvelope,
} from './storage/storedJsonContentEnvelope.js';

export {
  isSessionEncryptionModeAllowedByStoragePolicy,
  isStoredContentKindAllowedForSessionByStoragePolicy,
  resolveEffectiveDefaultAccountEncryptionMode,
  resolveStoredContentKindForSessionEncryptionMode,
  type SessionEncryptionMode,
  type SessionStoredContentKind,
} from './encryption/storagePolicyDecisions.js';

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
  parseSerializedJsonValue,
  stringifySerializedJsonValue,
} from './crypto/serializedJsonValue.js';

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

export {
  McpServerBindingOverridesV1Schema,
  McpServerBindingTargetV1Schema,
  McpServerBindingV1Schema,
  McpServerCatalogEntryTransportV1Schema,
  McpServerCatalogEntryV1Schema,
  McpServersSettingsV1Schema,
  McpValueRefV1Schema,
  type McpServerBindingOverridesV1,
  type McpServerBindingTargetV1,
  type McpServerBindingV1,
  type McpServerCatalogEntryTransportV1,
  type McpServerCatalogEntryV1,
  type McpServersSettingsV1,
  type McpValueRefV1,
} from './mcpServers/settingsV1.js';

export {
  resolveEffectiveServersV1,
  type ResolveEffectiveServersV1Result,
  type ResolvedMcpServerV1,
} from './mcpServers/resolveEffectiveServersV1.js';
export {
  parseSessionMcpSelectionV1Json,
  readSessionMcpSelectionV1FromMetadata,
  SessionMcpSelectionV1Schema,
  type SessionMcpSelectionV1,
} from './mcpServers/sessionSelectionV1.js';
export {
  resolveManagedSessionMcpSelectionV1,
  type ManagedSessionMcpAvailabilityV1,
  type ManagedSessionMcpPortabilityV1,
  type ManagedSessionMcpReasonCodeV1,
  type ManagedSessionMcpSelectionItemV1,
  type ResolveManagedSessionMcpSelectionV1Result,
} from './mcpServers/resolveManagedSessionMcpSelectionV1.js';
export {
  inferMcpServerAuthModeV1,
  type McpServerAuthModeV1,
} from './mcpServers/authModeV1.js';
export {
  BuiltInMcpPreviewEntryV1Schema,
  DaemonMcpServersPreviewRequestSchema,
  DaemonMcpServersPreviewResponseSchema,
  DetectedMcpPreviewEntryV1Schema,
  ManagedMcpPreviewEntryV1Schema,
  McpPreviewAuthModeV1Schema,
  McpPreviewEntryAvailabilityV1Schema,
  McpPreviewScopeKindV1Schema,
  McpPreviewSourceKindV1Schema,
  type BuiltInMcpPreviewEntryV1,
  type DaemonMcpServersPreviewRequest,
  type DaemonMcpServersPreviewResponse,
  type DetectedMcpPreviewEntryV1,
  type ManagedMcpPreviewEntryV1,
  type McpPreviewAuthModeV1,
  type McpPreviewEntryAvailabilityV1,
  type McpPreviewScopeKindV1,
  type McpPreviewSourceKindV1,
} from './mcpServers/previewV1.js';

export {
  DaemonMcpServersDetectRequestSchema,
  DaemonMcpServersDetectResponseSchema,
  DaemonMcpServersDetectWarningV1Schema,
  DaemonMcpServersTestErrorCodeSchema,
  DaemonMcpServersTestRequestSchema,
  DaemonMcpServersTestResponseSchema,
  DetectedMcpServerV1Schema,
  type DaemonMcpServersDetectRequest,
  type DaemonMcpServersDetectResponse,
  type DaemonMcpServersDetectWarningV1,
  type DaemonMcpServersTestErrorCode,
  type DaemonMcpServersTestRequest,
  type DaemonMcpServersTestResponse,
  type DetectedMcpServerV1,
  type McpDetectedProviderV1,
} from './mcpServers/daemonRpcV1.js';
export {
  DaemonFilesystemListDirectoryRequestSchema,
  DaemonFilesystemListDirectoryResponseSchema,
  DaemonFilesystemListRootsResponseSchema,
  MachineFileBrowserDirectoryEntrySchema,
  MachineFileBrowserRootSchema,
  type DaemonFilesystemListDirectoryRequest,
  type DaemonFilesystemListDirectoryResponse,
  type DaemonFilesystemListRootsResponse,
  type MachineFileBrowserDirectoryEntry,
  type MachineFileBrowserRoot,
} from './machineFileBrowser.js';

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
  SessionForkPointSchema,
  SessionForkRpcParamsSchema,
  SessionForkRpcResultSchema,
  SessionForkStrategySchema,
  type SessionForkPoint,
  type SessionForkRpcParams,
  type SessionForkRpcResult,
  type SessionForkStrategy,
} from './sessionFork.js';
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
export {
  INSTALLABLES_CATALOG,
  INSTALLABLE_KEYS,
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  type InstallableAutoUpdateMode,
  type InstallableCatalogEntry,
  type InstallableDefaultPolicy,
  type InstallableKey,
  type InstallableKind,
} from './installables.js';
export { applyInstallablePolicyOverride, resolveInstallablePolicy, type InstallablePolicyOverride } from './installablesPolicy.js';
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

export { SENT_FROM_VALUES, SentFromSchema, createSentFromSchema, type SentFrom } from './sentFrom.js';
export {
  AuthStatusEnvelopeSchema,
  AuthStatusResultSchema,
  SessionControlEnvelopeBaseSchema,
  SessionControlEnvelopeErrorSchema,
  SessionControlEnvelopeSuccessSchema,
  SessionControlErrorCodeSchema,
  SessionControlErrorSchema,
  SessionActionsDescribeEnvelopeSchema,
  SessionActionsDescribeResultSchema,
  SessionActionsListEnvelopeSchema,
  SessionActionsListResultSchema,
  SessionControlActionSpecSummarySchema,
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
  SessionRunStreamCancelEnvelopeSchema,
  SessionRunStreamCancelResultSchema,
  SessionRunStreamReadEnvelopeSchema,
  SessionRunStreamReadResultSchema,
  SessionRunStreamStartEnvelopeSchema,
  SessionRunStreamStartResultSchema,
  SessionRunWaitEnvelopeSchema,
  SessionRunWaitResultSchema,
  SessionSendEnvelopeSchema,
  SessionSendResultSchema,
  SessionStatusEnvelopeSchema,
  SessionStatusResultSchema,
  SessionStopEnvelopeSchema,
  SessionStopResultSchema,
  SessionShareSchema,
  V2SessionByIdNotFoundSchema,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
  V2SessionMessageResponseSchema,
  V2SessionRecordSchema,
  V2_SESSION_LIST_CURSOR_V1_PREFIX,
  decodeV2SessionListCursorV1,
  encodeV2SessionListCursorV1,
  SessionSummarySchema,
  SessionWaitEnvelopeSchema,
  SessionWaitResultSchema,
  type AuthStatusResult,
  type SessionActionsDescribeResult,
  type SessionActionsListResult,
  type SessionControlActionSpecSummary,
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
  type SessionRunStreamCancelResult,
  type SessionRunStreamReadResult,
  type SessionRunStreamStartResult,
  type SessionRunWaitResult,
  type SessionSendResult,
  type SessionStatusResult,
  type SessionStopResult,
  type SessionShare,
  type V2SessionByIdNotFound,
  type V2SessionByIdResponse,
  type V2SessionListResponse,
  type V2SessionMessageResponse,
  type V2SessionRecord,
  type SessionSummary,
  SessionMetadataSchema,
  type SessionMetadata,
  SessionSystemSessionV1Schema,
  type SessionSystemSessionV1,
  createSessionMetadataSchema,
  createSessionSystemSessionV1Schema,
  isHiddenSystemSession,
  readSystemSessionMetadataFromMetadata,
  buildSystemSessionMetadataV1,
  type SessionWaitResult,
} from './sessionControl/contract.js';

export {
  AcpConfiguredBackendV1Schema,
  type AcpConfiguredBackendV1,
  createAcpConfiguredBackendV1Schema,
  buildAcpConfiguredBackendV1,
  readAcpConfiguredBackendV1FromMetadata,
} from './sessionMetadata/acpConfiguredBackendV1.js';

export {
  ModelOverrideV1Schema,
  type ModelOverrideV1,
  createModelOverrideV1Schema,
  buildModelOverrideV1,
  AcpSessionModeOverrideV1Schema,
  type AcpSessionModeOverrideV1,
  createAcpSessionModeOverrideV1Schema,
  buildAcpSessionModeOverrideV1,
  AcpConfigOptionOverridesV1Schema,
  type AcpConfigOptionOverridesV1,
  createAcpConfigOptionOverridesV1Schema,
  buildAcpConfigOptionOverridesV1,
} from './sessionMetadata/metadataOverridesV1.js';

export {
  SessionTerminalMetadataSchema,
  type SessionTerminalMetadata,
  createSessionTerminalMetadataSchema,
} from './sessionMetadata/terminalMetadata.js';

export {
  WINDOWS_REMOTE_SESSION_LAUNCH_MODES,
  WindowsRemoteSessionLaunchModeSchema,
  type WindowsRemoteSessionLaunchMode,
} from './sessionMetadata/windowsRemoteSessionLaunchMode.js';

export {
  SESSION_PERMISSION_MODES,
  SessionPermissionModeSchema,
  type SessionPermissionMode,
  createSessionPermissionModeSchema,
} from './sessionMetadata/sessionPermissionModes.js';

export {
  SessionMessageMetaSchema,
  type SessionMessageMeta,
  createSessionMessageMetaSchema,
} from './sessionMessages/sessionMessageMeta.js';
export {
  ServerAddEnvelopeSchema,
  ServerAddResultSchema,
  ServerCurrentEnvelopeSchema,
  ServerCurrentResultSchema,
  ServerListEnvelopeSchema,
  ServerListResultSchema,
  ServerProfileSummarySchema,
  ServerRemoveEnvelopeSchema,
  ServerRemoveResultSchema,
  ServerSetEnvelopeSchema,
  ServerSetResultSchema,
  ServerTestEnvelopeSchema,
  ServerTestResultSchema,
  ServerUseEnvelopeSchema,
  ServerUseResultSchema,
  type ServerAddResult,
  type ServerCurrentResult,
  type ServerListResult,
  type ServerProfileSummary,
  type ServerRemoveResult,
  type ServerSetResult,
  type ServerTestResult,
  type ServerUseResult,
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
  ScmChangeDiscardEntrySchema,
  ScmChangeDiscardRequestSchema,
  ScmChangeDiscardResponseSchema,
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
  type ScmChangeDiscardEntry,
  type ScmChangeDiscardRequest,
  type ScmChangeDiscardResponse,
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
  ScmBranchCheckoutRequestSchema,
  ScmBranchCheckoutResponseSchema,
  ScmBranchCheckoutStrategySchema,
  ScmBranchCreateRequestSchema,
  ScmBranchCreateResponseSchema,
  ScmBranchListEntrySchema,
  ScmBranchListRequestSchema,
  ScmBranchListResponseSchema,
  ScmBranchTypeSchema,
  ScmRemotePublishRequestSchema,
  ScmRemotePublishResponseSchema,
  type ScmBranchCheckoutRequest,
  type ScmBranchCheckoutResponse,
  type ScmBranchCheckoutStrategy,
  type ScmBranchCreateRequest,
  type ScmBranchCreateResponse,
  type ScmBranchListEntry,
  type ScmBranchListRequest,
  type ScmBranchListResponse,
  type ScmBranchType,
  type ScmRemotePublishRequest,
  type ScmRemotePublishResponse,
} from './scmBranches.js';
export {
  ScmStashApplyRequestSchema,
  ScmStashApplyResponseSchema,
  ScmStashDropRequestSchema,
  ScmStashDropResponseSchema,
  ScmStashEntrySchema,
  ScmStashKindSchema,
  ScmStashListRequestSchema,
  ScmStashListResponseSchema,
  ScmStashPopRequestSchema,
  ScmStashPopResponseSchema,
  ScmStashShowRequestSchema,
  ScmStashShowResponseSchema,
  type ScmStashApplyRequest,
  type ScmStashApplyResponse,
  type ScmStashDropRequest,
  type ScmStashDropResponse,
  type ScmStashEntry,
  type ScmStashKind,
  type ScmStashListRequest,
  type ScmStashListResponse,
  type ScmStashPopRequest,
  type ScmStashPopResponse,
  type ScmStashShowRequest,
  type ScmStashShowResponse,
} from './scmStash.js';
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
  SessionUserMessageSendMetaSchema,
  SessionUserMessageSendRequestSchema,
  SessionUserMessageSendResponseSchema,
  type SessionUserMessageSendMeta,
  type SessionUserMessageSendRequest,
  type SessionUserMessageSendResponse,
} from './sessionUserMessageRpc.js';

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
  DaemonTerminalErrorCodeSchema,
  DaemonTerminalErrorSchema,
  DaemonTerminalEnsureRequestSchema,
  DaemonTerminalEnsureResponseSchema,
  DaemonTerminalStreamReadRequestSchema,
  DaemonTerminalStreamReadResponseSchema,
  DaemonTerminalStreamEventSchema,
  DaemonTerminalStreamEventDataSchema,
  DaemonTerminalStreamEventUrlSchema,
  DaemonTerminalStreamEventGapSchema,
  DaemonTerminalStreamEventExitSchema,
  DaemonTerminalInputRequestSchema,
  DaemonTerminalInputResponseSchema,
  DaemonTerminalResizeRequestSchema,
  DaemonTerminalResizeResponseSchema,
  DaemonTerminalCloseRequestSchema,
  DaemonTerminalCloseResponseSchema,
  DaemonTerminalRestartRequestSchema,
  DaemonTerminalRestartResponseSchema,
  type DaemonTerminalErrorCode,
  type DaemonTerminalError,
  type DaemonTerminalEnsureRequest,
  type DaemonTerminalEnsureResponse,
  type DaemonTerminalStreamReadRequest,
  type DaemonTerminalStreamReadResponse,
  type DaemonTerminalStreamEvent,
  type DaemonTerminalStreamEventData,
  type DaemonTerminalStreamEventUrl,
  type DaemonTerminalStreamEventGap,
  type DaemonTerminalStreamEventExit,
  type DaemonTerminalInputRequest,
  type DaemonTerminalInputResponse,
  type DaemonTerminalResizeRequest,
  type DaemonTerminalResizeResponse,
  type DaemonTerminalCloseRequest,
  type DaemonTerminalCloseResponse,
  type DaemonTerminalRestartRequest,
  type DaemonTerminalRestartResponse,
} from './daemonTerminal.js';

export {
  DirectSessionsProviderIdSchema,
  DirectSessionsSourceSchema,
  DirectSessionCandidateV1Schema,
  DirectSessionsCandidatesListRequestSchema,
  DirectSessionsCandidatesListResponseSchema,
  DirectSessionLinkEnsureRequestSchema,
  DirectSessionLinkEnsureResponseSchema,
  DirectSessionActivityV1Schema,
  DirectSessionStatusGetRequestSchema,
  DirectSessionStatusGetResponseSchema,
  DirectTranscriptRawMessageV1Schema,
  DirectTranscriptPageRequestSchema,
  DirectTranscriptPageResponseSchema,
  DirectTranscriptReadAfterRequestSchema,
  DirectTranscriptReadAfterResponseSchema,
  DirectSessionTakeoverRequestSchema,
  DirectSessionTakeoverResponseSchema,
  DirectSessionTakeoverPersistRequestSchema,
  DirectSessionTakeoverPersistResponseSchema,
  type DirectSessionsProviderId,
  type DirectSessionsSource,
  type DirectSessionCandidateV1,
  type DirectSessionsCandidatesListRequest,
  type DirectSessionsCandidatesListResponse,
  type DirectSessionLinkEnsureRequest,
  type DirectSessionLinkEnsureResponse,
  type DirectSessionActivityV1,
  type DirectSessionStatusGetRequest,
  type DirectSessionStatusGetResponse,
  type DirectTranscriptRawMessageV1,
  type DirectTranscriptPageRequest,
  type DirectTranscriptPageResponse,
  type DirectTranscriptReadAfterRequest,
  type DirectTranscriptReadAfterResponse,
  type DirectSessionTakeoverRequest,
  type DirectSessionTakeoverResponse,
  type DirectSessionTakeoverPersistRequest,
  type DirectSessionTakeoverPersistResponse,
} from './directSessions/daemonRpcV1.js';

export {
  SessionHandoffAbortRequestSchema,
  SessionHandoffAbortResponseSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffCommitResponseSchema,
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResponseSchema,
  SessionHandoffProviderBundleSchema,
  SessionHandoffStartRequestSchema,
  SessionHandoffStartResponseSchema,
  SessionHandoffStatusGetRequestSchema,
  SessionHandoffStatusSchema,
  SessionHandoffWorkspaceBundleSchema,
  MachineTransferReceiveEnvelopeSchema,
  MachineTransferSendEnvelopeSchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
  TransferStreamEnvelopeSchema,
  type SessionHandoffAbortRequest,
  type SessionHandoffAbortResponse,
  type SessionHandoffCommitRequest,
  type SessionHandoffCommitResponse,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResponse,
  type SessionHandoffProviderBundle,
  type SessionHandoffResumePlan,
  type SessionHandoffStartRequest,
  type SessionHandoffStartResponse,
  type SessionHandoffStatus,
  type SessionHandoffStatusGetRequest,
  type SessionHandoffStorageMode,
  type SessionHandoffTransportStrategy,
  type SessionHandoffWorkspaceBundle,
  type SessionHandoffWorkspaceBundleEntry,
  type SessionHandoffWorkspaceTransferPathSafety,
  type SessionHandoffWorkspaceTransferPathSafetyReasonCode,
  type SessionHandoffWorkspaceTransfer,
  type MachineTransferReceiveEnvelope,
  type MachineTransferSendEnvelope,
  type TransferEndpointCandidate,
  type TransferStreamEnvelope,
  evaluateSessionHandoffWorkspaceTransferSourcePathSafety,
} from './sessionControl/handoff/handoffRpc.js';

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
  LlmTaskRunnerConfigV1Schema,
  type LlmTaskRunnerConfigV1,
} from './llmTasks/llmTaskRunnerConfigV1.js';

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
  ParticipantRecipientV1Schema,
  ParticipantMessageV1Schema,
  parseParticipantMessageV1,
  type ParticipantRecipientV1,
  type ParticipantMessageV1,
} from './structuredMessages/participantMessageV1.js';

export {
  SubagentLaunchV1Schema,
  parseSubagentLaunchV1,
  type SubagentLaunchV1,
} from './structuredMessages/subagentLaunchV1.js';

export {
  SubagentCommandV1Schema,
  parseSubagentCommandV1,
  type SubagentCommandV1,
} from './structuredMessages/subagentCommandV1.js';

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
  MemoryStatusV1Schema,
  type MemoryStatusV1,
} from './memory/memoryStatus.js';

export {
  DEFAULT_MEMORY_SETTINGS,
  MemoryEmbeddingsBlendSchema,
  MemoryEmbeddingsCustomConfigSchema,
  MemoryEmbeddingsLocalTransformersConfigSchema,
  MemoryEmbeddingsModeSchema,
  MemoryEmbeddingsOpenAiCompatibleConfigSchema,
  MemoryEmbeddingsPresetIdSchema,
  MemoryBudgetsSettingsV1Schema,
  MemoryDeepSettingsV1Schema,
  MemoryEmbeddingsSettingsV1Schema,
  MemoryEmbeddingsSettingsV2Schema,
  MemoryHintsSettingsV1Schema,
  MemorySettingsV1Schema,
  MemoryWorkerSettingsV1Schema,
  normalizeMemoryEmbeddingsSettings,
  normalizeMemorySettings,
  type MemoryEmbeddingsBlend,
  type MemoryEmbeddingsCustomConfig,
  type MemoryEmbeddingsLocalTransformersConfig,
  type MemoryEmbeddingsMode,
  type MemoryEmbeddingsOpenAiCompatibleConfig,
  type MemoryEmbeddingsPresetId,
  type MemoryBudgetsSettingsV1,
  type MemoryDeepSettingsV1,
  type MemoryEmbeddingsSettingsV1,
  type MemoryEmbeddingsSettingsV2,
  type MemoryHintsSettingsV1,
  type MemorySettingsV1,
  type MemoryWorkerSettingsV1,
} from './memory/memorySettings.js';

export {
  MEMORY_EMBEDDINGS_PROFILE_REGISTRY,
  getMemoryEmbeddingsProfileMetadata,
  type MemoryEmbeddingsProfileMetadata,
} from './memory/memoryEmbeddingsProfiles.js';
export {
  resolveMemoryEmbeddingsConfig,
  type ResolvedMemoryEmbeddingsConfig,
} from './memory/resolveMemoryEmbeddingsConfig.js';

// Approvals (global inbox approvals queue)
export {
  ApprovalRequestCreatedBySchema,
  ApprovalRequestV1Schema,
  type ApprovalRequestCreatedBy,
  type ApprovalRequestV1,
} from './approvals/approvalRequestV1.js';

// Prompt library (prompt docs + bundles)
export {
  PromptFolderEntryV1Schema,
  PromptFoldersV1Schema,
  type PromptFolderEntryV1,
  type PromptFoldersV1,
} from './promptLibrary/promptFoldersV1.js';

export {
  PromptDocArtifactHeaderV1Schema,
  PromptDocBodyV1Schema,
  type PromptDocArtifactHeaderV1,
  type PromptDocBodyV1,
} from './promptLibrary/promptDocV2.js';

export {
  PROMPT_BUNDLE_SCHEMA_LIMITS_V1,
  PromptBundleBodyV1Schema,
  PromptBundleEntryV1Schema,
  PromptBundleSchemaIdV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
  type PromptBundleEntryV1,
  type PromptBundleSchemaIdV1,
  type PromptBundleValidationResult,
} from './promptLibrary/promptBundleSchemas.js';

export {
  computePromptBundleDigestV1,
  computePromptDocDigestV1,
} from './promptLibrary/promptLibraryDigests.js';

export {
  PromptExternalLinkEntryV1Schema,
  PromptExternalLinkSyncModeV1Schema,
  PromptExternalLinksV1Schema,
  type PromptExternalLinkEntryV1,
  type PromptExternalLinkSyncModeV1,
  type PromptExternalLinksV1,
} from './promptLibrary/promptExternalLinksV1.js';

export {
  PromptAssetBundleRecordV1Schema,
  PromptAssetCapabilitiesV1Schema,
  PromptAssetDefaultRootV1Schema,
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetDiscoverResponseV1Schema,
  PromptAssetDiscoveryItemV1Schema,
  PromptAssetExternalRefV1Schema,
  PromptAssetInstallModeV1Schema,
  PromptAssetLibraryKindV1Schema,
  PromptAssetListTypesResponseV1Schema,
  PromptAssetMutationErrorCodeV1Schema,
  PromptAssetMutationErrorResponseV1Schema,
  PromptAssetMutationPreviewV1Schema,
  PromptAssetMutationResponseV1Schema,
  PromptAssetMutationSuccessResponseV1Schema,
  PromptAssetReadRequestSchema,
  PromptAssetReadResponseV1Schema,
  PromptAssetScopeV1Schema,
  PromptAssetSupportsScopeV1Schema,
  PromptAssetTypeDescriptorV1Schema,
  PromptAssetWriteDocRequestSchema,
  PromptAssetWriteRequestSchema,
  PromptAssetWriteBundleRequestSchema,
  type PromptAssetBundleRecordV1,
  type PromptAssetCapabilitiesV1,
  type PromptAssetDocRecordV1,
  type PromptAssetDefaultRootV1,
  type PromptAssetDeleteRequest,
  type PromptAssetDiscoverRequest,
  type PromptAssetDiscoverResponseV1,
  type PromptAssetDiscoveryItemV1,
  type PromptAssetExternalRefV1,
  type PromptAssetInstallModeV1,
  type PromptAssetLibraryKindV1,
  type PromptAssetListTypesResponseV1,
  type PromptAssetMutationErrorCodeV1,
  type PromptAssetMutationPreviewV1,
  type PromptAssetMutationResponseV1,
  type PromptAssetReadRequest,
  type PromptAssetReadResponseV1,
  type PromptAssetScopeV1,
  type PromptAssetSupportsScopeV1,
  type PromptAssetTypeDescriptorV1,
  type PromptAssetWriteDocRequest,
  type PromptAssetWriteRequest,
  type PromptAssetWriteBundleRequest,
} from './promptLibrary/promptAssetsV1.js';
export {
  PromptRegistryAdapterDescriptorV1Schema,
  PromptRegistryConfiguredSourceV1Schema,
  PromptRegistryErrorCodeV1Schema,
  PromptRegistryErrorResponseV1Schema,
  PromptRegistryFetchItemRequestV1Schema,
  PromptRegistryFetchItemResponseV1Schema,
  PromptRegistryFetchedItemV1Schema,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  PromptRegistryInstallTargetV1Schema,
  PromptRegistryItemSummaryV1Schema,
  PromptRegistryListAdaptersResponseV1Schema,
  PromptRegistryListSourcesRequestV1Schema,
  PromptRegistryListSourcesResponseV1Schema,
  PromptRegistryScanSourceRequestV1Schema,
  PromptRegistryScanSourceResponseV1Schema,
  PromptRegistrySourceDescriptorV1Schema,
  PromptRegistrySourcesV1Schema,
  type PromptRegistryAdapterDescriptorV1,
  type PromptRegistryConfiguredSourceV1,
  type PromptRegistryErrorCodeV1,
  type PromptRegistryErrorResponseV1,
  type PromptRegistryFetchItemRequestV1,
  type PromptRegistryFetchItemResponseV1,
  type PromptRegistryFetchedItemV1,
  type PromptRegistryInstallRequestV1,
  type PromptRegistryInstallResponseV1,
  type PromptRegistryInstallTargetV1,
  type PromptRegistryItemSummaryV1,
  type PromptRegistryListAdaptersResponseV1,
  type PromptRegistryListSourcesRequestV1,
  type PromptRegistryListSourcesResponseV1,
  type PromptRegistryScanSourceRequestV1,
  type PromptRegistryScanSourceResponseV1,
  type PromptRegistrySourceDescriptorV1,
  type PromptRegistrySourcesV1,
} from './promptLibrary/promptRegistriesV1.js';

export {
  PromptPlacementV1Schema,
  type PromptPlacementV1,
} from './promptLibrary/promptPlacementV1.js';

export {
  PromptStackEditPolicyV1Schema,
  PromptStackEntryV1Schema,
  PromptStackRefV1Schema,
  PromptStacksV1Schema,
  type PromptStackEditPolicyV1,
  type PromptStackEntryV1,
  type PromptStackRefV1,
  type PromptStacksV1,
} from './promptLibrary/promptStacksV1.js';

export {
  PromptInvocationAvailabilityV1Schema,
  PromptInvocationBehaviorV1Schema,
  PromptInvocationEntryV1Schema,
  PromptInvocationTargetV1Schema,
  PromptInvocationsV1Schema,
  normalizePromptInvocationTokenV1,
  type PromptInvocationAvailabilityV1,
  type PromptInvocationBehaviorV1,
  type PromptInvocationEntryV1,
  type PromptInvocationTargetV1,
  type PromptInvocationsV1,
  type PromptInvocationTokenV1,
} from './promptLibrary/promptInvocationsV1.js';

// System prompt assembly (shared between UI + CLI)
export { buildAppendSystemPromptV1 } from './prompts/appendSystemPromptV1.js';
export { HAPPIER_BASE_SYSTEM_PROMPT_V1 } from './prompts/systemPromptBaseV1.js';
export {
  CHANGE_TITLE_INSTRUCTION_V1,
  buildChangeTitleInstructionV1,
  shouldAppendChangeTitleInstructionV1,
  type ChangeTitleInstructionV1Options,
} from './prompts/changeTitleInstructionV1.js';
export {
  buildExecutionRunsGuidanceBlockV1,
  normalizeExecutionRunsGuidanceFingerprintV1,
  type ExecutionRunsGuidanceEntryV1,
} from './prompts/executionRunsGuidanceV1.js';
export { buildAppendSystemPromptBaseV1 } from './prompts/buildAppendSystemPromptBaseV1.js';
export { buildMemoryRecallGuidanceBlockV1, type MemoryRecallGuidanceVariant } from './prompts/memoryRecallGuidanceV1.js';
export { resolvePromptStackSystemAppendBlocksV1 } from './promptLibrary/resolvePromptStackSystemAppendBlocksV1.js';

export * from './actions/index.js';

// Tool normalization (V2)
export * from './tools/happierToolsShellBridge.js';
export * from './tools/v2/index.js';

// Provider E2E specs (used by `@happier-dev/tests` to run real provider contract matrix)
export { E2eCliProviderSpecV1Schema, type E2eCliProviderSpecV1 } from './e2e/providerSpec.js';
export {
  E2eCliProviderScenarioRegistryV1Schema,
  type E2eCliProviderScenarioRegistryV1,
} from './e2e/providerScenarios.js';

// Diff helpers
export { splitUnifiedDiffByFile } from './diff/splitUnifiedDiffByFile.js';

// Push notifications (mobile)
export {
  PUSH_NOTIFICATION_ACTION_IDS,
  PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
  PUSH_NOTIFICATION_CATEGORY_IDS,
} from './push/pushNotificationActions.js';

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
  AccountEncryptionModeResponseSchema,
  AccountEncryptionModeUpdateRequestSchema,
  type AccountEncryptionModeResponse,
  type AccountEncryptionModeUpdateRequest,
} from './account/encryptionMode.js';

export {
  AccountEncryptionMigrateToModeSchema,
  AccountEncryptionMigrateKeyProofSchema,
  AccountEncryptionMigrateConnectedServicesDirectiveSchema,
  AccountEncryptionMigrateAutomationsDirectiveSchema,
  AccountEncryptionMigrateRequestSchema,
  AccountEncryptionMigrateSuccessResponseSchema,
  AccountEncryptionMigrateInvalidParamsReasonSchema,
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateForbiddenResponseSchema,
  AccountEncryptionMigrateNotFoundResponseSchema,
  AccountEncryptionMigrateConflictResponseSchema,
  AccountEncryptionMigrateInternalResponseSchema,
  AccountEncryptionMigrateAnyErrorResponseSchema,
  type AccountEncryptionMigrateToMode,
  type AccountEncryptionMigrateKeyProof,
  type AccountEncryptionMigrateConnectedServicesDirective,
  type AccountEncryptionMigrateAutomationsDirective,
  type AccountEncryptionMigrateRequest,
  type AccountEncryptionMigrateSuccessResponse,
  type AccountEncryptionMigrateInvalidParamsReason,
  type AccountEncryptionMigrateBadRequestResponse,
  type AccountEncryptionMigrateForbiddenResponse,
  type AccountEncryptionMigrateNotFoundResponse,
  type AccountEncryptionMigrateConflictResponse,
  type AccountEncryptionMigrateInternalResponse,
  type AccountEncryptionMigrateAnyErrorResponse,
} from './account/encryptionMigrate.js';

export {
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  AccountSettingsSchema,
  AccountSettingsStoredContentEnvelopeSchema,
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateRequestSchema,
  AccountSettingsV2UpdateResponseSchema,
  ForegroundBehaviorSchema,
  NotificationsSettingsV1Schema,
  DEFAULT_ACTIONS_SETTINGS_V1,
  DEFAULT_NOTIFICATIONS_SETTINGS_V1,
  accountSettingsParse,
  getNotificationsSettingsV1FromAccountSettings,
  type AccountSettings,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2GetResponse,
  type AccountSettingsV2UpdateRequest,
  type AccountSettingsV2UpdateResponse,
  type ForegroundBehavior,
  type NotificationsSettingsV1,
} from './account/settings/index.js';

export { ProfileBadgeSchema, type ProfileBadge } from './common/profileBadge.js';
export { AsyncTtlCache, type AsyncTtlCacheEntry } from './common/asyncTtlCache.js';
export {
  ProbedResourceCache,
  type ProbedResourcePhase,
  type ProbedResourceSnapshot,
} from './common/probedResourceCache.js';

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

export {
  DoctorSnapshotSchema,
  DoctorSnapshotServerProfileSchema,
  parseDoctorSnapshotSafe,
  sanitizeDoctorSnapshotUrls,
  type DoctorSnapshot,
  type DoctorSnapshotServerProfile,
} from './diagnostics/doctorSnapshot.js';

export {
  AIBackendProfileSchema,
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  EnvVarRequirementSchema,
  EnvironmentVariableSchema,
  SavedSecretSchema,
  getBuiltInBackendProfile,
  getRequiredConfigEnvVarNames,
  getMissingRequiredConfigEnvVarNames,
  getProfileEnvironmentVariables,
  getRequiredSecretEnvVarNames,
  getSecretSatisfaction,
  isProfileCompatibleWithBackendTarget,
  isProfileCompatibleWithAgent,
  resolveBackendProfile,
  type AIBackendProfile,
  type BackendProfileRefCandidate,
  type EnvVarRequirement,
  type EnvironmentVariable,
  type ResolveBackendProfileResult,
  type SavedSecret,
  type SecretSatisfactionItem,
  type SecretSatisfactionParams,
  type SecretSatisfactionResult,
  type SecretSatisfactionSource,
} from './profiles/index.js';
