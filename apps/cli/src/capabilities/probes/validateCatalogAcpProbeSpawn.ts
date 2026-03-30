import { requireCatalogEntry, type CatalogAgentId } from '@/backends/catalog';
import type { DaemonSpawnValidationResult } from '@/daemon/spawnHooks';

export async function validateCatalogAcpProbeSpawn(agentId: CatalogAgentId): Promise<DaemonSpawnValidationResult> {
  const entry = requireCatalogEntry(agentId);
  if (!entry.getAcpBackendFactory || !entry.getDaemonSpawnHooks) {
    return { ok: true };
  }

  const daemonSpawnHooks = await entry.getDaemonSpawnHooks();
  if (!daemonSpawnHooks.validateSpawn) {
    return { ok: true };
  }

  return await daemonSpawnHooks.validateSpawn({ experimentalCodexAcp: true });
}
