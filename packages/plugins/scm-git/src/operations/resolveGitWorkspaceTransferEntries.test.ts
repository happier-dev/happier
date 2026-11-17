import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { resolveGitWorkspaceTransferEntries } from './resolveGitWorkspaceTransferEntries.js';
import { resolveGitWorkspaceTransferSource } from '../workspaceIntegration.js';

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

async function withHostScmRuntime<T>(callback: () => Promise<T>): Promise<T> {
    return await runWithRealGitScmRuntime(callback);
}

describe('resolveGitWorkspaceTransferEntries', () => {
    it('classifies missing baseline candidates with Git while committed and ordinary deleted files stay eligible', async () => {
        const repoRoot = await makeTempDir('git-transfer-missing-omissions-');
        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, '.gitignore'), '*.env\n');
            await writeFile(join(repoRoot, 'ordinary.txt'), 'base\n');
            await runGit(repoRoot, ['add', '.']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await rm(join(repoRoot, 'ordinary.txt'));
            await writeFile(join(repoRoot, 'committed.env'), 'newly committed\n');
            await runGit(repoRoot, ['add', '-f', 'committed.env']);
            await runGit(repoRoot, ['commit', '-m', 'commit previously ignored path']);
            const selected = await withHostScmRuntime(() => resolveGitWorkspaceTransferSource({
                context: { cwd: repoRoot, projectKey: `test:${repoRoot}`,
                    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' } },
                workspaceTransfer: { strategy: 'transfer_snapshot', includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [],
                    exclusionCandidates: ['missing.env', 'missing\nsecret.env', 'ordinary.txt', 'committed.env'] },
            }));
            expect(selected?.entries.map(entry => entry.relativePath)).toContain('committed.env');
            expect(selected).toHaveProperty('excludedPaths', ['missing\nsecret.env', 'missing.env']);
            const eligibleOnly = await withHostScmRuntime(() => resolveGitWorkspaceTransferSource({
                context: { cwd: repoRoot, projectKey: `test:${repoRoot}`,
                    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' } },
                workspaceTransfer: { strategy: 'transfer_snapshot', includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [],
                    exclusionCandidates: ['ordinary.txt', 'committed.env'] },
            }));
            expect(eligibleOnly).toHaveProperty('excludedPaths', []);
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('reports exact existing omitted files and distinguishes new ignores from real deletions', async () => {
        const repoRoot = await makeTempDir('git-transfer-omissions-');
        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await mkdir(join(repoRoot, 'private'));
            await writeFile(join(repoRoot, '.gitignore'), 'private/\n');
            await writeFile(join(repoRoot, 'tracked.txt'), 'tracked\n');
            await runGit(repoRoot, ['add', '.']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await writeFile(join(repoRoot, 'local.env'), 'copied initially\n');
            await writeFile(join(repoRoot, 'private', 'secret.env'), 'ignored initially\n');
            const input = {
                context: { cwd: repoRoot, projectKey: `test:${repoRoot}`,
                    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const } },
                workspaceTransfer: { strategy: 'transfer_snapshot' as const, includeIgnoredMode: 'exclude' as const,
                    ignoredIncludeGlobs: [], includeAllIgnored: true },
            };
            const allFiles = await withHostScmRuntime(() => resolveGitWorkspaceTransferSource(input));
            expect(allFiles?.entries.map(entry => entry.relativePath)).toContain('private/secret.env');
            expect(allFiles).toHaveProperty('excludedPaths', []);

            await writeFile(join(repoRoot, '.gitignore'), 'private/\nlocal.env\n');
            await rm(join(repoRoot, 'tracked.txt'));
            const selected = await withHostScmRuntime(() => resolveGitWorkspaceTransferSource({
                ...input, workspaceTransfer: { ...input.workspaceTransfer, includeAllIgnored: false,
                    extraIgnorePatterns: ['tracked.txt'] },
            }));
            expect(selected?.entries.map(entry => entry.relativePath)).not.toContain('local.env');
            expect(selected).toHaveProperty('excludedPaths', ['local.env', 'private/secret.env']);
        } finally { await rm(repoRoot, { recursive: true, force: true }); }
    });

    it('applies the bounded policy overlay to tracked and untracked seed entries while explicit includes win', async () => {
        const repoRoot = await makeTempDir('git-transfer-policy-overlay-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await mkdir(join(repoRoot, 'dist'), { recursive: true });
            await mkdir(join(repoRoot, 'ignored'), { recursive: true });
            await writeFile(join(repoRoot, '.gitignore'), 'ignored/**\n', 'utf8');
            await writeFile(join(repoRoot, 'dist', 'tracked.txt'), 'tracked\n', 'utf8');
            await writeFile(join(repoRoot, 'dist', 'ordinary.txt'), 'ordinary\n', 'utf8');
            await writeFile(join(repoRoot, 'ignored', 'all-files.txt'), 'all files\n', 'utf8');
            await writeFile(join(repoRoot, 'ignored', 'selected.txt'), 'selected\n', 'utf8');
            await runGit(repoRoot, ['add', '.gitignore', 'dist/tracked.txt']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const selected = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferSource({
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
                    includeIgnoredMode: 'include_selected',
                    ignoredIncludeGlobs: ['dist/tracked.txt', 'ignored/selected.txt'],
                    includeAllIgnored: true,
                    extraIgnorePatterns: ['dist/**', 'ignored/selected.txt'],
                },
            }));

            expect(selected?.entries.map((entry) => entry.relativePath)).toEqual([
                '.gitignore',
                'dist/tracked.txt',
                'ignored/all-files.txt',
                'ignored/selected.txt',
            ]);
            expect(selected).toHaveProperty('excludedPaths', ['dist/ordinary.txt']);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('never exports checkout administration from a primary checkout', async () => {
        const repoRoot = await makeTempDir('git-transfer-primary-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
            await runGit(repoRoot, ['add', 'README.md']);
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const entries = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferEntries({
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
            }));

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md' }),
            ]));
            expect(entries.some((entry) => entry.relativePath === '.git/config')).toBe(false);
            expect(entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('omits all checkout administration when a primary checkout owns linked worktrees', async () => {
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

            const entries = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferEntries({
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
            }));

            expect(entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    }, 15_000);

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

            const entries = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferEntries({
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
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
            }));

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

            const entries = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferEntries({
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
            }));

            expect(entries).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'README.md' }),
            ]));
            expect(entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(worktreeRoot, { recursive: true, force: true });
        }
    }, 15_000);

    it('handles large git ls-files output without hitting exec maxBuffer limits', async () => {
        const repoRoot = await makeTempDir('git-transfer-large-ls-files-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);

            const deepDirSegment = `seg-${'x'.repeat(80)}`;
            const baseDir = join(repoRoot, deepDirSegment, deepDirSegment, deepDirSegment);
            const bucketCount = 25;
            const fileCount = 3500;

            const createdDirs = new Set<string>();
            const expectedRelativePath = join(
                deepDirSegment,
                deepDirSegment,
                deepDirSegment,
                'b0',
                `file-0000-${'y'.repeat(120)}.txt`,
            ).replace(/\\/g, '/');

            for (let index = 0; index < fileCount; index += 1) {
                const bucketDir = join(baseDir, `b${index % bucketCount}`);
                if (!createdDirs.has(bucketDir)) {
                    createdDirs.add(bucketDir);
                    await mkdir(bucketDir, { recursive: true });
                }

                const fileName = `file-${String(index).padStart(4, '0')}-${'y'.repeat(120)}.txt`;
                await writeFile(join(bucketDir, fileName), 'x', 'utf8');
            }

            const entries = await withHostScmRuntime(async () => await resolveGitWorkspaceTransferEntries({
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
            }));

            expect(entries.some((entry) => entry.relativePath === expectedRelativePath)).toBe(true);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    }, 15_000);
});
