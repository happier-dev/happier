import type { ProviderAccountUsageObservationV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { QualifiedConnectedAccountQuotaSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { projectProviderAccountUsageEnteredPriceV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';

// Keep admission metadata with the exact opened object, outside the public
// snapshot schemas. A record-id map could confer a new body's proof on old data.
const contentCursors = new WeakMap<object, number>();

export function readUsageContentCursor(value: object | null): number | undefined {
    return value === null ? undefined : contentCursors.get(value);
}

export function bindUsageContentCursor<T extends object>(value: T, cursor: number | undefined): T {
    if (cursor !== undefined) contentCursors.set(value, cursor);
    return value;
}

/** A return of undefined means acquire the named record through the ordinary opener. */
export function applyUsageObservationTime(
    reading: ProviderAccountUsageSnapshotV1, observation: ProviderAccountUsageObservationV1,
): ProviderAccountUsageSnapshotV1 | undefined;
export function applyUsageObservationTime(
    reading: QualifiedConnectedAccountQuotaSnapshotV4, observation: ProviderAccountUsageObservationV1,
): QualifiedConnectedAccountQuotaSnapshotV4 | undefined;
export function applyUsageObservationTime(
    reading: ProviderAccountUsageSnapshotV1 | QualifiedConnectedAccountQuotaSnapshotV4,
    observation: ProviderAccountUsageObservationV1,
): ProviderAccountUsageSnapshotV1 | QualifiedConnectedAccountQuotaSnapshotV4 | undefined {
    const { contentCursor, fetchedAtMs, observedAtMs, subscriptionObservedAtMs } = observation;
    if (observation.contentChanged || contentCursor === undefined || contentCursor !== readUsageContentCursor(reading)
        || observedAtMs === undefined || subscriptionObservedAtMs === undefined
        || (subscriptionObservedAtMs !== null && !reading.subscription)) return undefined;
    const fetchedAt = 'fetchedAt' in reading ? reading.fetchedAt : reading.fetchedAtMs;
    if (fetchedAtMs <= fetchedAt) return reading;
    const { subscription, ...body } = reading;
    const nextSubscription = subscription && subscriptionObservedAtMs !== null
        ? { ...subscription, observedAtMs: subscriptionObservedAtMs } : undefined;
    if ('fetchedAt' in body) {
        return bindUsageContentCursor({ ...body, fetchedAt: fetchedAtMs, fetchedAtMs,
            staleAtMs: fetchedAtMs + body.staleAfterMs, ...(nextSubscription ? { subscription: nextSubscription } : {}) }, contentCursor);
    }
    const next = { ...body, fetchedAtMs, observedAtMs, ...(nextSubscription ? { subscription: nextSubscription } : {}) };
    // Only the raw opener composes a device-visible, user-entered price with
    // an otherwise absent provider subscription.
    return bindUsageContentCursor(subscriptionObservedAtMs === null && subscription?.enteredMonthlyPrice
        ? projectProviderAccountUsageEnteredPriceV1(next, subscription.enteredMonthlyPrice) : next, contentCursor);
}
