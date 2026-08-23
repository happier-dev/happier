import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { getDirectSessionProviderOps } from '@/backends/catalog';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import { listSessionMarkers, type DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { directSessionMarkerMatches } from '@/api/directSessions/markers/readDirectSessionMarkerIdentity';
import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';

function markerMatchesDirectSession(
  marker: DaemonSessionMarker,
  linked: LoadedLinkedDirectSession,
): boolean {
  return directSessionMarkerMatches({
    marker,
    providerId: linked.providerId,
    remoteSessionId: linked.remoteSessionId,
  });
}

async function resolveTrackedConnectedServiceRuntimeSnapshot(
  linked: LoadedLinkedDirectSession,
): Promise<ConnectedServiceRuntimeSnapshot> {
  const markers = await listSessionMarkers().catch(() => [] as DaemonSessionMarker[]);
  const matches = markers
    .filter((marker) => markerMatchesDirectSession(marker, linked))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  for (const marker of matches) {
    const snapshot = mergeConnectedServiceRuntimeSnapshots(
      readConnectedServiceRuntimeSnapshot(marker.respawn),
      readConnectedServiceRuntimeSnapshot(marker.metadata),
    );
    if (hasConnectedServiceBindings(snapshot)) return snapshot;
  }
  return {};
}

export async function resolveDirectTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedDirectSession;
  sessionId: string;
}>): Promise<SpawnSessionOptions | null> {
  const spawnOptions = await (await getDirectSessionProviderOps(params.linked.providerId)).resolveTakeoverSpawnOptions(params);
  if (!spawnOptions) return null;
  const snapshot = mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(params.linked.metadata),
    await resolveTrackedConnectedServiceRuntimeSnapshot(params.linked),
  );
  return hasConnectedServiceBindings(snapshot)
    ? { ...spawnOptions, ...snapshot }
    : spawnOptions;
}
