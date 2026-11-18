import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { assertPortableGitWorkspaceEntries } from '../workspaceIntegration.js';

import {
    createRealGitScmBackendRuntimeServices,
    runWithGitScmCommandRunner,
    runWithRealGitScmRuntime,
} from '../testkit/scmRuntime.test-support.js';
import {
    materializePortableGitWorkspaceBundle,
    preparePortableGitWorkspaceTransfer,
} from './portableGitWorkspaceTransfer.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function copyTransferEntries(
    entries: readonly Readonly<{ relativePath: string; sourcePath: string }>[],
    targetPath: string,
): Promise<void> {
    for (const entry of entries) {
        const destination = join(targetPath, entry.relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(entry.sourcePath));
    }
}

async function createRepositoryFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'portable-git-source-'));
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'test@example.com']);
    await runGit(root, ['config', 'user.name', 'Happier Test']);
    await runGit(root, ['config', 'credential.helper', 'machine-local-secret-helper']);
    await runGit(root, ['branch', '-M', 'main']);
    await writeFile(join(root, 'tracked.txt'), 'committed\n', 'utf8');
    await runGit(root, ['add', 'tracked.txt']);
    await runGit(root, ['commit', '-m', 'initial']);
    await writeFile(join(root, 'tracked.txt'), 'working copy\n', 'utf8');
    await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
    await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 7\n', 'utf8');
    await writeFile(join(root, '.git', 'index.lock'), 'machine local lock\n', 'utf8');
    return root;
}

