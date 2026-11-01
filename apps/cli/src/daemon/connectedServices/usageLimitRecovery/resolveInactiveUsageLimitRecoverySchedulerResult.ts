import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import type { UsageLimitRecoverySchedulerRecoveryResult } from './UsageLimitRecoveryScheduler';

function readRecovery(result: unknown): SessionUsageLimitRecoveryV1 | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

function readStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

export function resolveInactiveUsageLimitRecoverySchedulerResult(input: Readonly<{
  result: unknown;
  nowMs: number;
  fallbackRetryDelayMs: number;
}>): UsageLimitRecoverySchedulerRecoveryResult {
  const resultStatus = readStatus(input.result);
  const recovery = readRecovery(input.result);
  const result = input.result;
  const confirmedCancellation = result !== null && typeof result === 'object' && !Array.isArray(result)
    && (('ok' in result && result.ok === true && resultStatus === 'cancelled')
      || ('errorCode' in result && result.errorCode === 'usage_limit_recovery_attempt_superseded'));
  if (confirmedCancellation) {
    return { status: 'superseded', lastProbeError: recovery?.lastProbeError ?? null };
  }
  if (resultStatus === 'ready') {
    return {
      status: 'pause',
      ...(recovery?.selectedAuth ? { selectedAuth: recovery.selectedAuth } : {}),
      ...(recovery?.recoveryCredits ? { recoveryCredits: recovery.recoveryCredits } : {}),
    };
  }
  if (resultStatus === 'resumed') {
    return {
      status: 'resumed',
      ...(recovery?.selectedAuth ? { selectedAuth: recovery.selectedAuth } : {}),
      ...(recovery?.recoveryCredits ? { recoveryCredits: recovery.recoveryCredits } : {}),
    };
  }
  if (recovery?.status === 'exhausted') {
    return {
      status: 'exhausted',
      lastProbeError: recovery.lastProbeError,
      ...(recovery.recoveryCredits ? { recoveryCredits: recovery.recoveryCredits } : {}),
    };
  }
  if (recovery?.status === 'cancelled') {
    return { status: 'superseded', lastProbeError: recovery.lastProbeError };
  }
  if (
    recovery
    && (recovery.status === 'waiting' || recovery.status === 'armed' || recovery.status === 'checking')
    && typeof recovery.nextCheckAtMs === 'number'
  ) {
    return {
      status: 'wait',
      nextCheckAtMs: recovery.nextCheckAtMs,
      lastProbeError: recovery.lastProbeError,
      selectedAuth: recovery.selectedAuth,
      ...(recovery.recoveryCredits ? { recoveryCredits: recovery.recoveryCredits } : {}),
    };
  }
  return {
    status: 'wait',
    nextCheckAtMs: input.nowMs + input.fallbackRetryDelayMs,
    lastProbeError: 'usage_limit_recovery_probe_not_ready',
  };
}
