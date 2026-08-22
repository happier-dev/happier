import { parseTimestampMs } from '@happier-dev/plugin-sdk';

export type ClaudeRuntimeResetTiming = Readonly<{
  retryAfterMs: number | null;
  resetAtMs: number | null;
}>;

export type ClaudeRuntimeResetTextEvidenceParser = (
  text: string,
  context: Readonly<{ nowMs: number }>,
) => ClaudeRuntimeResetTiming | null;

const DURATION_PART_PATTERN =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)(?=\s|\d|$|[.,;:])/giu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown): number | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeNonNegativeSafeMilliseconds(value: number): number | null {
  const milliseconds = Math.trunc(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function addSafeEpochMilliseconds(nowMs: number, durationMs: number): number | null {
  const now = normalizeNonNegativeSafeMilliseconds(nowMs);
  const duration = normalizeNonNegativeSafeMilliseconds(durationMs);
  if (now === null || duration === null) return null;

  const resetAtMs = now + duration;
  return Number.isSafeInteger(resetAtMs) ? resetAtMs : null;
}

function readCaseInsensitive(record: Record<string, unknown> | null, name: string): unknown {
  if (!record) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function parseCompactDurationMs(value: unknown): number | null {
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

export function parseClaudeProviderTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return normalizeNonNegativeSafeMilliseconds(ms);
  }
  if (typeof value === 'number') {
    const parsed = parseTimestampMs(value);
    return parsed === null ? null : normalizeNonNegativeSafeMilliseconds(parsed);
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

function parseRetryAfterHeader(value: unknown, options: Readonly<{ nowMs: number }>): ClaudeRuntimeResetTiming {
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
  const dateMs = parseClaudeProviderTimestampMs(value);
  const nowMs = normalizeNonNegativeSafeMilliseconds(options.nowMs);
  if (dateMs !== null && nowMs !== null && dateMs >= nowMs) {
    const retryAfterMs = normalizeNonNegativeSafeMilliseconds(dateMs - nowMs);
    if (retryAfterMs !== null) return { retryAfterMs, resetAtMs: dateMs };
  }
  return { retryAfterMs: null, resetAtMs: null };
}

function timingFromDuration(value: unknown, nowMs: number): ClaudeRuntimeResetTiming | null {
  const durationMs = parseCompactDurationMs(value);
  const resetAtMs = durationMs === null ? null : addSafeEpochMilliseconds(nowMs, durationMs);
  return durationMs === null || resetAtMs === null ? null : { retryAfterMs: durationMs, resetAtMs };
}

function timingFromSeconds(value: unknown, nowMs: number): ClaudeRuntimeResetTiming | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const durationMs = normalizeNonNegativeSafeMilliseconds(numeric * 1_000);
  const resetAtMs = durationMs === null ? null : addSafeEpochMilliseconds(nowMs, durationMs);
  return durationMs === null || resetAtMs === null ? null : { retryAfterMs: durationMs, resetAtMs };
}

function timingFromMilliseconds(value: unknown): ClaudeRuntimeResetTiming | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const retryAfterMs = normalizeNonNegativeSafeMilliseconds(numeric);
  return retryAfterMs === null ? null : { retryAfterMs, resetAtMs: null };
}

function timingFromTimestamp(value: unknown, nowMs: number): ClaudeRuntimeResetTiming | null {
  const resetAtMs = parseClaudeProviderTimestampMs(value);
  const normalizedNowMs = normalizeNonNegativeSafeMilliseconds(nowMs);
  if (resetAtMs === null || normalizedNowMs === null) return null;
  const retryAfterMs = normalizeNonNegativeSafeMilliseconds(Math.max(0, resetAtMs - normalizedNowMs));
  return retryAfterMs === null ? null : { retryAfterMs, resetAtMs };
}

function extractResetDelayText(value: unknown): string | null {
  const text = normalizeString(value);
  if (!text) return null;
  const match = /\b(?:reset|resets|retry|try again)\s+(?:after|in)\s+([0-9][0-9a-zA-Z.\s]*)/iu.exec(text);
  return match?.[1]?.trim() ?? null;
}

function collectStringCandidates(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringCandidates(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ['message', 'detail', 'details', 'error', 'description']) {
    collectStringCandidates(value[key], output);
  }
}

function readZonedParts(dateMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(dateMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = Number(values.get('year'));
    const month = Number(values.get('month'));
    const day = Number(values.get('day'));
    const hour = Number(values.get('hour'));
    const minute = Number(values.get('minute'));
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    return { year, month, day, hour, minute };
  } catch {
    return null;
  }
}

function zonedLocalDateTimeToUtcMs(params: Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}>): number | null {
  const desiredAsUtc = Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0, 0);
  const observed = readZonedParts(desiredAsUtc, params.timeZone);
  if (!observed) return null;
  const observedAsUtc = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    0,
    0,
  );
  return desiredAsUtc + (desiredAsUtc - observedAsUtc);
}

function parseMonthName(value: string | undefined): number | null {
  if (!value) return null;
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const index = months.findIndex((month) => month.startsWith(value.toLowerCase()));
  return index >= 0 ? index + 1 : null;
}

