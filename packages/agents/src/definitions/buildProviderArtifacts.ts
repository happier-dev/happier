import { AGENT_PROVIDER_IDS, type AgentId, type AgentProviderId } from '../types.js';
import { CANONICAL_AGENTS_CORE, DEFAULT_AGENT_ID } from '../manifest.js';
import {
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
} from '../sessionModes.js';
import { CANONICAL_AGENT_MODEL_CONFIG } from '../models.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { CANONICAL_AGENT_AUTH_PROBE_CONFIG } from '../auth.js';
import { BUILT_IN_ACP_CONFIG } from '../acp.js';
import {
  CANONICAL_AGENT_CLI_RUNTIME_SPECS,
  getAgentCliSetupRecommendedIds,
  getAgentCliSetupSupportedIds,
} from '../cli/runtime.js';
import { getProviderSettingsDefinition } from '../providerSettings/index.js';
import type { ProviderCatalogDefinition, ProviderDefinitionContractV1 } from './types.js';
import { resolveOwnedBackendIdsForAgent } from './resolveBackendOwnership.js';

function createProviderDefinition(agentId: AgentProviderId): ProviderCatalogDefinition {
  return {
    id: agentId,
    core: CANONICAL_AGENTS_CORE[agentId],
    sessionModeDescriptor: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS[agentId],
    sessionModesKind: CANONICAL_AGENT_SESSION_MODES[agentId],
    modelConfig: CANONICAL_AGENT_MODEL_CONFIG[agentId],
    localCli: CANONICAL_AGENT_LOCAL_CLI_CONFIG[agentId],
    agentCliRuntime: CANONICAL_AGENT_CLI_RUNTIME_SPECS[agentId],
    providerSettings: getProviderSettingsDefinition(agentId),
  };
}

function createProviderDefinitionContract(agentId: AgentProviderId): ProviderDefinitionContractV1 {
  return {
    kindVersion: 1,
    id: agentId,
    ownedBackendIds: Object.freeze(resolveOwnedBackendIdsForAgent(agentId)),
  };
}

const PROVIDER_DEFINITIONS = Object.freeze(AGENT_PROVIDER_IDS.map((agentId) => createProviderDefinition(agentId)));
const PROVIDER_DEFINITIONS_BY_ID = new Map<AgentId, ProviderCatalogDefinition>(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const PROVIDER_DEFINITION_CONTRACTS = Object.freeze(AGENT_PROVIDER_IDS.map((agentId) => createProviderDefinitionContract(agentId)));
const PROVIDER_DEFINITION_CONTRACTS_BY_ID = new Map<string, ProviderDefinitionContractV1>(
  PROVIDER_DEFINITION_CONTRACTS.map((definition) => [definition.id, definition]),
);

export type ProviderArtifacts = Readonly<{
  defaultAgentId: AgentId;
  providerIds: readonly AgentId[];
  providerDefinitions: readonly ProviderCatalogDefinition[];
  providerDefinitionsById: ReadonlyMap<AgentId, ProviderCatalogDefinition>;
  providerDefinitionContracts: readonly ProviderDefinitionContractV1[];
  providerDefinitionContractsById: ReadonlyMap<string, ProviderDefinitionContractV1>;
  agentCliSetupSupportedIds: readonly AgentId[];
  agentCliSetupRecommendedIds: readonly AgentId[];
  agentsCore: typeof CANONICAL_AGENTS_CORE;
  sessionModeDescriptors: typeof CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS;
  sessionModes: typeof CANONICAL_AGENT_SESSION_MODES;
  modelConfig: typeof CANONICAL_AGENT_MODEL_CONFIG;
  localCliConfig: typeof CANONICAL_AGENT_LOCAL_CLI_CONFIG;
  authProbeConfig: typeof CANONICAL_AGENT_AUTH_PROBE_CONFIG;
  builtInAcpConfig: typeof BUILT_IN_ACP_CONFIG;
  agentCliRuntimeSpecs: typeof CANONICAL_AGENT_CLI_RUNTIME_SPECS;
}>;

export function buildProviderArtifacts(): ProviderArtifacts {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    providerIds: AGENT_PROVIDER_IDS,
    providerDefinitions: PROVIDER_DEFINITIONS,
    providerDefinitionsById: PROVIDER_DEFINITIONS_BY_ID,
    providerDefinitionContracts: PROVIDER_DEFINITION_CONTRACTS,
    providerDefinitionContractsById: PROVIDER_DEFINITION_CONTRACTS_BY_ID,
    agentCliSetupSupportedIds: getAgentCliSetupSupportedIds(),
    agentCliSetupRecommendedIds: getAgentCliSetupRecommendedIds(),
    agentsCore: CANONICAL_AGENTS_CORE,
    sessionModeDescriptors: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
    sessionModes: CANONICAL_AGENT_SESSION_MODES,
    modelConfig: CANONICAL_AGENT_MODEL_CONFIG,
    localCliConfig: CANONICAL_AGENT_LOCAL_CLI_CONFIG,
    authProbeConfig: CANONICAL_AGENT_AUTH_PROBE_CONFIG,
    builtInAcpConfig: BUILT_IN_ACP_CONFIG,
    agentCliRuntimeSpecs: CANONICAL_AGENT_CLI_RUNTIME_SPECS,
  };
}

export const PROVIDER_ARTIFACTS = buildProviderArtifacts();
