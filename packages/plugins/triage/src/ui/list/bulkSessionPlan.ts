import type {
    TriageEntryRefV1,
    TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageEntrySessionStartRequestV1 } from '../../sessions/entrySessionOrchestrator.js';
import { isHostCancellation } from '../../hostCancellation.js';
import {
    planTriageOfferedActionsV1,
    type TriageActionV1,
} from '../../settings/actions.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';

/**
 * How one bulk action over a multi-selection becomes Sessions, and nothing else
 * (`PLAN.md` §0a A6).
 *
 * A bulk action resolves its profile and its prompt ONCE, for the action, and
 * then fans the selection out. This module owns exactly that fan-out and the
 * four facts it can get silently wrong:
 *
 *  - whether the source offers this exact action for each selected entry;
 *  - how an inapplicable entry is refused without aborting the other entries;
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
> & Readonly<{ workflowSubject: TriageSourceWorkflowSubjectV1 | null }>;

/**
 * The TWO things this module reads off a selected entry: its canonical
 * reference for identity/dedupe, and the exact source-declared workflow
 * subject used by the configured action planner.
 *
 * Everything else a press carries — the connection, the bounded presentation,
 * the routing hint, the repository — belongs to whoever starts the Session, and
 * naming it here would make this module a second definition of what a start
 * needs. So the fan-out is generic over the caller's own payload and constrains
 * only the member it actually compares.
 */
export type TriageBulkEntryIdentityV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    workflowSubject: TriageSourceWorkflowSubjectV1 | null;
}>;

export type TriageBulkActionRefusalV1<TEntry = TriageBulkEntrySelectionV1> = Readonly<{
    entry: TEntry;
    reason: 'workflowSubjectUnavailable' | 'actionInapplicable';
}>;

/**
 * The three approved destinations of a bulk action (`PLAN.md` §0a A6).
 *
 * Two of them produce Sessions here. The third — attach the whole selection to
 * the host's own New Session screen and open it — produces none, and is not a
 * missing arm: both halves of it now exist. Its NAVIGATION half is
 * `selectActionInput({ action: 'session.spawn_new', projection:
 * 'newSessionSeed' })`, which seeds the host's real New Session draft and opens
 * the screen; its ATTACHMENT half is the seed's declared author-shaped
 * additions, which the New Session composer applies AT ITS OWN MOUNT, where the
 * contribution authority and the host-minted instance id actually resolve
 * (`sessionComposerPresentationTargets.ts#createAttachmentAuthorityResolver`).
 * Nothing here mints an attachment identity, and after the seed the real
 * composer's canonical snapshot owns every edit and the send.
 */
export type TriageBulkSessionDestinationV1 =
    | 'oneSessionForAllEntries'
    | 'oneSessionPerEntry'
    | 'attachAllToNewSession';

/** One Session this press asks for: one creation key, and the entries it carries. */
export type TriageBulkSessionUnitV1<TEntry = TriageBulkEntrySelectionV1> = Readonly<{
    creationKey: string;
    entries: readonly TEntry[];
}>;

export type TriageBulkSessionPlanV1<TEntry = TriageBulkEntrySelectionV1> =
    | Readonly<{
        status: 'planned';
        units: readonly TriageBulkSessionUnitV1<TEntry>[];
        refusals: readonly TriageBulkActionRefusalV1<TEntry>[];
    }>
    /**
     * No Session is created and no creation key is spent: the whole deduped
     * selection is seeded into the host's New Session screen, and what becomes
     * of it there is the reader's to decide.
     */
    | Readonly<{
        status: 'seedNewSession';
        entries: readonly TEntry[];
        refusals: readonly TriageBulkActionRefusalV1<TEntry>[];
    }>
    | Readonly<{
        status: 'refused';
        reason: 'emptySelection' | 'noApplicableEntries' | 'creationKeyCollision';
        refusals?: readonly TriageBulkActionRefusalV1<TEntry>[];
    }>;

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
function distinctInSelectionOrder<TEntry extends TriageBulkEntryIdentityV1>(
    selection: readonly TEntry[],
): readonly TEntry[] {
    const kept: TEntry[] = [];
    for (const candidate of selection) {
        if (kept.some((held) => sameTriageEntryRefV1(held.entryRef, candidate.entryRef))) continue;
        kept.push(candidate);
    }
    return kept;
}

