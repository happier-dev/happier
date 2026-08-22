import { isRuntimeCheckedExperimentalVendorResume } from '@happier-dev/agents';

import { AGENTS } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  ProviderSessionRuntimePreferences,
  ProviderSessionRuntimePreferencesParams,
  VendorResumeSupportFn,
} from '@/agent/catalog/types';

export async function getVendorResumeSupport(agentId?: CatalogAgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  // The active contribution registry may replace an installed Agent under the
  // same id. Keep this read current rather than retaining an old hook by id.
  const entry = catalogId ? AGENTS[catalogId] ?? null : null;
  // An Agent that is absent from the current catalog supports nothing: vendor
  // resume must fail closed rather than inherit the default Agent's support.
  if (!catalogId || !entry) {
    return () => false;
  }
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
}

export async function resolveProviderSessionRuntimePreferences(
  agentId: CatalogAgentId | null | undefined,
  params: ProviderSessionRuntimePreferencesParams,
): Promise<ProviderSessionRuntimePreferences> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = catalogId ? AGENTS[catalogId] ?? null : null;
  return await (entry?.resolveSessionRuntimePreferences?.(params) ?? Promise.resolve({}));
}
