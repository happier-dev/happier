import { describe, expect, it } from 'vitest';

import { resolveSessionListOrderingPersistenceState } from './resolveSessionListOrderingPersistenceState';

describe('resolveSessionListOrderingPersistenceState', () => {
    it('normalizes missing or invalid ordering state to empty canonical collections', () => {
        expect(resolveSessionListOrderingPersistenceState({
            pinnedSessionKeysV1: null,
            sessionListGroupOrderV1: null,
        })).toEqual({
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            currentGroupOrderMap: {},
        });
    });

    it('reuses the pinned order array and group order object when they are valid', () => {
        const pinnedKeyList = ['server_a:sess_a', 'server_a:sess_b'];
        const currentGroupOrderMap = {
            'server:server_a:active': ['server_a:sess_b', 'server_a:sess_a'],
        };

        const state = resolveSessionListOrderingPersistenceState({
            pinnedSessionKeysV1: pinnedKeyList,
            sessionListGroupOrderV1: currentGroupOrderMap,
        });

        expect(state.pinnedKeyList).toBe(pinnedKeyList);
        expect(state.currentGroupOrderMap).toBe(currentGroupOrderMap);
        expect(state.pinnedKeySet).toEqual(new Set(pinnedKeyList));
    });
});
