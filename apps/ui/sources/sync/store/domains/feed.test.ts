import { describe, expect, it } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import { createFeedDomain } from './feed';

type State = ReturnType<typeof createFeedDomain> & { friendsLoaded: boolean };

function createHarness(): { get: () => State } {
    let state = {
        friendsLoaded: true,
    } as State;
    const get = () => state;
    const set = (updater: (draft: State) => State) => {
        state = updater(state);
    };
    state = { ...state, ...createFeedDomain({ get, set } as any) };
    return { get };
}

function feedItem(id: number) {
    return {
        id: `feed-${id}`,
        cursor: `fc${id}`,
        counter: id,
        createdAt: id,
        updatedAt: id,
    } as any;
}

describe('createFeedDomain retention', () => {
    it('retains only the bounded newest feed items', () => {
        const { get } = createHarness();
        const max = loadSyncTuning().feedItemsMaxEntries;

        get().applyFeedItems(Array.from({ length: max + 5 }, (_, index) => feedItem(index + 1)));

        expect(get().feedItems).toHaveLength(max);
        expect(get().feedItems[0]?.id).toBe(`feed-${max + 5}`);
        expect(get().feedItems.at(-1)?.id).toBe('feed-6');
        expect(get().feedTail).toBe('fc6');
    });
});
