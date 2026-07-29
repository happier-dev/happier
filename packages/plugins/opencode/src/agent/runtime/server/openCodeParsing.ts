export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Validate an opaque provider identifier for presence without changing its bytes. */
export function readNonBlankOpaqueIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

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
