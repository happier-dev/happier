import { CANONICAL_AGENTS_CORE as CANONICAL_AGENTS_CORE_FROM_MANIFEST } from './manifest.js';
import { CANONICAL_AGENT_MODEL_CONFIG as CANONICAL_AGENT_MODEL_CONFIG_FROM_MODELS } from './models.js';
import { CANONICAL_PROVIDER_CLI_RUNTIME_SPECS as CANONICAL_PROVIDER_CLI_RUNTIME_SPECS_FROM_RUNTIME } from './providers/providerCliRuntime.js';

export const HAPPY_AGENTS_PACKAGE = '@happier-dev/agents';
export const CANONICAL_AGENTS_CORE = CANONICAL_AGENTS_CORE_FROM_MANIFEST;
export const CANONICAL_AGENT_MODEL_CONFIG = CANONICAL_AGENT_MODEL_CONFIG_FROM_MODELS;
export const CANONICAL_PROVIDER_CLI_RUNTIME_SPECS = CANONICAL_PROVIDER_CLI_RUNTIME_SPECS_FROM_RUNTIME;

export {
    AGENT_IDS,
    CANONICAL_AGENT_IDS,
    isAgentId,
    PERMISSION_INTENTS,
    PERMISSION_MODES,
} from './types.js';
export type {
    AgentCore,
    AgentCoreRuntimeControlSurface,
    AgentHandoffConfig,
    AgentId,
    CanonicalAgentId,
    AgentLocalControlConfig,
    AgentLocalControlAttachStrategy,
    AgentLocalControlTopology,
    AgentResumeConfig,
    AgentSessionCapabilitySupportLevel,
    AgentSessionCapabilities,
    AgentSessionStorage,
    AgentToolsConfig,
    AgentToolsDelivery,
    AgentToolsSupportLevel,
    ConnectedServiceId,
    ConnectedServiceKind,
    CloudConnectTargetStatus,
    CloudVendorKey,
    PermissionIntent,
    PermissionMode,
    VendorHandoffSupportLevel,
    VendorResumeIdField,
    VendorResumeSupportLevel,
} from './types.js';
export {
  AGENTS_CORE,
  DEFAULT_AGENT_ID,
  getAgentCore,
  getAgentResumeConfig,
} from './manifest.js';
export {
  getAllProviderDefinitions,
  getAllProviderDefinitionContracts,
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getProviderDefinition,
  getProviderDefinitionContract,
  getBackendDefinition,
  getBackendDefinitionContract,
  type ProviderDefinition,
  type BackendDefinition,
  type ProviderDefinitionContractV1,
  type BackendDefinitionContractV1,
} from './definitions/index.js';
export {
  getAgentToolsCapability,
  isAgentToolsUnsupported,
  usesNativeMcpTools,
  usesShellBridgeTools,
  type AgentToolsCapability,
} from './tools.js';
export {
  getAgentLocalControlCapability,
  usesProviderAttachForLocalControl,
  usesTerminalHostedLocalControl,
  type AgentLocalControlCapability,
} from './localControl.js';
export { resolveAgentIdFromFlavor, resolveCanonicalAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
export { inferAgentIdFromSessionMetadata, resolveAgentIdFromSessionMetadata } from './resolveAgentIdFromSessionMetadata.js';
export {
  AGENT_MODEL_CONFIG,
  getAgentModelConfig,
  getAgentStaticModels,
  type AgentModelConfig,
  type AgentModelDescriptor,
  type AgentModelNonAcpApplyScope,
} from './models.js';
export {
  AGENT_LOCAL_CLI_CONFIG,
  CANONICAL_AGENT_LOCAL_CLI_CONFIG,
  getAgentLocalCliConfig,
  type AgentCliSupportKind,
  type AgentCliLaunchCommand,
  type AgentLocalCliConfig,
} from './localCli.js';
export {
  AGENT_AUTH_PROBE_CONFIG,
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  getAgentAuthProbeConfig,
  isAgentAuthProbeSafeForBackgroundChecks,
  type AgentAuthProbeConfig,
  type AgentAuthProbeBackgroundChecks,
  type AgentAuthProbeParser,
} from './auth.js';
export {
  BUILT_IN_ACP_CONFIG,
  getBuiltInAcpConfig,
  hasBuiltInAcpConfig,
  type BuiltInAcpConfig,
  type BuiltInAcpTransportProfile,
  type BuiltInAcpYesNoAuto,
} from './acp.js';
export {
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
  type BackendTargetKey,
  type BackendTargetKind,
  type BackendTargetRefV1,
} from './backendTargets.js';

export {
  AGENT_SESSION_MODE_DESCRIPTORS,
  AGENT_SESSION_MODES,
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  getAgentSessionModeDescriptor,
  getAgentSessionModesKind,
  type AgentSessionModeDescriptor,
  type AgentSessionModeSemantics,
  type AgentSessionModeSource,
  type AgentSessionModesKind,
} from './sessionModes.js';
export * as legacyCustomAcpCompat from './compat/customAcp.js';

export {
  normalizeCodexBackendMode,
  type CodexBackendMode,
  type OpenCodeBackendMode,
  type ProviderSettingsDescriptor,
  getAllProviderSettingsDefinitions,
  getProviderSettingsDefinition,
  type ProviderSettingsDefinition,
} from './providerSettings/index.js';

export {
  getAgentAdvancedModeCapabilities,
  type AgentAdvancedModeCapabilities,
  type AgentRuntimeModeSwitchKind,
} from './advancedModes.js';

export {
    getAgentRuntimeKindsManifest,
    resolveAgentRuntimeControlSurface,
    resolveDefaultAgentRuntimeKind,
    type AgentRuntimeKind,
    type AgentRuntimeKindCapableAgentId,
    type AgentRuntimeKindDefinition,
    type AgentRuntimeKindFor,
    type AgentRuntimeKindOverrideSurface,
    type AgentRuntimeKindOverrides,
    type AgentRuntimeKindsManifest,
    type AnyAgentRuntimeKindsManifest,
    type PartialDeep,
} from './runtimeKinds.js';

export {
    isPermissionIntent,
    isPermissionMode,
    type PermissionModeGroupId,
    parsePermissionIntentAlias,
    parsePermissionModeAlias,
    resolvePermissionModeGroupForAgent,
    resolvePermissionModeGroupForSessionModeDescriptor,
    normalizePermissionModeForAgent,
    normalizePermissionModeForGroup,
    resolveLatestPermissionIntent,
} from './permissions/index.js';

export {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from './providers/claude/permissionRequestSource.js';

export {
  computeMonotonicUpdatedAt,
  createFingerprintPublicationState,
  createSessionStateFacetFromHandlers,
  createSessionStateSyncEngine,
  emitSessionStateTelemetry,
  getSessionStateFieldCapability,
  getSessionStateFieldDescriptor,
  inferLatestUserPermissionModeIntent,
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  MODEL_OVERRIDE_KEY,
  PERMISSION_MODE_KEY,
  PERMISSION_MODE_UPDATED_AT_KEY,
  readRuntimeDescriptorSessionState,
  readVendorSessionIdSessionState,
  readAcpConfigOptionIntentFromMetadata,
  readAcpSessionModeIntentFromMetadata,
  readModelIntentFromMetadata,
  readPermissionModeIntentFromMetadata,
  readStringOverrideIntentFromMetadata,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_MODE_OVERRIDE_KEY,
  isSessionStateDirectionSupported,
  resolveFingerprintPublication,
  resolveTimestampedFieldUpdate,
  rollbackFingerprintPublication,
  sanitizeSessionStateErrorCode,
  SESSION_STATE_FIELD_REGISTRY,
  runtimeDescriptorBinding,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  clearSessionStateFieldFromMetadata,
  type FingerprintPublicationDecision,
  type FingerprintPublicationState,
  type InferredPermissionModeIntent,
  type MetadataUpdatePort,
  type MonotonicUpdatedAtPolicy,
  type RuntimeFacetCtx,
  type SessionStateApplyReason,
  type SessionStateBinding,
  type SessionStateCapabilityGateResult,
  type SessionStateDirection,
  type SessionStateDisposable,
  type SessionStateFacet,
  type SessionStateFieldDescriptor,
  type SessionStateFieldWriteValue,
  type SessionStateMetadataWriteResult,
  type SessionStateProviderFieldHandler,
  type SessionStateProviderHandlerMap,
  type SessionStateStoredValue,
  type SessionStateSyncEngine,
  type SessionStateSyncEngineOptions,
  type SessionStateTelemetryEvent,
  type SessionStateWrite,
  type TimestampedFieldStaleBehavior,
  type TimestampedFieldUpdateResult,
  type TimestampedFieldValue,
  type VendorSessionIdMetadataKey,
} from './session/state/index.js';
export {
  UNSUPPORTED_AGENT_SESSION_CAPABILITIES,
  evaluateAgentSessionCapabilitySupport,
  getAgentSessionCapabilities,
  getAgentSessionCapability,
  isAgentSessionCapabilitySupported,
  readRuntimeCapabilitiesForSession,
  type AgentSessionCapabilityKey,
} from './session/controls/sessionCapabilities.js';
export {
  buildCodexSpawnRuntimeAffinityCompatFields,
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
  type CodexSpawnRuntimeAffinityCompatFields,
  type PersistedCodexRuntimeIdentity,
} from './providers/codex/runtimeIdentity.js';
export {
  buildCodexRuntimeDescriptorProviderExtra,
  readCodexRuntimeDescriptorProviderExtra,
  type CodexRuntimeDescriptorProviderExtra,
} from './providers/codex/runtimeDescriptorExtra.js';
export {
  buildCodexAgentRuntimeDescriptor,
} from './providers/codex/buildAgentRuntimeDescriptor.js';
export {
  buildOpenCodeAgentRuntimeDescriptor,
} from './providers/opencode/buildAgentRuntimeDescriptor.js';
export {
  readNormalizedRuntimeDescriptor,
} from './runtime/identity/runtimeDescriptor.js';
export {
  bridgeTranscriptSourceHandoffGap,
  catchUpTranscriptSourceWindow,
  readInitialTranscriptSourceWindow,
  replayTranscriptSourceHistory,
  type TranscriptSourceFollowLease,
  type TranscriptSourceFollowUpdate,
  type TranscriptSourcePage,
  type TranscriptSourceReadAfter,
  type TranscriptSourceWindowState,
} from './runtime/facets/transcriptSource.js';
export {
  RUNTIME_DESCRIPTOR_PROVIDER_IDS,
  getRuntimeDescriptorReader,
  isSupportedRuntimeDescriptorProviderId,
} from './runtime/identity/runtimeDescriptorReaderRegistry.js';
export {
  readSessionMetadataRuntimeDescriptor,
} from './providers/readSessionMetadataRuntimeDescriptor.js';
export {
  readOpenCodeSessionAffinityFromMetadata,
  readOpenCodeSessionRuntimeHandleFromMetadata,
  type OpenCodeSessionAffinity,
  type OpenCodeSessionRuntimeHandle,
} from './providers/opencode/sessionRuntimeHandle.js';
export {
  buildOpenCodeRuntimeDescriptorProviderExtra,
  readOpenCodeRuntimeDescriptorProviderExtra,
  type OpenCodeRuntimeDescriptorProviderExtra,
  type OpenCodeRuntimeDescriptorProviderExtraRuntimeHandle,
} from './providers/opencode/runtimeDescriptorExtra.js';
export {
  applyAgentRuntimeKindOverrideToAccountSettings,
  normalizeAgentRuntimeKindOverride,
  resolveAgentConfiguredRuntimeKind,
} from './session/controls/runtimeKindOverride.js';
export {
  resolveAgentRuntimeControlSurfaceForSession,
} from './session/controls/runtimeControlSurface.js';
export {
  resolveCodexSessionBackendMode,
  resolveOpenCodeSessionBackendMode,
} from './session/controls/providerBackendModes.js';
export {
  LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  getMetadataKeysForAlias,
  readMetadataAliasValue,
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
} from './session/controls/metadataKeys.js';
export {
  resolveVendorResumeIdFromSessionMetadata,
  evaluateVendorResumeEligibility,
  type VendorResumeEligibility,
  type VendorResumeEligibilityReasonCode,
} from './session/controls/vendorResumePolicy.js';
export {
  evaluateExistingSessionAutomationEligibility,
  type ExistingSessionAutomationEligibility,
  type ExistingSessionAutomationEligibilityReasonCode,
} from './session/controls/existingSessionAutomationPolicy.js';
export {
  resolveVendorHandoffIdFromSessionMetadata,
  evaluateVendorHandoffEligibility,
  type VendorHandoffEligibility,
  type VendorHandoffEligibilityReasonCode,
  type VendorHandoffStorageMode,
} from './session/controls/vendorHandoffPolicy.js';

export {
  buildHappierReplayPromptFromDialog,
  type HappierReplayDialogItem,
  type HappierReplayStrategy,
} from './sessions/replay/happierReplayPrompt.js';
export { normalizeVoiceAgentTurnTranscriptText } from './voice/normalizeVoiceAgentTurnTranscriptText.js';

// Provider CLI runtime surface (used by bundled products like apps/cli via @happier-dev/cli-common).
export {
  PROVIDER_CLI_RUNTIME_SPECS,
  getProviderCliSetupRecommendedIds,
  getProviderCliSetupSupportedIds,
  getProviderCliRuntimeSpec,
  type ProviderCliInstallCommand,
  type ProviderCliInstallPlatform,
  type ProviderCliManagedInstallSpec,
  type ProviderCliManualInstallKind,
  type ProviderCliManualInstallRecipes,
  type ProviderCliRuntimeSpec,
  type ProviderCliSourcePreference,
} from './providers/providerCliRuntime.js';

// Namespaced provider-specific helpers/knobs.
export * as providers from './providers/index.js';

export {
  type ProviderCliInstallCommand as ProviderCliRuntimeInstallCommand,
  type ProviderCliInstallPlatform as ProviderCliRuntimeInstallPlatform,
} from './providers/providerCliRuntime.js';
export * from './providers/providerCliInstallGuidance.js';

export * from './providerSettings/index.js';

export type {
  BackendCatalogDefinition,
  ProviderCatalogDefinition,
} from './definitions/types.js';
export type { EngineSpec, RuntimeKindSpec } from './runtime/engine/contracts.js';
export type {
  EngineAdapter,
  MaybePromise,
  RuntimeControlSurface,
  RuntimeCore,
  RuntimeFacets,
  RuntimeTranscriptSourceFacet,
} from './runtime/engine/contracts.js';
export type {
  AttachSurfaceV1,
  ExternalSessionSurfaceV1,
  SessionHandoffSurfaceV1,
  TerminalRuntimeSurfaceV1,
} from './runtime/surfaces/index.js';
export type { RuntimeDescriptor } from './runtime/identity/runtimeDescriptor.js';
export {
  publishRuntimeIdentity,
  type RuntimeIdentityPublication,
} from './runtime/identity/runtimeIdentityPublication.js';
export type { RuntimeDiscovery } from './runtime/discovery/runtimeDiscovery.js';
export type {
  RuntimeCapabilities,
  RuntimeExecutionRunCapabilities,
} from './runtime/capabilities/runtimeCapabilities.js';
export {
  publishRuntimeCapabilities,
} from './runtime/capabilities/runtimeCapabilitiesPublication.js';
export type {
  ProviderAuthAdapter,
  ProviderConnectedServicesAdapter,
  ProviderMessageMetaEnricher,
  RuntimePreferencesAdapter,
} from './runtime/adjunctAdapters/types.js';
export {
  getProviderAuthAdapter,
  getProviderConnectedServicesAdapter,
  getProviderRuntimePreferencesAdapter,
  getProviderMessageMetaEnricher,
} from './runtime/adjunctAdapters/index.js';
export {
  isCodexVendorResumeBackendEnabled,
  resolveCodexSessionRuntimePreferences,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasForRuntime,
  resolveCodexSpawnExtrasFromSettings,
  resolveOpenCodeSessionRuntimePreferences,
} from './runtime/preferences/index.js';
export {
  resolveProviderOutgoingMessageMetaExtras,
} from './runtime/adjunctAdapters/messageMetaRegistry.js';
export {
  buildClaudeRemoteOutgoingMessageMetaExtras,
} from './providers/claude/messageMeta.js';

export * from './voice/index.js';
