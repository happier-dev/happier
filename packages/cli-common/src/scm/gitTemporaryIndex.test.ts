import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createGitTemporaryIndex, resolveGitIndexPath, type GitTemporaryIndexCommandAdapter } from './gitTemporaryIndex.js';

const cleanupBoundary = vi.hoisted(() => ({ fail: false }));
// Filesystem removal failure is an OS boundary; all Git/index mechanics stay real.
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return {
        ...fs,
        rmSync: (...args: Parameters<typeof fs.rmSync>) => {
            if (cleanupBoundary.fail) throw new Error('OS denied private-index cleanup');
            return fs.rmSync(...args);
        },
    };
});

const runGit: GitTemporaryIndexCommandAdapter = async (input) => {
    const result = spawnSync('git', [...input.args], {
        cwd: input.cwd, encoding: 'utf8', input: input.stdin, env: { ...process.env, ...input.env },
    });
    return { success: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 };
};

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    const result = await runGit({ cwd, args, env });
    if (!result.success) throw new Error(result.stderr);
    return result.stdout.trim();
}

async function withRepo(run: (cwd: string) => Promise<void>) {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-private-index-'));
    try {
        await git(cwd, ['init', '-q']);
        await git(cwd, ['config', 'user.email', 'test@example.com']);
        await git(cwd, ['config', 'user.name', 'Happier Test']);
        await run(cwd);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

describe('Git private index mechanics', () => {
    it('seeds empty and captured trees without changing the live index', async () => withRepo(async (cwd) => {
        writeFileSync(join(cwd, 'file.txt'), 'captured\n');
        await git(cwd, ['add', '.']);
        await git(cwd, ['commit', '-qm', 'captured']);
        const treeOid = await git(cwd, ['rev-parse', 'HEAD^{tree}']);
        writeFileSync(join(cwd, 'file.txt'), 'staged\n');
        await git(cwd, ['add', '.']);
        const before = readFileSync(join(cwd, '.git', 'index'));
        for (const seed of [{ kind: 'empty' }, { kind: 'tree', treeOid }] as const) {
            const result = await createGitTemporaryIndex({ cwd, runGit, seed });
            if (!result.success) throw new Error(result.error);
            const directory = dirname(result.tempIndex.indexPath);
            try {
                expect(await git(cwd, ['ls-files'], result.tempIndex.env)).toBe(seed.kind === 'empty' ? '' : 'file.txt');
                if (seed.kind === 'tree') expect(await git(cwd, ['write-tree'], result.tempIndex.env)).toBe(treeOid);
                expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(before);
            } finally {
                result.tempIndex.cleanup();
            }
            expect(existsSync(directory)).toBe(false);
            result.tempIndex.cleanup();
        }
    }));

    it.each([false, true])('snapshots current staged content and initializes an absent unborn index (split=%s)', async (split) => withRepo(async (cwd) => {
        const empty = await createGitTemporaryIndex({ cwd, runGit, seed: { kind: 'current-index' } });
        if (!empty.success) throw new Error(empty.error);
        try { expect(await git(cwd, ['ls-files'], empty.tempIndex.env)).toBe(''); }
        finally { empty.tempIndex.cleanup(); }
        writeFileSync(join(cwd, 'file.txt'), 'staged\n');
        await git(cwd, ['add', '.']);
        if (split) await git(cwd, ['update-index', '--split-index']);
        writeFileSync(join(cwd, 'file.txt'), 'unstaged\n');
        const result = await createGitTemporaryIndex({ cwd, runGit, seed: { kind: 'current-index' } });
        if (!result.success) throw new Error(result.error);
        try {
            if (split) {
                const sharedIndexPath = resolve(cwd, await git(cwd, ['rev-parse', '--shared-index-path']));
                const sharedIndex = readFileSync(sharedIndexPath);
                rmSync(sharedIndexPath);
                try {
                    expect(await git(cwd, ['show', ':file.txt'], result.tempIndex.env)).toBe('staged');
                } finally {
                    writeFileSync(sharedIndexPath, sharedIndex);
                }
            }
            expect(await git(cwd, ['show', ':file.txt'], result.tempIndex.env)).toBe('staged');
            writeFileSync(join(cwd, 'file.txt'), 'later\n');
            await git(cwd, ['add', '.']);
            expect(await git(cwd, ['show', ':file.txt'], result.tempIndex.env)).toBe('staged');
        } finally { result.tempIndex.cleanup(); }
    }));

    it('resolves and copies the linked worktree index rather than the main index', async () => withRepo(async (cwd) => {
        writeFileSync(join(cwd, 'file.txt'), 'base\n');
        await git(cwd, ['add', '.']);
        await git(cwd, ['commit', '-qm', 'base']);
        const linked = join(cwd, 'linked');
        await git(cwd, ['worktree', 'add', '-qb', 'linked', linked]);
        writeFileSync(join(linked, 'file.txt'), 'linked staged\n');
        await git(linked, ['add', '.']);
        const resolved = await resolveGitIndexPath({ cwd: linked, runGit });
        expect(resolved.success).toBe(true);
        if (!resolved.success) throw new Error(resolved.error);
        expect(resolved.indexPath).not.toBe(join(cwd, '.git', 'index'));
        const result = await createGitTemporaryIndex({ cwd: linked, runGit, seed: { kind: 'current-index' } });
        if (!result.success) throw new Error(result.error);
        try { expect(await git(linked, ['show', ':file.txt'], result.tempIndex.env)).toBe('linked staged'); }
        finally { result.tempIndex.cleanup(); }
    }));

    it('fails an invalid captured tree without falling back to empty and removes the private directory', async () => withRepo(async (cwd) => {
        let indexPath = '';
        const observeGit: GitTemporaryIndexCommandAdapter = async (input) => {
            indexPath = input.env?.GIT_INDEX_FILE ?? indexPath;
            return runGit(input);
        };
        const result = await createGitTemporaryIndex({ cwd, runGit: observeGit, seed: { kind: 'tree', treeOid: 'missing-tree' } });
        expect(result.success).toBe(false);
        expect(indexPath).not.toBe('');
        expect(existsSync(dirname(indexPath))).toBe(false);
        expect(existsSync(join(cwd, '.git', 'index'))).toBe(false);
    }));

    it('exposes cleanup failure and keeps disposal retryable', async () => withRepo(async (cwd) => {
        const result = await createGitTemporaryIndex({ cwd, runGit, seed: { kind: 'empty' } });
        if (!result.success) throw new Error(result.error);
        try {
            cleanupBoundary.fail = true;
            expect(() => result.tempIndex.cleanup()).toThrow('OS denied private-index cleanup');
            expect(existsSync(result.tempIndex.indexPath)).toBe(true);
        } finally {
            cleanupBoundary.fail = false;
            result.tempIndex.cleanup();
        }
        expect(existsSync(dirname(result.tempIndex.indexPath))).toBe(false);
    }));
});
