import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

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

    it('replaces a mounted transcript in one loaded store emission', () => {
        const store = createStore<any>((set, get) => ({
            ...createMessagesDomain({ set, get } as any),
            sessionPending: {},
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
        }));

        store.getState().applyMessages('s1', [{
            id: 'old-message',
            seq: 1,
            localId: null,
            createdAt: 1_000,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'old' },
        } as any]);
        store.getState().applyMessagesLoaded('s1');

        const observed: Array<{ texts: string[]; isLoaded: boolean }> = [];
        const unsubscribe = store.subscribe((state) => {
            const transcript = state.sessionMessages.s1;
            observed.push({
                texts: transcript.messageIdsOldestFirst.flatMap((messageId: string) => {
                    const message = transcript.messagesById[messageId];
                    return message?.kind === 'user-text' ? [message.text] : [];
                }),
                isLoaded: transcript.isLoaded,
            });
        });

        (store.getState() as any).replaceSessionMessages('s1', [{
            id: 'replacement-message',
            seq: 2,
            localId: null,
            createdAt: 2_000,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'replacement' },
        }]);
        unsubscribe();

        expect(observed).toEqual([{
            texts: ['replacement'],
            isLoaded: true,
        }]);
    });
});
