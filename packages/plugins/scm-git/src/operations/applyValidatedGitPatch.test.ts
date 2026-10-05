import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it } from 'vitest';

import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { applyValidatedGitPatch } from './applyValidatedGitPatch.js';

type ApplyValidatedGitPatchFn = (input: {
    cwd: string;
    patch: string;
    target: 'index' | 'worktree';
    reverse?: boolean;
    env?: Record<string, string | undefined>;
}) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: string;
}>;

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function configureGitRepo(cwd: string): Promise<void> {
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Happier Test']);
    await runGit(cwd, ['config', 'core.autocrlf', 'false']);
}

async function createCommittedRepo(initialContents: string): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'git-apply-patch-'));
    await runGit(repoRoot, ['init']);
    await configureGitRepo(repoRoot);
    await writeFile(join(repoRoot, 'a.txt'), initialContents, 'utf8');
    await runGit(repoRoot, ['add', 'a.txt']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

async function loadApplyValidatedGitPatch(): Promise<ApplyValidatedGitPatchFn> {
    expect(typeof applyValidatedGitPatch).toBe('function');
    return applyValidatedGitPatch;
}

describe('applyValidatedGitPatch', () => {
    it('rejects relocation to another repeated occurrence in the index, even with full blob IDs', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nmiddle\nsame\ntail\n');
        try {
            await writeFile(join(repoRoot, 'a.txt'), 'head\nsame\nmiddle\nchosen\ntail\n');
            const patch = await runGit(repoRoot, ['diff', '--full-index', '--unified=0', '--', 'a.txt']) + '\n';
            const current = 'head\nsame\nmiddle\nchanged elsewhere\ntail\n';
            await writeFile(join(repoRoot, 'a.txt'), current);
            await runGit(repoRoot, ['add', 'a.txt']);
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index' }));
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
            expect(await readFile(join(repoRoot, 'a.txt'), 'utf8')).toBe(current);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe(current.trimEnd());
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('uses the original-side occurrence when the new-side coordinate would select another repeated line', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nmiddle\nsame\ntail\n');
        try {
            const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -4 +2 @@\n-same\n+chosen\n';
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index' }));
            expect(result.success).toBe(true);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe('head\nsame\nmiddle\nchosen\ntail');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('validates the new-side location for reverse patches', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nmiddle\nsame\ntail\n');
        try {
            await writeFile(join(repoRoot, 'a.txt'), 'head\nsame\nmiddle\nchosen\ntail\n');
            const patch = await runGit(repoRoot, ['diff', '--full-index', '--unified=0', '--', 'a.txt']) + '\n';
            const current = 'head\nchosen\nmiddle\nchanged elsewhere\ntail\n';
            await writeFile(join(repoRoot, 'a.txt'), current);
            await runGit(repoRoot, ['add', 'a.txt']);
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index', reverse: true }));
            expect(result.success).toBe(false);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe(current.trimEnd());
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it.each(['same', 'same\r\n'])('preserves exact newline semantics when applying and reversing %j', async (before) => {
        const repoRoot = await createCommittedRepo(before);
        const after = before.replace('same', 'chosen');
        try {
            await writeFile(join(repoRoot, 'a.txt'), after);
            const { stdout: patch } = await execFile('git', ['diff', '--full-index', '--', 'a.txt'], { cwd: repoRoot });
            const forward = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index' }));
            expect(forward.success, forward.error).toBe(true);
            const applied = await execFile('git', ['show', ':a.txt'], { cwd: repoRoot });
            expect(applied.stdout).toBe(after);
            const reverse = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index', reverse: true }));
            expect(reverse.success).toBe(true);
            const restored = await execFile('git', ['show', ':a.txt'], { cwd: repoRoot });
            expect(restored.stdout).toBe(before);
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('accounts for preceding selected insertions without relocating a later repeated occurrence', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nmiddle\nsame\ntail\n');
        try {
            const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,0 +2 @@\n+inserted\n@@ -4 +4 @@\n-same\n+chosen\n';
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index' }));
            expect(result.success).toBe(true);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe('head\ninserted\nsame\nmiddle\nchosen\ntail');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('applies additions and deletions and reverses their exact source ranges', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nmiddle\nsame\ntail\n');
        try {
            const after = 'head\nmiddle\nsame\ntail\n';
            await writeFile(join(repoRoot, 'a.txt'), after);
            await writeFile(join(repoRoot, 'new file.txt'), 'new file');
            await runGit(repoRoot, ['add', '-N', 'new file.txt']);
            const { stdout: patch } = await execFile('git', ['diff', '--full-index', '--unified=0'], { cwd: repoRoot });
            const forward = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'index' }));
            expect(forward.success, forward.error).toBe(true);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe(after.trimEnd());
            expect(await runGit(repoRoot, ['show', ':new file.txt'])).toBe('new file');
            const { stdout: appliedDiff } = await execFile('git', ['diff', '--cached', '--full-index', '--unified=0'], { cwd: repoRoot });
            const reverse = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch: appliedDiff, target: 'index', reverse: true }));
            expect(reverse.success).toBe(true);
            expect(await runGit(repoRoot, ['diff', '--cached'])).toBe('');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('applies a Git-quoted rename from a nested working directory', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\ntail\n');
        const oldPath = 'sub/old café name.txt';
        const newPath = 'sub/new café name.txt';
        try {
            await runGit(repoRoot, ['config', 'core.quotePath', 'true']);
            await mkdir(join(repoRoot, 'sub'));
            await runGit(repoRoot, ['mv', 'a.txt', oldPath]);
            await runGit(repoRoot, ['commit', '-m', 'quoted source']);
            await runGit(repoRoot, ['mv', oldPath, newPath]);
            await writeFile(join(repoRoot, newPath), 'head\nchosen\ntail\n');
            await runGit(repoRoot, ['add', newPath]);
            const { stdout: patch } = await execFile('git', ['diff', '--cached', '--full-index', '--unified=0'], { cwd: repoRoot });
            await runGit(repoRoot, ['read-tree', 'HEAD']);
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: join(repoRoot, 'sub'), patch, target: 'index' }));
            expect(result.success, result.error).toBe(true);
            expect(await runGit(repoRoot, ['show', `:${newPath}`])).toBe('head\nchosen\ntail');
            expect(await runGit(repoRoot, ['ls-files', '--', oldPath])).toBe('');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('applies successive adjacent selections against the current index', async () => {
        const repoRoot = await createCommittedRepo('head\nsame\nsame\ntail\n');
        const patch = (line: number, value: string) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -${line} +${line} @@\n-same\n+${value}\n`;
        try {
            for (const [line, value] of [[2, 'first'], [3, 'second']] as const) {
                const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch: patch(line, value), target: 'index' }));
                expect(result.success, result.error).toBe(true);
            }
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe('head\nfirst\nsecond\ntail');
            const reverse = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch: patch(2, 'first'), target: 'index', reverse: true }));
            expect(reverse.success, reverse.error).toBe(true);
            expect(await runGit(repoRoot, ['show', ':a.txt'])).toBe('head\nsame\nsecond\ntail');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('uses Git-cleaned worktree text for an LF patch on an autocrlf checkout', async () => {
        const repoRoot = await createCommittedRepo('same\n');
        try {
            await runGit(repoRoot, ['config', 'core.autocrlf', 'true']);
            await writeFile(join(repoRoot, 'a.txt'), 'same\r\n');
            const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-same\n+chosen\n';
            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({ cwd: repoRoot, patch, target: 'worktree' }));
            expect(result.success, result.error).toBe(true);
            expect(await readFile(join(repoRoot, 'a.txt'), 'utf8')).toBe('chosen\r\n');
            expect(await runGit(repoRoot, ['diff', '--cached'])).toBe('');
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('applies a validated patch to the index without leaving worktree drift', async () => {
        const repoRoot = await createCommittedRepo('a\n');

        try {
            await writeFile(join(repoRoot, 'a.txt'), 'A\n', 'utf8');
            const applyValidatedGitPatch = await loadApplyValidatedGitPatch();
            const patch = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+A', ''].join('\n');

            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'index',
            }));

            expect(result.success).toBe(true);
            await expect(runGit(repoRoot, ['diff', '--cached', '--', 'a.txt'])).resolves.toContain('+A');
            await expect(runGit(repoRoot, ['diff', '--', 'a.txt'])).resolves.toBe('');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('applies a validated patch to the worktree without modifying the index', async () => {
        const repoRoot = await createCommittedRepo('a\n');

        try {
            const applyValidatedGitPatch = await loadApplyValidatedGitPatch();
            const patch = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+A', ''].join('\n');

            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'worktree',
            }));

            expect(result.success).toBe(true);
            await expect(runGit(repoRoot, ['diff', '--cached', '--', 'a.txt'])).resolves.toBe('');
            await expect(runGit(repoRoot, ['diff', '--', 'a.txt'])).resolves.toContain('+A');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns CHANGE_APPLY_FAILED when a worktree patch no longer matches', async () => {
        const repoRoot = await createCommittedRepo('a\n');

        try {
            await writeFile(join(repoRoot, 'a.txt'), 'X\n', 'utf8');
            const applyValidatedGitPatch = await loadApplyValidatedGitPatch();
            const patch = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+A', ''].join('\n');

            const result = await runWithRealGitScmRuntime(() => applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'worktree',
            }));

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
