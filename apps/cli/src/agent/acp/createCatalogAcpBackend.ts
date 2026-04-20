import { hasBuiltInAcpConfig, isAgentId } from '@happier-dev/agents';

import type { AgentFactoryOptions } from '@/agent/core';
import { requireCatalogEntry, type CatalogAgentLookupId } from '@/backends/catalog';
import type { CatalogAcpBackendCreateResult, CatalogAcpBackendFactory } from '@/backends/types';
import { loadBuiltInRuntimeOwners } from './catalog/builtIn/runtimeOwners';

const cachedFactoryPromises = new Map<CatalogAgentLookupId, Promise<CatalogAcpBackendFactory>>();

async function loadCatalogAcpFactory(agentId: CatalogAgentLookupId): Promise<CatalogAcpBackendFactory> {
  if (isAgentId(agentId) && hasBuiltInAcpConfig(agentId)) {
    const runtimeOwners = await loadBuiltInRuntimeOwners(agentId);
    return (opts) => ({ backend: runtimeOwners.createRuntime(opts) });
  }

  const entry = requireCatalogEntry(agentId);
  if (!entry.getAcpBackendFactory) {
    throw new Error(`Agent '${agentId}' does not support ACP backends`);
  }
  return await entry.getAcpBackendFactory();
}

async function getCatalogAcpFactory(agentId: CatalogAgentLookupId): Promise<CatalogAcpBackendFactory> {
  const existing = cachedFactoryPromises.get(agentId);
  if (existing) return await existing;

  const promise = loadCatalogAcpFactory(agentId);
  cachedFactoryPromises.set(agentId, promise);
  return await promise;
}

export async function createCatalogAcpBackend<
  TOptions extends AgentFactoryOptions,
  TResult extends CatalogAcpBackendCreateResult = CatalogAcpBackendCreateResult,
>(
  agentId: CatalogAgentLookupId,
  opts: TOptions,
): Promise<TResult> {
  const factory = await getCatalogAcpFactory(agentId);
  return factory(opts) as TResult;
}
