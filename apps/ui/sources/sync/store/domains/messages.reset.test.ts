import { describe, expect, it } from 'vitest';

import { createMessagesDomain } from './messages';

function createHarness(initial: any) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

describe('messages domain: resetSessionMessages', () => {
    it('clears messages and marks transcript not loaded', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'hello' },
            } as any,
        ]);
        domain.applyMessagesLoaded('s1');

        expect(get().sessionMessages.s1.isLoaded).toBe(true);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toHaveLength(1);
        expect(Object.keys(get().sessionMessages.s1.messagesById)).toHaveLength(1);

        domain.resetSessionMessages('s1');

        expect(get().sessionMessages.s1.isLoaded).toBe(false);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toHaveLength(0);
        expect(Object.keys(get().sessionMessages.s1.messagesById)).toHaveLength(0);
    });
});
