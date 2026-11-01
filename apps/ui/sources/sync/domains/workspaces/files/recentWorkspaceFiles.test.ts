import { describe, expect, it } from 'vitest';
import { parseRecentWorkspaceFiles, recordRecentWorkspaceFile, selectRecentWorkspaceFiles } from './recentWorkspaceFiles';
import { matchWorkspaceFileNames } from './workspaceFileSearchMatcher';
import { workspacePathToFileSearchItem } from './recentWorkspaceFiles';

describe('recentWorkspaceFiles', () => {
    it('reads tolerant persisted data and writes a unique bounded MRU list without touching another workspace', () => {
        const previous = parseRecentWorkspaceFiles({ a: ['src/a.ts', 7, 'src/a.ts', ''], b: ['b.ts'], ignored: true });
        expect(previous).toEqual({ a: ['src/a.ts'], b: ['b.ts'] });
        const full: Record<string, string[]> = { ...previous, a: Array.from({ length: 20 }, (_, i) => `${i}.ts`) };
        const next = recordRecentWorkspaceFile(full, 'a', '10.ts');
        expect(next.a).toEqual(['10.ts', ...full.a.filter(path => path !== '10.ts')]);
        expect(recordRecentWorkspaceFile(next, 'a', 'new.ts').a).toHaveLength(20);
        expect(recordRecentWorkspaceFile(next, 'a', 'new.ts').a).not.toContain('19.ts');
        expect(next.b).toBe(full.b);
        expect(recordRecentWorkspaceFile(next, 'a', '10.ts')).toBe(next);
    });

    it('filters missing files and matches only filenames while preserving recency', () => {
        const paths = ['settings/unrelated.ts', 'src/settings2.ts', 'src/settings1.ts', 'gone.ts'];
        const matches = new Set(matchWorkspaceFileNames(paths.map(workspacePathToFileSearchItem), 'settings').map(file => file.fullPath));
        expect(selectRecentWorkspaceFiles(paths, ['settings/unrelated.ts', 'src/settings1.ts', 'src/settings2.ts'], matches))
            .toEqual(['src/settings2.ts', 'src/settings1.ts']);
    });
    it('canonicalizes an older list when a new activation is recorded', () => {
        expect(recordRecentWorkspaceFile({ a: ['a.ts', 'b.ts', 'b.ts'] }, 'a', 'new.ts').a)
            .toEqual(['new.ts', 'a.ts', 'b.ts']);
    });

    it('uses the same subsequence membership for Recent names without matching their parent paths', () => {
        const paths = ['src/fileMatcher.ts', 'fileMatcher/unrelated.ts', 'src/fooMatzher.ts'];
        expect(matchWorkspaceFileNames(paths.map(workspacePathToFileSearchItem), 'fM').map(file => file.fullPath))
            .toEqual(['src/fileMatcher.ts', 'src/fooMatzher.ts']);
        expect(matchWorkspaceFileNames(paths.map(workspacePathToFileSearchItem), 'fileMatzher').map(file => file.fullPath))
            .toEqual([]);
    });
});
