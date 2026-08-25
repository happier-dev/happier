import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  AcpConfigOptionOverridesV1Schema,
  buildAcpConfigOptionOverridesV1,
  AccountSettingMutationV1Schema,
  BackendTargetRefV2Schema,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  derivePluginSessionInputLocalIdV1,
  MemorySearchResultV1Schema,
  MemoryWindowV1Schema,
  buildBackendTargetKeyV2,
  getActionSpec,
  RuntimeDescriptorV1Schema,
  PromptExternalLinksV1Schema,
  exportPromptLibraryArtifact,
  installPromptRegistryItemInLibrary,
  updatePromptBundleInLibrary,
  updatePromptDocInLibrary,
  SessionAgentSpawnPolicyV1Schema,
  SessionMcpSelectionV1Schema,
  SessionModelSelectionV1Schema,
  SessionModelSelectionResolutionError,
  SessionCreationCorrespondenceV1Schema,
  SessionCreationTargetPreparationResultV1Schema,
  SessionCreationDirectoryApprovalV1Schema,
  SessionAuthoringTerminalV1Schema,
  normalizeSessionCreationOrganizationPlacementV1,
  isSessionCreationCorrespondenceConflictSpawnErrorDetail,
  isSessionCreationOrganizationInvalidSpawnErrorDetail,
  supportsMachineOperationProtocolCapabilityV1,
  ProviderConnectionIdSchema,
  resolveExplicitSessionSpawnMachineTarget,
  resolveSessionModelSelectionInputRefV1,
  mergeSpawnConfigOptionAliases,
  parseBackendTargetKeyV2,
  readBackendTargetRefV2,
  readRuntimeDescriptorV1FromMetadata,
  resolveActionBackendTargetSelection,
  withExecutionRunStartFailureDetails,
  type ConnectedServiceBindingsV1,
  type SessionAgentSpawnPolicyV1,
  type SpawnConfigOptionValue,
  type SessionBridgeLifecycleHookEventIdV1,
  type SessionModelSelectionV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
  type ActionExecutorDeps,
  type ActionSurfaces,
  type BackendTargetRefV2,
  type ScmDiffSummaryGenerateInput,
  type PromptRegistryFetchedItemV1,
  type SessionSpawnNewInputV2,
  type SessionSpawnNewResultV1,
  type SessionCreationDirectoryApprovalV1,
  type SessionCreationTargetPreparationRequestV1,
  type SessionCreationTargetPreparationResultV1,
  type AgentExecutionTargetV1,
  type ActionCaller,
  type ComposerAttachmentInputV1,
} from '@happier-dev/protocol';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import {
  assertNonEscalatingPermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  resolvePermissionPrivilegeOrdinal,
} from '@happier-dev/protocol/actions/permissionPrivilege';
import { SpawnSessionTerminalSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  resolveCanonicalAgentIdFromFlavor,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readMachineOperationProtocolCapabilitiesV1 } from '@/api/machine/machineOperationProtocolCapabilities';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readSettings, type StoredCredentials } from '@/persistence';
import {
  createSpawnedSession,
  type DirectSpawnedSessionTransport,
  type ReplaySeededSessionCreationV1,
} from '@/session/services/createSpawnedSession';
import { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { resolveReplaySourceContextAuthority } from '@/session/replay/resolveReplaySourceContextAuthority';
import {
  resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import { getSessionEvents } from '@/session/services/getSessionEvents';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import { listSessions } from '@/session/services/listSessions';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { admitPluginSessionInputAttachmentsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import { notifyComposerAttachmentsAfterMessageAccepted } from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';
import {
  sendSessionMessage,
} from '@/session/services/sendSessionMessage';
import {
  buildSessionSpawnInitialInputAdmissionV1,
  buildPluginSessionInputAdmissionV1,
} from '@/session/services/sessionInputAdmissionIdentity';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import { setSessionModel } from '@/session/services/setSessionModel';
import { setSessionMode } from '@/session/services/setSessionMode';
import { setSessionPermissionMode } from '@/session/services/setSessionPermissionMode';
import { setSessionTitle } from '@/session/services/setSessionTitle';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { resolveCurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';

import type {
  SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  cancelExecutionRunStream,
  ensureExecutionRun,
  ensureOrStartExecutionRun,
  executeExecutionRunAction,
  getExecutionRun,
  listExecutionRuns,
  readExecutionRunStream,
  sendExecutionRunMessage,
  startExecutionRun,
  startExecutionRunStream,
  stopExecutionRun,
  waitForExecutionRun,
} from '@/session/services/executionRuns';
import { buildPluginInstallApprovalPreview } from '@/plugins/devLoop/installApprovalPreview';
import {
  normalizeExecutionRunWaitPollIntervalMs,
  normalizeExecutionRunWaitTimeoutMs,
} from '@/session/services/executionRunWaitTiming';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById, fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
  callMachineRpc,
  readMachineRpcRequestDisposition,
} from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
} from '@happier-dev/protocol/rpcErrors';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import {
  normalizeUsageLimitRecoveryOperationResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { executePluginSettingsAdministrationAction } from '@/plugins/settings/administration';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
  isConcreteBackendTargetCompatId,
} from '@/session/backendTargets/compat/customAcp';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveSessionAgentSpawnInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';
import {
  createRemoteDevSessionSpawnApprovalReplayNormalizer,
} from './approvals/normalizeRemoteDevSessionSpawnApprovalReplay';
import {
  readSessionAgentState,
  readSessionMetadata,
} from './cliActionDeps/sessionStateReaders';
import {
  HostSubagentStoreError,
  hostSubagentStore,
  type HostSubagentActor,
} from '@/session/subagents/hostSubagentStore';
import {
  resolveUsageLimitRecoveryEnabled,
  usageLimitRecoveryDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import {
  deletePromptAsset,
  discoverPromptAssets,
  writePromptAsset,
} from '@/prompts/assets/actions';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import {
  fetchPromptRegistryItem,
  installPromptRegistryItem,
  scanPromptRegistrySource,
} from '@/prompts/registries/actions';
import { createPluginPermissionGrantActionExecutor } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantActionExecutor';
import { createPluginWebhookActionExecutor } from '@/plugins/runtime/webhooks/pluginWebhookActionExecutor';
import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';
import {
  createAutomationEventActionExecutor,
  type ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerImmutableGeneration,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { executeScmDiffSummaryAction } from '@/scm/actions/executeScmDiffSummaryAction';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { executePluginExternalSessionAction } from './externalSessions/pluginExternalSessionActionExecutor';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  updateAccountSettingsV2WithRetry,
  type AccountSettingsMutationResult,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

type PromptExternalLinkPersistenceSettlement =
  | Readonly<{
    status: 'applied' | 'satisfied' | 'unchanged';
    version: number;
  }>
  | Readonly<{
    status: 'conflict';
    currentVersion: number;
  }>
  | Readonly<{
    status: 'outcomeUnknown';
    lastKnownVersion: number;
  }>
  | Readonly<{
    status: 'cancelled';
    submitted: false;
  }>
  | Readonly<{
    status: 'locked';
    reason: 'encryptionMaterialUnavailable' | 'modeMismatch' | 'contentUnreadable';
  }>
  | Readonly<{
    status: 'invalid';
    reason: 'unknownKey' | 'invalidValue' | 'duplicateKey' | 'tooLarge' | 'tooDeep';
  }>
  | Readonly<{
    status: 'unavailable';
    retryable: boolean;
  }>;

/**
 * The action response reports the independent Settings settlement without
 * ever exposing the Account Settings document that produced it.
 */
function projectPromptExternalLinkPersistenceSettlement(
  result: AccountSettingsMutationResult,
): PromptExternalLinkPersistenceSettlement {
  switch (result.status) {
    case 'applied':
    case 'satisfied':
    case 'unchanged':
      return Object.freeze({ status: result.status, version: result.version });
    case 'conflict':
      return Object.freeze({ status: result.status, currentVersion: result.currentVersion });
    case 'outcomeUnknown':
      return Object.freeze({ status: result.status, lastKnownVersion: result.lastKnownVersion });
    case 'cancelled':
      return Object.freeze({ status: result.status, submitted: result.submitted });
    case 'locked':
      return Object.freeze({ status: result.status, reason: result.reason });
    case 'invalid':
      return Object.freeze({ status: result.status, reason: result.reason });
    case 'unavailable':
      return Object.freeze({ status: result.status, retryable: result.retryable });
  }
}

function serializeHostSubagentStoreError(error: unknown): Readonly<{ ok: false; errorCode: string; error: string }> {
  if (error instanceof HostSubagentStoreError) {
    return { ok: false, errorCode: error.code, error: error.code };
  }
  throw error;
}

function deriveHostSubagentActor(caller: ActionCaller): HostSubagentActor {
  if (caller.kind !== 'plugin' || !caller.contributionLocalId?.trim()) {
    return { kind: 'externalRpc' };
  }
  return {
    kind: 'plugin',
    pluginId: caller.pluginId,
    agentId: caller.contributionLocalId,
  };
}

function normalizeStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function executionRunActionFailure(
  code: string,
  message?: string,
  details?: unknown,
): Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }> {
  return {
    ok: false,
    errorCode: code,
    error: message ?? code,
    ...(details !== undefined ? { details } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isExecutionRunActionAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || readRecord(error).name === 'AbortError';
}

function hasPossiblyAcceptedSpawnNonce(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return typeof details.spawnNonce === 'string' && details.spawnNonce.trim().length > 0;
}

/**
 * The Action surface consumes only the protocol-owned terminal detail, never
 * daemon/server wording. Direct daemon-control failures carry it at
 * `details.errorDetail`; the awaiter path nests the original response once.
 */
function hasSessionCreationOrganizationInvalidDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationOrganizationInvalidSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationOrganizationInvalidSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

function hasSessionCreationCorrespondenceConflictDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | undefined {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : undefined;
}

export type ResumeInactiveSessionWhenUsageLimitReady = (input: Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>) => Promise<boolean>;

export type ScheduleInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  recovery: SessionUsageLimitRecoveryV1;
  runCheckNow: () => Promise<unknown>;
}>) => Promise<void> | void;

export type CancelInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}>) => Promise<void> | void;

/**
 * Reads the current record from the inactive usage-limit recovery lifecycle owner so an
 * in-flight readiness probe can be fenced against a cancellation, exhaustion or replacement
 * that landed while it was running.
 */
export type ReadInactiveSessionUsageLimitRecovery = (input: Readonly<{
  sessionId: string;
}>) => SessionUsageLimitRecoveryV1 | null;

export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
}>) => Promise<unknown> | unknown;

export type RetryTemporaryThrottleNow = (input: Readonly<{
  sessionId: string;
}>) => Promise<unknown> | unknown;

/**
 * Host-private exact-daemon path used only after the public V2 Action owner
 * has admitted an already server-stamped request. It replaces transport, not
 * Session creation policy, normalization, or lifecycle ownership.
 */
