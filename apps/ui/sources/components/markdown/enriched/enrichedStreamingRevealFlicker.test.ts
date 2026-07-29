import { describe, expect, it } from 'vitest';

// Pure reveal-range model of the vendored enriched-markdown web renderer (shipped via
// patches/react-native-enriched-markdown+0.5.0.patch). Tested from the app repo because
// the defect and its fix live in our patch, and this suite is the RED/GREEN gate for
// regenerating it.
import { updateStreamingRevealRanges } from 'react-native-enriched-markdown/lib/module/web/streamingReveal.js';

describe('enriched streaming reveal — source-append bounding (live flicker 2026-07-13)', () => {
    it('does not re-reveal the downstream region when completing inline syntax collapses the rendered prefix', () => {
        // Rendered text is NOT append-only while markdown streams: `**bo` renders
        // literally, then the closing `**` arrives and the same region renders as bold
        // `bo` — the rendered prefix changes UPSTREAM of the tail. Diffing rendered text
        // alone re-classified everything after the change as new, re-wrapped it in
        // reveal spans, and replayed the opacity keyframe for the whole region on every
        // chunk (constant text flicker on big streaming markdown). Reveals must be
        // bounded by the genuinely APPENDED SOURCE, which is append-only.
        const previousRendered = 'intro **bold start and then a very long already-revealed paragraph of streamed text';
        const currentRendered = 'intro bold start and then a very long already-revealed paragraph of streamed text tail';
        const ranges = updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 600,
            // The chunk appended ` tail` plus the closing `**`: 7 source chars.
            previousSourceLength: 100,
            currentSourceLength: 107,
        });

        // Old words far upstream of the appended window must not re-enter the reveal.
        const revealWindowStart = currentRendered.length - (7 * 2 + 16);
        for (const range of ranges) {
            expect(range.start).toBeGreaterThanOrEqual(revealWindowStart);
        }
        expect(ranges.length).toBeGreaterThan(0);
    });

    it('reveals nothing new on a pure re-parse with no appended source', () => {
        const previousRendered = 'a **long paragraph that keeps re-parsing';
        const currentRendered = 'a long paragraph that keeps re-parsing';
        const ranges = updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 600,
            previousSourceLength: 44,
            currentSourceLength: 44,
        });
        expect(ranges).toEqual([]);
    });

    it('keeps the ordinary append path revealing exactly the appended words', () => {
        const previousRendered = 'hello world';
        const currentRendered = 'hello world and more';
        const ranges = updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 600,
            previousSourceLength: 11,
            currentSourceLength: 20,
        });
        expect(ranges.length).toBeGreaterThan(0);
        for (const range of ranges) {
            expect(range.start).toBeGreaterThanOrEqual('hello world'.length);
        }
    });
});
