export type CodexUsageLimitSwitchAttemptStatus =
  | 'switched'
  | 'observed_generation'
  | 'generation_apply_failed'
  | 'no_eligible_member'
  | 'manual_strategy'
  | 'auto_switch_disabled'
  | 'switch_reason_disabled'
  | 'switch_limit_reached';

export type CodexUsageLimitSwitchProgress =
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'wait_until_reset'; nextCheckAtMs: number }>
  | Readonly<{ kind: 'exhausted'; reason: string }>;

export type CodexUsageLimitRecoveryOutcomeProofKind =
  | 'fresh_candidate_selected'
  | 'terminal_exhausted';

function normalizeProfileId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveWaitTime(input: Readonly<{
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
}>): number {
  if (typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)) {
    return Math.trunc(input.resetAtMs);
  }
  if (typeof input.fallbackNextCheckAtMs === 'number' && Number.isFinite(input.fallbackNextCheckAtMs)) {
    return Math.trunc(input.fallbackNextCheckAtMs);
  }
  return input.nowMs + 60_000;
}

export function resolveCodexUsageLimitSwitchProgress(input: Readonly<{
  switchAttemptStatus: CodexUsageLimitSwitchAttemptStatus | null;
  exhaustedProfileId: string | null;
  selectedProfileId: string | null;
  verificationStatus?: 'verified' | 'weakly_verified' | null;
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
  errorCode?: string | null;
}>): CodexUsageLimitSwitchProgress {
  const waitUntilReset = (): CodexUsageLimitSwitchProgress => ({
    kind: 'wait_until_reset',
    nextCheckAtMs: resolveWaitTime(input),
  });

  switch (input.switchAttemptStatus) {
    case 'generation_apply_failed':
      return {
        kind: 'exhausted',
        reason: `connected_service_generation_apply_failed:${normalizeProfileId(input.errorCode) ?? 'unknown'}`,
      };
    case 'no_eligible_member':
      if (
        (typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs))
        || (typeof input.fallbackNextCheckAtMs === 'number' && Number.isFinite(input.fallbackNextCheckAtMs))
      ) {
        return waitUntilReset();
      }
      return { kind: 'exhausted', reason: 'connected_service_group_no_eligible_member' };
    case 'manual_strategy':
    case 'auto_switch_disabled':
    case 'switch_reason_disabled':
    case 'switch_limit_reached':
      return waitUntilReset();
    case 'switched':
    case 'observed_generation': {
      if (input.verificationStatus === 'verified') {
        return { kind: 'retry' };
      }
      return waitUntilReset();
    }
    default:
      return waitUntilReset();
  }
}

export function mapCodexUsageLimitSwitchProgressToProof(
  progress: CodexUsageLimitSwitchProgress,
): CodexUsageLimitRecoveryOutcomeProofKind | null {
  switch (progress.kind) {
    case 'retry':
      return 'fresh_candidate_selected';
    case 'exhausted':
      return 'terminal_exhausted';
    case 'wait_until_reset':
      return null;
  }
}
