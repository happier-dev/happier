import { describe, expect, it } from 'vitest';

import { createPendingDomain } from './pending';

function createHarness(initial: any = {}) {
    let setCalls = 0;
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        setCalls += 1;
        const next = typeof updater === 'function' ? updater(state) : updater;
        if (next === state) return;
        state = { ...state, ...next };
    };

    const domain = createPendingDomain({ get, set } as any);
    return { get, getSetCalls: () => setCalls, domain };
}

describe('pending domain: ordering', () => {
    it('applies pending and discarded refresh projections in one state transition', () => {
        const { get, getSetCalls, domain } = createHarness();
        const pendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'pending',
            rawRecord: { role: 'user', content: { type: 'text', text: 'pending' } } as any,
        };
        const discardedMessage = {
            id: 'd1',
            localId: 'd1',
            createdAt: 3_000,
            updatedAt: 3_000,
            text: 'discarded',
            rawRecord: { role: 'user', content: { type: 'text', text: 'discarded' } } as any,
            discardedAt: 3_100,
            discardedReason: 'manual' as const,
        };

        domain.applyPendingSnapshot('s1', {
            messages: [pendingMessage],
            discarded: [discardedMessage],
        });

        expect(getSetCalls()).toBe(1);
        expect(get().sessionPending.s1).toEqual({
            messages: [pendingMessage],
            discarded: [discardedMessage],
            isLoaded: true,
        });
    });

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

    it('keeps unresolved server pending rows visible even when their localId is committed in the transcript', () => {
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
                id: 'server-p1',
                localId: 'p1',
                source: 'server_pending',
                createdAt: 1_000,
                updatedAt: 1_000,
                text: 'server committed-localId row',
                rawRecord: { role: 'user', content: { type: 'text', text: 'server committed-localId row' } } as any,
            },
            {
                id: 'local-stale-p1',
                localId: 'p1',
                source: 'local_outbound',
                createdAt: 1_500,
                updatedAt: 1_500,
                text: 'local stale projection',
                rawRecord: { role: 'user', content: { type: 'text', text: 'local stale projection' } } as any,
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
            id: 'server-p1',
            localId: 'p1',
            source: 'server_pending',
            createdAt: 4_000,
            updatedAt: 4_000,
            text: 'late server upsert',
            rawRecord: { role: 'user', content: { type: 'text', text: 'late server upsert' } } as any,
        });

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['server-p1', 'queue-p2']);
        expect(get().sessionPending.s1.messages[0].text).toBe('late server upsert');
    });

    it('does not treat recovered history as commit proof when pending arrives later', () => {
        const { get, domain } = createHarness({
            sessionMessages: {
                s1: {
                    messagesById: {
                        history: {
                            id: 'history',
                            kind: 'user-text',
                            localId: 'shared-local',
                            createdAt: 1_000,
                            text: 'recovered history',
                            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
                        },
                    },
                    messagesMap: {},
                },
            },
        });
        const localPending = {
            id: 'pending-live',
            localId: 'shared-local',
            source: 'local_outbound' as const,
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'live pending',
            rawRecord: { role: 'user', content: { type: 'text', text: 'live pending' } } as any,
        };

        domain.applyPendingMessages('s1', [localPending]);

        expect(get().sessionPending.s1.messages).toEqual([localPending]);
    });

    it('preserves state and pending bucket references for equivalent loaded pending refreshes', () => {
        const pendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'first',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first' } } as any,
        };
        const discardedMessage = {
            id: 'd1',
            localId: 'd1',
            createdAt: 3_000,
            updatedAt: 3_000,
            reason: 'replaced',
        } as any;
        const { get, domain } = createHarness({
            sessionPending: {
                s1: {
                    messages: [pendingMessage],
                    discarded: [discardedMessage],
                    isLoaded: true,
                },
            },
        });
        const beforeState = get();
        const beforeBucket = beforeState.sessionPending.s1;
        const beforeMessages = beforeBucket.messages;
        const beforeDiscarded = beforeBucket.discarded;

        domain.applyPendingLoaded('s1');
        domain.applyPendingMessages('s1', [{ ...pendingMessage }]);
        domain.applyDiscardedPendingMessages('s1', [{ ...discardedMessage }]);

        expect(get()).toBe(beforeState);
        expect(get().sessionPending.s1).toBe(beforeBucket);
        expect(get().sessionPending.s1.messages).toBe(beforeMessages);
        expect(get().sessionPending.s1.discarded).toBe(beforeDiscarded);
    });

    it('preserves state references for equivalent upserts and absent removals', () => {
        const pendingMessage = {
            id: 'p1',
            localId: 'p1',
            createdAt: 2_000,
            updatedAt: 2_000,
            text: 'first',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first' } } as any,
        };
        const { get, domain } = createHarness({
            sessionPending: {
                s1: {
                    messages: [pendingMessage],
                    discarded: [],
                    isLoaded: true,
                },
            },
        });
        const beforeState = get();
        const beforeBucket = beforeState.sessionPending.s1;
        const beforeMessages = beforeBucket.messages;

        domain.upsertPendingMessage('s1', { ...pendingMessage });
        domain.removePendingMessage('s1', 'missing');

        expect(get()).toBe(beforeState);
        expect(get().sessionPending.s1).toBe(beforeBucket);
        expect(get().sessionPending.s1.messages).toBe(beforeMessages);
    });
});
