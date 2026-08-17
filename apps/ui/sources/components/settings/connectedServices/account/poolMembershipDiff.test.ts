import { describe, expect, it } from 'vitest';

import { computePoolMembershipDiff } from './poolMembershipDiff';

describe('computePoolMembershipDiff', () => {
    it('adds newly selected ids and removes deselected members', () => {
        expect(computePoolMembershipDiff(['work', 'backup'], ['work', 'extra'])).toEqual({
            toAdd: ['extra'],
            toRemove: ['backup'],
        });
    });

    it('reports no change when the selection matches the current members', () => {
        expect(computePoolMembershipDiff(['work', 'backup'], ['backup', 'work'])).toEqual({
            toAdd: [],
            toRemove: [],
        });
    });

    it('is duplicate-safe on both sides', () => {
        expect(computePoolMembershipDiff(['work', 'work'], ['work', 'extra', 'extra'])).toEqual({
            toAdd: ['extra'],
            toRemove: [],
        });
    });

    it('removes everything when the selection is emptied', () => {
        expect(computePoolMembershipDiff(['work', 'backup'], [])).toEqual({
            toAdd: [],
            toRemove: ['work', 'backup'],
        });
    });
});
