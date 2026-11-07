import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { createScmReviewedSelections } from '@/sync/domains/scm/diffSummary/reviewedMarks';

import type { WalkthroughReading, WalkthroughStop } from './walkthroughReading';

type Subscribe = (listener: () => void) => () => void;
export type WalkthroughReviewedSource = Readonly<{
    base: WalkthroughReading;
    getBase: () => WalkthroughReading;
    getSnapshot: () => WalkthroughReading;
    getStop: (id: string) => WalkthroughStop | undefined;
    getReviewedCount: () => number;
    subscribe: Subscribe;
    subscribeProgress: Subscribe;
    subscribeStop: (id: string, listener: () => void) => () => void;
    apply: (record: ScmReviewedMarksRecord | null) => void;
}>;

/** An unmarked captured reading owns membership once; personal records publish only affected stop facts. */
export function createWalkthroughReviewedSource(base: WalkthroughReading, comparison: ScmComparison): WalkthroughReviewedSource {
    const selections = createScmReviewedSelections(comparison, base.stops);
    const stopIndexes = new Map(base.stops.map((stop, index) => [stop.id, index]));
    const notePathsByStop = new Map<string, Set<string>>();
    for (const [path, hunks] of base.explainNotesByHunk) for (const notes of hunks) for (const note of notes) {
        if (!note.stop) continue;
        let paths = notePathsByStop.get(note.stop.id);
        if (!paths) notePathsByStop.set(note.stop.id, paths = new Set());
        paths.add(path);
    }
    const listeners = new Set<() => void>();
    const progressListeners = new Set<() => void>();
    const stopListeners = new Map<string, Set<() => void>>();
    let snapshot = base;
    let structural: WalkthroughReading;
    const source: WalkthroughReviewedSource = {
        get base() { return structural; },
        getBase: () => structural,
        getSnapshot: () => snapshot,
        getStop: id => snapshot.stops[stopIndexes.get(id) ?? -1],
        getReviewedCount: () => snapshot.reviewedCount,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeProgress: listener => { progressListeners.add(listener); return () => { progressListeners.delete(listener); }; },
        subscribeStop: (id, listener) => {
            let callbacks = stopListeners.get(id);
            if (!callbacks) stopListeners.set(id, callbacks = new Set());
            callbacks.add(listener);
            return () => { callbacks.delete(listener); if (!callbacks.size) stopListeners.delete(id); };
        },
        apply: record => {
            const changedStops = new Map<string, WalkthroughStop>();
            for (const [index, reviewed] of selections.apply(record)) {
                const stop = snapshot.stops[index]!;
                changedStops.set(stop.id, { ...stop, reviewed });
            }
            if (!changedStops.size) return;
            const stops = snapshot.stops.slice();
            const paths = new Set<string>();
            for (const [id, stop] of changedStops) {
                stops[stopIndexes.get(id)!] = stop;
                for (const path of notePathsByStop.get(id) ?? []) paths.add(path);
            }
            const explainNotesByHunk = new Map(snapshot.explainNotesByHunk);
            for (const path of paths) explainNotesByHunk.set(path, snapshot.explainNotesByHunk.get(path)!.map(notes => {
                const changed = notes.some(note => note.stop && changedStops.has(note.stop.id));
                return changed ? notes.map(note => {
                    const stop = note.stop && changedStops.get(note.stop.id);
                    return stop ? { ...note, stop } : note;
                }) : notes;
            }));
            const reviewedCount = selections.getReviewedCount();
            const progressChanged = reviewedCount !== snapshot.reviewedCount;
            snapshot = { ...snapshot, stops, reviewedCount, explainNotesByHunk };
            for (const id of changedStops.keys()) for (const listener of stopListeners.get(id) ?? []) listener();
            if (progressChanged) for (const listener of progressListeners) listener();
            for (const listener of listeners) listener();
        },
    };
    structural = { ...base, reviewedSource: source };
    snapshot = structural;
    return source;
}

