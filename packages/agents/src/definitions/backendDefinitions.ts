import type { AgentId } from '../types.js';
import { BACKEND_ARTIFACTS } from './buildBackendArtifacts.js';
import type { BackendCatalogDefinition } from './types.js';

export function getAllBackendCatalogDefinitions(): readonly BackendCatalogDefinition[] {
  return BACKEND_ARTIFACTS.backendDefinitions;
}

export function getBackendCatalogDefinition(agentId: AgentId): BackendCatalogDefinition | null {
  return BACKEND_ARTIFACTS.backendDefinitionsById.get(agentId) ?? null;
}

export function getAllBackendDefinitionContracts() {
  return BACKEND_ARTIFACTS.backendDefinitionContracts;
}

export function getBackendDefinitionContract(agentId: AgentId) {
  return BACKEND_ARTIFACTS.backendDefinitionContractsById.get(agentId) ?? null;
}
