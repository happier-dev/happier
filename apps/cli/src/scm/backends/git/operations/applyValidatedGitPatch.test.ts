import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { applyValidatedGitPatch } from './applyValidatedGitPatch';

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
    it('applies a validated patch to the index without leaving worktree drift', async () => {
        const repoRoot = await createCommittedRepo('a\n');

        try {
            await writeFile(join(repoRoot, 'a.txt'), 'A\n', 'utf8');
            const applyValidatedGitPatch = await loadApplyValidatedGitPatch();
            const patch = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+A', ''].join('\n');

            const result = await applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'index',
            });

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

            const result = await applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'worktree',
            });

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

            const result = await applyValidatedGitPatch({
                cwd: repoRoot,
                patch,
                target: 'worktree',
            });

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
