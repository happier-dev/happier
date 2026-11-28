import { describe, expect, it } from 'vitest';

import { SUPPORTER_PASS_STYLE_IDS } from '@/sync/domains/settings/registry/local/supporterPassStyleSetting';

import { passGlyphPaths } from './passArt';
import { passArtSpec } from './passArtStyles';

describe('passGlyphPaths', () => {
    it('draws the holder number out of the field’s own cells, and none on the blank pass', () => {
        const blank = passGlyphPaths(null);
        const fortyTwo = passGlyphPaths(42);

        expect(blank.digits).toBe('');
        expect(fortyTwo.digits.length).toBeGreaterThan(0);
        // Each number is its own picture; the same number is the same picture.
        expect(passGlyphPaths(1291).digits).not.toBe(fortyTwo.digits);
        expect(passGlyphPaths(42)).toBe(fortyTwo);
        // The plate clears the sky around the digits, so the field differs from the blank one.
        expect(fortyTwo.field).not.toBe(blank.field);
    });
});

describe('passArtSpec', () => {
    // The seeded arts put the holder's number into the picture; the rest are one image per edition.
    const NUMBERED = new Set(['glyph-number', 'star-chart', 'embossed-number']);

    it('draws every style in both materials as a pure function of style, material and number', () => {
        for (const style of SUPPORTER_PASS_STYLE_IDS) {
            for (const material of ['graphite', 'paper'] as const) {
                const art = passArtSpec(style, material, 42);
                expect(art.layers.length).toBeGreaterThan(0);
                expect(passArtSpec(style, material, 42)).toBe(art);
            }
            expect(passArtSpec(style, 'paper', 42)).not.toEqual(passArtSpec(style, 'graphite', 42));
        }
    });

    it('puts the number in the numbered arts only, and leaves it out of the blank pass', () => {
        for (const style of SUPPORTER_PASS_STYLE_IDS) {
            const seven = passArtSpec(style, 'paper', 7);
            const blank = passArtSpec(style, 'paper', null);
            if (NUMBERED.has(style)) {
                expect(passArtSpec(style, 'paper', 1291)).not.toEqual(seven);
                expect(blank).not.toEqual(seven);
                expect(blank.layers.some((layer) => layer.kind === 'text')).toBe(false);
            } else {
                expect(passArtSpec(style, 'paper', 1291)).toBe(seven);
                expect(blank).toBe(seven);
            }
        }
    });
});
