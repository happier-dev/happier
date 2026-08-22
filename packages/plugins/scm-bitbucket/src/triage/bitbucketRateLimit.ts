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
 * with an invented one.
 */

import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

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

export function readBitbucketRateLimitTelemetry(
  headers: Readonly<Record<string, string>>,
): BitbucketRateLimitTelemetry {
  const rawLimit = readTriageResponseHeaderV1(headers, 'x-ratelimit-limit');
  const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
  const rawNearLimit = readTriageResponseHeaderV1(headers, 'x-ratelimit-nearlimit');
  return {
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null,
    resource: readTriageResponseHeaderV1(headers, 'x-ratelimit-resource'),
    nearLimit: rawNearLimit === null ? null : rawNearLimit.toLowerCase() === 'true',
  };
}

/**
 * Returns an absolute epoch-millisecond deadline derived only from a real `Retry-After`, converted
 * through the injected clock. Both documented spellings are accepted: delta-seconds and an
 * HTTP-date. Anything else — including the advisory scaled-limit telemetry — yields `null`.
 *
 * The deadline is Bitbucket's own and is not bounded here. How far ahead a provider statement may
 * push our pacing is one policy owned by the single consumer that honours it (`plugins/triage`
 * `refresh/refreshEligibility.ts`); a private ceiling here would be one of five owners of it and
 * would hide a rewritten header from the one place that can bound it for every source.
 */
export function readBitbucketRetryNotBeforeMs(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | null {
  const raw = readTriageResponseHeaderV1(headers, 'retry-after');
  if (raw === null) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return null;
    return nowMs + seconds * 1_000;
  }

  // Every HTTP-date form begins with a day name, so anything else is not a deadline. Handing an
  // arbitrary string to Date.parse would turn `-5` into a plausible-looking future timestamp.
  if (!/^[A-Za-z]/.test(raw)) return null;

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return parsed;
}

export function isBitbucketRateLimitedStatus(status: number): boolean {
  return status === 429;
}
