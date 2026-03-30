import { describe, expect, it } from 'vitest';

import { createPendingDomain } from './pending';

function createHarness(initial: any = {}) {
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

    const domain = createPendingDomain({ get, set } as any);
    return { get, domain };
}

describe('pending domain: ordering', () => {
    it('keeps newly queued pending messages in arrival order even when timestamps regress', () => {
        const { get, domain } = createHarness();

        domain.upsertPendingMessage('s1', {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'first',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first' } } as any,
        });

        domain.upsertPendingMessage('s1', {
            id: 'p2',
            localId: 'p2',
            createdAt: 1_000,
            updatedAt: 1_000,
            text: 'second',
            rawRecord: { role: 'user', content: { type: 'text', text: 'second' } } as any,
        });

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['p1', 'p2']);
    });
});
