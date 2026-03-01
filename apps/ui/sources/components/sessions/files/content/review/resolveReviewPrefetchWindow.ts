import type { ChangedFilesReviewRow } from './buildChangedFilesReviewRows';

export type ReviewPrefetchWindow = Readonly<{ startFileIndex: number; endFileIndex: number }>;

export function resolveReviewPrefetchWindow(input: Readonly<{
    rows: readonly ChangedFilesReviewRow[];
    viewableRowIndices: readonly number[];
    aheadCount: number;
    behindCount: number;
    maxFileIndex: number;
}>): ReviewPrefetchWindow | null {
    const ahead = Number.isFinite(input.aheadCount) ? Math.max(0, input.aheadCount) : 0;
    const behind = Number.isFinite(input.behindCount) ? Math.max(0, input.behindCount) : 0;
    const maxFileIndex = Number.isFinite(input.maxFileIndex) ? Math.max(0, input.maxFileIndex) : 0;

    let minVisible = Number.POSITIVE_INFINITY;
    let maxVisible = Number.NEGATIVE_INFINITY;

    for (const rowIndex of input.viewableRowIndices) {
        if (typeof rowIndex !== 'number' || !Number.isFinite(rowIndex)) continue;
        const row = input.rows[rowIndex];
        if (!row || row.kind !== 'file') continue;
        minVisible = Math.min(minVisible, row.fileIndex);
        maxVisible = Math.max(maxVisible, row.fileIndex);
    }

    if (!Number.isFinite(minVisible) || !Number.isFinite(maxVisible)) {
        return null;
    }

    // Never include file indices *above* the first visible file. Loading diffs above the viewport can
    // change heights outside the user's view and cause scroll "snap back" (especially on web).
    //
    // Keep behindCount for future tunings, but clamp the window start to the first visible index
    // so prefetch does not trigger above-viewport height changes.
    const startFileIndex = Math.max(0, Math.min(maxFileIndex, Math.max(minVisible, minVisible - behind)));
    const endFileIndex = Math.max(0, Math.min(maxFileIndex, maxVisible + ahead));

    return { startFileIndex, endFileIndex };
}
