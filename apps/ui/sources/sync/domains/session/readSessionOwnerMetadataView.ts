import {
  type Metadata,
} from '@/sync/domains/state/storageTypes';

type SessionOwnerMetadataViewInput = Readonly<{
  metadataLayoutVersion?: number;
  metadata: unknown;
  ownerMetadataView?: unknown;
}>;

function readMetadataView(value: unknown): Metadata | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Metadata
    : null;
}

export function readSessionOwnerMetadataView(
  session: SessionOwnerMetadataViewInput,
): Metadata | null {
  if ((session.metadataLayoutVersion ?? 0) === 0) {
    return readMetadataView(session.metadata);
  }
  if (session.metadataLayoutVersion !== 1) {
    return null;
  }
  return readMetadataView(session.ownerMetadataView);
}
