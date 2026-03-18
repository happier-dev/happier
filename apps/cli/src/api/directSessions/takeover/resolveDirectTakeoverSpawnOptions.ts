import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { getDirectSessionProviderOps } from '@/backends/catalog';
import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  sessionId: string;
}>): Promise<SpawnSessionOptions | null> {
  return await (await getDirectSessionProviderOps(params.linked.providerId)).resolveTakeoverSpawnOptions(params);
}
