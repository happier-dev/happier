import { describe, expect, it } from 'vitest';
import { createFileViewerFindModel, type FileViewerFindContent } from './useFileViewerFind';

const options = { matchCase: false, regex: false };

describe('file viewer Find', () => {
    it('keeps closed surfaces inert and seeds the addressed CRLF/UTF-16 line before stepping', () => {
        let reads = 0;
        const content: FileViewerFindContent = { path: 'a.ts', mode: 'file', text: 'needle\r\n😀 needle needle\r\n' };
        const model = createFileViewerFindModel(() => { reads++; return content; });
        model.refresh();
        expect(reads).toBe(0);
        expect(model.applySeed({ query: 'needle', options, target: { kind: 'file', path: 'a.ts', anchor: { kind: 'fileLine', startLine: 2 } } })).toBe(true);
        expect(model.status).toMatchObject({ current: 2, total: 3, coverage: 'complete' });
        expect(model.getSnapshot().lineTarget).toBe('f:2');
        expect(model.getSnapshot().lineRanges.get('f:2')).toEqual([
            { start: 3, end: 9, current: true }, { start: 10, end: 16, current: false },
        ]);
        model.step(1);
        expect(model.status).toMatchObject({ current: 3, total: 3 });
        model.close();
        expect(model.getSnapshot().lineRanges.size).toBe(0);
    });

    it('matches Markdown display text and maps the ranges to source syntax without searching hidden link destinations', () => {
        const model = createFileViewerFindModel(() => ({ path: 'a.md', mode: 'markdown', text: '**needle** and [needle](https://hidden.test)' }));
        model.open();
        model.setQuery('needle');
        expect(model.status).toMatchObject({ current: 1, total: 2 });
        expect(model.getSnapshot().markdownRanges).toEqual([
            { start: 2, end: 8, current: true }, { start: 16, end: 22, current: false },
        ]);
        model.setQuery('hidden.test');
        expect(model.status).toMatchObject({ total: 0, coverage: 'complete' });
    });

    it('does not consume seeds for the wrong file or a non-text/loading destination', () => {
        let content: FileViewerFindContent = { path: 'a.ts', mode: 'file', text: null };
        const model = createFileViewerFindModel(() => content);
        const seed = { query: 'needle', options, target: { kind: 'file' as const, path: 'a.ts', anchor: { kind: 'fileLine' as const, startLine: 1 } } };
        expect(model.applySeed(seed)).toBe(false);
        content = { ...content, text: 'needle' };
        expect(model.applySeed({ ...seed, target: { ...seed.target, path: 'other.ts' } })).toBe(false);
        expect(model.applySeed(seed)).toBe(true);
        expect(model.status).toMatchObject({ current: 1, total: 1 });
    });

    it('reveals the addressed Markdown paragraph without searching its syntax', () => {
        const model = createFileViewerFindModel(() => ({ path: 'a.md', mode: 'markdown',
            text: '# Title\r\n\r\n**needle**\r\n\r\n[needle](https://hidden.test)' }));
        model.applySeed({ query: 'needle', options, target: { kind: 'file', path: 'a.md', anchor: { kind: 'fileLine', startLine: 5 } } });
        expect(model.getSnapshot().markdownLineTarget).toBe(5);
        expect(model.status).toMatchObject({ current: 2, total: 2 });
        model.step(-1);
        expect(model.getSnapshot().markdownLineTarget).toBe(3);
    });

    it('accepts the canonical line-anchor shape used by file reference targets', () => {
        const model = createFileViewerFindModel(() => ({ path: 'a.ts', mode: 'file', text: 'needle\nneedle' }));
        model.applySeed({ query: 'needle', options, target: { kind: 'file', path: 'a.ts', anchor: { kind: 'line', filePath: 'a.ts', line: 2 } } });
        expect(model.status).toMatchObject({ current: 2, total: 2 });
        expect(model.getSnapshot().lineTarget).toBe('f:2');
    });

    it('rejects invalid patterns and retains the current match when unchanged content refreshes', () => {
        const model = createFileViewerFindModel(() => ({ path: 'a.ts', mode: 'file', text: 'needle\nneedle' }));
        model.open(); model.setQuery('needle'); model.step(1); model.refresh();
        expect(model.status).toMatchObject({ current: 2, total: 2 });
        model.setOptions({ ...options, regex: true }); model.setQuery('[');
        expect(model.status.kind).toBe('invalidPattern');
        expect(model.getSnapshot().lineRanges.size).toBe(0);
    });
});
