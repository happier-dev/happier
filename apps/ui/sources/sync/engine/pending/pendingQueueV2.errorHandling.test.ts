import { beforeEach, describe, expect, it } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DiscardedPendingMessage } from '@/sync/domains/state/storageTypes';
import { loadPendingOutboxForSession, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';

import {
    blockPendingDeliveryV2 as blockPendingDeliveryV2Impl,
    deleteDiscardedPendingMessageV2 as deleteDiscardedPendingMessageV2Impl,
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    discardPendingMessageV2 as discardPendingMessageV2Impl,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2 as fetchAndApplyPendingMessagesV2Impl,
    markPendingDeliveryHandledV2 as markPendingDeliveryHandledV2Impl,
    reorderPendingMessagesV2 as reorderPendingMessagesV2Impl,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
    restoreDiscardedPendingMessageV2 as restoreDiscardedPendingMessageV2Impl,
    sendPendingDeliveryAsNewV2 as sendPendingDeliveryAsNewV2Impl,
    updatePendingMessageV2 as updatePendingMessageV2Impl,
    updatePendingRequestedActionV2 as updatePendingRequestedActionV2Impl,
} from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    resetPendingQueueState,
    withExactPendingEnqueueAckIdentityForTest,
} from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;
const enqueuePendingMessageV2 = (
    params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'requestedAction' | 'wireMode'>,
) => enqueuePendingMessageV2Impl({
    ...params,
    request: withExactPendingEnqueueAckIdentityForTest(params.request),
    requestedAction: { v: 1, kind: 'enqueue' },
    wireMode: 'pending_input_v1',
});
const updatePendingMessageV2 = (
    params: Omit<Parameters<typeof updatePendingMessageV2Impl>[0], 'outboxScope'>,
) => updatePendingMessageV2Impl({ ...params, outboxScope });
const retryPendingOutboxOperationV2 = (
    params: Omit<Parameters<typeof retryPendingOutboxOperationV2Impl>[0], 'wireMode'>,
) => retryPendingOutboxOperationV2Impl({
    ...params,
    request: withExactPendingEnqueueAckIdentityForTest(params.request),
    wireMode: 'pending_input_v1',
});

const withOutboxScope = <T extends { outboxScope: ServerAccountScope }>(
    fn: (params: T) => Promise<void>,
) => (params: Omit<T, 'outboxScope'>) =>
    // Test adapter restores the one deliberately omitted required boundary field.
    fn({ ...params, outboxScope } as T);
const isCurrentPendingScope = () => true;
const fetchAndApplyPendingMessagesV2 = (
    params: Omit<Parameters<typeof fetchAndApplyPendingMessagesV2Impl>[0], 'outboxScope'>,
) => fetchAndApplyPendingMessagesV2Impl({
    ...params,
    outboxScope,
    isOutboxScopeCurrent: params.isOutboxScopeCurrent ?? isCurrentPendingScope,
});
const deletePendingMessageV2 = withOutboxScope(deletePendingMessageV2Impl);
const discardPendingMessageV2 = withOutboxScope(discardPendingMessageV2Impl);
const restoreDiscardedPendingMessageV2 = withOutboxScope(restoreDiscardedPendingMessageV2Impl);
const deleteDiscardedPendingMessageV2 = withOutboxScope(deleteDiscardedPendingMessageV2Impl);
const reorderPendingMessagesV2 = withOutboxScope(reorderPendingMessagesV2Impl);
const markPendingDeliveryHandledV2 = withOutboxScope(markPendingDeliveryHandledV2Impl);
const blockPendingDeliveryV2 = withOutboxScope(blockPendingDeliveryV2Impl);
const sendPendingDeliveryAsNewV2 = withOutboxScope(sendPendingDeliveryAsNewV2Impl);
const updatePendingRequestedActionV2 = (
    params: Omit<Parameters<typeof updatePendingRequestedActionV2Impl>[0], 'outboxScope' | 'wireMode'>,
) => updatePendingRequestedActionV2Impl({
    ...params,
    outboxScope,
    wireMode: 'pending_input_v1',
});

function buildDiscardedPendingMessage(): DiscardedPendingMessage {
    return {
        id: 'd1',
        localId: 'd1',
        createdAt: 1,
        updatedAt: 1,
        text: 'x',
        rawRecord: { role: 'user', content: { type: 'text', text: 'x' } },
        discardedAt: 2,
        discardedReason: 'manual',
    };
}

