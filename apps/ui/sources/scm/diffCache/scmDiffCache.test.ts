import { describe, expect, it } from 'vitest';

import type { ScmDiffArea } from '@happier-dev/protocol';

import { ScmDiffCache } from './scmDiffCache';

function key(input: { sessionId?: string; sig?: string; area?: ScmDiffArea; path: string }) {
    return {
        sessionId: input.sessionId ?? 's1',
        snapshotSignature: input.sig ?? 'sig1',
        diffArea: input.area ?? 'pending',
        path: input.path,
    } as const;
}

describe('ScmDiffCache', () => {
    it('stores and retrieves diffs by session/signature/area/path', () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });
        cache.set(key({ path: 'a.ts' }), 'diff-a');
        expect(cache.get(key({ path: 'a.ts' }))?.diff).toBe('diff-a');
        expect(cache.get(key({ path: 'b.ts' }))).toBeNull();
    });

    it('evicts least-recently-used entries when exceeding maxEntries', () => {
        const cache = new ScmDiffCache({ maxEntries: 2, maxTotalBytes: 10_000, now: () => 1_000 });
        cache.set(key({ path: 'a.ts' }), 'a');
        cache.set(key({ path: 'b.ts' }), 'b');
        // Touch a.ts so b.ts becomes LRU.
        expect(cache.get(key({ path: 'a.ts' }))?.diff).toBe('a');
        cache.set(key({ path: 'c.ts' }), 'c');

        expect(cache.get(key({ path: 'b.ts' }))).toBeNull();
        expect(cache.get(key({ path: 'a.ts' }))?.diff).toBe('a');
        expect(cache.get(key({ path: 'c.ts' }))?.diff).toBe('c');
    });

    it('invalidates all entries for a session and specific paths', () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });
        cache.set(key({ sessionId: 's1', path: 'a.ts' }), 'a');
        cache.set(key({ sessionId: 's1', path: 'b.ts' }), 'b');
        cache.set(key({ sessionId: 's2', path: 'a.ts' }), 'a2');

        cache.invalidatePaths({ sessionId: 's1', paths: new Set(['a.ts']) });
        expect(cache.get(key({ sessionId: 's1', path: 'a.ts' }))).toBeNull();
        expect(cache.get(key({ sessionId: 's1', path: 'b.ts' }))?.diff).toBe('b');
        expect(cache.get(key({ sessionId: 's2', path: 'a.ts' }))?.diff).toBe('a2');

        cache.invalidateSession('s1');
        expect(cache.get(key({ sessionId: 's1', path: 'b.ts' }))).toBeNull();
        expect(cache.get(key({ sessionId: 's2', path: 'a.ts' }))?.diff).toBe('a2');
    });

    it('evicts entries when limits are lowered after storing', () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });
        cache.set(key({ path: 'a.ts' }), 'a');
        cache.set(key({ path: 'b.ts' }), 'b');
        cache.set(key({ path: 'c.ts' }), 'c');

        cache.setLimits({ maxEntries: 2, maxTotalBytes: 10_000 });
        expect(cache.get(key({ path: 'a.ts' }))).toBeNull();
        expect(cache.get(key({ path: 'b.ts' }))?.diff).toBe('b');
        expect(cache.get(key({ path: 'c.ts' }))?.diff).toBe('c');
    });
});
