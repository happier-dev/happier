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
export { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from './sessionControls/metadata.js';
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
  buildHappierReplayPromptFromDialog,
  type HappierReplayDialogItem,
  type HappierReplayStrategy,
} from './sessions/replay/happierReplayPrompt.js';

// Namespaced provider-specific helpers/knobs.
export * as providers from './providers/index.js';

export {
  PROVIDER_CLI_INSTALL_SPECS,
  getProviderCliInstallSpec,
  type ProviderCliInstallCommand,
  type ProviderCliInstallPlatform,
  type ProviderCliInstallSpec,
} from './providers/cliInstallSpecs.js';

export * from './providerSettings/index.js';

export * from './voice/index.js';
