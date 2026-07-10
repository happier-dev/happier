/**
 * Read-compat normalizer for pre-rename persisted session metadata (providers-first-class R.17).
 *
 * Phase R renamed the agent-meaning `provider`/`providerId` fields in persisted
 * session-metadata records to `agentId` (and `forkV1.providerHint` to `forkV1.agentHint`).
 * Persisted dev data written before the rename still carries the legacy keys, so every
 * metadata READ boundary routes through this normalizer (same pattern as the runtime
 * descriptor read-compat in `@happier-dev/protocol` `compat/runtimeDescriptorMetadata`).
 * Writes always use the new names.
 */

const LEGACY_PROVIDER_FIELD_RECORD_KEYS = [
  'acpHistoryImportV1',
  'acpTransportV1',
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
] as const;

const LEGACY_PROVIDER_ID_FIELD_RECORD_KEYS = [
  'externalHistoryImportV1',
  'handoffV1',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeLegacyKeyedRecord(
  value: unknown,
  legacyKey: string,
  canonicalKey: string,
): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (!Object.hasOwn(record, legacyKey)) return value;
  const { [legacyKey]: legacyValue, ...rest } = record;
  if (Object.hasOwn(record, canonicalKey)) return rest;
  return { ...rest, [canonicalKey]: legacyValue };
}

function normalizeLegacyForkHint(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (!Object.hasOwn(record, 'providerHint')) return value;
  const { providerHint, ...rest } = record;
  if (Object.hasOwn(record, 'agentHint')) return rest;
  const hint = asRecord(providerHint);
  if (!hint) return rest;
  const normalizedHint = normalizeLegacyKeyedRecord(
    normalizeLegacyKeyedRecord(hint, 'providerId', 'agentId'),
    'providerSessionId',
    'agentSessionId',
  );
  return { ...rest, agentHint: normalizedHint };
}

/**
 * Maps legacy agent-vocabulary keys in a persisted session-metadata object onto the
 * canonical post-rename names. Returns the input unchanged when nothing is legacy.
 */
export function normalizeLegacyAgentVocabularySessionMetadata<T>(metadata: T): T {
  const record = asRecord(metadata);
  if (!record) return metadata;

  let next: Record<string, unknown> | null = null;
  const ensureNext = () => {
    next ??= { ...record };
    return next;
  };

  for (const key of LEGACY_PROVIDER_FIELD_RECORD_KEYS) {
    const current = (next ?? record)[key];
    const normalized = normalizeLegacyKeyedRecord(current, 'provider', 'agentId');
    if (normalized !== current) ensureNext()[key] = normalized;
  }

  for (const key of LEGACY_PROVIDER_ID_FIELD_RECORD_KEYS) {
    const current = (next ?? record)[key];
    const normalized = normalizeLegacyKeyedRecord(current, 'providerId', 'agentId');
    if (normalized !== current) ensureNext()[key] = normalized;
  }

  const fork = (next ?? record).forkV1;
  const normalizedFork = normalizeLegacyForkHint(fork);
  if (normalizedFork !== fork) ensureNext().forkV1 = normalizedFork;

  return (next ?? metadata) as T;
}
