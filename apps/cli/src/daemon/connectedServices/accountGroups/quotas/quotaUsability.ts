import type {
  ConnectedServiceAuthGroupQuotaMeterSnapshot,
  ConnectedServiceAuthGroupQuotaSnapshot,
} from '../selection/selectConnectedServiceAuthGroupCandidate';

/**
 * The single owner of what a member's quota evidence says about usability:
 * - `included`: included allowances remain;
 * - `credits_only`: every spent allowance is a usage allowance and the account still has provider
 *   credit headroom (Codex credits, Claude extra usage), so the provider keeps serving it;
 * - `exhausted`: a usage allowance is spent with no credit headroom, or a request-rate limit is
 *   spent (credits never lift a rate limit).
 *
 * This reads quota observations only. A provider's runtime usage-limit failure is recorded in the
 * member's limiter fields and stays authoritative over any credit headroom seen here.
 */
export type ConnectedServiceAuthGroupQuotaUsability = 'included' | 'credits_only' | 'exhausted';

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isConnectedServiceAuthGroupUsageMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'usage_limit';
}

export function isConnectedServiceAuthGroupRateLimitMeter(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  return meter.limitCategory === 'rate_limit';
}

export function connectedServiceAuthGroupMeterHasRemainingQuota(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining > 0;
}

export function isConnectedServiceAuthGroupMeterExhausted(meter: ConnectedServiceAuthGroupQuotaMeterSnapshot): boolean {
  const remaining = numberOrNull(meter.remainingPct);
  return remaining !== null && remaining <= 0;
}

export function resolveConnectedServiceAuthGroupQuotaUsability(
  snapshot: ConnectedServiceAuthGroupQuotaSnapshot,
): ConnectedServiceAuthGroupQuotaUsability {
  const meters = snapshot.meters ?? [];
  if (meters.some((meter) => isConnectedServiceAuthGroupRateLimitMeter(meter) && isConnectedServiceAuthGroupMeterExhausted(meter))) {
    return 'exhausted';
  }
  const effectiveRemaining = numberOrNull(snapshot.effectiveRemainingPercent);
  const usageSpent = snapshot.exhausted === true
    || meters.some((meter) => isConnectedServiceAuthGroupUsageMeter(meter) && isConnectedServiceAuthGroupMeterExhausted(meter))
    || (effectiveRemaining !== null && effectiveRemaining <= 0);
  if (!usageSpent) return 'included';
  return snapshot.creditsAvailable === true ? 'credits_only' : 'exhausted';
}

export function isConnectedServiceAuthGroupQuotaSnapshotExhausted(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  return resolveConnectedServiceAuthGroupQuotaUsability(snapshot) === 'exhausted';
}

/** Fresh quota that proves a member can serve work: headroom on every usage allowance, or credits. */
export function connectedServiceAuthGroupSnapshotProvesQuotaUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  if (snapshot.exhausted === true) return false;
  const usageMeters = (snapshot.meters ?? []).filter(isConnectedServiceAuthGroupUsageMeter);
  const remaining = numberOrNull(snapshot.effectiveRemainingPercent);
  const includedUsable = usageMeters.length > 0
    ? usageMeters.every(connectedServiceAuthGroupMeterHasRemainingQuota)
    : remaining !== null && remaining > 0;
  return includedUsable || resolveConnectedServiceAuthGroupQuotaUsability(snapshot) === 'credits_only';
}

export function connectedServiceAuthGroupSnapshotProvesRateLimitUsable(snapshot: ConnectedServiceAuthGroupQuotaSnapshot): boolean {
  const rateLimitMeters = (snapshot.meters ?? []).filter(isConnectedServiceAuthGroupRateLimitMeter);
  return rateLimitMeters.length > 0 && rateLimitMeters.every(connectedServiceAuthGroupMeterHasRemainingQuota);
}
