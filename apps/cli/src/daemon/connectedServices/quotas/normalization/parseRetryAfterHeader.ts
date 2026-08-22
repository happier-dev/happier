import { parseTimestampMs } from '@happier-dev/plugin-sdk';

export type ProviderResetTiming = Readonly<{
  retryAfterMs: number | null;
  resetAtMs: number | null;
}>;

const DURATION_PART_PATTERN =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)(?=\s|\d|$|[.,;:])/giu;

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown): number | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

export function normalizeNonNegativeSafeMilliseconds(value: number): number | null {
  const milliseconds = Math.trunc(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

export function addSafeEpochMilliseconds(nowMs: number, durationMs: number): number | null {
  const now = normalizeNonNegativeSafeMilliseconds(nowMs);
  const duration = normalizeNonNegativeSafeMilliseconds(durationMs);
  if (now === null || duration === null) return null;

  const resetAtMs = now + duration;
  return Number.isSafeInteger(resetAtMs) ? resetAtMs : null;
}

export function parseCompactDurationMs(value: unknown): number | null {
  const text = normalizeString(value);
  if (!text) return null;
  let totalMs = 0;
  let matched = false;
  for (const match of text.matchAll(DURATION_PART_PATTERN)) {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(amount) || amount < 0 || !unit) continue;
    matched = true;
    const multiplier = unit.startsWith('ms') || unit.startsWith('millisecond')
      ? 1
      : unit === 's' || unit.startsWith('sec')
        ? 1_000
        : unit === 'm' || unit.startsWith('min')
          ? 60_000
          : unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')
            ? 3_600_000
            : unit === 'd' || unit.startsWith('day')
              ? 86_400_000
              : Number.NaN;
    const partMs = amount * multiplier;
    if (!Number.isFinite(partMs)) return null;
    totalMs += partMs;
    if (!Number.isFinite(totalMs)) return null;
  }
  return matched ? normalizeNonNegativeSafeMilliseconds(totalMs) : null;
}

export function parseProviderTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return normalizeNonNegativeSafeMilliseconds(ms);
  }
  const numeric = parseNonNegativeNumber(value);
  if (numeric !== null) {
    const parsed = parseTimestampMs(numeric);
    return parsed === null ? null : normalizeNonNegativeSafeMilliseconds(parsed);
  }
  const text = normalizeString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return normalizeNonNegativeSafeMilliseconds(parsed);
}

export function parseRetryAfterHeader(
  value: unknown,
  options: Readonly<{ nowMs: number }>,
): ProviderResetTiming {
  const numericSeconds = parseNonNegativeNumber(value);
  if (numericSeconds !== null) {
    const retryAfterMs = normalizeNonNegativeSafeMilliseconds(numericSeconds * 1_000);
    return retryAfterMs === null
      ? { retryAfterMs: null, resetAtMs: null }
      : { retryAfterMs, resetAtMs: null };
  }
  const durationMs = parseCompactDurationMs(value);
  if (durationMs !== null) {
    const resetAtMs = addSafeEpochMilliseconds(options.nowMs, durationMs);
    return resetAtMs === null
      ? { retryAfterMs: null, resetAtMs: null }
      : { retryAfterMs: durationMs, resetAtMs };
  }
  const dateMs = parseProviderTimestampMs(value);
  const nowMs = normalizeNonNegativeSafeMilliseconds(options.nowMs);
  if (dateMs !== null && nowMs !== null && dateMs >= nowMs) {
    const retryAfterMs = normalizeNonNegativeSafeMilliseconds(dateMs - nowMs);
    if (retryAfterMs !== null) return { retryAfterMs, resetAtMs: dateMs };
  }
  return { retryAfterMs: null, resetAtMs: null };
}
