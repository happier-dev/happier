import { describe, expect, it } from 'vitest';

import {
    migrateLegacyPaddedSortKeysToFractional,
    nextSortKeyBetween,
    rebalanceSortKeys,
} from './orderKey';

describe('session folder order keys', () => {
    it('creates sortable keys between sibling bounds', () => {
        const first = nextSortKeyBetween(null, null);
        const second = nextSortKeyBetween(first, null);
        const between = nextSortKeyBetween(first, second);

        expect(first < between).toBe(true);
        expect(between < second).toBe(true);
    });

    it('rebalances long midpoint keys into shorter ordered keys', () => {
        const longA = `a0${'V'.repeat(80)}`;
        const longB = `a0${'W'.repeat(80)}`;
        const rebalanced = rebalanceSortKeys(new Map([
            ['first', longA],
            ['second', longB],
            ['third', `${longB}z`],
        ]));

        const keys = ['first', 'second', 'third'].map((id) => rebalanced.get(id));
        expect(keys.every((key) => typeof key === 'string' && key.length <= 64)).toBe(true);
        expect(keys[0]! < keys[1]!).toBe(true);
        expect(keys[1]! < keys[2]!).toBe(true);
    });

    it('migrates legacy padded sibling keys while preserving their existing order', () => {
        const migrated = migrateLegacyPaddedSortKeysToFractional([
            { id: 'a', sortKey: '000001' },
            { id: 'b', sortKey: '000002' },
            { id: 'c', sortKey: '000003' },
        ]);

        expect([...migrated.keys()]).toEqual(['a', 'b', 'c']);
        expect(migrated.get('a')).not.toBe('000001');
        expect(migrated.get('a')! < migrated.get('b')!).toBe(true);
        expect(migrated.get('b')! < migrated.get('c')!).toBe(true);
    });
});
