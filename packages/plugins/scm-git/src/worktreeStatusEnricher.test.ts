import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithGitScmCommandRunner, runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';
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

    it('bounds dirty-file mtime scans while preserving porcelain changeCount', async () => {
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

        const statCalls: string[] = [];
        const result = await runWithRealGitScmRuntime(() => readWorktreeStatusEnrichmentForPaths({
            worktreePaths: [repoRoot],
            dirtyFileStatBudgetMs: 0,
            onDirtyFileStat: (relativePath) => {
                statCalls.push(relativePath);
            },
        }));

        expect(result[0]?.changeCount).toBe(fileCount);
        expect(statCalls.length).toBeLessThanOrEqual(4);
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
});
