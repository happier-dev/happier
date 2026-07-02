export type UsageLimitRecoveryTimingInput = Readonly<{
  occurredAtMs: number | null | undefined;
  resetAtMs: number | null | undefined;
  retryAfterMs: number | null | undefined;
}>;

export type UsageLimitRecoveryTiming = Readonly<{
  resetAtMs: number | null;
  nextCheckAtMs: number | null;
}>;

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function deriveUsageLimitRecoveryTiming(input: UsageLimitRecoveryTimingInput): UsageLimitRecoveryTiming {
  const resetAtMs = normalizeNonNegativeInteger(input.resetAtMs);
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
