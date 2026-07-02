import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

export const USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_EXHAUSTED_ERROR =
  'usage_limit_recovery_max_attempts_exhausted' as const;

export function resolveUsageLimitRecoveryMaxAttemptsExhaustion(
  intent: SessionUsageLimitRecoveryV1,
): SessionUsageLimitRecoveryV1 | null {
  if (intent.maxAttempts <= 0 || intent.attemptCount < intent.maxAttempts) {
    return null;
  }

  return {
    ...intent,
    status: 'exhausted',
    attemptCount: intent.attemptCount + 1,
    lastProbeError: intent.lastProbeError ?? USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_EXHAUSTED_ERROR,
  };
}