async function expectNotAuthenticated(promise: Promise<unknown>, status: 401 | 403): Promise<void> {
    await expect(promise).rejects.toMatchObject({
        name: 'HappyError',
        canTryAgain: false,
        kind: 'auth',
        code: 'not_authenticated',
        status,
    });
}

function insertEditablePendingMessage(sessionId: string): void {
    storage.getState().applySessions([buildSession({ sessionId })]);
    storage.getState().upsertPendingMessage(sessionId, {
        id: 'p1',
        localId: 'p1',
        createdAt: 1,
        updatedAt: 1,
        text: 'original',
        rawRecord: {
            role: 'user',
            content: { type: 'text', text: 'original' },
            meta: {},
        },
    });
}

describe('pendingQueueV2 error handling', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it.each([
        { name: 'discard', mutate: discardPendingMessageV2 },
        { name: 'handled delivery', mutate: markPendingDeliveryHandledV2 },
    ])('does not restore a row from a held pre-write snapshot after successful $name', async ({ mutate }) => {
        const sessionId = 's_pending_retirement_snapshot';
        const localId = 'retired-local-id';
        const freshLocalId = 'new-server-row-after-write';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'retire this row' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: rawRecord.content.text, rawRecord,
        });
        const encryption = await createPendingQueueEncryption({ sessionId });
        const readStarted = createDeferred<void>();
        const oldRead = createDeferred<Response>();
        const retired = createDeferred<void>();
        const unsubscribe = storage.subscribe((state) => {
            if (!(state.sessionPending[sessionId]?.messages ?? []).some((message) => message.localId === localId)) {
                retired.resolve();
            }
        });
        let firstRead = true;
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            if (init?.method === 'POST') return Response.json({ ok: true });
            if (firstRead) {
                firstRead = false;
                readStarted.resolve();
                return oldRead.promise;
            }
            return Response.json({ pending: [{
                localId: freshLocalId, content: { t: 'plain', v: rawRecord }, requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued', position: 0, createdAt: 2, updatedAt: 2,
            }] });
        };
        const refresh = fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
        await readStarted.promise;
        const mutation = mutate({ sessionId, pendingId: localId, encryption, request, isOutboxScopeCurrent: isCurrentPendingScope });
        try {
            await retired.promise;
            oldRead.resolve(Response.json({ pending: [{
                localId, content: { t: 'plain', v: rawRecord }, requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
            }] }));
            await Promise.all([refresh, mutation]);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([
                expect.objectContaining({ localId: freshLocalId }),
            ]);
        } finally {
            unsubscribe();
        }
    });

    it('invalidates a pre-write snapshot as soon as requested-action PATCH succeeds while its body is still pending', async () => {
        const sessionId = 's_pending_action_response_body';
        const localId = 'action-local-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'send this row now' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            requestedAction: { v: 1, kind: 'enqueue' }, text: rawRecord.content.text, rawRecord,
        });
        const encryption = await createPendingQueueEncryption({ sessionId });
        const readStarted = createDeferred<void>();
        const oldRead = createDeferred<Response>();
        const bodyStarted = createDeferred<void>();
        const body = createDeferred<{ didUpdate: boolean }>();
        const successfulPatch = Response.json({ didUpdate: true });
        successfulPatch.json = async () => {
            bodyStarted.resolve();
            return body.promise;
        };
        const snapshot = (kind: 'enqueue' | 'send_now') => Response.json({ pending: [{
            localId, content: { t: 'plain', v: rawRecord }, requestedAction: { v: 1, kind },
            status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
        }] });
        let firstRead = true;
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            if (init?.method === 'PATCH') return successfulPatch;
            if (firstRead) {
                firstRead = false;
                readStarted.resolve();
                return oldRead.promise;
            }
            return snapshot('send_now');
        };
        const refresh = fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
        await readStarted.promise;
        const mutation = updatePendingRequestedActionV2({
            sessionId, localId, requestedAction: { v: 1, kind: 'send_now' }, request,
        });
        await bodyStarted.promise;
        try {
            const freshRefresh = fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
            oldRead.resolve(snapshot('enqueue'));
            await Promise.all([refresh, freshRefresh]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({ localId, requestedAction: { v: 1, kind: 'send_now' } }),
            ]);
        } finally {
            body.resolve({ didUpdate: true });
            await mutation;
        }
    });

    it.each(['requested-action', 'enqueue', 'retry'] as const)(
        'applies a removal snapshot started while the %s response body is loading', async (operation) => {
            const sessionId = 's_pending_action_removal_during_body';
            const localId = 'materialized-action-local-id';
            storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId, localId, createdAt: 1, updatedAt: 1,
                source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
                text: 'already handled by the agent',
                rawRecord: { role: 'user', content: { type: 'text', text: 'already handled by the agent' } },
            });
            const encryption = await createPendingQueueEncryption({ sessionId });
            const bodyStarted = createDeferred<void>();
            const payload = { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' }, pending: { localId } };
            const body = createDeferred<typeof payload>();
            const snapshotStarted = createDeferred<void>();
            const snapshot = createDeferred<Response>();
            const successfulResponse = Response.json({ didUpdate: true });
            successfulResponse.json = async () => {
                bodyStarted.resolve();
                return body.promise;
            };
            if (operation === 'retry') {
                await enqueuePendingMessageV2({
                    sessionId, localId, text: 'already handled by the agent', encryption, outboxScope,
                    request: async () => { throw new Error('lost enqueue response'); },
                }).catch(() => undefined);
            }
            const request = async () => successfulResponse;
            const mutation = operation === 'requested-action'
                ? updatePendingRequestedActionV2({
                    sessionId, localId, requestedAction: { v: 1, kind: 'send_now' }, request,
                })
                : operation === 'enqueue'
                    ? enqueuePendingMessageV2({
                        sessionId, localId, text: 'already handled by the agent', encryption, outboxScope, request,
                    })
                    : retryPendingOutboxOperationV2({ sessionId, localId, outboxScope, request });
            await bodyStarted.promise;
            const refresh = fetchAndApplyPendingMessagesV2({
                sessionId, encryption,
                request: async () => {
                    snapshotStarted.resolve();
                    return snapshot.promise;
                },
            });
            await snapshotStarted.promise;
            body.resolve(payload);
            await mutation;
            snapshot.resolve(Response.json({ pending: [] }));
            await refresh;

            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
        },
    );

    it('clears discarded messages when the pending fetch fails', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('nope', { status: 500 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when the pending response JSON shape is invalid', async () => {
        const sessionId = 's_test_bad_shape';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify({ pending: 'bad' }), { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it('clears discarded messages when response JSON parsing fails', async () => {
        const sessionId = 's_test_parse_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 6 });

        storage.getState().applyDiscardedPendingMessages(sessionId, [buildDiscardedPendingMessage()]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response('{', { status: 200 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([]);
        expect(pendingState?.isLoaded).toBe(true);
    });

    it.each([401, 403] as const)('surfaces pending fetch auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_fetch_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const discarded = buildDiscardedPendingMessage();

        storage.getState().applyDiscardedPendingMessages(sessionId, [discarded]);

        await expectNotAuthenticated(
            fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                request: async () => new Response(null, { status }),
            }),
            status,
        );

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.discarded ?? []).toEqual([discarded]);
        expect(pendingState?.isLoaded ?? false).toBe(false);
    });

    it('keeps the local pending row when pending enqueue fails from transient connectivity', async () => {
        const sessionId = 's_test_enqueue_timeout';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        const timeoutError = Object.assign(new Error('operation has timed out'), {
            name: 'ServerFetchConnectivityTimeoutError',
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            outboxScope,
            request: async () => {
                throw timeoutError;
            },
        })).resolves.toEqual({
            accepted: false,
            localId: expect.any(String),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([
            expect.objectContaining({
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'hello',
            }),
        ]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('keeps the local pending row when the server reports retryable transaction backpressure', async () => {
        const sessionId = 's_test_enqueue_transaction_unavailable';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            outboxScope,
            request: async () => new Response(
                JSON.stringify({ error: 'transaction-unavailable', retryAfterMs: 1_000 }),
                { status: 503, headers: { 'Retry-After': '1' } },
            ),
        })).resolves.toEqual({
            accepted: false,
            localId: expect.any(String),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([
            expect.objectContaining({
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'hello',
            }),
        ]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each([401, 403] as const)('surfaces pending mutation auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_mutation_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status });

        const mutations: Array<() => Promise<void>> = [
            () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
            () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
            () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
            () => markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request }),
            () => blockPendingDeliveryV2({
                sessionId,
                pendingId: 'p1',
                reason: 'provider_unavailable_before_acceptance',
                encryption,
                request,
            }),
        ];

        for (const runMutation of mutations) {
            await expectNotAuthenticated(runMutation(), status);
        }
    });

    it('keeps an external handoff visible when its fail-closed server DELETE is acknowledged', async () => {
        const sessionId = 's_test_delete_external_handoff';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-handoff-1',
            localId: 'external-handoff-1',
            createdAt: 111,
            updatedAt: 111,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            text: 'provider custody is unresolved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'provider custody is unresolved' }, meta: {} },
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'external-handoff-1',
            createdAt: 111,
            text: 'provider custody is unresolved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'provider custody is unresolved' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({
                    localId: 'external-handoff-1',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'provider custody is unresolved' }, meta: {} } },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryMode: 'external_handoff',
                }),
            },
        }, outboxScope));

        await deletePendingMessageV2({
            sessionId,
            pendingId: 'external-handoff-1',
            request: async () => new Response(null, { status: 200 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId: 'external-handoff-1',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({
                pending: [{
                    localId: 'external-handoff-1',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'provider custody is unresolved' }, meta: {} },
                    },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 111,
                    updatedAt: 112,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId: 'external-handoff-1',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ pending: [] }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId: 'external-handoff-1',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
    });

    it('removes a manually handled external handoff before reconciling an absent server snapshot', async () => {
        const sessionId = 's_test_handle_external_handoff';
        const localId = 'handled-external-handoff';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            text: 'handled by user',
            rawRecord: { role: 'user', content: { type: 'text', text: 'handled by user' }, meta: {} },
        });
        const methods: Array<string | undefined> = [];

        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId: localId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (_path, init) => {
                methods.push(init?.method);
                return init?.method === 'POST'
                    ? Response.json({ ok: true })
                    : Response.json({ pending: [] });
            },
        });

        expect(methods).toEqual(['POST', 'GET']);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('retires the local projection of a discarded message without waiting for the refresh', async () => {
        // Discard is an OWNER-driven retirement: the user asked for it and no committed twin is
        // coming. Its two siblings (`deletePendingMessageV2`, `markPendingDeliveryHandledV2`)
        // retire the local projection themselves; discard relied entirely on the refresh, so a
        // refresh that does not land left a live-looking pending row for a discarded message.
        const sessionId = 's_test_discard_retires_local_projection';
        const localId = 'discarded-projection';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            pendingDeliveryStatus: 'server_queued',
            text: 'discard me',
            rawRecord: { role: 'user', content: { type: 'text', text: 'discard me' }, meta: {} },
        });
        const methods: Array<string | undefined> = [];

        await discardPendingMessageV2({
            sessionId,
            pendingId: localId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (_path, init) => {
                methods.push(init?.method);
                // The discard commits, then the refresh fails (offline/5xx) and cannot retire it.
                return init?.method === 'POST'
                    ? Response.json({ ok: true })
                    : new Response(null, { status: 500 });
            },
        });

        expect(methods).toEqual(['POST', 'GET']);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it.each(['.', '..'] as const)('rejects unsafe pending ID path segment %s before issuing a request', async (pendingId) => {
        const sessionId = `s_test_unsafe_pending_id_${pendingId.length}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        let requestCalled = false;

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                requestCalled = true;
                return new Response(null, { status: 200 });
            },
        })).rejects.toThrow('Pending message ID cannot be a dot path segment');

        expect(requestCalled).toBe(false);
    });

    it.each(['.', '..'] as const)('rejects unsafe pending collection ID %s before issuing a request', async (localId) => {
        const sessionId = `s_test_unsafe_pending_collection_id_${localId.length}`;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        let requestCalled = false;

        expect(() => enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'unsafe id',
            encryption,
            outboxScope,
            request: async () => {
                requestCalled = true;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).toThrow('Pending message ID cannot be a dot path segment');

        expect(requestCalled).toBe(false);
    });

    it('treats a direct pending DELETE 404 as confirmed absence', async () => {
        const sessionId = 's_test_direct_delete_absent';
        const pendingId = 'already-absent';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 111,
            updatedAt: 111,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'already absent',
            rawRecord: { role: 'user', content: { type: 'text', text: 'already absent' }, meta: {} },
        });

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => new Response(null, { status: 404 }),
        })).resolves.toBeUndefined();

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('retains cancellation custody when deleting a server-authoritative same-localId row fails', async () => {
        const sessionId = 's_test_delete_server_authoritative_with_outbox';
        const localId = 'server-authoritative-with-outbox';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'retained local custody' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 222,
            updatedAt: 223,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'server authoritative',
            rawRecord: { role: 'user', content: { type: 'text', text: 'server authoritative' }, meta: {} },
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'retained local custody',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, outboxScope));

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => new Response(null, { status: 500 }),
        })).rejects.toThrow('Failed to delete pending message (500)');

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, source: 'server_pending' }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
    });

    it('confirms target deletion before retiring a locally queued ambiguous row', async () => {
        const sessionId = 's_test_delete_local_queued';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-delete-me',
            localId: 'local-delete-me',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'cancel before enqueue',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'cancel before enqueue' },
                meta: {},
            },
            pendingOutboxScope: outboxScope,
        } as any);
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'local-delete-me',
            createdAt: 111,
            text: 'cancel before enqueue',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cancel before enqueue' }, meta: {} },
            request: {
                v: 1,
                body: '{"localId":"local-delete-me","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, outboxScope));

        const requests: Array<{ path: string; method?: string }> = [];
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: 'local-delete-me',
            request: async (path, init) => {
                requests.push({ path, method: init?.method });
                return new Response(null, { status: 404 });
            },
        })).resolves.toBeUndefined();

        expect(requests).toEqual([{
            path: `/v2/sessions/${sessionId}/pending/local-delete-me`,
            method: 'DELETE',
        }]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
    });

    it('canonicalizes a collision-allocated projection id before cancelling durable enqueue custody', async () => {
        const sessionId = 's_test_delete_collision_allocated_projection';
        const localId = 'durable-local-id';
        const projectionId = 'pending-outbox:collision-allocated-id';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'cancel this exact enqueue' },
            meta: {},
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: projectionId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: outboxScope,
            text: 'cancel this exact enqueue',
            rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'cancel this exact enqueue',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, outboxScope));
        const requests: Array<{ path: string; method?: string }> = [];

        await deletePendingMessageV2({
            sessionId,
            pendingId: projectionId,
            request: async (path, init) => {
                requests.push({ path, method: init?.method });
                return new Response(null, { status: 404 });
            },
        });

        expect(requests).toEqual([{
            path: `/v2/sessions/${sessionId}/pending/${localId}`,
            method: 'DELETE',
        }]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('encodes an opaque local ID in the server cancellation path', async () => {
        const sessionId = 's_test_opaque_cancel_path';
        const localId = 'opaque/local?#%';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: outboxScope,
            text: 'opaque cancellation',
            rawRecord: { role: 'user', content: { type: 'text', text: 'opaque cancellation' }, meta: {} },
        } as any);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'opaque cancellation',
            rawRecord: { role: 'user', content: { type: 'text', text: 'opaque cancellation' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
            },
        }, outboxScope));
        const paths: string[] = [];

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async (path) => {
                paths.push(path);
                return new Response(null, { status: 200 });
            },
        });

        expect(paths).toEqual([
            `/v2/sessions/${sessionId}/pending/${encodeURIComponent(localId)}`,
        ]);
    });

    it('retains a durable cancellation and visible row when target deletion is ambiguous', async () => {
        const sessionId = 's_test_delete_local_ambiguous';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-delete-ambiguous',
            localId: 'local-delete-ambiguous',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'possibly committed',
            rawRecord: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
            pendingOutboxScope: outboxScope,
        } as any);
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'local-delete-ambiguous',
            createdAt: 111,
            text: 'possibly committed',
            rawRecord: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
            request: {
                v: 1,
                body: '{"localId":"local-delete-ambiguous","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, outboxScope));

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: 'local-delete-ambiguous',
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        })).rejects.toThrow('Failed to fetch');

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'local-delete-ambiguous' }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: 'local-delete-ambiguous', operation: 'cancel' }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId: 'local-delete-ambiguous',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'local-delete-ambiguous', source: 'server_pending' }),
        ]);

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'local-delete-ambiguous',
            outboxScope,
            request: async () => { throw new TypeError('Failed to fetch'); },
        })).resolves.toEqual({ accepted: false });
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId: 'local-delete-ambiguous',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 224,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'local-delete-ambiguous', source: 'server_pending' }),
        ]);
    });

    it('retries a locally queued pending enqueue and marks the row accepted after the server accepts it', async () => {
        const sessionId = 's_test_retry_pending_enqueue';
        storage.getState().applySessions([buildSession({ sessionId })]);

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-retry',
            localId: 'local-pending-retry',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: outboxScope,
            text: 'retry me',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            },
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'local-pending-retry',
            createdAt: 111,
            text: 'retry me',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry me' }, meta: {} },
            request: {
                v: 1,
                body: '{"localId":"local-pending-retry","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, outboxScope));

        const bodies: unknown[] = [];
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'local-pending-retry',
            outboxScope,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).resolves.toEqual({ accepted: true });

        expect(bodies).toEqual([
            expect.objectContaining({
                localId: 'local-pending-retry',
                messageRole: 'user',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'local-pending-retry',
                localId: 'local-pending-retry',
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                text: 'retry me',
            }),
        ]);
    });

    it('keeps the locally queued pending enqueue row when retry still has transient connectivity', async () => {
        const sessionId = 's_test_retry_pending_enqueue_transient';
        storage.getState().applySessions([buildSession({ sessionId })]);

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-retry-transient',
            localId: 'local-pending-retry-transient',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: outboxScope,
            text: 'retry transient',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retry transient' },
                meta: {},
            },
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'local-pending-retry-transient',
            createdAt: 111,
            text: 'retry transient',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry transient' }, meta: {} },
            request: {
                v: 1,
                body: '{"localId":"local-pending-retry-transient","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, outboxScope));

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'local-pending-retry-transient',
            outboxScope,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        })).resolves.toEqual({ accepted: false });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'local-pending-retry-transient',
                localId: 'local-pending-retry-transient',
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'retry transient',
            }),
        ]);
    });

    it('keeps a post-2xx retry parse failure unconfirmed because the server commit may exist', async () => {
        const sessionId = 's_test_retry_post_2xx_parse_failure';
        const localId = 'retry-post-2xx-parse-failure';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'ambiguous parse' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
            pendingOutboxScope: outboxScope,
            text: 'ambiguous parse',
            rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'ambiguous parse',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, outboxScope));

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope,
            request: async () => new Response('{not-json', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        })).rejects.toThrow('Server did not acknowledge the persisted Pending requested action');

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toHaveLength(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, sendState: 'unconfirmed' }),
        ]);
    });

    it('keeps external handoff visible after exact replay when auxiliary rawRecord is invalid', async () => {
        const sessionId = 's_test_retry_invalid_auxiliary_projection';
        const localId = 'retry-invalid-auxiliary-projection';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'valid frozen envelope',
            // Boundary fixture deliberately persists malformed auxiliary projection data beside a valid frozen envelope.
            rawRecord: ({ role: 'assistant', content: { type: 'text', text: 'invalid auxiliary projection' } } as unknown as Parameters<typeof savePendingOutboxMessage>[0]['rawRecord']),
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'valid frozen envelope' }, meta: {} } },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryMode: 'external_handoff',
                }),
            },
        }, outboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, outboxScope));
        const frozenBody = (await loadPendingOutboxForSession(sessionId, outboxScope))[0]!.request.body;
        const sentBodies: string[] = [];

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            },
        })).resolves.toEqual({ accepted: true });

        expect(sentBodies).toEqual([frozenBody]);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'valid frozen envelope',
                pendingDecryptFailure: { kind: 'decrypt_failed' },
            }),
        ]);
    });

    it.each([401, 403] as const)('retains an ambiguous enqueue after retry auth failure %s', async (status) => {
        const sessionId = `s_test_retry_pending_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-auth',
            localId: 'local-pending-auth',
            createdAt: 111,
            updatedAt: 111,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
            text: 'retry after auth',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry after auth' }, meta: {} },
            pendingOutboxScope: outboxScope,
        } as any);
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'local-pending-auth',
            createdAt: 111,
            text: 'retry after auth',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry after auth' }, meta: {} },
            request: {
                v: 1,
                body: '{"localId":"local-pending-auth","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, outboxScope));

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'local-pending-auth',
            outboxScope,
            request: async () => new Response(null, { status }),
        })).rejects.toMatchObject({ kind: 'auth', status });

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toHaveLength(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'local-pending-auth', sendState: 'failed' }),
        ]);
    });

    it('preserves generic status errors for non-auth pending mutations', async () => {
        const sessionId = 's_test_mutation_generic_error';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status: 500 });

        const mutations: Array<{ run: () => Promise<void>; message: string }> = [
            {
                run: () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
                message: 'Failed to update pending message (500)',
            },
            {
                run: () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
                message: 'Failed to delete pending message (500)',
            },
            {
                run: () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to discard pending message (500)',
            },
            {
                run: () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to restore discarded message (500)',
            },
            {
                run: () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to delete discarded message (500)',
            },
            {
                run: () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
                message: 'Failed to reorder pending messages (500)',
            },
            {
                run: () => markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request }),
                message: 'Failed to mark pending delivery handled (500)',
            },
            {
                run: () => blockPendingDeliveryV2({
                    sessionId,
                    pendingId: 'p1',
                    reason: 'provider_unavailable_before_acceptance',
                    encryption,
                    request,
                }),
                message: 'Failed to block pending delivery (500)',
            },
        ];

        for (const mutation of mutations) {
            await expect(mutation.run()).rejects.toThrow(mutation.message);
        }
    });

    it('preserves request rejections for pending mutation timeouts', async () => {
        const sessionId = 's_test_mutation_timeout';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        insertEditablePendingMessage(sessionId);
        const timeout = new Error('request timed out');

        await expect(
            discardPendingMessageV2({
                sessionId,
                pendingId: 'p1',
                encryption,
                request: async () => {
                    throw timeout;
                },
            }),
        ).rejects.toBe(timeout);
    });

    it('rejects a mutation follow-up snapshot when its resolved owner scope is stale', async () => {
        const sessionId = 's_test_mutation_stale_owner_refresh';
        const encryption = await createPendingQueueEncryption({ sessionId });
        insertEditablePendingMessage(sessionId);
        let scopeCurrent = true;

        await discardPendingMessageV2({
            sessionId,
            pendingId: 'p1',
            encryption,
            isOutboxScopeCurrent: () => scopeCurrent,
            request: async (path) => {
                if (path.endsWith('/discard')) {
                    scopeCurrent = false;
                    return Response.json({ ok: true });
                }
                return Response.json({ pending: [] });
            },
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: 'p1', text: 'original' }),
        ]);
    });

    it('treats discarded DELETE 404 as confirmed absence', async () => {
        const sessionId = 's_test_discarded_delete_absent';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: [],
            discarded: [buildDiscardedPendingMessage()],
        });

        await expect(deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId: 'd1',
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path) => path.endsWith('?includeDiscarded=1')
                ? Response.json({ pending: [] })
                : new Response(null, { status: 404 }),
        })).resolves.toBeUndefined();

        expect(storage.getState().sessionPending[sessionId]?.discarded ?? []).toEqual([]);
    });

    it('posts pending delivery handled action then refreshes pending rows', async () => {
        const sessionId = 's_test_delivery_actions';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });
        const calls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method });
            if (path.endsWith('/delivery/handled')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (path.endsWith('/pending?includeDiscarded=1')) {
                return new Response(JSON.stringify({ pending: [] }), { status: 200 });
            }
            return new Response(null, { status: 404 });
        };

        await markPendingDeliveryHandledV2({ sessionId, pendingId: 'p1', encryption, request });

        expect(calls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending/p1/delivery/handled`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`, method: 'GET' },
        ]);
    });

    it('blocks the exact pending delivery reason then refreshes pending rows', async () => {
        const sessionId = 's_test_delivery_block';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 12 });
        const calls: Array<{ path: string; method: string | undefined; body: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            calls.push({
                path,
                method: init?.method,
                body: typeof init?.body === 'string' ? init.body : undefined,
            });
            if (path.endsWith('/delivery/block')) {
                return Response.json({ ok: true });
            }
            if (path.endsWith('/pending?includeDiscarded=1')) {
                return Response.json({ pending: [] });
            }
            return new Response(null, { status: 404 });
        };

        await blockPendingDeliveryV2({
            sessionId,
            pendingId: 'voice-local-1',
            reason: 'provider_unavailable_before_acceptance',
            encryption,
            request,
        });

        expect(calls).toEqual([
            {
                path: `/v2/sessions/${sessionId}/pending/voice-local-1/delivery/block`,
                method: 'POST',
                body: JSON.stringify({ reason: 'provider_unavailable_before_acceptance' }),
            },
            {
                path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
                method: 'GET',
                body: undefined,
            },
        ]);
    });

    it('leaves send-as-new replacement identity out of the UI wire request', async () => {
        const sessionId = 's_test_delivery_send_as_new';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });
        const calls: Array<{ path: string; method: string | undefined; body: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            calls.push({
                path,
                method: init?.method,
                body: typeof init?.body === 'string' ? init.body : undefined,
            });
            if (path.endsWith('/delivery/send-as-new')) {
                return Response.json({ ok: true });
            }
            if (path.endsWith('/pending?includeDiscarded=1')) {
                return Response.json({ pending: [] });
            }
            return new Response(null, { status: 404 });
        };

        await sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId: 'voice-local-1',
            encryption,
            request,
            isOutboxScopeCurrent: () => true,
        });

        expect(calls).toEqual([
            {
                path: `/v2/sessions/${sessionId}/pending/voice-local-1/delivery/send-as-new`,
                method: 'POST',
                body: JSON.stringify({}),
            },
            {
                path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
                method: 'GET',
                body: undefined,
            },
        ]);
    });

    it('treats requested-action localId as canonical when another scoped projection uses it as an id', async () => {
        const sessionId = 's_action_canonical_local_id_collision';
        const canonicalLocalId = 'action-canonical-local-id';
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalLocalId,
            localId: 'action-collider-local-id',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            pendingOutboxScope: outboxScope,
            text: 'raw id collider',
            rawRecord: { role: 'user', content: { type: 'text', text: 'raw id collider' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'action-canonical-synthetic-projection',
            localId: canonicalLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            pendingOutboxScope: outboxScope,
            text: 'canonical target',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical target' }, meta: {} },
        });

        await updatePendingRequestedActionV2({
            sessionId,
            localId: canonicalLocalId,
            requestedAction: { v: 1, kind: 'send_now' },
            request: async (path) => {
                expect(path).toBe(`/v2/sessions/${sessionId}/pending/${canonicalLocalId}/action`);
                return Response.json({ didUpdate: false });
            },
        });
    });

    it('preserves canonical reorder localIds when scoped projection ids collide', async () => {
        const sessionId = 's_reorder_canonical_local_id_collision';
        const firstLocalId = 'reorder-first-canonical-local';
        const secondLocalId = 'reorder-second-canonical-local';
        storage.getState().upsertPendingMessage(sessionId, {
            id: firstLocalId,
            localId: 'reorder-raw-id-collider-local',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            pendingOutboxScope: outboxScope,
            text: 'raw id collider',
            rawRecord: { role: 'user', content: { type: 'text', text: 'raw id collider' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'reorder-first-synthetic-projection',
            localId: firstLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            pendingOutboxScope: outboxScope,
            text: 'first canonical',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first canonical' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'reorder-second-projection',
            localId: secondLocalId,
            createdAt: 3,
            updatedAt: 3,
            source: 'server_pending',
            pendingOutboxScope: outboxScope,
            text: 'second canonical',
            rawRecord: { role: 'user', content: { type: 'text', text: 'second canonical' }, meta: {} },
        });

        await reorderPendingMessagesV2({
            sessionId,
            orderedLocalIds: [firstLocalId, secondLocalId],
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path, init) => {
                if (path.endsWith('/reorder')) {
                    expect(JSON.parse(String(init?.body))).toEqual({ orderedLocalIds: [firstLocalId, secondLocalId] });
                    return Response.json({ ok: true });
                }
                return Response.json({ pending: [] });
            },
        });
    });

    it('removes the exact canonical row after handled delivery when a diagnostic shares its localId', async () => {
        const sessionId = 's_test_handled_exact_canonical_collision';
        const pendingId = 'handled-canonical-local';
        const diagnosticId = 'handled-quarantine-diagnostic';
        storage.getState().upsertPendingMessage(sessionId, {
            id: diagnosticId,
            localId: pendingId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: outboxScope,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'diagnostic remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'diagnostic remains' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'blocked',
            text: 'canonical handled row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical handled row' }, meta: {} },
        });
        let refreshStarted!: () => void;
        const refreshStartedGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const handled = markPendingDeliveryHandledV2({
            sessionId,
            pendingId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path) => {
                if (path.endsWith('/delivery/handled')) return Response.json({ ok: true });
                refreshStarted();
                await refreshGate;
                return Response.json({ pending: [] });
            },
        });
        await refreshStartedGate;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: diagnosticId,
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
        ]);
        releaseRefresh();
        await handled;
    });

    it('removes the caller-resolved synthetic projection instead of a scoped raw-id collider after handled delivery', async () => {
        const sessionId = 's_test_handled_synthetic_projection_collision';
        const canonicalLocalId = 'handled-canonical-local-collision';
        const syntheticProjectionId = 'handled-synthetic-projection';
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalLocalId,
            localId: 'unrelated-local-identity',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: outboxScope,
            text: 'raw-id collider remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'raw-id collider remains' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticProjectionId,
            localId: canonicalLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: outboxScope,
            text: 'synthetic target handled',
            rawRecord: { role: 'user', content: { type: 'text', text: 'synthetic target handled' }, meta: {} },
        });
        let refreshStarted!: () => void;
        const refreshStartedGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const handled = markPendingDeliveryHandledV2({
            sessionId,
            pendingId: syntheticProjectionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path) => {
                if (path.endsWith('/delivery/handled')) {
                    expect(path).toBe(`/v2/sessions/${sessionId}/pending/${canonicalLocalId}/delivery/handled`);
                    return Response.json({ ok: true });
                }
                refreshStarted();
                await refreshGate;
                return Response.json({ pending: [] });
            },
        });
        await refreshStartedGate;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: canonicalLocalId,
                localId: 'unrelated-local-identity',
                text: 'raw-id collider remains',
            }),
        ]);
        releaseRefresh();
        await handled;
    });
});
