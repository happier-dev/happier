import type { AgentId } from '@happier-dev/agents';
import { isRuntimeCheckedExperimentalVendorResume } from '@happier-dev/agents';

import { AGENTS, requireCatalogEntry } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  ProviderSessionRuntimePreferences,
  ProviderSessionRuntimePreferencesParams,
  VendorResumeSupportFn,
} from '@/agent/catalog/types';

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();

export async function getVendorResumeSupport(agentId?: AgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedVendorResumeSupportPromises.get(catalogId);
  if (existing) return await existing;

  const entry = requireCatalogEntry(catalogId);
  const promise = (async () => {
    if (entry.vendorResumeSupport === 'supported') {
      return () => true;
    }
    if (entry.vendorResumeSupport === 'unsupported') {
      return () => false;
    }
    if (entry.getVendorResumeSupport) {
      return await entry.getVendorResumeSupport();
    }
    if (isRuntimeCheckedExperimentalVendorResume(catalogId)) {
      return () => true;
    }
    return () => false;
  })();

  cachedVendorResumeSupportPromises.set(catalogId, promise);
  return await promise;
}

export async function resolveProviderSessionRuntimePreferences(
  agentId: AgentId | null | undefined,
  params: ProviderSessionRuntimePreferencesParams,
): Promise<ProviderSessionRuntimePreferences> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await (entry?.resolveSessionRuntimePreferences?.(params) ?? Promise.resolve({}));
}
