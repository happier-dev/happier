import { describe, expect, it } from 'vitest';

import { resolveScrollOffsetForVisibleRect } from './useScrollRectIntoView';

const metrics = Object.freeze({
    offsetY: 0,
    viewportHeight: 600,
    contentHeight: 4000,
});

describe('resolveScrollOffsetForVisibleRect', () => {
    it('centers a target that fits inside the viewport', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 100 },
            metrics,
            alignment: 'center',
        })).toBe(750);
    });

    it('shows the start of a target taller than the viewport instead of centering past it', () => {
        // A settings section can be taller than the viewport. Centering it puts
        // the section's own start — the control the focus request named — above
        // the top edge, so the deep link scrolls past what it was asked to show.
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 200, height: 2000 },
            metrics,
            alignment: 'center',
        })).toBe(192);
    });

    it('shows the start of an oversized target already partly visible', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 300, height: 2000 },
            metrics: { ...metrics, offsetY: 250 },
            alignment: 'center',
        })).toBe(292);
    });

    it('leaves nearest alignment on its own edges, oversized targets included', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 100 },
            metrics,
            alignment: 'nearest',
        })).toBe(508);
        // The transcript navigation rail is the only nearest caller and passes
        // marker-sized rects. Pin its bottom-edge answer so the centre fix
        // cannot silently move it.
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 2000 },
            metrics,
            alignment: 'nearest',
        })).toBe(2408);
    });

    it('reports no scroll when the target is already fully visible', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 100, height: 100 },
            metrics,
            alignment: 'center',
        })).toBeNull();
    });
});
