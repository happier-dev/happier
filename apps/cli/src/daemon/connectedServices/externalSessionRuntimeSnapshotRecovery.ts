import {
  getAgentResumeConfig,
  readProviderSessionIdSessionState,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  ExternalSessionsAgentIdSchema,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionsAgentId,
  type SessionMetadata,
} from '@happier-dev/protocol';

import { listSessionMarkers, type DaemonSessionMarker } from '@/daemon/sessionRegistry';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from './connectedServiceRuntimeSnapshot';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeExternalSessionsAgentId(value: unknown): ExternalSessionsAgentId | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) return null;
  const parsed = ExternalSessionsAgentIdSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function resolveMetadataProviderId(value: unknown): ExternalSessionsAgentId | null {
  return normalizeExternalSessionsAgentId(resolveAgentIdFromSessionMetadata(value));
}

function resolveMarkerProviderId(marker: DaemonSessionMarker): ExternalSessionsAgentId | null {
  const metadataProviderId = resolveMetadataProviderId(marker.metadata);
  if (metadataProviderId) return metadataProviderId;

  const markerFlavorProviderId = normalizeExternalSessionsAgentId(marker.flavor);
  if (markerFlavorProviderId) return markerFlavorProviderId;

  const respawnProviderId = resolveMetadataProviderId(marker.respawn);
  if (respawnProviderId) return respawnProviderId;

  const respawn = readRecord(marker.respawn);
  const backendTarget = readRecord(respawn?.backendTarget);
  return normalizeExternalSessionsAgentId(backendTarget?.backendId)
    ?? normalizeExternalSessionsAgentId(backendTarget?.agentId);
}

function readProviderResumeFieldSessionId(
  metadata: Readonly<Record<string, unknown>>,
  agentId: ExternalSessionsAgentId,
): string | null {
  const resume = getAgentResumeConfig(agentId);
  if (!resume) return null;
  const field = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  return field ? normalizeNullableString(metadata[field]) : null;
}

function readExternalSessionRemoteSessionId(
  metadata: Readonly<Record<string, unknown>>,
  agentId: ExternalSessionsAgentId,
): string | null {
  const externalSession = readLinkedExternalSessionV1FromMetadata(metadata);
  if (externalSession?.agentId !== agentId) return null;
  return normalizeNullableString(externalSession.remoteSessionId);
}

function readProviderSessionIdForProvider(value: unknown, agentId: ExternalSessionsAgentId): string | null {
  const metadata = readRecord(value);
  if (!metadata) return null;

  const externalSessionRemoteSessionId = readExternalSessionRemoteSessionId(metadata, agentId);
  if (externalSessionRemoteSessionId) return externalSessionRemoteSessionId;

  const stateValue = readProviderSessionIdSessionState(metadata as SessionMetadata).value;
  if (stateValue && resolveMetadataProviderId(metadata) === agentId) {
    return stateValue;
  }

  return readProviderResumeFieldSessionId(metadata, agentId);
}

function resolveMarkerRemoteSessionId(
  marker: DaemonSessionMarker,
  agentId: ExternalSessionsAgentId,
): string | null {
  const respawn = readRecord(marker.respawn);
  return normalizeNullableString(respawn?.resume)
    ?? readProviderSessionIdForProvider(marker.metadata, agentId)
    ?? readProviderSessionIdForProvider(marker.respawn, agentId);
}

function markerMatchesExternalSession(
  marker: DaemonSessionMarker,
  agentId: ExternalSessionsAgentId,
  remoteSessionId: string,
): boolean {
  return resolveMarkerProviderId(marker) === agentId
    && resolveMarkerRemoteSessionId(marker, agentId) === remoteSessionId;
}

function resolveMarkerConnectedServiceRuntimeSnapshot(marker: DaemonSessionMarker): ConnectedServiceRuntimeSnapshot {
  return mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(marker.respawn),
    readConnectedServiceRuntimeSnapshot(marker.metadata),
  );
}

/**
 * Resolve the Connected Services a linked external session must run under.
 *
 * Ownership is proven by the Agent plus the native session identity a Session
 * marker carries. Directory coincidence is not ownership: markers are
 * Session/PID-owned, and two sessions in one repository may legitimately run
 * under different Connected Service profiles, so an unmatched marker never
 * contributes credentials.
 */
export async function resolveConnectedServiceRuntimeSnapshotForExternalSession(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
}>): Promise<ConnectedServiceRuntimeSnapshot> {
  const markers = await listSessionMarkers().catch(() => [] as DaemonSessionMarker[]);
  return markers
    .filter((marker) => markerMatchesExternalSession(marker, params.agentId, params.remoteSessionId))
    .map((marker) => ({ marker, snapshot: resolveMarkerConnectedServiceRuntimeSnapshot(marker) }))
    .filter((entry) => hasConnectedServiceBindings(entry.snapshot))
    .sort((left, right) => right.marker.updatedAt - left.marker.updatedAt)[0]
    ?.snapshot ?? {};
}
