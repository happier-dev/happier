import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import {
  resolveConnectedServiceRuntimeSnapshotForExternalSession,
} from '@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  sessionId: string;
}>): Promise<SpawnSessionOptions | null> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(params.linked.providerId)).externalSession;
  if (!providerOps?.resolveTakeoverSpawnOptions) return null;
  const spawnOptions = await providerOps.resolveTakeoverSpawnOptions(params);
  if (!spawnOptions) return null;
  const snapshot = mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(params.linked.metadata),
    await resolveConnectedServiceRuntimeSnapshotForExternalSession({
      providerId: params.linked.providerId,
      remoteSessionId: params.linked.remoteSessionId,
    }),
  );
  return hasConnectedServiceBindings(snapshot)
    ? { ...spawnOptions, ...snapshot }
    : spawnOptions;
}
