import type { DirectSessionsProviderId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { directSessionMarkerMatches } from '@/api/directSessions/markers/readDirectSessionMarkerIdentity';

export function findTrustedDirectSessionOwner(params: Readonly<{
  markers: readonly DaemonSessionMarker[];
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  isPidAlive?: (pid: number) => boolean;
}>): DaemonSessionMarker | null {
  const isPidAlive = params.isPidAlive ?? (() => true);
  const remoteSessionId = String(params.remoteSessionId ?? '').trim();
  if (!remoteSessionId) return null;

  const candidates = params.markers
    .filter((marker) => Number.isFinite(marker.pid) && marker.pid > 0 && isPidAlive(marker.pid))
    .filter((marker) => directSessionMarkerMatches({ marker, providerId: params.providerId, remoteSessionId }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.pid - a.pid);

  return candidates[0] ?? null;
}
