import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { inspectGitCheckoutIdentity } from './checkoutIdentity';

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

async function resolveGitBinaryPath(): Promise<string> {
    const { stdout } = await execFile('which', ['git']);
    return stdout.trim();
}

describe('inspectGitCheckoutIdentity', () => {
    it('returns the checkout branch, head revision, and git admin paths for an attached checkout', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-attached-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const headRevision = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            const gitDirPath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-dir']);
            const commonDirPath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            const worktreePath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']);

            await expect(inspectGitCheckoutIdentity({ cwd: repoRoot })).resolves.toEqual({
                branchName: 'main',
                headRevision,
                gitDirPath,
                commonDirPath,
                worktreePath,
                registeredWorktreePath: worktreePath,
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns a detached checkout identity without a branch name', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-detached-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const headRevision = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            await runGit(repoRoot, ['checkout', headRevision]);
            const worktreePath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']);

            await expect(inspectGitCheckoutIdentity({ cwd: repoRoot })).resolves.toEqual(
                expect.objectContaining({
                    branchName: null,
                    headRevision,
                    worktreePath,
                    registeredWorktreePath: worktreePath,
                })
            );
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns null when the cwd is not a git checkout', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-missing-');

        try {
            await expect(inspectGitCheckoutIdentity({ cwd: repoRoot })).resolves.toBeNull();
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns an unborn branch identity even before the first commit exists', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-unborn-');

        try {
            await runGit(repoRoot, ['init']);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await runGit(repoRoot, ['checkout', '-B', 'feature']);

            const gitDirPath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-dir']);
            const commonDirPath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            const worktreePath = await runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']);

            await expect(inspectGitCheckoutIdentity({ cwd: repoRoot })).resolves.toEqual({
                branchName: 'feature',
                headRevision: null,
                gitDirPath,
                commonDirPath,
                worktreePath,
                registeredWorktreePath: worktreePath,
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns linked worktree paths for a linked worktree checkout identity', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-linked-repo-');
        const worktreeRoot = await makeTempDir('git-checkout-identity-linked-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature']);
            await runGit(repoRoot, ['worktree', 'add', worktreeRoot, 'feature']);

            const headRevision = await runGit(worktreeRoot, ['rev-parse', 'HEAD']);
            const gitDirPath = await runGit(worktreeRoot, ['rev-parse', '--path-format=absolute', '--git-dir']);
            const commonDirPath = await runGit(worktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            const worktreePath = await runGit(worktreeRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel']);

            await expect(inspectGitCheckoutIdentity({ cwd: worktreeRoot })).resolves.toEqual({
                branchName: 'feature',
                headRevision,
                gitDirPath,
                commonDirPath,
                worktreePath,
                registeredWorktreePath: worktreePath,
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    });

    it('falls back when git does not support path-format absolute reporting', async () => {
        const repoRoot = await makeTempDir('git-checkout-identity-path-fallback-');
        const wrapperRoot = await makeTempDir('git-checkout-identity-path-wrapper-');
        const originalPath = process.env.PATH;

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const headRevision = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            const fallbackWorktreePath = await runGit(repoRoot, ['rev-parse', '--show-toplevel']);
            const gitBinaryPath = await resolveGitBinaryPath();
            const wrapperPath = join(wrapperRoot, 'git');
            await writeFile(
                wrapperPath,
                `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then
    echo "fatal: unknown option: --path-format=absolute" >&2
    exit 129
fi
exec "${gitBinaryPath}" "$@"
`,
                'utf8'
            );
            await chmod(wrapperPath, 0o755);
            process.env.PATH = `${wrapperRoot}:${originalPath ?? ''}`;

            await expect(inspectGitCheckoutIdentity({ cwd: repoRoot })).resolves.toEqual({
                branchName: 'main',
                headRevision,
                gitDirPath: join(repoRoot, '.git'),
                commonDirPath: join(repoRoot, '.git'),
                worktreePath: fallbackWorktreePath,
                registeredWorktreePath: fallbackWorktreePath,
            });
        } finally {
            process.env.PATH = originalPath;
            await rm(repoRoot, { recursive: true, force: true });
            await rm(wrapperRoot, { recursive: true, force: true });
        }
    });
});
