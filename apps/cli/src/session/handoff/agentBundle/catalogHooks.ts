import { AGENTS } from '@/agent/catalog/registry';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  SessionHandoffAgentBundleRecordExtractor,
} from '@/agent/catalog/types';

const cachedSessionHandoffAgentBundleRecordExtractorPromises = new Map<
  CatalogAgentId,
  Promise<SessionHandoffAgentBundleRecordExtractor | null>
>();

export async function getSessionHandoffAgentBundleRecordExtractor(
  agentId?: string | null,
): Promise<SessionHandoffAgentBundleRecordExtractor | null> {
  const rawAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  const baseAgentId = rawAgentId.split('-')[0] ?? '';
  if (!isCatalogAgentId(baseAgentId)) {
    return null;
  }
  const catalogId = baseAgentId;
  const existing = cachedSessionHandoffAgentBundleRecordExtractorPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionHandoffAgentBundleRecordExtractor
    ? entry.getSessionHandoffAgentBundleRecordExtractor()
    : Promise.resolve(null);
  cachedSessionHandoffAgentBundleRecordExtractorPromises.set(catalogId, promise);
  return await promise;
}
