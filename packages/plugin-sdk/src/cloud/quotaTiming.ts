import { parseTimestampMs } from '../sessions/fileStores/records.js';

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

function parseDateMs(value: unknown): number | null {
  const text = normalizeString(value);
  const parsed = value instanceof Date ? value.getTime() : text === null ? Number.NaN : Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseProviderTimestampMs(value: unknown): number | null {
  const numeric = parseNonNegativeNumber(value);
  const parsed = numeric === null ? parseDateMs(value) : parseTimestampMs(numeric);
  return parsed === null ? null : normalizeNonNegativeSafeMilliseconds(parsed);
}

/**
 * Interprets Retry-After's numeric seconds and date evidence without choosing a
 * provider's accepted syntax, precedence, clock, rounding or safe-epoch policy.
 * Both interpretations remain available because a provider may reject a numeric
 * spelling while accepting that same text through its existing date grammar.
 */
export function parseRetryAfterValue(value: unknown): Readonly<{
  seconds: number | null;
  dateMs: number | null;
}> {
  return { seconds: parseNonNegativeNumber(value), dateMs: parseDateMs(value) };
}

export function parseRetryAfterHeader(
  value: unknown,
  options: Readonly<{ nowMs: number }>,
): ProviderResetTiming {
  const evidence = parseRetryAfterValue(value);
  const numericSeconds = evidence.seconds;
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
  const dateMs = evidence.dateMs === null ? null : normalizeNonNegativeSafeMilliseconds(evidence.dateMs);
  const nowMs = normalizeNonNegativeSafeMilliseconds(options.nowMs);
  if (dateMs !== null && nowMs !== null && dateMs >= nowMs) {
    const retryAfterMs = normalizeNonNegativeSafeMilliseconds(dateMs - nowMs);
    if (retryAfterMs !== null) return { retryAfterMs, resetAtMs: dateMs };
  }
  return { retryAfterMs: null, resetAtMs: null };
}
