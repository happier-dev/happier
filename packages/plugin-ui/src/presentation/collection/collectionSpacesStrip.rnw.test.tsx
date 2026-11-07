import { describe, expect, it } from 'vitest';

import { neighbourHappierCollectionSpaceId, resolveHappierCollectionSpaceStripRevealX } from './CollectionSpacesStrip.js';

const viewport = (x: number) => ({ x, width: 120 });

describe('revealing the selected space in an overflowing strip', () => {
    it('does not move while the tab is fully in view', () => {
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 40, width: 36 }, viewport(0))).toBeNull();
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 84, width: 36 }, viewport(0))).toBeNull();
    });

    it('scrolls only as far as needed to bring a tab past either edge into view', () => {
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 360, width: 36 }, viewport(0))).toBe(276);
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 38, width: 36 }, viewport(200))).toBe(38);
    });

    it('keeps the revealed tab clear of a faded edge, but never scrolls past either end', () => {
        const fade = { edgeInsetPx: 16, contentWidth: 460 };
        // The 5th tab ends at 120, flush with the trailing edge the fade covers: it moves 16 px further in.
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 84, width: 36 }, viewport(0), fade)).toBe(16);
        // Under the leading fade of a scrolled strip it moves out from under it too.
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 200, width: 36 }, viewport(196), fade)).toBe(184);
        // At either end there is no fade on that side to clear: the first and last tabs sit flush.
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 0, width: 36 }, viewport(30), fade)).toBe(0);
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 424, width: 36 }, viewport(300), fade)).toBe(340);
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 424, width: 36 }, viewport(340), fade)).toBeNull();
    });

    it('does nothing until the strip has a width', () => {
        expect(resolveHappierCollectionSpaceStripRevealX({ x: 360, width: 36 }, { x: 0, width: 0 })).toBeNull();
    });
});

describe('paging between spaces', () => {
    const spaces = [{ id: 'all-discussions' }, { id: 'review' }, { id: 'mentions' }];

    it('pages through the entity order and stops at either end', () => {
        expect(neighbourHappierCollectionSpaceId(spaces, 'review', 1)).toBe('mentions');
        expect(neighbourHappierCollectionSpaceId(spaces, 'review', -1)).toBe('all-discussions');
        expect(neighbourHappierCollectionSpaceId(spaces, 'mentions', 1)).toBeNull();
        expect(neighbourHappierCollectionSpaceId(spaces, 'gone', 1)).toBeNull();
    });
});
