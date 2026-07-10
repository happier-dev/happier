import { AGENT_IDS, type AgentId } from '../types.js';
import type { BackendCatalogDefinition, BackendDefinitionContractV1 } from './types.js';
import { AGENT_ARTIFACTS } from './buildAgentArtifacts.js';
import { isConcreteBackendDefinitionAgentId } from './resolveBackendOwnership.js';
import { buildEngineSpecFromRuntimeKindsManifest } from '../runtime/engine/contracts.js';

export const BACKEND_DEFINITION_AGENT_IDS: readonly AgentId[] = AGENT_IDS.filter(isConcreteBackendDefinitionAgentId);

function createBackendDefinition(agentId: AgentId): BackendCatalogDefinition {
  const agent = AGENT_ARTIFACTS.agentDefinitionsById.get(agentId);
  if (agent === null || agent === undefined) {
    throw new Error(`Missing agent definition for backend definition: ${agentId}`);
  }

  return {
    id: agentId,
    agentId,
    agent,
    engine: buildEngineSpecFromRuntimeKindsManifest({
      engineId: agentId,
      runtimeKindsManifest: agent.core.runtimeKinds ?? null,
    }),
    runtimeKinds: agent.core.runtimeKinds ?? null,
  };
}

const BACKEND_DEFINITIONS = Object.freeze(BACKEND_DEFINITION_AGENT_IDS.map((agentId) => createBackendDefinition(agentId)));
const BACKEND_DEFINITIONS_BY_ID = new Map<AgentId, BackendCatalogDefinition>(
  BACKEND_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const BACKEND_DEFINITION_CONTRACTS = Object.freeze(BACKEND_DEFINITION_AGENT_IDS.map((agentId) => ({
  kindVersion: 1 as const,
  id: agentId,
  agentId,
} satisfies BackendDefinitionContractV1)));
const BACKEND_DEFINITION_CONTRACTS_BY_ID = new Map<string, BackendDefinitionContractV1>(
  BACKEND_DEFINITION_CONTRACTS.map((definition) => [definition.id, definition]),
);

export type BackendArtifacts = Readonly<{
  backendDefinitions: readonly BackendCatalogDefinition[];
  backendDefinitionsById: ReadonlyMap<AgentId, BackendCatalogDefinition>;
  backendDefinitionContracts: readonly BackendDefinitionContractV1[];
  backendDefinitionContractsById: ReadonlyMap<string, BackendDefinitionContractV1>;
}>;

export function buildBackendArtifacts(): BackendArtifacts {
  return {
    backendDefinitions: BACKEND_DEFINITIONS,
    backendDefinitionsById: BACKEND_DEFINITIONS_BY_ID,
    backendDefinitionContracts: BACKEND_DEFINITION_CONTRACTS,
    backendDefinitionContractsById: BACKEND_DEFINITION_CONTRACTS_BY_ID,
  };
}

export const BACKEND_ARTIFACTS = buildBackendArtifacts();
