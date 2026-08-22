import type {
    TriageSourceFailureV1,
    TriageSourceInstanceRefV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageListLaneV1 } from './listWindow.js';
import type { TriageListWindowSnapshotV1 } from './listWindowStore.js';

/**
 * Which configured connections could not be read, named.
 *
 * `REQ-01` asks for per-source freshness **and health**, and health that cannot
 * say whose it is only tells a reader with six connections that one of them is
 * broken. The window already carries the attribution — every lane knows its
 * `sourceInstanceId` and its contributing source (`projection/listWindow.ts`) —
 * and the snapshot already carries the user's own name for each connection, so
 * this is a join over facts the projection holds rather than any new health
 * model.
 *
 * It is one owner because both surfaces that report health need the same join:
 * the Composer picker names the connections it could not read, and the shell
 * names them beside the list. Two joins would be two answers to "which of my
 * sources is broken", and the one that drifts is always the one on screen.
 *
 * Nothing here decodes a contributor descriptor, and nothing here needs one:
 * the source's own declared display name is an entry-scoped fact the detail
 * read carries, while the connection label the user themselves gave is a
 * durable configured fact this join already holds. Naming a broken *connection*
 * by its source's declared name would also lose the distinction the whole join
 * exists for when several connections share one source.
 */

export type TriageSourceHealthV1 = Readonly<{
    sourceInstance: TriageSourceInstanceRefV1;
    /** The user's own name for the connection, or the qualified contribution id. */
    displayName: string;
    failure: TriageSourceFailureV1;
}>;

/**
 * The name to show a reader for one configured connection.
 *
 * A connection with no configured label loses the label rather than showing an
 * internal instance UUID: the qualified contribution id at least says which
 * source it is, while a UUID names the connection without telling the reader
 * anything they could act on.
 */
export function readTriageSourceDisplayName(
    snapshot: TriageListWindowSnapshotV1,
    sourceInstance: TriageSourceInstanceRefV1,
): string {
    const summary = snapshot.configuredSources.find(
        (candidate) => candidate.sourceInstanceId === sourceInstance.sourceInstanceId,
    );
    return summary?.displayLabel
        ?? `${sourceInstance.source.pluginId}/${sourceInstance.source.localId}`;
}

/**
 * Every lane that answered with a typed failure, in window order.
 *
 * `unavailable` is deliberately excluded. It means the invocation never settled
 * into provider evidence at all — a configured source whose plugin is not
 * currently admitted, or a lane this pass has not reached yet — and calling that
 * a source failure would accuse a provider that was never asked. Coverage
 * already reports it as an unfinished walk.
 */
/**
 * One configured connection this pass asked and could not read at all, named.
 *
 * It carries no `TriageSourceFailureV1` and never will: the invocation never
 * settled into provider evidence, so there is no class to classify and inventing
 * one would accuse a provider that never answered. What it does carry is the
 * store's own account of what went wrong, which is a fact about the invocation
 * and not about the source.
 */
export type TriageSourceUnreadableV1 = Readonly<{
    sourceInstance: TriageSourceInstanceRefV1;
    /** The user's own name for the connection, or the qualified contribution id. */
    displayName: string;
    /** What the store could say about the invocation that did not settle. */
    reason: string;
}>;

/**
 * Every connection the store asked and could not read, in window order.
 *
 * The predicate is the store's record of what it invoked, never the lane's
 * health word. `unavailable` also covers a lane no pass has reached, and naming
 * that one would tell a reader a connection is broken when nothing has tried it
 * yet — the same lost attribution, in the other direction.
 */
export function projectTriageUnreadableSourceHealth(
    snapshot: TriageListWindowSnapshotV1,
): readonly TriageSourceUnreadableV1[] {
    const unreadable = snapshot.unreadableSources ?? [];
    if (unreadable.length === 0) return Object.freeze([]);
    const messages = new Map(unreadable.map((entry) => [entry.sourceInstanceId, entry.message]));
    const health: TriageSourceUnreadableV1[] = [];
    for (const lane of snapshot.window?.lanes ?? []) {
        const message = messages.get(lane.sourceInstanceId);
        if (message === undefined) continue;
        const sourceInstance = { source: lane.source, sourceInstanceId: lane.sourceInstanceId };
        health.push(Object.freeze({
            sourceInstance,
            displayName: readTriageSourceDisplayName(snapshot, sourceInstance),
            reason: message,
        }));
    }
    return Object.freeze(health);
}

/**
 * One lane's own provider evidence that it could not be read, or `null`.
 *
 * The rule lives here rather than at each reader because it is one comparison
 * that is wrong in a way nobody notices: `unavailable` is not a failure, and a
 * surface that folds it in tells a reader a connection did not answer when
 * nothing asked it. The detail header re-derived exactly that and said so on
 * screen.
 */
export function readTriageLaneFailure(
    lane: TriageListLaneV1 | undefined,
): TriageSourceFailureV1 | null {
    return lane?.health.kind === 'failed' ? lane.health.failure : null;
}

export function projectTriageFailedSourceHealth(
    snapshot: TriageListWindowSnapshotV1,
): readonly TriageSourceHealthV1[] {
    const health: TriageSourceHealthV1[] = [];
    for (const lane of snapshot.window?.lanes ?? []) {
        const failure = readTriageLaneFailure(lane);
        if (failure === null) continue;
        const sourceInstance = { source: lane.source, sourceInstanceId: lane.sourceInstanceId };
        health.push(Object.freeze({
            sourceInstance,
            displayName: readTriageSourceDisplayName(snapshot, sourceInstance),
            failure,
        }));
    }
    return Object.freeze(health);
}
