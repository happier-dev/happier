import { AGENT_IDS, type AgentId, type BundledAgentId } from '../types.js';
import { CANONICAL_AGENTS_CORE, DEFAULT_AGENT_ID } from '../manifest.js';
import {
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
} from '../sessionModes.js';
import { CANONICAL_AGENT_MODEL_CONFIG } from '../models.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { BUILT_IN_ACP_CONFIG } from '../acp.js';
import {
  getAgentCliSetupRecommendedIds,
  getAgentCliSetupSupportedIds,
} from '../cli/runtime.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';
import type { AgentCatalogDefinition, AgentDefinitionContractV1 } from './types.js';
import { resolveOwnedBackendIdsForAgent } from './resolveBackendOwnership.js';

function createAgentCatalogDefinition(agentId: BundledAgentId): AgentCatalogDefinition {
  const bundledDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
  const settingsBackendId = bundledDefinition
    && 'settingsBackendId' in bundledDefinition
    && typeof bundledDefinition.settingsBackendId === 'string'
      ? bundledDefinition.settingsBackendId
      : null;
  return {
    id: agentId,
    settingsBackendId: typeof settingsBackendId === 'string' && settingsBackendId.trim().length > 0
      ? settingsBackendId
      : null,
    core: CANONICAL_AGENTS_CORE[agentId],
    sessionModeDescriptor: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS[agentId],
    sessionModesKind: CANONICAL_AGENT_SESSION_MODES[agentId],
    modelConfig: CANONICAL_AGENT_MODEL_CONFIG[agentId],
    localCli: CANONICAL_AGENT_LOCAL_CLI_CONFIG[agentId],
  };
}

function createAgentDefinitionContract(agentId: BundledAgentId): AgentDefinitionContractV1 {
  const bundledDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
  const enablementCompatibilityBackendIds = bundledDefinition
    && 'enablementCompatibilityBackendIds' in bundledDefinition
    && Array.isArray(bundledDefinition.enablementCompatibilityBackendIds)
      ? bundledDefinition.enablementCompatibilityBackendIds
          .map((backendId) => (typeof backendId === 'string' ? backendId.trim() : ''))
          .filter((backendId) => backendId.length > 0)
      : [];
  return {
    kindVersion: 1,
    id: agentId,
    ownedBackendIds: Object.freeze(resolveOwnedBackendIdsForAgent(agentId)),
    ...(enablementCompatibilityBackendIds.length > 0
      ? { enablementCompatibilityBackendIds: Object.freeze(enablementCompatibilityBackendIds) }
      : {}),
  };
}

const AGENT_CATALOG_DEFINITIONS = Object.freeze(AGENT_IDS.map((agentId) => createAgentCatalogDefinition(agentId)));
const AGENT_CATALOG_DEFINITIONS_BY_ID = new Map<AgentId, AgentCatalogDefinition>(
  AGENT_CATALOG_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const AGENT_DEFINITION_CONTRACTS = Object.freeze(AGENT_IDS.map((agentId) => createAgentDefinitionContract(agentId)));
const AGENT_DEFINITION_CONTRACTS_BY_ID = new Map<string, AgentDefinitionContractV1>(
  AGENT_DEFINITION_CONTRACTS.map((definition) => [definition.id, definition]),
);

export type AgentArtifacts = Readonly<{
  defaultAgentId: AgentId;
  agentIds: readonly AgentId[];
  agentDefinitions: readonly AgentCatalogDefinition[];
  agentDefinitionsById: ReadonlyMap<AgentId, AgentCatalogDefinition>;
  agentDefinitionContracts: readonly AgentDefinitionContractV1[];
  agentDefinitionContractsById: ReadonlyMap<string, AgentDefinitionContractV1>;
  agentCliSetupSupportedIds: readonly AgentId[];
  agentCliSetupRecommendedIds: readonly AgentId[];
  agentsCore: typeof CANONICAL_AGENTS_CORE;
  sessionModeDescriptors: typeof CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS;
  sessionModes: typeof CANONICAL_AGENT_SESSION_MODES;
  modelConfig: typeof CANONICAL_AGENT_MODEL_CONFIG;
  localCliConfig: typeof CANONICAL_AGENT_LOCAL_CLI_CONFIG;
  builtInAcpConfig: typeof BUILT_IN_ACP_CONFIG;
}>;

export function buildAgentArtifacts(): AgentArtifacts {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    agentIds: AGENT_IDS,
    agentDefinitions: AGENT_CATALOG_DEFINITIONS,
    agentDefinitionsById: AGENT_CATALOG_DEFINITIONS_BY_ID,
    agentDefinitionContracts: AGENT_DEFINITION_CONTRACTS,
    agentDefinitionContractsById: AGENT_DEFINITION_CONTRACTS_BY_ID,
    agentCliSetupSupportedIds: getAgentCliSetupSupportedIds(),
    agentCliSetupRecommendedIds: getAgentCliSetupRecommendedIds(),
    agentsCore: CANONICAL_AGENTS_CORE,
    sessionModeDescriptors: CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
    sessionModes: CANONICAL_AGENT_SESSION_MODES,
    modelConfig: CANONICAL_AGENT_MODEL_CONFIG,
    localCliConfig: CANONICAL_AGENT_LOCAL_CLI_CONFIG,
    builtInAcpConfig: BUILT_IN_ACP_CONFIG,
  };
}

export const AGENT_ARTIFACTS = buildAgentArtifacts();
