import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';

/**
 * A Team snapshot's failure in the shape every Team surface renders. Both
 * describe the same Home answer, and the snapshot keeps the Action front door's
 * typed code, so a refusal such as an Action turned off in Settings reaches the
 * page with its meaning instead of collapsing into a generic load failure.
 */
export function homeDomainFailureFromSnapshotError(error: ScopedSnapshotError): HomeDomainFailure<string> {
    return Object.freeze({ kind: error.kind, retryable: error.retryable, code: error.code ?? null,
        ...(error.details === undefined ? {} : { details: error.details }) });
}
