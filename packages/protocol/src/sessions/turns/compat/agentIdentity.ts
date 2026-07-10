function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeLegacyStringField(
  record: Record<string, unknown>,
  legacyKey: string,
  canonicalKey: string,
): Record<string, unknown> | null {
  if (!Object.hasOwn(record, legacyKey)) return record;
  const legacyValue = typeof record[legacyKey] === 'string' ? record[legacyKey].trim() : '';
  const hasCanonicalValue = Object.hasOwn(record, canonicalKey);
  const canonicalValue = typeof record[canonicalKey] === 'string' ? record[canonicalKey].trim() : '';
  if (!legacyValue || (hasCanonicalValue && (!canonicalValue || canonicalValue !== legacyValue))) return null;
  const { [legacyKey]: _legacyValue, ...rest } = record;
  return hasCanonicalValue ? rest : { ...rest, [canonicalKey]: legacyValue };
}

/** Read compatibility for deployed V1 turn records and mutations. */
export function normalizeLegacySessionTurnAgentIdentity(value: unknown): unknown {
  const input = asRecord(value);
  if (!input) return value;

  let normalized = normalizeLegacyStringField(input, 'provider', 'agentId');
  if (!normalized) return undefined;
  normalized = normalizeLegacyStringField(normalized, 'providerTurnId', 'agentTurnId');
  return normalized ?? undefined;
}
