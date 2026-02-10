import { describe, expect, it } from 'vitest';

import {
    filterMultiServerGroupProfilesToAvailable,
    normalizeStoredMultiServerGroupProfiles,
    toggleMultiServerGroupServerIdEnsuringNonEmpty,
} from './multiServerGroups';

describe('normalizeStoredMultiServerGroupProfiles', () => {
    it('returns empty array for non-array input', () => {
        expect(normalizeStoredMultiServerGroupProfiles(null)).toEqual([]);
        expect(normalizeStoredMultiServerGroupProfiles({})).toEqual([]);
        expect(normalizeStoredMultiServerGroupProfiles('nope')).toEqual([]);
    });

    it('dedupes profiles by id and normalizes fields without filtering by availability', () => {
        const normalized = normalizeStoredMultiServerGroupProfiles([
            {
                id: '  group-1 ',
                name: '  My Group ',
                serverIds: [' a ', 'b', 'a', '', '   '],
                presentation: 'flat-with-badge',
            },
            {
                id: 'group-1',
                name: 'should be ignored due to duplicate id',
                serverIds: ['c'],
                presentation: 'grouped',
            },
            {
                id: 'group-2',
                name: 'Two',
                serverIds: ['cloud', 'localhost-3013'],
                // invalid presentation falls back
                presentation: 'nope',
            },
        ]);

        expect(normalized).toEqual([
            {
                id: 'group-1',
                name: 'My Group',
                serverIds: ['a', 'b'],
                presentation: 'flat-with-badge',
            },
            {
                id: 'group-2',
                name: 'Two',
                serverIds: ['cloud', 'localhost-3013'],
                presentation: 'grouped',
            },
        ]);
    });
});

describe('filterMultiServerGroupProfilesToAvailable', () => {
    it('filters serverIds to those present in the available set', () => {
        const profiles = normalizeStoredMultiServerGroupProfiles([
            { id: 'g1', name: 'G1', serverIds: ['cloud', 'localhost-3013', 'missing'], presentation: 'grouped' },
        ]);

        const filtered = filterMultiServerGroupProfilesToAvailable(profiles, new Set(['localhost-3013']));
        expect(filtered).toEqual([
            { id: 'g1', name: 'G1', serverIds: ['localhost-3013'], presentation: 'grouped' },
        ]);
    });

    it('does not filter when the available set is empty (treat as unknown/uninitialized)', () => {
        const profiles = normalizeStoredMultiServerGroupProfiles([
            { id: 'g1', name: 'G1', serverIds: ['cloud'], presentation: 'grouped' },
        ]);

        const filtered = filterMultiServerGroupProfilesToAvailable(profiles, new Set());
        expect(filtered).toEqual([
            { id: 'g1', name: 'G1', serverIds: ['cloud'], presentation: 'grouped' },
        ]);
    });

    it('keeps profiles even when none of their serverIds are in the available set', () => {
        const profiles = normalizeStoredMultiServerGroupProfiles([
            { id: 'g1', name: 'G1', serverIds: ['cloud'], presentation: 'grouped' },
        ]);

        const filtered = filterMultiServerGroupProfilesToAvailable(profiles, new Set(['localhost-3013']));
        expect(filtered).toEqual([
            { id: 'g1', name: 'G1', serverIds: [], presentation: 'grouped' },
        ]);
    });
});

describe('toggleMultiServerGroupServerIdEnsuringNonEmpty', () => {
    it('adds an id when not present', () => {
        expect(toggleMultiServerGroupServerIdEnsuringNonEmpty([], 'a')).toEqual({
            nextServerIds: ['a'],
            preventedEmpty: false,
        });
    });

    it('removes an id when present (if more than one)', () => {
        expect(toggleMultiServerGroupServerIdEnsuringNonEmpty(['a', 'b'], 'a')).toEqual({
            nextServerIds: ['b'],
            preventedEmpty: false,
        });
    });

    it('prevents removing the last remaining id', () => {
        expect(toggleMultiServerGroupServerIdEnsuringNonEmpty(['a'], 'a')).toEqual({
            nextServerIds: ['a'],
            preventedEmpty: true,
        });
    });

    it('normalizes ids by trimming and de-duping', () => {
        expect(toggleMultiServerGroupServerIdEnsuringNonEmpty([' a ', 'b', 'a'], ' b ')).toEqual({
            nextServerIds: ['a'],
            preventedEmpty: false,
        });
    });
});
