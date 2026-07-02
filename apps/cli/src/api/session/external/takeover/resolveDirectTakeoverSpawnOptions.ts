import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  sessionId: string;
}>): Promise<SpawnSessionOptions | null> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(params.linked.providerId)).externalSession;
  if (!providerOps?.resolveTakeoverSpawnOptions) return null;
  return await providerOps.resolveTakeoverSpawnOptions(params);
}
