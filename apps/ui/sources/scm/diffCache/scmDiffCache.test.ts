import { describe, expect, it, vi } from 'vitest';

import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

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
    it('does not copy the repository signature into every file lookup key', async () => {
        const cache = new ScmDiffCache({ maxEntries: 30, maxTotalBytes: 10_000, now: () => 1 });
        const signature = JSON.stringify(Array.from({ length: 59_448 }, (_, index) => `rows/row${index}.txt`));
        // Observe real Map lookups without replacing cache decisions. A new
        // composite string makes hashing work proportional to repository × files.
        const lookups = vi.spyOn(Map.prototype, 'get');
        let copiedSignatureLookups: number;
        try {
            for (let index = 0; index < 23; index++) {
                const input = key({ path: `rows/row${index}.txt`, sig: signature });
                await cache.getOrLoad(input, async () => ({ success: true, diff: 'held body' }));
                cache.get(input);
            }
            copiedSignatureLookups = lookups.mock.calls.filter(([value]) =>
                typeof value === 'string' && value.length > signature.length && value.includes(signature)).length;
        } finally { lookups.mockRestore(); }
        expect(copiedSignatureLookups).toBe(0);
    });

    it('shares equivalent concurrent loads and cached results, with freshness and scope isolation', async () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1 });
        let finish!: (value: { success: true; diff: string }) => void;
        let loads = 0;
        const load = () => { loads++; return new Promise<{ success: true; diff: string }>((resolve) => { finish = resolve; }); };
        const first = cache.getOrLoad(key({ path: 'a.ts' }), load);
        const second = cache.getOrLoad(key({ path: 'a.ts' }), load);
        expect(loads).toBe(1);
        finish({ success: true, diff: 'first' });
        expect(await first).toEqual(await second);
        expect(await cache.getOrLoad(key({ path: 'a.ts' }), load)).toEqual({ success: true, diff: 'first' });
        expect(loads).toBe(1);
        for (const next of [key({ path: 'a.ts', sig: 'sig2' }), key({ path: 'a.ts', sessionId: 's2' }), key({ path: 'a.ts', area: 'included' })]) {
            expect(await cache.getOrLoad(next, async () => ({ success: true, diff: 'fresh' }))).toEqual({ success: true, diff: 'fresh' });
        }
    });

    it('does not resurrect an invalidated pending diff or retain failures', async () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1 });
        let finish!: (value: { success: true; diff: string }) => void;
        const pending = cache.getOrLoad(key({ path: 'a.ts' }), () => new Promise((resolve) => { finish = resolve; }));
        cache.invalidatePaths({ sessionId: 's1', paths: new Set(['a.ts']) });
        finish({ success: true, diff: 'stale' });
        await pending;
        expect(cache.get(key({ path: 'a.ts' }))).toBeNull();
        await expect(cache.getOrLoad(key({ path: 'a.ts' }), async () => { throw new Error('offline'); })).rejects.toThrow('offline');
        expect(await cache.getOrLoad(key({ path: 'a.ts' }), async () => ({ success: true, diff: 'recovered' }))).toEqual({ success: true, diff: 'recovered' });
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
