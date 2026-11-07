import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inspectGitWorkspaceLocation } from './workspaceIntegration.js';
import { runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';

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
    it('proves the main checkout of a linked worktree without joining an independent local clone', async () => {
        const root = await makeTempDir('git-workspace-family-');
        const main = join(root, 'z-main');
        const linked = join(root, 'a-linked');
        const clone = join(root, 'clone');
        try {
            await runGit(root, ['init', main]);
            await configureGitRepo(main);
            await runGit(main, ['commit', '--allow-empty', '-m', 'initial']);
            await runGit(main, ['worktree', 'add', '-b', 'feature', linked]);
            await runGit(root, ['clone', main, clone]);
            const mainPath = await runGit(main, ['rev-parse', '--show-toplevel']);
            const inspect = (cwd: string) => runWithRealGitScmRuntime(() => inspectGitWorkspaceLocation({ context: {
                cwd, projectKey: 'family', detection: { isRepo: true, rootPath: cwd, mode: '.git' },
            } }));
            expect((await inspect(linked))?.checkoutDiscovery).toEqual([expect.objectContaining({
                path: await runGit(linked, ['rev-parse', '--show-toplevel']), parentRootPath: mainPath,
            })]);
            expect((await inspect(main))?.checkoutDiscovery?.[0]).not.toHaveProperty('parentRootPath');
            expect((await inspect(clone))?.checkoutDiscovery?.[0]).not.toHaveProperty('parentRootPath');
            const bare = join(root, 'bare.git');
            const bareLinked = join(root, 'bare-linked');
            await runGit(root, ['clone', '--bare', main, bare]);
            await runGit(bare, ['worktree', 'add', '-b', 'bare-feature', bareLinked]);
            expect((await inspect(bareLinked))?.checkoutDiscovery?.[0]).toHaveProperty('parentRootPath',
                await runGit(bare, ['rev-parse', '--absolute-git-dir']));
            const separate = join(root, 'separate');
            const admin = join(root, 'administration');
            const separateLinked = join(root, 'separate-linked');
            await runGit(root, ['init', '--separate-git-dir', admin, separate]);
            await configureGitRepo(separate);
            await runGit(separate, ['commit', '--allow-empty', '-m', 'initial']);
            await runGit(separate, ['worktree', 'add', '-b', 'separate-feature', separateLinked]);
            expect((await inspect(separateLinked))?.checkoutDiscovery?.[0]).not.toHaveProperty('parentRootPath');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
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
            const repositoryIdentityPath = await realpath(join(repoRoot, '.git'));

            await expect(runWithRealGitScmRuntime(() => inspectGitWorkspaceLocation({
                context: {
                    cwd: worktreeRoot,
                    projectKey: `test:${worktreeRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: worktreeRoot,
                        mode: '.git',
                    },
                },
            }))).resolves.toEqual({
                rootPath: worktreeRoot,
                scmProvider: 'git',
                committedRevision: await runGit(worktreeRoot, ['rev-parse', 'HEAD']),
                checkoutDiscovery: [{
                    kind: 'git_worktree',
                    path: resolvedWorktreePath,
                    repositoryIdentityPath,
                    parentRootPath: await runGit(repoRoot, ['rev-parse', '--show-toplevel']),
                }],
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
            const repositoryIdentityPath = await realpath(join(repoRoot, '.git'));

            await expect(runWithRealGitScmRuntime(() => inspectGitWorkspaceLocation({
                context: {
                    cwd: restoredWorktreeRoot,
                    projectKey: `test:${restoredWorktreeRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: restoredWorktreeRoot,
                        mode: '.git',
                    },
                },
            }))).resolves.toEqual({
                rootPath: restoredWorktreeRoot,
                scmProvider: 'git',
                committedRevision: await runGit(restoredWorktreeRoot, ['rev-parse', 'HEAD']),
                checkoutDiscovery: [{
                    kind: 'git_worktree',
                    path: registeredWorktreePath,
                    repositoryIdentityPath,
                    parentRootPath: await runGit(repoRoot, ['rev-parse', '--show-toplevel']),
                }],
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
            await rm(restoredWorktreeRoot, { recursive: true, force: true });
        }
    });
});
