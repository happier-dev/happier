import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { resolveCatalogAgentId } from '@/backends/catalog';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { TrackedSession } from '../types';

export function readBuiltInCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (target?.kind !== 'builtInAgent') return null;
  return (CATALOG_AGENT_IDS as readonly string[]).includes(target.agentId)
    ? resolveCatalogAgentId(target.agentId as CatalogAgentId)
    : null;
}

export function resolveTrackedSessionCatalogAgentId(tracked: TrackedSession): CatalogAgentId {
  if (tracked.spawnOptions?.backendTarget?.kind === 'configuredAcpBackend') return 'customAcp';
  const fromBackendTarget = readBuiltInCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
  if (fromBackendTarget) return fromBackendTarget;
  return resolveCatalogAgentId(resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook));
}
