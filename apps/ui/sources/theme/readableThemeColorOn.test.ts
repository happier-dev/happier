import Color from 'color';
import { describe, expect, it } from 'vitest';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio } from '@happier-dev/protocol/account/settings/themeColor';
import { readableThemeColorOn } from './themeContrast';

describe('readableThemeColorOn', () => {
    it('fixes translucent ink against its painted surface and verifies the serialized result', () => {
        const surface = '#ffffff';
        const fixed = readableThemeColorOn('rgba(240, 100, 40, 0.2)', surface, 4.5);
        const parsed = parseThemeColorValue(fixed)!;
        expect(themeContrastRatio(compositeThemeColor(parsed, [1, 1, 1]), [1, 1, 1])).toBeGreaterThanOrEqual(4.5);
        expect(Math.abs(Color(fixed).hue() - Color('rgb(240, 100, 40)').hue())).toBeLessThan(1);
        expect(Color(fixed).saturationl()).toBeGreaterThan(70);
    });

    it('retains already readable authored alpha and adjusts in either lightness direction', () => {
        expect(readableThemeColorOn('rgba(0, 0, 0, 0.8)', '#ffffff', 4.5)).toBe('rgba(0, 0, 0, 0.8)');
        const fixed = readableThemeColorOn('#713818', '#101010', 7);
        expect(themeContrastRatio(parseThemeColorValue(fixed)!.rgb, parseThemeColorValue('#101010')!.rgb)).toBeGreaterThanOrEqual(7);
        expect(Color(fixed).lightness()).toBeGreaterThan(Color('#713818').lightness());
    });
});
