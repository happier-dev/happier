import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { AGENTS } from '@/agent/catalog/registry';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import type { PreflightSessionControlsProbeAdapter } from './preflightSessionControlsProbeAdapterTypes';

export async function resolvePreflightSessionControlsProbeAdapter(
  agentId: CatalogAgentLookupId,
  catalogEntry?: AgentCatalogEntry | null,
): Promise<PreflightSessionControlsProbeAdapter | null> {
  const entry = catalogEntry === undefined ? AGENTS[agentId] : catalogEntry;
  if (!entry?.getPreflightSessionControlsProbeAdapter) return null;
  return await entry.getPreflightSessionControlsProbeAdapter();
}
