import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ScmWorktree } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enrichGitWorktreesWithStatus, readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher';

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

async function initRepoWithCommit(prefix: string): Promise<string> {
    const repoRoot = await makeTempDir(prefix);
    await runGit(repoRoot, ['init']);
    await configureGitRepo(repoRoot);
    await runGit(repoRoot, ['branch', '-M', 'main']);
    await writeTrackedFile(repoRoot, 'README.md', 'hello\n');
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function formatTouchTimestamp(date: Date): string {
    // BSD `touch -t [[CC]YY]MMDDhhmm[.SS]`
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    const second = pad2(date.getSeconds());
    return `${year}${month}${day}${hour}${minute}.${second}`;
}

function baseWorktree(path: string, branch: string | null = 'main', isCurrent = true): ScmWorktree {
    return {
        path,
        branch,
        isCurrent,
        isMain: true,
    };
}

describe('enrichGitWorktreesWithStatus', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((c) => c().catch(() => undefined)));
    });

    it('returns the input worktrees unchanged when the opt-in flag is false', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-flag-off-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const worktrees = [baseWorktree(repoRoot)];
        const enriched = await enrichGitWorktreesWithStatus({
            worktrees,
            includeWorktreeStatus: false,
        });

        expect(enriched).toEqual(worktrees);
        expect(enriched[0]?.changeCount).toBeUndefined();
        expect(enriched[0]?.lastActivityAt).toBeUndefined();
    });

    it('returns the input worktrees unchanged when the opt-in flag is undefined', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-flag-undef-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const worktrees = [baseWorktree(repoRoot)];
        const enriched = await enrichGitWorktreesWithStatus({
            worktrees,
            includeWorktreeStatus: undefined,
        });

        expect(enriched).toEqual(worktrees);
    });

    it('populates changeCount and lastActivityAt for a clean worktree when the flag is true', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-clean-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: [baseWorktree(repoRoot)],
            includeWorktreeStatus: true,
        });

        expect(enriched).toHaveLength(1);
        expect(enriched[0]?.changeCount).toBe(0);
        expect(typeof enriched[0]?.lastActivityAt).toBe('number');
        expect(enriched[0]?.lastActivityAt).toBeGreaterThan(0);
    });

    it('counts modified, added, deleted, and untracked entries in changeCount', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-dirty-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        await writeFile(join(repoRoot, 'untracked-1.txt'), 'a\n', 'utf8');
        await writeFile(join(repoRoot, 'untracked-2.txt'), 'b\n', 'utf8');
        await writeFile(join(repoRoot, 'staged.txt'), 'c\n', 'utf8');
        await runGit(repoRoot, ['add', 'staged.txt']);

        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: [baseWorktree(repoRoot)],
            includeWorktreeStatus: true,
        });

        // Modified README + 2 untracked + 1 staged = 4 entries
        expect(enriched[0]?.changeCount).toBe(4);
    });

    it('falls back to undefined per-worktree on a failing git path while preserving the rest of the list', async () => {
        const goodRepo = await initRepoWithCommit('git-enrich-mixed-good-');
        cleanups.push(() => rm(goodRepo, { recursive: true, force: true }));

        const missingPath = join(tmpdir(), 'happier-nonexistent-worktree-target-xxxx');

        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: [
                baseWorktree(goodRepo, 'main', true),
                { path: missingPath, branch: 'feature', isCurrent: false, isMain: false },
            ],
            includeWorktreeStatus: true,
        });

        expect(enriched).toHaveLength(2);
        expect(enriched[0]?.changeCount).toBe(0);
        expect(typeof enriched[0]?.lastActivityAt).toBe('number');
        // Failing worktree gets undefined for both fields, but the list still returns
        expect(enriched[1]?.changeCount).toBeUndefined();
        expect(enriched[1]?.lastActivityAt).toBeUndefined();
    });

    it('respects the concurrency cap (never more than the configured limit run in parallel)', async () => {
        // Create N small repos so we have N worktrees to enrich.
        const repoRoots: string[] = [];
        for (let i = 0; i < 12; i += 1) {
            const repo = await initRepoWithCommit(`git-enrich-conc-${i}-`);
            cleanups.push(() => rm(repo, { recursive: true, force: true }));
            repoRoots.push(repo);
        }

        let inFlight = 0;
        let observedMax = 0;
        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: repoRoots.map((p) => baseWorktree(p, 'main', false)),
            includeWorktreeStatus: true,
            concurrency: 3,
            onPerWorktreeStart: () => {
                inFlight += 1;
                if (inFlight > observedMax) observedMax = inFlight;
            },
            onPerWorktreeFinish: () => {
                inFlight -= 1;
            },
        });

        expect(enriched).toHaveLength(repoRoots.length);
        expect(observedMax).toBeGreaterThan(0);
        expect(observedMax).toBeLessThanOrEqual(3);
    });

    it('reports lastActivityAt greater than the HEAD commit timestamp when a tracked file is modified after the last commit', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-activity-newer-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        // HEAD commit timestamp in ms (git stores in seconds).
        const headSecondsRaw = await runGit(repoRoot, ['log', '-1', '--format=%ct']);
        const headMs = Number.parseInt(headSecondsRaw, 10) * 1000;
        expect(Number.isFinite(headMs)).toBe(true);

        // Force a tracked file's mtime to be strictly newer than HEAD by a known margin.
        const aheadMs = headMs + 60_000;
        const aheadSeconds = aheadMs / 1000;
        const targetPath = join(repoRoot, 'README.md');
        await writeFile(targetPath, 'changed\n', 'utf8');
        await execFile('touch', ['-t', formatTouchTimestamp(new Date(aheadMs)), targetPath]);
        // Sanity: confirm the touch landed.
        const { stat } = await import('node:fs/promises');
        const info = await stat(targetPath);
        expect(Math.floor(info.mtimeMs)).toBeGreaterThanOrEqual(headMs + 30_000);

        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: [baseWorktree(repoRoot)],
            includeWorktreeStatus: true,
        });

        expect(typeof enriched[0]?.lastActivityAt).toBe('number');
        // The reported activity must reflect the newer working-tree mtime, not the HEAD time.
        expect(enriched[0]!.lastActivityAt!).toBeGreaterThan(headMs);
        // Allow a small filesystem-precision tolerance.
        expect(enriched[0]!.lastActivityAt!).toBeGreaterThanOrEqual(Math.floor(aheadSeconds * 1000) - 2000);
    });

    it('counts renamed files as a single change in changeCount', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-rename-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        // Add two extra tracked files so we can rename one of them.
        await writeTrackedFile(repoRoot, 'a.txt', 'aa\n');
        await writeTrackedFile(repoRoot, 'b.txt', 'bb\n');
        await runGit(repoRoot, ['commit', '-m', 'add a/b']);

        // Stage a rename: a.txt → renamed-a.txt.
        await runGit(repoRoot, ['mv', 'a.txt', 'renamed-a.txt']);

        const enriched = await enrichGitWorktreesWithStatus({
            worktrees: [baseWorktree(repoRoot)],
            includeWorktreeStatus: true,
        });

        // Exactly one change: the rename. Not zero, not two.
        expect(enriched[0]?.changeCount).toBe(1);
    });

});

