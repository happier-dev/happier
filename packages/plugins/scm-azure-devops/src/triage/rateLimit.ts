import type { AzureDevOpsRateLimitEvidence } from './types.js';

/**
 * The furthest future a provider-supplied reset is allowed to push a retry fact. Azure can
 * return a reset far ahead; carrying it verbatim would let one throttled response silence a
 * source for hours. This is a source-owned positive bound — the shared contract declares no
 * value for it.
 */
export const MAX_AZURE_RETRY_HORIZON_MS = 60 * 60 * 1000;

/**
 * Read Azure DevOps' own rate-limit evidence, case-insensitively, exactly as returned.
 *
 * Nothing here is converted to a deadline and nothing is invented: `remaining`, `limit`,
 * `delay` and `resource` are diagnostics that never authorize a wait or a persisted limiter.
 */
export function readAzureDevOpsRateLimitEvidence(
  headers: Readonly<Record<string, string>>,
): AzureDevOpsRateLimitEvidence {
  const retryAfter = readHeader(headers, 'retry-after');
  const retryAfterSeconds = readNonNegativeNumber(retryAfter);
  return {
    retryAfterSeconds,
    // RFC 9110 also permits an HTTP-date; Azure documents delta-seconds but the date form
    // is honored rather than discarded.
    retryAfterAtEpochMs: retryAfterSeconds === null ? readHttpDate(retryAfter) : null,
    resetEpochSeconds: readNonNegativeNumber(readHeader(headers, 'x-ratelimit-reset')),
    remaining: readNonNegativeNumber(readHeader(headers, 'x-ratelimit-remaining')),
    limit: readNonNegativeNumber(readHeader(headers, 'x-ratelimit-limit')),
    delaySeconds: readNonNegativeNumber(readHeader(headers, 'x-ratelimit-delay')),
    resource: readHeader(headers, 'x-ratelimit-resource'),
  };
}

/**
 * Convert provider evidence into one absolute epoch-millisecond fact using the injected clock.
 *
 * Explicit `Retry-After` wins; otherwise a valid **future** `X-RateLimit-Reset` is used. With
 * neither, the result is `null` — Azure publishes no documented minimum, so inventing one
 * would be a guessed schedule rather than provider evidence.
 */
export function resolveAzureDevOpsRetryNotBeforeMs(
  evidence: AzureDevOpsRateLimitEvidence,
  nowMs: number,
): number | null {
  if (!Number.isFinite(nowMs)) return null;

  if (evidence.retryAfterSeconds !== null) {
    return clampRetryNotBefore(nowMs + evidence.retryAfterSeconds * 1000, nowMs);
  }
  if (evidence.retryAfterAtEpochMs !== null && evidence.retryAfterAtEpochMs > nowMs) {
    return clampRetryNotBefore(evidence.retryAfterAtEpochMs, nowMs);
  }
  if (evidence.resetEpochSeconds !== null) {
    const resetMs = evidence.resetEpochSeconds * 1000;
    if (resetMs > nowMs) return clampRetryNotBefore(resetMs, nowMs);
  }
  return null;
}

function clampRetryNotBefore(candidateMs: number, nowMs: number): number {
  const bounded = Math.min(candidateMs, nowMs + MAX_AZURE_RETRY_HORIZON_MS);
  return Math.max(Math.round(bounded), nowMs);
}

export function readHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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
