import { describe, expect, it } from 'vitest';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio, themeLinearToSrgb, themeRelativeLuminance, themeSrgbToLinear } from './themeColor.js';

describe('portable theme colour primitives', () => {
    it('retains RGB and alpha across the admitted colour syntaxes', () => {
        expect(parseThemeColorValue('#1234')).toEqual({ rgb: [17 / 255, 34 / 255, 51 / 255], alpha: 68 / 255 });
        expect(parseThemeColorValue('#11223344')).toEqual(parseThemeColorValue('#1234'));
        expect(parseThemeColorValue(' rgba(17, 34, 51, .25) ')).toEqual({ rgb: [17 / 255, 34 / 255, 51 / 255], alpha: 0.25 });
        expect(parseThemeColorValue('rgb(17, 34, 51)')).toEqual({ rgb: [17 / 255, 34 / 255, 51 / 255], alpha: 1 });
        expect(parseThemeColorValue('transparent')).toEqual({ rgb: [0, 0, 0], alpha: 0 });
        for (const invalid of ['#12345', '#1234567', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 1.1)', 'rgba(0, 0, 0)', 'var(--ink)']) {
            expect(parseThemeColorValue(invalid)).toBeNull();
        }
    });

    it('uses sRGB transfer and luminance weights with source-over alpha', () => {
        expect(themeSrgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
        expect(themeLinearToSrgb(themeSrgbToLinear(0.5))).toBeCloseTo(0.5, 12);
        expect(themeRelativeLuminance([1, 0, 0])).toBeCloseTo(0.2126, 12);
        expect(themeContrastRatio([0, 0, 0], [1, 1, 1])).toBe(21);
        const painted = compositeThemeColor(parseThemeColorValue('#00000033')!, [1, 1, 1]);
        expect(painted).toEqual([0.8, 0.8, 0.8]);
        expect(themeContrastRatio(painted, [1, 1, 1])).toBeCloseTo(1.6059, 4);
    });
});
