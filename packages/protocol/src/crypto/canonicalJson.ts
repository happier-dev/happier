function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(record[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function createCanonicalJsonSigningInput(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}
