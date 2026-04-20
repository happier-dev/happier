import { requireCatalogEntry, type CatalogAgentLookupId } from '@/backends/catalog';
import type { DaemonSpawnValidationResult } from '@/daemon/spawnHooks';

export async function validateCatalogAcpProbeSpawn(agentId: CatalogAgentLookupId): Promise<DaemonSpawnValidationResult> {
  const entry = requireCatalogEntry(agentId);
  if (!entry.getAcpBackendFactory || !entry.getDaemonSpawnHooks) {
    return { ok: true };
  }

  const daemonSpawnHooks = await entry.getDaemonSpawnHooks();
  if (!daemonSpawnHooks.resolveRuntimePrerequisites) {
    return { ok: true };
  }

  return await daemonSpawnHooks.resolveRuntimePrerequisites({ codexBackendMode: 'acp' });
}
