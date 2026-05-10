export type MonotonicUpdatedAtPolicy = 'ignore_older' | 'force_update';

/**
 * Compute the updatedAt timestamp to use for a timestamped field update.
 *
 * This is a tiny shared helper used by both UI and CLI to keep "latest wins" behavior consistent
 * without duplicating edge-case handling.
 *
 * Policies:
 * - `ignore_older`: only apply when desiredUpdatedAt is strictly newer than previousUpdatedAt.
 * - `force_update`: if desiredUpdatedAt is not newer but desiredValue differs, bump to previousUpdatedAt + 1.
 */
export function computeMonotonicUpdatedAt(params: Readonly<{
  previousUpdatedAt: number;
  desiredUpdatedAt: number;
  previousValue: string;
  desiredValue: string;
  policy: MonotonicUpdatedAtPolicy;
}>): number | null {
  const prevAt = Number.isFinite(params.previousUpdatedAt) ? params.previousUpdatedAt : 0;
  const desiredAt = Number.isFinite(params.desiredUpdatedAt) ? params.desiredUpdatedAt : 0;

  const prevValue = typeof params.previousValue === 'string' ? params.previousValue : '';
  const desiredValue = typeof params.desiredValue === 'string' ? params.desiredValue : '';

  if (desiredAt > prevAt) return desiredAt;

  if (params.policy === 'ignore_older') return null;
  if (desiredValue === prevValue) return null;

  return prevAt + 1;
}
