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

describe('enriched streaming reveal — retained ranges are rebased onto the text they were created for', () => {
    // A reveal range is a pair of offsets into the RENDERED comparison text of the
    // render that created it. Ranges outlive that render (they are carried forward
    // for `ttlMs` so the CSS keyframe can finish), but rendered text is not
    // append-only while markdown streams: completing inline syntax, and the
    // repaired/raw markdown flip on long messages, rewrite the rendered prefix.
    // A carried-forward range must therefore never keep offsets that now denote
    // different characters — otherwise already-painted words are re-wrapped in a
    // reveal span and replay their opacity keyframe.

    it('drops a retained range whose text was rewritten by a prefix collapse', () => {
        // Repair flip: the incomplete link is replaced by its text, so the SOURCE
        // shrinks — no reveal window opens and the retained ranges are the whole
        // output. The retained range was created over '[the docs](https://exa'.
        const previousRendered = 'settled words already on screen [the docs](https://exa';
        const currentRendered = 'settled words already on screen the docs';
        const retained = { start: 32, end: 54, expiresAtMs: 10_500 };
        expect(previousRendered.slice(retained.start, retained.end)).toBe('[the docs](https://exa');

        const ranges = updateStreamingRevealRanges({
            activeRanges: [retained],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 260,
            previousSourceLength: previousRendered.length,
            currentSourceLength: currentRendered.length,
        });

        // Invariant: a carried-forward range still describes the same characters.
        for (const range of ranges) {
            expect(currentRendered.slice(range.start, range.end)).toBe(
                previousRendered.slice(range.start, range.end),
            );
        }
        // Nothing of that range survives the rewrite: the collapse starts at its start.
        expect(ranges).toEqual([]);
    });

    it('clips a retained range that straddles the collapse to the unchanged prefix', () => {
        const previousRendered = 'alpha bravo **charlie';
        const currentRendered = 'alpha bravo charlie';
        const retained = { start: 6, end: 21, expiresAtMs: 10_500 };
        expect(previousRendered.slice(retained.start, retained.end)).toBe('bravo **charlie');

        const ranges = updateStreamingRevealRanges({
            activeRanges: [retained],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 260,
            previousSourceLength: previousRendered.length,
            currentSourceLength: previousRendered.length,
        });

        for (const range of ranges) {
            expect(currentRendered.slice(range.start, range.end)).toBe(
                previousRendered.slice(range.start, range.end),
            );
        }
        // 'bravo ' is byte-identical in both renders and keeps animating; the
        // '**charlie' half described text that no longer exists.
        expect(ranges).toEqual([{ start: 6, end: 12, expiresAtMs: 10_500 }]);
    });

    it('carries a retained range unchanged across a pure append', () => {
        const previousRendered = 'hello world';
        const currentRendered = 'hello world and more';
        const ranges = updateStreamingRevealRanges({
            activeRanges: [{ start: 6, end: 11, expiresAtMs: 10_500 }],
            previousComparisonText: previousRendered,
            currentComparisonText: currentRendered,
            nowMs: 10_000,
            ttlMs: 260,
            previousSourceLength: 11,
            currentSourceLength: 20,
        });

        // Retention must survive the case it exists for: nothing upstream changed.
        expect(ranges).toContainEqual({ start: 6, end: 11, expiresAtMs: 10_500 });
        expect(ranges.some((range) => range.start >= 11)).toBe(true);
    });
});
