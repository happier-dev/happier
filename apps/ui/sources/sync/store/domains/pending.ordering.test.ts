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

    it('does not reintroduce pending rows once their localId is committed in the transcript', () => {
        const { get, domain } = createHarness({
            sessionMessages: {
                s1: {
                    messagesById: {
                        m1: {
                            id: 'm1',
                            kind: 'user-text',
                            localId: 'p1',
                            createdAt: 3_000,
                            text: 'committed',
                        },
                    },
                    messagesMap: {},
                },
            },
        });

        domain.applyPendingMessages('s1', [
            {
                id: 'queue-p1',
                localId: 'p1',
                createdAt: 1_000,
                updatedAt: 1_000,
                text: 'already committed',
                rawRecord: { role: 'user', content: { type: 'text', text: 'already committed' } } as any,
            },
            {
                id: 'queue-p2',
                localId: 'p2',
                createdAt: 2_000,
                updatedAt: 2_000,
                text: 'still pending',
                rawRecord: { role: 'user', content: { type: 'text', text: 'still pending' } } as any,
            },
        ]);
        domain.upsertPendingMessage('s1', {
            id: 'late-queue-p1',
            localId: 'p1',
            createdAt: 4_000,
            updatedAt: 4_000,
            text: 'late stale upsert',
            rawRecord: { role: 'user', content: { type: 'text', text: 'late stale upsert' } } as any,
        });

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['queue-p2']);
    });
});
