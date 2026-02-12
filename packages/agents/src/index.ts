export const HAPPY_AGENTS_PACKAGE = '@happier-dev/agents';

export {
    AGENT_IDS,
    PERMISSION_INTENTS,
    PERMISSION_MODES,
    type AgentCore,
    type AgentId,
    type CloudConnectTargetStatus,
    type CloudVendorKey,
    type PermissionIntent,
    type PermissionMode,
    type ResumeRuntimeGate,
    type VendorResumeIdField,
    type VendorResumeSupportLevel,
} from './types.js';
export { AGENTS_CORE, DEFAULT_AGENT_ID } from './manifest.js';
export {
  AGENT_MODEL_CONFIG,
  getAgentModelConfig,
  type AgentModelConfig,
  type AgentModelNonAcpApplyScope,
} from './models.js';

export {
  AGENT_SESSION_MODES,
  getAgentSessionModesKind,
  type AgentSessionModesKind,
} from './sessionModes.js';

export {
  getAgentAdvancedModeCapabilities,
  type AgentAdvancedModeCapabilities,
  type AgentRuntimeModeSwitchKind,
} from './advancedModes.js';

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

// Namespaced provider-specific helpers/knobs.
export * as providers from './providers/index.js';

export * from './providerSettings/index.js';
