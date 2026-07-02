import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS,
  UsageLimitCheckNowRateLimiter,
  resolveUsageLimitCheckNowThrottleMs,
} from './usageLimitCheckNowRateLimiter';

const THROTTLE_ENV = 'HAPPIER_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS';

describe('usageLimitCheckNowRateLimiter', () => {
  let savedEnvValue: string | undefined;

  beforeEach(() => {
    savedEnvValue = process.env[THROTTLE_ENV];
    delete process.env[THROTTLE_ENV];
  });

  afterEach(() => {
    if (savedEnvValue === undefined) {
      delete process.env[THROTTLE_ENV];
    } else {
      process.env[THROTTLE_ENV] = savedEnvValue;
    }
  });

  it('throttles repeated check-now probes per key on the planned ~30s daemon default', () => {
    // Plan contract (provider-quota-switch-recovery-unification): "default daemon throttle
    // recommendation: 30 seconds per key, configurable".
    let nowMs = 1_000_000;
    const limiter = new UsageLimitCheckNowRateLimiter({ nowMs: () => nowMs });

    expect(limiter.check('svc:profile')).toEqual({ allowed: true });

    nowMs += 29_000;
    const blocked = limiter.check('svc:profile');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterMs).toBe(1_000);
    }

    nowMs += 1_000;
    expect(limiter.check('svc:profile')).toEqual({ allowed: true });
  });

  it('keys the throttle independently per target', () => {
    const limiter = new UsageLimitCheckNowRateLimiter({ nowMs: () => 1_000_000 });
    expect(limiter.check('svc:profile-a')).toEqual({ allowed: true });
    expect(limiter.check('svc:profile-b')).toEqual({ allowed: true });
  });

  it('honors the env override over the default', () => {
    process.env[THROTTLE_ENV] = '10000';
    expect(resolveUsageLimitCheckNowThrottleMs()).toBe(10_000);
    delete process.env[THROTTLE_ENV];
    expect(resolveUsageLimitCheckNowThrottleMs()).toBe(DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS);
  });
});
