import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveGitWorkspaceTransferEntries } from './resolveGitWorkspaceTransferEntries';

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

describe('resolveGitWorkspaceTransferEntries', () => {
    it('includes portable .git metadata for a primary checkout', async () => {
        const repoRoot = await makeTempDir('git-transfer-primary-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const entries = await resolveGitWorkspaceTransferEntries({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            });

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md' }),
                expect.objectContaining({ relativePath: '.git/HEAD' }),
            ]));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits linked-worktree admin metadata from a primary checkout export', async () => {
        const repoRoot = await makeTempDir('git-transfer-primary-linked-admin-repo-');
        const worktreeRoot = await makeTempDir('git-transfer-primary-linked-admin-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature']);
            await runGit(repoRoot, ['worktree', 'add', worktreeRoot, 'feature']);

            const entries = await resolveGitWorkspaceTransferEntries({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            });

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: '.git/HEAD' }),
            ]));
            expect(entries.some((entry) => entry.relativePath.startsWith('.git/worktrees/'))).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    });

    it('scopes nested workspace exports to the requested subdirectory and omits checkout metadata', async () => {
        const repoRoot = await makeTempDir('git-transfer-nested-workspace-');
        const nestedWorkspaceDir = join(repoRoot, 'apps', 'demo');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await mkdir(nestedWorkspaceDir, { recursive: true });
            await writeFile(join(repoRoot, 'README.md'), 'repo root\n', 'utf8');
            await writeFile(join(nestedWorkspaceDir, 'workspace.txt'), 'workspace\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md', 'apps/demo/workspace.txt']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const entries = await resolveGitWorkspaceTransferEntries({
                context: {
                    cwd: nestedWorkspaceDir,
                    projectKey: `test:${nestedWorkspaceDir}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceTransfer: {
                    strategy: 'sync_changes',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            });

            expect(entries).toEqual([
                expect.objectContaining({ relativePath: 'workspace.txt' }),
            ]);
            expect(entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
            expect(entries.some((entry) => entry.relativePath === 'README.md')).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits non-portable linked-worktree admin metadata', async () => {
        const repoRoot = await makeTempDir('git-transfer-linked-repo-');
        const worktreeRoot = await makeTempDir('git-transfer-linked-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature']);
            await runGit(repoRoot, ['worktree', 'add', worktreeRoot, 'feature']);

            const entries = await resolveGitWorkspaceTransferEntries({
                context: {
                    cwd: worktreeRoot,
                    projectKey: `test:${worktreeRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            });

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md' }),
            ]));
            expect(entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    });

    it('falls back when git metadata discovery cannot use path-format absolute', async () => {
        const repoRoot = await makeTempDir('git-transfer-path-fallback-');
        const wrapperRoot = await makeTempDir('git-transfer-path-wrapper-');
        const originalPath = process.env.PATH;

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const gitBinaryPath = await resolveGitBinaryPath();
            const wrapperPath = join(wrapperRoot, 'git');
            await writeFile(
                wrapperPath,
                `#!/bin/sh
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--path-format=absolute" ]; then
    echo "fatal: unknown option: --path-format=absolute" >&2
    exit 129
fi
exec "${gitBinaryPath}" "$@"
`,
                'utf8'
            );
            await chmod(wrapperPath, 0o755);
            process.env.PATH = `${wrapperRoot}:${originalPath ?? ''}`;

            const entries = await resolveGitWorkspaceTransferEntries({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: {
                        isRepo: true,
                        rootPath: repoRoot,
                        mode: '.git',
                    },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            });

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md' }),
                expect.objectContaining({ relativePath: '.git/HEAD' }),
            ]));
        } finally {
            process.env.PATH = originalPath;
            await rm(repoRoot, { recursive: true, force: true });
            await rm(wrapperRoot, { recursive: true, force: true });
        }
    });
});
