import { describe, expect, it } from 'vitest';
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
