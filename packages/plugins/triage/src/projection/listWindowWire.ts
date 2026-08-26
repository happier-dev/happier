import type {
    TriageListEntriesResultV1,
} from '../actions/listEntriesProtocol.js';
import type { ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';
import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import type { TriageListRowV1, TriageListWindowV1 } from './listWindow.js';

/**
 * The one projection between the assembled window and the list Action's wire.
 *
 * Both directions live here because they are one contract. The wire carries
 * one complete folded answer for every connection that observed a row: the
 * rendered answer first, then the remaining answers in a stable order. The
 * mounted store rehydrates that complete set through the canonical fold, rather
 * than making a second local attention or selection decision.
 *
 * Keeping the inverse beside it is what makes the mounted store's rehydration
 * checkable against the same rule instead of guessing at it.
 */

type WireRows = TriageListEntriesResultV1['window']['rows'];
type WireRow = WireRows[number];

function byInstanceIdAscending(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * The one connection's answer the row is rendered from.
 *
 * It is the fold's own `content` decision rather than a second one: the wire
 * carries exactly the observation the display renders from, so a row read back
 * off the wire says what the row that produced it said. Choosing here again —
 * the selected connection, or whichever answered last — is how the wire, the
 * fold and the display came to hold three rules for one question.
 *
 * A row with no present answer anywhere still carries its newest answer of any
 * kind, so `presence` and the identity-only display have the observation they
 * describe.
 */
function renderedObservation(row: TriageListRowV1): ProjectedObservationV1 | undefined {
    if (row.content !== null) return row.content;
    let newest: ProjectedObservationV1 | undefined;
    for (const observation of row.observations) {
        if (newest === undefined || observation.observedAtMs > newest.observedAtMs) newest = observation;
    }
    return newest;
}

/**
 * The newest answer of each connection that answered for this entry.
 *
 * One connection answering twice in a pass — the same entry on two pages — is
 * one connection, not two: the row reports who observed it, and a duplicate
 * would both overstate `observedByCount` and spend a slot another connection
 * needs.
 */
function newestByConnection(row: TriageListRowV1): Map<string, ProjectedObservationV1> {
    const byConnection = new Map<string, ProjectedObservationV1>();
    for (const observation of row.observations) {
        const current = byConnection.get(observation.sourceInstanceId);
        if (current !== undefined && current.observedAtMs >= observation.observedAtMs) continue;
        byConnection.set(observation.sourceInstanceId, observation);
    }
    return byConnection;
}

/**
 * The other connections, attention first and then by stable id.
 *
 * The id order is deliberate: two connections' observation clocks come from two
 * machines and are not comparable, so ordering by them would make the wire
 * depend on a comparison the rest of this projection refuses to make. Putting
 * the attention connection first is what keeps a row from naming a connection
 * in `attention` that its own list omits.
 */
function otherObservations(
    row: TriageListRowV1,
    byConnection: ReadonlyMap<string, ProjectedObservationV1>,
    renderedInstanceId: string,
): WireRow['otherObservations'] {
    const attentionInstanceId = row.attention?.fromSourceInstanceId;
    const rest = [...byConnection.values()]
        .filter((observation) => observation.sourceInstanceId !== renderedInstanceId
            && observation.sourceInstanceId !== attentionInstanceId)
        .sort((left, right) => byInstanceIdAscending(left.sourceInstanceId, right.sourceInstanceId));
    const attention = attentionInstanceId === undefined || attentionInstanceId === renderedInstanceId
        ? undefined
        : byConnection.get(attentionInstanceId);
    return attention === undefined ? rest : [attention, ...rest];
}

/** Project one assembled window's rows onto the list Action's wire. */
export function toTriageListWireRows(window: TriageListWindowV1): WireRows {
    const rows: WireRow[] = [];
    for (const row of window.rows) {
        const observation = renderedObservation(row);
        // A row exists because some connection answered for it, so the fold
        // cannot produce one without an observation; there is simply nothing to
        // project when it somehow did.
        if (observation === undefined) continue;
        const byConnection = newestByConnection(row);
        rows.push({
            entryRef: row.entryRef,
            lane: row.lane,
            sortAtMs: row.sortAtMs,
            presence: {
                kind: row.presence.kind,
                ...(row.presence.observedAtMs === null ? {} : { observedAtMs: row.presence.observedAtMs }),
            },
            ...(row.attention === null ? {} : { attention: row.attention }),
            selected: row.selected,
            observation,
            otherObservations: otherObservations(row, byConnection, observation.sourceInstanceId),
            observedByCount: byConnection.size,
        });
    }
    return rows;
}

/**
 * The complete folded observations of one connection, rehydrated with the
 * canonical ref each row carries.
 *
 * The mounted store drives one mixed Action pass for every included connection.
 * A row is rendered from only one of those connections, but its other complete
 * observations belong to the same pass and must re-enter the fold through their
 * own lanes. Returning only the rendered answer would give the wire a second,
 * lossy source-selection rule.
 */
export function laneObservationsFromWire(
    result: TriageListEntriesResultV1,
    sourceInstanceId: string,
): readonly CorpusQualifiedObservationV1[] {
    const observations: CorpusQualifiedObservationV1[] = [];
    for (const row of result.window.rows) {
        for (const observation of [row.observation, ...row.otherObservations]) {
            if (observation.sourceInstanceId !== sourceInstanceId) continue;
            observations.push({ ...observation, entryRef: row.entryRef });
        }
    }
    return observations;
}
