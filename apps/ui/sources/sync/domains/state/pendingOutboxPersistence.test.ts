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

    it('quarantines a malformed persisted target instead of replaying it as main', async () => {
        await savePendingOutboxMessage({
            sessionId: 's1', localId: 'target', createdAt: 1, text: 'private run input',
            rawRecord: { role: 'user' }, request: plainRequest('target'),
        }, scope);
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized);
        persisted.s1[0].request.recipient = { kind: 'execution_run', runId: '' };
        store.set(key, JSON.stringify(persisted));
        expect(await loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ operation: 'quarantined', quarantineReason: 'invalid_persisted_envelope' }),
        ]);
    });

    it('preserves the strict target operation through cancellation and rejects a different target for the same identity', async () => {
        const message = {
            sessionId: 's1', localId: 'run-input', createdAt: 1, text: 'run input', rawRecord: { role: 'user' },
            request: {
                v: 1 as const,
                recipient: { kind: 'execution_run' as const, runId: 'run-a' },
                body: JSON.stringify({
                    v: 1, localId: 'run-input', targetMachineId: 'machine-a',
                    content: { t: 'plain', v: { role: 'user' } }, messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        };
        await savePendingOutboxMessage(message, scope);
        await markPendingOutboxMessageCancelRequested('s1', 'run-input', scope);
        expect(await loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ operation: 'cancel', request: message.request }),
        ]);
        await expect(savePendingOutboxMessage({
            ...message,
            request: { ...message.request, recipient: { kind: 'execution_run', runId: 'run-b' } },
        }, scope)).rejects.toMatchObject({ code: 'session_input_idempotency_conflict' });
    });

    it('preserves ordinary Machine placement through cancellation and quarantines a malformed known target', async () => {
        const request = { v: 1 as const, body: JSON.stringify({ localId: 'ordinary-target',
            targetMachineId: 'selected-machine', content: { t: 'plain', v: { role: 'user' } }, messageRole: 'user' }) };
        await savePendingOutboxMessage({ sessionId: 's1', localId: 'ordinary-target', createdAt: 1,
            text: 'ordinary input', rawRecord: { role: 'user' }, request }, scope);
        await markPendingOutboxMessageCancelRequested('s1', 'ordinary-target', scope);
        expect(await loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ operation: 'cancel', request }),
        ]);
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized) as Record<string, Array<{ request: { body: string } }>>;
        persisted.s1![0]!.request.body = JSON.stringify({ localId: 'ordinary-target',
            targetMachineId: ' ', content: { t: 'plain', v: {} }, messageRole: 'user' });
        store.set(key, JSON.stringify(persisted));
        expect(await loadPendingOutboxForSession('s1', scope)).toEqual([
            expect.objectContaining({ operation: 'quarantined', quarantineReason: 'invalid_persisted_envelope' }),
        ]);
    });

    it('enumerates only the session ids with durable custody in the requested server-account scope', async () => {
        const otherScope = { serverId: scope.serverId, accountId: 'account-b' } as const;
        const save = async (sessionId: string, localId: string, outboxScope: ServerAccountScope) => {
            (await savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 100,
                text: localId,
                rawRecord: { role: 'user' },
                request: plainRequest(localId),
            }, outboxScope));
        };
        (await save('session-b', 'local-b', scope));
        (await save('session-a', 'local-a', scope));
        (await save('other-account-session', 'other-local', otherScope));

        expect((await listPendingOutboxSessionIds(scope))).toEqual(['session-a', 'session-b']);
        expect((await listPendingOutboxSessionIds(otherScope))).toEqual(['other-account-session']);
    });

    it('durably changes an ambiguous enqueue into a cancellation without replacing its request envelope', async () => {
        const original = (await savePendingOutboxMessage({
            sessionId: 's1',
            localId: 'cancel-me',
            createdAt: 100,
            text: 'hello',
            rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
            request: plainRequest('cancel-me'),
        }, scope));

        expect((await markPendingOutboxMessageCancelRequested('s1', 'cancel-me', scope))).toEqual({
            ...original,
            operation: 'cancel',
        });
        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({
                localId: 'cancel-me',
                operation: 'cancel',
                request: original.request,
            }),
        ]);
    });

    it('accepts an absent legacy operation as enqueue and quarantines an explicit unknown operation across later writes', async () => {
        (await savePendingOutboxMessage({
            sessionId: 's1', localId: 'legacy', createdAt: 1, text: 'legacy',
            rawRecord: { role: 'user', content: { type: 'text', text: 'legacy' } },
            request: plainRequest('legacy'),
        }, scope));
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized) as Record<string, Array<Record<string, unknown>>>;
        delete persisted.s1![0]!.operation;
        store.set(key, JSON.stringify(persisted));
        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({ localId: 'legacy', operation: 'enqueue' }),
        ]);

        persisted.s1![0]!.operation = 'future-operation';
        store.set(key, JSON.stringify(persisted));
        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({
                localId: 'legacy',
                operation: 'quarantined',
                quarantineReason: 'unsupported_persisted_operation',
            }),
        ]);

        (await savePendingOutboxMessage({
            sessionId: 's1', localId: 'later-valid', createdAt: 2, text: 'later',
            rawRecord: { role: 'user', content: { type: 'text', text: 'later' } },
            request: plainRequest('later-valid'),
        }, scope));
        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({
                localId: 'legacy',
                operation: 'quarantined',
                quarantineReason: 'unsupported_persisted_operation',
            }),
            expect.objectContaining({ localId: 'later-valid', operation: 'enqueue' }),
        ]);
    });

    it.each(['.', '..'])('rejects new dot-segment local IDs but quarantines persisted custody across later writes (%s)', async (localId) => {
        await expect(async () => (await savePendingOutboxMessage({
            sessionId: 's1', localId, createdAt: 1, text: 'invalid',
            rawRecord: { role: 'user', content: { type: 'text', text: 'invalid' } },
            request: plainRequest(localId),
        }, scope))).rejects.toThrow('Pending message ID is invalid');

        (await savePendingOutboxMessage({
            sessionId: 's1', localId: 'valid', createdAt: 1, text: 'valid',
            rawRecord: { role: 'user', content: { type: 'text', text: 'valid' } },
            request: plainRequest('valid'),
        }, scope));
        const [key, serialized] = [...store.entries()][0]!;
        const persisted = JSON.parse(serialized) as Record<string, Array<Record<string, unknown>>>;
        persisted.s1![0]!.localId = localId;
        persisted.s1![0]!.request = plainRequest(localId);
        store.set(key, JSON.stringify(persisted));

        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({
                localId,
                operation: 'quarantined',
                quarantineReason: 'invalid_persisted_local_id',
            }),
        ]);

        (await savePendingOutboxMessage({
            sessionId: 's1', localId: 'later-valid', createdAt: 2, text: 'later',
            rawRecord: { role: 'user', content: { type: 'text', text: 'later' } },
            request: plainRequest('later-valid'),
        }, scope));
        expect((await loadPendingOutboxForSession('s1', scope))).toEqual([
            expect.objectContaining({ localId, quarantineReason: 'invalid_persisted_local_id' }),
            expect.objectContaining({ localId: 'later-valid', operation: 'enqueue' }),
        ]);
    });

});
