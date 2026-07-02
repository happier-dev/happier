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
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) totalMs += amount;
    else if (unit === 's' || unit.startsWith('sec')) totalMs += amount * 1000;
    else if (unit === 'm' || unit.startsWith('min')) totalMs += amount * 60_000;
    else if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) totalMs += amount * 3_600_000;
    else if (unit === 'd' || unit.startsWith('day')) totalMs += amount * 86_400_000;
  }
  return matched ? Math.max(0, Math.trunc(totalMs)) : null;
}

export function parseProviderTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  const numeric = parseNonNegativeNumber(value);
  if (numeric !== null) {
    return Math.trunc(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const text = normalizeString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseRetryAfterHeader(
  value: unknown,
  options: Readonly<{ nowMs: number }>,
): ProviderResetTiming {
  const numericSeconds = parseNonNegativeNumber(value);
  if (numericSeconds !== null) {
    return { retryAfterMs: Math.trunc(numericSeconds * 1000), resetAtMs: null };
  }
  const durationMs = parseCompactDurationMs(value);
  if (durationMs !== null) {
    return { retryAfterMs: durationMs, resetAtMs: options.nowMs + durationMs };
  }
  const dateMs = parseProviderTimestampMs(value);
  if (dateMs !== null && dateMs >= options.nowMs) {
    return { retryAfterMs: dateMs - options.nowMs, resetAtMs: dateMs };
  }
  return { retryAfterMs: null, resetAtMs: null };
}
