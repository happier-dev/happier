import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inspectGitCheckoutIdentity } from '../checkoutIdentity';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
} from './materializeGitWorkspaceCheckout';

const execFile = promisify(execFileCallback);

async function makeTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function configureGitRepo(cwd: string): Promise<void> {
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

async function writeTrackedFile(cwd: string, relativePath: string, contents: string): Promise<void> {
    await writeFile(join(cwd, relativePath), contents, 'utf8');
    await runGit(cwd, ['add', relativePath]);
}

describe('materializeGitWorkspaceCheckout', () => {
    it('registers a linked worktree into a pre-populated target path without replacing imported files', async () => {
        const repoRoot = await makeTempDir('git-materialize-populated-repo-');
        const targetRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            await mkdir(targetRoot, { recursive: true });
            await writeFile(join(targetRoot, 'README.md'), 'imported\n', 'utf8');
            await writeFile(join(targetRoot, 'notes.txt'), 'transferred\n', 'utf8');

            const materializedCheckout = await materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: targetRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
            });

            expect(materializedCheckout).toEqual({
                targetPath: targetRoot,
            });
            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature-auth');
            await expect(runGit(targetRoot, ['rev-parse', '--git-common-dir'])).resolves.toBe(await realpath(join(repoRoot, '.git')));
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('imported\n');
            await expect(readFile(join(targetRoot, 'notes.txt'), 'utf8')).resolves.toBe('transferred\n');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('reuses a restored matching linked worktree at the default git-owned path instead of creating a suffixed checkout', async () => {
        const repoRoot = await makeTempDir('git-materialize-create-restored-repo-');
        const originalWorktreeRoot = await makeTempDir('git-materialize-create-restored-original-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature/auth']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature/auth']);

            const restoredRoot = join(repoRoot, '.dev', 'worktree', 'feature', 'auth');
            await mkdir(join(repoRoot, '.dev', 'worktree', 'feature'), { recursive: true });
            await cp(originalWorktreeRoot, restoredRoot, { recursive: true });

            const createdCheckout = await createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/auth',
                baseRef: 'main',
            });
            const restoredIdentity = await inspectGitCheckoutIdentity({ cwd: restoredRoot });

            expect(createdCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
            });
            expect(restoredIdentity).toEqual(expect.objectContaining({
                branchName: 'feature/auth',
                registeredWorktreePath: createdCheckout.targetPath,
            }));
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(
                `worktree ${join(repoRoot, '.dev', 'worktree', 'feature', 'auth-2')}`,
            );
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
        }
    });

    it('returns the rebound registered worktree path when explicit materialization repairs a restored checkout', async () => {
        const repoRoot = await makeTempDir('git-materialize-realize-restored-repo-');
        const originalWorktreeRoot = await makeTempDir('git-materialize-realize-restored-original-');
        const restoredRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-auth']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature-auth']);

            await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
            await cp(originalWorktreeRoot, restoredRoot, { recursive: true });

            const materializedCheckout = await materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: restoredRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
            });
            const restoredIdentity = await inspectGitCheckoutIdentity({ cwd: restoredRoot });

            expect(materializedCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
            });
            expect(restoredIdentity).toEqual(expect.objectContaining({
                branchName: 'feature-auth',
                registeredWorktreePath: materializedCheckout.targetPath,
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
        }
    });
});
