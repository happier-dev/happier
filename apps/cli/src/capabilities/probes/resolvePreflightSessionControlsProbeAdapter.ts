import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentLookupId } from '@/backends/types';

import type { PreflightSessionControlsProbeAdapter } from './preflightSessionControlsProbeAdapterTypes';

export async function resolvePreflightSessionControlsProbeAdapter(
  agentId: CatalogAgentLookupId,
): Promise<PreflightSessionControlsProbeAdapter | null> {
  const entry = AGENTS[agentId];
  if (!entry?.getPreflightSessionControlsProbeAdapter) return null;
  return await entry.getPreflightSessionControlsProbeAdapter().catch(() => null);
}
