import { describe, expect, it } from 'vitest';

import { clearShikiCacheForKey, resolveHappierShikiThemeId, shikiTokenizeLines } from './shikiTokenize.web';

describe('shikiTokenizeLines with the real highlighter', () => {
    it('preserves text, custom syntax colors and unknown-language fallback through lazy initialization', async () => {
        const colors = {
            surface: { base: '#ffffff', inset: '#f6f8fa' },
            text: { primary: '#24292f', secondary: '#57606a' },
            syntax: { default: '#24292f', keyword: '#123456', number: '#0550ae', comment: '#6e7781' },
        };
        const themeId = resolveHappierShikiThemeId({ isDark: false, colors });
        try {
            const lines = ['const value = 1;', '', '// hello'];
            const result = await shikiTokenizeLines({ isDark: false, language: 'typescript', lines, colors });
            expect(result.tokensByLine.map(row => row.map(token => token.text).join(''))).toEqual(lines);
            expect(result.tokensByLine[0]?.find(token => token.text === 'const')?.color).toBe('#123456');
            expect(result.tokensByLine[0]?.find(token => token.text === '1')?.color.toLowerCase()).toBe('#0550ae');
            expect(result.tokensByLine[2]?.every(token => token.color.toLowerCase() === '#6e7781')).toBe(true);
            expect(result.fg.toLowerCase()).toBe('#24292f');

            const plain = await shikiTokenizeLines({ isDark: false, language: 'not-a-shiki-language', lines, colors });
            expect(plain.tokensByLine.map(row => row.map(token => token.text).join(''))).toEqual(lines);
            expect(plain.tokensByLine.flat().every(token => token.color === plain.fg)).toBe(true);
        } finally {
            clearShikiCacheForKey(themeId);
        }
    });
});
