import { describe, expect, it } from 'vitest';

import { buildTranscriptNavigationTimelineRows } from './buildTranscriptNavigationTimelineRows';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

function entry(id: string, createdAtMs: number | null): TranscriptNavigationEntry {
    return {
        id,
        sessionId: 's1',
        seq: 1,
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: id,
        promptPreview: id,
        responsePreview: null,
        createdAtMs,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
    };
}

function atLocal(year: number, month: number, day: number, hour: number): number {
    return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

describe('buildTranscriptNavigationTimelineRows', () => {
    it('emits no day header for a session that stays within one local day', () => {
        const rows = buildTranscriptNavigationTimelineRows([
            entry('a', atLocal(2026, 7, 27, 9)),
            entry('b', atLocal(2026, 7, 27, 18)),
        ]);

        expect(rows.map((row) => row.kind)).toEqual(['entry', 'entry']);
    });

    it('opens a day section per local day once the session spans days', () => {
        const rows = buildTranscriptNavigationTimelineRows([
            entry('a', atLocal(2026, 7, 26, 23)),
            entry('b', atLocal(2026, 7, 27, 1)),
            entry('c', atLocal(2026, 7, 27, 20)),
        ]);

        expect(rows.map((row) => (row.kind === 'day' ? 'day' : row.entry.id))).toEqual([
            'day', 'a', 'day', 'b', 'c',
        ]);
    });

    it('keeps timestamp-less entries in the preceding section instead of inventing one', () => {
        const rows = buildTranscriptNavigationTimelineRows([
            entry('a', atLocal(2026, 7, 26, 10)),
            entry('b', null),
            entry('c', atLocal(2026, 7, 27, 10)),
        ]);

        expect(rows.map((row) => (row.kind === 'day' ? 'day' : row.entry.id))).toEqual([
            'day', 'a', 'b', 'day', 'c',
        ]);
    });

    it('numbers entry rows by entry index so rail progress survives interleaved sections', () => {
        const rows = buildTranscriptNavigationTimelineRows([
            entry('a', atLocal(2026, 7, 26, 10)),
            entry('b', atLocal(2026, 7, 27, 10)),
        ]);

        expect(rows.filter((row) => row.kind === 'entry').map((row) => (row.kind === 'entry' ? row.entryIndex : -1)))
            .toEqual([0, 1]);
    });

    it('returns no rows for an empty entry list', () => {
        expect(buildTranscriptNavigationTimelineRows([])).toEqual([]);
    });
});
