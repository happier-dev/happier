import { describe, expect, it } from 'vitest';

import {
    compositeThemeColorOver,
    parseThemeColor,
    themeContrastRatio,
    themeContrastRatioForFadedInk,
    themeContrastRatioOverLayers,
    withThemeColorOpacity,
} from '@/theme/themeContrastMath';

describe('themeContrastMath', () => {
    it('reads both hex forms and rgba, keeping alpha', () => {
        expect(parseThemeColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
        expect(parseThemeColor('#0059B3')).toEqual({ r: 0, g: 89, b: 179, a: 1 });
        expect(parseThemeColor('rgba(0, 122, 255, 0.10)')).toEqual({ r: 0, g: 122, b: 255, a: 0.1 });
    });

    it('refuses a value it cannot measure rather than guessing black', () => {
        expect(() => parseThemeColor('transparent')).toThrow(/Unsupported color value/);
    });

    it('produces the WCAG reference ratio for black on white', () => {
        const ratio = themeContrastRatio(parseThemeColor('#000000'), parseThemeColor('#ffffff'));
        expect(Number(ratio.toFixed(2))).toBe(21);
    });

    it('composites a translucent tint before measuring it', () => {
        const ink = parseThemeColor('#1A7030');
        const overWhite = themeContrastRatioOverLayers(ink, ['#ffffff', 'rgba(52, 199, 89, 0.12)']);
        const againstRawTint = themeContrastRatio(ink, parseThemeColor('rgba(52, 199, 89, 0.12)'));

        expect(Number(overWhite.toFixed(2))).toBe(5.6);
        // The uncomposited reading treats the 12% tint as a solid green and is materially wrong.
        expect(Number(againstRawTint.toFixed(2))).not.toBe(Number(overWhite.toFixed(2)));
    });

    it('measures faded ink against what it faded into, not against its own alpha', () => {
        const ink = parseThemeColor('#6c6c70');
        const surface = parseThemeColor('#ffffff');

        const faded = themeContrastRatioForFadedInk({ ink, opacity: 0.7, backdrop: surface });
        const naive = themeContrastRatio(withThemeColorOpacity(ink, 0.7), surface);

        // 0.7 opacity on white takes secondary text from 5.23:1 to 2.87:1 — a real AA failure.
        expect(Number(faded.toFixed(2))).toBe(2.87);
        // Relative luminance has no alpha term, so the naive form silently reports the UNDIMMED
        // figure. This is the mistake that makes the `opacity: pressed ? 0.7 : 1` idiom look fine.
        expect(Number(naive.toFixed(2))).toBe(5.23);
    });

    it('layers back to front', () => {
        const opaque = compositeThemeColorOver(
            parseThemeColor('rgba(0, 0, 0, 1)'),
            parseThemeColor('#ffffff'),
        );
        expect(opaque).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    });
});
