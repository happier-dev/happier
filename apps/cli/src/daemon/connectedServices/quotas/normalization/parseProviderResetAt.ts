import {
  parseCompactDurationMs,
  parseProviderTimestampMs,
  parseRetryAfterHeader,
  type ProviderResetTiming,
} from './parseRetryAfterHeader';

export type ProviderResetTextEvidenceParser = (
  text: string,
  context: Readonly<{ nowMs: number }>,
) => ProviderResetTiming | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCaseInsensitive(record: Record<string, unknown> | null, name: string): unknown {
  if (!record) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function timingFromDuration(value: unknown, nowMs: number): ProviderResetTiming | null {
  const durationMs = parseCompactDurationMs(value);
  return durationMs === null ? null : { retryAfterMs: durationMs, resetAtMs: nowMs + durationMs };
}

function timingFromSeconds(value: unknown, nowMs: number): ProviderResetTiming | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const durationMs = Math.trunc(numeric * 1_000);
  return { retryAfterMs: durationMs, resetAtMs: nowMs + durationMs };
}

function timingFromMilliseconds(value: unknown): ProviderResetTiming | null {
  const text = normalizeString(value);
  const numeric = typeof value === 'number' ? value : text === null ? Number.NaN : Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return { retryAfterMs: Math.trunc(numeric), resetAtMs: null };
}

function timingFromTimestamp(value: unknown, nowMs: number): ProviderResetTiming | null {
  const resetAtMs = parseProviderTimestampMs(value);
  return resetAtMs === null ? null : { retryAfterMs: Math.max(0, resetAtMs - nowMs), resetAtMs };
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

export function parseProviderResetAt(input: Readonly<{
  nowMs: number;
  headers?: unknown;
  body?: unknown;
  timestampEvidence?: readonly unknown[];
  textEvidenceParsers?: readonly ProviderResetTextEvidenceParser[];
}>): ProviderResetTiming {
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
    ...(input.timestampEvidence ?? []),
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
    for (const parseTextEvidence of input.textEvidenceParsers ?? []) {
      const textEvidenceTiming = parseTextEvidence(candidate, { nowMs: input.nowMs });
      if (textEvidenceTiming) return textEvidenceTiming;
    }
    const timing = timingFromDuration(extractResetDelayText(candidate), input.nowMs);
    if (timing) return timing;
    const timestamp = timingFromTimestamp(candidate, input.nowMs);
    if (timestamp) return timestamp;
  }

  return { retryAfterMs: null, resetAtMs: null };
}
