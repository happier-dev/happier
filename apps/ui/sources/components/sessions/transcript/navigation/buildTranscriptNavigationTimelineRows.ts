import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

export type TranscriptNavigationTimelineRow =
    | Readonly<{ kind: 'day'; id: string; dayStartMs: number }>
    | Readonly<{ kind: 'entry'; id: string; entry: TranscriptNavigationEntry; entryIndex: number }>;

function resolveDayStartMs(atMs: number): number {
    const date = new Date(atMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function normalizeTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Flattens navigation entries into the timeline's render rows.
 *
 * Day headers only appear when the session actually spans more than one local day — a
 * single-day session should read as one continuous spine, not as a list with one
 * redundant "Today" banner. Entries without a timestamp join whatever group precedes
 * them rather than inventing a bucket of their own.
 *
 * `entryIndex` is the index within `entries`, not within the returned rows, so the rail's
 * "travelled" tint stays correct once day sections are interleaved.
 */
export function buildTranscriptNavigationTimelineRows(
    entries: readonly TranscriptNavigationEntry[],
): readonly TranscriptNavigationTimelineRow[] {
    if (entries.length === 0) return [];

    const dayStarts: (number | null)[] = entries.map((entry) => {
        const createdAtMs = normalizeTimestamp(entry.createdAtMs);
        return createdAtMs === null ? null : resolveDayStartMs(createdAtMs);
    });
    const distinctDays = new Set(dayStarts.filter((value): value is number => value !== null));
    const groupByDay = distinctDays.size > 1;

    const rows: TranscriptNavigationTimelineRow[] = [];
    let lastDayStartMs: number | null = null;
    entries.forEach((entry, entryIndex) => {
        const dayStartMs = dayStarts[entryIndex] ?? null;
        if (groupByDay && dayStartMs !== null && dayStartMs !== lastDayStartMs) {
            rows.push({ kind: 'day', id: `day:${dayStartMs}`, dayStartMs });
            lastDayStartMs = dayStartMs;
        }
        rows.push({ kind: 'entry', id: entry.id, entry, entryIndex });
    });
    return rows;
}
