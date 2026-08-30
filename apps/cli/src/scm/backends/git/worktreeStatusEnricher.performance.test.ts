/**
 * Performance contract tests for `worktreeStatusEnricher`.
 *
 * FR3-13 (audit 2026-05-12): each per-worktree enrichment must run AT MOST ONE
 * `git status --porcelain -z` invocation. The previous implementation read
 * porcelain output twice per worktree (once for `changeCount`, once for the
 * dirty-file mtime walk that feeds `lastActivityAt`), doubling the most
 * expensive part of the enrichment for any large/dirty repository.
 *
 * Strategy: mock `runScmCommand` and assert exact invocation counts for the
 * two git arg-lists the enricher executes (`status --porcelain -z` and
 * `log -1 --format=%ct`). Pure logic verification, no filesystem dependency.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const runScmCommandMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() =>
    vi.fn(async (_path: unknown) => ({
        mtimeMs: 1_700_000_000_000,
        isFile: () => true,
    })),
);

vi.mock('../../runtime', () => ({
    runScmCommand: (...args: unknown[]) => runScmCommandMock(...args),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        stat: (path: unknown) => statMock(path),
    };
});

describe('worktreeStatusEnricher — git invocation budget (FR3-13)', () => {
    afterEach(() => {
        runScmCommandMock.mockReset();
        statMock.mockClear();
    });

    function setupCannedGitResponses(): void {
        // Default behavior:
        // - `git log -1 --format=%ct` returns a HEAD commit timestamp in seconds.
        // - `git status --porcelain -z` returns one modified file so the dirty-file
        //   walk has something to iterate but stays small.
        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => {
            const args = input.args ?? [];
            if (args[0] === 'log') {
                return {
                    success: true,
                    exitCode: 0,
                    stdout: '1700000000',
                    stderr: '',
                    timedOut: false,
                };
            }
            if (args[0] === 'status') {
                return {
                    success: true,
                    exitCode: 0,
                    // One modified file ("M README.md\0") so the dirty-file walk runs at
                    // least once per worktree without exploding the assertion surface.
                    stdout: ' M README.md\0',
                    stderr: '',
                    timedOut: false,
                };
            }
            return {
                success: false,
                exitCode: 1,
                stdout: '',
                stderr: 'unexpected git invocation',
                timedOut: false,
            };
        });
    }

    it('invokes `git status --porcelain -z` exactly once per worktree (not twice)', async () => {
        setupCannedGitResponses();

        const { readWorktreeStatusEnrichmentForPaths } = await import('./worktreeStatusEnricher');

        const paths = ['/repo/wt-1', '/repo/wt-2', '/repo/wt-3', '/repo/wt-4', '/repo/wt-5'];
        const result = await readWorktreeStatusEnrichmentForPaths({ worktreePaths: paths });

        expect(result).toHaveLength(paths.length);

        const calls = runScmCommandMock.mock.calls;
        const statusCalls = calls.filter(([input]) => {
            const args = (input as { args?: readonly string[] }).args ?? [];
            return args[0] === 'status' && args[1] === '--porcelain' && args[2] === '-z';
        });

        // The audit finding: previously this was 2 * paths.length (=10). The
        // contract is one porcelain read per worktree.
        expect(statusCalls).toHaveLength(paths.length);
    });

    it('invokes `git log -1 --format=%ct` at most once per worktree', async () => {
        setupCannedGitResponses();

        const { readWorktreeStatusEnrichmentForPaths } = await import('./worktreeStatusEnricher');

        const paths = ['/repo/wt-1', '/repo/wt-2', '/repo/wt-3', '/repo/wt-4', '/repo/wt-5'];
        await readWorktreeStatusEnrichmentForPaths({ worktreePaths: paths });

        const logCalls = runScmCommandMock.mock.calls.filter(([input]) => {
            const args = (input as { args?: readonly string[] }).args ?? [];
            return args[0] === 'log';
        });

        expect(logCalls.length).toBeLessThanOrEqual(paths.length);
    });

    it('populates both changeCount and lastActivityAt from a single porcelain read', async () => {
        setupCannedGitResponses();

        const { readWorktreeStatusEnrichmentForPaths } = await import('./worktreeStatusEnricher');

        const result = await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: ['/repo/only-one'],
        });

        expect(result).toHaveLength(1);
        // One modified file -> changeCount === 1.
        expect(result[0]?.changeCount).toBe(1);
        // Activity is the max of HEAD time (1.7e12) and the dirty file mtime (1.7e12).
        expect(typeof result[0]?.lastActivityAt).toBe('number');
        expect(result[0]?.lastActivityAt).toBeGreaterThanOrEqual(1_700_000_000_000);

        // Exactly one porcelain read for this single worktree.
        const statusCalls = runScmCommandMock.mock.calls.filter(([input]) => {
            const args = (input as { args?: readonly string[] }).args ?? [];
            return args[0] === 'status';
        });
        expect(statusCalls).toHaveLength(1);
    });

    it('attempts `git status --porcelain` AT MOST ONCE per worktree even when git fails', async () => {
        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => {
            const args = input.args ?? [];
            if (args[0] === 'log') {
                return { success: false, exitCode: 1, stdout: '', stderr: 'no commits', timedOut: false };
            }
            if (args[0] === 'status') {
                return { success: false, exitCode: 1, stdout: '', stderr: 'fatal', timedOut: false };
            }
            return { success: false, exitCode: 1, stdout: '', stderr: 'unexpected', timedOut: false };
        });

        const { readWorktreeStatusEnrichmentForPaths } = await import('./worktreeStatusEnricher');

        const paths = ['/repo/wt-a', '/repo/wt-b'];
        const result = await readWorktreeStatusEnrichmentForPaths({ worktreePaths: paths });

        expect(result).toHaveLength(paths.length);
        for (const entry of result) {
            // `changeCount` must reflect the porcelain failure (undefined). The
            // `lastActivityAt` fallback path that stats the worktree directory is
            // unrelated to FR3-13 and is not asserted here.
            expect(entry.changeCount).toBeUndefined();
        }

        // Each worktree should attempt porcelain AT MOST ONCE even on failure.
        const statusCalls = runScmCommandMock.mock.calls.filter(([input]) => {
            const args = (input as { args?: readonly string[] }).args ?? [];
            return args[0] === 'status';
        });
        expect(statusCalls.length).toBeLessThanOrEqual(paths.length);
    });

    it('omits enrichment deterministically when the process boundary reports a timeout', async () => {
        runScmCommandMock.mockResolvedValue({
            success: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            timedOut: true,
        });

        const { enrichGitWorktreesWithStatus } = await import('./worktreeStatusEnricher');
        const result = await enrichGitWorktreesWithStatus({
            worktrees: [{ path: '/repo/timed-out', branch: 'dev', isCurrent: false, isMain: true }],
            includeWorktreeStatus: true,
            perCallTimeoutMs: 1,
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.changeCount).toBeUndefined();
        expect(result[0]?.lastActivityAt).toBeUndefined();
    });
});
