import * as React from 'react';
import type { LocalFileReviewControl } from './hunkReview/useHunkReviewController';
import type { DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';

const noSubscription = () => () => {};

/** The per-file Keep / Discard models the hunk review controller publishes; their identity changes only with the file's own facts. */
export type ChangedFilesReviewHunkReviewModels = Readonly<{
    hunksForPath: (path: string) => DiffViewerHunks;
    fileReviewForPath?: (path: string) => LocalFileReviewControl | null;
    /** Captured evidence's canonical units; absent for the live checkout. */
    reviewUnitsForPath?: (path: string) => readonly ReviewUnit[];
}>;

/**
 * Each body reads its own file's model from this source. A publish (any file's diff landing, a Keep) re-reads
 * every mounted body's model and redraws only the bodies whose model changed; the renderer handed to the list keeps
 * its identity, so no body redraws for another file.
 */
export type ChangedFilesReviewHunkReviewSource = Readonly<{
    subscribe: (listener: () => void) => () => void;
    hunksFor: (path: string) => DiffViewerHunks | null;
    fileReviewFor: (path: string) => LocalFileReviewControl | null;
    reviewUnitsFor: (path: string) => readonly ReviewUnit[] | undefined;
}>;

export function useHunkReviewSource(models: ChangedFilesReviewHunkReviewModels | undefined): ChangedFilesReviewHunkReviewSource | undefined {
    const latest = React.useRef(models);
    latest.current = models;
    const [source] = React.useState(() => {
        const listeners = new Set<() => void>();
        return {
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            fileReviewFor: (path: string) => latest.current?.fileReviewForPath?.(path) ?? null,
            hunksFor: (path: string) => latest.current?.hunksForPath(path) ?? null,
            reviewUnitsFor: (path: string) => latest.current?.reviewUnitsForPath?.(path),
            publish: () => { for (const listener of [...listeners]) listener(); },
        };
    });
    const hunksForPath = models?.hunksForPath;
    const reviewUnitsForPath = models?.reviewUnitsForPath;
    const fileReviewForPath = models?.fileReviewForPath;
    React.useLayoutEffect(() => { source.publish(); }, [source, hunksForPath, reviewUnitsForPath, fileReviewForPath]);
    return models ? source : undefined;
}

/** A body's own file's model from the review source (null without hunk review). */
export function useChangedFilesReviewPathHunkReview(source: ChangedFilesReviewHunkReviewSource | undefined, path: string) {
    const subscribe = source?.subscribe ?? noSubscription;
    const hunks = React.useSyncExternalStore(subscribe, () => source?.hunksFor(path) ?? null, () => source?.hunksFor(path) ?? null);
    const reviewUnits = React.useSyncExternalStore(subscribe, () => source?.reviewUnitsFor(path), () => source?.reviewUnitsFor(path));
    return { hunks, reviewUnits };
}

/** A file header observes only its own local review verdict. */
export function useChangedFilesReviewPathFileReview(source: ChangedFilesReviewHunkReviewSource | undefined, path: string) {
    return React.useSyncExternalStore(source?.subscribe ?? noSubscription,
        () => source?.fileReviewFor(path) ?? null, () => source?.fileReviewFor(path) ?? null);
}
