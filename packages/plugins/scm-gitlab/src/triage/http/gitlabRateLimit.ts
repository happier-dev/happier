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

/**
 * GitLab documents its request quota as a per-minute window and, for a differently
 * configured period, approximates it to "the nearest 60-minute period". A reset
 * further out than that is not a rate-limit window, so it is clamped rather than
 * allowed to park the source indefinitely.
 */
export const GITLAB_MAX_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type GitlabRetryEvidenceSource = 'retry-after' | 'ratelimit-reset' | 'ratelimit-reset-time';

export type GitlabRetryEvidence = Readonly<{
  /** Absolute epoch milliseconds. */
  retryNotBeforeMs: number;
  source: GitlabRetryEvidenceSource;
  /** True when GitLab's value exceeded the documented maximum window and was clamped. */
  clamped: boolean;
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

function clamp(nowMs: number, deadlineMs: number): { deadlineMs: number; clamped: boolean } {
  const ceiling = nowMs + GITLAB_MAX_RATE_LIMIT_WINDOW_MS;
  return deadlineMs > ceiling
    ? { deadlineMs: ceiling, clamped: true }
    : { deadlineMs, clamped: false };
}

/**
 * Converts GitLab's own retry evidence into an absolute deadline using the injected
 * clock. Returns `null` when GitLab supplied none — an application-level limit can
 * answer `429` without quota headers, and inventing a schedule there would turn one
 * user-driven read into a scheduler.
 */
export function readGitlabRetryEvidence(
  headers: GitlabResponseHeaders,
  nowMs: number,
): GitlabRetryEvidence | null {
  // `Retry-After` is the response's own instruction and wins when present.
  const retryAfterSeconds = readDeltaSeconds(headers.get('retry-after'));
  if (retryAfterSeconds !== null) {
    const { deadlineMs, clamped } = clamp(nowMs, nowMs + retryAfterSeconds * 1000);
    return { retryNotBeforeMs: deadlineMs, source: 'retry-after', clamped };
  }

  const resetSeconds = readEpochSeconds(headers.get('ratelimit-reset'));
  if (resetSeconds !== null) {
    const absoluteMs = resetSeconds * 1000;
    if (absoluteMs > nowMs) {
      const { deadlineMs, clamped } = clamp(nowMs, absoluteMs);
      return { retryNotBeforeMs: deadlineMs, source: 'ratelimit-reset', clamped };
    }
    return null;
  }

  const resetTimeMs = readHttpDateMs(headers.get('ratelimit-resettime'));
  if (resetTimeMs !== null && resetTimeMs > nowMs) {
    const { deadlineMs, clamped } = clamp(nowMs, resetTimeMs);
    return { retryNotBeforeMs: deadlineMs, source: 'ratelimit-reset-time', clamped };
  }

  return null;
}
