import { describe, expect, it } from 'vitest';
import { MOBILE_THEME_PREVIEWS, resolveNextThemePreviewIndex } from './themePreviews';

describe('mobile theme previews', () => {
    it('declares the eight iOS theme screenshots in display order', () => {
        expect(MOBILE_THEME_PREVIEWS.map((preview) => preview.imageId)).toEqual([
            'iosTheme1',
            'iosTheme2',
            'iosTheme3',
            'iosTheme4',
            'iosTheme5',
            'iosTheme6',
            'iosTheme7',
            'iosTheme8',
        ]);
        expect(MOBILE_THEME_PREVIEWS.map((preview) => preview.swatch)).toEqual([
            '#131111',
            '#181926',
            '#050506',
            '#21252B',
            '#0D1117',
            '#F5F5F5',
            '#EFF1F5',
            '#F8F8F2',
        ]);
        expect(MOBILE_THEME_PREVIEWS).toHaveLength(8);
        expect(new Set(MOBILE_THEME_PREVIEWS.map((preview) => preview.swatch)).size).toBe(8);
    });

    it('cycles to the next screenshot and wraps at the end', () => {
        expect(resolveNextThemePreviewIndex(0, MOBILE_THEME_PREVIEWS.length)).toBe(1);
        expect(resolveNextThemePreviewIndex(7, MOBILE_THEME_PREVIEWS.length)).toBe(0);
    });
});
