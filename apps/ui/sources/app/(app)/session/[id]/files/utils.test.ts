import { describe, expect, it } from 'vitest';

import type { GitFileStatus } from '@/sync/git/gitStatusFiles';
import { buildAllRepositoryChangedFiles, formatFileSubtitle, formatLineChanges, normalizeFilePath } from './utils';

function makeFile(path: string, input?: Partial<GitFileStatus>): GitFileStatus {
    return {
        fileName: path.split('/').at(-1) ?? path,
        filePath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        fullPath: path,
        status: 'modified',
        isIncluded: false,
        linesAdded: 0,
        linesRemoved: 0,
        ...input,
    };
}

describe('normalizeFilePath', () => {
    it('removes a trailing slash and keeps other paths unchanged', () => {
        expect(normalizeFilePath('src/app.ts')).toBe('src/app.ts');
        expect(normalizeFilePath('src/dir/')).toBe('src/dir');
        expect(normalizeFilePath('')).toBe('');
    });
});

describe('buildAllRepositoryChangedFiles', () => {
    it('merges staged and unstaged lists, deduplicates by path, and sorts', () => {
        const pending = [makeFile('b.ts'), makeFile('a.ts')];
        const included = [makeFile('a.ts', { isIncluded: true }), makeFile('c.ts', { isIncluded: true })];

        const result = buildAllRepositoryChangedFiles({ includedFiles: included, pendingFiles: pending });
        expect(result.map((file) => file.fullPath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
});

describe('formatLineChanges', () => {
    it('formats additions/removals and omits empty values', () => {
        expect(formatLineChanges(makeFile('src/a.ts', { linesAdded: 3, linesRemoved: 2 }))).toBe('+3 -2');
        expect(formatLineChanges(makeFile('src/a.ts', { linesAdded: 3, linesRemoved: 0 }))).toBe('+3');
        expect(formatLineChanges(makeFile('src/a.ts', { linesAdded: 0, linesRemoved: 2 }))).toBe('-2');
        expect(formatLineChanges(makeFile('src/a.ts', { linesAdded: 0, linesRemoved: 0 }))).toBe('');
    });
});

describe('formatFileSubtitle', () => {
    it('uses project root label when filePath is empty and appends line deltas when available', () => {
        expect(formatFileSubtitle(makeFile('root.ts', { filePath: '', linesAdded: 0, linesRemoved: 0 }), 'Project root'))
            .toBe('Project root');

        expect(formatFileSubtitle(makeFile('src/root.ts', { linesAdded: 1, linesRemoved: 2 }), 'Project root'))
            .toBe('src • +1 -2');
    });
});
