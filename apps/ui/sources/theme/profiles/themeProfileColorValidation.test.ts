import { describe, expect, it } from 'vitest';

import { isValidThemeProfileColorValue, normalizeOpaqueThemeHexColor } from './themeProfileColorValidation';

describe('theme profile color validation', () => {
    it('normalizes opaque appearance colours without admitting alpha or CSS expressions', () => {
        expect(normalizeOpaqueThemeHexColor(' #aBc ')).toBe('#AABBCC');
        expect(normalizeOpaqueThemeHexColor('#a1b2c3')).toBe('#A1B2C3');
        for (const value of ['#abcd', '#aabbccdd', 'red', 'rgb(1,2,3)', null]) {
            expect(normalizeOpaqueThemeHexColor(value)).toBeNull();
        }
    });
    it('accepts V1 color values supported by import and editing', () => {
        expect(isValidThemeProfileColorValue('transparent')).toBe(true);
        expect(isValidThemeProfileColorValue('#abc')).toBe(true);
        expect(isValidThemeProfileColorValue('#abcd')).toBe(true);
        expect(isValidThemeProfileColorValue('#AABBCC')).toBe(true);
        expect(isValidThemeProfileColorValue('#AABBCCDD')).toBe(true);
        expect(isValidThemeProfileColorValue('rgb(10, 20, 30)')).toBe(true);
        expect(isValidThemeProfileColorValue('rgba(10, 20, 30, 0.45)')).toBe(true);
    });

    it('rejects unsupported, malformed, and non-string color values', () => {
        const invalidValues = [
            '',
            '   ',
            'red',
            '#12',
            '#ggg',
            'rgb(256, 20, 30)',
            'rgba(10, 20, 30, 1.5)',
            'hsl(10, 50%, 50%)',
            'hsla(10, 50%, 50%, 0.5)',
            'var(--color)',
            'color-mix(in srgb, red 20%, blue)',
            { semantic: 'platform' },
            null,
            undefined,
            42,
        ] as const;

        for (const value of invalidValues) {
            expect(isValidThemeProfileColorValue(value)).toBe(false);
        }
    });
});
