import { describe, expect, it, vi } from 'vitest';

import {
    buildVitestShardRunArgs,
    classifyVitestShardTermination,
    partitionVitestFilesIntoShards,
    resolveVitestConfigPath,
    resolveVitestPositionalFilters,
    resolveVitestShardCount,
    resolveVitestShardRange,
    resolveVitestShardTimeoutMs,
    resolveVitestPassthroughArgs,
    runVitestShardRuns,
    shouldVitestShardRunProceedWithoutFiles,
    summarizeVitestShardOutcomes,
} from '../../scripts/runVitestShards.mjs';

describe('apps/ui runVitestShards', () => {
    it('defaults shard count to 24', () => {
        expect(resolveVitestShardCount({})).toBe(24);
    });

    it('uses HAPPIER_UI_VITEST_SHARDS override when valid', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '6' })).toBe(6);
    });

    it('ignores invalid shard overrides', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '0' })).toBe(24);
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: 'nope' })).toBe(24);
    });

    it('partitions the configured shard count into balanced CI parts', () => {
        expect(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '1', HAPPIER_UI_VITEST_PARTS: '4' }, 24)).toEqual({
            start: 1,
            end: 6,
            part: 1,
            parts: 4,
        });
        expect(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '4', HAPPIER_UI_VITEST_PARTS: '4' }, 24)).toEqual({
            start: 19,
            end: 24,
            part: 4,
            parts: 4,
        });
    });

    it('runs the full shard range when partition inputs are absent or invalid', () => {
        expect(resolveVitestShardRange({}, 24)).toEqual({ start: 1, end: 24, part: 1, parts: 1 });
        expect(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '5', HAPPIER_UI_VITEST_PARTS: '4' }, 24)).toEqual({
            start: 1,
            end: 24,
            part: 1,
            parts: 1,
        });
    });

    it('bounds each shard independently so one wedged process cannot hide later shards', () => {
        expect(resolveVitestShardTimeoutMs({})).toBe(900_000);
        expect(resolveVitestShardTimeoutMs({ HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '120000' })).toBe(120_000);
        expect(resolveVitestShardTimeoutMs({ HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '0' })).toBe(900_000);
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGTERM', timedOut: true })).toEqual({
            outcome: 'failed',
            exitCode: 124,
            signal: 'SIGTERM',
            timedOut: true,
        });
    });

    it('parses --config path from argv', () => {
        expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.config.ts'])).toBe(
            'vitest.config.ts',
        );
    });

    it('returns null when --config is missing', () => {
        expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
    });

    it('preserves additional vitest args after --config', () => {
        expect(
            resolveVitestPassthroughArgs([
                'node',
                'run',
                '--config',
                'vitest.config.ts',
                'sources/dev/runVitestShards.test.ts',
                '--reporter',
                'dot',
            ]),
        ).toEqual(['sources/dev/runVitestShards.test.ts', '--reporter', 'dot']);
    });

    it('partitions files across shards deterministically', () => {
        const buckets = partitionVitestFilesIntoShards(['c', 'a', 'b', 'd', 'e'], 2);
        expect(buckets).toEqual([
            ['a', 'c', 'e'],
            ['b', 'd'],
        ]);
    });

    it('partitions every file exactly once even when shards outnumber files', () => {
        const files = ['e', 'a', 'd', 'b', 'c'];
        const executed = partitionVitestFilesIntoShards(files, 8).flat();
        // No file may be dropped and none may be executed twice.
        expect(executed.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(executed).toHaveLength(files.length);
    });

    it('runs a shard on its own file list without re-adding the caller path filters', () => {
        // Vitest ORs positional filters, so forwarding the caller filter alongside the
        // shard file list makes every shard re-run the whole filtered set.
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: ['sources/components/sessions', '--reporter', 'dot'],
                positionalFilters: ['sources/components/sessions'],
                files: ['/abs/a.test.ts', '/abs/b.test.ts'],
            }),
        ).toEqual([
            'run',
            '--config',
            'vitest.config.ts',
            '--no-file-parallelism',
            '--reporter',
            'dot',
            '/abs/a.test.ts',
            '/abs/b.test.ts',
        ]);
    });

    it('leaves an unfiltered run (the CI lane shape) carrying only its shard files', () => {
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: [],
                positionalFilters: [],
                files: ['/abs/a.test.ts'],
            }),
        ).toEqual(['run', '--config', 'vitest.config.ts', '--no-file-parallelism', '/abs/a.test.ts']);
    });

    it('keeps an option value that is spelled like the dropped path filter', () => {
        expect(
            buildVitestShardRunArgs({
                configPath: 'vitest.config.ts',
                passthroughArgs: ['--testNamePattern', 'sources/x', 'sources/x'],
                positionalFilters: ['sources/x'],
                files: ['/abs/a.test.ts'],
            }),
        ).toEqual([
            'run',
            '--config',
            'vitest.config.ts',
            '--no-file-parallelism',
            '--testNamePattern',
            'sources/x',
            '/abs/a.test.ts',
        ]);
    });

    it('treats a failed shard as a failure to keep running, and only an operator interrupt as an abort', () => {
        // The lane-green claim that shipped the mirror shape came from a sharded run that
        // stopped at the first failing shard: the shards after it never executed and their
        // silence was read as green. A failing shard must therefore never end the run.
        expect(classifyVitestShardTermination({ code: 1, signal: null })).toEqual({
            outcome: 'failed',
            exitCode: 1,
            signal: null,
        });
        // A crashed shard (SIGSEGV / SIGABRT / OOM-killer SIGKILL) is the failure mode sharding
        // exists to contain; it is this shard's failure, not a reason to skip the rest.
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGSEGV' }).outcome).toBe('failed');
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGKILL' }).outcome).toBe('failed');
        // Ctrl-C is the one case where continuing is wrong: the rest would be spawned into it.
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGINT' })).toEqual({
            outcome: 'aborted',
            exitCode: 130,
            signal: 'SIGINT',
        });
        expect(classifyVitestShardTermination({ code: 0, signal: null }).outcome).toBe('passed');
    });

    it('runs later shards after an early shard fails', async () => {
        const runShard = vi.fn()
            .mockResolvedValueOnce({ ok: true, code: 1, signal: null })
            .mockResolvedValueOnce({ ok: true, code: 0, signal: null })
            .mockResolvedValueOnce({ ok: true, code: 0, signal: null });

        const outcomes = await runVitestShardRuns({
            shardFiles: [['/abs/a.test.ts'], ['/abs/b.test.ts'], ['/abs/c.test.ts']],
            runShard,
        });

        expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([1, 2, 3]);
        expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed', 'passed']);
    });

    it('runs later shards after an early shard times out', async () => {
        const runShard = vi.fn()
            .mockResolvedValueOnce({ ok: true, code: null, signal: 'SIGTERM', timedOut: true })
            .mockResolvedValueOnce({ ok: true, code: 0, signal: null });

        const outcomes = await runVitestShardRuns({
            shardFiles: [['/abs/a.test.ts'], ['/abs/b.test.ts']],
            runShard,
        });

        expect(runShard).toHaveBeenCalledTimes(2);
        expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed']);
        expect(summarizeVitestShardOutcomes({ shardCount: 2, outcomes }).lines.join('\n')).toContain('shard 1/2 FAILED (timed out)');
    });

    it('runs only the assigned absolute shard range', async () => {
        const runShard = vi.fn().mockResolvedValue({ ok: true, code: 0, signal: null });
        const shardFiles = Array.from({ length: 8 }, (_value, index) => [`/abs/${index + 1}.test.ts`]);

        const outcomes = await runVitestShardRuns({
            shardFiles,
            startShard: 5,
            endShard: 8,
            runShard,
        });

        expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([5, 6, 7, 8]);
        expect(outcomes.map((entry) => entry.shard)).toEqual([5, 6, 7, 8]);
    });

    it('exits non-zero and names every failing shard when a later shard fails', () => {
        const summary = summarizeVitestShardOutcomes({
            shardCount: 4,
            outcomes: [
                { shard: 1, outcome: 'passed', exitCode: 0, signal: null, fileCount: 3 },
                { shard: 2, outcome: 'failed', exitCode: 1, signal: null, fileCount: 3 },
                { shard: 3, outcome: 'passed', exitCode: 0, signal: null, fileCount: 3 },
                { shard: 4, outcome: 'failed', exitCode: 1, signal: null, fileCount: 2 },
            ],
        });

        expect(summary.exitCode).toBe(1);
        expect(summary.executedCount).toBe(4);
        expect(summary.passedCount).toBe(2);
        expect(summary.failedShards.map((entry) => entry.shard)).toEqual([2, 4]);
        // The aggregate must name the failing shards; a bare non-zero exit hides which ran.
        expect(summary.lines.join('\n')).toContain('2 passed, 2 failed');
        expect(summary.lines.some((line) => line.includes('shard 2/4 FAILED'))).toBe(true);
        expect(summary.lines.some((line) => line.includes('shard 4/4 FAILED'))).toBe(true);
    });

    it('distinguishes the aborted shard, unexecuted shards, and known empty shards', async () => {
        const runShard = vi.fn()
            .mockResolvedValueOnce({ ok: true, code: 0, signal: null })
            .mockResolvedValueOnce({ ok: true, code: null, signal: 'SIGINT' });
        const outcomes = await runVitestShardRuns({
            shardFiles: [
                ['/abs/a.test.ts'],
                ['/abs/b.test.ts'],
                ['/abs/c.test.ts'],
                [],
                ['/abs/d.test.ts'],
            ],
            runShard,
        });
        const summary = summarizeVitestShardOutcomes({
            shardCount: 5,
            outcomes,
        });

        expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([1, 2]);
        expect(outcomes.map((entry) => entry.outcome)).toEqual([
            'passed',
            'aborted',
            'unexecuted',
            'empty',
            'unexecuted',
        ]);
        expect(summary.exitCode).toBe(130);
        expect(summary.executedCount).toBe(2);
        expect(summary.emptyCount).toBe(1);
        expect(summary.unexecutedCount).toBe(2);
        expect(summary.lines.join('\n')).toContain('ABORTED by SIGINT at shard 2/5');
        expect(summary.lines.join('\n')).toContain('1 empty, 2 unexecuted');
    });

    it('refuses to report a zero-file sharded run as green unless --passWithNoTests was asked for', () => {
        // A mistyped path filter resolves to zero files. `vitest run` exits non-zero there; a
        // wrapper that exits 0 turns a typo into a green lane claim.
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 0, passthroughArgs: ['sources/typo'] })).toBe(false);
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 0, passthroughArgs: ['--passWithNoTests'] })).toBe(true);
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 3, passthroughArgs: [] })).toBe(true);
    });

    it('reports a clean sweep as green', () => {
        const summary = summarizeVitestShardOutcomes({
            shardCount: 2,
            outcomes: [
                { shard: 1, outcome: 'passed', exitCode: 0, signal: null, fileCount: 1 },
                { shard: 2, outcome: 'passed', exitCode: 0, signal: null, fileCount: 1 },
            ],
        });

        expect(summary.exitCode).toBe(0);
        expect(summary.failedShards).toEqual([]);
        expect(summary.lines.join('\n')).toContain('2 passed, 0 failed');
    });

    it('classifies positional filters with vitest own CLI parser, not a dash heuristic', async () => {
        await expect(
            resolveVitestPositionalFilters(['--reporter', 'dot', 'sources/a', 'sources/b']),
        ).resolves.toEqual(['sources/a', 'sources/b']);
        // `1` is the value of `--bail`, not a path filter.
        await expect(resolveVitestPositionalFilters(['--bail', '1', 'sources/a'])).resolves.toEqual([
            'sources/a',
        ]);
        await expect(resolveVitestPositionalFilters([])).resolves.toEqual([]);
    });
});