function parseClock(hourText: string, minuteText: string | undefined, meridiemText: string): {
  hour: number;
  minute: number;
} | null {
  const hour12 = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const meridiem = meridiemText.toLowerCase();
  const hour = meridiem === 'pm' ? (hour12 % 12) + 12 : hour12 % 12;
  return { hour, minute };
}

const parseClaudeTuiResetText: ClaudeRuntimeResetTextEvidenceParser = (text, { nowMs }) => {
  const match = /\b(?:resets?)\s+(?:(?:([A-Z][a-z]+)\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))\s*\(([^)]+)\)/iu.exec(text);
  if (!match) return null;
  const clock = parseClock(match[3] ?? '', match[4], match[5] ?? '');
  if (!clock) return null;
  const timeZone = match[6]?.trim();
  if (!timeZone) return null;

  const nowParts = readZonedParts(nowMs, timeZone);
  if (!nowParts) return null;
  const explicitMonth = parseMonthName(match[1]);
  const explicitDay = match[2] ? Number(match[2]) : null;
  const base = {
    year: nowParts.year,
    month: explicitMonth ?? nowParts.month,
    day: explicitDay && Number.isInteger(explicitDay) ? explicitDay : nowParts.day,
    hour: clock.hour,
    minute: clock.minute,
    timeZone,
  };
  let resetAtMs = zonedLocalDateTimeToUtcMs(base);
  if (resetAtMs === null) return null;
  if (resetAtMs < nowMs && !explicitMonth && !explicitDay) {
    resetAtMs = zonedLocalDateTimeToUtcMs({
      ...base,
      day: base.day + 1,
    });
  }
  return resetAtMs === null ? null : timingFromTimestamp(resetAtMs, nowMs);
};

function readClaudeHeaderTimestampEvidence(headers: Record<string, unknown> | null): readonly unknown[] {
  return [
    readCaseInsensitive(headers, 'anthropic-ratelimit-tokens-reset'),
    readCaseInsensitive(headers, 'anthropic-ratelimit-requests-reset'),
    readCaseInsensitive(headers, 'anthropic-ratelimit-input-tokens-reset'),
    readCaseInsensitive(headers, 'anthropic-ratelimit-output-tokens-reset'),
  ];
}

export function parseClaudeUsageLimitReset(input: Readonly<{
  nowMs: number;
  headers?: unknown;
  body?: unknown;
}>): ClaudeRuntimeResetTiming {
  const headers = isRecord(input.headers) ? input.headers : null;
  const body = isRecord(input.body) ? input.body : null;
  const retryAfterMs = readCaseInsensitive(headers, 'retry-after-ms')
    ?? body?.['retry-after-ms']
    ?? body?.retryAfterMs;
  const retryAfterMsTiming = timingFromMilliseconds(retryAfterMs) ?? timingFromDuration(retryAfterMs, input.nowMs);
  if (retryAfterMsTiming) return retryAfterMsTiming;

  const retryAfter = parseRetryAfterHeader(readCaseInsensitive(headers, 'retry-after') ?? body?.['retry-after'], {
    nowMs: input.nowMs,
  });
  if (retryAfter.retryAfterMs !== null || retryAfter.resetAtMs !== null) return retryAfter;

  for (const value of [
    readCaseInsensitive(headers, 'x-ratelimit-reset-after'),
    body?.quotaResetDelay,
    body?.retryDelay,
    body?.retry_delay,
  ]) {
    const timing = timingFromDuration(value, input.nowMs) ?? timingFromSeconds(value, input.nowMs);
    if (timing) return timing;
  }

  for (const value of [
    readCaseInsensitive(headers, 'x-ratelimit-reset'),
    ...readClaudeHeaderTimestampEvidence(headers),
    body?.quotaResetTimeStamp,
    body?.quotaResetTimestamp,
    body?.quota_reset_timestamp,
    body?.resetTime,
    body?.reset_time,
    body?.resetsAt,
    body?.resets_at,
    body?.resetAt,
    body?.reset_at,
  ]) {
    const timing = timingFromTimestamp(value, input.nowMs);
    if (timing) return timing;
  }

  const textCandidates: string[] = [];
  collectStringCandidates(input.body, textCandidates);
  for (const candidate of textCandidates) {
    const textEvidenceTiming = parseClaudeTuiResetText(candidate, { nowMs: input.nowMs });
    if (textEvidenceTiming) return textEvidenceTiming;
    const timing = timingFromDuration(extractResetDelayText(candidate), input.nowMs);
    if (timing) return timing;
    const timestamp = timingFromTimestamp(candidate, input.nowMs);
    if (timestamp) return timestamp;
  }

  return { retryAfterMs: null, resetAtMs: null };
}

export function readClaudeAnthropicHeaderResetAtMs(headers: Record<string, unknown>): number | null {
  for (const value of readClaudeHeaderTimestampEvidence(headers)) {
    const resetAtMs = parseClaudeProviderTimestampMs(value);
    if (resetAtMs !== null) return resetAtMs;
  }
  return null;
}
