import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScmBackendContext } from './types.js';
import { createGitBackend } from './backend.js';
import { runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';

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
