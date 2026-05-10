import type { SessionMetadata } from '@happier-dev/protocol';

import { AGENT_IDS } from '../../../types.js';
import { getAgentResumeConfig } from '../../../manifest.js';
import { readNormalizedRuntimeDescriptor } from '../../../runtime/identity/runtimeDescriptor.js';
import type { SessionStateBinding, SessionStateFieldWriteValue, SessionStateStoredValue } from '../_types.js';

export type VendorSessionIdMetadataKey = keyof SessionMetadata & string;

const VENDOR_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID = Object.freeze(Object.fromEntries(
  AGENT_IDS.map((agentId) => {
    const resume = getAgentResumeConfig(agentId);
    return [agentId, resume.vendorResumeIdField];
  }),
)) as Readonly<Record<string, VendorSessionIdMetadataKey>>;

const LEGACY_VENDOR_SESSION_ID_KEYS = Object.freeze(
  Object.values(VENDOR_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID),
);

export function getLegacyVendorSessionIdMetadataKeys(): readonly VendorSessionIdMetadataKey[] {
  return LEGACY_VENDOR_SESSION_ID_KEYS;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLegacyVendorSessionId(metadata: SessionMetadata): string | null {
  for (const key of LEGACY_VENDOR_SESSION_ID_KEYS) {
    const value = asTrimmedString((metadata as Record<string, unknown>)[key]);
    if (value) return value;
  }
  return null;
}

function resolveVendorSessionIdMetadataKey(metadata: SessionMetadata): VendorSessionIdMetadataKey | null {
  const providerId = readNormalizedRuntimeDescriptor(metadata)?.providerId;
  if (providerId && providerId in VENDOR_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID) {
    return VENDOR_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID[
      providerId as keyof typeof VENDOR_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID
    ];
  }

  for (const key of LEGACY_VENDOR_SESSION_ID_KEYS) {
    if (asTrimmedString((metadata as Record<string, unknown>)[key])) {
      return key;
    }
  }

  return null;
}

export function readVendorSessionIdSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'identity.vendorSessionId'> {
  return {
    value: asTrimmedString(readNormalizedRuntimeDescriptor(metadata)?.vendorSessionId) ?? readLegacyVendorSessionId(metadata),
    updatedAt: null,
  };
}

export function writeVendorSessionIdSessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  update: Readonly<{
    metadataKey: keyof TMetadata & string;
    value: string | null | undefined;
  }>,
): TMetadata {
  const next = typeof update.value === 'string' ? update.value.trim() : '';
  if (!next) {
    return metadata;
  }

  return {
    ...metadata,
    [update.metadataKey]: next,
  };
}

function readStructuredVendorSessionIdWrite(
  value: SessionStateFieldWriteValue<'identity.vendorSessionId'>,
): Readonly<{ value: string | null | undefined; metadataKey: VendorSessionIdMetadataKey }> | null {
  if (!isRecord(value)) return null;
  const metadataKey = typeof value.metadataKey === 'string' && value.metadataKey.trim().length > 0
    ? value.metadataKey.trim()
    : null;
  if (!metadataKey || !(LEGACY_VENDOR_SESSION_ID_KEYS as readonly string[]).includes(metadataKey)) return null;
  return {
    metadataKey,
    value: typeof value.value === 'string' ? value.value : null,
  };
}

function readVendorSessionIdWriteValue(
  value: SessionStateFieldWriteValue<'identity.vendorSessionId'>,
): string | null | undefined {
  const structured = readStructuredVendorSessionIdWrite(value);
  if (structured) return structured.value;
  return typeof value === 'string' ? value : null;
}

export function createVendorSessionIdBinding(
  metadataKey: VendorSessionIdMetadataKey,
): SessionStateBinding<'identity.vendorSessionId'> {
  return {
    read: readVendorSessionIdSessionState,
    write: (metadata, update) => writeVendorSessionIdSessionState(
      metadata as SessionMetadata & Record<string, unknown>,
      {
        metadataKey,
        value: readVendorSessionIdWriteValue(update.value),
      },
    ) as SessionMetadata,
  };
}

export const vendorSessionIdBinding: SessionStateBinding<'identity.vendorSessionId'> = {
  read: readVendorSessionIdSessionState,
  write: (metadata, update) => {
    const structured = readStructuredVendorSessionIdWrite(update.value);
    const metadataKey = structured?.metadataKey ?? resolveVendorSessionIdMetadataKey(metadata);
    if (!metadataKey) return metadata;
    return writeVendorSessionIdSessionState(
      metadata as SessionMetadata & Record<string, unknown>,
      {
        metadataKey,
        value: structured?.value ?? readVendorSessionIdWriteValue(update.value),
      },
    ) as SessionMetadata;
  },
};
