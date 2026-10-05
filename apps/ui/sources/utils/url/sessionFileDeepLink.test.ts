import { describe, expect, it } from 'vitest';

import { buildSessionFileDeepLink, parseSearchFileTarget, parseSessionFileDeepLinkAnchor } from './sessionFileDeepLink';

describe('sessionFileDeepLink', () => {
    it('accepts predecessor line URLs whose position is encoded as line rather than startLine', () => {
        expect(parseSessionFileDeepLinkAnchor({ path: 'src/a.ts', source: 'diff', anchor: 'line', line: '12', side: 'before' }))
            .toEqual({ source: 'diff', anchor: { kind: 'line', filePath: 'src/a.ts', line: 12, side: 'before' } });
    });
    it('preserves the predecessor selected-text hash in range URLs', () => {
        const anchor = { kind: 'range' as const, filePath: 'src/a.ts', startLine: 12, endLine: 14, selectedTextHash: 'lh1:1234567890abcdef' as const };
        const url = buildSessionFileDeepLink({ sessionId: 's1', filePath: 'src/a.ts', source: 'file', anchor });
        expect(parseSessionFileDeepLinkAnchor(Object.fromEntries(new URL(url, 'https://happier.test').searchParams))).toEqual({ source: 'file', anchor });
        const diffUrl = buildSessionFileDeepLink({ sessionId: 's1', filePath: 'src/a.ts', source: 'diff', anchor });
        expect(parseSearchFileTarget(diffUrl)).toMatchObject({ anchorSource: 'diff', anchor });
    });
    it('parses terminal line and column suffixes without splitting drives or literal filename colons', () => {
        expect(parseSearchFileTarget('C:\\x\\a.ts:12:4')).toEqual({ path: 'C:\\x\\a.ts', anchor: { kind: 'fileLine', startLine: 12 }, column: 4 });
        expect(parseSearchFileTarget('C:\\x\\a.ts:12')).toEqual({ path: 'C:\\x\\a.ts', anchor: { kind: 'fileLine', startLine: 12 } });
        expect(parseSearchFileTarget('a:b.ts')).toBeNull();
        expect(parseSearchFileTarget('a:b.ts:12')).toEqual({ path: 'a:b.ts', anchor: { kind: 'fileLine', startLine: 12 } });
        expect(parseSearchFileTarget('a.ts:0')).toBeNull();
        expect(parseSearchFileTarget('a.ts:12junk')).toBeNull();
    });

    it('parses a pasted deep link through the same anchor owner', () => {
        const url = buildSessionFileDeepLink({ sessionId: 's1', serverId: 'home-a', filePath: 'src/a:b.ts', source: 'file',
            anchor: { kind: 'range', filePath: 'src/a:b.ts', startLine: 12, endLine: 14 } });
        expect(parseSearchFileTarget(`https://happier.test${url}`)).toEqual({ path: 'src/a:b.ts', sessionId: 's1', serverId: 'home-a',
            anchor: { kind: 'range', filePath: 'src/a:b.ts', startLine: 12, endLine: 14 } });
        expect(parseSessionFileDeepLinkAnchor({ source: 'file', anchor: 'fileLine', startLine: '12junk' })).toBeNull();
    });
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
