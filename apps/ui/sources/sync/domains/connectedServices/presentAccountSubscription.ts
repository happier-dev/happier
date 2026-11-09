import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';

const DAY_MS = 24 * 60 * 60 * 1000;

export type AccountSubscriptionPresentation = Readonly<{
    /** `renews` on the period end; `ends` then (not renewing); `none` (no paid plan); `period` (renewal unknown). */
    state: 'renews' | 'ends' | 'period' | 'none';
    /** Whole days until the period ends (0 = today), rounded up; null for `none`. */
    days: number | null;
    endsAtMs: number | null;
    /** When the producer last checked (the later of its read and its last failed refresh). */
    checkedAtMs: number;
    /** Older than the producer says the fact stays fresh ("may be out of date"). */
    stale: boolean;
}>;

/**
 * A provider subscription as people read it (lab `csvc` C1, D1, U1): "Renews in 17 days", "Not renewing ·
 * ends in 5 days", with the checked-at time and staleness from the producer's own freshness window. It
 * claims nothing the producer did not say: `unavailable`, or a subscribed plan without a period end, is
 * `null` (never inferred as "none").
 */
export function presentAccountSubscription(
    subscription: ProviderAccountSubscriptionV1 | null | undefined,
    nowMs: number,
): AccountSubscriptionPresentation | null {
    if (!subscription || subscription.status === 'unavailable') return null;
    const checkedAtMs = Math.max(subscription.observedAtMs, subscription.lastRefreshError?.observedAtMs ?? 0);
    const stale = nowMs - subscription.observedAtMs > subscription.staleAfterMs;
    if (subscription.status === 'none') return { state: 'none', days: null, endsAtMs: null, checkedAtMs, stale };
    const endsAtMs = subscription.currentPeriodEndAtMs;
    if (typeof endsAtMs !== 'number') return null;
    const days = Math.max(0, Math.ceil((endsAtMs - nowMs) / DAY_MS));
    const state = subscription.renewal === 'on' ? 'renews' : subscription.renewal === 'off' ? 'ends' : 'period';
    return { state, days, endsAtMs, checkedAtMs, stale };
}
