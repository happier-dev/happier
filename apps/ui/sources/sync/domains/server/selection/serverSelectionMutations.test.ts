import { describe, expect, it } from 'vitest';

import {
    filterServerSelectionGroupsToAvailableServers,
    normalizeStoredServerSelectionGroups,
    toggleServerSelectionGroupServerIdEnsuringNonEmpty,
} from './serverSelectionMutations';

describe('normalizeStoredServerSelectionGroups', () => {
    it('returns empty array for non-array input', () => {
        expect(normalizeStoredServerSelectionGroups(null)).toEqual([]);
        expect(normalizeStoredServerSelectionGroups({})).toEqual([]);
    });

    it('dedupes groups and normalizes fields', () => {
        const normalized = normalizeStoredServerSelectionGroups([
            {
                id: '  group-1 ',
                name: '  My Group ',
                serverIds: [' a ', 'b', 'a', '', '   '],
                presentation: 'flat-with-badge',
            },
            {
                id: 'group-1',
                name: 'ignored duplicate',
                serverIds: ['c'],
                presentation: 'grouped',
            },
        ]);

        expect(normalized).toEqual([
            {
                id: 'group-1',
                name: 'My Group',
                serverIds: ['a', 'b'],
                presentation: 'flat-with-badge',
            },
        ]);
    });
});

describe('filterServerSelectionGroupsToAvailableServers', () => {
    it('filters serverIds to those present in the available set', () => {
        const groups = normalizeStoredServerSelectionGroups([
            { id: 'g1', name: 'G1', serverIds: ['srv-a', 'srv-b', 'missing'], presentation: 'grouped' },
        ]);

        const filtered = filterServerSelectionGroupsToAvailableServers(groups, new Set(['srv-b']));
        expect(filtered).toEqual([
            { id: 'g1', name: 'G1', serverIds: ['srv-b'], presentation: 'grouped' },
        ]);
    });
});

describe('toggleServerSelectionGroupServerIdEnsuringNonEmpty', () => {
    it('prevents removing the last remaining id', () => {
        expect(toggleServerSelectionGroupServerIdEnsuringNonEmpty(['a'], 'a')).toEqual({
            nextServerIds: ['a'],
            preventedEmpty: true,
        });
    });
});
