import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';

const PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV =
  'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS' as const;
const PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV =
  'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS' as const;
const DEFAULT_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS = 600_000;
const DEFAULT_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;

export function createPiUsageLimitRecoveryControlAdapter(deps: Readonly<{
  nowMs?: () => number;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): SessionUsageLimitRecoveryControlAdapter {
  return createBackoffSessionUsageLimitRecoveryControlAdapter({
    providerId: 'pi',
    fallbackBackoffEnvKey: PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_ENV,
    maxAttemptsEnvKey: PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_ENV,
    defaultFallbackBackoffMs: DEFAULT_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS,
    defaultMaxAttempts: DEFAULT_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS,
    ...deps,
  });
}

export const piUsageLimitRecoveryControlAdapter =
  createPiUsageLimitRecoveryControlAdapter();
