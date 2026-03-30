import { describe, expect, it } from 'vitest';

import { LruMap } from './lruMap';

describe('LruMap', () => {
    it('evicts the least recently used entry when exceeding maxEntries', () => {
        const map = new LruMap<string, number>({ maxEntries: 2 });
        map.set('a', 1);
        map.set('b', 2);

        // Touch a so b becomes LRU.
        expect(map.get('a')).toBe(1);

        map.set('c', 3);

        expect(map.get('b')).toBeUndefined();
        expect(map.get('a')).toBe(1);
        expect(map.get('c')).toBe(3);
    });
});

