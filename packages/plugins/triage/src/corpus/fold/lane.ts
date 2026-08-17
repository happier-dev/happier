import type { TriageSourceEntrySnapshotV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The canonical, attention-free lane. It is a projection value, not a stored or
 * indexed one: nothing provider-derived is persisted, so a lane exists only for
 * as long as the window that shows it.
 */
export const CORPUS_LANE = {
    open: '1-open',
    done: '2-done',
} as const;
export type CorpusLaneV1 = (typeof CORPUS_LANE)[keyof typeof CORPUS_LANE];
export const CORPUS_LANES: readonly CorpusLaneV1[] = Object.freeze([CORPUS_LANE.open, CORPUS_LANE.done]);

/**
 * The canonical, attention-free lane of one entry.
 *
 * `unknown` is a source-neutral **present** state, so it maps to the open lane.
 * Relabelling it terminal because the source did not expose a known state would
 * make a live entry read as finished; the provider's own word stays in the
 * snapshot's `nativeLabel`.
 */
export function laneForSnapshot(snapshot: TriageSourceEntrySnapshotV1): CorpusLaneV1 {
    switch (snapshot.state.presentation) {
        case 'resolved':
        case 'closed':
        case 'suppressed':
            return CORPUS_LANE.done;
        case 'active':
        case 'unknown':
        default:
            return CORPUS_LANE.open;
    }
}

/**
 * The presentation ordinal used for "newest activity" ordering, and for nothing
 * else. It mixes provider and host clocks across entries by construction, which
 * is admissible only because it decides no content winner and no freshness
 * claim, and is never compared to anything but another `sortAtMs`.
 */
export function sortAtMsFor(input: Readonly<{
    snapshot: TriageSourceEntrySnapshotV1;
    sourceUpdatedAtMs?: number;
    observedAtMs: number;
}>): number {
    return input.sourceUpdatedAtMs ?? input.snapshot.createdAtMs ?? input.observedAtMs;
}
