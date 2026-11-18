import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import { isPendingUsageLimitRecoveryStatus } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';

import type { UsageLimitRecoverySchedulerRecoveryResult } from './UsageLimitRecoveryScheduler';

function readRecovery(result: unknown): SessionUsageLimitRecoveryV1 | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

function readStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

function isConfirmedCancellation(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const acknowledgement = result as { ok?: unknown; errorCode?: unknown };
  return acknowledgement.ok === true
    || acknowledgement.errorCode === 'usage_limit_recovery_attempt_superseded';
}

export function resolveInactiveUsageLimitRecoverySchedulerResult(input: Readonly<{
  result: unknown;
}>): UsageLimitRecoverySchedulerRecoveryResult {
  const resultStatus = readStatus(input.result);
  const recovery = readRecovery(input.result);
  if (resultStatus === 'cancelled' && isConfirmedCancellation(input.result)) {
    return { status: 'superseded', lastProbeError: recovery?.lastProbeError ?? null };
  }
  if (resultStatus === 'ready') {
    return {
      status: 'pause',
      ...(recovery?.selectedAuth ? { selectedAuth: recovery.selectedAuth } : {}),
    };
  }
  if (resultStatus === 'resumed') {
    return {
      status: 'resumed',
      ...(recovery?.selectedAuth ? { selectedAuth: recovery.selectedAuth } : {}),
    };
  }
  if (resultStatus === 'exhausted' || recovery?.status === 'exhausted') {
    return {
      status: 'exhausted',
      lastProbeError: recovery?.lastProbeError ?? null,
    };
  }
  if (recovery?.status === 'cancelled') {
    return { status: 'superseded', lastProbeError: recovery.lastProbeError };
  }
  if (
    recovery
    && isPendingUsageLimitRecoveryStatus(recovery.status)
  ) {
    return {
      status: 'wait',
      nextCheckAtMs: recovery.nextCheckAtMs,
      resetAtMs: recovery.resetAtMs,
      lastProbeError: recovery.lastProbeError,
      selectedAuth: recovery.selectedAuth,
    };
  }
  return {
    status: 'wait',
    nextCheckAtMs: null,
    lastProbeError: 'usage_limit_recovery_probe_not_ready',
  };
}
