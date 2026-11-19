import type { SessionRuntimeUsageLimitDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

export type UsageLimitRecoveryTimingInput = Readonly<{
  occurredAtMs: number | null | undefined;
  resetAtMs: number | null | undefined;
  retryAfterMs: number | null | undefined;
  allWindows?: SessionRuntimeUsageLimitDetailsV1['allWindows'];
}>;

export type UsageLimitRecoveryTiming = Readonly<{
  resetAtMs: number | null;
  nextCheckAtMs: number | null;
}>;

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function deriveUsageLimitRecoveryTiming(input: UsageLimitRecoveryTimingInput): UsageLimitRecoveryTiming {
  let resetAtMs = normalizeNonNegativeInteger(input.resetAtMs);
  for (const window of input.allWindows ?? []) {
    if (window.remainingPct !== 0) continue;
    const windowResetAtMs = normalizeNonNegativeInteger(window.resetAtMs);
    if (windowResetAtMs === null) return { resetAtMs: null, nextCheckAtMs: null };
    resetAtMs = resetAtMs === null ? windowResetAtMs : Math.max(resetAtMs, windowResetAtMs);
  }
  if (resetAtMs !== null) {
    return { resetAtMs, nextCheckAtMs: resetAtMs };
  }

  const occurredAtMs = normalizeNonNegativeInteger(input.occurredAtMs);
  const retryAfterMs = normalizeNonNegativeInteger(input.retryAfterMs);
  const nextCheckAtMs = occurredAtMs !== null && retryAfterMs !== null
    ? occurredAtMs + retryAfterMs
    : null;

  return { resetAtMs: null, nextCheckAtMs };
}
