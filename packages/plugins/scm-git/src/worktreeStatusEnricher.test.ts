import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';
import { enrichGitWorktreesWithStatus, readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function initRepoWithCommit(prefix: string): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), prefix));
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await runGit(repoRoot, ['branch', '-M', 'main']);
    await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'README.md']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

async function writeTrackedFile(repoRoot: string, relativePath: string, contents: string): Promise<void> {
    await writeFile(join(repoRoot, relativePath), contents, 'utf8');
    await runGit(repoRoot, ['add', relativePath]);
}

describe('readWorktreeStatusEnrichmentForPaths', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => undefined)));
    });

    it('counts rename porcelain records as one logical change', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-enrich-rename-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['mv', 'README.md', 'README-renamed.md']);

        const result = await runWithRealGitScmRuntime(() => readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
        }));

        expect(result[0]?.changeCount).toBe(1);
        expect(result[0]?.lastActivityAt).toBeGreaterThan(0);
    });

    it('preserves the complete change count without using dirty file mtimes as last use', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-enrich-budget-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const fileCount = 24;
        for (let index = 0; index < fileCount; index += 1) {
            await writeTrackedFile(repoRoot, `f${index}.txt`, 'a\n');
        }
        await runGit(repoRoot, ['commit', '-m', 'seed files']);
        for (let index = 0; index < fileCount; index += 1) {
            await writeFile(join(repoRoot, `f${index}.txt`), `b${index}\n`, 'utf8');
        }

        const result = await runWithRealGitScmRuntime(() => readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
        }));

        expect(result[0]?.changeCount).toBe(fileCount);
    });

    it('omits enrichment deterministically when the process boundary reports a timeout', async () => {
        const result = await runWithGitScmCommandRunner(async () => ({
            success: false,
            stdout: '',
            stderr: '',
            exitCode: -1,
            timedOut: true,
        }), () => enrichGitWorktreesWithStatus({
            worktrees: [{ path: '/repo/timed-out', branch: 'dev', isCurrent: false, isMain: true }],
            includeWorktreeStatus: true,
            perCallTimeoutMs: 1,
        }));

        expect(result).toHaveLength(1);
        expect(result[0]?.changeCount).toBeUndefined();
        expect(result[0]?.lastActivityAt).toBeUndefined();
    });

    it.each(['HEAD', 'symbolic-ref'] as const)('keeps identity-dependent enrichment unknown after interrupted %s inspection', async (probe) => {
        const repoRoot = await initRepoWithCommit('git-plugin-enrich-interrupted-identity-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const realCommand = createRealGitScmBackendRuntimeServices().runCommand;
        for (const interruption of [{ exitCode: 1, timedOut: true }, { exitCode: 1, outputLimitExceeded: true }, { exitCode: -1 }]) {
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                const interrupted = probe === 'symbolic-ref' ? input.args[0] === 'symbolic-ref'
                    : input.args[0] === 'rev-parse' && input.args.at(-1) === 'HEAD';
                return interrupted ? { success: false, stdout: '', stderr: 'inspection interrupted', ...interruption }
                    : realCommand(input);
            }, () => readWorktreeStatusEnrichmentForPaths({ worktreePaths: [repoRoot] })));
            expect(result).toEqual([{ path: repoRoot, changeCount: 0, hasSubmodules: false }]);
        }
    });

    it('uses an explicitly configured existing local default when remote HEAD is unavailable', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-enrich-local-default-');
        const remote = await mkdtemp(join(tmpdir(), 'git-plugin-enrich-local-remote-'));
        const worktree = join(repoRoot, 'feature-worktree');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }), () => rm(remote, { recursive: true, force: true }));
        await runGit(remote, ['init', '--bare']);
        await runGit(repoRoot, ['branch', '-m', 'release/default']);
        await runGit(repoRoot, ['config', '--local', 'init.defaultBranch', 'release/default']);
        await runGit(repoRoot, ['remote', 'add', 'origin', remote]);
        await runGit(repoRoot, ['worktree', 'add', '-b', 'feature', worktree]);
        await runGit(repoRoot, ['push', 'origin', 'release/default', 'feature']);
        const read = async () => (await runWithRealGitScmRuntime(() => readWorktreeStatusEnrichmentForPaths({ worktreePaths: [worktree] })))[0];
        expect(await read()).toMatchObject({ ahead: 0, upstream: null, mergedIntoDefault: true });

        await writeTrackedFile(worktree, 'feature.txt', 'new feature\n');
        await runGit(worktree, ['commit', '-m', 'unpublished feature']);
        expect(await read()).toMatchObject({ ahead: 1, mergedIntoDefault: false });
        await runGit(repoRoot, ['push', 'origin', 'feature']);
        expect(await read()).toMatchObject({ ahead: 0, mergedIntoDefault: false });

        // A real remote default remains authoritative over a different local default.
        await runGit(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature']);
        expect(await read()).toMatchObject({ mergedIntoDefault: true });
    });

    it('keeps the merge fact unknown without a verified configured local default', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-enrich-unknown-default-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const read = async () => (await runWithRealGitScmRuntime(() => readWorktreeStatusEnrichmentForPaths({ worktreePaths: [repoRoot] })))[0];
        // Existing main and the checked-out branch alone are not default evidence.
        expect((await read())?.mergedIntoDefault).toBeUndefined();
        await runGit(repoRoot, ['config', '--local', 'init.defaultBranch', 'missing']);
        expect((await read())?.mergedIntoDefault).toBeUndefined();
        await runGit(repoRoot, ['config', '--local', 'init.defaultBranch', 'HEAD']);
        expect((await read())?.mergedIntoDefault).toBeUndefined();
        await runGit(repoRoot, ['config', '--local', 'init.defaultBranch', 'main~0']);
        expect((await read())?.mergedIntoDefault).toBeUndefined();
    });
});
