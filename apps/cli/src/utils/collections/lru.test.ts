import { describe, expect, it } from 'vitest';

import { LruSet, setBoundedMap } from './lru';

describe('LruSet', () => {
  it('evicts oldest entries when size exceeds max', () => {
    const set = new LruSet(2);
    set.add('a');
    set.add('b');
    set.add('c');
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
  });

  it('refreshes insertion order on re-add', () => {
    const set = new LruSet(2);
    set.add('a');
    set.add('b');
    set.add('a'); // refresh
    set.add('c'); // should evict b
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
  });
});

describe('setBoundedMap', () => {
  it('evicts oldest keys when size exceeds limit', () => {
    const map = new Map<string, number>();
    setBoundedMap(map, 'a', 1, 2);
    setBoundedMap(map, 'b', 2, 2);
    setBoundedMap(map, 'c', 3, 2);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe(2);
    expect(map.get('c')).toBe(3);
  });

  it('refreshes insertion order on overwrite', () => {
    const map = new Map<string, number>();
    setBoundedMap(map, 'a', 1, 2);
    setBoundedMap(map, 'b', 2, 2);
    setBoundedMap(map, 'a', 3, 2);
    setBoundedMap(map, 'c', 4, 2);
    expect(map.has('b')).toBe(false);
    expect(map.get('a')).toBe(3);
    expect(map.get('c')).toBe(4);
  });
});

