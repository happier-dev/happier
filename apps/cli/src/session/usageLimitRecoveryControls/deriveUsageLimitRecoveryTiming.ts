// Resume just after the provider's boundary, allowing its window reset to settle.
export const USAGE_LIMIT_RECOVERY_RESET_MARGIN_MS = 5_000;

export type UsageLimitRecoveryTimingInput = Readonly<{
  occurredAtMs: number | null | undefined;
  resetAtMs: number | null | undefined;
  retryAfterMs: number | null | undefined;
  windows?: readonly Readonly<{ remainingPct?: number | null; resetAtMs?: number | null }>[];
}>;

export type UsageLimitRecoveryTiming = Readonly<{
  resetAtMs: number | null;
  nextCheckAtMs: number | null;
}>;

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function deriveUsageLimitRecoveryTiming(input: UsageLimitRecoveryTimingInput): UsageLimitRecoveryTiming {
  const blockingResets = (input.windows ?? [])
    .filter((window) => typeof window.remainingPct === 'number' && window.remainingPct <= 0)
    .map((window) => normalizeNonNegativeInteger(window.resetAtMs));
  if (blockingResets.some((reset) => reset === null)) return { resetAtMs: null, nextCheckAtMs: null };
  const resets = [normalizeNonNegativeInteger(input.resetAtMs), ...blockingResets]
    .filter((value): value is number => value !== null);
  const resetAtMs = resets.length > 0 ? Math.max(...resets) : null;
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
