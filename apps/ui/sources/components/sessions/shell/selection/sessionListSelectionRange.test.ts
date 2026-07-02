import { describe, expect, it } from 'vitest';

import { resolveSessionListSelectionRange } from './sessionListSelectionRange';

describe('resolveSessionListSelectionRange', () => {
    const visibleKeys = ['a', 'b', 'c', 'd'];

    it('resolves forward and backward inclusive ranges over visible session keys', () => {
        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'b',
            targetKey: 'd',
        })).toEqual(['b', 'c', 'd']);

        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'd',
            targetKey: 'b',
        })).toEqual(['b', 'c', 'd']);
    });

    it('falls back to the target when the anchor is missing', () => {
        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'missing',
            targetKey: 'c',
        })).toEqual(['c']);
    });

    it('filters ineligible keys from the resolved span', () => {
        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'a',
            targetKey: 'd',
            eligibleKeys: new Set(['a', 'c', 'd']),
        })).toEqual(['a', 'c', 'd']);
    });

    it('returns an empty range when the target is not visible or eligible', () => {
        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'a',
            targetKey: 'missing',
        })).toEqual([]);

        expect(resolveSessionListSelectionRange({
            visibleOrderedKeys: visibleKeys,
            anchorKey: 'a',
            targetKey: 'b',
            eligibleKeys: new Set(['a']),
        })).toEqual([]);
    });
});