export type SessionSpawnDirectTargetTransport = Readonly<{
  machineId: string;
  prepare: (
    request: SessionCreationTargetPreparationRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionCreationTargetPreparationResultV1>;
  spawnedSession: DirectSpawnedSessionTransport;
}>;

export type MachineActionDirectTargetTransport = Readonly<{
  machineId: string;
  invoke: (
    method: string,
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
}>;

type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readConfigOptionsRecord(value: unknown): Record<string, SpawnConfigOptionValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => (
    typeof entryValue === 'string'
    || typeof entryValue === 'number' && Number.isFinite(entryValue)
    || typeof entryValue === 'boolean'
    || entryValue === null
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
}

function hasExplicitString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExplicitValue(value: unknown): boolean {
  return value !== undefined;
}

function isSessionAgentSurface(surface: unknown): surface is 'agent' {
  return surface === 'agent';
}

function normalizeSessionAgentSpawnPolicy(raw: unknown): SessionAgentSpawnPolicyV1 {
  const parsed = SessionAgentSpawnPolicyV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
}

function resolveSpawnPolicyDeniedField(params: Readonly<{
  policy: SessionAgentSpawnPolicyV1;
  input: Readonly<{
    path?: unknown;
    directory?: unknown;
    host?: unknown;
    machineId?: unknown;
    serverId?: unknown;
    agentId?: unknown;
    backendTargetKey?: unknown;
    backendTarget?: unknown;
    modelId?: unknown;
    providerConnectionId?: unknown;
    permissionMode?: unknown;
    agentModeId?: unknown;
    sessionConfigOptionOverrides?: unknown;
    configOptions?: unknown;
    profileId?: unknown;
    environmentVariables?: unknown;
    connectedServices?: unknown;
    mcpSelection?: unknown;
    transcriptStorage?: unknown;
    runtimeDescriptorV1?: unknown;
  }>;
}>): string | null {
  const { policy, input } = params;
  if (!policy.allowCustomDirectory && hasExplicitString(input.path)) return 'path';
  if (!policy.allowCustomDirectory && hasExplicitString(input.directory)) return 'directory';
  if (!policy.allowCrossMachine && hasExplicitString(input.host)) return 'host';
  if (!policy.allowCrossMachine && hasExplicitString(input.machineId)) return 'machineId';
  if (!policy.allowCrossMachine && hasExplicitString(input.serverId)) return 'serverId';
  if (!policy.allowBackendTargetOverride && hasExplicitString(input.agentId)) return 'agentId';
  if (!policy.allowBackendTargetOverride && hasExplicitString(input.backendTargetKey)) return 'backendTargetKey';
  if (!policy.allowBackendTargetOverride && hasExplicitValue(input.backendTarget)) return 'backendTarget';
  if (!policy.allowBackendTargetOverride && hasExplicitValue(input.runtimeDescriptorV1)) return 'runtimeDescriptorV1';
  if (!policy.allowModelOverride && hasExplicitString(input.modelId)) return 'modelId';
  if (!policy.allowModelOverride && input.providerConnectionId !== undefined) return 'providerConnectionId';
  if (!policy.allowPermissionModeOverride && hasExplicitString(input.permissionMode)) return 'permissionMode';
  if (!policy.allowAgentModeOverride && hasExplicitString(input.agentModeId)) return 'agentModeId';
  if (!policy.allowConfigOptionOverrides && hasExplicitValue(input.sessionConfigOptionOverrides)) return 'sessionConfigOptionOverrides';
  if (!policy.allowConfigOptionOverrides && hasExplicitValue(input.configOptions)) return 'configOptions';
  if (!policy.allowProfileOverride && hasExplicitString(input.profileId)) return 'profileId';
  if (!policy.allowEnvironmentVariables && hasExplicitValue(input.environmentVariables)) return 'environmentVariables';
  if (!policy.allowConnectedServicesOverride && hasExplicitValue(input.connectedServices)) return 'connectedServices';
  if (!policy.allowMcpSelectionOverride && hasExplicitValue(input.mcpSelection)) return 'mcpSelection';
  if (!policy.allowTranscriptStorageOverride && hasExplicitValue(input.transcriptStorage)) return 'transcriptStorage';
  return null;
}

function permissionEscalationDetails(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Readonly<{
    reason: string;
    requestedMode: string;
    requestedOrdinal: number | null;
    callerMode: string;
    callerOrdinal: number;
  }>;
}>): Record<string, unknown> {
  return {
    surface: params.callerSurface ?? null,
    reason: params.decision.reason,
    requestedMode: params.decision.requestedMode,
    requestedOrdinal: params.decision.requestedOrdinal,
    callerMode: params.decision.callerMode,
    callerOrdinal: params.decision.callerOrdinal,
  };
}

function permissionEscalationActionResult(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Exclude<ReturnType<typeof assertNonEscalatingPermissionMode>, { ok: true }>;
}>): Readonly<{ ok: false; errorCode: string; error: string; details: Record<string, unknown> }> {
  return {
    ok: false,
    errorCode: params.decision.reason,
    error: params.decision.reason,
    details: permissionEscalationDetails(params),
  };
}

function permissionEscalationSpawnResult(params: Readonly<{
  callerSurface: keyof ActionSurfaces | null | undefined;
  decision: Exclude<ReturnType<typeof assertNonEscalatingPermissionMode>, { ok: true }>;
}>): Readonly<{
  type: 'error';
  errorCode: string;
  errorMessage: string;
  details: Record<string, unknown>;
}> {
  return {
    type: 'error',
    errorCode: params.decision.reason,
    errorMessage: params.decision.reason,
    details: permissionEscalationDetails(params),
  };
}

function applyPermissionCeiling(params: Readonly<{
  callerMode: string;
  permissionCeiling: SessionAgentSpawnPolicyV1['permissionCeiling'];
}>): string {
  if (!params.permissionCeiling) return params.callerMode;
  const callerOrdinal = resolvePermissionPrivilegeOrdinal(params.callerMode) ?? 1;
  const ceilingOrdinal = resolvePermissionPrivilegeOrdinal(params.permissionCeiling);
  if (ceilingOrdinal === null || ceilingOrdinal >= callerOrdinal) return params.callerMode;
  return params.permissionCeiling;
}

async function resolveSpawnConnectedServicesDefaultPayload(params: Readonly<{
  backendTarget: NonNullable<ReturnType<typeof readBackendTargetRefV2>>;
  credentials: StoredCredentials;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null> {
  if (params.backendTarget.sourceKind !== 'built_in') return null;
  // ONE defaulting owner (QA2-F02): session spawn and execution-run start resolve defaults
  // through the same fresh-bootstrap owner; no local settings-snapshot path.
  return await resolveSessionSpawnConnectedServicesDefaultsPayload({
    agentId: params.backendTarget.backendId,
    credentials: params.credentials,
  });
}

type PendingAgentRequestKind = 'permission' | 'user_action';

function permissionRequestNotFoundResult(sessionId: string) {
  return {
    ok: false,
    errorCode: 'permission_request_not_found',
    errorMessage: 'permission_request_not_found',
    sessionId,
  } as const;
}

function isKnownCompletedRequestId(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  requestId: string;
  kind: PendingAgentRequestKind;
}> & SessionStoredContentCryptoContext): boolean {
  const agentState = readSessionAgentState(params);
  const completedRequests = agentState?.completedRequests;
  if (!completedRequests || typeof completedRequests !== 'object' || Array.isArray(completedRequests)) {
    return false;
  }

  const completed = (completedRequests as Record<string, unknown>)[params.requestId];
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) {
    return false;
  }

  const requestKind = (completed as Record<string, unknown>).kind;
  if (params.kind === 'user_action') return requestKind === 'user_action';
  return requestKind === 'permission' || typeof requestKind === 'undefined';
}

