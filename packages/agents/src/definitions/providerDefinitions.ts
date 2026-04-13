import type { AgentId } from '../types.js';
import { PROVIDER_ARTIFACTS } from './buildProviderArtifacts.js';
import type { ProviderDefinition } from './types.js';

export function getAllProviderDefinitions(): readonly ProviderDefinition[] {
  return PROVIDER_ARTIFACTS.providerDefinitions;
}

export function getProviderDefinition(agentId: AgentId): ProviderDefinition | null {
  return PROVIDER_ARTIFACTS.providerDefinitionsById.get(agentId) ?? null;
}

export function getAllProviderDefinitionContracts() {
  return PROVIDER_ARTIFACTS.providerDefinitionContracts;
}

export function getProviderDefinitionContract(agentId: AgentId) {
  return PROVIDER_ARTIFACTS.providerDefinitionContractsById.get(agentId) ?? null;
}
