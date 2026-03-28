type RecordLike = Record<string, unknown>;

export function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

export function parseStrictInteger(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^[-]?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.trunc(parsed);
}

export function parseInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const candidate = Math.trunc(value);
    if (candidate < min || candidate > max) return null;
    return candidate;
  }
  if (typeof value === 'string') {
    return parseStrictInteger(value, min, max);
  }
  return null;
}

export function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseStringArray(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const parsed = parseCsv(value);
    return parsed.length > 0 ? parsed : null;
  }
  if (!Array.isArray(value)) return null;
  const out = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'number' && Number.isFinite(entry)) return String(Math.trunc(entry));
      return '';
    })
    .filter((entry) => entry.length > 0);
  if (out.length === 0 && value.length > 0) {
    return null;
  }
  return out;
}

export function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function firstParsed<T>(values: readonly unknown[], parse: (value: unknown) => T | null): T | null {
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}
