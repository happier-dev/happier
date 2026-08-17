/**
 * Bitbucket Cloud rate-limit evidence — the canonical provider-local parser.
 *
 * Atlassian's published "API request limits" contract documents exactly three response headers,
 * and only for scaled limits on access-token/Forge requests: `X-RateLimit-Limit` ("the total number
 * of requests permitted per hour. Note, this is not the number of remaining possible requests"),
 * `X-RateLimit-Resource`, and `X-RateLimit-NearLimit` ("less than 20% of the requests remain").
 *
 * There is no published `X-RateLimit-Remaining`, no reset header, and no documented `Retry-After`
 * on the pull-request routes. Those three headers are therefore advisory telemetry, never a
 * deadline: a throttle without a real `Retry-After` is reported with no deadline at all rather than
 * with an invented one. The one published quantitative fact this module derives a bound from is the
 * "one-hour rolling window" the same page states.
 */

export const BITBUCKET_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type BitbucketRateLimitTelemetry = Readonly<{
  limit: number | null;
  resource: string | null;
  nearLimit: boolean | null;
}>;

export const EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY: BitbucketRateLimitTelemetry = Object.freeze({
  limit: null,
  resource: null,
  nearLimit: null,
});

function readHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export function readBitbucketRateLimitTelemetry(
  headers: Readonly<Record<string, string>>,
): BitbucketRateLimitTelemetry {
  const rawLimit = readHeader(headers, 'x-ratelimit-limit');
  const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const rawNearLimit = readHeader(headers, 'x-ratelimit-nearlimit');
  return {
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null,
    resource: readHeader(headers, 'x-ratelimit-resource'),
    nearLimit: rawNearLimit === null ? null : rawNearLimit.toLowerCase() === 'true',
  };
}

/**
 * Returns an absolute epoch-millisecond deadline derived only from a real `Retry-After`, converted
 * through the injected clock. Both documented spellings are accepted: delta-seconds and an
 * HTTP-date. Anything else — including the advisory scaled-limit telemetry — yields `null`.
 */
export function readBitbucketRetryNotBeforeMs(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | null {
  const raw = readHeader(headers, 'retry-after');
  if (raw === null) return null;

  const clamp = (deadlineMs: number): number => Math.min(
    deadlineMs,
    nowMs + BITBUCKET_RATE_LIMIT_WINDOW_MS,
  );

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return null;
    return clamp(nowMs + seconds * 1_000);
  }

  // Every HTTP-date form begins with a day name, so anything else is not a deadline. Handing an
  // arbitrary string to Date.parse would turn `-5` into a plausible-looking future timestamp.
  if (!/^[A-Za-z]/.test(raw)) return null;

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return clamp(parsed);
}

export function isBitbucketRateLimitedStatus(status: number): boolean {
  return status === 429;
}
