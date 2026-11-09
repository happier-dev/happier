import { isRuntimeCheckedExperimentalVendorResume } from '@happier-dev/agents/manifest';

import { readCurrentCatalogHook, readRegistryCatalogHook } from '@/agent/catalog/runtimeEntry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  AgentCatalogEntry,
  CatalogAgentId,
  ProviderSessionRuntimePreferences,
  VendorResumeSupportFn,
} from '@/agent/catalog/types';
import type { AgentCliSessionCommandBuildInputV1 } from '@happier-dev/plugin-sdk/agents/runtime';

/** Applies the same resume policy to a current catalog or an admitted retained entry. */
export async function getCatalogEntryVendorResumeSupport(entry: AgentCatalogEntry): Promise<VendorResumeSupportFn> {
  if (entry.vendorResumeSupport === 'supported') return () => true;
  if (entry.vendorResumeSupport === 'unsupported') return () => false;
  if (entry.vendorResumeSupport === 'experimental' && entry.getVendorResumeSupport) {
    return await entry.getVendorResumeSupport();
  }
  if (isRuntimeCheckedExperimentalVendorResume(entry.id)) return () => true;
  return () => false;
}

export async function getVendorResumeSupport(
  agentId?: CatalogAgentId | null,
  registry?: ResolvedExecutablePluginRuntimeRegistry,
): Promise<VendorResumeSupportFn> {
  const catalogId = registry ? agentId : resolveCatalogAgentId(agentId);
  if (!catalogId) return () => false;
  // Demand the current Agent runtime through the shared catalog owner. A
  // declaration-only snapshot does not contain lazily registered predicates.
  return (registry
    ? await readRegistryCatalogHook(registry, catalogId, getCatalogEntryVendorResumeSupport)
    : await readCurrentCatalogHook(catalogId, getCatalogEntryVendorResumeSupport)) ?? (() => false);
}

export async function resolveProviderSessionRuntimePreferences(
  agentId: CatalogAgentId | null | undefined,
  params: AgentCliSessionCommandBuildInputV1,
): Promise<ProviderSessionRuntimePreferences> {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return {};
  return await readCurrentCatalogHook(catalogId, (entry) => (
    entry.resolveSessionRuntimePreferences?.(params) ?? Promise.resolve({})
  )) ?? {};
}
