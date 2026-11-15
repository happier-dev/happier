import { describe, expect, it } from 'vitest';

import { resolveModalCardDimensions } from './useModalCardDimensions';

describe('resolveModalCardDimensions', () => {
    it('uses the standard dialog width by default and preserves explicit narrow and wide presets', () => {
        const viewport = { width: 1440, height: 1000 };
        expect(resolveModalCardDimensions(viewport).width).toBe(464);
        expect(resolveModalCardDimensions(viewport, { size: 'dialog' }).width).toBe(360);
        expect(resolveModalCardDimensions(viewport, { size: 'md' }).width).toBe(560);
        expect(resolveModalCardDimensions(viewport, { size: 'lg' }).width).toBe(840);
    });

    it('falls back to a non-zero width when window dimensions are not yet available', () => {
        const dimensions = resolveModalCardDimensions(
            { width: 0, height: 0 },
            { size: 'md', width: 500 },
        );

        expect(dimensions.width).toBe(500);
        expect(dimensions.maxHeight).toBeGreaterThan(0);
    });

    it('supports tighter viewport margins for mobile-sized modal cards', () => {
        const dimensions = resolveModalCardDimensions(
            { width: 441, height: 956 },
            {
                size: 'lg',
                width: 560,
                maxHeightRatio: 0.96,
                viewportMargin: { horizontal: 12, vertical: 12 },
            },
        );

        expect(dimensions).toEqual({
            width: 417,
            maxHeight: 860,
        });
    });

    it('never lets the card minimum height exceed the actual short viewport', () => {
        const dimensions = resolveModalCardDimensions(
            { width: 900, height: 280 },
            { size: 'lg', width: 800, maxHeightRatio: 0.7 },
        );

        expect(dimensions.maxHeight).toBe(184);
    });

    it('shrinks on smaller windows while retaining the minimum preferred width', () => {
        expect(resolveModalCardDimensions({ width: 360, height: 420 }, { size: 'lg' })).toEqual({
            width: 320,
            maxHeight: 324,
        });
    });

    it('never lets a preferred minimum width run a card past a phone window\'s sheet gutter', () => {
        // 308 px window: the md minimum (320) would cut both of the card's sides off.
        expect(resolveModalCardDimensions({ width: 308, height: 844 }).width).toBe(276);
        expect(resolveModalCardDimensions({ width: 308, height: 844 }, { size: 'dialog' }).width).toBe(276);
    });

    it('still fits within narrow windows when an explicit width is requested', () => {
        expect(resolveModalCardDimensions(
            { width: 360, height: 680 },
            { size: 'lg', width: 560 },
        )).toEqual({
            width: 280,
            maxHeight: 578,
        });
    });

    it('preserves a minimum vertical viewport margin for near-full-height cards', () => {
        expect(resolveModalCardDimensions(
            { width: 393, height: 736 },
            {
                size: 'lg',
                width: 720,
                maxHeightRatio: 0.96,
                viewportMargin: { horizontal: 12, vertical: 12 },
            },
        )).toEqual({
            width: 369,
            maxHeight: 640,
        });
    });

    it('does not hard-cap dialog height when its requested ratio allows a larger card', () => {
        expect(resolveModalCardDimensions(
            { width: 1200, height: 1000 },
            { size: 'dialog', maxHeightRatio: 0.85 },
        )).toEqual({
            width: 360,
            maxHeight: 850,
        });
    });
});
