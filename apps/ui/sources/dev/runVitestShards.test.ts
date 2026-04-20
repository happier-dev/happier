import { describe, expect, it } from 'vitest';

import {
    partitionVitestFilesIntoShards,
    createVitestShardRunPlan,
    resolveVitestShardConcurrency,
    runVitestShardRunPlan,
    resolveVitestConfigPath,
    resolveVitestShardCount,
    resolveVitestPassthroughArgs,
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

    it('runs shards with bounded concurrency and bails early on first failure', async () => {
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

        // Fail shard 2, which should cancel the remaining running shard (3/3).
        deferred[1]!.resolve({ ok: true, code: 1, signal: null });
        deferred[2]!.resolve({ ok: true, code: 0, signal: null });

        const result = await runPromise;
        expect(result).toEqual({ ok: true, code: 1, signal: null });
        expect(cancels).toEqual(['3/3']);
    });
});
