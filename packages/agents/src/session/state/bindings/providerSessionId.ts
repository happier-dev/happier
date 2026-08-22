import {
  readRuntimeDescriptorV1FromMetadata,
  writeRuntimeDescriptorV1ToMetadata,
  type SessionMetadata,
} from '@happier-dev/protocol';

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

/**
 * Catalog-declared native-session-log-path keys, indexed by the vendor resume id
 * key whose conversation they name. The path names ONE conversation, so the two
 * keys are always written and cleared together: an id write that inherited the
 * previous id's path would point a reader at the wrong log.
 */
const NATIVE_SESSION_LOG_PATH_METADATA_KEY_BY_RESUME_ID_KEY = Object.freeze(Object.fromEntries(
  AGENT_IDS.flatMap((agentId) => {
    const resume = getAgentResumeConfig(agentId);
    const logPathField = resume.vendorResumeContinuityProofField?.trim();
    return resume.vendorResumeIdField && logPathField
      ? [[resume.vendorResumeIdField, logPathField] as const]
      : [];
  }),
)) as Readonly<Record<string, string>>;

const AGENT_NATIVE_SESSION_LOG_PATH_KEYS = Object.freeze(
  Object.values(NATIVE_SESSION_LOG_PATH_METADATA_KEY_BY_RESUME_ID_KEY),
);

export function getLegacyProviderSessionIdMetadataKeys(): readonly ProviderSessionIdMetadataKey[] {
  return LEGACY_PROVIDER_SESSION_ID_KEYS;
}

/** Every catalog-declared native-session-log-path metadata key, in catalog order. */
export function getAgentNativeSessionLogPathMetadataKeys(): readonly string[] {
  return AGENT_NATIVE_SESSION_LOG_PATH_KEYS;
}

/** The native-session-log-path key that belongs to one vendor resume id key, if any. */
export function getAgentNativeSessionLogPathMetadataKey(
  vendorResumeIdMetadataKey: string,
): string | null {
  return NATIVE_SESSION_LOG_PATH_METADATA_KEY_BY_RESUME_ID_KEY[vendorResumeIdMetadataKey] ?? null;
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

/**
 * The agent-agnostic slot for an Agent with no catalog-declared flat field —
 * every external (manifest-contributed) Agent, and any bundled Agent whose
 * catalog stops declaring one.
 *
 * The descriptor is the Session's own runtime identity and already names the
 * Agent, so the id lands beside the Agent that produced it. Without a
 * descriptor there is no Agent identity to attach the id to, and inventing one
 * would attribute a native conversation to the wrong Agent, so the write is
 * declined rather than guessed.
 */
function writeRuntimeDescriptorProviderSessionId<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  providerSessionId: string,
): TMetadata {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  if (!descriptor) return metadata;
  const agent = descriptor.agent as Readonly<Record<string, unknown>>;
  if (agent.providerSessionId === providerSessionId) return metadata;
  return writeRuntimeDescriptorV1ToMetadata(metadata, {
    ...descriptor,
    agent: { ...agent, providerSessionId },
  }) as TMetadata;
}

export function writeProviderSessionIdSessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  update: Readonly<{
    metadataKey: (keyof TMetadata & string) | null;
    value: string | null | undefined;
    nativeSessionLogPath?: string | null;
  }>,
): TMetadata {
  const next = typeof update.value === 'string' ? update.value.trim() : '';
  if (!next) {
    return metadata;
  }

  if (!update.metadataKey) {
    return writeRuntimeDescriptorProviderSessionId(metadata, next);
  }

  const written = {
    ...metadata,
    [update.metadataKey]: next,
  };

  const logPathMetadataKey = getAgentNativeSessionLogPathMetadataKey(update.metadataKey);
  if (!logPathMetadataKey) {
    return written;
  }

  // The log path names exactly one conversation. Writing an id therefore always
  // rewrites its path slot — setting the matched path, or clearing whatever was
  // there — so a new id can never inherit the previous id's log. This is why the
  // path rides inside this write rather than being a separately publishable
  // field.
  const logPathValue = update.nativeSessionLogPath?.trim() ?? '';
  if (!logPathValue) {
    const { [logPathMetadataKey]: _clearedLogPath, ...withoutLogPath } = written;
    return withoutLogPath as TMetadata;
  }
  return {
    ...written,
    [logPathMetadataKey]: logPathValue,
  };
}

/**
 * A structured id write. `metadataKey` is the CATALOG-DECLARED flat slot when the
 * publisher knows one; a key no Agent catalog declares is not honored as a
 * metadata key (a caller must never be able to name an arbitrary metadata
 * field) and the write falls through to the agent-agnostic descriptor slot.
 */
function readStructuredProviderSessionIdWrite(
  value: SessionStateFieldWriteValue<'identity.providerSessionId'>,
): Readonly<{
  value: string | null | undefined;
  metadataKey: ProviderSessionIdMetadataKey | null;
  nativeSessionLogPath: string | null;
}> | null {
  if (!isRecord(value)) return null;
  const rawMetadataKey = typeof value.metadataKey === 'string' && value.metadataKey.trim().length > 0
    ? value.metadataKey.trim()
    : null;
  const metadataKey = rawMetadataKey
    && (LEGACY_PROVIDER_SESSION_ID_KEYS as readonly string[]).includes(rawMetadataKey)
    ? rawMetadataKey
    : null;
  const rawLogPath = typeof value.nativeSessionLogPath === 'string'
    ? value.nativeSessionLogPath.trim()
    : '';
  return {
    metadataKey,
    value: typeof value.value === 'string' ? value.value : null,
    // A non-string or blank path is treated as no path: the seed offers the
    // successor nothing rather than a pointer it cannot follow.
    nativeSessionLogPath: rawLogPath || null,
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
    write: (metadata, update) => {
      const structured = readStructuredProviderSessionIdWrite(update.value);
      return writeProviderSessionIdSessionState(
        metadata as SessionMetadata & Record<string, unknown>,
        {
          metadataKey,
          value: readProviderSessionIdWriteValue(update.value),
          nativeSessionLogPath: structured?.nativeSessionLogPath ?? null,
        },
      ) as SessionMetadata;
    },
  };
}

/**
 * ONE writer for a Session's native provider session id.
 *
 * A catalog-declared flat `<vendor>SessionId` slot wins when the Agent has one;
 * otherwise the id goes to the agent-agnostic runtime-descriptor slot. Before,
 * the absence of a declared slot returned the metadata unchanged, so every
 * external Agent's id — including one published through the documented
 * `identity.providerSessionId` author channel — was silently discarded and its
 * Session could never be resumed.
 */
export const providerSessionIdBinding: SessionStateBinding<'identity.providerSessionId'> = {
  read: readProviderSessionIdSessionState,
  write: (metadata, update) => {
    const structured = readStructuredProviderSessionIdWrite(update.value);
    const metadataKey = structured?.metadataKey ?? resolveProviderSessionIdMetadataKey(metadata);
    return writeProviderSessionIdSessionState(
      metadata as SessionMetadata & Record<string, unknown>,
      {
        metadataKey,
        value: structured?.value ?? readProviderSessionIdWriteValue(update.value),
        nativeSessionLogPath: structured?.nativeSessionLogPath ?? null,
      },
    ) as SessionMetadata;
  },
};