describe('portable Git workspace transfer', () => {
    it('binds transfer metadata to the exact HEAD advertised by the staged bundle', async () => {
        const repositoryRoot = await createRepositoryFixture();
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'portable-git-artifacts-'));
        const realRuntime = createRealGitScmBackendRuntimeServices();
        let committedAfterIdentityRead = false;
        try {
            await rm(join(repositoryRoot, '.git', 'index.lock'), { force: true });
            const prepared = await runWithGitScmCommandRunner(async (input) => {
                const result = await realRuntime.runCommand(input);
                if (!committedAfterIdentityRead
                    && result.success
                    && input.args.slice(-3).join('\0') === ['rev-parse', '--verify', 'HEAD'].join('\0')) {
                    committedAfterIdentityRead = true;
                    await writeFile(join(repositoryRoot, 'later.txt'), 'later commit\n', 'utf8');
                    await runGit(repositoryRoot, ['add', 'later.txt']);
                    await runGit(repositoryRoot, ['commit', '-m', 'later']);
                }
                return result;
            }, async () => await preparePortableGitWorkspaceTransfer({
                context: {
                    cwd: repositoryRoot,
                    projectKey: `test:${repositoryRoot}`,
                    detection: { isRepo: true, rootPath: repositoryRoot, mode: '.git' },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                artifactDirectory,
            }));

            expect(committedAfterIdentityRead).toBe(true);
            const bundleEntry = prepared.entries.find((entry) => entry.relativePath === '.happier-scm/git.bundle');
            expect(bundleEntry).toBeDefined();
            const advertisedHead = await runGit(repositoryRoot, [
                'bundle',
                'list-heads',
                bundleEntry!.sourcePath,
                'HEAD',
            ]);
            expect(prepared.metadata).toMatchObject({
                headRevision: advertisedHead.split(/\s+/u)[0],
            });
            await bundleEntry!.disposeSource?.();
        } finally {
            await rm(repositoryRoot, { recursive: true, force: true });
            await rm(artifactDirectory, { recursive: true, force: true });
        }
    });

    it('fails closed when the staged bundle does not advertise one unambiguous HEAD', async () => {
        const repositoryRoot = await createRepositoryFixture();
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'portable-git-artifacts-'));
        const realRuntime = createRealGitScmBackendRuntimeServices();
        try {
            await expect(runWithGitScmCommandRunner(async (input) => {
                if (input.args.slice(0, 2).join('\0') === ['bundle', 'list-heads'].join('\0')) {
                    return {
                        success: true,
                        stdout: `${'1'.repeat(40)} HEAD\n${'2'.repeat(40)} HEAD\n`,
                        stderr: '',
                        exitCode: 0,
                    };
                }
                return await realRuntime.runCommand(input);
            }, async () => await preparePortableGitWorkspaceTransfer({
                context: {
                    cwd: repositoryRoot,
                    projectKey: `test:${repositoryRoot}`,
                    detection: { isRepo: true, rootPath: repositoryRoot, mode: '.git' },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                artifactDirectory,
            }))).rejects.toMatchObject({ code: 'git_selection_unavailable' });
        } finally {
            await rm(repositoryRoot, { recursive: true, force: true });
            await rm(artifactDirectory, { recursive: true, force: true });
        }
    });

    for (const sourceKind of ['primary', 'linked', 'separate', 'submodule'] as const) {
        for (const sessionLocation of ['root', 'nested'] as const) {
            it(`materializes a portable ${sourceKind} checkout from a ${sessionLocation} session without copying Git administration`, async () => {
            const repositoryRoot = await createRepositoryFixture();
            const artifactDirectory = await mkdtemp(join(tmpdir(), 'portable-git-artifacts-'));
            const targetPath = await mkdtemp(join(tmpdir(), 'portable-git-target-'));
            let sourcePath = repositoryRoot;
            try {
                if (sourceKind === 'linked') {
                    sourcePath = await mkdtemp(join(tmpdir(), 'portable-git-linked-'));
                    await runGit(repositoryRoot, ['branch', 'feature']);
                    await runGit(repositoryRoot, ['worktree', 'add', sourcePath, 'feature']);
                    await writeFile(join(sourcePath, 'tracked.txt'), 'linked working copy\n', 'utf8');
                    await writeFile(join(sourcePath, 'linked-untracked.txt'), 'linked untracked\n', 'utf8');
                }

                if (sourceKind === 'separate') {
                    await runGit(repositoryRoot, ['init', '--separate-git-dir', join(artifactDirectory, 'admin')]);
                }
                if (sourceKind === 'submodule') {
                    await rm(join(repositoryRoot, '.git', 'index.lock'), { force: true });
                    await runGit(repositoryRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', repositoryRoot, 'child']);
                    sourcePath = join(repositoryRoot, 'child');
                    await writeFile(join(sourcePath, 'tracked.txt'), 'working copy\n');
                    await writeFile(join(sourcePath, 'untracked.txt'), 'untracked\n');
                }

                const sessionPath = sessionLocation === 'nested' ? join(sourcePath, 'packages', 'empty') : sourcePath;
                if (sessionLocation === 'nested') await mkdir(sessionPath, { recursive: true });
                const prepared = await runWithRealGitScmRuntime(() => preparePortableGitWorkspaceTransfer({
                    context: {
                        cwd: sessionPath,
                        projectKey: `test:${sessionPath}`,
                        detection: { isRepo: true, rootPath: sourcePath, mode: '.git' },
                    },
                    workspaceTransfer: {
                        strategy: 'transfer_snapshot',
                        includeIgnoredMode: 'exclude',
                        ignoredIncludeGlobs: [],
                        includeAllIgnored: true,
                    },
                    artifactDirectory,
                }));

                await assertPortableGitWorkspaceEntries({ entries: prepared.entries });
                expect(prepared.entries.some((entry) => entry.relativePath.startsWith('.git/'))).toBe(false);
                expect(prepared.metadata).toMatchObject({
                    sessionRelativeCwd: sessionLocation === 'nested' ? 'packages/empty' : '',
                });
                expect(prepared.entries).toEqual(expect.arrayContaining([
                    expect.objectContaining({ relativePath: 'tracked.txt' }),
                    expect.objectContaining({ relativePath: '.happier-scm/git.bundle' }),
                ]));
                const bundleEntry = prepared.entries.find((entry) => entry.relativePath === '.happier-scm/git.bundle')!;
                await expect(runGit(sourcePath, ['bundle', 'verify', bundleEntry.sourcePath])).resolves.toContain('The bundle records a complete history');

                await copyTransferEntries(prepared.entries, targetPath);
                await runWithRealGitScmRuntime(() => materializePortableGitWorkspaceBundle({
                    targetPath,
                    workspaceIntegrationMetadata: prepared.metadata,
                }));

                await expect(runGit(targetPath, ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true');
                await expect(runGit(targetPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe(sourceKind !== 'linked' ? 'main' : 'feature');
                await expect(readFile(join(targetPath, 'tracked.txt'), 'utf8')).resolves.toBe(sourceKind !== 'linked' ? 'working copy\n' : 'linked working copy\n');
                const status = await runGit(targetPath, ['status', '--short']);
                expect(status).toContain('M tracked.txt');
                expect(status).toContain(sourceKind !== 'linked' ? '?? untracked.txt' : '?? linked-untracked.txt');
                await expect(runGit(targetPath, ['diff', '--cached', '--quiet'])).resolves.toBe('');
                await expect(runGit(targetPath, ['diff', '--quiet'])).rejects.toThrow();
                await expect(runGit(targetPath, ['config', '--local', '--get', 'credential.helper'])).rejects.toThrow();
                await expect(readFile(join(targetPath, '.git', 'hooks', 'post-checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(readFile(join(targetPath, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(readFile(join(targetPath, '.git', 'FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(readFile(join(targetPath, '.happier-scm', 'git.bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

                await bundleEntry.disposeSource?.();
                await expect(readFile(bundleEntry.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
            } finally {
                await rm(repositoryRoot, { recursive: true, force: true });
                if (sourceKind === 'linked' && sourcePath !== repositoryRoot) await rm(sourcePath, { recursive: true, force: true });
                await rm(artifactDirectory, { recursive: true, force: true });
                await rm(targetPath, { recursive: true, force: true });
            }
            }, 20_000);
        }
    }

    it('fails closed when the session cwd escapes the selected repository through a symlink', async () => {
        const repositoryRoot = await createRepositoryFixture();
        const outside = await mkdtemp(join(tmpdir(), 'portable-git-outside-'));
        const nestedPath = join(repositoryRoot, 'escaped');
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'portable-git-artifacts-'));
        try {
            await symlink(outside, nestedPath, 'dir');
            await expect(runWithRealGitScmRuntime(() => preparePortableGitWorkspaceTransfer({
                context: {
                    cwd: nestedPath,
                    projectKey: `test:${nestedPath}`,
                    detection: { isRepo: true, rootPath: repositoryRoot, mode: '.git' },
                },
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                artifactDirectory,
            }))).rejects.toMatchObject({ code: 'git_selection_unavailable' });
        } finally {
            await rm(repositoryRoot, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
            await rm(artifactDirectory, { recursive: true, force: true });
        }
    });
});
