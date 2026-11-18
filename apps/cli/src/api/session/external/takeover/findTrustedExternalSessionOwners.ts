import { resolveDeclaredAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { ExternalSessionsAgentId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

function extractProviderSessionIdFromMarkerMetadata(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  marker: DaemonSessionMarker;
}>): string | null {
  const { metadata, flavor } = params.marker;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rec = metadata as Record<string, unknown>;
  // A local runtime declaration identifies this process. Linked Session metadata only describes a link.
  const declaredAgentId = resolveDeclaredAgentIdFromSessionMetadata(rec, null);
  if (declaredAgentId !== null) {
    if (declaredAgentId !== params.agentId) return null;
  } else {
    const legacyFlavor = typeof rec.flavor === 'string' ? rec.flavor.trim() : '';
    if (flavor !== params.agentId || (legacyFlavor && legacyFlavor !== params.agentId)) return null;
  }
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
    .filter(
      (marker) =>
        extractProviderSessionIdFromMarkerMetadata({
          agentId: params.agentId,
          marker,
        }) === remoteSessionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || b.pid - a.pid);

  return candidates;
}
