import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { hasConnectedServiceQuotaObservationTime } from '@happier-dev/protocol/connect/quotaObservationTime';

declare const acquisitionClockChecked: unique symbol;

/** Only snapshots admitted by the host clock convention may enter a publication queue. */
export type AcquiredProviderAccountUsageSnapshot = ProviderAccountUsageSnapshotV1 & {
    readonly [acquisitionClockChecked]: true;
};

type QuotaObservationEvidence =
    | Readonly<{ kind: 'acquired'; acquiredAtMs: number }>
    | Readonly<{ kind: 'retained' }>;

export function normalizeAcquiredProviderAccountUsageSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    evidence: QuotaObservationEvidence,
): AcquiredProviderAccountUsageSnapshot {
    if (evidence.kind === 'retained' || snapshot.state === 'not_loaded' || snapshot.state === 'error_last_known_good'
        || (hasConnectedServiceQuotaObservationTime(snapshot.observedAtMs)
            && hasConnectedServiceQuotaObservationTime(snapshot.fetchedAtMs))) {
        return snapshot as AcquiredProviderAccountUsageSnapshot;
    }
    // When the producer supplied either clock, preserve it as evidence of the reading.
    const observedAtMs = snapshot.observedAtMs || snapshot.fetchedAtMs || evidence.acquiredAtMs;
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) {
        throw new Error('A measured quota observation requires a positive acquisition clock');
    }
    return {
        ...snapshot,
        observedAtMs,
        fetchedAtMs: snapshot.fetchedAtMs || observedAtMs,
    } as AcquiredProviderAccountUsageSnapshot;
}
