export const HAPPY_AGENTS_PACKAGE = '@happier-dev/agents';

export {
    AGENT_IDS,
    PERMISSION_INTENTS,
    PERMISSION_MODES,
    type AgentCore,
    type AgentCoreRuntimeControlSurface,
    type AgentHandoffConfig,
    type AgentId,
    type AgentLocalControlConfig,
    type AgentLocalControlAttachStrategy,
    type AgentLocalControlTopology,
    type AgentResumeConfig,
    type AgentSessionCapabilitySupportLevel,
    type AgentSessionCapabilities,
    type AgentSessionStorage,
    type AgentToolsConfig,
    type AgentToolsDelivery,
    type AgentToolsSupportLevel,
    type ConnectedServiceId,
    type ConnectedServiceKind,
    type CloudConnectTargetStatus,
    type CloudVendorKey,
    type PermissionIntent,
    type PermissionMode,
    type VendorHandoffSupportLevel,
    type VendorResumeIdField,
    type VendorResumeSupportLevel,
} from './types.js';
export { AGENTS_CORE, DEFAULT_AGENT_ID } from './manifest.js';
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
  type AgentLocalControlCapability,
} from './localControl.js';
export { resolveAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
export { inferAgentIdFromSessionMetadata, resolveAgentIdFromSessionMetadata } from './resolveAgentIdFromSessionMetadata.js';
export {
  AGENT_MODEL_CONFIG,
  getAgentModelConfig,
  type AgentModelConfig,
  type AgentModelNonAcpApplyScope,
} from './models.js';
export {
  AGENT_LOCAL_CLI_CONFIG,
  getAgentLocalCliConfig,
  type AgentCliAuthSupport,
  type AgentCliLaunchCommand,
  type AgentLocalCliConfig,
} from './localCli.js';
export {
  AGENT_AUTH_PROBE_CONFIG,
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
  getAgentSessionModeDescriptor,
  getAgentSessionModesKind,
  type AgentSessionModeDescriptor,
  type AgentSessionModeSemantics,
  type AgentSessionModeSource,
  type AgentSessionModesKind,
} from './sessionModes.js';

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
    normalizePermissionModeForAgent,
    normalizePermissionModeForGroup,
    resolveLatestPermissionIntent,
} from './permissions/index.js';

export { computeMonotonicUpdatedAt, type MonotonicUpdatedAtPolicy } from './sessionControls/monotonic.js';
export {
  UNSUPPORTED_AGENT_SESSION_CAPABILITIES,
  evaluateAgentSessionCapabilitySupport,
  getAgentSessionCapabilities,
  getAgentSessionCapability,
  isAgentSessionCapabilitySupported,
  type AgentSessionCapabilityKey,
} from './sessionControls/sessionCapabilities.js';
export {
  buildCodexSpawnRuntimeAffinityCompatFields,
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
  type CodexSpawnRuntimeAffinityCompatFields,
  type PersistedCodexRuntimeIdentity,
} from './sessionControls/codexRuntimeIdentity.js';
export {
  buildCodexRuntimeDescriptorProviderExtra,
  readCodexRuntimeDescriptorProviderExtra,
  type CodexRuntimeDescriptorProviderExtra,
} from './sessionControls/codexRuntimeDescriptorExtra.js';
export {
  buildCodexAgentRuntimeDescriptor,
  buildOpenCodeAgentRuntimeDescriptor,
  readSessionMetadataRuntimeDescriptor,
} from './sessionControls/agentRuntimeDescriptor.js';
export {
  readOpenCodeSessionAffinityFromMetadata,
  readOpenCodeSessionRuntimeHandleFromMetadata,
  type OpenCodeSessionAffinity,
  type OpenCodeSessionRuntimeHandle,
} from './sessionControls/opencodeSessionRuntimeHandle.js';
export {
  buildOpenCodeRuntimeDescriptorProviderExtra,
  readOpenCodeRuntimeDescriptorProviderExtra,
  type OpenCodeRuntimeDescriptorProviderExtra,
  type OpenCodeRuntimeDescriptorProviderExtraRuntimeHandle,
} from './sessionControls/opencodeRuntimeDescriptorExtra.js';
export {
  resolveAgentRuntimeControlSurfaceForSession,
  resolveCodexSessionBackendMode,
  resolveOpenCodeSessionBackendMode,
} from './sessionControls/providerSessionBackends.js';
export { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from './sessionControls/metadata.js';
export {
  LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  getMetadataKeysForAlias,
  readMetadataAliasValue,
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  SESSION_MODE_OVERRIDE_KEY,
} from './sessionControls/metadataKeys.js';
export {
  computeNextMetadataStringOverrideV1,
  computeNextPermissionIntentMetadata,
  computeNextMetadataConfigOptionOverrideV1,
} from './sessionControls/publish.js';
export {
  resolveVendorResumeIdFromSessionMetadata,
  evaluateVendorResumeEligibility,
  type VendorResumeEligibility,
  type VendorResumeEligibilityReasonCode,
} from './sessionControls/vendorResumePolicy.js';
export {
  evaluateExistingSessionAutomationEligibility,
  type ExistingSessionAutomationEligibility,
  type ExistingSessionAutomationEligibilityReasonCode,
} from './sessionControls/existingSessionAutomationPolicy.js';
export {
  resolveVendorHandoffIdFromSessionMetadata,
  evaluateVendorHandoffEligibility,
  type VendorHandoffEligibility,
  type VendorHandoffEligibilityReasonCode,
  type VendorHandoffStorageMode,
} from './sessionControls/vendorHandoffPolicy.js';

export {
  buildHappierReplayPromptFromDialog,
  type HappierReplayDialogItem,
  type HappierReplayStrategy,
} from './sessions/replay/happierReplayPrompt.js';
export { normalizeVoiceAgentTurnTranscriptText } from './voice/normalizeVoiceAgentTurnTranscriptText.js';

// Namespaced provider-specific helpers/knobs.
export * as providers from './providers/index.js';

export {
  PROVIDER_CLI_RUNTIME_SPECS,
  getProviderCliRuntimeSpec,
  type ProviderCliInstallCommand as ProviderCliRuntimeInstallCommand,
  type ProviderCliInstallPlatform as ProviderCliRuntimeInstallPlatform,
  type ProviderCliManagedInstallSpec,
  type ProviderCliManualInstallKind,
  type ProviderCliManualInstallRecipes,
  type ProviderCliRuntimeSpec,
  type ProviderCliSourcePreference,
} from './providers/providerCliRuntime.js';
export * from './providers/providerCliInstallGuidance.js';

export * from './providerSettings/index.js';

export * from './voice/index.js';
