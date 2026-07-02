import type { SessionMetadata } from '@happier-dev/protocol';

import { AGENT_IDS } from '../../../types.js';
import { getAgentResumeConfig } from '../../../manifest.js';
import { readNormalizedRuntimeDescriptor } from '../../../runtime/identity/runtimeDescriptor.js';
import type { SessionStateBinding, SessionStateFieldWriteValue, SessionStateStoredValue } from '../_types.js';

export type ProviderSessionIdMetadataKey = keyof SessionMetadata & string;

const PROVIDER_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID = Object.freeze(Object.fromEntries(
  AGENT_IDS.map((agentId) => {
    const resume = getAgentResumeConfig(agentId);
    return [agentId, resume.vendorResumeIdField];
  }),
)) as Readonly<Record<string, ProviderSessionIdMetadataKey>>;

const LEGACY_PROVIDER_SESSION_ID_KEYS = Object.freeze(
  Object.values(PROVIDER_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID),
);

export function getLegacyProviderSessionIdMetadataKeys(): readonly ProviderSessionIdMetadataKey[] {
  return LEGACY_PROVIDER_SESSION_ID_KEYS;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLegacyProviderSessionId(metadata: SessionMetadata): string | null {
  for (const key of LEGACY_PROVIDER_SESSION_ID_KEYS) {
    const value = asTrimmedString((metadata as Record<string, unknown>)[key]);
    if (value) return value;
  }
  return null;
}

function resolveProviderSessionIdMetadataKey(metadata: SessionMetadata): ProviderSessionIdMetadataKey | null {
  const providerId = readNormalizedRuntimeDescriptor(metadata)?.providerId;
  if (providerId && providerId in PROVIDER_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID) {
    return PROVIDER_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID[
      providerId as keyof typeof PROVIDER_SESSION_ID_METADATA_KEY_BY_PROVIDER_ID
    ];
  }

  for (const key of LEGACY_PROVIDER_SESSION_ID_KEYS) {
    if (asTrimmedString((metadata as Record<string, unknown>)[key])) {
      return key;
    }
  }

  return null;
}

export function readProviderSessionIdSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'identity.providerSessionId'> {
  return {
    value: asTrimmedString(readNormalizedRuntimeDescriptor(metadata)?.providerSessionId) ?? readLegacyProviderSessionId(metadata),
    updatedAt: null,
  };
}

export function writeProviderSessionIdSessionState<TMetadata extends Record<string, unknown>>(
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

function readStructuredProviderSessionIdWrite(
  value: SessionStateFieldWriteValue<'identity.providerSessionId'>,
): Readonly<{ value: string | null | undefined; metadataKey: ProviderSessionIdMetadataKey }> | null {
  if (!isRecord(value)) return null;
  const metadataKey = typeof value.metadataKey === 'string' && value.metadataKey.trim().length > 0
    ? value.metadataKey.trim()
    : null;
  if (!metadataKey || !(LEGACY_PROVIDER_SESSION_ID_KEYS as readonly string[]).includes(metadataKey)) return null;
  return {
    metadataKey,
    value: typeof value.value === 'string' ? value.value : null,
  };
}

function readProviderSessionIdWriteValue(
  value: SessionStateFieldWriteValue<'identity.providerSessionId'>,
): string | null | undefined {
  const structured = readStructuredProviderSessionIdWrite(value);
  if (structured) return structured.value;
  return typeof value === 'string' ? value : null;
}

export function createProviderSessionIdBinding(
  metadataKey: ProviderSessionIdMetadataKey,
): SessionStateBinding<'identity.providerSessionId'> {
  return {
    read: readProviderSessionIdSessionState,
    write: (metadata, update) => writeProviderSessionIdSessionState(
      metadata as SessionMetadata & Record<string, unknown>,
      {
        metadataKey,
        value: readProviderSessionIdWriteValue(update.value),
      },
    ) as SessionMetadata,
  };
}

export const providerSessionIdBinding: SessionStateBinding<'identity.providerSessionId'> = {
  read: readProviderSessionIdSessionState,
  write: (metadata, update) => {
    const structured = readStructuredProviderSessionIdWrite(update.value);
    const metadataKey = structured?.metadataKey ?? resolveProviderSessionIdMetadataKey(metadata);
    if (!metadataKey) return metadata;
    return writeProviderSessionIdSessionState(
      metadata as SessionMetadata & Record<string, unknown>,
      {
        metadataKey,
        value: structured?.value ?? readProviderSessionIdWriteValue(update.value),
      },
    ) as SessionMetadata;
  },
};
