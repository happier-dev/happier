import type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageEntryRepositoryRefV1,
    TriageSourceEntrySnapshotV1,
    TriageSourceFailureV1,
    TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * One entry as one configured source instance answered for it, in the current
 * materialization pass.
 *
 * It is process-local: it lives in the device's projection for as long as that
 * projection is mounted and is never written to a Collection, a Settings value
 * or a file. That is what collapses the predecessor's stored
 * `authoritative` + `lastAttempt` pair into a single outcome — there is no
 * accumulated history to protect from a later failed attempt, because a pass
 * carries only what this pass observed.
 *
 * `observedAtMs` is our clock, stamped by the aggregate. `sourceUpdatedAtMs` is
 * the provider's, and nothing compares the two — or two instances' — to each
 * other.
 */
export type ProjectedObservationV1 = Readonly<{
    /** The stable configured-instance id this observation was made through. */
    sourceInstanceId: string;
    observedAtMs: number;
    outcome:
        | Readonly<{
            kind: 'present';
            locator: TriageEntryLocatorV1;
            snapshot: TriageSourceEntrySnapshotV1;
            viewer: TriageSourceViewerFactsV1;
            sourceUpdatedAtMs?: number;
            /**
             * Source-declared currentness evidence used only while folding one
             * process-local pass. It deliberately does not cross the list wire.
             */
            nativeRevision?: string;
            /**
             * The forge repository this entry belongs to, when its source
             * declared one. It is the left half of the launch-placement join
             * (`sessions/launchPlacement.ts`) and is carried on the observation
             * because that is where the source said it — the aggregate never
             * derives a repository from a locator, a scope label or a URL.
             */
            repository?: TriageEntryRepositoryRefV1;
        }>
        /**
         * Absence carries no basis of its own. `CONTRACT.md` §4 fixes the
         * serialized shape at exactly `{ kind, localRef }` and makes the
         * operation the basis: only an authoritative `get` may answer `absent`,
         * and `scan` has no absent arm at all. A `basis` member here would be
         * the aggregate re-minting a fact the boundary already established, and
         * a second absence authority is exactly what the published contract
         * exists to make unrepresentable.
         */
        | Readonly<{ kind: 'absent' }>
        | Readonly<{ kind: 'merged'; successor: TriageEntryRefV1 }>
        | Readonly<{ kind: 'unresolved'; failure: TriageSourceFailureV1 }>;
}>;

/**
 * The observations of one entry in the current pass.
 *
 * Each carries its own `sourceInstanceId`, so an instance id can never become
 * detached from the observation whose signal it carries.
 */
export type CorpusEntryObservationsV1 = readonly ProjectedObservationV1[];
