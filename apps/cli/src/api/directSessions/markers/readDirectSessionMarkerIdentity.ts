import type { DirectSessionsProviderId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function readProviderId(value: unknown): DirectSessionsProviderId | null {
  const normalized = readString(value);
  return normalized === 'claude' || normalized === 'codex' || normalized === 'opencode' || normalized === 'pi'
    ? normalized
    : null;
}

export function readDirectSessionMarkerProviderId(marker: DaemonSessionMarker): DirectSessionsProviderId | null {
  const metadata = readRecord(marker.metadata);
  const respawn = readRecord(marker.respawn);
  const backendTarget = readRecord(respawn?.backendTarget);
  return readProviderId(metadata?.flavor)
    ?? readProviderId(marker.flavor)
    ?? readProviderId(backendTarget?.agentId);
}

export function readDirectSessionMarkerRemoteSessionId(
  marker: DaemonSessionMarker,
  providerId: DirectSessionsProviderId,
): string | null {
  const respawn = readRecord(marker.respawn);
  const resume = readString(respawn?.resume);
  if (resume) return resume;

  const metadata = readRecord(marker.metadata);
  const directSession = readRecord(metadata?.directSessionV1);
  if (readProviderId(directSession?.providerId) === providerId) {
    const directRemoteSessionId = readString(directSession?.remoteSessionId);
    if (directRemoteSessionId) return directRemoteSessionId;
  }

  const legacyId = readString(metadata?.[
    providerId === 'codex'
      ? 'codexSessionId'
      : providerId === 'claude'
        ? 'claudeSessionId'
        : providerId === 'opencode'
          ? 'opencodeSessionId'
          : 'piSessionId'
  ]);
  if (legacyId) return legacyId;

  const runtimeDescriptor = readRecord(metadata?.agentRuntimeDescriptorV1);
  if (readProviderId(runtimeDescriptor?.providerId) !== providerId) return null;
  return readString(readRecord(runtimeDescriptor?.provider)?.vendorSessionId);
}

export function directSessionMarkerMatches(params: Readonly<{
  marker: DaemonSessionMarker;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
}>): boolean {
  return readDirectSessionMarkerProviderId(params.marker) === params.providerId
    && readDirectSessionMarkerRemoteSessionId(params.marker, params.providerId) === params.remoteSessionId;
}
