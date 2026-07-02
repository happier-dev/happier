export type QuotaPersistenceMaterialState = Readonly<{
  fingerprint: string;
  fetchedAt: number;
  staleAfterMs: number;
  status: 'ok' | 'unavailable' | 'estimated' | 'error';
  refreshRequestedAt?: number;
}>;

export type QuotaPersistenceDecision =
  | Readonly<{ persist: true; reason: 'first_snapshot' | 'fingerprint_changed' | 'status_changed' | 'freshness_refresh' | 'stale_after_changed' | 'refresh_marker_clearing' }>
  | Readonly<{ persist: false; reason: 'stale_snapshot' | 'unchanged_fresh' }>;

function readFiniteNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function shouldPersistQuotaSnapshot(input: Readonly<{
  previous: QuotaPersistenceMaterialState | null;
  next: QuotaPersistenceMaterialState;
  nowMs: number;
  minFreshnessMs: number;
}>): QuotaPersistenceDecision {
  if (!input.previous) return { persist: true, reason: 'first_snapshot' };
  if (input.next.fetchedAt < input.previous.fetchedAt) return { persist: false, reason: 'stale_snapshot' };
  if (input.next.fingerprint !== input.previous.fingerprint) return { persist: true, reason: 'fingerprint_changed' };
  if (input.next.status !== input.previous.status) return { persist: true, reason: 'status_changed' };
  if (input.next.staleAfterMs !== input.previous.staleAfterMs) return { persist: true, reason: 'stale_after_changed' };

  const previousRefreshRequestedAt = readFiniteNumber(input.previous.refreshRequestedAt);
  if (previousRefreshRequestedAt !== null && previousRefreshRequestedAt > input.previous.fetchedAt) {
    return { persist: true, reason: 'refresh_marker_clearing' };
  }

  const minFreshnessMs = Math.max(0, Math.trunc(input.minFreshnessMs));
  if (input.next.fetchedAt >= input.previous.fetchedAt + minFreshnessMs) {
    return { persist: true, reason: 'freshness_refresh' };
  }

  return { persist: false, reason: 'unchanged_fresh' };
}
