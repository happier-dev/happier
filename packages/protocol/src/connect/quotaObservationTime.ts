export type ConnectedServiceQuotaObservationRecency =
  | 'incoming_newer'
  | 'same'
  | 'incoming_older'
  | 'incoming_future';

function normalizeTimestamp(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * A `not_loaded` snapshot or an epoch observation makes an account addressable before its first
 * provider read. The epoch is not a time anything was read, including retained empty snapshots.
 */
export function wasConnectedServiceQuotaObserved(snapshot: Readonly<{ state: string; observedAtMs: number }>): boolean {
  return snapshot.state !== 'not_loaded' && snapshot.observedAtMs > 0;
}

export function isConnectedServiceQuotaObservationAtOrBeforeNow(input: Readonly<{
  observedAtMs: number;
  nowMs: number;
}>): boolean {
  const observedAtMs = normalizeTimestamp(input.observedAtMs);
  const nowMs = normalizeTimestamp(input.nowMs);
  return observedAtMs !== null && nowMs !== null && observedAtMs <= nowMs;
}

export function isConnectedServiceQuotaObservationFresh(input: Readonly<{
  observedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
}>): boolean {
  const observedAtMs = normalizeTimestamp(input.observedAtMs);
  const nowMs = normalizeTimestamp(input.nowMs);
  const maxAgeMs = normalizeTimestamp(input.maxAgeMs);
  return observedAtMs !== null
    && nowMs !== null
    && maxAgeMs !== null
    && observedAtMs <= nowMs
    && nowMs - observedAtMs < maxAgeMs;
}

/**
 * Compare quota observation time from the current clock's perspective. Future-dated incoming
 * observations are non-authoritative, while a current observation supersedes a retained future
 * timestamp so a single clock jump cannot poison recency indefinitely.
 */
export function compareConnectedServiceQuotaObservationRecency(input: Readonly<{
  existingObservedAtMs: number;
  incomingObservedAtMs: number;
  nowMs: number;
}>): ConnectedServiceQuotaObservationRecency {
  const existingObservedAtMs = normalizeTimestamp(input.existingObservedAtMs);
  const incomingObservedAtMs = normalizeTimestamp(input.incomingObservedAtMs);
  const nowMs = normalizeTimestamp(input.nowMs);
  if (incomingObservedAtMs === null || nowMs === null || incomingObservedAtMs > nowMs) {
    return 'incoming_future';
  }
  if (existingObservedAtMs === null || existingObservedAtMs > nowMs) return 'incoming_newer';
  if (incomingObservedAtMs > existingObservedAtMs) return 'incoming_newer';
  if (incomingObservedAtMs < existingObservedAtMs) return 'incoming_older';
  return 'same';
}
