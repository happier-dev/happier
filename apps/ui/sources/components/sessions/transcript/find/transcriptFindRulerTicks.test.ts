import { describe, expect, it } from 'vitest';
import { resolveTranscriptFindRulerTicks } from './transcriptFindRulerTicks';

const rows: Record<string, { y: number; height: number }> = {
    a: { y: 0, height: 100 },
    b: { y: 500, height: 100 },
    c: { y: 501, height: 100 },
    far: { y: 1900, height: 100 },
};

describe('transcript Find overview ruler', () => {
    it('places each matched message where its row sits in the scroll content, without mounting it', () => {
        const ticks = resolveTranscriptFindRulerTicks({
            messageIds: ['a', 'b', 'far'], currentMessageId: 'b', contentHeight: 2000, trackHeight: 200,
            measure: (id) => rows[id] ?? null,
        });
        expect(ticks).toEqual([
            { key: 'a', top: 0, current: false },
            { key: 'b', top: 50, current: true },
            { key: 'far', top: 190, current: false },
        ]);
    });

    it('skips messages the list cannot place and merges marks that land on the same pixel, keeping the current one', () => {
        const ticks = resolveTranscriptFindRulerTicks({
            messageIds: ['b', 'c', 'unmounted-and-unknown'], currentMessageId: 'c', contentHeight: 2000, trackHeight: 200,
            measure: (id) => rows[id] ?? null,
        });
        expect(ticks).toEqual([{ key: 'c', top: 50, current: true }]);
    });

    it('draws nothing before the content has a height', () => {
        expect(resolveTranscriptFindRulerTicks({ messageIds: ['a'], currentMessageId: 'a', contentHeight: 0,
            trackHeight: 200, measure: (id) => rows[id] ?? null })).toEqual([]);
    });
});