export function createCliActionDeps(params: Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession?: Readonly<{
    metadata?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
  }> | null;
  getCallerPermissionMode?: (() => string | null | undefined) | null;
  getCurrentSessionBackendTarget?: (() => BackendTargetRefV2 | null | undefined) | null;
  happyHomeDir?: string;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
  isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  /**
   * Read at dispatch time so the plugin runtime's declared Composer attachments
   * are reachable from the Session-input writer. It is absent for hosts that
   * run no plugin runtime, in which case a declared attachment is refused
   * rather than dropped.
   */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
}> & SessionStoredContentCryptoContext): ActionExecutorDeps {
  const inventoryDeps = createCliActionInventoryDeps(params);
  const approvalsStore = params.credentials ? createCliApprovalsArtifactStore({ credentials: params.credentials }) : null;
  const pluginPermissionGrantAction = params.credentials
    ? createPluginPermissionGrantActionExecutor({ credentials: params.credentials })
    : null;
  const pluginWebhookAction = params.credentials
    ? createPluginWebhookActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
    })
    : null;
  const automationConversationAction = params.credentials
    ? createAutomationConversationActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerImmutableGeneration
        ? { revalidateCallerImmutableGeneration: params.revalidatePluginActionCallerImmutableGeneration }
        : {}),
    })
    : null;
  const automationEventAction = params.credentials && params.resolveAutomationEventAdoptedDefinitionSet
    ? createAutomationEventActionExecutor({
      credentials: params.credentials,
      resolveAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerImmutableGeneration
        ? { revalidateCallerImmutableGeneration: params.revalidatePluginActionCallerImmutableGeneration }
        : {}),
    })
    : null;
  const reviewCommentAction = params.credentials
    ? createCliReviewCommentActionExecutorFromCredentials({ credentials: params.credentials })
    : null;
  const promptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    ...(params.readRegisteredPromptAssetAdapters
      ? { readRegisteredAdapters: params.readRegisteredPromptAssetAdapters }
      : {}),
  });
  const promptRegistryAdapterRegistry = createPromptRegistryAdapterRegistry();
  let currentSessionMetadata = readSessionMetadata({
    ...params,
    rawSession: params.rawSession,
  });
  type ResolvedSessionTransport = Extract<
    Awaited<ReturnType<typeof resolveSessionTransportContext>>,
    Readonly<{ ok: true }>
  >;
  type LifecycleHookSessionContext = Readonly<{
    machineId?: string;
    cwd?: string;
    workspaceId?: string;
  }>;

  const sessionTransportCache = new Map<string, ResolvedSessionTransport>();
  const ambiguousSpawnActionRequestIds = new Set<string>();
  const callMachineAction = async (input: Readonly<{
    machineId: string;
    method: string;
    request: unknown;
    signal?: AbortSignal;
  }>): Promise<unknown> => {
    const direct = params.machineActionDirectTargetTransport;
    if (direct?.machineId === input.machineId) {
      return await direct.invoke(
        input.method,
        input.request,
        input.signal ? { signal: input.signal } : undefined,
      );
    }
    return await callMachineRpc({
      credentials: params.credentials!,
      machineId: input.machineId,
      method: input.method,
      request: input.request,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };

  const readCurrentSessionMetadata = async (): Promise<Record<string, unknown> | null> => {
    if (currentSessionMetadata) return currentSessionMetadata;

    try {
      const rawSession = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
      currentSessionMetadata = readSessionMetadata({
        ...params,
        rawSession,
      });
      return currentSessionMetadata;
    } catch {
      currentSessionMetadata = null;
      return null;
    }
  };

  const readValidPermissionMode = (value: unknown): string | null => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized && parsePermissionIntentAlias(normalized) ? normalized : null;
  };

  const resolveCallerPermissionMode = async (explicit: unknown): Promise<string> => {
    const explicitMode = readValidPermissionMode(explicit);
    if (explicitMode) return explicitMode;
    const liveMode = readValidPermissionMode(params.getCallerPermissionMode?.());
    if (liveMode) return liveMode;
    const metadata = await readCurrentSessionMetadata();
    return resolvePermissionIntentFromSessionMetadata(metadata)?.intent ?? 'default';
  };

  const resolveCurrentSessionValue = async (key: 'path' | 'host' | 'machineId'): Promise<string | null> => {
    const rawValue = params.rawSession?.[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }

    const metadata = await readCurrentSessionMetadata();
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };

  let currentMachineControlIdentityPromise: Promise<CurrentMachineControlIdentity> | null = null;

  const readCurrentMachineControlIdentity = async (): Promise<CurrentMachineControlIdentity> => {
    currentMachineControlIdentityPromise ??= (async () => {
      let machineId: string | null = null;
      try {
        machineId = normalizeStringValue((await readSettings()).machineId);
      } catch {
        machineId = null;
      }

      let host: string | null = null;
      try {
        host = normalizeStringValue(await getPreferredHostName());
      } catch {
        host = null;
      }

      return {
        machineId,
        host,
        homeDir: normalizeStringValue(homedir()),
      };
    })();
    return await currentMachineControlIdentityPromise;
  };

  const resolveSessionSpawnAgentTarget = (agentTarget: AgentExecutionTargetV1) => {
    const catalog = readAgentCatalogSnapshot();
    const agentContribution = [...catalog.agentDefinitionsById.values()].find(
      (candidate) => candidate.identity?.pluginId === agentTarget.identity.pluginId
        && candidate.identity.localId === agentTarget.identity.localId,
    );
    if (!agentContribution) return null;

    try {
      return {
        agentId: agentContribution.id,
        backendTarget: readBackendTargetRefV2({
          kind: 'backend',
          backendId: agentContribution.id,
          sourceKind: 'built_in',
        }),
      };
    } catch {
      return null;
    }
  };

  const resolveSessionSpawnAgentInventorySelection: NonNullable<
    ActionExecutorDeps['resolveSessionSpawnAgentInventorySelection']
  > = ({ agentTarget }) => {
    const resolvedTarget = resolveSessionSpawnAgentTarget(agentTarget);
    return resolvedTarget
      ? {
          agentId: resolvedTarget.agentId,
          backendTargetKey: buildBackendTargetKeyV2(resolvedTarget.backendTarget),
        }
      : null;
  };

  const normalizeSessionSpawnNewLegacyApprovalReplay =
    createRemoteDevSessionSpawnApprovalReplayNormalizer({
      readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values(),
      readLocalMachineIdentity: async () => {
        const current = await readCurrentMachineControlIdentity();
        return { machineId: current.machineId, host: current.host };
      },
    });

  const requireLocalPromptActionMachine = async (machineId: string): Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>> => {
    const current = await readCurrentMachineControlIdentity();
    return current.machineId === machineId
      ? { ok: true }
      : { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
  };

  const readPromptExternalLinks = async (): Promise<
    | Readonly<{ status: 'valid'; value: ReturnType<typeof PromptExternalLinksV1Schema.parse> }>
    | Readonly<{ status: 'invalid' }>
    | ReturnType<typeof notSupported>
  > => {
    if (!params.credentials) return notSupported();
    const context = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      refresh: 'force',
    });
    const persisted = context.rawSettings ?? context.settings;
    if (!Object.hasOwn(persisted, 'promptExternalLinksV1')) {
      return { status: 'valid', value: { v: 1, links: [] } };
    }
    const parsed = PromptExternalLinksV1Schema.safeParse(persisted.promptExternalLinksV1);
    return parsed.success
      ? { status: 'valid', value: parsed.data }
      : { status: 'invalid' };
  };

  const persistPromptExternalLink = async (
    nextLinks: ReturnType<typeof PromptExternalLinksV1Schema.parse> | undefined,
    sourceWasInvalid: boolean,
    signal?: AbortSignal,
  ): Promise<PromptExternalLinkPersistenceSettlement | undefined> => {
    const nextLink = nextLinks?.links.at(-1);
    if (!nextLink) return undefined;
    if (sourceWasInvalid) {
      return Object.freeze({ status: 'invalid', reason: 'invalidValue' });
    }
    if (!params.credentials) {
      return Object.freeze({ status: 'unavailable' as const, retryable: false });
    }
    try {
      const mutation = AccountSettingMutationV1Schema.parse({
        operations: [{
          op: 'set',
          key: 'promptExternalLinksV1',
          value: nextLinks,
        }],
      });
      const result = await updateAccountSettingsV2WithRetry({
        credentials: params.credentials,
        signal,
        mutation,
      });
      return projectPromptExternalLinkPersistenceSettlement(result);
    } catch {
      // The artifact operation has already succeeded. Preserve that success
      // and report only the independent link-persistence settlement.
      return Object.freeze({ status: 'unavailable' as const, retryable: false });
    }
  };

  const resolveTransportForSession = async (idOrPrefix: string): Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>> => {
    if (!params.credentials) {
      return { ok: false, code: 'not_authenticated' };
    }

    const normalized = String(idOrPrefix ?? '').trim();
    if (!normalized) {
      return { ok: false, code: 'session_not_found' };
    }
    const cachedTransport = sessionTransportCache.get(normalized);
    if (cachedTransport) return cachedTransport;

    const resolved = await resolveSessionTransportContext({ credentials: params.credentials, idOrPrefix: normalized });
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }

    const cached: ResolvedSessionTransport = resolved;
    sessionTransportCache.set(resolved.sessionId, cached);
    // If the input is already a full id, also cache by that literal.
    sessionTransportCache.set(normalized, cached);
    return cached;
  };

  const resumeInactiveSessionTransport = async (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    signal?: AbortSignal;
    waitForReady?: boolean;
  }>) => {
    if (input.transport.rawSession.active === true) {
      return { ok: true } as const;
    }
    if (!params.credentials) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Inactive session resume requires authentication',
      } as const;
    }
    const metadata = readSessionMetadata({
      ...input.transport,
      rawSession: input.transport.rawSession,
    }) ?? {};
    return await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId: input.transport.sessionId,
      localId: input.localId,
      rawSession: input.transport.rawSession,
      metadata,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.waitForReady === true ? { waitForReady: true } : {}),
    });
  };

  type ExecutionRunActionTransportOptions = Readonly<{
    serverId?: string | null;
    originSessionId?: string | null;
    targetMachineId?: string | null;
    exactMachineId?: string | null;
    signal?: AbortSignal;
  }>;
  type ExecutionRunMachineTarget =
    | Readonly<{ ok: true; machineId: string }>
    | Readonly<{ ok: false; errorCode: 'execution_run_target_not_selected' | 'execution_run_target_unavailable' }>;

  /**
   * Scope selection is authoritative before this point. This only resolves the
   * already-selected Session's daemon (or the caller's current device outside
   * a Session); it never scans, falls back, or accepts a machine id from Action
   * input.
   */
  const resolveExecutionRunMachineTarget = async (
    sessionId: string | null,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<ExecutionRunMachineTarget> => {
    const preflightMachineId = normalizeStringValue(opts?.exactMachineId);
    if (preflightMachineId) return { ok: true, machineId: preflightMachineId };

    // A bound host admits this target before Action dispatch. It is neither
    // mutable Action input nor a fallback candidate: V2 capability preflight
    // must interrogate this exact daemon before the resulting exactMachineId
    // pins every later control.
    const admittedMachineId = normalizeStringValue(opts?.targetMachineId);
    if (admittedMachineId) return { ok: true, machineId: admittedMachineId };

    const originSessionId = normalizeStringValue(opts?.originSessionId);
    const ownSessionId = params.sessionId !== 'cli-global' && params.sessionId !== 'plugin-global'
      ? normalizeStringValue(params.sessionId)
      : null;
    const targetSessionId = sessionId ?? originSessionId ?? ownSessionId;

    if (targetSessionId) {
      const transport = await resolveTransportForSession(targetSessionId);
      if (!transport.ok) return { ok: false, errorCode: 'execution_run_target_unavailable' };
      const metadata = readSessionMetadata({ ...transport, rawSession: transport.rawSession });
      const machineId = normalizeStringValue(transport.rawSession.machineId)
        ?? normalizeStringValue(metadata?.machineId);
      return machineId
        ? { ok: true, machineId }
        : { ok: false, errorCode: 'execution_run_target_unavailable' };
    }

    const local = await readCurrentMachineControlIdentity();
    return local.machineId
      ? { ok: true, machineId: local.machineId }
      : { ok: false, errorCode: 'execution_run_target_not_selected' };
  };

  const callDetachedExecutionRunRpc = async (
    sessionId: string | null,
    method: string,
    request: unknown,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<unknown> => {
    const isStart = method === SESSION_RPC_METHODS.EXECUTION_RUN_START;
    const failure = (code: string, runCreation: 'noRunCreated' | 'outcomeUnknown', message?: string) => (
      executionRunActionFailure(
        code,
        message,
        isStart ? withExecutionRunStartFailureDetails(undefined, runCreation) : undefined,
      )
    );
    if (!params.credentials) {
      return failure('not_authenticated', 'noRunCreated');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return failure(target.errorCode, 'noRunCreated');
    try {
      return await callMachineRpc({
        credentials: params.credentials,
        machineId: target.machineId,
        method,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      const runCreation = readMachineRpcRequestDisposition(error) === 'notSent'
        ? 'noRunCreated'
        : 'outcomeUnknown';
      if (isExecutionRunActionAbort(error, opts?.signal)) {
        return failure('cancelled', runCreation);
      }
      return failure('execution_run_target_unavailable', runCreation);
    }
  };

  const readExecutionRunProtocolV2 = async (
    sessionId: string | null,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<
    | Readonly<{ ok: true; exactMachineId: string }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > => {
    if (!params.credentials) {
      return executionRunActionFailure('not_authenticated');
    }
    if (opts?.signal?.aborted) {
      return executionRunActionFailure('cancelled');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return executionRunActionFailure(target.errorCode);
    try {
      const response = await callMachineRpc({
        credentials: params.credentials,
        machineId: target.machineId,
        method: RPC_METHODS.CAPABILITIES_DETECT,
        request: { requests: [{ id: 'tool.executionRuns' }] },
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const result = readRecord(readRecord(response).results)['tool.executionRuns'];
      const data = readRecord(readRecord(result).data);
      const features = readRecord(data.features);
      if (
        readRecord(result).ok !== true
        || data.protocolVersion !== 2
        || features.detachedScope !== true
        || features.startAndWait !== true
      ) {
        return executionRunActionFailure('execution_run_protocol_unsupported');
      }
      return { ok: true, exactMachineId: target.machineId };
    } catch (error) {
      if (isExecutionRunActionAbort(error, opts?.signal)) {
        return executionRunActionFailure('cancelled');
      }
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return executionRunActionFailure('execution_run_protocol_unsupported');
      }
      return executionRunActionFailure('execution_run_target_unavailable');
    }
  };

  const callSessionRpcForTransport = async (
    transport: ResolvedSessionTransport,
    methodSuffix: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    try {
      return await callSessionRpc({
        ...transport,
        token: params.credentials.token,
        sessionId: transport.sessionId,
        method: `${transport.sessionId}:${methodSuffix}`,
        request,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const errorCode = readRpcErrorCode(error) ?? 'session_rpc_failed';
      return {
        ok: false,
        errorCode,
        error: errorCode,
        errorMessage: error instanceof Error ? error.message : errorCode,
        sessionId: transport.sessionId,
      };
    }
  };

  const normalizeLifecycleHookSessionContext = (context: Readonly<{
    machineId?: unknown;
    cwd?: unknown;
    workspaceId?: unknown;
  }>): LifecycleHookSessionContext => {
    const machineId = normalizeStringValue(context.machineId);
    const cwd = normalizeStringValue(context.cwd);
    const workspaceId = normalizeStringValue(context.workspaceId);
    return {
      ...(machineId ? { machineId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  };

  const resolveLifecycleHookSessionContext = async (event: Readonly<{
    happySessionId: string;
    exactSessionContext?: LifecycleHookSessionContext;
  }>): Promise<LifecycleHookSessionContext> => {
    if (event.exactSessionContext !== undefined) {
      return normalizeLifecycleHookSessionContext(event.exactSessionContext);
    }

    if (event.happySessionId === params.sessionId) {
      const metadata = await readCurrentSessionMetadata();
      return normalizeLifecycleHookSessionContext({
        machineId: await resolveCurrentSessionValue('machineId'),
        cwd: await resolveCurrentSessionValue('path'),
        workspaceId: metadata?.workspaceId,
      });
    }

    try {
      const transport = await resolveTransportForSession(event.happySessionId);
      if (!transport.ok) return {};
      const metadata = readSessionMetadata({
        ...transport,
        rawSession: transport.rawSession,
      });
      return normalizeLifecycleHookSessionContext({
        machineId: normalizeStringValue(transport.rawSession.machineId) ?? metadata?.machineId,
        cwd: normalizeStringValue(transport.rawSession.path) ?? metadata?.path,
        workspaceId: metadata?.workspaceId,
      });
    } catch {
      return {};
    }
  };

  const dispatchSessionLifecycleHookEvent = async (event: Readonly<{
    eventId: SessionBridgeLifecycleHookEventIdV1;
    happySessionId: string;
    backendTarget?: string;
    exactSessionContext?: LifecycleHookSessionContext;
    payload: Record<string, unknown>;
  }>): Promise<void> => {
    const happyHomeDir = typeof params.happyHomeDir === 'string' && params.happyHomeDir.trim().length > 0
      ? params.happyHomeDir.trim()
      : null;
    if (!happyHomeDir) {
      return;
    }
    const sessionContext = await resolveLifecycleHookSessionContext(event);

    await getSessionHostBridge().emitLifecycleHookEvent({
      happyHomeDir,
      eventId: event.eventId,
      happySessionId: event.happySessionId,
      ...sessionContext,
      ...(event.backendTarget ? { backendTarget: event.backendTarget } : {}),
      payload: event.payload,
    });
  };

  const callResolvedSessionRpc = async (
    sessionId: string,
    method: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
    }
    return await callSessionRpcForTransport(transport, method, request, signal);
  };

  const isUsageLimitRecoveryEnabled = async (): Promise<boolean> => {
    if (typeof params.isUsageLimitRecoveryEnabled === 'function') {
      return await params.isUsageLimitRecoveryEnabled();
    }
    return await resolveUsageLimitRecoveryEnabled();
  };

  const callRoutedSessionGoalControl = async (
    sessionId: string,
    operation: 'get' | 'set' | 'clear',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readSessionMetadata({
      ...transport,
      rawSession: transport.rawSession,
    });
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    return await routeSessionGoalControl({
      ...transport,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      operation,
      ...(operation === 'set' ? { request } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        operation === 'get'
          ? SESSION_RPC_METHODS.SESSION_GOAL_GET
          : operation === 'clear'
            ? SESSION_RPC_METHODS.SESSION_GOAL_CLEAR
            : SESSION_RPC_METHODS.SESSION_GOAL_SET,
        request,
      ),
    });
  };

  const callRoutedSessionCatalogControl = async (
    sessionId: string,
    operation: 'vendorPlugins' | 'skills',
    request: Readonly<{ cwd?: string }>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: 'not_authenticated' }
        : { unsupported: true, skills: [], diagnostic: 'not_authenticated' };
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: transport.code }
        : { unsupported: true, skills: [], diagnostic: transport.code };
    }

    const metadata = readSessionMetadata({
      ...transport,
      rawSession: transport.rawSession,
    });
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    const method = operation === 'vendorPlugins'
      ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST
      : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
    const rpcRequest = {
      ...(typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? { cwd: request.cwd.trim() } : {}),
    };
    return await routeSessionCatalogControl({
      ...transport,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      operation,
      ...('cwd' in rpcRequest ? { cwd: rpcRequest.cwd } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        method,
        rpcRequest,
      ),
    });
  };

  const callRoutedUsageLimitRecoveryControl = async (
    sessionId: string,
    operation: 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow' | 'consumeResetCredit',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readSessionMetadata({
      ...transport,
      rawSession: transport.rawSession,
    });
    if (transport.rawSession.active === true) {
      return normalizeUsageLimitRecoveryOperationResult(await callSessionRpcForTransport(
        transport,
        operation === 'enable'
          ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
          : operation === 'cancel'
            ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
            : operation === 'consumeResetCredit'
              ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
              : SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        request,
      ), { sessionId: transport.sessionId });
    }

    const rawMachineId = normalizeStringValue(transport.rawSession.machineId);
    const metadataMachineId = normalizeStringValue(metadata?.machineId);
    if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_mismatch',
        error: 'session_usage_limit_recovery_control_target_machine_mismatch',
      }, { sessionId: transport.sessionId });
    }
    const machineId = rawMachineId ?? metadataMachineId;
    if (!machineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }

    const method = operation === 'enable'
      ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
      : operation === 'cancel'
        ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
        : operation === 'consumeResetCredit'
          ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
          : RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW;
    try {
      return normalizeUsageLimitRecoveryOperationResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method,
        request,
      }), { sessionId: transport.sessionId });
    } catch {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }
  };

  const executeSessionBoundScmAction: NonNullable<ActionExecutorDeps['scmActionExecute']> = async ({
    actionId,
    input,
    context,
    executeCanonicalAction,
  }) => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Readonly<Record<string, unknown>>
      : {};
    if (actionId === 'scm.reviewWorkspace.materializePrepared') {
      const selectedRoot = normalizeStringValue(inputRecord.cwd);
      if (!selectedRoot) {
        return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
      }
      return await executeScmActionOperation({
        actionId,
        input: inputRecord,
        workingDirectory: selectedRoot,
        accessPolicy: { kind: 'restrictedRoots', roots: [selectedRoot] },
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    const sessionId = normalizeStringValue(context.defaultSessionId);
    if (!sessionId) {
      return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    }
    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code };
    }

    const metadata = readSessionMetadata({
      ...transport,
      rawSession: transport.rawSession,
    });
    const persistedWorkingDirectory = normalizeStringValue(transport.rawSession.path)
      ?? normalizeStringValue(metadata?.path);
    if (!persistedWorkingDirectory) {
      return {
        ok: false,
        errorCode: 'scm_action_worktree_unavailable',
        error: 'scm_action_worktree_unavailable',
      };
    }

    const currentMachine = await readCurrentMachineControlIdentity();
    const workingDirectory = metadata
      ? resolveSessionMachineWorkspacePath({
          metadata,
          currentMachineId: currentMachine.machineId,
          candidatePath: persistedWorkingDirectory,
        }) ?? persistedWorkingDirectory
      : persistedWorkingDirectory;
    const sessionMachineId = normalizeStringValue(transport.rawSession.machineId)
      ?? normalizeStringValue(metadata?.machineId);
    const sessionHost = normalizeStringValue(transport.rawSession.host)
      ?? normalizeStringValue(metadata?.host);
    const machineMismatch = Boolean(
      sessionMachineId
      && currentMachine.machineId
      && sessionMachineId !== currentMachine.machineId,
    );
    const hostMismatch = Boolean(
      !sessionMachineId
      && sessionHost
      && currentMachine.host
      && sessionHost !== currentMachine.host,
    );
    if (machineMismatch || hostMismatch) {
      return {
        ok: false,
        errorCode: 'scm_action_session_not_local',
        error: 'scm_action_session_not_local',
      };
    }

    const sessionBoundInput = actionId === 'scm.repository.clone'
      ? inputRecord
      : actionId === 'scm.pullRequest.prepareWorktree'
        ? { ...inputRecord, cwd: workingDirectory, sourcePath: workingDirectory }
        : { ...inputRecord, cwd: workingDirectory };
    const backendTarget = (() => {
      if (actionId !== 'scm.diffSummary.generate') return null;
      const selector = sessionBoundInput.modelSelector;
      const selectorRecord = selector && typeof selector === 'object' && !Array.isArray(selector)
        ? selector as Readonly<Record<string, unknown>>
        : {};
      const targetKey = normalizeStringValue(selectorRecord.backendTargetKey);
      if (targetKey) {
        try {
          return parseBackendTargetKeyV2(targetKey);
        } catch {
          return null;
        }
      }
      return resolveBackendTargetFromSessionMetadata(metadata);
    })();

    return await executeScmActionOperation({
      actionId,
      input: sessionBoundInput,
      workingDirectory,
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      ...(context.signal ? { signal: context.signal } : {}),
      executeDiffSummary: async ({ request }) => await executeScmDiffSummaryAction({
        request: request as ScmDiffSummaryGenerateInput,
        backendTarget,
        executeCanonicalAction,
      }),
    });
  };

  type SessionSpawnTargetPreparation =
    | Readonly<{
        ok: true;
        preparedTarget: Extract<
          SessionCreationTargetPreparationResultV1,
          Readonly<{ ok: true }>
        >;
      }>
    | Readonly<{
        ok: false;
        result: Extract<SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;
      }>;

  /**
   * A direct transport is installed only by the authenticated exact-machine
   * receiver. Once that receiver has selected this daemon, its local profile
   * id is not an Account-routing identity: retain the portable server id in
   * the Action input and approval artifact instead of comparing it to that
   * profile-local value.
   */
  const isCurrentSessionSpawnExecutionTarget = (executionTarget: Readonly<{
    serverId: string;
    machineId: string;
  }>): boolean => {
    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (directTargetTransport?.machineId === executionTarget.machineId) {
      return true;
    }
    const activeServerId = String(configuration.activeServerId ?? '').trim();
    return Boolean(activeServerId && executionTarget.serverId === activeServerId);
  };

  /**
   * One exact-target bridge to the daemon-owned preparation RPC. Both the
   * Action approval probe and the eventual V2 spawn consume this owner; no
   * caller resolves a remote path or synthesizes its directory state.
   */
  const prepareSessionSpawnTarget = async (input: Readonly<{
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    directory: string;
    checkoutCreationDraft?: SessionCreationTargetPreparationRequestV1['checkoutCreationDraft'];
    signal?: AbortSignal;
  }>): Promise<SessionSpawnTargetPreparation> => {
    if (!params.credentials) {
      return {
        ok: false,
        result: { type: 'error', code: 'permission_denied', retryable: false },
      };
    }
    if (input.signal?.aborted) {
      return {
        ok: false,
        result: { type: 'error', code: 'cancelled', retryable: true },
      };
    }

    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (
      directTargetTransport
      && directTargetTransport.machineId !== input.executionTarget.machineId
    ) {
      return {
        ok: false,
        result: { type: 'error', code: 'target_unavailable', retryable: false },
      };
    }

    let rawPreparedTarget: unknown;
    try {
      rawPreparedTarget = directTargetTransport
        ? await directTargetTransport.prepare(
          {
            directory: input.directory,
            ...(input.checkoutCreationDraft !== undefined
              ? { checkoutCreationDraft: input.checkoutCreationDraft }
              : {}),
          },
          input.signal ? { signal: input.signal } : undefined,
        )
        : await callMachineAction({
            machineId: input.executionTarget.machineId,
            method: RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
            request: {
              directory: input.directory,
              ...(input.checkoutCreationDraft !== undefined
                ? { checkoutCreationDraft: input.checkoutCreationDraft }
                : {}),
            },
            ...(input.signal ? { signal: input.signal } : {}),
          });
    } catch (error) {
      if (input.signal?.aborted) {
        return {
          ok: false,
          result: { type: 'error', code: 'cancelled', retryable: true },
        };
      }
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return {
          ok: false,
          result: { type: 'error', code: 'incompatible_target', retryable: false },
        };
      }
      if (isAuthenticationError(error)) {
        return {
          ok: false,
          result: { type: 'error', code: 'permission_denied', retryable: false },
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'machine_offline', retryable: true },
      };
    }

    const preparedTarget = SessionCreationTargetPreparationResultV1Schema.safeParse(rawPreparedTarget);
    if (!preparedTarget.success) {
      return {
        ok: false,
        result: { type: 'error', code: 'incompatible_target', retryable: false },
      };
    }
    if (!preparedTarget.data.ok) {
      if (preparedTarget.data.code === 'invalid_directory') {
        return {
          ok: false,
          result: { type: 'error', code: 'invalid_input', retryable: false },
        };
      }
      if (preparedTarget.data.code === 'checkout_unavailable') {
        return {
          ok: false,
          result: { type: 'error', code: 'incompatible_target', retryable: false },
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'spawn_failed', retryable: true },
      };
    }
    return { ok: true, preparedTarget: preparedTarget.data };
  };

  return {
    normalizeSessionSpawnNewLegacyApprovalReplay,
    resolveSessionSpawnAgentInventorySelection,
    scmActionExecute: executeSessionBoundScmAction,
    executionRunCheckProtocolV2: async (sessionId, requirement, opts) => {
      if (!requirement.detachedScope && !requirement.startAndWait) {
        return { ok: true };
      }
      return await readExecutionRunProtocolV2(sessionId, opts);
    },
    executionRunStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          code: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId: `execution.run.start:${randomUUID()}`,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        waitForReady: true,
      });
      if (!resumed.ok) {
        return {
          ok: false,
          code: 'execution_run_target_unavailable',
          message: resumed.message,
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      return await startExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunList: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await listExecutionRuns({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        skipLiveRpc: transport.rawSession.active === false,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunGet: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await getExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunSend: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await sendExecutionRunMessage({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunEnsure: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await ensureExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunEnsureOrStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await ensureOrStartExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await startExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamRead: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await readExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamCancel: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await cancelExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStop: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await stopExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunAction: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await executeExecutionRunAction({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunWait: async (sessionId, request, opts) => {
      const pollIntervalMs = normalizeExecutionRunWaitPollIntervalMs(
        (request as any)?.pollIntervalMs,
        normalizeExecutionRunWaitPollIntervalMs(process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS),
      );
      if (sessionId === null) {
        return await waitForExecutionRun({
          runId: String((request as any)?.runId ?? ''),
          timeoutMs: normalizeExecutionRunWaitTimeoutMs((request as any)?.timeoutSeconds),
          pollIntervalMs,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          readRun: async (getRequest) => {
            const result = await callDetachedExecutionRunRpc(
              sessionId,
              SESSION_RPC_METHODS.EXECUTION_RUN_GET,
              getRequest,
              opts,
            );
            const record = readRecord(result);
            if (record.ok === false) {
              const code = normalizeStringValue(record.errorCode) ?? 'execution_run_target_unavailable';
              return {
                ok: false,
                code,
                ...(normalizeStringValue(record.error) ? { message: normalizeStringValue(record.error)! } : {}),
              };
            }
            return { ok: true, data: result };
          },
        });
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }

      return await waitForExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        runId: String((request as any)?.runId ?? ''),
        timeoutMs: normalizeExecutionRunWaitTimeoutMs((request as any)?.timeoutSeconds),
        pollIntervalMs,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    reviewStartInline: async ({ sessionId, input }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, input);
    },
    ...(reviewCommentAction
      ? {
        reviewCommentAction: async ({ actionId, input, reviewCommentPrincipal, signal }) =>
          await reviewCommentAction(actionId, input, {
            ...(reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : {}),
            ...(signal ? { signal } : {}),
          }),
      }
      : {}),

    daemonMemorySearch: async ({ machineId, query }) => {
      if (!params.credentials) return notSupported();
      return MemorySearchResultV1Schema.parse(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
        request: query,
      }));
    },
    daemonMemoryGetWindow: async ({ machineId, sessionId, seqFrom, seqTo }) => {
      if (!params.credentials) return notSupported();
      return MemoryWindowV1Schema.parse(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId, seqFrom, seqTo },
      }));
    },
    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId }) => {
      if (!params.credentials) return notSupported();
      return await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: sessionId ? { sessionId } : {},
      });
    },
    daemonPromptAssetsDiscover: async ({ request, signal }) => await discoverPromptAssets({
      registry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    daemonPromptAssetsDelete: async ({ request, signal }) => await deletePromptAsset({
      registry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    daemonPromptRegistryScanSource: async ({ request }) => await scanPromptRegistrySource({
      registry: promptRegistryAdapterRegistry,
      request,
    }),
    daemonPromptRegistryInstall: async ({ request, signal }) => await installPromptRegistryItem({
      registry: promptRegistryAdapterRegistry,
      assetRegistry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    promptDocUpdate: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptDocInLibrary({
        store: approvalsStore.promptLibraryStore,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    promptBundleUpdate: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptBundleInLibrary({
        store: approvalsStore.promptLibraryStore,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    promptAssetExport: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const localMachine = await requireLocalPromptActionMachine(request.machineId);
      if (!localMachine.ok) return localMachine;
      const promptExternalLinks = await readPromptExternalLinks();
      if ('ok' in promptExternalLinks && promptExternalLinks.ok === false) return promptExternalLinks;
      const result = await exportPromptLibraryArtifact({
        store: approvalsStore.promptLibraryStore,
        write: async ({ request: writeRequest, signal: writeSignal }) => await writePromptAsset({
          registry: promptAssetAdapterRegistry,
          request: writeRequest,
          ...(writeSignal ? { signal: writeSignal } : {}),
        }),
        request: {
          ...request,
          workspacePath: request.directory ?? null,
          targetInput: request.targetPath ?? request.targetName ?? '',
          promptExternalLinks: promptExternalLinks.status === 'valid'
            ? promptExternalLinks.value
            : { v: 1, links: [] },
        },
        randomId: randomUUID,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return result;
      const externalLinkPersistence = await persistPromptExternalLink(
        result.nextPromptExternalLinks,
        promptExternalLinks.status === 'invalid',
        signal,
      );
      return {
        ...result,
        ...(externalLinkPersistence ? { externalLinkPersistence } : {}),
      };
    },
    promptRegistryInstall: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const localMachine = await requireLocalPromptActionMachine(request.machineId);
      if (!localMachine.ok) return localMachine;
      let fetchedItem: PromptRegistryFetchedItemV1 | null = null;
      const promptExternalLinks = await readPromptExternalLinks();
      if ('ok' in promptExternalLinks && promptExternalLinks.ok === false) return promptExternalLinks;
      const result = await installPromptRegistryItemInLibrary({
        store: approvalsStore.promptLibraryStore,
        fetchItem: async ({ sourceId, itemId, configuredSources, signal: fetchSignal }) => {
          const fetched = await fetchPromptRegistryItem({
            registry: promptRegistryAdapterRegistry,
            sourceId,
            itemId,
            configuredSources,
            ...(fetchSignal ? { signal: fetchSignal } : {}),
          });
          if (fetched.ok) fetchedItem = fetched.item;
          return fetched;
        },
        install: async ({ request: installRequest, signal: installSignal }) => await installPromptRegistryItem({
          registry: promptRegistryAdapterRegistry,
          assetRegistry: promptAssetAdapterRegistry,
          request: installRequest,
          ...(fetchedItem ? { fetchedItem } : {}),
          ...(installSignal ? { signal: installSignal } : {}),
        }),
        request: {
          ...request,
          promptExternalLinks: promptExternalLinks.status === 'valid'
            ? promptExternalLinks.value
            : { v: 1, links: [] },
        },
        randomId: randomUUID,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return result;
      const externalLinkPersistence = await persistPromptExternalLink(
        result.nextPromptExternalLinks,
        promptExternalLinks.status === 'invalid',
        signal,
      );
      return {
        ...result,
        ...(externalLinkPersistence ? { externalLinkPersistence } : {}),
      };
    },

    sessionOpen: async ({ sessionId, actionRequestId, signal }) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      if (transport.rawSession.active === true) {
        return { ok: true, status: 'opened', sessionId: transport.sessionId };
      }
      const localId = normalizeStringValue(actionRequestId) ?? `session.open:${transport.sessionId}`;
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId,
        ...(signal ? { signal } : {}),
      });
      return resumed.ok
        ? { ok: true, status: 'opened', sessionId: transport.sessionId }
        : { ok: false, errorCode: resumed.code, error: resumed.message };
    },
    sessionFork: async ({
      sessionId,
      forkPoint,
      strategy,
      replaySummaryRunner,
      replayMaxSeedChars,
      requestId,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      const metadata = readSessionMetadata({ ...transport, rawSession: transport.rawSession });
      const machineId = normalizeStringValue(transport.rawSession.machineId)
        ?? normalizeStringValue(metadata?.machineId);
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      return await callMachineAction({
        machineId,
        method: RPC_METHODS.SESSION_FORK,
        request: {
          parentSessionId: transport.sessionId,
          forkPoint,
          ...(strategy ? { strategy } : {}),
          ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
          ...(replayMaxSeedChars !== undefined ? { replayMaxSeedChars } : {}),
          ...(requestId ? { requestId } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    sessionContinueWithReplay: async (args) => {
      if (!params.credentials) return notSupported();
      const machineId = (await readCurrentMachineControlIdentity()).machineId;
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      const { signal, ...request } = args;
      return await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    sessionRollback: async ({ sessionId, target, signal }) => await callResolvedSessionRpc(
      sessionId,
      SESSION_RPC_METHODS.SESSION_ROLLBACK,
      { sessionId, ...(target ? { target } : {}) },
      signal,
    ),
    checkpointCodeRollback: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
      request,
      signal,
    ),
    sessionCheckpoint: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT,
      request,
      signal,
    ),
    sessionRestore: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_RESTORE,
      request,
      signal,
    ),
    sessionHandoffStart: async ({
      sessionId,
      targetMachineId,
      targetSessionStorageMode,
      workspaceTransfer,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      // One owner for the handoff source facts, shared with the daemon's tracked
      // coordinator: machine custody and transcript-storage authority both come
      // from OWNER metadata, and an unresolved link refuses here rather than
      // being stamped as `persisted` on a request that stops the source.
      const source = resolveSessionHandoffSourceAuthority({
        credentials: params.credentials,
        rawSession: transport.rawSession,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
      });
      if (!source.ok) {
        return { ok: false, errorCode: source.errorCode, error: source.error };
      }
      const sourceMachineId = source.sourceMachineId;
      return await callMachineAction({
        machineId: sourceMachineId,
        method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
        request: {
          sessionId: transport.sessionId,
          sourceMachineId,
          targetMachineId,
          sessionStorageMode: source.sessionStorageMode,
          ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
          preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
          ...(workspaceTransfer ? { workspaceTransfer } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    sessionSpawnNewDirectoryApprovalPreflight: async ({ input, signal }) => {
      if (!params.credentials) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'permission_denied' as const, retryable: false },
        };
      }
      if (signal?.aborted) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'cancelled' as const, retryable: true },
        };
      }
      if (!isCurrentSessionSpawnExecutionTarget(input.executionTarget)) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'target_unavailable' as const, retryable: false },
        };
      }
      if (input.checkoutCreationDraft) {
        // A worktree is materialized by the SCM owner, not by the raw
        // directory-creation authorization path.
        return { type: 'not_required' as const };
      }

      const preparation = await prepareSessionSpawnTarget({
        executionTarget: input.executionTarget,
        directory: input.directory,
        ...(signal ? { signal } : {}),
      });
      if (!preparation.ok) {
        return { type: 'error' as const, result: preparation.result };
      }
      if (!preparation.preparedTarget.directoryCreationRequired) {
        return { type: 'not_required' as const };
      }
      const approval: SessionCreationDirectoryApprovalV1 = {
        v: 1,
        executionTarget: input.executionTarget,
        directory: preparation.preparedTarget.directory,
      };
      return { type: 'approval_required' as const, approval };
    },
    sessionSpawnNew: async ({
      executionTarget,
      directory,
      organizationPlacement,
      agentTarget,
      modelSelection,
      profileId,
      environmentVariables,
      permissionMode,
      agentModeId,
      configuration: configurationSnapshot,
      connectedServices,
      mcpSelection,
      transcriptStorage,
      terminal,
      checkoutCreationDraft,
      title,
      initialMessage,
      agentSessionStartupInstructionsV1,
      sessionCreationTag,
      sourceContext,
      legacyMetadataLabel,
      actionCaller,
      callerSurface,
      actionRequestId,
      resumeActionRequest,
      sessionCreationDirectoryApproval,
      signal,
    }): Promise<SessionSpawnNewResultV1> => {
      if (!params.credentials) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }

      if (!isCurrentSessionSpawnExecutionTarget(executionTarget)) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      const normalizedActionRequestId = normalizeStringValue(actionRequestId);
      if (resumeActionRequest === true && !normalizedActionRequestId) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnNonce = normalizedActionRequestId
        ? createStableSpawnNonce('session.spawn_new.action', { actionRequestId: normalizedActionRequestId })
        : undefined;

      const directTargetTransport = params.sessionSpawnDirectTargetTransport;
      if (
        directTargetTransport
        && directTargetTransport.machineId !== executionTarget.machineId
      ) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      if (!directTargetTransport) {
        let targetCapabilityProjection: Awaited<ReturnType<typeof readMachineOperationProtocolCapabilitiesV1>>;
        try {
          targetCapabilityProjection = await readMachineOperationProtocolCapabilitiesV1({
            credentials: params.credentials,
            machineId: executionTarget.machineId,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          const spawnMayHaveBeenAccepted = hasPossiblyAcceptedSpawnNonce(error);
          if (signal?.aborted) {
            if (spawnMayHaveBeenAccepted) {
              return {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
              };
            }
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          if (isAuthenticationError(error)) {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          return { type: 'error', code: 'machine_offline', retryable: true };
        }
        if (
          !targetCapabilityProjection
          || !supportsMachineOperationProtocolCapabilityV1(
            targetCapabilityProjection.capabilities,
            'sessionSpawn',
          )
        ) {
          return { type: 'error', code: 'incompatible_target', retryable: false };
        }
      }

      const resolvedAgentTarget = resolveSessionSpawnAgentTarget(agentTarget);
      if (!resolvedAgentTarget) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      const { backendTarget } = resolvedAgentTarget;
      const connectedServicesDefaults = connectedServices === undefined
        ? await resolveSpawnConnectedServicesDefaultPayload({
            credentials: params.credentials,
            backendTarget,
          })
        : null;
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const resolvedConnectedServices = connectedServices
        ?? connectedServicesDefaults?.connectedServices;
      const resolvedConnectedServicesUpdatedAt = connectedServicesDefaults?.connectedServicesUpdatedAt;
      const normalizedPlacement =
        normalizeSessionCreationOrganizationPlacementV1(organizationPlacement);
      const normalizedTerminal = terminal === undefined
        ? undefined
        : SessionAuthoringTerminalV1Schema.safeParse(terminal);
      if (normalizedTerminal !== undefined && !normalizedTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnTerminal = normalizedTerminal === undefined
        ? undefined
        : SpawnSessionTerminalSchema.safeParse(normalizedTerminal.data);
      if (spawnTerminal !== undefined && !spawnTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const windowsTerminal = normalizedTerminal?.data.windows;
      const normalizedConfigurationOverrides = configurationSnapshot
        ? buildAcpConfigOptionOverridesV1({
            updatedAt: Math.max(
              configurationSnapshot.mode.updatedAtMs,
              configurationSnapshot.model.updatedAtMs,
              configurationSnapshot.permissionIntent.updatedAtMs,
              ...Object.values(configurationSnapshot.options).map((entry) => entry.updatedAtMs),
            ),
            overrides: Object.fromEntries(
              Object.entries(configurationSnapshot.options).map(([key, entry]) => [
                key,
                { updatedAt: entry.updatedAtMs, value: entry.value },
              ]),
            ),
          })
        : undefined;
      const resolvedModelSelection = modelSelection
        ?? (configurationSnapshot?.model.value
          ? SessionModelSelectionV1Schema.parse({
              v: 1,
              updatedAt: configurationSnapshot.model.updatedAtMs,
              ref: {
                agentTargetKey: buildBackendTargetKeyV2(backendTarget),
                providerConnectionId: null,
                modelId: configurationSnapshot.model.value,
              },
            })
          : undefined);
      const requestedPermissionMode = permissionMode
        ?? configurationSnapshot?.permissionIntent.value
        ?? undefined;
      const resolvedPermissionMode = requestedPermissionMode
        ? parsePermissionIntentAlias(requestedPermissionMode)
        : undefined;
      if (requestedPermissionMode && !resolvedPermissionMode) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const resolvedAgentModeId = agentModeId
        ?? configurationSnapshot?.mode.value
        ?? undefined;
      const startupInstructionsMarker = agentSessionStartupInstructionsV1
        ? {
            v: agentSessionStartupInstructionsV1.v,
            id: agentSessionStartupInstructionsV1.id,
            revision: agentSessionStartupInstructionsV1.revision,
          }
        : null;
      const targetPreparation = await prepareSessionSpawnTarget({
        executionTarget,
        directory,
        ...(checkoutCreationDraft !== undefined ? { checkoutCreationDraft } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!targetPreparation.ok) return targetPreparation.result;
      const preparedTarget = targetPreparation.preparedTarget;
      const directoryApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
        sessionCreationDirectoryApproval,
      );
      if (
        preparedTarget.directoryCreationRequired
        && (
          !directoryApproval.success
          || directoryApproval.data.executionTarget.serverId !== executionTarget.serverId
          || directoryApproval.data.executionTarget.machineId !== executionTarget.machineId
          || directoryApproval.data.directory !== preparedTarget.directory
        )
      ) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const normalizedDirectory = preparedTarget.directory;
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: {
            machineId: executionTarget.machineId,
            directory: normalizedDirectory,
          },
          organization: normalizedPlacement,
          agentTarget,
          modelSelection: resolvedModelSelection ?? null,
          profileId: profileId ?? null,
          requestedPermissionMode: resolvedPermissionMode ?? null,
          agentModeId: resolvedAgentModeId ?? null,
          configuration: configurationSnapshot ?? null,
          connectedServices: resolvedConnectedServices ?? null,
          mcpSelection: mcpSelection ?? null,
          transcriptStorage: transcriptStorage ?? null,
          terminal: normalizedTerminal?.data ?? null,
          agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
          checkout: preparedTarget.checkout,
        },
      });
      // A source recipe is required semantics, not a hint: it is resolved to an
      // exact cutoff before any Session row exists, and a failure creates no
      // child so the authoring draft and its chip stay intact.
      let replaySeededCreation: ReplaySeededSessionCreationV1 | undefined;
      if (sourceContext && resumeActionRequest !== true) {
        let sourceAuthority: Awaited<ReturnType<typeof resolveReplaySourceContextAuthority>>;
        try {
          sourceAuthority = await resolveReplaySourceContextAuthority({
            credentials: params.credentials,
            sourceSessionId: sourceContext.sourceSessionId,
          });
        } catch (error) {
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        if (sourceAuthority.status !== 'owned') {
          return sourceAuthority.status === 'not_owned'
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        const recipeResult = await buildReplaySeededSpawnRecipe({
          credentials: params.credentials,
          cwd: normalizedDirectory,
          source: {
            sourceSessionId: sourceContext.sourceSessionId,
            forkPoint: sourceContext.forkPoint,
          },
          agentHintAgentId: resolvedAgentTarget.agentId,
          // Source-local media survives only when the source and selected child
          // target are proven to be the same exact machine and this process is
          // directly preparing that target. A replacement relation or a direct
          // transport alone does not make an old workspace path usable.
          mediaContinuityUsableOnCreatingMachine:
            Boolean(directTargetTransport)
            && sourceAuthority.sourceMachineId === executionTarget.machineId,
        });
        if (!recipeResult.ok) {
          // The two recipe failures — an unhydratable source and an empty seed —
          // are not distinguishable at this owner, and neither created a child.
          // Report the retryable form so a transient source read does not strand
          // an otherwise valid authoring attempt.
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        replaySeededCreation = {
          tag: sessionCreationTag,
          flavor: resolvedAgentTarget.agentId,
          metadata: {
            ...recipeResult.recipe.metadata,
            sessionCreationCorrespondenceV1: correspondence,
          },
          sourceRecipe: {
            sourceSessionId: sourceContext.sourceSessionId,
            cutoffSeqInclusive: recipeResult.recipe.cutoffSeqInclusive,
          },
        };
      }
      try {
        const created = await createSpawnedSession({
          credentials: params.credentials,
          directory: normalizedDirectory,
          machineId: executionTarget.machineId,
          backendTarget,
          sessionCreationTag,
          ...(replaySeededCreation ? { replaySeededCreation } : {}),
          ...(sourceContext ? { sourceContext } : {}),
          approvedNewDirectoryCreation: preparedTarget.directoryCreationRequired,
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
          sessionCreationCorrespondence: correspondence,
          organizationPlacement: normalizedPlacement,
          ...(resolvedModelSelection ? { modelSelection: resolvedModelSelection } : {}),
          ...(profileId ? { profileId } : {}),
          ...(environmentVariables ? { environmentVariables } : {}),
          ...(resolvedPermissionMode ? { permissionMode: resolvedPermissionMode } : {}),
          ...(resolvedAgentModeId ? { agentModeId: resolvedAgentModeId } : {}),
          ...(normalizedConfigurationOverrides
            ? { sessionConfigOptionOverrides: normalizedConfigurationOverrides }
            : {}),
          ...(resolvedConnectedServices ? { connectedServices: resolvedConnectedServices } : {}),
          ...(resolvedConnectedServicesUpdatedAt !== undefined
            ? { connectedServicesUpdatedAt: resolvedConnectedServicesUpdatedAt }
            : {}),
          ...(mcpSelection ? { mcpSelection } : {}),
          ...(transcriptStorage ? { transcriptStorage } : {}),
          ...(spawnTerminal?.data ? { terminal: spawnTerminal.data } : {}),
          ...(windowsTerminal?.launchMode
            ? { windowsRemoteSessionLaunchMode: windowsTerminal.launchMode }
            : {}),
          ...(windowsTerminal?.console
            ? { windowsRemoteSessionConsole: windowsTerminal.console }
            : {}),
          ...(windowsTerminal?.windowName
            ? { windowsTerminalWindowName: windowsTerminal.windowName }
            : {}),
          ...(configurationSnapshot?.providerSessionResume
            ? { resume: configurationSnapshot.providerSessionResume.providerSessionId }
            : {}),
          ...(title ? { initialTitle: title } : {}),
          ...(initialMessage ? { initialMessage } : {}),
          ...(initialMessage
            ? {
                buildInitialInputAdmission: (sessionId: string) =>
                  buildSessionSpawnInitialInputAdmissionV1({
                    actionCaller,
                    callerSurface,
                    sessionId,
                    sessionCreationTag,
                  }),
              }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(directTargetTransport
            ? { directTransport: directTargetTransport.spawnedSession }
            : {}),
          ...(params.machineActionDirectTargetTransport?.machineId === executionTarget.machineId
            ? {
                machineActionTransport: params.machineActionDirectTargetTransport.invoke,
              }
            : {}),
          ...(agentSessionStartupInstructionsV1
            ? { agentSessionStartupInstructionsV1 }
            : {}),
          ...(spawnNonce ? { spawnNonce } : {}),
          ...(resumeActionRequest === true ? { resumeOnly: true } : {}),
          ...(signal ? { signal } : {}),
        });
        return {
          type: 'success',
          disposition: created.disposition,
          sessionId: created.sessionId,
          executionTarget,
          organizationPlacement: created.organizationPlacement,
          initialInput: created.initialInput,
        };
      } catch (error) {
        const code = error && typeof error === 'object'
          && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : '';
        if (isAuthenticationError(error)) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        if (hasSessionCreationOrganizationInvalidDetail(error)) {
          return { type: 'error', code: 'organization_invalid', retryable: false };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST) {
          return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (code === 'creation_conflict' || hasSessionCreationCorrespondenceConflictDetail(error)) {
          return { type: 'error', code: 'creation_conflict', retryable: false };
        }
        if (
          code === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          || code === 'MACHINE_RPC_TIMEOUT'
        ) {
          return {
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
          };
        }
        if (signal?.aborted) {
          return { type: 'error', code: 'cancelled', retryable: true };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE) {
          return { type: 'error', code: 'incompatible_target', retryable: false };
        }
        return { type: 'error', code: 'spawn_failed', retryable: true };
      }
    },
    ...(approvalsStore ?? {}),
    ...inventoryDeps,
    sessionSendMessage: async ({
      sessionId,
      message,
      displayText,
      messageMeta,
      requestedAction,
      actionCaller,
      idempotencyKey,
      localId,
      source,
      attachments,
      wait,
      timeoutSeconds,
      permissionModeOverride,
      modelOverride,
      providerConnectionId,
      callerSurface,
      callerPermissionMode,
      signal,
    }) => {
      const pluginCaller = actionCaller?.kind === 'plugin' ? actionCaller : null;
      if (pluginCaller && typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0) {
        return {
          status: 'rejected' as const,
          code: 'session_input_invalid' as const,
        };
      }
      if (!params.credentials) {
        return pluginCaller
          ? { status: 'rejected' as const, code: 'session_input_unauthorized' as const }
          : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedWait = typeof wait === 'boolean' ? wait : false;
      const normalizedTimeoutSeconds =
        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? Math.min(3600, timeoutSeconds)
          : 300;
      const permissionOverrideDecision = isSessionAgentSurface(callerSurface) && typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
        ? assertNonEscalatingPermissionMode({
            requestedMode: permissionModeOverride,
            callerMode: await resolveCallerPermissionMode(callerPermissionMode),
          })
        : null;
      if (permissionOverrideDecision?.ok === false) {
        return permissionEscalationActionResult({
          callerSurface,
          decision: permissionOverrideDecision,
        });
      }
      const normalizedPermissionModeOverride = permissionOverrideDecision?.ok === true
        ? permissionOverrideDecision.normalizedMode
        : typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
          ? permissionModeOverride.trim()
          : undefined;
      const normalizedProviderConnectionId = providerConnectionId === null
        ? null
        : providerConnectionId === undefined
          ? undefined
          : ProviderConnectionIdSchema.parse(providerConnectionId);
      const normalizedModelOverride = modelOverride === null
        ? null
        : typeof modelOverride === 'string' && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : undefined;
      if (normalizedProviderConnectionId !== undefined
        && normalizedProviderConnectionId !== null
        && (normalizedModelOverride === undefined || normalizedModelOverride === null)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const modelSelectionInput = normalizedModelOverride === undefined
        ? undefined
        : {
            ...(normalizedProviderConnectionId !== undefined
              ? { providerConnectionId: normalizedProviderConnectionId }
              : {}),
            modelId: normalizedModelOverride,
          };

      if (
        pluginCaller
        && (
          typeof pluginCaller.contributionLocalId !== 'string'
          || typeof idempotencyKey !== 'string'
        )
      ) {
        return {
          status: 'rejected' as const,
          code: 'session_input_untrusted_assertion' as const,
        };
      }
      const pluginLocalId = pluginCaller
        ? derivePluginSessionInputLocalIdV1({
            caller: pluginCaller,
            sessionId,
            idempotencyKey: idempotencyKey!,
          })
        : undefined;
      const pluginInputAdmission = pluginCaller
        ? buildPluginSessionInputAdmissionV1({
            caller: pluginCaller,
            surface: callerSurface,
            ...(source ? { source } : {}),
          })
        : undefined;

      // Declared attachments reach the canonical structured-input admission
      // owner before the Session writer, exactly as a Composer-authored draft
      // does. Only a plugin caller owns a declaration the host can qualify.
      let admittedAttachmentMeta: Record<string, unknown> | undefined;
      let admittedComposerAttachments: readonly ComposerAttachmentInputV1[] = [];
      const composerAttachmentRegistry = params.resolveComposerAttachmentSendPreparation?.() ?? null;
      if (attachments && attachments.length > 0) {
        if (!pluginCaller || !pluginLocalId) {
          return {
            status: 'rejected' as const,
            code: 'session_input_untrusted_assertion' as const,
          };
        }
        const attachmentAdmission = await admitPluginSessionInputAttachmentsV1({
          attachments: composerAttachmentRegistry,
          pluginId: pluginCaller.pluginId,
          sessionId,
          messageLocalId: pluginLocalId,
          text: String(message ?? ''),
          authored: attachments,
          ...(signal ? { signal } : {}),
        });
        if (attachmentAdmission.status === 'rejected') {
          return { status: 'rejected' as const, code: attachmentAdmission.code };
        }
        admittedAttachmentMeta = attachmentAdmission.meta;
        admittedComposerAttachments = attachmentAdmission.attachments;
      }

      const dispatchMessageHook = async (canonicalSessionId: string, source: 'plugin' | 'user') => {
        try {
          await dispatchSessionLifecycleHookEvent({
            eventId: 'session.message.send',
            happySessionId: canonicalSessionId,
            payload: {
              sessionId: canonicalSessionId,
              text: String(message ?? ''),
              source,
            },
          });
        } catch {
          // Hook dispatch is best-effort so a misbehaving plugin cannot break message send.
        }
      };

      if (pluginCaller && pluginLocalId && pluginInputAdmission) {
        const protectedResult = await sendSessionMessage({
          credentials: params.credentials,
          idOrPrefix: sessionId,
          message: String(message ?? ''),
          requestedAction,
          wait: normalizedWait,
          timeoutMs: normalizedTimeoutSeconds * 1000,
          localId: pluginLocalId,
          inputAdmission: pluginInputAdmission,
          ...((admittedAttachmentMeta || messageMeta || displayText)
            ? {
                messageMeta: {
                  ...(messageMeta ?? {}),
                  ...(admittedAttachmentMeta ?? {}),
                  ...(displayText ? { displayText } : {}),
                },
              }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(modelSelectionInput ? { modelSelectionInput } : {}),
          ...(signal ? { signal } : {}),
        });
        if (!protectedResult.ok) return protectedResult.admissionResult;
        const canonicalSessionId = typeof protectedResult.sessionId === 'string'
          && protectedResult.sessionId.trim().length > 0
          ? protectedResult.sessionId
          : sessionId;
        const admissionResult = protectedResult.admissionResult;
        if (
          composerAttachmentRegistry
          && (admissionResult.status === 'accepted' || admissionResult.status === 'alreadyAccepted')
        ) {
          notifyComposerAttachmentsAfterMessageAccepted({
            sessionId: canonicalSessionId,
            localId: admissionResult.localId,
            attachments: admittedComposerAttachments,
            notify: ({ attachment, event, signal: notificationSignal }) => (
              composerAttachmentRegistry.afterMessageAccepted({
                attachment,
                event,
                signal: notificationSignal,
              })
            ),
            signal: signal ?? new AbortController().signal,
          });
        }
        await dispatchMessageHook(canonicalSessionId, 'plugin');
        return admissionResult;
      }

      const result = await sendSessionMessage({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        message: String(message ?? ''),
        requestedAction,
        wait: normalizedWait,
        timeoutMs: normalizedTimeoutSeconds * 1000,
        // A caller-retained localId makes an ambiguous send retryable: the
        // durable pending queue is keyed by it, so resubmitting rejoins the
        // existing input instead of enqueuing a second message.
        ...(typeof localId === 'string' && localId.trim().length > 0 ? { localId } : {}),
        ...(normalizedPermissionModeOverride ? { permissionModeOverride: normalizedPermissionModeOverride } : {}),
        ...(modelSelectionInput ? { modelSelectionInput } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        return {
          ok: false,
          errorCode: result.code,
          error: result.code,
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.message ? { message: result.message } : {}),
          ...(result.providerError ? { details: result.providerError } : {}),
        };
      }
      const canonicalSessionId = typeof result.sessionId === 'string' && result.sessionId.trim().length > 0
        ? result.sessionId
        : sessionId;
      await dispatchMessageHook(canonicalSessionId, 'user');
      return result;
    },

    sessionStop: async ({ sessionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId });
    },

    sessionTitleSet: async ({ sessionId, title }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedTitle = String(title ?? '').trim();
      if (!normalizedTitle) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await setSessionTitle({ credentials: params.credentials, idOrPrefix: sessionId, title: normalizedTitle });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, title: normalizedTitle };
    },

    sessionPermissionModeSet: async ({ sessionId, permissionMode, callerSurface, callerPermissionMode }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const permissionDecision = isSessionAgentSurface(callerSurface)
        ? assertNonEscalatingPermissionMode({
            requestedMode: permissionMode,
            callerMode: await resolveCallerPermissionMode(callerPermissionMode),
          })
        : null;
      if (permissionDecision?.ok === false) {
        return permissionEscalationActionResult({
          callerSurface,
          decision: permissionDecision,
        });
      }
      const parsed = parsePermissionIntentAlias(
        permissionDecision?.ok === true
          ? permissionDecision.normalizedMode
          : String(permissionMode ?? '').trim(),
      );
      if (!parsed) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      const res = await setSessionPermissionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        permissionMode: parsed as PermissionIntent,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, permissionMode: parsed, updatedAt };
    },

    sessionModelSet: async ({ sessionId, modelId, providerConnectionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedModelId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await setSessionModel({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modelId: normalizedModelId,
        ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
      });
      if (!res.ok) {
        const errorCode = 'code' in res ? res.code : res.status;
        return {
          ok: false,
          errorCode,
          error: errorCode,
          ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}),
          ...('status' in res
            ? {
                details: {
                  status: res.status,
                  activeSelection: res.activeSelection,
                  requestedSelection: res.requestedSelection,
                  ...('reason' in res && res.reason ? { reason: res.reason } : {}),
                },
              }
            : {}),
        };
      }
      if (res.status === 'intent_updated') {
        return {
          ok: true,
          status: res.status,
          sessionId: res.sessionId,
          modelId: res.selection.modelId,
          selection: res.selection,
          updatedAt: res.updatedAt,
        };
      }
      return {
        ...res,
        modelId: res.activeSelection.modelId,
      };
    },

    sessionArchiveSet: async ({ sessionId, archived }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await setSessionArchivedState({ credentials: params.credentials, idOrPrefix: sessionId, archived: archived === true });
    },

    sessionStatusGet: async ({ sessionId, live }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await getSessionStatus({ credentials: params.credentials, idOrPrefix: sessionId, live: live === true });
    },

    sessionWorkStateGet: async ({ sessionId }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, {});
    },

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, {
        sessionId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, {
        sessionId,
        localId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionGoalGet: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'get', {});
    },

    sessionGoalSet: async ({ sessionId, objective, status, tokenBudget }) => {
      return await callRoutedSessionGoalControl(sessionId, 'set', {
        ...(typeof objective === 'string' ? { objective } : {}),
        ...(typeof status === 'string' && status.trim().length > 0 ? { status: status.trim() } : {}),
        ...(typeof tokenBudget !== 'undefined' ? { tokenBudget: tokenBudget ?? null } : {}),
      });
    },

    sessionGoalClear: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'clear', {});
    },

    sessionUsageLimitWaitResumeEnable: async ({ sessionId, issueFingerprint, remember, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      const request = {
        sessionId,
        ...(typeof issueFingerprint === 'string' ? { issueFingerprint } : {}),
        ...(remember === true ? { rememberPreference: true } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'enable', request);
    },

    sessionUsageLimitWaitResumeCancel: async ({ sessionId, issueFingerprint, armedAtMs, runtimeAuthRecoveryAttemptId }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const request = {
        sessionId,
        ...(issueFingerprint !== undefined ? { issueFingerprint } : {}),
        ...(typeof armedAtMs === 'number' && Number.isFinite(armedAtMs)
          ? { armedAtMs: Math.trunc(armedAtMs) }
          : {}),
        ...(typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0
          ? { runtimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId.trim() }
          : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'cancel', request);
    },

    sessionUsageLimitCheckNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'checkNow', {
        sessionId,
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitSwitchAccountNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'switchAccountNow', {
        sessionId,
        operation: 'switch_account_now',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitConsumeResetCredit: async ({ sessionId, agentId, issueFingerprint, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedIssueFingerprint = typeof issueFingerprint === 'string' ? issueFingerprint.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'consumeResetCredit', {
        sessionId,
        operation: 'consume_reset_credit',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedIssueFingerprint.length > 0 ? { issueFingerprint: normalizedIssueFingerprint } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionVendorPluginCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'vendorPlugins', { cwd });
    },

    sessionSkillCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'skills', { cwd });
    },

    sessionHistoryGet: async ({ sessionId, limit, format, includeMeta, includeStructuredPayload }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedLimit =
	        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
	          ? Math.min(1000, Math.floor(limit))
	          : 50;
	      const normalizedFormat = format === 'raw' || format === 'compact' ? format : 'compact';
	      return await getSessionEvents({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        limit: normalizedLimit,
	        format: normalizedFormat,
	        includeMeta: includeMeta === true,
	        includeStructuredPayload: includeStructuredPayload === true,
	      });
	    },

    sessionTranscriptGet: async ({
      sessionId,
      projection,
      callerPluginId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      includeTools,
      includeReasoning,
      includeEvents,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxCharsPerMessage,
      maxRawPayloadChars,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(projection ? { projection } : {}),
        ...(callerPluginId ? { callerPluginId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(typeof includeTools === 'boolean' ? { includeTools } : {}),
        ...(typeof includeReasoning === 'boolean' ? { includeReasoning } : {}),
        ...(typeof includeEvents === 'boolean' ? { includeEvents } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
        ...(maxRawPayloadChars !== undefined ? { maxRawPayloadChars } : {}),
        ...(signal ? { signal } : {}),
      });
    },

    sessionEventsGet: async ({
      sessionId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      kinds,
      format,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxTextChars,
      maxPayloadChars,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionEvents({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(kinds ? { kinds } : {}),
        ...(format ? { format } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        ...(typeof maxPayloadChars === 'number' ? { maxPayloadChars } : {}),
      });
    },

	    sessionWaitIdle: async ({ sessionId, timeoutSeconds }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedTimeoutSeconds =
	        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
	          ? Math.min(3600, timeoutSeconds)
	          : 300;
	      return await waitForSessionIdle({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        timeoutMs: Math.max(1, Math.floor(normalizedTimeoutSeconds * 1000)),
	      });
	    },

    sessionPermissionRemoteAction: async (args) => {
      const rejectUnavailable = (
        code: 'canceled' | 'mediationStateUnavailable' | 'ownerMachineUnavailable',
      ) => args.actionId === 'session.permission.remote.pending.list'
        ? { ok: false as const, errorCode: code, error: code }
        : args.actionId === 'session.permission.remote.grants.list'
          ? { ok: false as const, errorCode: code, error: code }
        : { status: 'rejected' as const, code };

      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }

      // The existing current-session binding is the only live owner lookup.
      // Do not fall back to the Action deps' construction session, a registry,
      // or a Session RPC: a remote decision must reach the exact active owner.
      const binding = resolveCurrentSessionCapabilityBinding(args.input.sessionId);
      if (!binding) {
        return rejectUnavailable('ownerMachineUnavailable');
      }
      const bindingIsStillCurrent = (): boolean => {
        if (args.signal?.aborted || binding.signal.aborted) return false;
        try {
          if (binding.isCurrent() !== true) return false;
        } catch {
          return false;
        }
        return resolveCurrentSessionCapabilityBinding(args.input.sessionId)?.scopeId === binding.scopeId;
      };
      if (!bindingIsStillCurrent()) {
        return rejectUnavailable('ownerMachineUnavailable');
      }

      const permissionHandler = binding.permissionHandler;
      if (!permissionHandler) {
        return rejectUnavailable('mediationStateUnavailable');
      }

      if (args.actionId === 'session.permission.remote.pending.list') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const list = permissionHandler.listMediatedPendingRequests;
        if (typeof list !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = list.call(permissionHandler, {
          mediatorPluginId: args.caller.pluginId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          ...('cursor' in args.input && args.input.cursor !== undefined
            ? { cursor: args.input.cursor }
            : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.permission.remote.respond') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const respond = permissionHandler.respondToMediatedPendingPermission;
        if (typeof respond !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await respond.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          idempotencyKey: args.input.idempotencyKey,
          actor: args.input.actor,
          decision: args.input.decision,
          scope: args.input.scope,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.user_action.remote.answer') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const answer = permissionHandler.respondToMediatedPendingUserAction;
        if (typeof answer !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await answer.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          answers: args.input.answers,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      const viewer = args.caller.kind === 'plugin'
        ? { kind: 'mediatorPlugin' as const, pluginId: args.caller.pluginId }
        : args.caller.kind === 'host'
          ? { kind: 'host' as const }
          : null;
      if (!viewer) {
        return rejectUnavailable('mediationStateUnavailable');
      }

      if (args.actionId === 'session.permission.remote.grants.list') {
        const listGrants = permissionHandler.listMediatedPermissionGrants;
        if (typeof listGrants !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await listGrants.call(permissionHandler, {
          viewer,
          limit: args.input.limit,
          ...(args.input.cursor !== undefined ? { cursor: args.input.cursor } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        if (!bindingIsStillCurrent()) {
          return rejectUnavailable('ownerMachineUnavailable');
        }
        return result ?? rejectUnavailable('mediationStateUnavailable');
      }

      const revoke = permissionHandler.revokeMediatedPermissionGrant;
      if (typeof revoke !== 'function') {
        return rejectUnavailable('mediationStateUnavailable');
      }
      const result = await revoke.call(permissionHandler, {
        turnId: args.input.turnId,
        requestId: args.input.requestId,
        grantId: args.input.grantId,
        caller: viewer,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }
      return bindingIsStillCurrent()
        ? result
        : rejectUnavailable('ownerMachineUnavailable');
    },

    sessionPermissionRespond: async ({
      sessionId,
      decision,
      requestId,
      allowedTools,
      updatedPermissions,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      const approved = decision === 'allow';
      const legacyDecision =
        !approved
          ? 'denied'
          : execPolicyAmendment && typeof execPolicyAmendment === 'object'
            ? 'approved_execpolicy_amendment'
            : undefined;
      try {
        return await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.permission.respond`,
          request: {
            id: reqId,
            approved,
            ...(legacyDecision ? { decision: legacyDecision } : {}),
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionUserActionAnswer: async ({
      sessionId,
      requestId,
      answers,
      decision,
      reason,
      updatedPermissions,
      allowedTools,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      if (isKnownCompletedRequestId({
        ...transport,
        rawSession: transport.rawSession,
        requestId: reqId,
        kind: 'user_action',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }
      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim().length > 0 && entry.values.length > 0) {
          normalizedAnswers[question] = [...entry.values];
        }
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const approved = decision ? decision === 'approve' : true;
      const legacyDecision =
        decision === 'reject'
          ? 'denied'
          : decision === 'request_changes'
            ? 'abort'
            : 'approved';
      try {
        return await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.user_action.answer`,
          request: {
            id: reqId,
            approved,
            decision: legacyDecision,
            ...(decision ? { actionDecision: decision } : {}),
            ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
            ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionModeSet: async ({ sessionId, modeId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedModeId = String(modeId ?? '').trim();
      const updatedAt = Date.now();
      const res = await setSessionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modeId: normalizedModeId,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, modeId: normalizedModeId, updatedAt };
    },
    sessionList: async ({ limit, cursor, activeOnly, archivedOnly, includeSystem, resumableOnly, includeRows, includeLastMessagePreview }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedActiveOnly = activeOnly === true;
      const normalizedArchivedOnly = archivedOnly === true;
      if (normalizedActiveOnly && normalizedArchivedOnly) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const res = await listSessions({
        credentials: params.credentials,
        activeOnly: normalizedActiveOnly,
        archivedOnly: normalizedArchivedOnly,
        includeSystem: includeSystem === true,
        resumableOnly: resumableOnly === true,
        includeRows: includeRows === true,
        includeLastMessagePreview: includeLastMessagePreview === true,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(typeof cursor === 'string' && cursor.trim().length > 0 ? { cursor: cursor.trim() } : {}),
      });
      return res;
    },

    sessionActivityGet: async ({ sessionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const session = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId }).catch(() => null);
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found', sessionId };
      }
      return {
        ok: true,
        sessionId,
        active: Boolean(session.active),
        updatedAt: typeof (session as any).updatedAt === 'number' ? (session as any).updatedAt : null,
        pendingCount: typeof (session as any).pendingCount === 'number' ? (session as any).pendingCount : 0,
        pendingPermissionRequestCount: typeof (session as any).pendingPermissionRequestCount === 'number'
          ? (session as any).pendingPermissionRequestCount
          : 0,
        pendingUserActionRequestCount: typeof (session as any).pendingUserActionRequestCount === 'number'
          ? (session as any).pendingUserActionRequestCount
          : 0,
      };
    },

    sessionRecentMessagesGet: async ({ sessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(Object.prototype.hasOwnProperty.call({ cursor }, 'cursor') ? { cursor: cursor ?? null } : {}),
        roles: [
          ...(includeUser === false ? [] : ['user' as const]),
          ...(includeAssistant === false ? [] : ['assistant' as const]),
        ],
        ...(Object.prototype.hasOwnProperty.call({ maxCharsPerMessage }, 'maxCharsPerMessage') ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
      });
    },

    subagentsList: async (args) => {
      return await hostSubagentStore.list(args);
    },

    subagentsGet: async (args) => {
      return await hostSubagentStore.get(args);
    },

    subagentsWatch: async (args) => {
      try {
        return await new Promise((resolve, reject) => {
          try {
            let subscription: Readonly<{ unsubscribe(): void }> | null = null;
            let unsubscribeAfterRegister = false;
            subscription = hostSubagentStore.watch(args, (event) => {
              if (event.kind !== 'snapshot') return;
              resolve({
                kind: 'snapshot',
                subagents: event.subagents ?? [],
              });
              if (subscription) {
                subscription.unsubscribe();
              } else {
                unsubscribeAfterRegister = true;
              }
            });
            if (unsubscribeAfterRegister) {
              subscription.unsubscribe();
            }
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpsert: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.upsert({
          actor: deriveHostSubagentActor(caller),
          input,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpdateStatus: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.updateStatus({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsComplete: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.complete({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    pluginsDevLoopAction: async ({ actionId, input, context }) => await executePluginDevLoopAction({
      actionId,
      input,
      happyHomeDir: params.happyHomeDir,
      workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
      context,
    }),

    pluginSettingsAdministrationAction: async ({ actionId, input, context }) => (
      await executePluginSettingsAdministrationAction({
        actionId,
        input,
        happyHomeDir: params.happyHomeDir,
        ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
    ),

    pluginPermissionGrantAction: async (args) => pluginPermissionGrantAction
      ? await pluginPermissionGrantAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    pluginWebhookAction: async (args) => pluginWebhookAction
      ? await pluginWebhookAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    ...(automationEventAction ? {
      automationEventAction: async (args) => await automationEventAction(args),
    } : {}),

    automationConversationAction: async (args) => automationConversationAction
      ? await automationConversationAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    pluginSessionHookManagementAction: async (args) => {
      const hookManagementAction =
        params.externalSessionPluginAdmissionOwner?.hookManagementAction;
      if (!hookManagementAction) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: `unsupported_action:${args.actionId}`,
        };
      }
      const execution = await hookManagementAction(
        args.actionId,
        args.input,
        {
          surface: 'action',
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      return execution.ok ? execution.result : execution;
    },

    externalSessionAction: async (args) => params.credentials
      ? await executePluginExternalSessionAction(
          { ...args, credentials: params.credentials },
          params.externalSessionPluginAdmissionOwner?.materializeStart
            ? {
                materializeStart:
                  params.externalSessionPluginAdmissionOwner.materializeStart,
              }
            : {},
        )
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    buildApprovalPreview: async ({ actionId, input, defaultPreview }) => {
      if (actionId === 'plugins.install') {
        return await buildPluginInstallApprovalPreview({
          input,
          defaultPreview,
          workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
        });
      }
      return defaultPreview;
    },

    resetGlobalVoiceAgent: () => {},
  };
}
