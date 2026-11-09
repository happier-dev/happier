import { describe, expect, it } from 'vitest';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { computeScmDirectoryTreeBadge, computeScmFileTreeBadge, createScmTreeBadgeIndex } from './scmTreeBadges';

function snapshot(entries: any[]) {
    return {
        projectKey: 'p1',
        fetchedAt: 0,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: false,
            writeCommitLineSelection: false,
            writeBackout: false,
            writeRemoteFetch: false,
            writeRemotePull: false,
            writeRemotePush: false,
            worktreeCreate: false,
            changeSetModel: 'index',
            supportedDiffAreas: ['pending'],
        },
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    } as any;
}

describe('scmTreeBadges', () => {
    it('keeps media file and directory change badges without counting media lines', () => {
        const paths = ['media/a.pdf', 'media/b.png', 'media/c.mp4', 'media/d.mp3', 'media/e.dat', 'src/a.ts'];
        const s = snapshot(paths.map(path => ({
            path, previousPath: null, kind: 'modified', includeStatus: 'M', pendingStatus: 'M',
            hasIncludedDelta: true, hasPendingDelta: true,
            stats: { includedAdded: 2, includedRemoved: 1, pendingAdded: 3, pendingRemoved: 4, isBinary: path.endsWith('.dat') },
        })));
        const index = createScmTreeBadgeIndex(s);
        for (const path of paths.slice(0, -1)) expect(index.getFileBadge(path)).toEqual({ kindLetter: 'M', added: 0, removed: 0, changedCount: 1 });
        expect(index.getDirectoryBadge('media')).toEqual({ kindLetter: 'M', added: 0, removed: 0, changedCount: 5 });
        expect(index.getDirectoryBadge('')).toEqual({ kindLetter: 'M', added: 5, removed: 5, changedCount: 6 });
    });

    it('computes file badge using combined included+pending stats', () => {
        const s = snapshot([
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 2, includedRemoved: 1, pendingAdded: 3, pendingRemoved: 5, isBinary: false },
            },
        ]);

        expect(computeScmFileTreeBadge(s, 'src/a.ts')).toEqual({ kindLetter: 'M', added: 5, removed: 6, changedCount: 1 });
        expect(computeScmFileTreeBadge(s, 'src/missing.ts')).toBeNull();
    });

    it('returns a badge for changed entries even when line stats are zero', () => {
        const s = snapshot([
            {
                path: 'src/binary.png',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: true },
            },
            {
                path: 'src/new-file.txt',
                previousPath: null,
                kind: 'untracked',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false },
            },
        ]);

        expect(computeScmFileTreeBadge(s, 'src/binary.png')).toEqual({ kindLetter: 'M', added: 0, removed: 0, changedCount: 1 });
        expect(computeScmFileTreeBadge(s, 'src/new-file.txt')).toEqual({ kindLetter: 'A', added: 0, removed: 0, changedCount: 1 });
        expect(computeScmDirectoryTreeBadge(s, 'src')).toEqual({ kindLetter: 'M', added: 0, removed: 0, changedCount: 2 });
    });

    it('aggregates directory badges across nested entries', () => {
        const s = snapshot([
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false },
            },
            {
                path: 'src/nested/b.ts',
                previousPath: null,
                kind: 'added',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 4, pendingRemoved: 0, isBinary: false },
            },
        ]);

        expect(computeScmDirectoryTreeBadge(s, 'src')).toEqual({ kindLetter: 'M', added: 6, removed: 1, changedCount: 2 });
        expect(computeScmDirectoryTreeBadge(s, 'src/nested')).toEqual({ kindLetter: 'A', added: 4, removed: 0, changedCount: 1 });
        expect(computeScmDirectoryTreeBadge(s, 'does-not-exist')).toBeNull();
    });

    it('counts folder changes from the one changed-file list, so a folder total equals the header count', () => {
        const entry = (path: string, kind: string, pending = true, included = false) => ({
            path,
            previousPath: null,
            kind,
            includeStatus: '',
            pendingStatus: '',
            hasIncludedDelta: included,
            hasPendingDelta: pending,
            stats: { includedAdded: included ? 1 : 0, includedRemoved: 0, pendingAdded: pending ? 1 : 0, pendingRemoved: 0, isBinary: false },
        });
        const s = snapshot([
            entry('src/a.ts', 'modified', true, true),
            entry('src/new.ts', 'untracked'),
            // A directory the backend collapsed is not a file anyone can open or commit.
            entry('src/scratch/', 'untracked'),
            entry('README.md', 'modified'),
        ]);

        const index = createScmTreeBadgeIndex(s);
        expect(index.getDirectoryBadge('')?.changedCount).toBe(selectScmChangedFiles(s).length);
        expect(index.getDirectoryBadge('src')?.changedCount).toBe(2);
        expect(index.getFileBadge('src/scratch/')).toBeNull();
    });

    it('memoizes directory badge index per snapshot instance', () => {
        const s = snapshot([
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false },
            },
        ]);

        const first = createScmTreeBadgeIndex(s);
        const second = createScmTreeBadgeIndex(s);

        expect(second).toBe(first);
        expect(first.getFileBadge('src/a.ts')).toEqual({ kindLetter: 'M', added: 2, removed: 1, changedCount: 1 });
        expect(first.getDirectoryBadge('src')).toEqual({ kindLetter: 'M', added: 2, removed: 1, changedCount: 1 });
    });
});
