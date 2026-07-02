import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

function extractProviderSessionIdFromMarkerMetadata(params: Readonly<{
  providerId: ExternalSessionsProviderId;
  metadata: unknown;
}>): string | null {
  if (!params.metadata || typeof params.metadata !== 'object' || Array.isArray(params.metadata)) return null;
  const rec = params.metadata as Record<string, unknown>;
  const expectedFlavor = typeof rec.flavor === 'string' ? rec.flavor.trim() : '';
  if (expectedFlavor && expectedFlavor !== params.providerId) return null;
  return resolveVendorResumeIdFromSessionMetadata(params.providerId, rec);
}

export function findTrustedExternalSessionOwner(params: Readonly<{
  markers: readonly DaemonSessionMarker[];
  providerId: ExternalSessionsProviderId;
  remoteSessionId: string;
  isPidAlive?: (pid: number) => boolean;
}>): DaemonSessionMarker | null {
  const isPidAlive = params.isPidAlive ?? (() => true);
  const remoteSessionId = String(params.remoteSessionId ?? '').trim();
  if (!remoteSessionId) return null;

  const candidates = params.markers
    .filter((marker) => Number.isFinite(marker.pid) && marker.pid > 0 && isPidAlive(marker.pid))
    .filter((marker) => marker.flavor === params.providerId)
    .filter(
      (marker) =>
        extractProviderSessionIdFromMarkerMetadata({
          providerId: params.providerId,
          metadata: marker.metadata,
        }) === remoteSessionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || b.pid - a.pid);

  return candidates[0] ?? null;
}
