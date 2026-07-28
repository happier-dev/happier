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
    type AgentMediaCapabilityKey,
    type AgentMediaCapabilities,
    type AgentMediaCapabilitySupportLevel,
    type AgentRuntimeInputConfig,
    type AgentResumeConfig,
    type AgentSessionAuthSwitchTransition,
    type AgentSessionCapabilitySupportLevel,
    type AgentSessionCapabilities,
    type AgentSessionStorage,
    type AgentToolsConfig,
    type AgentToolsDelivery,
    type AgentToolsSupportLevel,
    type ConnectedServiceId,
    type ConnectedServiceKind,
    type ConnectedServicesProviderStateSharingCapability,
    type ConnectedServicesProviderStateSharingUnavailableReason,
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
  getAgentMediaCapabilities,
  getAgentMediaCapability,
  isAgentMediaCapabilitySupported,
} from './mediaCapabilities.js';
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
export {
  getAgentRuntimeInputCapability,
  supportsAgentInFlightSteer,
  supportsAgentTerminalPromptInjection,
} from './runtimeInput.js';
export {
  isConnectedServiceAccountGroupConfigurationSupported,
  isConnectedServiceRuntimeFallbackSupported,
  resolveConnectedServiceRuntimeFallbackCapability,
  supportsAgentConnectedServiceSessionAuthSwitchTransition,
} from './connectedServices/runtimeFallbackCapability.js';
export {
  type TerminalHostKind,
  type TerminalInjectionDuplicateRisk,
  type TerminalInjectionFailurePhase,
  type TerminalInputInjectionResult,
  type TerminalInputInjectionV1,
  type TerminalPromptInput,
} from './runtime/terminal/inputInjection.js';
export {
  TERMINAL_SHIFT_TAB_SEQUENCE,
  TERMINAL_SPECIAL_KEYS,
  type TerminalControlCapture,
  type TerminalControlCaptureResult,
  type TerminalControlPort,
  type TerminalControlSendFailureReason,
  type TerminalControlSendResult,
  type TerminalControlUnsupportedReason,
  type TerminalSpecialKey,
} from './runtime/terminal/control.js';
export { resolveAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
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
  type AgentAcpSessionModeSetMethod,
  type AgentSessionModeDescriptor,
  type AgentSessionModeSemantics,
  type AgentSessionModeSource,
  type AgentSessionModesKind,
} from './sessionModes.js';

export {
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  KIMI_PROVIDER_FIELDS,
  type ClaudeUnifiedTerminalHost,
  type ClaudeUnifiedTerminalResumeChoice,
  normalizeCodexBackendMode,
  normalizeKimiAcpPythonSelector,
  type CodexBackendMode,
  type KimiAcpPythonSelector,
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
    normalizePermissionModeForAgent,
    normalizePermissionModeForGroup,
    resolveProviderNativePermissionModeForAgent,
    type ProviderNativePermissionMode,
    resolveLatestPermissionIntent,
} from './permissions/index.js';

export {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
    CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_REQUEST_SOURCE,
    isClaudeLocalPermissionBridgeAgentStateRequest,
    isClaudeUnifiedTerminalResumeChoiceAgentStateRequest,
} from './providers/claude/permissionRequestSource.js';
export {
    DEFAULT_AGENT_STATE_EQUIVALENT_REQUEST_COMPLETION_WINDOW_MS,
    isAgentStateRequestCoveredByCompletedRequests,
    readAgentStateRequestCompletedAt,
    type AgentStateRequestCoverageOptions,
    type AgentStateRequestCoverageRecord,
} from './runtime/agentStateRequestCoverage.js';
export {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
  CLAUDE_CODE_REQUIRED_OAUTH_SCOPES,
} from './providers/claude/oauthScopes.js';

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
  type SessionMetadataConnectedServiceBinding,
} from './sessionControls/agentRuntimeDescriptor.js';
export { readSessionMetadataConnectedServiceBindings } from './providers/readSessionMetadataConnectedServiceBindings.js';
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
  applyAgentRuntimeKindOverrideToAccountSettings,
  normalizeAgentRuntimeKindOverride,
  resolveAgentConfiguredRuntimeKind,
  resolveAgentRuntimeControlSurfaceForSession,
  resolveCodexSessionBackendMode,
  resolveOpenCodeSessionBackendMode,
} from './sessionControls/providerSessionBackends.js';
export {
  parseSessionConfigOptionOverridesMetadataStateV1,
  parseSessionModelsMetadataStateV1,
  readNewestSessionConfigOptionOverridesMetadataStateV1,
  readNewestSessionModelsMetadataStateV1,
  resolveMetadataStringOverrideStateV1,
  resolveMetadataStringOverrideStateV1FromAliases,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  type MetadataStringOverrideStateV1,
  type SessionConfigOptionOverridesMetadataStateV1,
  type SessionModelsMetadataStateV1,
} from './sessionControls/metadata.js';
export {
  LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  getMetadataKeysForAlias,
  readMetadataAliasValue,
  readNewestMetadataAliasValue,
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
  computeNextModelOverrideMetadataV1,
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

// Provider CLI runtime surface (used by bundled products like apps/cli via @happier-dev/cli-common).
export {
  getProviderCliBinaryNames,
  PROVIDER_CLI_RUNTIME_SPECS,
  getProviderCliRuntimeSpec,
  type ProviderCliInstallCommand,
  type ProviderCliInstallPlatform,
  type ProviderCliAlternativeBinaryIdentityProbe,
  type ProviderCliKnownCommandCandidate,
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

export * from './voice/index.js';
