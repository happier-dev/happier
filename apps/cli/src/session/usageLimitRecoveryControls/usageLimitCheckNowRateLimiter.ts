export const USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE = 'probe_rate_limited';
// Plan contract (provider-quota-switch-recovery-unification): default daemon check-now
// throttle is ~30 seconds per key, configurable via env.
export const DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS = 30_000;
const USAGE_LIMIT_CHECK_NOW_THROTTLE_MS_ENV = 'HAPPIER_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS';

export type UsageLimitCheckNowRateLimitResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAfterMs: number }>;

function normalizeThrottleMs(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

export function resolveUsageLimitCheckNowThrottleMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return normalizeThrottleMs(env[USAGE_LIMIT_CHECK_NOW_THROTTLE_MS_ENV])
    ?? DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS;
}

export class UsageLimitCheckNowRateLimiter {
  private readonly lastAllowedAtMsByKey = new Map<string, number>();

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    throttleMs?: number;
  }>) {}

  check(key: string): UsageLimitCheckNowRateLimitResult {
    const throttleMs = typeof this.deps.throttleMs === 'number' && Number.isFinite(this.deps.throttleMs)
      ? Math.max(0, Math.trunc(this.deps.throttleMs))
      : resolveUsageLimitCheckNowThrottleMs();
    if (throttleMs <= 0) return { allowed: true };

    const nowMs = this.deps.nowMs();
    const lastAllowedAtMs = this.lastAllowedAtMsByKey.get(key);
    if (typeof lastAllowedAtMs === 'number') {
      const elapsedMs = Math.max(0, nowMs - lastAllowedAtMs);
      if (elapsedMs < throttleMs) {
        return { allowed: false, retryAfterMs: throttleMs - elapsedMs };
      }
    }

    this.lastAllowedAtMsByKey.set(key, nowMs);
    return { allowed: true };
  }
}
