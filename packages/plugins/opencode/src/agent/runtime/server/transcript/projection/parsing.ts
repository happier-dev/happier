import { parseTimestampMs } from '@happier-dev/plugin-sdk';

export function asOpenCodeProjectionRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeOpenCodeProjectionString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeOpenCodeProjectionLowerString(value: unknown): string {
  return normalizeOpenCodeProjectionString(value).trim().toLowerCase();
}

export function readOpenCodeBooleanLike(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function readOpenCodeFiniteInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function readOpenCodeTimestampMs(
  value: unknown,
  opts: Readonly<{ allowSecondsNumber: boolean }>,
): number | null {
  // OpenCode's legacy `created`/`created_at` fields are the same mixed
  // seconds-or-milliseconds timestamp contract as the public SDK parser.
  // Keep the explicit-ms fields below separate: a field named `*Ms` must not
  // reinterpret a small value as seconds.
  if (opts.allowSecondsNumber) return parseTimestampMs(value);

  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
  }

  const numberValue = readOpenCodeFiniteInteger(value);
  if (numberValue === null || numberValue < 0) return null;
  return numberValue;
}

export function readOpenCodeNestedRecord(
  source: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return source ? asOpenCodeProjectionRecord(source[key]) : null;
}

export function hasOpenCodeInternalFlag(source: Record<string, unknown> | null): boolean {
  if (!source) return false;
  if (readOpenCodeBooleanLike(source.synthetic)) return true;
  if (readOpenCodeBooleanLike(source.ignored)) return true;
  if (readOpenCodeBooleanLike(source.internal)) return true;
  if (readOpenCodeBooleanLike(source.hidden)) return true;

  const metadata = readOpenCodeNestedRecord(source, 'metadata') ?? readOpenCodeNestedRecord(source, 'meta');
  if (!metadata) return false;
  return readOpenCodeBooleanLike(metadata.synthetic)
    || readOpenCodeBooleanLike(metadata.ignored)
    || readOpenCodeBooleanLike(metadata.internal)
    || readOpenCodeBooleanLike(metadata.hidden);
}
