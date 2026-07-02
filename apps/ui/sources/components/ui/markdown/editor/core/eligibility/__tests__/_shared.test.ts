import { describe, expect, it } from 'vitest';

import { createBoundedFifoCache, hashContent } from '../_shared';

describe('hashContent', () => {
    it('is deterministic for the same input', () => {
        expect(hashContent('hello world')).toBe(hashContent('hello world'));
    });

    it('produces different hashes for different inputs', () => {
        expect(hashContent('a')).not.toBe(hashContent('b'));
    });

    it('returns a base36 string for the empty string', () => {
        const hash = hashContent('');
        expect(typeof hash).toBe('string');
        expect(hash).toMatch(/^[0-9a-z]+$/);
    });

    it('matches the djb2-xor reference for a known input', () => {
        // Reference value computed from the djb2-xor algorithm the editor uses; a
        // change here means the cache-key hashing changed (a behavior change).
        let hash = 5381;
        for (let i = 0; i < 'abc'.length; i += 1) {
            hash = ((hash << 5) + hash) ^ 'abc'.charCodeAt(i);
            hash |= 0;
        }
        const expected = (hash >>> 0).toString(36);
        expect(hashContent('abc')).toBe(expected);
    });
});

describe('createBoundedFifoCache', () => {
    it('stores and retrieves values by key', () => {
        const cache = createBoundedFifoCache<string>(3);
        cache.set('a', '1');
        expect(cache.has('a')).toBe(true);
        expect(cache.get('a')).toBe('1');
    });

    it('returns undefined for a missing key', () => {
        const cache = createBoundedFifoCache<string>(3);
        expect(cache.has('missing')).toBe(false);
        expect(cache.get('missing')).toBeUndefined();
    });

    it('evicts the oldest entry once the bound is exceeded (FIFO)', () => {
        const cache = createBoundedFifoCache<number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3); // evicts 'a'

        expect(cache.has('a')).toBe(false);
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
    });

    it('preserves the cached value reference (identity) across reads', () => {
        const cache = createBoundedFifoCache<{ v: number }>(2);
        const value = { v: 1 };
        cache.set('a', value);
        expect(cache.get('a')).toBe(value);
    });

    it('keeps a re-set key without growing the cache beyond the bound', () => {
        const cache = createBoundedFifoCache<number>(2);
        cache.set('a', 1);
        cache.set('a', 2); // overwrite, not a new slot
        cache.set('b', 3);

        expect(cache.get('a')).toBe(2);
        expect(cache.get('b')).toBe(3);
    });

    it('can store and return null as a distinct cached value', () => {
        const cache = createBoundedFifoCache<string | null>(2);
        cache.set('a', null);
        expect(cache.has('a')).toBe(true);
        expect(cache.get('a')).toBeNull();
    });
});
