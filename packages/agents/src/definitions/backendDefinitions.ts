import type { AgentId } from '../types.js';
import { BACKEND_ARTIFACTS } from './buildBackendArtifacts.js';
import type { BackendDefinition } from './types.js';

export function getAllBackendDefinitions(): readonly BackendDefinition[] {
  return BACKEND_ARTIFACTS.backendDefinitions;
}

export function getBackendDefinition(agentId: AgentId): BackendDefinition | null {
  return BACKEND_ARTIFACTS.backendDefinitionsById.get(agentId) ?? null;
}

export function getAllBackendDefinitionContracts() {
  return BACKEND_ARTIFACTS.backendDefinitionContracts;
}

export function getBackendDefinitionContract(agentId: AgentId) {
  return BACKEND_ARTIFACTS.backendDefinitionContractsById.get(agentId) ?? null;
}