describe('readWorktreeStatusEnrichmentForPaths', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((c) => c().catch(() => undefined)));
    });

    it('returns an empty array when no paths are provided (no git work executed)', async () => {
        let started = 0;
        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [],
            onPerWorktreeStart: () => {
                started += 1;
            },
        });
        expect(result).toEqual([]);
        expect(started).toBe(0);
    });

    it('returns one entry per requested path with changeCount + lastActivityAt for a clean repo', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-paths-clean-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.path).toBe(repoRoot);
        expect(result[0]?.changeCount).toBe(0);
        expect(typeof result[0]?.lastActivityAt).toBe('number');
        expect(result[0]?.lastActivityAt).toBeGreaterThan(0);
    });

    it('counts modified + untracked + staged entries as changeCount', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-paths-dirty-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        await writeFile(join(repoRoot, 'untracked.txt'), 'a\n', 'utf8');
        await writeFile(join(repoRoot, 'staged.txt'), 'c\n', 'utf8');
        await runGit(repoRoot, ['add', 'staged.txt']);

        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
        });

        expect(result[0]?.changeCount).toBe(3);
    });

    it('returns undefined fields per path on failure (missing path) but still emits an entry', async () => {
        const goodRepo = await initRepoWithCommit('git-enrich-paths-mixed-');
        cleanups.push(() => rm(goodRepo, { recursive: true, force: true }));

        const missingPath = join(tmpdir(), 'happier-nonexistent-enrich-target-yyyy');

        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [goodRepo, missingPath],
        });

        expect(result).toHaveLength(2);
        expect(result[0]?.path).toBe(goodRepo);
        expect(result[0]?.changeCount).toBe(0);
        expect(result[1]?.path).toBe(missingPath);
        expect(result[1]?.changeCount).toBeUndefined();
        expect(result[1]?.lastActivityAt).toBeUndefined();
    });

    it('respects the concurrency cap', async () => {
        const repoRoots: string[] = [];
        for (let i = 0; i < 6; i += 1) {
            const repo = await initRepoWithCommit(`git-enrich-paths-conc-${i}-`);
            cleanups.push(() => rm(repo, { recursive: true, force: true }));
            repoRoots.push(repo);
        }

        let inFlight = 0;
        let observedMax = 0;
        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: repoRoots,
            concurrency: 2,
            onPerWorktreeStart: () => {
                inFlight += 1;
                if (inFlight > observedMax) observedMax = inFlight;
            },
            onPerWorktreeFinish: () => {
                inFlight -= 1;
            },
        });

        expect(result).toHaveLength(repoRoots.length);
        expect(observedMax).toBeGreaterThan(0);
        expect(observedMax).toBeLessThanOrEqual(2);
    });

    // ---- FR4-6: dirty-file mtime fan-out must be bounded (cap + concurrency + aggregate budget) ----

    it('FR4-6: caps the dirty-file mtime fan-out at 16 entries per worktree (changeCount is still accurate via porcelain)', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-fr4-6-cap-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        // Add many tracked dirty files to force the scan loop to consider more than the cap.
        const fileCount = 100;
        for (let i = 0; i < fileCount; i += 1) {
            await writeTrackedFile(repoRoot, `f${i}.txt`, 'a\n');
        }
        await runGit(repoRoot, ['commit', '-m', 'seed many files']);
        // Modify ALL of them so porcelain reports them as dirty.
        for (let i = 0; i < fileCount; i += 1) {
            await writeFile(join(repoRoot, `f${i}.txt`), `b${i}\n`, 'utf8');
        }

        const statCallsByPath: string[] = [];
        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
            // Hook directly into the dirty-file stat phase via test instrumentation.
            onDirtyFileStat: (relativePath: string) => {
                statCallsByPath.push(relativePath);
            },
        });

        // changeCount should still reflect ALL dirty files (porcelain counts them, not stat).
        expect(result[0]?.changeCount).toBeGreaterThanOrEqual(fileCount);
        // The stat hook must have been called at least once (proves the bounded loop ran)…
        expect(statCallsByPath.length).toBeGreaterThan(0);
        // …but capped at 16 per the FR4-6 contract.
        expect(statCallsByPath.length).toBeLessThanOrEqual(16);
    });

    it('FR4-6: respects the dirty-file stat concurrency cap of 4 by default', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-fr4-6-conc-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        for (let i = 0; i < 12; i += 1) {
            await writeTrackedFile(repoRoot, `f${i}.txt`, 'a\n');
        }
        await runGit(repoRoot, ['commit', '-m', 'seed']);
        for (let i = 0; i < 12; i += 1) {
            await writeFile(join(repoRoot, `f${i}.txt`), `b${i}\n`, 'utf8');
        }

        let inFlight = 0;
        let observedMax = 0;
        await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
            onDirtyFileStatStart: () => {
                inFlight += 1;
                if (inFlight > observedMax) observedMax = inFlight;
            },
            onDirtyFileStatFinish: () => {
                inFlight -= 1;
            },
        });

        expect(observedMax).toBeGreaterThan(0);
        // The default concurrency cap is 4.
        expect(observedMax).toBeLessThanOrEqual(4);
    });

    it('FR4-6: aborts the dirty-file scan once the aggregate stat budget is exceeded', async () => {
        const repoRoot = await initRepoWithCommit('git-enrich-fr4-6-budget-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

        for (let i = 0; i < 16; i += 1) {
            await writeTrackedFile(repoRoot, `f${i}.txt`, 'a\n');
        }
        await runGit(repoRoot, ['commit', '-m', 'seed']);
        for (let i = 0; i < 16; i += 1) {
            await writeFile(join(repoRoot, `f${i}.txt`), `b${i}\n`, 'utf8');
        }

        const statCalls: string[] = [];
        // Synthetic 0ms budget forces an immediate abort after the first batch.
        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
            dirtyFileStatBudgetMs: 0,
            onDirtyFileStat: (rel: string) => {
                statCalls.push(rel);
            },
        });

        // changeCount still comes from porcelain (one cheap git call) so the count is accurate.
        expect(result[0]?.changeCount).toBe(16);
        // Budget abort means we observed at most one concurrency batch (<=4).
        expect(statCalls.length).toBeLessThanOrEqual(4);
    });
});

describe('readWorktreeStatusEnrichmentForPaths — basic order', () => {
    const orderCleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        await Promise.all(orderCleanups.map((c) => c().catch(() => undefined)));
        orderCleanups.length = 0;
    });

    it('preserves the order of input paths in the response', async () => {
        const a = await initRepoWithCommit('git-enrich-paths-order-a-');
        const b = await initRepoWithCommit('git-enrich-paths-order-b-');
        const c = await initRepoWithCommit('git-enrich-paths-order-c-');
        orderCleanups.push(() => rm(a, { recursive: true, force: true }));
        orderCleanups.push(() => rm(b, { recursive: true, force: true }));
        orderCleanups.push(() => rm(c, { recursive: true, force: true }));

        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [b, a, c],
        });

        expect(result.map((e) => e.path)).toEqual([b, a, c]);
    });
});
