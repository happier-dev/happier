import { execFile as execFileCallback } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inspectGitCheckoutIdentity } from '../checkoutIdentity';
import { reconcileGitWorkspaceCheckout } from './reconcileWorkspaceCheckout';

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
    const filePath = join(cwd, relativePath);
    await writeFile(filePath, contents, 'utf8');
    await runGit(cwd, ['add', relativePath]);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

describe('reconcileGitWorkspaceCheckout', () => {
    it('realigns the target branch ref to the source HEAD when both checkouts are already on the same branch', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-align-source-');
        const targetRoot = await makeTempDir('git-reconcile-align-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await runGit(sourceRoot, ['checkout', '-b', 'feature']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature v1\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v1']);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);

            await writeTrackedFile(sourceRoot, 'README.md', 'feature v2\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v2']);

            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
            const targetHeadBefore = await runGit(targetRoot, ['rev-parse', 'HEAD']);
            expect(targetHeadBefore).not.toBe(sourceHead);

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
            });

            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHead);
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('feature v2\n');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('switches the target checkout to the source branch when the branch already exists locally', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-source-');
        const targetRoot = await makeTempDir('git-reconcile-target-');

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
            await writeFile(join(targetRoot, 'README.md'), 'feature\n', 'utf8');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
            });

            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature');
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('feature\n');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('does nothing when the source checkout is detached', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-detached-source-');
        const targetRoot = await makeTempDir('git-reconcile-detached-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            const head = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
            await runGit(sourceRoot, ['checkout', head]);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
            });

            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('main');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('switches an unborn target checkout to the source unborn branch before the first commit exists', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-unborn-source-');
        const targetRoot = await makeTempDir('git-reconcile-unborn-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await runGit(sourceRoot, ['checkout', '-B', 'feature']);

            await runGit(targetRoot, ['init']);
            await runGit(targetRoot, ['branch', '-M', 'main']);
            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('main');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
            });

            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('feature');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('switches the restored target HEAD to exported git branch metadata without resetting imported files', async () => {
        const targetRoot = await makeTempDir('git-reconcile-metadata-target-');

        try {
            await runGit(targetRoot, ['init']);
            await configureGitRepo(targetRoot);
            await runGit(targetRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(targetRoot, 'README.md', 'main\n');
            await runGit(targetRoot, ['commit', '-m', 'initial']);
            await writeFile(join(targetRoot, 'README.md'), 'imported\n', 'utf8');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'branch',
                    branchName: 'feature',
                },
            });

            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('feature');
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('imported\n');
        } finally {
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('restores an unborn branch from exported git metadata without reusing a stale local branch ref', async () => {
        const targetRoot = await makeTempDir('git-reconcile-unborn-metadata-target-');

        try {
            await runGit(targetRoot, ['init']);
            await configureGitRepo(targetRoot);
            await runGit(targetRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(targetRoot, 'README.md', 'main\n');
            await runGit(targetRoot, ['commit', '-m', 'initial']);
            await runGit(targetRoot, ['branch', 'feature']);
            await writeFile(join(targetRoot, 'README.md'), 'imported\n', 'utf8');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'branch',
                    branchName: 'feature',
                },
            });

            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
            await expect(runGit(targetRoot, ['show-ref', '--verify', 'refs/heads/feature'])).rejects.toThrow();
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('imported\n');
        } finally {
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('realigns the restored target branch ref to exported git head metadata when the branch name already matches', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-metadata-source-head-');
        const targetRoot = await makeTempDir('git-reconcile-metadata-target-head-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await runGit(sourceRoot, ['checkout', '-b', 'feature']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature v1\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v1']);
            const featureV1Revision = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature v2\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v2']);
            const featureV2Revision = await runGit(sourceRoot, ['rev-parse', 'HEAD']);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);
            await runGit(targetRoot, ['checkout', 'feature']);
            await runGit(targetRoot, ['reset', '--hard', featureV1Revision]);
            await writeFile(join(targetRoot, 'README.md'), 'feature v2\n', 'utf8');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'branch',
                    branchName: 'feature',
                    headRevision: featureV2Revision,
                },
            });

            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(featureV2Revision);
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('feature v2\n');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('detaches the restored target HEAD to exported git metadata without resetting imported files', async () => {
        const targetRoot = await makeTempDir('git-reconcile-detached-metadata-target-');

        try {
            await runGit(targetRoot, ['init']);
            await configureGitRepo(targetRoot);
            await runGit(targetRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(targetRoot, 'README.md', 'main\n');
            await runGit(targetRoot, ['commit', '-m', 'initial']);
            const headRevision = await runGit(targetRoot, ['rev-parse', 'HEAD']);
            await writeFile(join(targetRoot, 'README.md'), 'imported\n', 'utf8');

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'detached',
                    headRevision,
                },
            });

            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).rejects.toThrow();
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(headRevision);
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('imported\n');
        } finally {
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('restores a plain git checkout from the previous target during metadata-only import after replace-existing content promotion', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-metadata-plain-source-');
        const targetRoot = await makeTempDir('git-reconcile-metadata-plain-target-');
        const backupRoot = `${targetRoot}-backup`;

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await runGit(sourceRoot, ['checkout', '-b', 'feature']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature']);
            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);

            await rename(targetRoot, backupRoot);
            await cp(sourceRoot, targetRoot, { recursive: true });
            await rm(join(targetRoot, '.git'), { recursive: true, force: true });

            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(false);

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                previousTargetPath: backupRoot,
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'branch',
                    branchName: 'feature',
                    headRevision: sourceHead,
                },
            });

            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(true);
            await expect(runGit(targetRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHead);
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('feature\n');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
            await rm(backupRoot, { recursive: true, force: true });
        }
    });

    it('restores a plain cloned target checkout from the previous target during same-machine apply before source branch realignment', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-apply-plain-source-');
        const targetRoot = await makeTempDir('git-reconcile-apply-plain-target-');
        const backupRoot = `${targetRoot}-backup`;

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'main\n');
            await runGit(sourceRoot, ['commit', '-m', 'initial']);
            await runGit(sourceRoot, ['checkout', '-b', 'feature']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature v1\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v1']);

            await runGit(tmpdir(), ['clone', sourceRoot, targetRoot]);
            await configureGitRepo(targetRoot);

            await writeTrackedFile(sourceRoot, 'README.md', 'feature v2\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature v2']);
            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);

            await rename(targetRoot, backupRoot);
            await cp(sourceRoot, targetRoot, { recursive: true });
            await rm(join(targetRoot, '.git'), { recursive: true, force: true });

            const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourceRoot });
            const previousTargetIdentity = await inspectGitCheckoutIdentity({ cwd: backupRoot });
            expect(sourceIdentity).not.toBeNull();
            expect(previousTargetIdentity).not.toBeNull();
            expect(sourceIdentity?.gitDirPath).not.toBe(previousTargetIdentity?.gitDirPath);
            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(false);

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
                previousTargetPath: backupRoot,
            });

            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(true);
            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature');
            await expect(runGit(targetRoot, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHead);
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('feature v2\n');
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
            await rm(backupRoot, { recursive: true, force: true });
        }
    });

    it('restores linked-worktree admin state from the previous target during metadata-only import after copied git admin files overwrite the target', async () => {
        const repoRoot = await makeTempDir('git-reconcile-metadata-worktree-repo-');
        const sourceRoot = await makeTempDir('git-reconcile-metadata-worktree-source-');
        const targetRoot = await makeTempDir('git-reconcile-metadata-worktree-target-');
        const backupRoot = `${targetRoot}-backup`;

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-source']);
            await runGit(repoRoot, ['branch', 'feature-target']);
            await runGit(repoRoot, ['worktree', 'add', sourceRoot, 'feature-source']);
            await runGit(repoRoot, ['worktree', 'add', targetRoot, 'feature-target']);
            await writeTrackedFile(sourceRoot, 'README.md', 'feature source\n');
            await runGit(sourceRoot, ['commit', '-m', 'feature source']);
            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);

            const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourceRoot });
            const originalTargetIdentity = await inspectGitCheckoutIdentity({ cwd: targetRoot });
            expect(sourceIdentity).not.toBeNull();
            expect(originalTargetIdentity).not.toBeNull();
            expect(sourceIdentity?.gitDirPath).not.toBe(originalTargetIdentity?.gitDirPath);

            await rename(targetRoot, backupRoot);
            await cp(sourceRoot, targetRoot, { recursive: true });

            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toEqual(expect.objectContaining({
                gitDirPath: sourceIdentity?.gitDirPath,
                branchName: 'feature-source',
            }));

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                previousTargetPath: backupRoot,
                sourceControllerMetadata: {
                    provider: 'git',
                    checkoutKind: 'branch',
                    branchName: 'feature-source',
                    headRevision: sourceHead,
                },
            });

            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toEqual(expect.objectContaining({
                gitDirPath: originalTargetIdentity?.gitDirPath,
                commonDirPath: originalTargetIdentity?.commonDirPath,
                registeredWorktreePath: targetRoot,
                branchName: 'feature-source',
                headRevision: sourceHead,
            }));
            await expect(readFile(join(targetRoot, '.git'), 'utf8')).resolves.toBe(`gitdir: ${originalTargetIdentity?.gitDirPath}\n`);
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.toContain(`worktree ${targetRoot}`);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
            await rm(backupRoot, { recursive: true, force: true });
        }
    });

    it('does nothing when the materialized target is not a git checkout and there is no admin state to restore', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-missing-target-source-');
        const targetRoot = await makeTempDir('git-reconcile-missing-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'source\n');
            await runGit(sourceRoot, ['commit', '-m', 'source']);

            await expect(reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
            })).resolves.toBeUndefined();

            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(false);
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('skips admin-state restore when the backup checkout belongs to a different git identity', async () => {
        const sourceRoot = await makeTempDir('git-reconcile-identity-source-');
        const previousTargetRoot = await makeTempDir('git-reconcile-identity-previous-target-');
        const targetRoot = await makeTempDir('git-reconcile-identity-target-');

        try {
            await runGit(sourceRoot, ['init']);
            await configureGitRepo(sourceRoot);
            await runGit(sourceRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(sourceRoot, 'README.md', 'source\n');
            await runGit(sourceRoot, ['commit', '-m', 'source']);

            await runGit(previousTargetRoot, ['init']);
            await configureGitRepo(previousTargetRoot);
            await runGit(previousTargetRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(previousTargetRoot, 'README.md', 'backup\n');
            await runGit(previousTargetRoot, ['commit', '-m', 'backup']);

            await expect(reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
                previousTargetPath: previousTargetRoot,
            })).resolves.toBeUndefined();

            await expect(pathExists(join(targetRoot, '.git'))).resolves.toBe(false);
            await expect(pathExists(join(previousTargetRoot, '.git'))).resolves.toBe(true);
        } finally {
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(previousTargetRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });

    it('restores the original target worktree admin redirection after staged source files overwrite the target .git file', async () => {
        const repoRoot = await makeTempDir('git-reconcile-worktree-repo-');
        const sourceRoot = await makeTempDir('git-reconcile-worktree-source-');
        const targetRoot = await makeTempDir('git-reconcile-worktree-target-');
        const backupRoot = `${targetRoot}-backup`;

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-source']);
            await runGit(repoRoot, ['branch', 'feature-target']);
            await runGit(repoRoot, ['worktree', 'add', sourceRoot, 'feature-source']);
            await runGit(repoRoot, ['worktree', 'add', targetRoot, 'feature-target']);
            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
            await runGit(sourceRoot, ['checkout', sourceHead]);

            const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourceRoot });
            const originalTargetIdentity = await inspectGitCheckoutIdentity({ cwd: targetRoot });
            expect(sourceIdentity).not.toBeNull();
            expect(originalTargetIdentity).not.toBeNull();
            expect(sourceIdentity?.branchName).toBeNull();
            expect(sourceIdentity?.gitDirPath).not.toBe(originalTargetIdentity?.gitDirPath);

            await rename(targetRoot, backupRoot);
            await cp(sourceRoot, targetRoot, { recursive: true });

            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toEqual(expect.objectContaining({
                gitDirPath: sourceIdentity?.gitDirPath,
            }));

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
                previousTargetPath: backupRoot,
            });

            const repairedTargetIdentity = await inspectGitCheckoutIdentity({ cwd: targetRoot });
            expect(repairedTargetIdentity).not.toBeNull();
            await expect(Promise.resolve(repairedTargetIdentity)).resolves.toEqual(expect.objectContaining({
                gitDirPath: originalTargetIdentity?.gitDirPath,
                commonDirPath: originalTargetIdentity?.commonDirPath,
            }));
            const worktreeList = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
            expect(worktreeList).toContain(`worktree ${repairedTargetIdentity?.registeredWorktreePath}`);
            expect(worktreeList).not.toContain(`worktree ${backupRoot}`);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
            await rm(backupRoot, { recursive: true, force: true });
        }
    });

    it('restores the original target worktree admin state even after the copied source checkout becomes unreadable', async () => {
        const repoRoot = await makeTempDir('git-reconcile-worktree-unreadable-repo-');
        const sourceRoot = await makeTempDir('git-reconcile-worktree-unreadable-source-');
        const targetRoot = await makeTempDir('git-reconcile-worktree-unreadable-target-');
        const backupRoot = `${targetRoot}-backup`;

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-source']);
            await runGit(repoRoot, ['branch', 'feature-target']);
            await runGit(repoRoot, ['worktree', 'add', sourceRoot, 'feature-source']);
            await runGit(repoRoot, ['worktree', 'add', targetRoot, 'feature-target']);

            const sourceIdentity = await inspectGitCheckoutIdentity({ cwd: sourceRoot });
            const originalTargetIdentity = await inspectGitCheckoutIdentity({ cwd: targetRoot });
            expect(sourceIdentity).not.toBeNull();
            expect(originalTargetIdentity).not.toBeNull();

            await rename(targetRoot, backupRoot);
            await cp(sourceRoot, targetRoot, { recursive: true });
            await rm(sourceIdentity!.gitDirPath, { recursive: true, force: true });

            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toBeNull();

            await reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
                previousTargetPath: backupRoot,
            });

            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toEqual(expect.objectContaining({
                gitDirPath: originalTargetIdentity?.gitDirPath,
                commonDirPath: originalTargetIdentity?.commonDirPath,
                branchName: 'feature-target',
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
            await rm(backupRoot, { recursive: true, force: true });
        }
    });

    it('rebinds a restored linked worktree even when the preserved .git file still points at the old location', async () => {
        const repoRoot = await makeTempDir('git-reconcile-worktree-relative-repo-');
        const sourceRoot = await makeTempDir('git-reconcile-worktree-relative-source-');
        const originalTargetRoot = join(await makeTempDir('git-reconcile-worktree-original-parent-'), 'checkout');
        const targetRoot = join(await makeTempDir('git-reconcile-worktree-restored-parent-'), 'nested', 'checkout-restored');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-source']);
            await runGit(repoRoot, ['branch', 'feature-target']);
            await runGit(repoRoot, ['worktree', 'add', sourceRoot, 'feature-source']);
            await runGit(repoRoot, ['worktree', 'add', originalTargetRoot, 'feature-target']);
            const sourceHead = await runGit(sourceRoot, ['rev-parse', 'HEAD']);
            await runGit(sourceRoot, ['checkout', sourceHead]);

            const originalTargetIdentity = await inspectGitCheckoutIdentity({ cwd: originalTargetRoot });
            expect(originalTargetIdentity).not.toBeNull();

            await writeFile(
                join(originalTargetRoot, '.git'),
                `gitdir: ${relative(originalTargetRoot, originalTargetIdentity!.gitDirPath)}\n`,
                'utf8',
            );

            await mkdir(join(targetRoot, '..'), { recursive: true });
            await cp(sourceRoot, targetRoot, { recursive: true });

            await expect(reconcileGitWorkspaceCheckout({
                context: {
                    cwd: targetRoot,
                    projectKey: `test:${targetRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: targetRoot,
                        mode: '.git',
                    },
                },
                sourcePath: sourceRoot,
                previousTargetPath: originalTargetRoot,
            })).resolves.toBeUndefined();

            await expect(readFile(join(targetRoot, '.git'), 'utf8')).resolves.toBe(`gitdir: ${originalTargetIdentity?.gitDirPath}\n`);
            await expect(inspectGitCheckoutIdentity({ cwd: targetRoot })).resolves.toEqual(expect.objectContaining({
                gitDirPath: originalTargetIdentity?.gitDirPath,
                commonDirPath: originalTargetIdentity?.commonDirPath,
                branchName: 'feature-target',
                registeredWorktreePath: targetRoot,
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(sourceRoot, { recursive: true, force: true });
            await rm(originalTargetRoot, { recursive: true, force: true });
            await rm(targetRoot, { recursive: true, force: true });
        }
    });
});
