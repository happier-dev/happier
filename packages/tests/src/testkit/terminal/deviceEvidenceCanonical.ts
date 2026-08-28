import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function terminalEvidenceCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function terminalEvidenceSha256(value: unknown): string {
  return createHash('sha256').update(terminalEvidenceCanonicalJson(value)).digest('hex');
}
