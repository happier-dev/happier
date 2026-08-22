import { projectTriageEntrySearchText } from '../projection/entrySearch.js';
import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import { projectTriageFailedSourceHealth } from '../projection/sourceHealth.js';
import { projectTriageEntryDisplay } from '../ui/window/entryDisplay.js';
import type {
    TriagePickerCorpusFactsV1,
    TriagePickerCorpusRowV1,
    TriagePickerFreshnessV1,
} from './pickerModel.js';

/**
 * The picker's view of the one mounted window (`core/CORPUS.md` §4.1).
 *
 * The picker consumes the same projection and the same single-flight owner as
 * the list, so this module is a projection and never a second read: it starts
 * from a snapshot the shared store already published and reaches nothing.
 * That is what makes "opening the picker issues no provider call" (`REQ-14`) a
 * property of the shape rather than a promise — there is nothing here to call.
 *
 * Freshness arrives as a decided fact rather than a timestamp the picker
 * judges, because a local staleness ceiling here would be a second freshness
 * owner disagreeing with the list about the very same rows.
 */

function pickerFreshness(snapshot: TriageListWindowSnapshotV1): TriagePickerFreshnessV1 {
    const window = snapshot.window;
    if (window === undefined) return { kind: 'neverSynchronized' };
    if (snapshot.freshness === 'fresh') return { kind: 'current' };
    return { kind: 'stale', lastMaterializedAtMs: window.assembledAtMs };
}

export function projectTriagePickerCorpusFacts(input: Readonly<{
    snapshot: TriageListWindowSnapshotV1;
    nowMs: number;
}>): TriagePickerCorpusFactsV1 {
    const { snapshot } = input;
    const rows: TriagePickerCorpusRowV1[] = (snapshot.window?.rows ?? []).map((row) => {
        const display = projectTriageEntryDisplay(row);
        return {
            entryRef: row.entryRef,
            title: display.title,
            scopeLabel: display.scopeLabel,
            // Projected by the one search owner, so the picker answers a query
            // exactly as the list does over these same rows.
            search: projectTriageEntrySearchText(row.observations),
            // The instance decision is the window's, never re-derived here: the
            // picker must attach an entry under the same connection the list
            // would open it with.
            instance: row.selected,
        };
    });

    return Object.freeze({
        configuredSourceInstanceCount: snapshot.configuredSources.length,
        rows: Object.freeze(rows),
        // A bounded window that has not exhausted every lane is still walking,
        // which is what lets the picker say "no match yet" instead of "no match".
        coverage: snapshot.window?.coverage === 'complete' ? 'complete' : 'progressive',
        freshness: pickerFreshness(snapshot),
        refreshRunning: snapshot.pending !== 'idle',
        // The one join of failed lanes to the reader's own connection names; the
        // shell reports the same fact from the same owner.
        health: projectTriageFailedSourceHealth(snapshot),
        // Whether a Refresh press can read anything is the refresh coordinator's
        // decision, carried here verbatim. The picker used to re-derive a
        // narrower answer from rate-limit failures alone and therefore offered a
        // Refresh that the coordinator was already refusing for an aggregate
        // backoff, with no banner, no disabled control and no log.
        refreshBlocked: snapshot.refreshBlocked ?? null,
        nowMs: input.nowMs,
    });
}
