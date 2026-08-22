import type { CanonicalPluginManifest } from './types';

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry)]),
    );
  }
  return value;
}

export function serializeCanonicalPluginManifest(
  manifest: CanonicalPluginManifest,
): string {
  return `${JSON.stringify(canonicalizeJsonValue(manifest), null, 2)}\n`;
}
