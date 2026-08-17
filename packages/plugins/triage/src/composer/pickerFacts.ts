import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import { projectTriageEntryDisplay } from '../ui/window/entryDisplay.js';
import type {
    TriagePickerCorpusFactsV1,
    TriagePickerCorpusRowV1,
    TriagePickerFreshnessV1,
    TriagePickerSourceHealthV1,
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

function pickerHealth(snapshot: TriageListWindowSnapshotV1): readonly TriagePickerSourceHealthV1[] {
    const displayLabels = new Map(snapshot.configuredSources.map(
        (source) => [source.sourceInstanceId, source.displayLabel],
    ));
    const health: TriagePickerSourceHealthV1[] = [];
    for (const lane of snapshot.window?.lanes ?? []) {
        if (lane.health.kind !== 'failed') continue;
        health.push({
            sourceInstance: { source: lane.source, sourceInstanceId: lane.sourceInstanceId },
            // The configured label is the user's own name for the connection;
            // the qualified contribution id is the honest fallback rather than
            // an invented one.
            displayName: displayLabels.get(lane.sourceInstanceId)
                ?? `${lane.source.pluginId}/${lane.source.localId}`,
            failure: lane.health.failure,
        });
    }
    return Object.freeze(health);
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
        health: pickerHealth(snapshot),
        nowMs: input.nowMs,
    });
}
