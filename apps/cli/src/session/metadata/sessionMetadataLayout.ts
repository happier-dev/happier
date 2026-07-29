import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionSharedMetadataV1Schema,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

type ParsedSessionMetadataLayout =
  | Readonly<{
      layoutVersion: 0;
      metadata: Record<string, unknown>;
    }>
  | Readonly<{
      layoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
      metadata: SessionSharedMetadataV1;
    }>;

export function readSessionMetadataLayoutVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function tryParseSessionMetadataLayout(
  value: unknown,
  metadataLayoutVersion: unknown,
): ParsedSessionMetadataLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const layoutVersion = readSessionMetadataLayoutVersion(metadataLayoutVersion);
  if (layoutVersion === 0) {
    return {
      layoutVersion,
      metadata: Object.fromEntries(Object.entries(value)),
    };
  }
  if (layoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;

  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(value);
  return sharedMetadata.success
    ? {
        layoutVersion,
        metadata: sharedMetadata.data,
      }
    : null;
}

export function tryReadSessionMetadataRecordForLayout(
  value: unknown,
  metadataLayoutVersion: unknown,
): Record<string, unknown> | null {
  const parsed = tryParseSessionMetadataLayout(value, metadataLayoutVersion);
  return parsed
    ? Object.fromEntries(Object.entries(parsed.metadata))
    : null;
}

export function tryReadApiSessionMetadataForLayout(
  value: unknown,
  metadataLayoutVersion: unknown,
): Metadata | null {
  const parsed = tryParseSessionMetadataLayout(value, metadataLayoutVersion);
  if (!parsed) return null;

  if (parsed.layoutVersion === 0) {
    // Layout 0 is the released legacy Metadata wire shape.
    return parsed.metadata as unknown as Metadata;
  }

  return {
    path: '',
    host: '',
    homeDir: '',
    happyHomeDir: '',
    happyLibDir: '',
    happyToolsDir: '',
    ...parsed.metadata,
  };
}
