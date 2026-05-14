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
            anchor: { kind: 'diffLine', startLine: 10, side: 'after', oldLine: 3, newLine: 4, lineHash: 'lh1:fedcba0987654321' },
        });

        expect(url).toBe('/session/s1/file?path=src%2Ffoo.ts&source=diff&anchor=diffLine&startLine=10&side=after&oldLine=3&newLine=4&lineHash=lh1%3Afedcba0987654321');

        const parsed = parseSessionFileDeepLinkAnchor({
            source: 'diff',
            anchor: 'diffLine',
            startLine: '10',
            side: 'after',
            oldLine: '3',
            newLine: '4',
            lineHash: 'lh1:fedcba0987654321',
        });
        expect(parsed).toEqual({
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 10, side: 'after', oldLine: 3, newLine: 4, lineHash: 'lh1:fedcba0987654321' },
        });
    });

    it('builds normalized line and range anchor URLs and parses them back', () => {
        const lineUrl = buildSessionFileDeepLink({
            sessionId: 's1',
            filePath: 'src/foo.ts',
            source: 'file',
            anchor: { kind: 'line', filePath: 'src/foo.ts', line: 12, lineHash: 'lh1:1234567890abcdef' },
        });
        expect(lineUrl).toBe('/session/s1/file?path=src%2Ffoo.ts&source=file&anchor=line&startLine=12&lineHash=lh1%3A1234567890abcdef');
        expect(parseSessionFileDeepLinkAnchor({
            path: 'src/foo.ts',
            source: 'file',
            anchor: 'line',
            startLine: '12',
            lineHash: 'lh1:1234567890abcdef',
        })).toEqual({
            source: 'file',
            anchor: { kind: 'line', filePath: 'src/foo.ts', line: 12, lineHash: 'lh1:1234567890abcdef' },
        });

        const rangeUrl = buildSessionFileDeepLink({
            sessionId: 's1',
            filePath: 'src/foo.ts',
            source: 'diff',
            anchor: { kind: 'range', filePath: 'src/foo.ts', startLine: 12, endLine: 14, side: 'after', startLineHash: 'lh1:1234567890abcdef', endLineHash: 'lh1:fedcba0987654321' },
        });
        expect(rangeUrl).toBe('/session/s1/file?path=src%2Ffoo.ts&source=diff&anchor=range&startLine=12&endLine=14&side=after&startLineHash=lh1%3A1234567890abcdef&endLineHash=lh1%3Afedcba0987654321');
        expect(parseSessionFileDeepLinkAnchor({
            path: 'src/foo.ts',
            source: 'diff',
            anchor: 'range',
            startLine: '12',
            endLine: '14',
            side: 'after',
            startLineHash: 'lh1:1234567890abcdef',
            endLineHash: 'lh1:fedcba0987654321',
        })).toEqual({
            source: 'diff',
            anchor: {
                kind: 'range',
                filePath: 'src/foo.ts',
                startLine: 12,
                endLine: 14,
                side: 'after',
                startLineHash: 'lh1:1234567890abcdef',
                endLineHash: 'lh1:fedcba0987654321',
            },
        });
    });
});
