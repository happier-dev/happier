import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { inspectGitCheckoutIdentity } from '../checkoutIdentity.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
    prepareGitReviewWorkspace,
} from './materializeGitWorkspaceCheckout.js';

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
    it('classifies a selected root without the provider-authorized source remote as a remote mismatch', async () => {
        const selectedRoot = await makeTempDir('git-review-workspace-remote-mismatch-');

        try {
            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'initial']);
            await runGit(selectedRoot, ['remote', 'add', 'origin', 'https://forge.example/target/repository.git']);

            await expect(runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://forge.example',
                        repository: 'contributor/repository',
                    },
                    cloneUrl: 'https://forge.example/contributor/repository.git',
                    branch: 'feature/auth',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature/auth',
                },
            }))).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND });
        } finally {
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('fetches the provider-authorized source tip into a linked worktree without switching the selected root', async () => {
        const remoteRoot = await makeTempDir('git-review-workspace-remote-');
        const authorRoot = await makeTempDir('git-review-workspace-author-');
        const selectedRoot = await makeTempDir('git-review-workspace-selected-');
        const sourceUrl = 'https://forge.example/contributor/repository.git';

        try {
            await runGit(remoteRoot, ['init', '--bare']);
            await runGit(authorRoot, ['init']);
            await configureGitRepo(authorRoot);
            await runGit(authorRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(authorRoot, 'README.md', 'main\n');
            await runGit(authorRoot, ['commit', '-m', 'initial']);
            await runGit(authorRoot, ['remote', 'add', 'origin', remoteRoot]);
            await runGit(authorRoot, ['push', 'origin', 'main']);
            await runGit(authorRoot, ['switch', '-c', 'feature/auth']);
            await writeTrackedFile(authorRoot, 'feature.txt', 'feature\n');
            await runGit(authorRoot, ['commit', '-m', 'feature']);
            const sourceHeadSha = await runGit(authorRoot, ['rev-parse', 'HEAD']);
            await runGit(authorRoot, ['push', 'origin', 'feature/auth']);

            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'selected-initial']);
            const selectedHeadBefore = await runGit(selectedRoot, ['rev-parse', 'HEAD']);
            await runGit(selectedRoot, ['remote', 'add', 'fork', sourceUrl]);
            await runGit(selectedRoot, ['config', `url.file://${remoteRoot}.insteadOf`, sourceUrl]);

            const prepared = await runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://forge.example',
                        repository: 'contributor/repository',
                    },
                    cloneUrl: sourceUrl,
                    branch: 'feature/auth',
                    sourceHeadSha,
                    fetchRef: 'refs/heads/feature/auth',
                },
            }));

            expect(prepared).toMatchObject({
                branchName: 'feature/auth',
                created: true,
                currentness: { kind: 'currentAtObservedHead' },
            });
            expect(await realpath(prepared.targetPath)).not.toBe(await realpath(selectedRoot));
            await expect(runGit(prepared.targetPath, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHeadSha);
            await expect(runGit(selectedRoot, ['rev-parse', 'HEAD'])).resolves.toBe(selectedHeadBefore);
            await expect(runGit(selectedRoot, ['branch', '--show-current'])).resolves.toBe('main');
        } finally {
            await rm(remoteRoot, { recursive: true, force: true });
            await rm(authorRoot, { recursive: true, force: true });
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('rejects forbidden worktree display names before materializing a checkout', async () => {
        const repoRoot = await makeTempDir('git-materialize-forbidden-name-repo-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            await expect(runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/@',
                baseRef: 'main',
                branchMode: 'new',
            }))).rejects.toThrow('Invalid Git worktree name');
            await expect(runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature.lock',
                baseRef: 'main',
                branchMode: 'new',
            }))).rejects.toThrow('Invalid Git worktree name');
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('.dev/worktree');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

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

            const materializedCheckout = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: targetRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            }));

            expect(materializedCheckout).toEqual({
                targetPath: targetRoot,
                branchName: 'feature-auth',
                reused: false,
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

            const createdCheckout = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            }));
            const restoredIdentity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: restoredRoot }));

            expect(createdCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
                branchName: 'feature/auth',
                reused: true,
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

    it('reuses the worktree that already holds an existing branch at a non-default path', async () => {
        const repoRoot = await makeTempDir('git-materialize-existing-branch-repo-');
        const existingWorktreeRoot = await makeTempDir('git-materialize-existing-branch-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature/auth']);
            await runGit(repoRoot, ['worktree', 'add', existingWorktreeRoot, 'feature/auth']);

            const materialized = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'existing',
            }));

            expect(await realpath(materialized.targetPath)).toBe(await realpath(existingWorktreeRoot));
            expect(materialized).toMatchObject({
                branchName: 'feature/auth',
                reused: true,
            });
            await expect(runGit(repoRoot, ['branch', '--list', 'feature/auth-2']))
                .resolves.toBe('');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(existingWorktreeRoot, { recursive: true, force: true });
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

            const materializedCheckout = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: restoredRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            }));
            const restoredIdentity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: restoredRoot }));

            expect(materializedCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
                branchName: 'feature-auth',
                reused: true,
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
