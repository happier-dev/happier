import { projectTriageEntrySearchText } from '../projection/entrySearch.js';
import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import { readTriageListSourceFailuresV1 } from '../ui/shell/windowState.js';
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
            identifierLabel: display.identifierLabel,
            lifecycleLabel: display.lifecycleLabel,
            // Projected by the one search owner, so the picker answers a query
            // exactly as the list does over these same rows.
            search: projectTriageEntrySearchText(row.observations),
            // The locator of the SAME observation the title and scope come from,
            // never a newer one from another connection: a row that routes by one
            // observation while showing another is the split this row's `content`
            // member exists to prevent.
            locator: row.content?.outcome.locator ?? null,
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
        // The page's own list of connections that could not be read, so both name the same ones.
        health: readTriageListSourceFailuresV1(snapshot),
        // Whether a Refresh press can read anything is the refresh coordinator's
        // decision, carried here verbatim. The picker used to re-derive a
        // narrower answer from rate-limit failures alone. Every source-stated
        // deadline must be reflected in the same banner and disabled control.
        refreshBlocked: snapshot.refreshBlocked ?? null,
        nowMs: input.nowMs,
    });
}
