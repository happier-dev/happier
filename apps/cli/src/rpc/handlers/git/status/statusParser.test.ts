import { describe, expect, it } from 'vitest';

import { buildSnapshot, createEmptySnapshot } from '../status';

describe('git status snapshot parser', () => {
    it('builds an empty snapshot for non-git directories', () => {
        const snapshot = createEmptySnapshot('machine-1:/repo', 123);
        expect(snapshot).toMatchObject({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            repo: { isGitRepo: false, rootPath: null },
            hasConflicts: false,
            entries: [],
        });
        expect(snapshot.totals).toMatchObject({
            stagedFiles: 0,
            unstagedFiles: 0,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
        });
    });

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

        const stagedNumStatOutput =
            '2\t0\tsrc/app.ts\0' +
            '0\t0\t\0src/old name.ts\0src/new name.ts\0';

        const unstagedNumStatOutput =
            '3\t1\tsrc/app.ts\0' +
            '-\t-\tbinary.asset\0';

        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            stagedNumStatOutput,
            unstagedNumStatOutput,
        });

        expect(snapshot.repo).toEqual({ isGitRepo: true, rootPath: '/repo' });
        expect(snapshot.branch).toMatchObject({
            head: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 1,
            detached: false,
        });
        expect(snapshot.stashCount).toBe(3);
        expect(snapshot.hasConflicts).toBe(true);

        const renamed = snapshot.entries.find((entry) => entry.path === 'src/new name.ts');
        expect(renamed?.previousPath).toBe('src/old name.ts');
        expect(renamed?.kind).toBe('renamed');

        const untracked = snapshot.entries.find((entry) => entry.path === 'untracked file.ts');
        expect(untracked?.kind).toBe('untracked');
        expect(untracked?.hasUnstagedDelta).toBe(true);

        expect(snapshot.totals).toMatchObject({
            stagedFiles: 3,
            unstagedFiles: 4,
            untrackedFiles: 1,
            stagedAdded: 2,
            stagedRemoved: 0,
            unstagedAdded: 3,
            unstagedRemoved: 1,
        });
    });

    it('parses newline-containing paths for ordinary and renamed entries', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb dir/line\nbreak.ts\0' +
            '2 R. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd R100 dir/new\nname.ts\0dir/old\nname.ts\0';

        const stagedNumStatOutput = '0\t0\t\0dir/old\nname.ts\0dir/new\nname.ts\0';
        const unstagedNumStatOutput = '1\t1\tdir/line\nbreak.ts\0';

        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            stagedNumStatOutput,
            unstagedNumStatOutput,
        });

        const ordinary = snapshot.entries.find((entry) => entry.path === 'dir/line\nbreak.ts');
        expect(ordinary).toBeDefined();
        expect(ordinary?.hasUnstagedDelta).toBe(true);

        const renamed = snapshot.entries.find((entry) => entry.path === 'dir/new\nname.ts');
        expect(renamed).toBeDefined();
        expect(renamed?.previousPath).toBe('dir/old\nname.ts');
        expect(renamed?.kind).toBe('renamed');
        expect(renamed?.hasStagedDelta).toBe(true);

        expect(snapshot.totals).toMatchObject({
            stagedFiles: 1,
            unstagedFiles: 1,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 1,
            unstagedRemoved: 1,
        });
    });

    it('marks detached branch variants as detached', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head (detached from 1111111)\0';

        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            stagedNumStatOutput: '',
            unstagedNumStatOutput: '',
        });

        expect(snapshot.branch.detached).toBe(true);
        expect(snapshot.branch.head).toBeNull();
    });

    it('parses tab-containing paths for status and numstat outputs', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb dir/tab\tname.ts\0' +
            '? dir/new\tfile.ts\0';

        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            stagedNumStatOutput: '',
            unstagedNumStatOutput: '1\t1\tdir/tab\tname.ts\0',
        });

        const modified = snapshot.entries.find((entry) => entry.path === 'dir/tab\tname.ts');
        expect(modified).toBeDefined();
        expect(modified?.hasUnstagedDelta).toBe(true);
        expect(modified?.stats.unstagedAdded).toBe(1);
        expect(modified?.stats.unstagedRemoved).toBe(1);

        const untracked = snapshot.entries.find((entry) => entry.path === 'dir/new\tfile.ts');
        expect(untracked).toBeDefined();
        expect(untracked?.kind).toBe('untracked');
    });

    it('parses unicode paths from porcelain and numstat outputs', () => {
        const statusOutput =
            '# branch.oid 1111111111111111111111111111111111111111\0' +
            '# branch.head main\0' +
            '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb dir/unicodé.ts\0';

        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput,
            stagedNumStatOutput: '',
            unstagedNumStatOutput: '2\t1\tdir/unicodé.ts\0',
        });

        const entry = snapshot.entries.find((value) => value.path === 'dir/unicodé.ts');
        expect(entry).toBeDefined();
        expect(entry?.hasUnstagedDelta).toBe(true);
        expect(entry?.stats.unstagedAdded).toBe(2);
        expect(entry?.stats.unstagedRemoved).toBe(1);
    });

    it('marks both staged and unstaged deltas for numstat-only entries present in both maps', () => {
        const snapshot = buildSnapshot({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            rootPath: '/repo',
            statusOutput:
                '# branch.oid 1111111111111111111111111111111111111111\0' +
                '# branch.head main\0',
            stagedNumStatOutput: '2\t1\tsrc/shared.ts\0',
            unstagedNumStatOutput: '4\t3\tsrc/shared.ts\0',
        });

        const entry = snapshot.entries.find((value) => value.path === 'src/shared.ts');
        expect(entry).toBeDefined();
        expect(entry?.hasStagedDelta).toBe(true);
        expect(entry?.hasUnstagedDelta).toBe(true);
        expect(entry?.indexStatus).toBe('M');
        expect(entry?.worktreeStatus).toBe('M');
        expect(entry?.stats.stagedAdded).toBe(2);
        expect(entry?.stats.stagedRemoved).toBe(1);
        expect(entry?.stats.unstagedAdded).toBe(4);
        expect(entry?.stats.unstagedRemoved).toBe(3);
    });
});
