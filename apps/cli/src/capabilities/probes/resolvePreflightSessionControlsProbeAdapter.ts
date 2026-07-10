import { AGENTS } from '@/agent/catalog/registry';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';

import type { PreflightSessionControlsProbeAdapter } from './preflightSessionControlsProbeAdapterTypes';

export async function resolvePreflightSessionControlsProbeAdapter(
  agentId: CatalogAgentLookupId,
): Promise<PreflightSessionControlsProbeAdapter | null> {
  const entry = AGENTS[agentId];
  if (!entry?.getPreflightSessionControlsProbeAdapter) return null;
  return await entry.getPreflightSessionControlsProbeAdapter().catch(() => null);
}
