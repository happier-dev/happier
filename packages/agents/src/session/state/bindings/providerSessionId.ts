import type { AgentNativeContinuityProofV1, SessionMetadata } from '@happier-dev/protocol';
import { AgentNativeContinuityProofV1Schema } from '@happier-dev/protocol';

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
 * Catalog-declared continuity-proof keys, indexed by the vendor resume id key
 * they prove. A proof is only meaningful for the exact id it was produced
 * alongside (`REQ-STATE-01`), so the two keys are always written and cleared
 * together and never resolved independently.
 */
const CONTINUITY_PROOF_METADATA_KEY_BY_RESUME_ID_KEY = Object.freeze(Object.fromEntries(
  AGENT_IDS.flatMap((agentId) => {
    const resume = getAgentResumeConfig(agentId);
    const proofField = resume.vendorResumeContinuityProofField?.trim();
    return resume.vendorResumeIdField && proofField
      ? [[resume.vendorResumeIdField, proofField] as const]
      : [];
  }),
)) as Readonly<Record<string, string>>;

const VENDOR_RESUME_CONTINUITY_PROOF_KEYS = Object.freeze(
  Object.values(CONTINUITY_PROOF_METADATA_KEY_BY_RESUME_ID_KEY),
);

export function getLegacyProviderSessionIdMetadataKeys(): readonly ProviderSessionIdMetadataKey[] {
  return LEGACY_PROVIDER_SESSION_ID_KEYS;
}

/** Every catalog-declared continuity-proof metadata key, in catalog order. */
export function getVendorResumeContinuityProofMetadataKeys(): readonly string[] {
  return VENDOR_RESUME_CONTINUITY_PROOF_KEYS;
}

/** The continuity-proof key that belongs to one vendor resume id key, if any. */
export function getVendorResumeContinuityProofMetadataKey(
  vendorResumeIdMetadataKey: string,
): string | null {
  return CONTINUITY_PROOF_METADATA_KEY_BY_RESUME_ID_KEY[vendorResumeIdMetadataKey] ?? null;
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
    continuityProof?: AgentNativeContinuityProofV1 | null;
  }>,
): TMetadata {
  const next = typeof update.value === 'string' ? update.value.trim() : '';
  if (!next) {
    return metadata;
  }

  const written = {
    ...metadata,
    [update.metadataKey]: next,
  };

  const proofMetadataKey = getVendorResumeContinuityProofMetadataKey(update.metadataKey);
  if (!proofMetadataKey) {
    return written;
  }

  // The proof belongs to exactly one id. Writing an id therefore always
  // rewrites its proof slot — setting the matched proof, or clearing whatever
  // was there — so a new id can never inherit the previous id's proof
  // (`REQ-STATE-01`). This is why the proof rides inside this write rather than
  // being a separately publishable field.
  const proofValue = update.continuityProof?.value.trim() ?? '';
  if (!proofValue) {
    const { [proofMetadataKey]: _clearedProof, ...withoutProof } = written;
    return withoutProof as TMetadata;
  }
  return {
    ...written,
    [proofMetadataKey]: proofValue,
  };
}

function readStructuredProviderSessionIdWrite(
  value: SessionStateFieldWriteValue<'identity.providerSessionId'>,
): Readonly<{
  value: string | null | undefined;
  metadataKey: ProviderSessionIdMetadataKey;
  continuityProof: AgentNativeContinuityProofV1 | null;
}> | null {
  if (!isRecord(value)) return null;
  const metadataKey = typeof value.metadataKey === 'string' && value.metadataKey.trim().length > 0
    ? value.metadataKey.trim()
    : null;
  if (!metadataKey || !(LEGACY_PROVIDER_SESSION_ID_KEYS as readonly string[]).includes(metadataKey)) return null;
  const parsedProof = value.continuityProof == null
    ? null
    : AgentNativeContinuityProofV1Schema.safeParse(value.continuityProof);
  return {
    metadataKey,
    value: typeof value.value === 'string' ? value.value : null,
    // An unparseable proof is treated as no proof: it must degrade to a fresh
    // target, never authorize resuming an arbitrary native session.
    continuityProof: parsedProof?.success ? parsedProof.data : null,
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
          continuityProof: structured?.continuityProof ?? null,
        },
      ) as SessionMetadata;
    },
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
        continuityProof: structured?.continuityProof ?? null,
      },
    ) as SessionMetadata;
  },
};
