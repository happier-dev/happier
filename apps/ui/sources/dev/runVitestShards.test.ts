import { describe, expect, it } from 'vitest';

import {
    partitionVitestFilesIntoShards,
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
});
