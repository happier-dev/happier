import { describe, expect, it } from 'vitest';

import { resolvePierreWorkerPoolConfig } from './resolvePierreWorkerPoolConfig';

describe('resolvePierreWorkerPoolConfig', () => {
    it('returns a conservative config for unified diffs', () => {
        expect(resolvePierreWorkerPoolConfig('unified')).toEqual({
            poolSize: 1,
            totalASTLRUCacheSize: 24,
            defaultLineDiffType: 'none',
        });
    });

    it('returns a higher throughput config for split diffs', () => {
        expect(resolvePierreWorkerPoolConfig('split')).toEqual({
            poolSize: 2,
            totalASTLRUCacheSize: 56,
            defaultLineDiffType: 'word-alt',
        });
    });
});
