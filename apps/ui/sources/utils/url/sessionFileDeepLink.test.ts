import { describe, expect, it } from 'vitest';

import { buildSessionFileDeepLink, parseSessionFileDeepLinkAnchor } from './sessionFileDeepLink';

describe('sessionFileDeepLink', () => {
    it('builds a stable fileLine anchor URL and parses it back', () => {
        const url = buildSessionFileDeepLink({
            sessionId: 's1',
            filePath: 'src/foo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12, lineHash: 'lh1:1234567890abcdef' },
        });

        expect(url).toBe('/session/s1/file?path=src%2Ffoo.ts&source=file&anchor=fileLine&startLine=12&lineHash=lh1%3A1234567890abcdef');

        const parsed = parseSessionFileDeepLinkAnchor({
            source: 'file',
            anchor: 'fileLine',
            startLine: '12',
            lineHash: 'lh1:1234567890abcdef',
        });
        expect(parsed).toEqual({ source: 'file', anchor: { kind: 'fileLine', startLine: 12, lineHash: 'lh1:1234567890abcdef' } });
    });

    it('builds a stable diffLine anchor URL and parses it back', () => {
        const url = buildSessionFileDeepLink({
            sessionId: 's1',
            filePath: 'src/foo.ts',
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 10, side: 'after', oldLine: 3, newLine: 4, lineHash: 'lh1:abcdef1234567890' },
        });

        expect(url).toBe('/session/s1/file?path=src%2Ffoo.ts&source=diff&anchor=diffLine&startLine=10&side=after&oldLine=3&newLine=4&lineHash=lh1%3Aabcdef1234567890');

        const parsed = parseSessionFileDeepLinkAnchor({
            source: 'diff',
            anchor: 'diffLine',
            startLine: '10',
            side: 'after',
            oldLine: '3',
            newLine: '4',
            lineHash: 'lh1:abcdef1234567890',
        });
        expect(parsed).toEqual({
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 10, side: 'after', oldLine: 3, newLine: 4, lineHash: 'lh1:abcdef1234567890' },
        });
    });
});
