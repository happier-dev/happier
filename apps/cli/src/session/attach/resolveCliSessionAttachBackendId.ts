import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol';

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readConfiguredAcpBackendIdFromFlavor(metadata: Record<string, unknown>): string | null {
  const flavor = normalizeString(metadata.flavor);
  if (!flavor?.startsWith('acp:')) return null;
  return normalizeString(flavor.slice('acp:'.length));
}

export function resolveCliSessionAttachBackendId(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  return readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId
    ?? readConfiguredAcpBackendIdFromFlavor(metadata)
    ?? resolveAgentIdFromSessionMetadata(metadata);
}
