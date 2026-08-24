import { buildTriageEntryAttachmentPresentation } from '../../composer/mutationPlan.js';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageEntrySessionStartRequestV1 } from '../header/useEntrySessionStart.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';

/**
 * One selected row, as everything a Session start needs from it.
 *
 * The bulk path deliberately builds the SAME per-entry payload the single-entry
 * press builds (`ui/detail/region.tsx`): the connection the row is showing, the
 * display facts the link freezes, the bounded immutable attachment presentation
 * built by the one composer-side owner, the routing hint the observation
 * carried, and the source-declared repository the launch join reads. An entry
 * attached by a bulk press and an entry attached by a single press are then the
 * same record, resolved through the same owners.
 *
 * `action` and `preference` are absent because they belong to the PRESS, not to
 * a row: a bulk action resolves its profile and its prompt once, for the action,
 * and every unit carries the same ones (`PLAN.md` §0a A6).
 */
export type TriageBulkSelectedEntryV1 = Readonly<{ key: string }>
    & Omit<TriageEntrySessionStartRequestV1, 'action' | 'preference'>;

export type TriageBulkSelectionProjectionV1 = Readonly<{
    entries: readonly TriageBulkSelectedEntryV1[];
    /**
     * Selected keys this window can no longer supply a Session payload for —
     * a row whose connection is retired, or one this mount has never
     * materialized (a pin, or an entry the reader chose before narrowing the
     * list past it and the projection then dropped).
     *
     * They are REPORTED rather than silently dropped: a reader who selected six
     * entries and starts four Sessions must be told which two were left out,
     * and refusing the whole press over one unavailable row would throw away
     * five valid choices the reader made.
     */
    unavailableKeys: readonly string[];
}>;

/**
 * Project the selected keys onto the window that is currently loaded.
 *
 * Keys are answered in the order they are given — the order the reader built
 * the set in — so "one Session with every entry attached" attaches them in that
 * order rather than in whatever order a Set happens to iterate a rehash in.
 */
export function projectTriageBulkSelectedEntriesV1(input: Readonly<{
    rows: readonly TriageListRowV1[];
    keys: readonly string[];
}>): TriageBulkSelectionProjectionV1 {
    const rowsByKey = new Map<string, TriageListRowV1>();
    for (const row of input.rows) rowsByKey.set(triageEntryRowKey(row.entryRef), row);

    const entries: TriageBulkSelectedEntryV1[] = [];
    const unavailableKeys: string[] = [];
    for (const key of input.keys) {
        const row = rowsByKey.get(key);
        const selected = row === undefined ? null : readTriageSelectedObservationV1(row);
        if (row === undefined || selected === null) {
            unavailableKeys.push(key);
            continue;
        }
        const observation = selected.observation;
        entries.push(Object.freeze({
            key,
            entryRef: row.entryRef,
            display: {
                locator: observation.locator,
                scopeLabel: observation.snapshot.scopeLabel,
            },
            sourceInstance: {
                source: row.entryRef.source,
                sourceInstanceId: selected.sourceInstanceId,
            },
            presentation: buildTriageEntryAttachmentPresentation({
                title: observation.snapshot.title,
                scopeLabel: observation.snapshot.scopeLabel,
            }),
            lastKnownLocator: observation.locator,
            ...(selected.repository === undefined
                ? {}
                : { repository: selected.repository }),
        }));
    }
    return Object.freeze({
        entries: Object.freeze(entries),
        unavailableKeys: Object.freeze(unavailableKeys),
    });
}
