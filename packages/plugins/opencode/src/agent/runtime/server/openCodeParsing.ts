export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/** OpenCode V1 names the error, while V2 tags it with a type. */
export function isOpenCodeNativeAbortError(value: unknown): boolean {
  const error = asRecord(value);
  return error?.name === 'MessageAbortedError' || error?.name === 'AbortError' || error?.type === 'aborted';
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// One plugin-scoped owner of the opaque-identifier rule; re-exported here so
// runtime-server callers keep their existing import path.
export { readNonBlankOpaqueIdentifier } from '../../../protocol/opaqueIdentifier.js';

export function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

export function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> {
  const record = asRecord(value);
  if (!record) return {};

  const entries: Array<[string, string | undefined]> = [];
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'string' || typeof raw === 'undefined') {
      entries.push([key, raw]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}
