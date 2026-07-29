import { readCatalogEntriesSnapshot } from '@/agent/catalog/registry';
import type {
  CatalogAgentId,
  ManagedServerClaimDescriptor,
  ManagedServerShutdownCleanup,
  AgentCliLaunchSpec,
} from '@/agent/catalog/types';

const cachedManagedServerLaunchSpecPromises = new Map<CatalogAgentId, Promise<AgentCliLaunchSpec | null>>();
const cachedManagedServerShutdownCleanupPromises = new Map<CatalogAgentId, Promise<ManagedServerShutdownCleanup | null>>();

export async function getManagedServerLaunchSpec(agentId: CatalogAgentId): Promise<AgentCliLaunchSpec | null> {
  const existing = cachedManagedServerLaunchSpecPromises.get(agentId);
  if (existing) return await existing;

  const entry = readCatalogEntriesSnapshot()[agentId];
  const promise = entry?.getManagedServerLaunchSpec ? entry.getManagedServerLaunchSpec() : Promise.resolve(null);
  cachedManagedServerLaunchSpecPromises.set(agentId, promise);
  return await promise;
}

export async function getManagedServerShutdownCleanup(
  agentId: CatalogAgentId,
): Promise<ManagedServerShutdownCleanup | null> {
  const existing = cachedManagedServerShutdownCleanupPromises.get(agentId);
  if (existing) return await existing;

  const entry = readCatalogEntriesSnapshot()[agentId];
  const promise = entry?.getManagedServerShutdownCleanup
    ? entry.getManagedServerShutdownCleanup()
    : Promise.resolve(null);
  cachedManagedServerShutdownCleanupPromises.set(agentId, promise);
  return await promise;
}

export async function listManagedServerClaimDescriptors(): Promise<readonly ManagedServerClaimDescriptor[]> {
  const entries = readCatalogEntriesSnapshot();
  const descriptors = await Promise.all(Object.values(entries).map(async (entry) => (
    entry.getManagedServerClaimDescriptor ? await entry.getManagedServerClaimDescriptor() : null
  )));
  return Object.freeze(descriptors.filter((descriptor): descriptor is ManagedServerClaimDescriptor => Boolean(descriptor)));
}
