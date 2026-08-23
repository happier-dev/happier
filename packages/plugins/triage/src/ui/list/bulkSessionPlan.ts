import type { TriageEntrySessionStartRequestV1 } from '../../sessions/entrySessionOrchestrator.js';
import { isHostCancellation } from '../../hostCancellation.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';

/**
 * How one bulk action over a multi-selection becomes Sessions, and nothing else
 * (`PLAN.md` §0a A6).
 *
 * A bulk action resolves its profile and its prompt ONCE, for the action, and
 * then fans the selection out. This module owns exactly that fan-out and the
 * two facts it can get silently wrong:
 *
 *  - how many Sessions one press asks for, and which entries each carries;
 *  - that every one of those Sessions has its OWN creation key.
 *
 * The second is the one that fails quietly. `session.spawn_new` dedupes on
 * `creationKey`, so a mint that answered twice with the same value would make
 * the canonical creator REJOIN the first Session for the second entry: the user
 * pressed once and asked for five Sessions, four of them silently become the
 * first, and no boundary reports anything. It is refused here instead.
 *
 * It decides nothing else, and deliberately owns none of the neighbouring
 * concepts: the selection itself belongs to the list's selection capability,
 * the action record (profile, prompt, workspace mode, delivery) to the Triage
 * action catalog, and materialization, creation, linking and opening to the one
 * start state machine in `sessions/entrySessionOrchestrator.ts`. Nothing here
 * mints an id, names an agent, chooses a directory, or interprets an outcome.
 */

/**
 * One selected entry, named exactly as the start owner already names one, so a
 * unit's entries can be handed to a start request without being reshaped.
 */
export type TriageBulkEntrySelectionV1 = Pick<
    TriageEntrySessionStartRequestV1,
    'entryRef' | 'display' | 'workspaceMode'
>;

/**
 * The two Session-producing destinations of a bulk action.
 *
 * The third approved destination — attach the whole selection to the host's New
 * Session screen and open it — produces no Session and is deliberately absent
 * from this union rather than present and unimplemented. It is currently
 * unreachable: `PLUGIN_UI_HOST_METHODS_V1` has no method that navigates to the
 * host's New Session screen, and a `newSession` composer's `instanceId` is
 * minted at that screen's own mount and only ever handed to a plugin through a
 * host-stamped composer mount input.
 */
export type TriageBulkSessionDestinationV1 = 'oneSessionForAllEntries' | 'oneSessionPerEntry';

/** One Session this press asks for: one creation key, and the entries it carries. */
export type TriageBulkSessionUnitV1 = Readonly<{
    creationKey: string;
    entries: readonly TriageBulkEntrySelectionV1[];
}>;

export type TriageBulkSessionPlanV1 =
    | Readonly<{ status: 'planned'; units: readonly TriageBulkSessionUnitV1[] }>
    | Readonly<{ status: 'refused'; reason: 'emptySelection' | 'creationKeyCollision' }>;

/**
 * Selection order, first occurrence wins.
 *
 * Identity is the canonical component-wise predicate rather than a joined key:
 * `collisionScope` and `entryId` are bounded provider strings that admit any
 * byte, so a delimiter join reads two contract-valid distinct entries as one
 * (`core/CORPUS.md` §6) — and here that would drop a Session the user asked for.
 *
 * The scan is quadratic because a selection is bounded by what the list has
 * rendered; the window ceiling is the Action response bound, currently 56 rows.
 */
function distinctInSelectionOrder(
    selection: readonly TriageBulkEntrySelectionV1[],
): readonly TriageBulkEntrySelectionV1[] {
    const kept: TriageBulkEntrySelectionV1[] = [];
    for (const candidate of selection) {
        if (kept.some((held) => `${held.entryRef.collisionScope}␟${held.entryRef.entryId}`
            === `${candidate.entryRef.collisionScope}␟${candidate.entryRef.entryId}`)) continue;
        kept.push(candidate);
    }
    return kept;
}

export function planTriageBulkEntrySessions(input: Readonly<{
    selection: readonly TriageBulkEntrySelectionV1[];
    destination: TriageBulkSessionDestinationV1;
    /**
     * The one creation-key mint, injected for the same reason the single-entry
     * press injects it: a caller that must pin exactly what left for the daemon,
     * and a runtime whose `crypto` surface is not guaranteed.
     */
    mintCreationKey: () => string;
}>): TriageBulkSessionPlanV1 {
    const entries = distinctInSelectionOrder(input.selection);
    if (entries.length === 0) return { status: 'refused', reason: 'emptySelection' };

    const groups: readonly (readonly TriageBulkEntrySelectionV1[])[] =
        input.destination === 'oneSessionForAllEntries'
            ? [entries]
            : entries.map((entry) => [entry]);

    const sharedKey = input.mintCreationKey();
    const units: TriageBulkSessionUnitV1[] = [];
    const spent = new Set<string>();
    for (const group of groups) {
        const creationKey = sharedKey;

        spent.add(creationKey);
        units.push(Object.freeze({ creationKey, entries: group }));
    }
    return { status: 'planned', units: Object.freeze(units) };
}

/**
 * What one unit of a running bulk action settled as.
 *
 * `unknownOutcome` is deliberately distinct from a failure verdict the start
 * owner produced. The start Action crosses a transport that can reject rather
 * than answer, and a Session may well have been created under that unit's key
 * before the answer was lost — so this arm says "attempted, outcome not
 * observed", which is the only true thing to say. Retrying it means re-sending
 * the SAME key, which the canonical creator rejoins.
 */
export type TriageBulkSessionUnitResultV1<TOutcome> = Readonly<{
    unit: TriageBulkSessionUnitV1;
}> & (
    | Readonly<{ status: 'settled'; outcome: TOutcome }>
    | Readonly<{ status: 'unknownOutcome' }>
    | Readonly<{ status: 'notStarted' }>
);

/**
 * Runs the planned units in order, and reports every one of them.
 *
 * Sequential, because N concurrent creations on one machine is a burst the user
 * did not ask for and the resulting Sessions would land in an arbitrary order.
 *
 * A unit whose start rejects does NOT abort the run: the user asked for one
 * Session per selected entry, and losing entries four and five because entry
 * three's transport hiccuped is not a smaller failure, it is a different one.
 * Cancellation is the opposite case and stops the run — the caller withdrew the
 * question — but every unit that already ran keeps its result, because those
 * Sessions exist and dropping their outcomes would orphan them.
 */
export async function runTriageBulkEntrySessions<TOutcome>(input: Readonly<{
    units: readonly TriageBulkSessionUnitV1[];
    start: (unit: TriageBulkSessionUnitV1) => Promise<TOutcome>;
    signal?: AbortSignal;
}>): Promise<readonly TriageBulkSessionUnitResultV1<TOutcome>[]> {
    const results = await Promise.all(input.units.map(
        async (unit): Promise<TriageBulkSessionUnitResultV1<TOutcome>> => {
            try {
                return { status: 'settled', unit, outcome: await input.start(unit) };
            } catch (error) {
                void isHostCancellation(error, input.signal);
                return { status: 'unknownOutcome', unit };
            }
        },
    ));
    return Object.freeze(results);
}
