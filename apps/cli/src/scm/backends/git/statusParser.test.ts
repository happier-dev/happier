import { describe, expect, it } from 'vitest';

import { buildGitSnapshot } from './statusSnapshot';

type SnapshotEntry = Readonly<{
    path: string;
    previousPath?: string | null;
    kind?: string | null;
    hasPendingDelta?: boolean;
    hasIncludedDelta?: boolean;
    stats?: Readonly<{ pendingAdded?: number }> | null;
}>;

function isSnapshotEntry(value: unknown): value is SnapshotEntry {
    if (!value || typeof value !== 'object') return false;
    const anyValue = value as { path?: unknown };
    return typeof anyValue.path === 'string' && anyValue.path.length > 0;
}

function findEntryByPath(entries: unknown[], path: string): SnapshotEntry | undefined {
    return entries.find((value): value is SnapshotEntry => isSnapshotEntry(value) && value.path === path);
}

describe('git status snapshot parser', () => {
    it('parses porcelain-v2 -z status with rename, conflict, untracked, and numstat totals', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '# branch.upstream origin/main\0' +
            '# branch.ab +2 -1\0' +
            '# stash 3\0' +
            '1 MM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb src/app.ts\0' +
            '2 R. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd R100 src/new name.ts\0src/old name.ts\0' +
            'u UU N... 100644 100644 100644 100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ffffffffffffffffffffffffffffffffffffffff 0000000000000000000000000000000000000000 conflicted.ts\0' +
            '? untracked file.ts\0';

        const includedNumStatOutput =
            '2\t0\tsrc/app.ts\0' +
            '0\t0\t\0src/old name.ts\0src/new name.ts\0';

        const pendingNumStatOutput =
            '3\t1\tsrc/app.ts\0' +
            '-\t-\tbinary.asset\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            includedNumStatOutput,
            pendingNumStatOutput,
        });

        expect(snapshot.repo).toEqual({ isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] });
        expect(snapshot.branch).toMatchObject({
            head: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 1,
            detached: false,
        });
        expect(snapshot.stashCount).toBe(3);
        expect(snapshot.hasConflicts).toBe(true);

        const entries = snapshot.entries as unknown[];
        const renamed = findEntryByPath(entries, 'src/new name.ts');
        expect(renamed?.previousPath).toBe('src/old name.ts');
        expect(renamed?.kind).toBe('renamed');

        const untracked = findEntryByPath(entries, 'untracked file.ts');
        expect(untracked?.kind).toBe('untracked');
        expect(untracked?.hasPendingDelta).toBe(true);

        expect(snapshot.totals).toMatchObject({
            includedFiles: 3,
            pendingFiles: 4,
            untrackedFiles: 1,
            includedAdded: 2,
            includedRemoved: 0,
            pendingAdded: 3,
            pendingRemoved: 1,
        });
    });

    it('applies untracked file stats when provided (counts as pending additions)', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '? Dockerfile\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            includedNumStatOutput: '',
            pendingNumStatOutput: '',
            untrackedStatsByPath: {
                Dockerfile: { pendingAdded: 12, isBinary: false },
            },
        });

	    const entries = snapshot.entries as unknown[];
	    const untracked = findEntryByPath(entries, 'Dockerfile');
	    expect(untracked?.kind).toBe('untracked');
	    expect(untracked?.stats?.pendingAdded).toBe(12);
	    expect(snapshot.totals.pendingAdded).toBe(12);
	});

    it('parses newline-containing paths for ordinary and renamed entries', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb dir/line\nbreak.ts\0' +
            '2 R. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd R100 dir/new\nname.ts\0dir/old\nname.ts\0';

        const includedNumStatOutput = '0\t0\t\0dir/old\nname.ts\0dir/new\nname.ts\0';
        const pendingNumStatOutput = '1\t1\tdir/line\nbreak.ts\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            includedNumStatOutput,
            pendingNumStatOutput,
        });

        const entries = snapshot.entries as unknown[];
        const ordinary = findEntryByPath(entries, 'dir/line\nbreak.ts');
        expect(ordinary).toBeDefined();
        expect(ordinary?.hasPendingDelta).toBe(true);

        const renamed = findEntryByPath(entries, 'dir/new\nname.ts');
        expect(renamed).toBeDefined();
        expect(renamed?.previousPath).toBe('dir/old\nname.ts');
        expect(renamed?.kind).toBe('renamed');
        expect(renamed?.hasIncludedDelta).toBe(true);

        expect(snapshot.totals).toMatchObject({
            includedFiles: 1,
            pendingFiles: 1,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 1,
        });
    });

    it('marks detached branch variants as detached', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head (detached from 1111111)\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            includedNumStatOutput: '',
            pendingNumStatOutput: '',
        });

        expect(snapshot.branch.detached).toBe(true);
        expect(snapshot.branch.head).toBeNull();
    });

    it('includes discovered git worktrees and marks the current worktree even when the repo root is the primary checkout', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head feature/auth\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo/.worktrees/feature-auth',
            fetchedAt: 123,
            rootPath: '/repo/.worktrees/feature-auth',
            mainWorktreePath: '/repo',
            statusOutput,
            includedNumStatOutput: '',
            pendingNumStatOutput: '',
            worktreesOutput:
                'worktree /repo\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/main\n' +
                '\n' +
                'worktree /repo/.worktrees/feature-auth\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/feature/auth\n' +
                '\n' +
                'worktree /repo/.worktrees/bugfix\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/bugfix\n',
        });

        expect(snapshot.repo.worktrees).toEqual([
            { path: '/repo', branch: 'main', isCurrent: false, isMain: true },
            { path: '/repo/.worktrees/bugfix', branch: 'bugfix', isCurrent: false, isMain: false },
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: true, isMain: false },
        ]);
    });

    it('marks the linked worktree as current when the snapshot root stays at the shared git toplevel', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head feature/auth\0';

        const snapshot = buildGitSnapshot({
            projectKey: 'machine-1:/repo/.worktrees/feature-auth',
            fetchedAt: 123,
            rootPath: '/repo',
            currentWorktreePath: '/repo/.worktrees/feature-auth',
            statusOutput,
            includedNumStatOutput: '',
            pendingNumStatOutput: '',
            worktreesOutput:
                'worktree /repo\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/main\n' +
                '\n' +
                'worktree /repo/.worktrees/feature-auth\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/feature/auth\n' +
                '\n' +
                'worktree /repo/.worktrees/bugfix\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/bugfix\n',
        });

        expect(snapshot.repo.rootPath).toBe('/repo');
        expect(snapshot.repo.worktrees).toEqual([
            { path: '/repo', branch: 'main', isCurrent: false, isMain: true },
            { path: '/repo/.worktrees/bugfix', branch: 'bugfix', isCurrent: false, isMain: false },
            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: true, isMain: false },
        ]);
    });
});
