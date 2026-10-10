import {
  normalizeNonNegativeSafeMilliseconds,
  parseProviderResetAt,
  parseProviderTimestampMs,
} from '@happier-dev/plugin-sdk/connected-accounts';

export type ClaudeRuntimeResetTiming = Readonly<{
  retryAfterMs: number | null;
  resetAtMs: number | null;
}>;

export type ClaudeRuntimeResetTextEvidenceParser = (
  text: string,
  context: Readonly<{ nowMs: number }>,
) => ClaudeRuntimeResetTiming | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCaseInsensitive(record: Record<string, unknown> | null, name: string): unknown {
  if (!record) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

export function parseClaudeProviderTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return normalizeNonNegativeSafeMilliseconds(ms);
  }
  return parseProviderTimestampMs(value);
}

function timingFromTimestamp(value: unknown, nowMs: number): ClaudeRuntimeResetTiming | null {
  const resetAtMs = parseClaudeProviderTimestampMs(value);
  const normalizedNowMs = normalizeNonNegativeSafeMilliseconds(nowMs);
  if (resetAtMs === null || normalizedNowMs === null) return null;
  const retryAfterMs = normalizeNonNegativeSafeMilliseconds(Math.max(0, resetAtMs - normalizedNowMs));
  return retryAfterMs === null ? null : { retryAfterMs, resetAtMs };
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
  return parseProviderResetAt({
    ...input,
    timestampEvidence: readClaudeHeaderTimestampEvidence(headers),
    textEvidenceParsers: [parseClaudeTuiResetText],
  });
}

export function readClaudeAnthropicHeaderResetAtMs(headers: Record<string, unknown>): number | null {
  for (const value of readClaudeHeaderTimestampEvidence(headers)) {
    const resetAtMs = parseClaudeProviderTimestampMs(value);
    if (resetAtMs !== null) return resetAtMs;
  }
  return null;
}
