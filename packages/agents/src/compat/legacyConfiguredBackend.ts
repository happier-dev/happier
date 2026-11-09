// Vocabulary facade for Session/flavor lookup and cli/runtimeLookup; the
// released customAcp codec remains the sole sentinel/legacy flavor owner.
export {
  LEGACY_COMPAT_AGENT_IDS as LEGACY_CONFIGURED_BACKEND_SENTINEL_IDS,
  LEGACY_CUSTOM_ACP_AGENT_ID as LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
  getLegacyCustomAcpAgentCliRuntimeSpec as getLegacyConfiguredBackendAgentCliRuntimeSpec,
  isAgentLookupId as isLegacyConfiguredBackendLookupId,
  isLegacyCustomAcpAgentId as isLegacyConfiguredBackendSentinelId,
  readLegacyCustomAcpCompatBackendIdFromMetadata as readLegacyConfiguredBackendIdFromMetadata,
  resolveLegacyCustomAcpCompatAgentIdFromFlavor as resolveLegacyConfiguredBackendCompatAgentIdFromFlavor,
} from './customAcp.js';
export type {
  AgentCompatId as LegacyConfiguredBackendCompatId,
  AgentLookupId as LegacyConfiguredBackendLookupId,
  LegacyCompatAgentId as LegacyConfiguredBackendSentinelId,
  LegacyCompatAgentCliRuntimeSpec as LegacyConfiguredBackendAgentCliRuntimeSpec,
} from './customAcp.js';
