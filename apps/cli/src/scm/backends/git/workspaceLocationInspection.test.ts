import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inspectGitWorkspaceLocation } from './sourceController';

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

describe('inspectGitWorkspaceLocation', () => {
    it('includes the actual linked worktree path in checkout discovery details', async () => {
        const repoRoot = await makeTempDir('git-workspace-location-repo-');
        const worktreeRoot = await makeTempDir('git-workspace-location-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature']);
            await runGit(repoRoot, ['worktree', 'add', worktreeRoot, 'feature']);

            const resolvedWorktreePath = await runGit(worktreeRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']);

            await expect(inspectGitWorkspaceLocation({
                context: {
                    cwd: worktreeRoot,
                    projectKey: `test:${worktreeRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: worktreeRoot,
                        mode: '.git',
                    },
                },
            })).resolves.toEqual({
                rootPath: worktreeRoot,
                scmProvider: 'git',
                checkoutDiscovery: [{ kind: 'git_worktree', path: resolvedWorktreePath }],
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    });

    it('prefers the registered linked worktree path when copied admin metadata still points at the original checkout', async () => {
        const repoRoot = await makeTempDir('git-workspace-location-copied-repo-');
        const originalWorktreeRoot = await makeTempDir('git-workspace-location-copied-original-');
        const restoredWorktreeRoot = await makeTempDir('git-workspace-location-copied-restored-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature']);

            const originalGitDir = await runGit(originalWorktreeRoot, ['rev-parse', '--path-format=absolute', '--git-dir']);
            await cp(originalWorktreeRoot, restoredWorktreeRoot, { recursive: true });
            await writeFile(
                join(restoredWorktreeRoot, '.git'),
                `gitdir: ${relative(restoredWorktreeRoot, originalGitDir)}\n`,
                'utf8',
            );
            const registeredWorktreePath = await realpath(originalWorktreeRoot);

            await expect(inspectGitWorkspaceLocation({
                context: {
                    cwd: restoredWorktreeRoot,
                    projectKey: `test:${restoredWorktreeRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: restoredWorktreeRoot,
                        mode: '.git',
                    },
                },
            })).resolves.toEqual({
                rootPath: restoredWorktreeRoot,
                scmProvider: 'git',
                checkoutDiscovery: [{ kind: 'git_worktree', path: registeredWorktreePath }],
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
            await rm(restoredWorktreeRoot, { recursive: true, force: true });
        }
    });
});
