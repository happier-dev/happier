import {
  getAgentCatalogDefinition,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeNotificationText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function readMetadataSnapshot(getMetadataSnapshot?: (() => unknown) | null): unknown {
  if (!getMetadataSnapshot) return null;
  try {
    return getMetadataSnapshot();
  } catch {
    return null;
  }
}

function firstNormalized(values: readonly unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeNotificationText(value);
    if (normalized) return normalized;
  }
  return null;
}

export function getSessionNotificationTitle(getMetadataSnapshot?: (() => unknown) | null): string | null {
  const metadata = asRecord(readMetadataSnapshot(getMetadataSnapshot));
  if (!metadata) return null;
  const summary = asRecord(metadata.summary);
  return firstNormalized([
    summary?.text,
    metadata.name,
    metadata.title,
  ]);
}

export function getSessionNotificationAgentDisplayName(getMetadataSnapshot?: (() => unknown) | null): string | null {
  const metadata = asRecord(readMetadataSnapshot(getMetadataSnapshot));
  if (!metadata) return null;

  const explicit = firstNormalized([
    metadata.agentDisplayName,
    metadata.agentName,
    metadata.providerDisplayName,
    metadata.providerLabel,
    metadata.backendTitle,
    metadata.acpBackendTitle,
    metadata.acpTransportProviderLabel,
  ]);
  if (explicit) return explicit;

  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  if (!agentId) return null;

  const providerDefinition = getAgentCatalogDefinition(agentId);
  return normalizeNotificationText(providerDefinition?.agentCliRuntime.title);
}
