import { describe, expect, it } from 'vitest';

import { resolveChipRailCutEdges } from './resolveChipRailCutEdges';

// Chip rects relative to the rail's left edge, 6px apart, in a 300px rail.
const chip = (left: number, right: number) => ({ left, right });
const rail = { viewportWidth: 300, scrollLeft: 0 };

describe('resolveChipRailCutEdges', () => {
    it('ends the rail at the last whole chip when the next chip would be cut', () => {
        const items = [chip(0, 80), chip(86, 170), chip(176, 250), chip(256, 340)];
        // The fourth chip starts inside the rail but runs past it: it goes whole, not as "Wo…".
        expect(resolveChipRailCutEdges({ ...rail, items })).toEqual({ end: { solidUntilPx: 250, clearFromPx: 256 } });
    });

    it('keeps a chip that is mostly in view on the ordinary fade instead of hiding it behind a gap (QA-PHONE P2)', () => {
        // The 390 composer: a 298px rail whose folder chip starts at 155 and runs past the end.
        expect(resolveChipRailCutEdges({ viewportWidth: 298, scrollLeft: 0, items: [chip(0, 149), chip(155, 420)] })).toEqual({});
        expect(resolveChipRailCutEdges({ ...rail, scrollLeft: 120, items: [chip(-120, 150), chip(156, 290)] })).toEqual({});
    });

    it('leaves a rail alone when every chip is whole, or when it is scrolled to its end', () => {
        expect(resolveChipRailCutEdges({ ...rail, items: [chip(0, 80), chip(86, 170)] })).toEqual({});
        expect(resolveChipRailCutEdges({ ...rail, scrollLeft: 120, items: [chip(-120, -40), chip(0, 60), chip(66, 270)] })).toEqual({});
    });

    it('keeps the standard fade when the only chip in view is wider than the rail', () => {
        expect(resolveChipRailCutEdges({ ...rail, items: [chip(0, 420), chip(426, 500)] })).toEqual({});
    });

    it('starts the rail at the first whole chip once the leading chip is scrolled partly out', () => {
        const items = [chip(-60, 20), chip(26, 110), chip(116, 200), chip(206, 290)];
        expect(resolveChipRailCutEdges({ ...rail, scrollLeft: 60, items })).toEqual({ start: { clearUntilPx: 20, solidFromPx: 26 } });
    });

    it('clips both ends of a rail scrolled into the middle', () => {
        const items = [chip(-60, 20), chip(26, 110), chip(116, 200), chip(206, 270), chip(290, 380)];
        expect(resolveChipRailCutEdges({ ...rail, scrollLeft: 60, items })).toEqual({
            start: { clearUntilPx: 20, solidFromPx: 26 },
            end: { solidUntilPx: 270, clearFromPx: 290 },
        });
    });
});
