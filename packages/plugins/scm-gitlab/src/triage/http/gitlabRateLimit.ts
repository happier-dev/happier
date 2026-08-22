/**
 * GitLab's rate-limit contract — this provider's only parser.
 *
 * GitLab publishes these headers (`RateLimit-Limit`, `RateLimit-Name`,
 * `RateLimit-Observed`, `RateLimit-Remaining`, `RateLimit-Reset`) on **every**
 * throttled-endpoint response, not only on a `429`. Presence of `RateLimit-Reset` is
 * therefore quota telemetry, never by itself evidence that a request was limited: the
 * status classifies, and this module only converts GitLab's own retry evidence into
 * an absolute deadline.
 *
 * `RateLimit-ResetTime` and `Retry-After` are documented as additionally returned
 * when the client is actually throttled.
 *
 * Nothing here sleeps, retries, or keeps quota state. GitLab publishes no minimum
 * backoff, so an application-level `429` with no retry evidence yields **no**
 * deadline rather than an invented one.
 */

import type { GitlabResponseHeaders } from './gitlabHeaders.js';

export type GitlabRetryEvidenceSource = 'retry-after' | 'ratelimit-reset' | 'ratelimit-reset-time';

export type GitlabRetryEvidence = Readonly<{
  /** Absolute epoch milliseconds, exactly as GitLab stated it. */
  retryNotBeforeMs: number;
  source: GitlabRetryEvidenceSource;
}>;

function readDeltaSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds : null;
}

function readEpochSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function readHttpDateMs(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Converts GitLab's own retry evidence into an absolute deadline using the injected
 * clock. Returns `null` when GitLab supplied none — an application-level limit can
 * answer `429` without quota headers, and inventing a schedule there would turn one
 * user-driven read into a scheduler.
 *
 * The value is GitLab's, unbounded: how long the aggregate is willing to wait on a
 * provider statement is one pacing decision owned by the single consumer that
 * honours it (`plugins/triage` `refresh/refreshEligibility.ts`). A private ceiling
 * here would be a fifth owner of that policy and would hide a skewed header from
 * the one place that can bound it for every source.
 */
export function readGitlabRetryEvidence(
  headers: GitlabResponseHeaders,
  nowMs: number,
): GitlabRetryEvidence | null {
  // `Retry-After` is the response's own instruction and wins when present.
  const retryAfterSeconds = readDeltaSeconds(headers.get('retry-after'));
  if (retryAfterSeconds !== null) {
    return { retryNotBeforeMs: nowMs + retryAfterSeconds * 1000, source: 'retry-after' };
  }

  const resetSeconds = readEpochSeconds(headers.get('ratelimit-reset'));
  if (resetSeconds !== null) {
    const absoluteMs = resetSeconds * 1000;
    return absoluteMs > nowMs
      ? { retryNotBeforeMs: absoluteMs, source: 'ratelimit-reset' }
      : null;
  }

  const resetTimeMs = readHttpDateMs(headers.get('ratelimit-resettime'));
  if (resetTimeMs !== null && resetTimeMs > nowMs) {
    return { retryNotBeforeMs: resetTimeMs, source: 'ratelimit-reset-time' };
  }

  return null;
}
