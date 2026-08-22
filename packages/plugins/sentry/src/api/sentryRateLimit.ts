/**
 * Response-local Sentry rate evidence.
 *
 * `[SOURCE]` `src/sentry/middleware/ratelimit.py:225-233` sets the
 * `X-Sentry-Rate-Limit-*` headers on **all** responses, and `:210-216` wraps the
 * limiter in a `try/except` that fails open, while self-hosted ships with
 * `SENTRY_RATELIMITER_ENABLED = False`. The headers may therefore be absent
 * entirely, so an absent header decodes as `null` and never as `0` — `0` means
 * exhausted.
 *
 * `[SOURCE]` a grep of `ratelimit.py` finds no `Retry-After`: the `Retry-After`
 * behaviour described for Sentry 429s belongs to event ingestion (`/store/`,
 * `/envelope/`), a different subsystem. This module never reads it.
 *
 * A snapshot exists only while the response that carried it is being classified.
 * It is never persisted, cached, keyed by an account or source instance, or used
 * to start a timer.
 */

import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

export type SentryRateLimitSnapshotV1 = Readonly<{
  /** null when the header was absent — never 0, which would mean "exhausted". */
  limit: number | null;
  remaining: number | null;
  /** Absolute epoch milliseconds, derived from the Reset header's epoch seconds. */
  resetAtMs: number | null;
  concurrentLimit: number | null;
  concurrentRemaining: number | null;
  /** True when no `X-Sentry-Rate-Limit-*` header was present on this response. */
  headersAbsent: boolean;
}>;

const RATE_LIMIT_HEADERS = Object.freeze({
  limit: 'x-sentry-rate-limit-limit',
  remaining: 'x-sentry-rate-limit-remaining',
  reset: 'x-sentry-rate-limit-reset',
  concurrentLimit: 'x-sentry-rate-limit-concurrentlimit',
  concurrentRemaining: 'x-sentry-rate-limit-concurrentremaining',
} as const);

/**
 * The horizon past which a `Reset` value is treated as unusable rather than
 * propagated as a retry deadline.
 *
 * Sentry's API limiter is a fixed-window/concurrency limiter whose documented
 * windows are seconds long (`[SOURCE]` `ratelimit.py` messages such as
 * "Limit is 40 requests in 1 seconds"). A reset an hour away is therefore not a
 * window this endpoint family produces; it is a clock-skewed, mis-scaled or
 * rewritten header. When it fires, the hint is dropped and the failure carries
 * no `retryNotBeforeMs`, leaving the retry decision to the shared backoff owner.
 */
export const SENTRY_MAX_RETRY_HINT_HORIZON_MS = 60 * 60 * 1000;

const INTEGER_PATTERN = /^-?\d+$/u;

function readInteger(
  headers: Readonly<Record<string, string>>,
  name: string,
): number | null {
  const raw = readTriageResponseHeaderV1(headers, name);
  if (raw === null || !INTEGER_PATTERN.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function readSentryRateLimitSnapshot(
  headers: Readonly<Record<string, string>>,
): SentryRateLimitSnapshotV1 {
  const anyHeaderPresent = Object.values(RATE_LIMIT_HEADERS)
    .some((name) => readTriageResponseHeaderV1(headers, name) !== null);
  const resetSeconds = readInteger(headers, RATE_LIMIT_HEADERS.reset);

  return Object.freeze({
    limit: readInteger(headers, RATE_LIMIT_HEADERS.limit),
    remaining: readInteger(headers, RATE_LIMIT_HEADERS.remaining),
    resetAtMs: resetSeconds === null ? null : resetSeconds * 1000,
    concurrentLimit: readInteger(headers, RATE_LIMIT_HEADERS.concurrentLimit),
    concurrentRemaining: readInteger(headers, RATE_LIMIT_HEADERS.concurrentRemaining),
    headersAbsent: !anyHeaderPresent,
  });
}

/**
 * The absolute deadline a rate-limited result may carry, or `null` when the
 * provider supplied no usable evidence. It is never synthesized from a guessed
 * schedule and never derived from a successful response.
 */
export function resolveSentryRetryNotBeforeMs(
  snapshot: SentryRateLimitSnapshotV1,
  nowMs: number,
): number | null {
  const { resetAtMs } = snapshot;
  if (resetAtMs === null) return null;
  if (!Number.isSafeInteger(resetAtMs) || resetAtMs <= nowMs) return null;
  if (resetAtMs - nowMs > SENTRY_MAX_RETRY_HINT_HORIZON_MS) return null;
  return resetAtMs;
}
