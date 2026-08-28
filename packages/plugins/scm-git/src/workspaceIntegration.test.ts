import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
    assertPortableGitWorkspaceEntries,
    classifyGitPortableWorkspacePath,
    createGitWorkspaceCheckout,
    materializeGitWorkspaceSourceCheckout,
    verifyGitPreparedReviewWorkspace,
    reconcileGitWorkspacePostMaterialization,
    realizeGitWorkspaceCheckout,
} from './workspaceIntegration.js';
import { inspectGitCheckoutIdentity } from './checkoutIdentity.js';
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

async function writeTrackedFile(cwd: string, relativePath: string, contents: string): Promise<void> {
    await writeFile(join(cwd, relativePath), contents, 'utf8');
    await runGit(cwd, ['add', relativePath]);
}

describe('git workspace integration', () => {
    it('reports the already-prepared checkout local HEAD without mutating it', async () => {
        const repoRoot = await makeTempDir('git-review-workspace-verify-');
        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeTrackedFile(repoRoot, 'README.md', 'initial\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            const localHead = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            const signal = new AbortController().signal;

            await expect(runWithRealGitScmRuntime(() => verifyGitPreparedReviewWorkspace({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' },
                },
                request: {
                    cwd: repoRoot,
                    displayName: 'feature',
                    sourceTip: {
                        repository: {
                            kind: 'github',
                            deployment: 'https://github.com',
                            repository: 'acme/repository',
                        },
                        cloneUrl: 'https://github.com/acme/repository.git',
                        branch: 'feature',
                        sourceHeadSha: 'ffffffffffffffffffffffffffffffffffffffff',
                        fetchRef: 'refs/heads/feature',
                    },
                    verification: { targetPath: repoRoot },
                },
                signal,
            }))).resolves.toEqual({
                success: true,
                verification: { targetPath: repoRoot, sourceHeadSha: localHead },
            });
            await expect(runGit(repoRoot, ['rev-parse', 'HEAD'])).resolves.toBe(localHead);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves cancellation before reading a prepared review workspace', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(verifyGitPreparedReviewWorkspace({
            context: {
                cwd: '/selected/repository',
                projectKey: 'test:selected',
                detection: { isRepo: true, rootPath: '/selected/repository', mode: '.git' },
            },
            request: {
                cwd: '/selected/repository',
                displayName: 'feature',
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://github.com',
                        repository: 'acme/repository',
                    },
                    cloneUrl: 'https://github.com/acme/repository.git',
                    branch: 'feature',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature',
                },
                verification: { targetPath: '/selected/repository/.happier/worktrees/feature' },
            },
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('classifies linked-worktree admin paths as non-portable while keeping regular git metadata portable', () => {
        expect(classifyGitPortableWorkspacePath({ relativePath: '.git/HEAD' })).toBe('portable');
        expect(classifyGitPortableWorkspacePath({ relativePath: '.git/worktrees/feature-auth/HEAD' })).toBe('non_portable');
        expect(classifyGitPortableWorkspacePath({ relativePath: 'README.md' })).toBe('unknown');
    });

    it('rejects non-portable linked-worktree admin entries during portable import validation', async () => {
        await expect(assertPortableGitWorkspaceEntries({
            entries: [{ relativePath: '.git/worktrees/feature-auth/HEAD' }],
        })).rejects.toThrow('non-portable git worktree admin state');
    });

    it('uses the shared checkout materialization request as the source-of-truth for reconcile inputs', async () => {
        const sourceRoot = await makeTempDir('git-workspace-integration-source-');
        const targetRoot = await makeTempDir('git-workspace-integration-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await runGit(sourceRoot, ['checkout', '-b', 'feature']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature']);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);
            await runGit(targetRoot, ['checkout', 'main']);

            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);

            await runWithRealGitScmRuntime(() => reconcileGitWorkspacePostMaterialization({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                checkoutMaterialization: {
                    targetPath: targetRoot,
                    sourcePath: sourceRoot,
                },
                sourcePath: '/stale/source-path',
            }));

            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHead);
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('materializes a linked worktree through the plugin checkout materialization leaf', async () => {
        const sourceRoot = await makeTempDir('git-workspace-integration-materialize-source-');
        const targetRoot = join(sourceRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await mkdir(join(sourceRoot, 'packages/app'), { recursive: true });
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await writeTrackedFile(sourceRoot, 'packages/app/index.ts', 'export const app = true;\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await mkdir(join(sourceRoot, '.worktrees'), { recursive: true });

            const materialized = await runWithRealGitScmRuntime(() => materializeGitWorkspaceSourceCheckout({
                context: {
                    cwd: sourceRoot,
                    projectKey: `test:${sourceRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: sourceRoot,
                        mode: '.git',
                    },
                },
                workspaceCheckoutMaterialization: {
                    kind: 'git_worktree',
                    sourcePath: join(sourceRoot, 'packages/app'),
                    targetPath: targetRoot,
                    displayName: 'feature/auth',
                    baseRef: 'main',
                    branchMode: 'new',
                },
            }));

            expect(materialized).toEqual({
                targetPath: await realpath(targetRoot),
                branchName: 'feature/auth',
                created: true,
            });

            await expect(runGit(targetRoot, ['rev-parse', '--show-toplevel'])).resolves.toBe(await realpath(targetRoot));
            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature/auth');
            await expect(runGit(targetRoot, ['rev-parse', '--git-common-dir'])).resolves.toBe(await realpath(join(sourceRoot, '.git')));
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
        }
    });

    it('returns the rebound linked worktree path through the shared realization seam when materialization repairs a restored checkout', async () => {
        const repoRoot = await makeTempDir('git-workspace-integration-realize-repo-');
        const originalWorktreeRoot = await makeTempDir('git-workspace-integration-realize-original-');
        const restoredRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await mkdir(join(repoRoot, 'packages/app'), { recursive: true });
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await writeTrackedFile(repoRoot, 'packages/app/index.ts', 'export const app = true;\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-auth']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature-auth']);

            await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
            await cp(originalWorktreeRoot, restoredRoot, { recursive: true });

            const realizedCheckout = await runWithRealGitScmRuntime(() => realizeGitWorkspaceCheckout({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceCheckoutRealization: {
                    kind: 'git_worktree',
                    sourcePath: join(repoRoot, 'packages/app'),
                    targetPath: restoredRoot,
                    displayName: 'feature-auth',
                    baseRef: 'main',
                    branchMode: 'existing',
                },
            }));
            const restoredIdentity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: restoredRoot }));

            expect(realizedCheckout).toEqual({
                kind: 'git_worktree',
                targetPath: restoredIdentity?.registeredWorktreePath,
                branchName: 'feature-auth',
                created: false,
            });
            expect(restoredIdentity).toEqual(expect.objectContaining({
                branchName: 'feature-auth',
                registeredWorktreePath: realizedCheckout?.targetPath,
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
        }
    });

    it('creates a linked worktree at the git-owned default path through the shared checkout seam', async () => {
        const sourceRoot = await makeTempDir('git-workspace-integration-create-source-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await mkdir(join(sourceRoot, 'packages/app'), { recursive: true });
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await writeTrackedFile(sourceRoot, 'packages/app/index.ts', 'export const app = true;\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);

            const createdRoot = join(sourceRoot, '.dev', 'worktree', 'feature', 'auth');

            const createdCheckout = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckout({
                context: {
                    cwd: sourceRoot,
                    projectKey: `test:${sourceRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: sourceRoot,
                        mode: '.git',
                    },
                },
                workspaceCheckoutCreation: {
                    kind: 'git_worktree',
                    sourcePath: join(sourceRoot, 'packages/app'),
                    displayName: 'feature/auth',
                    baseRef: 'main',
                    branchMode: 'new',
                },
            }));

            expect(createdCheckout).toEqual({
                kind: 'git_worktree',
                targetPath: await realpath(createdRoot),
                branchName: 'feature/auth',
                created: true,
            });

            await expect(runGit(createdRoot, ['rev-parse', '--show-toplevel'])).resolves.toBe(await realpath(createdRoot));
            await expect(runGit(createdRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature/auth');
            await expect(runGit(createdRoot, ['rev-parse', '--git-common-dir'])).resolves.toBe(await realpath(join(sourceRoot, '.git')));
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
        }
    });

    it('reuses an existing branch worktree at a non-default path without creating a suffixed checkout', async () => {
        const repoRoot = await makeTempDir('git-workspace-integration-reuse-repo-');
        const existingWorktreeRoot = await makeTempDir('git-workspace-integration-reuse-existing-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await mkdir(join(repoRoot, 'packages/app'), { recursive: true });
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await writeTrackedFile(repoRoot, 'packages/app/index.ts', 'export const app = true;\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature/auth']);
            await runGit(repoRoot, ['worktree', 'add', existingWorktreeRoot, 'feature/auth']);

            const reusedCheckout = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckout({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceCheckoutCreation: {
                    kind: 'git_worktree',
                    sourcePath: join(repoRoot, 'packages/app'),
                    displayName: 'feature/auth',
                    baseRef: 'main',
                    branchMode: 'existing',
                },
            }));

            expect(reusedCheckout).toEqual({
                kind: 'git_worktree',
                targetPath: await realpath(existingWorktreeRoot),
                branchName: 'feature/auth',
                created: false,
            });
        } finally {
            await rm(existingWorktreeRoot, { recursive: true, force: true });
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

});
