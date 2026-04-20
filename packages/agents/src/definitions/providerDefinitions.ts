import type { AgentId } from '../types.js';
import { PROVIDER_ARTIFACTS } from './buildProviderArtifacts.js';
import type { ProviderCatalogDefinition } from './types.js';

export function getAllProviderDefinitions(): readonly ProviderCatalogDefinition[] {
  return PROVIDER_ARTIFACTS.providerDefinitions;
}

export function getProviderDefinition(agentId: AgentId): ProviderCatalogDefinition | null {
  return PROVIDER_ARTIFACTS.providerDefinitionsById.get(agentId) ?? null;
}

export function getAllProviderDefinitionContracts() {
  return PROVIDER_ARTIFACTS.providerDefinitionContracts;
}

export function getProviderDefinitionContract(agentId: AgentId) {
  return PROVIDER_ARTIFACTS.providerDefinitionContractsById.get(agentId) ?? null;
}
