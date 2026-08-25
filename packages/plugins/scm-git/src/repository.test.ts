import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from './types.js';
import { createGitBackend } from './backend.js';
import { detectGitRepo } from './repository.js';
import { runWithGitScmCommandRunner, runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function makeTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function initRepoWithCommit(prefix: string): Promise<string> {
    const repoRoot = await makeTempDir(prefix);
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await runGit(repoRoot, ['branch', '-M', 'main']);
    await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'README.md']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function buildContext(repoRoot: string): ScmBackendContext {
    return {
        cwd: repoRoot,
        projectKey: `test:${repoRoot}`,
        detection: {
            isRepo: true,
            rootPath: repoRoot,
            mode: '.git',
        },
    };
}

describe('Git repository worktree status enrichment', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => undefined)));
    });

    it('enriches status snapshots only when includeWorktreeStatus is true', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-snap-enrich-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        const canonicalRoot = await realpath(repoRoot);

        const backend = createGitBackend();
        const context = buildContext(repoRoot);

        const lightResponse = await runWithRealGitScmRuntime(() => backend.statusSnapshot({
            context,
            request: {},
        }));
        expect(lightResponse.success).toBe(true);
        const lightWorktree = lightResponse.snapshot?.repo.worktrees.find((worktree) => worktree.path === canonicalRoot);
        expect(lightWorktree?.changeCount).toBeUndefined();
        expect(lightWorktree?.lastActivityAt).toBeUndefined();

        const enrichedResponse = await runWithRealGitScmRuntime(() => backend.statusSnapshot({
            context,
            request: { includeWorktreeStatus: true },
        }));
        expect(enrichedResponse.success).toBe(true);
        const enrichedWorktree = enrichedResponse.snapshot?.repo.worktrees.find((worktree) => worktree.path === canonicalRoot);
        expect(enrichedWorktree?.changeCount).toBeGreaterThanOrEqual(1);
        expect(enrichedWorktree?.lastActivityAt).toBeGreaterThan(0);
    });

    it('dedicated enrichment validates requested paths against registered realpath worktrees', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-path-enrich-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        const canonicalRoot = await realpath(repoRoot);
        const symlinkDir = await makeTempDir('git-plugin-path-enrich-link-');
        cleanups.push(() => rm(symlinkDir, { recursive: true, force: true }));
        const symlinkPath = join(symlinkDir, 'repo-link');
        await symlink(canonicalRoot, symlinkPath, 'dir');

        const backend = createGitBackend() as ReturnType<typeof createGitBackend> & {
            worktreesEnrichment?: (input: {
                context: ScmBackendContext;
                request: { worktreePaths: string[] };
            }) => Promise<{ success: boolean; worktrees?: Array<{ path: string; changeCount?: number; lastActivityAt?: number }> }>;
        };

        expect(typeof backend.worktreesEnrichment).toBe('function');
        if (typeof backend.worktreesEnrichment !== 'function') return;

        const response = await runWithRealGitScmRuntime(() => backend.worktreesEnrichment!({
            context: buildContext(canonicalRoot),
            request: { worktreePaths: [symlinkPath, '/etc'] },
        }));

        expect(response.success).toBe(true);
        expect(response.worktrees).toHaveLength(1);
        expect(response.worktrees?.[0]?.path).toBe(canonicalRoot);
        expect(response.worktrees?.[0]?.changeCount).toBeGreaterThanOrEqual(1);
        expect(response.worktrees?.[0]?.lastActivityAt).toBeGreaterThan(0);
    });
});

describe('Git repository detection', () => {
    // F-SCM-1. `git rev-parse --is-inside-work-tree` exits non-zero for a directory that is not a
    // repository AND for a git that cannot run at all, so the exit code alone cannot tell a real
    // negative from a broken tool. Reported live: a `git` that failed every invocation made the
    // session source-control pane say "This directory is not under source control" about a healthy
    // repository, and it stayed wrong after `git` came back.
    it('refuses to answer when git fails every invocation, instead of reporting "not a repository"', async () => {
        const detection = runWithGitScmCommandRunner(
            async () => ({
                success: false,
                stdout: '',
                stderr: 'fatal: broken git\n',
                exitCode: 128,
            }),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-broken-git' }),
        );

        await expect(detection).rejects.toMatchObject({
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });
    });

    it('still reports a real non-repository as one when git itself is healthy', async () => {
        const detection = await runWithGitScmCommandRunner(
            async (input) => (
                input.args[0] === '--version'
                    ? { success: true, stdout: 'git version 2.49.0\n', stderr: '', exitCode: 0 }
                    : {
                        success: false,
                        stdout: '',
                        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
                        exitCode: 128,
                    }
            ),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-plain-folder' }),
        );

        expect(detection).toEqual({ isRepo: false, rootPath: null, mode: null });
    });

    it('refuses to answer when the probe is cut short even though the binary works', async () => {
        const detection = runWithGitScmCommandRunner(
            async (input) => (
                input.args[0] === '--version'
                    ? { success: true, stdout: 'git version 2.49.0\n', stderr: '', exitCode: 0 }
                    : { success: false, stdout: '', stderr: '', exitCode: -1, timedOut: true }
            ),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-stalled' }),
        );

        await expect(detection).rejects.toMatchObject({
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });
    });

    it('detects a real repository against the real git binary', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-detect-real-');
        try {
            const detection = await runWithRealGitScmRuntime(() => detectGitRepo({ cwd: repoRoot }));
            expect(detection.isRepo).toBe(true);
            expect(detection.mode).toBe('.git');
            expect(detection.rootPath).toBe(await realpath(repoRoot));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
