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

describe('messages domain: permissionMode inference lifecycle', () => {
    it('does not override session permissionMode from message meta when session metadata has permissionMode', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: { permissionMode: 'yolo', permissionModeUpdatedAt: 100 },
                    permissionMode: 'yolo',
                    permissionModeUpdatedAt: 100,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                localId: null,
                createdAt: 200,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'hi' },
                meta: { permissionMode: 'read-only' },
            } as any,
        ]);

        expect(get().sessions.s1.permissionMode).toBe('yolo');
        expect(get().sessions.s1.permissionModeUpdatedAt).toBe(100);
    });
});
