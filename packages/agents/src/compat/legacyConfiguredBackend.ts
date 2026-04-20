export {
  LEGACY_COMPAT_AGENT_IDS as LEGACY_CONFIGURED_BACKEND_SENTINEL_IDS,
  LEGACY_CUSTOM_ACP_AGENT_ID as LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
  getLegacyCustomAcpProviderCliRuntimeSpec as getLegacyConfiguredBackendProviderCliRuntimeSpec,
  isAgentLookupId as isLegacyConfiguredBackendLookupId,
  isLegacyCustomAcpAgentId as isLegacyConfiguredBackendSentinelId,
  readLegacyCustomAcpCompatBackendIdFromMetadata as readLegacyConfiguredBackendIdFromMetadata,
  resolveLegacyCustomAcpCompatAgentIdFromFlavor as resolveLegacyConfiguredBackendCompatAgentIdFromFlavor,
} from './customAcp.js';
export type {
  AgentCompatId as LegacyConfiguredBackendCompatId,
  AgentLookupId as LegacyConfiguredBackendLookupId,
  LegacyCompatAgentId as LegacyConfiguredBackendSentinelId,
  LegacyCompatProviderCliRuntimeSpec as LegacyConfiguredBackendProviderCliRuntimeSpec,
} from './customAcp.js';
