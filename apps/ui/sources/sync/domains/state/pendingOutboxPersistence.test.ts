import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
        getAllKeys() { return [...store.keys()]; }
        clearAll() { store.clear(); }
    }
    return { MMKV };
});

import {
    listPendingOutboxSessionIds,
    loadPendingOutboxForSession,
    markPendingOutboxMessageCancelRequested,
    savePendingOutboxMessage,
} from './pendingOutboxPersistence';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function plainRequest(localId: string): { v: 1; body: string } {
    return {
        v: 1,
        body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
    };
}

describe('pending outbox persistence', () => {
    beforeEach(() => store.clear());

    it('enumerates only the session ids with durable custody in the requested server-account scope', () => {
        const otherScope = { serverId: scope.serverId, accountId: 'account-b' } as const;
        const save = (sessionId: string, localId: string, outboxScope: ServerAccountScope) => {
            savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 100,
                text: localId,
                rawRecord: { role: 'user' },
                request: plainRequest(localId),
            }, outboxScope);
        };
        save('session-b', 'local-b', scope);
        save('session-a', 'local-a', scope);
        save('other-account-session', 'other-local', otherScope);

        expect(listPendingOutboxSessionIds(scope)).toEqual(['session-a', 'session-b']);
        expect(listPendingOutboxSessionIds(otherScope)).toEqual(['other-account-session']);
    });

    it('durably changes an ambiguous enqueue into a cancellation without replacing its request envelope', () => {
        const original = savePendingOutboxMessage({
            sessionId: 's1',
            localId: 'cancel-me',
            createdAt: 100,
            text: 'hello',
            rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
            request: plainRequest('cancel-me'),
        }, scope);

        expect(markPendingOutboxMessageCancelRequested('s1', 'cancel-me', scope)).toEqual({
            ...original,
            operation: 'cancel',
        });
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId: 'cancel-me',
                operation: 'cancel',
                request: original.request,
            }),
        ]);
    });

    it('accepts an absent legacy operation as enqueue and quarantines an explicit unknown operation across later writes', () => {
        savePendingOutboxMessage({
            sessionId: 's1', localId: 'legacy', createdAt: 1, text: 'legacy',
            rawRecord: { role: 'user', content: { type: 'text', text: 'legacy' } },
            request: plainRequest('legacy'),
        }, scope);
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized) as Record<string, Array<Record<string, unknown>>>;
        delete persisted.s1![0]!.operation;
        store.set(key, JSON.stringify(persisted));
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ localId: 'legacy', operation: 'enqueue' }),
        ]);

        persisted.s1![0]!.operation = 'future-operation';
        store.set(key, JSON.stringify(persisted));
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId: 'legacy',
                operation: 'quarantined',
                quarantineReason: 'unsupported_persisted_operation',
            }),
        ]);

        savePendingOutboxMessage({
            sessionId: 's1', localId: 'later-valid', createdAt: 2, text: 'later',
            rawRecord: { role: 'user', content: { type: 'text', text: 'later' } },
            request: plainRequest('later-valid'),
        }, scope);
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId: 'legacy',
                operation: 'quarantined',
                quarantineReason: 'unsupported_persisted_operation',
            }),
            expect.objectContaining({ localId: 'later-valid', operation: 'enqueue' }),
        ]);
    });

    it.each(['.', '..'])('rejects new dot-segment local IDs but quarantines persisted custody across later writes (%s)', (localId) => {
        expect(() => savePendingOutboxMessage({
            sessionId: 's1', localId, createdAt: 1, text: 'invalid',
            rawRecord: { role: 'user', content: { type: 'text', text: 'invalid' } },
            request: plainRequest(localId),
        }, scope)).toThrow('Pending message ID is invalid');

        savePendingOutboxMessage({
            sessionId: 's1', localId: 'valid', createdAt: 1, text: 'valid',
            rawRecord: { role: 'user', content: { type: 'text', text: 'valid' } },
            request: plainRequest('valid'),
        }, scope);
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized) as Record<string, Array<Record<string, unknown>>>;
        persisted.s1![0]!.localId = localId;
        persisted.s1![0]!.request = plainRequest(localId);
        store.set(key, JSON.stringify(persisted));

        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({
                localId,
                operation: 'quarantined',
                quarantineReason: 'invalid_persisted_local_id',
            }),
        ]);

        savePendingOutboxMessage({
            sessionId: 's1', localId: 'later-valid', createdAt: 2, text: 'later',
            rawRecord: { role: 'user', content: { type: 'text', text: 'later' } },
            request: plainRequest('later-valid'),
        }, scope);
        expect(loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ localId, quarantineReason: 'invalid_persisted_local_id' }),
            expect.objectContaining({ localId: 'later-valid', operation: 'enqueue' }),
        ]);
    });

});
