import type {
    TriageDetailSurfaceInputV1,
    TriageEntryRepositoryRefV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageListRowV1 } from '../../projection/listWindow.js';

/**
 * The one reader of "which observation is this row actually showing".
 *
 * A window row carries every connection's observation of one entry plus the
 * Corpus decision of which of them is SELECTED
 * (`corpus/selection/selectObservationInstance.ts`). Every consumer that needs
 * the facts behind a row — the detail region's surface input, and a bulk
 * selection's per-entry Session payload — needs the same pairing: the selected
 * instance, and the present observation made through it.
 *
 * It lives here rather than at each consumer because the failure mode of a
 * second reader is silent and specific: picking the first present observation,
 * or the first instance, opens or attaches an entry under a connection the row
 * is not showing. The Corpus already decided; this only follows the decision.
 *
 * `null` means the row shows nothing openable — no instance was selected, or
 * the selected instance's observation is not `present` — which is a real state
 * for a pinned row this mount never materialized.
 */
export type TriageSelectedObservationV1 = Readonly<{
    sourceInstanceId: string;
    /**
     * Exactly the closed observation the detail contract admits. Keep the
     * source-declared repository beside it: adding that launch-only fact to
     * this object makes the published detail parse reject the whole read.
     */
    observation: TriageDetailSurfaceInputV1['observation'];
    /** The source-declared repository the launch-placement join reads. */
    repository?: TriageEntryRepositoryRefV1;
}>;

export function readTriageSelectedObservationV1(
    row: TriageListRowV1,
): TriageSelectedObservationV1 | null {
    if (row.selected.kind !== 'selected') return null;
    const sourceInstanceId = row.selected.sourceInstanceId;
    const found = row.observations.find(
        (candidate) => candidate.sourceInstanceId === sourceInstanceId
            && candidate.outcome.kind === 'present',
    );
    if (found === undefined || found.outcome.kind !== 'present') return null;
    const outcome = found.outcome;
    return {
        sourceInstanceId,
        observation: {
            entryRef: row.entryRef,
            observedAtMs: found.observedAtMs,
            locator: outcome.locator,
            snapshot: outcome.snapshot,
            viewer: outcome.viewer,
            ...(outcome.sourceUpdatedAtMs === undefined
                ? {}
                : { sourceUpdatedAtMs: outcome.sourceUpdatedAtMs }),
        },
        ...(outcome.repository === undefined ? {} : { repository: outcome.repository }),
    };
}
