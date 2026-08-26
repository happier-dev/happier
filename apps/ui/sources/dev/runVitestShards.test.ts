import { describe, expect, it } from 'vitest';

import {
    classifyVitestShardTermination,
    partitionVitestFilesIntoShards,
    createVitestShardRunPlan,
    resolveVitestShardConcurrency,
    resolveVitestShardRange,
    resolveVitestShardTimeoutMs,
    runVitestShardRunPlan,
    resolveVitestConfigPath,
    resolveVitestShardCount,
    resolveVitestPassthroughArgs,
    shouldVitestShardRunProceedWithoutFiles,
    summarizeVitestShardOutcomes,
} from '../../scripts/runVitestShards.mjs';

describe('apps/ui runVitestShards', () => {
    it('defaults shard count to 32 so worker result batches stay below the observed RPC timeout boundary', () => {
        expect(resolveVitestShardCount({})).toBe(32);
    });

    it('uses HAPPIER_UI_VITEST_SHARDS override when valid', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '6' })).toBe(6);
    });

    it('ignores invalid shard overrides', () => {
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: '0' })).toBe(32);
        expect(resolveVitestShardCount({ HAPPIER_UI_VITEST_SHARDS: 'nope' })).toBe(32);
    });

    it('partitions the configured shard count into balanced CI parts', () => {
        expect(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '1', HAPPIER_UI_VITEST_PARTS: '4' }, 32))
            .toEqual({ start: 1, end: 8, part: 1, parts: 4 });
        expect(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '4', HAPPIER_UI_VITEST_PARTS: '4' }, 32))
            .toEqual({ start: 25, end: 32, part: 4, parts: 4 });
        expect(resolveVitestShardRange({}, 32)).toEqual({ start: 1, end: 32, part: 1, parts: 1 });
    });

    it('bounds each shard independently', () => {
        expect(resolveVitestShardTimeoutMs({})).toBe(900_000);
        expect(resolveVitestShardTimeoutMs({ HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '120000' })).toBe(120_000);
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGTERM', timedOut: true })).toEqual({
            outcome: 'failed',
            exitCode: 124,
            signal: 'SIGTERM',
            timedOut: true,
        });
    });

    it('defaults shard concurrency to 1', () => {
        expect(resolveVitestShardConcurrency({}, ['node', 'run'])).toBe(1);
    });

    it('uses HAPPIER_UI_VITEST_SHARD_CONCURRENCY override when valid', () => {
        expect(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '3' }, ['node', 'run'])).toBe(
            3,
        );
    });

    it('ignores invalid shard concurrency overrides', () => {
        expect(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '0' }, ['node', 'run'])).toBe(
            1,
        );
        expect(
            resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: 'nope' }, ['node', 'run']),
        ).toBe(1);
    });

    it('allows --concurrency flag to override env', () => {
        expect(
            resolveVitestShardConcurrency(
                { HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '2' },
                ['node', 'run', '--concurrency', '4'],
            ),
        ).toBe(4);
        expect(resolveVitestShardConcurrency({}, ['node', 'run', '--concurrency=5'])).toBe(5);
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

    it('does not forward --concurrency into vitest passthrough args', () => {
        expect(
            resolveVitestPassthroughArgs([
                'node',
                'run',
                '--config',
                'vitest.config.ts',
                '--concurrency',
                '3',
                'sources/dev/runVitestShards.test.ts',
                '--reporter',
                'dot',
            ]),
        ).toEqual(['sources/dev/runVitestShards.test.ts', '--reporter', 'dot']);
    });

    it('partitions files across shards deterministically', () => {
        const buckets = partitionVitestFilesIntoShards(['c', 'a', 'b', 'd', 'e'], 2);
        expect(buckets).toEqual([
            ['a', 'b', 'c'],
            ['d', 'e'],
        ]);
    });

    it('creates a shard run plan skipping empty shards', () => {
        const shardFiles = partitionVitestFilesIntoShards(['c', 'a', 'b', 'd', 'e'], 4);
        const plan = createVitestShardRunPlan({ shardFiles, shardCount: 4 });
        expect(plan.map((entry) => entry.shardSpec)).toEqual(['1/4', '2/4', '3/4', '4/4']);
        expect(plan.map((entry) => entry.files)).toEqual(shardFiles);
    });

    it('creates a plan only for the assigned absolute shard range', () => {
        const shardFiles = partitionVitestFilesIntoShards(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 8);
        const plan = createVitestShardRunPlan({ shardFiles, shardCount: 8, startShard: 5, endShard: 8 });
        expect(plan.map((entry) => entry.shardSpec)).toEqual(['5/8', '6/8', '7/8', '8/8']);
    });

    // REPLACED 2026-08-09. The predecessor asserted `expect(cancels).toEqual(['3/3'])` — it
    // CERTIFIED the defect: one failing shard cancelled the shards still running and the plan
    // returned, so every shard after the first failure was silently skipped and a lane could
    // report green on a run that never executed most of its tests.
    it('runs every shard when one fails, and reports a truthful failing aggregate', async () => {
        const plan = [
            { shardIndex: 1, shardCount: 3, shardSpec: '1/3', files: ['a'] },
            { shardIndex: 2, shardCount: 3, shardSpec: '2/3', files: ['b'] },
            { shardIndex: 3, shardCount: 3, shardSpec: '3/3', files: ['c'] },
        ];

        const starts: string[] = [];
        const cancels: string[] = [];
        const deferred: Array<{ resolve: (value: any) => void }> = [];

        const startShard = (entry: any) => {
            starts.push(entry.shardSpec);
            let resolve!: (value: any) => void;
            const promise = new Promise((r) => {
                resolve = r;
            });
            deferred.push({ resolve });
            return {
                promise,
                cancel: async () => {
                    cancels.push(entry.shardSpec);
                },
            };
        };

        const runPromise = runVitestShardRunPlan({
            plan,
            concurrency: 2,
            startShard,
        });

        // Starts up to concurrency first.
        expect(starts).toEqual(['1/3', '2/3']);

        // Completing shard 1 should allow shard 3 to start.
        deferred[0]!.resolve({ ok: true, code: 0, signal: null });
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(starts).toEqual(['1/3', '2/3', '3/3']);

        // Shard 2 fails. Shard 3 must be left alone to finish and be graded.
        deferred[1]!.resolve({ ok: true, code: 1, signal: null });
        deferred[2]!.resolve({ ok: true, code: 0, signal: null });

        const result = await runPromise;
        expect(cancels).toEqual([]);
        expect(result.code).toBe(1);
        expect(result.outcomes.map((entry: any) => [entry.shardSpec, entry.outcome])).toEqual([
            ['1/3', 'passed'],
            ['2/3', 'failed'],
            ['3/3', 'passed'],
        ]);
    });

    it('stops the plan only when the operator interrupts it', async () => {
        const plan = [
            { shardIndex: 1, shardCount: 2, shardSpec: '1/2', files: ['a'] },
            { shardIndex: 2, shardCount: 2, shardSpec: '2/2', files: ['b'] },
        ];
        const cancels: string[] = [];
        const deferred: Array<{ resolve: (value: any) => void }> = [];
        const startShard = (entry: any) => {
            let resolve!: (value: any) => void;
            const promise = new Promise((r) => {
                resolve = r;
            });
            deferred.push({ resolve });
            return { promise, cancel: async () => { cancels.push(entry.shardSpec); } };
        };

        const runPromise = runVitestShardRunPlan({ plan, concurrency: 2, startShard });
        deferred[0]!.resolve({ ok: true, code: null, signal: 'SIGINT' });
        deferred[1]!.resolve({ ok: true, code: 0, signal: null });

        const result = await runPromise;
        expect(result.code).toBe(130);
        expect(cancels).toEqual(['2/2']);
    });

    it('treats a failed shard as a failure to keep running, and only an operator interrupt as an abort', () => {
        expect(classifyVitestShardTermination({ code: 1, signal: null }).outcome).toBe('failed');
        // A crashed shard (SIGSEGV / SIGABRT / OOM-killer SIGKILL) is the failure mode sharding
        // exists to contain; it is this shard's failure, not a reason to skip the rest.
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGSEGV' }).outcome).toBe('failed');
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGKILL' }).outcome).toBe('failed');
        expect(classifyVitestShardTermination({ code: null, signal: 'SIGINT' })).toEqual({
            outcome: 'aborted',
            exitCode: 130,
            signal: 'SIGINT',
        });
        expect(classifyVitestShardTermination({ code: 0, signal: null }).outcome).toBe('passed');
    });

    it('exits non-zero and names every failing shard in the aggregate', () => {
        const summary = summarizeVitestShardOutcomes({
            shardCount: 4,
            outcomes: [
                { shardSpec: '1/4', outcome: 'passed', exitCode: 0, signal: null },
                { shardSpec: '2/4', outcome: 'failed', exitCode: 1, signal: null },
                { shardSpec: '3/4', outcome: 'passed', exitCode: 0, signal: null },
                { shardSpec: '4/4', outcome: 'failed', exitCode: 1, signal: null },
            ],
        });

        expect(summary.exitCode).toBe(1);
        expect(summary.passedCount).toBe(2);
        expect(summary.failedShards.map((entry: any) => entry.shardSpec)).toEqual(['2/4', '4/4']);
        expect(summary.lines.join('\n')).toContain('2 passed, 2 failed');
        expect(summary.lines.some((line: string) => line.includes('shard 2/4 FAILED'))).toBe(true);
        expect(summary.lines.some((line: string) => line.includes('shard 4/4 FAILED'))).toBe(true);
    });

    it('reports a clean sweep as green', () => {
        const summary = summarizeVitestShardOutcomes({
            shardCount: 2,
            outcomes: [
                { shardSpec: '1/2', outcome: 'passed', exitCode: 0, signal: null },
                { shardSpec: '2/2', outcome: 'passed', exitCode: 0, signal: null },
            ],
        });
        expect(summary.exitCode).toBe(0);
        expect(summary.failedShards).toEqual([]);
    });

    it('refuses to report a zero-file sharded run as green unless --passWithNoTests was asked for', () => {
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 0, passthroughArgs: ['sources/typo'] })).toBe(false);
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 0, passthroughArgs: ['--passWithNoTests'] })).toBe(true);
        expect(shouldVitestShardRunProceedWithoutFiles({ fileCount: 3, passthroughArgs: [] })).toBe(true);
    });
});
