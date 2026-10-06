import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { ExternalSessionsAgentId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

function extractProviderSessionIdFromMarkerMetadata(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  metadata: unknown;
}>): string | null {
  if (!params.metadata || typeof params.metadata !== 'object' || Array.isArray(params.metadata)) return null;
  const rec = params.metadata as Record<string, unknown>;
  const expectedFlavor = typeof rec.flavor === 'string' ? rec.flavor.trim() : '';
  if (expectedFlavor && expectedFlavor !== params.agentId) return null;
  return resolveVendorResumeIdFromSessionMetadata(params.agentId, rec);
}

export function findTrustedExternalSessionOwners(params: Readonly<{
  markers: readonly DaemonSessionMarker[];
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
}>): readonly DaemonSessionMarker[] {
  // The Agent minted this id and the marker persists it verbatim through
  // `resolveVendorResumeIdFromSessionMetadata`. Presence is the only judgement
  // here; re-canonicalizing the query would stop it matching its own owner.
  const remoteSessionId = readNonBlankOpaqueIdentifier(params.remoteSessionId);
  if (remoteSessionId === null) return [];

  const candidates = params.markers
    .filter((marker) => Number.isFinite(marker.pid) && marker.pid > 0)
    .filter((marker) => marker.flavor === params.agentId)
    .filter(
      (marker) =>
        extractProviderSessionIdFromMarkerMetadata({
          agentId: params.agentId,
          metadata: marker.metadata,
        }) === remoteSessionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || b.pid - a.pid);

  return candidates;
}
