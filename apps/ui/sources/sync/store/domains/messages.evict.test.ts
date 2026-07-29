import { afterEach, describe, expect, it } from 'vitest';

import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';

import { createMessagesDomain } from './messages';

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

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function buildSessionRow(sessionId: string) {
    return {
        id: sessionId,
        createdAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        metadata: null,
        permissionMode: null,
        permissionModeUpdatedAt: 0,
    };
}

function userMessage(id: string, seq: number, text: string) {
    return {
        id,
        seq,
        localId: null,
        createdAt: 1000 + seq,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text },
    } as any;
}

describe('messages domain: evictSessionMessages', () => {
    const unregisterFns: Array<() => void> = [];

    afterEach(() => {
        while (unregisterFns.length > 0) {
            unregisterFns.pop()?.();
        }
    });

    it('removes the sessionMessages entry entirely so a re-open follows the first-open load pipeline', () => {
        const { get, domain } = createHarness({
            sessions: { s1: buildSessionRow('s1'), s2: buildSessionRow('s2') },
        });

        domain.applyMessages('s1', [userMessage('m1', 1, 'hello')]);
        domain.applyMessagesLoaded('s1');
        domain.applyMessages('s2', [userMessage('m2', 1, 'other')]);
        domain.applyMessagesLoaded('s2');

        expect(get().sessionMessages.s1.isLoaded).toBe(true);

        domain.evictSessionMessages('s1');

        // Entry is gone entirely (transcript, reducerState, aggregate), not reset-in-place.
        expect(get().sessionMessages.s1).toBeUndefined();
        // Other sessions keep their entries (referentially untouched).
        expect(get().sessionMessages.s2.isLoaded).toBe(true);
        expect(Object.keys(get().sessionMessages.s2.messagesById)).toHaveLength(1);

        // Re-opening behaves like a first open: not loaded until the pipeline marks it.
        expect(get().sessionMessages.s1?.isLoaded).not.toBe(true);
        domain.applyMessagesLoaded('s1');
        expect(get().sessionMessages.s1.isLoaded).toBe(true);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toEqual([]);
    });

    it('clears per-session derived transcript caches through the shared release seam', () => {
        const cleared: string[] = [];
        unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cleared.push(sessionId);
        }));

        const { domain } = createHarness({ sessions: { s1: buildSessionRow('s1') } });
        domain.applyMessages('s1', [userMessage('m1', 1, 'hello')]);
        domain.applyMessagesLoaded('s1');

        domain.evictSessionMessages('s1');
        expect(cleared).toEqual(['s1']);
    });

    it('is a no-op for sessions without a hydrated entry', () => {
        const cleared: string[] = [];
        unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cleared.push(sessionId);
        }));

        const { get, domain } = createHarness();
        const before = get().sessionMessages;

        domain.evictSessionMessages('missing');

        expect(get().sessionMessages).toBe(before);
        expect(cleared).toEqual([]);
    });
});
