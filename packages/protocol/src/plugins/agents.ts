/**
 * The canonical Protocol/Agents author projection. Agent-meaning vocabulary
 * leaves this module under its Agent spelling only: `BackendSurface…` and
 * `PluginBackend…` are the declaration-file implementation names retained at
 * the internal manifest-ingress owners (and the protocol root index consumed
 * by host tooling), never the author-facing projection.
 */
export {
  BackendSurfaceOperationCatalogV1 as AgentSurfaceOperationCatalogV1,
} from './backendSurfaceDeclarationV1.js';
export {
  PluginBackendCapabilitiesV1Schema as PluginAgentCapabilitiesV1Schema,
} from './backendDefinitionV1.js';
export {
  type AgentExecutionTargetV1,
} from '../agents/executionTargetV1.js';
export {
  buildBackendTargetKeyV2,
  parseBackendTargetKeyV2,
} from '../backends/targets/backendTargetRefV2.js';
export {
  buildBackendTargetKey,
} from '../backends/targets/backendTargetRef.js';
export {
  PluginAgentExternalSessionLinkDataSchema,
} from './contributions/agentExternalSessions.js';
export {
  ExternalSessionsSourceSchema,
} from '../sessions/external/sourceCatalog.js';
export {
  ExternalAgentObservationLeafFactV1Schema,
} from '../sessions/external/externalAgentObservationV1.js';
export {
  PluginAgentSessionCompactionCapabilityV2Schema,
  type PluginAgentSessionCompactionCapabilityV2,
  type AgentSessionCompactionCapability,
  type AgentSessionCompactionIdleCapability,
} from './contributions/agentSessionCapabilities.js';
