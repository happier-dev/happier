import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  sessionId: string;
}>): Promise<SpawnSessionOptions | null> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(params.linked.providerId)).directSessions;
  if (!providerOps) return null;
  return await providerOps.resolveTakeoverSpawnOptions(params);
}
