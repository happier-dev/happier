import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorktreeChangeFingerprint } from './readWorktreeChangeFingerprint';
import { runScmCommand } from './runtime';

describe('readWorktreeChangeFingerprint', () => {
    let root: string;
    let repo: string;

    async function git(args: string[], cwd = repo): Promise<void> {
        const result = await runScmCommand({ bin: 'git', cwd, args });
        if (!result.success) throw new Error(result.stderr);
    }

    async function fingerprint(cwd = repo): Promise<string> {
        const result = await readWorktreeChangeFingerprint(cwd);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected a Git fingerprint');
        return result.fingerprint;
    }

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-worktree-fingerprint-'));
        repo = join(root, 'repo with spaces');
        await mkdir(repo);
        await git(['init']);
        await writeFile(join(repo, 'tracked.txt'), 'original\n');
        await git(['add', '--', 'tracked.txt']);
        await git(['-c', 'user.name=Fingerprint Test', '-c', 'user.email=fingerprint@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial fixture']);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        // Only the exact per-test temporary fixture is removed; the shared checkout is untouched.
        await rm(root, { recursive: true, force: true });
    });

    it('is stable and covers the whole worktree from a nested cwd', async () => {
        await mkdir(join(repo, 'nested'));
        await writeFile(join(repo, 'tracked.txt'), 'changed\n');
        const value = await fingerprint();
        expect(await fingerprint()).toBe(value);
        expect(await fingerprint(join(repo, 'nested'))).toBe(value);
    });

    it('detects successive tracked edits with identical status and restores the original value', async () => {
        const original = await fingerprint();
        await writeFile(join(repo, 'tracked.txt'), 'changed1\n');
        const firstEdit = await fingerprint();
        expect(firstEdit).not.toBe(original);
        await writeFile(join(repo, 'tracked.txt'), 'changed2\n');
        expect(await fingerprint()).not.toBe(firstEdit);
        await writeFile(join(repo, 'tracked.txt'), 'original\n');
        expect(await fingerprint()).toBe(original);
    });

    it('detects untracked names and binary content, and restores the value on removal', async () => {
        const original = await fingerprint();
        const untracked = join(repo, 'untracked é space.bin');
        await writeFile(untracked, Buffer.from([0, 255, 1]));
        const added = await fingerprint();
        expect(added).not.toBe(original);
        await writeFile(untracked, Buffer.from([0, 254, 1]));
        expect(await fingerprint()).not.toBe(added);
        await unlink(untracked);
        expect(await fingerprint()).toBe(original);
    });

    it('distinguishes staging from the same unstaged content and detects subsequent staged edits', async () => {
        const original = await fingerprint();
        await writeFile(join(repo, 'tracked.txt'), 'changed1\n');
        const unstaged = await fingerprint();
        await git(['add', '--', 'tracked.txt']);
        const staged = await fingerprint();
        expect(staged).not.toBe(unstaged);
        await writeFile(join(repo, 'tracked.txt'), 'changed2\n');
        await git(['add', '--', 'tracked.txt']);
        expect(await fingerprint()).not.toBe(staged);
        await writeFile(join(repo, 'tracked.txt'), 'original\n');
        await git(['add', '--', 'tracked.txt']);
        expect(await fingerprint()).toBe(original);
    });

    it('detects a deletion and restores the value when the file returns', async () => {
        const original = await fingerprint();
        await unlink(join(repo, 'tracked.txt'));
        expect(await fingerprint()).not.toBe(original);
        await writeFile(join(repo, 'tracked.txt'), 'original\n');
        expect(await fingerprint()).toBe(original);
    });

    it('returns unavailable outside Git and for an unusable cwd', async () => {
        expect(await readWorktreeChangeFingerprint(root)).toEqual({ kind: 'unavailable' });
        expect(await readWorktreeChangeFingerprint(join(root, 'missing'))).toEqual({ kind: 'unavailable' });
    });

    it('returns unavailable when Git cannot run', async () => {
        vi.stubEnv('PATH', '');
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
    });

    it('returns unavailable when the SCM command cannot return complete output', async () => {
        vi.stubEnv('HAPPIER_SCM_MAX_OUTPUT_BYTES', '1');
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
    });

    it.skipIf(process.platform === 'win32')('hashes symlink targets without following them', async () => {
        const original = await fingerprint();
        const link = join(repo, 'link');
        await symlink('missing-target-one', link);
        const first = await fingerprint();
        expect(first).not.toBe(original);
        await unlink(link);
        await symlink('missing-target-two', link);
        expect(await fingerprint()).not.toBe(first);
        await unlink(link);
        expect(await fingerprint()).toBe(original);
    });

    it('supports an unborn repository and excludes ignored files', async () => {
        repo = join(root, 'unborn');
        await mkdir(repo);
        await git(['init']);
        await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
        const original = await fingerprint();
        await writeFile(join(repo, 'ignored.txt'), 'ignored content\n');
        expect(await fingerprint()).toBe(original);
        await writeFile(join(repo, 'new.txt'), 'new content\n');
        const untracked = await fingerprint();
        expect(untracked).not.toBe(original);
        await git(['add', '--', 'new.txt']);
        expect(await fingerprint()).not.toBe(untracked);
    });

    it('does not claim a complete fingerprint for an untracked nested repository', async () => {
        await git(['init', 'nested-repository']);
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
    });

    it('returns unavailable for dirty submodule contents rather than hashing only the gitlink', async () => {
        const source = join(root, 'submodule source');
        await mkdir(source);
        await git(['init'], source);
        await writeFile(join(source, 'tracked.txt'), 'original\n');
        await git(['add', '--', 'tracked.txt'], source);
        await git(['-c', 'user.name=Fingerprint Test', '-c', 'user.email=fingerprint@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-m', 'Submodule fixture'], source);
        await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', source, 'submodule']);
        await git(['-c', 'user.name=Fingerprint Test', '-c', 'user.email=fingerprint@example.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-am', 'Add submodule fixture']);

        const original = await fingerprint();
        const untracked = join(repo, 'submodule', 'new.txt');
        await writeFile(untracked, 'first\n');
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
        await writeFile(untracked, 'second\n');
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
        await unlink(untracked);
        expect(await fingerprint()).toBe(original);
        const tracked = join(repo, 'submodule', 'tracked.txt');
        await writeFile(tracked, 'changed\n');
        expect(await readWorktreeChangeFingerprint(repo)).toEqual({ kind: 'unavailable' });
        await writeFile(tracked, 'original\n');
        expect(await fingerprint()).toBe(original);
    });

    it('reads pending entries through the admitted workspace source, never this Machine\'s disk at the same path', async () => {
        const { localWorkspaceSource } = await import('@/workspaces/source/localWorkspaceSource');
        const { runWithWorkspaceSource } = await import('@/workspaces/source/workspaceSource');
        await writeFile(join(repo, 'tracked.txt'), 'changed\n');
        await symlink('tracked.txt', join(repo, 'link'));
        const reached: string[] = [];
        // A target stand-in on this disk: kind/id differ, so every entry fact must come through it.
        const source = { ...localWorkspaceSource, kind: 'target' as const, id: 'target:fingerprint',
            lstat: async (path: string) => { reached.push(`lstat:${path}`); return await localWorkspaceSource.lstat(path); },
            readlink: async (path: string) => { reached.push(`readlink:${path}`); return await localWorkspaceSource.readlink(path); } };
        const placed = await runWithWorkspaceSource(source, () => readWorktreeChangeFingerprint(repo));
        expect(placed).toEqual({ kind: 'available', fingerprint: await fingerprint() });
        expect(reached).toEqual(expect.arrayContaining([`lstat:${join(repo, 'tracked.txt')}`,
            `lstat:${join(repo, 'link')}`, `readlink:${join(repo, 'link')}`]));
    });
});
