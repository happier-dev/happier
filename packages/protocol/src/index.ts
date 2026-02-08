export const HAPPY_PROTOCOL_PACKAGE = '@happier-dev/protocol';

export { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorCode, type SpawnSessionResult } from './spawnSession.js';
export {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  isRpcMethodNotFoundResult,
  type RpcErrorCode,
  type RpcMethod,
} from './rpc.js';
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
  GIT_COMMIT_MESSAGE_MAX_LENGTH,
  GIT_OPERATION_ERROR_CODES,
  GitCommitCreateRequestSchema,
  GitCommitCreateResponseSchema,
  GitCommitRevertRequestSchema,
  GitCommitRevertResponseSchema,
  GitDiffCommitRequestSchema,
  GitDiffCommitResponseSchema,
  GitDiffFileModeSchema,
  GitDiffFileRequestSchema,
  GitDiffFileResponseSchema,
  GitEntryKindSchema,
  GitLogEntrySchema,
  GitLogListRequestSchema,
  GitLogListResponseSchema,
  GitOperationErrorCodeSchema,
  GitPatchApplyRequestSchema,
  GitPatchApplyResponseSchema,
  GitPathStatsSchema,
  GitRemoteRequestSchema,
  GitRemoteResponseSchema,
  GitStatusSnapshotRequestSchema,
  GitStatusSnapshotResponseSchema,
  GitWorkingEntrySchema,
  GitWorkingSnapshotSchema,
  type GitCommitCreateRequest,
  type GitCommitCreateResponse,
  type GitCommitRevertRequest,
  type GitCommitRevertResponse,
  type GitDiffCommitRequest,
  type GitDiffCommitResponse,
  type GitDiffFileMode,
  type GitDiffFileRequest,
  type GitDiffFileResponse,
  type GitEntryKind,
  type GitLogEntry,
  type GitLogListRequest,
  type GitLogListResponse,
  type GitOperationErrorCode,
  type GitPatchApplyRequest,
  type GitPatchApplyResponse,
  type GitPathStats,
  type GitRemoteRequest,
  type GitRemoteResponse,
  type GitStatusSnapshotRequest,
  type GitStatusSnapshotResponse,
  type GitWorkingEntry,
  type GitWorkingSnapshot,
} from './git.js';

export {
  VOICE_MEDIATOR_ERROR_CODES,
  VoiceMediatorAgentSourceSchema,
  VoiceMediatorPermissionPolicySchema,
  VoiceMediatorStartRequestSchema,
  VoiceMediatorStartResponseSchema,
  VoiceMediatorSendTurnRequestSchema,
  VoiceMediatorSendTurnResponseSchema,
  VoiceMediatorCommitRequestSchema,
  VoiceMediatorCommitResponseSchema,
  VoiceMediatorStopRequestSchema,
  VoiceMediatorStopResponseSchema,
  VoiceMediatorGetModelsRequestSchema,
  VoiceMediatorGetModelsResponseSchema,
  VoiceMediatorVerbositySchema,
  type VoiceMediatorErrorCode,
  type VoiceMediatorAgentSource,
  type VoiceMediatorPermissionPolicy,
  type VoiceMediatorVerbosity,
  type VoiceMediatorStartRequest,
  type VoiceMediatorStartResponse,
  type VoiceMediatorSendTurnRequest,
  type VoiceMediatorSendTurnResponse,
  type VoiceMediatorCommitRequest,
  type VoiceMediatorCommitResponse,
  type VoiceMediatorStopRequest,
  type VoiceMediatorStopResponse,
  type VoiceMediatorGetModelsRequest,
  type VoiceMediatorGetModelsResponse,
  type VoiceMediatorModel,
} from './voiceMediator.js';

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
export { FeaturesResponseSchema, type FeaturesResponse, OAuthProviderStatusSchema, type OAuthProviderStatus } from './features.js';
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
