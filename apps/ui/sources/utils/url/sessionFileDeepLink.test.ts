import { describe, expect, it } from 'vitest';

import { buildSessionFileDeepLink, buildWorkspaceFileLink, readWorkspaceFileLinkView, parseSearchFileTarget, parseSessionFileDeepLinkAnchor } from './sessionFileDeepLink';

describe('sessionFileDeepLink', () => {
    it('retains a captured file base when a copied link is pasted into Search', () => {
        const href = buildWorkspaceFileLink({ target: { kind: 'session', sessionId: 'nested-session' }, path: 'nested/a.ts', rootPath: '/repo' });
        expect(parseSearchFileTarget(href)).toMatchObject({ path: 'nested/a.ts', rootPath: '/repo' });
    });
    it('keeps Session identity characters out of file-link query parsing', () => {
        const href = buildWorkspaceFileLink({ target: { kind: 'session', sessionId: 's?branch/one' }, path: 'src/a.ts' });
        expect(parseSearchFileTarget(href)).toMatchObject({ sessionId: 's?branch/one', path: 'src/a.ts' });
        expect(parseSearchFileTarget(buildSessionFileDeepLink({ sessionId: 's?branch/one', filePath: 'src/a.ts' })))
            .toMatchObject({ sessionId: 's?branch/one', path: 'src/a.ts' });
    });
    it('reads file-view launch intent without accepting unknown modes or changing anchor vocabulary', () => {
        expect(readWorkspaceFileLinkView({ fileView: 'changes', blame: '1', fileOpenAs: 'preview' }))
            .toEqual({ view: 'changes', blame: true, openAs: 'preview' });
        expect(readWorkspaceFileLinkView({ fileView: ['edit'], blame: '0', fileOpenAs: 'pinned' }))
            .toEqual({ view: 'edit', blame: false, openAs: 'pinned' });
        expect(readWorkspaceFileLinkView({ fileView: 'unknown', blame: 'unknown', fileOpenAs: 'unknown' })).toEqual({});
    });
    it('shares one file-link builder across Session and Project targets with anchor and view intent', () => {
        for (const target of [
            { kind: 'session' as const, sessionId: 's1', serverId: 'home-a' },
            { kind: 'project' as const, workspaceRefId: 'project-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/checkout' },
        ]) {
            const path = 'src/has space.ts';
            const anchor = { kind: 'range' as const, filePath: path, startLine: 9, endLine: 12 };
            const href = buildWorkspaceFileLink({ target, path, anchor, view: 'changes', blame: true,
                changesScope: { kind: 'turn', turnId: 'turn-a' } });
            const parsed = parseSearchFileTarget(href);
            expect(parsed).toMatchObject({ path, anchor, serverId: 'home-a' });
            expect(parsed).toMatchObject(target.kind === 'session' ? { sessionId: 's1' } : { workspaceRefId: 'project-a' });
            const url = new URL(href, 'https://happier.test');
            expect(url.searchParams.get('fileView')).toBe('changes');
            expect(url.searchParams.get('blame')).toBe('1');
            expect(url.searchParams.get('comparison')).toBe('turnCheckpoint');
            expect(url.searchParams.get('turnId')).toBe('turn-a');
            if (target.kind === 'project') expect(url.searchParams.get('activeRootPath')).toBe('/repo/checkout');
        }
    });
    it('reads file intent on canonical Project pages without admitting unpublished alias routes', () => {
        expect(parseSearchFileTarget('/projects/project-a/code?serverId=home-b&initialFile=src%2Fa.ts&source=file&anchor=fileLine&startLine=9'))
            .toEqual({ workspaceRefId: 'project-a', serverId: 'home-b', path: 'src/a.ts', anchor: { kind: 'fileLine', startLine: 9 } });
        expect(parseSearchFileTarget('/projects/project-a/details?initialFile=src%2Fa.ts')).toBeNull();
    });
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
        expect(parseSearchFileTarget('C:12')).toBeNull();
        expect(parseSearchFileTarget('src/a.ts::12')).toBeNull();
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