export function planTriageBulkEntrySessions<
    TEntry extends TriageBulkEntryIdentityV1 = TriageBulkEntrySelectionV1,
>(input: Readonly<{
    action: TriageActionV1;
    selection: readonly TEntry[];
    destination: TriageBulkSessionDestinationV1;
    /**
     * The one creation-key mint, injected for the same reason the single-entry
     * press injects it: a caller that must pin exactly what left for the daemon,
     * and a runtime whose `crypto` surface is not guaranteed.
     */
    mintCreationKey: () => string;
}>): TriageBulkSessionPlanV1<TEntry> {
    const entries = distinctInSelectionOrder(input.selection);
    if (entries.length === 0) return { status: 'refused', reason: 'emptySelection' };

    const applicable: TEntry[] = [];
    const refusals: TriageBulkActionRefusalV1<TEntry>[] = [];
    for (const entry of entries) {
        if (entry.workflowSubject === null) {
            refusals.push({ entry, reason: 'workflowSubjectUnavailable' });
            continue;
        }
        const offered = planTriageOfferedActionsV1([input.action], entry.workflowSubject);
        if (offered[0] !== input.action) {
            refusals.push({ entry, reason: 'actionInapplicable' });
            continue;
        }
        applicable.push(entry);
    }
    const frozenRefusals = Object.freeze(refusals);
    if (applicable.length === 0) {
        return { status: 'refused', reason: 'noApplicableEntries', refusals: frozenRefusals };
    }

    // The seed spends no creation key, because it creates nothing. Minting one
    // and discarding it would put a spent identity into a press that never
    // reached the canonical creator.
    if (input.destination === 'attachAllToNewSession') {
        return {
            status: 'seedNewSession',
            entries: Object.freeze([...applicable]),
            refusals: frozenRefusals,
        };
    }

    const groups: readonly (readonly TEntry[])[] =
        input.destination === 'oneSessionForAllEntries'
            ? [applicable]
            : applicable.map((entry) => [entry]);

    const units: TriageBulkSessionUnitV1<TEntry>[] = [];
    const spent = new Set<string>();
    for (const group of groups) {
        const creationKey = input.mintCreationKey();
        // One Session, one key. `session.spawn_new` dedupes on `creationKey`, so
        // a repeat here is not a duplicate request — it is the second Session
        // silently becoming the first.
        if (spent.has(creationKey)) {
            return {
                status: 'refused',
                reason: 'creationKeyCollision',
                ...(frozenRefusals.length === 0 ? {} : { refusals: frozenRefusals }),
            };
        }
        spent.add(creationKey);
        units.push(Object.freeze({ creationKey, entries: group }));
    }
    return { status: 'planned', units: Object.freeze(units), refusals: frozenRefusals };
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
export type TriageBulkSessionUnitResultV1<TOutcome, TEntry = TriageBulkEntrySelectionV1> = Readonly<{
    unit: TriageBulkSessionUnitV1<TEntry>;
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
export async function runTriageBulkEntrySessions<
    TOutcome,
    TEntry = TriageBulkEntrySelectionV1,
>(input: Readonly<{
    units: readonly TriageBulkSessionUnitV1<TEntry>[];
    start: (unit: TriageBulkSessionUnitV1<TEntry>) => Promise<TOutcome>;
    signal?: AbortSignal;
}>): Promise<readonly TriageBulkSessionUnitResultV1<TOutcome, TEntry>[]> {
    const results: TriageBulkSessionUnitResultV1<TOutcome, TEntry>[] = [];
    let cancelled = false;
    for (const unit of input.units) {
        if (cancelled || input.signal?.aborted === true) {
            results.push({ status: 'notStarted', unit });
            continue;
        }
        try {
            results.push({ status: 'settled', unit, outcome: await input.start(unit) });
        } catch (error) {
            // The key is retained on the unit this result carries, so a retry
            // re-sends the SAME key and the canonical creator rejoins rather
            // than creating a second Session for one entry.
            results.push({ status: 'unknownOutcome', unit });
            if (isHostCancellation(error, input.signal)) cancelled = true;
        }
    }
    return Object.freeze(results);
}
