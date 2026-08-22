import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import type { AzureDevOpsRateLimitEvidence } from './types.js';

/**
 * Read Azure DevOps' own rate-limit evidence, case-insensitively, exactly as returned.
 *
 * Nothing here is converted to a deadline and nothing is invented: `remaining`, `limit`,
 * `delay` and `resource` are diagnostics that never authorize a wait or a persisted limiter.
 */
export function readAzureDevOpsRateLimitEvidence(
  headers: Readonly<Record<string, string>>,
): AzureDevOpsRateLimitEvidence {
  const retryAfter = readTriageResponseHeaderV1(headers, 'retry-after');
  const retryAfterSeconds = readNonNegativeNumber(retryAfter);
  return {
    retryAfterSeconds,
    // RFC 9110 also permits an HTTP-date; Azure documents delta-seconds but the date form
    // is honored rather than discarded.
    retryAfterAtEpochMs: retryAfterSeconds === null ? readHttpDate(retryAfter) : null,
    resetEpochSeconds: readNonNegativeNumber(readTriageResponseHeaderV1(headers, 'x-ratelimit-reset')),
    remaining: readNonNegativeNumber(readTriageResponseHeaderV1(headers, 'x-ratelimit-remaining')),
    limit: readNonNegativeNumber(readTriageResponseHeaderV1(headers, 'x-ratelimit-limit')),
    delaySeconds: readNonNegativeNumber(readTriageResponseHeaderV1(headers, 'x-ratelimit-delay')),
    resource: readTriageResponseHeaderV1(headers, 'x-ratelimit-resource'),
  };
}

/**
 * Convert provider evidence into one absolute epoch-millisecond fact using the injected clock.
 *
 * Explicit `Retry-After` wins; otherwise a valid **future** `X-RateLimit-Reset` is used. With
 * neither, the result is `null` — Azure publishes no documented minimum, so inventing one
 * would be a guessed schedule rather than provider evidence.
 *
 * The instant is Azure's own and is not bounded here. Azure can return a reset far ahead, but
 * how long we are willing to wait on a provider statement is one pacing policy owned by the
 * single consumer that honours it (`plugins/triage` `refresh/refreshEligibility.ts`); a
 * source-owned ceiling here would be one of five owners of the same rule and would hide a
 * skewed reset from the one place that can bound it for every source.
 */
export function resolveAzureDevOpsRetryNotBeforeMs(
  evidence: AzureDevOpsRateLimitEvidence,
  nowMs: number,
): number | null {
  if (!Number.isFinite(nowMs)) return null;

  if (evidence.retryAfterSeconds !== null) {
    // Azure documents delta-seconds as an integer but the header is provider text: a
    // fractional value still has to leave here as the whole epoch millisecond the
    // contract declares (`TriageSourceFailureV1.retryNotBeforeMs` is an integer).
    return Math.round(nowMs + evidence.retryAfterSeconds * 1000);
  }
  if (evidence.retryAfterAtEpochMs !== null && evidence.retryAfterAtEpochMs > nowMs) {
    return Math.round(evidence.retryAfterAtEpochMs);
  }
  if (evidence.resetEpochSeconds !== null) {
    const resetMs = evidence.resetEpochSeconds * 1000;
    if (resetMs > nowMs) return Math.round(resetMs);
  }
  return null;
}

function readNonNegativeNumber(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readHttpDate(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
