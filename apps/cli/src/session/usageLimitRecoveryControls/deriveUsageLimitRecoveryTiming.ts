export type UsageLimitRecoveryTimingInput = Readonly<{
  occurredAtMs: number | null | undefined;
  resetAtMs: number | null | undefined;
  retryAfterMs: number | null | undefined;
  windows?: readonly Readonly<{ remainingPct?: number; resetAtMs?: number; status?: string }>[];
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
  for (const window of input.windows ?? []) {
    const status = window.status?.toLowerCase();
    if (window.remainingPct !== 0 && status !== 'exhausted' && status !== 'limited' && status !== 'rate_limited') continue;
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
