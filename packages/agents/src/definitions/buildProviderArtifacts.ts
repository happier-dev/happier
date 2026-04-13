import { AGENT_IDS, type AgentId } from '../types.js';
import { AGENTS_CORE, DEFAULT_AGENT_ID } from '../manifest.js';
import { AGENT_SESSION_MODE_DESCRIPTORS, AGENT_SESSION_MODES } from '../sessionModes.js';
import { AGENT_MODEL_CONFIG } from '../models.js';
import { AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { AGENT_AUTH_PROBE_CONFIG } from '../auth.js';
import { BUILT_IN_ACP_CONFIG } from '../acp.js';
import { PROVIDER_CLI_RUNTIME_SPECS, getProviderCliSetupRecommendedIds, getProviderCliSetupSupportedIds } from '../providers/providerCliRuntime.js';
import { getProviderSettingsDefinition } from '../providerSettings/index.js';
import type { ProviderDefinition, ProviderDefinitionContractV1 } from './types.js';
import { resolveOwnedBackendIdsForAgent } from './resolveBackendOwnership.js';

function createProviderDefinition(agentId: AgentId): ProviderDefinition {
  return {
    id: agentId,
    core: AGENTS_CORE[agentId],
    sessionModeDescriptor: AGENT_SESSION_MODE_DESCRIPTORS[agentId],
    sessionModesKind: AGENT_SESSION_MODES[agentId],
    modelConfig: AGENT_MODEL_CONFIG[agentId],
    localCli: AGENT_LOCAL_CLI_CONFIG[agentId],
    providerCliRuntime: PROVIDER_CLI_RUNTIME_SPECS[agentId],
    providerSettings: getProviderSettingsDefinition(agentId),
  };
}

function createProviderDefinitionContract(agentId: AgentId): ProviderDefinitionContractV1 {
  return {
    kindVersion: 1,
    id: agentId,
    ownedBackendIds: Object.freeze(resolveOwnedBackendIdsForAgent(agentId)),
  };
}

const PROVIDER_DEFINITIONS = Object.freeze(AGENT_IDS.map((agentId) => createProviderDefinition(agentId)));
const PROVIDER_DEFINITIONS_BY_ID = new Map<AgentId, ProviderDefinition>(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const PROVIDER_DEFINITION_CONTRACTS = Object.freeze(AGENT_IDS.map((agentId) => createProviderDefinitionContract(agentId)));
const PROVIDER_DEFINITION_CONTRACTS_BY_ID = new Map<string, ProviderDefinitionContractV1>(
  PROVIDER_DEFINITION_CONTRACTS.map((definition) => [definition.id, definition]),
);

export type ProviderArtifacts = Readonly<{
  defaultAgentId: AgentId;
  providerIds: readonly AgentId[];
  providerDefinitions: readonly ProviderDefinition[];
  providerDefinitionsById: ReadonlyMap<AgentId, ProviderDefinition>;
  providerDefinitionContracts: readonly ProviderDefinitionContractV1[];
  providerDefinitionContractsById: ReadonlyMap<string, ProviderDefinitionContractV1>;
  providerCliSetupSupportedIds: readonly AgentId[];
  providerCliSetupRecommendedIds: readonly AgentId[];
  agentsCore: typeof AGENTS_CORE;
  sessionModeDescriptors: typeof AGENT_SESSION_MODE_DESCRIPTORS;
  sessionModes: typeof AGENT_SESSION_MODES;
  modelConfig: typeof AGENT_MODEL_CONFIG;
  localCliConfig: typeof AGENT_LOCAL_CLI_CONFIG;
  authProbeConfig: typeof AGENT_AUTH_PROBE_CONFIG;
  builtInAcpConfig: typeof BUILT_IN_ACP_CONFIG;
  providerCliRuntimeSpecs: typeof PROVIDER_CLI_RUNTIME_SPECS;
}>;

export function buildProviderArtifacts(): ProviderArtifacts {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    providerIds: AGENT_IDS,
    providerDefinitions: PROVIDER_DEFINITIONS,
    providerDefinitionsById: PROVIDER_DEFINITIONS_BY_ID,
    providerDefinitionContracts: PROVIDER_DEFINITION_CONTRACTS,
    providerDefinitionContractsById: PROVIDER_DEFINITION_CONTRACTS_BY_ID,
    providerCliSetupSupportedIds: getProviderCliSetupSupportedIds(),
    providerCliSetupRecommendedIds: getProviderCliSetupRecommendedIds(),
    agentsCore: AGENTS_CORE,
    sessionModeDescriptors: AGENT_SESSION_MODE_DESCRIPTORS,
    sessionModes: AGENT_SESSION_MODES,
    modelConfig: AGENT_MODEL_CONFIG,
    localCliConfig: AGENT_LOCAL_CLI_CONFIG,
    authProbeConfig: AGENT_AUTH_PROBE_CONFIG,
    builtInAcpConfig: BUILT_IN_ACP_CONFIG,
    providerCliRuntimeSpecs: PROVIDER_CLI_RUNTIME_SPECS,
  };
}

export const PROVIDER_ARTIFACTS = buildProviderArtifacts();
