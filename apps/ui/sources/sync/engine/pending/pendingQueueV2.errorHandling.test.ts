import { beforeEach, describe, expect, it } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { resolveListReorderFailure } from '@/sync/ops/actions/listReorderFailure';

import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DiscardedPendingMessage } from '@/sync/domains/state/storageTypes';
import { loadPendingOutboxForSession, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';

import {
    blockPendingDeliveryV2 as blockPendingDeliveryV2Impl,
    deleteDiscardedPendingMessageV2 as deleteDiscardedPendingMessageV2Impl,
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    dismissPendingDeliveryV2 as dismissPendingDeliveryV2Impl,
    discardPendingMessageV2 as discardPendingMessageV2Impl,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2 as fetchAndApplyPendingMessagesV2Impl,
    isReleasedServerV021PendingEnqueueResponse,
    markPendingDeliveryHandledV2 as markPendingDeliveryHandledV2Impl,
    reorderPendingMessagesV2 as reorderPendingMessagesV2Impl,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
    restoreDiscardedPendingMessageV2 as restoreDiscardedPendingMessageV2Impl,
    serializePendingEnqueueBodyForServerWire,
    updatePendingMessageV2 as updatePendingMessageV2Impl,
    updatePendingRequestedActionV2,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;
const enqueuePendingMessageV2 = (
    params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'serverWireMode'>,
) => enqueuePendingMessageV2Impl({ ...params, serverWireMode: 'pending_input_v1' });
const retryPendingOutboxOperationV2 = (
    params: Omit<Parameters<typeof retryPendingOutboxOperationV2Impl>[0], 'serverWireMode'>,
) => retryPendingOutboxOperationV2Impl({ ...params, serverWireMode: 'pending_input_v1' });
const isCurrentPendingScope = () => true;
const fetchAndApplyPendingMessagesV2 = (
    params: Omit<Parameters<typeof fetchAndApplyPendingMessagesV2Impl>[0], 'outboxScope'>,
) => fetchAndApplyPendingMessagesV2Impl({
    ...params,
    outboxScope,
    isOutboxScopeCurrent: () => true,
});
const withOutboxScope = <T extends { outboxScope: ServerAccountScope }, TResult>(
    fn: (params: T) => Promise<TResult>,
) => (params: Omit<T, 'outboxScope'>) =>
    // Test adapter restores the one deliberately omitted required boundary field.
    fn({ ...params, outboxScope } as T);
const discardPendingMessageV2 = withOutboxScope(discardPendingMessageV2Impl);
const restoreDiscardedPendingMessageV2 = withOutboxScope(restoreDiscardedPendingMessageV2Impl);
const deleteDiscardedPendingMessageV2 = withOutboxScope(deleteDiscardedPendingMessageV2Impl);
const reorderPendingMessagesV2 = withOutboxScope(reorderPendingMessagesV2Impl);
const deletePendingMessageV2 = withOutboxScope(deletePendingMessageV2Impl);
const blockPendingDeliveryV2 = withOutboxScope(blockPendingDeliveryV2Impl);
const dismissPendingDeliveryV2 = withOutboxScope(dismissPendingDeliveryV2Impl);
const markPendingDeliveryHandledV2 = withOutboxScope(markPendingDeliveryHandledV2Impl);
const updatePendingMessageV2 = withOutboxScope(updatePendingMessageV2Impl);

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
    beforeEach(async () => {
        // The app entry normally loads the real implementation before a Home is applied.
        await import('@/sync/syncEngine');
        await resetPendingQueueState(outboxScope);
    });

    it('rejects an explicit whitespace-only localId before creating local or remote state', async () => {
        const sessionId = 's_test_blank_local_id';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        let requested = false;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: ' \t ',
            text: 'must not enqueue',
            encryption,
            outboxScope,
            request: async () => {
                requested = true;
                return new Response(JSON.stringify({}), { status: 200 });
            },
        })).rejects.toThrow();

        expect(requested).toBe(false);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('serializes only the released-server v0.2.1 enqueue wire shape', () => {
        const canonicalBody = JSON.stringify({
            localId: 'local-old-wire',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        });

        expect(JSON.parse(serializePendingEnqueueBodyForServerWire(
            canonicalBody,
            'released_server_v0_2_1',
        )!)).toEqual({
            localId: 'local-old-wire',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        });
        expect(serializePendingEnqueueBodyForServerWire(canonicalBody, 'indeterminate')).toBeNull();
    });

    it('accepts only an exact released-server v0.2.1 acknowledgement for the requested localId', () => {
        const acknowledgement = {
            didWrite: true,
            pendingCount: 1,
            pendingVersion: 2,
            pending: {
                localId: 'local-old-ack',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
                status: 'queued',
                position: 0,
                createdAt: 1,
                updatedAt: 1,
                discardedAt: null,
                discardedReason: null,
                authorAccountId: 'account-a',
            },
        };

        expect(isReleasedServerV021PendingEnqueueResponse(acknowledgement, 'local-old-ack')).toBe(true);
        expect(isReleasedServerV021PendingEnqueueResponse(acknowledgement, 'local-other')).toBe(false);
        expect(isReleasedServerV021PendingEnqueueResponse({ ...acknowledgement, extra: true }, 'local-old-ack')).toBe(false);
        expect(isReleasedServerV021PendingEnqueueResponse({
            ...acknowledgement,
            pending: { ...acknowledgement.pending, extra: true },
        }, 'local-old-ack')).toBe(false);
    });

    it.each([
        { name: 'discard', mutate: discardPendingMessageV2, recipient: undefined },
        { name: 'handled delivery', mutate: markPendingDeliveryHandledV2, recipient: undefined },
        { name: 'Run discard', mutate: discardPendingMessageV2, recipient: { kind: 'execution_run' as const, runId: 'run-a' } },
    ])('does not restore a row from a held pre-write snapshot after successful $name', async ({ mutate, recipient }) => {
        const sessionId = 's_pending_retirement_snapshot';
        const localId = 'retired-local-id';
        const freshLocalId = 'new-server-row-after-write';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'retire this row' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain', pendingVersion: 1 } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, recipient, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: rawRecord.content.text, rawRecord,
        });
        const encryption = await createPendingQueueEncryption({ sessionId });
        const readStarted = createDeferred<void>();
        const oldRead = createDeferred<Response>();
        const writeAccepted = createDeferred<void>();
        let firstRead = true;
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            if (init?.method === 'POST') {
                const response = Response.json({ ok: true });
                // The successful response is observed while the earlier snapshot is still held.
                Object.defineProperty(response, 'ok', { get: () => { writeAccepted.resolve(); return true; } });
                return response;
            }
            if (firstRead) {
                firstRead = false;
                readStarted.resolve();
                return oldRead.promise;
            }
            return Response.json({ pending: [{
                localId: freshLocalId, recipient, content: { t: 'plain', v: rawRecord }, requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued', position: 0, createdAt: 2, updatedAt: 2,
            }] });
        };
        const refresh = fetchAndApplyPendingMessagesV2({ sessionId, recipient, encryption, request });
        await readStarted.promise;
        const mutation = mutate({ sessionId, pendingId: localId, encryption, request, isOutboxScopeCurrent: isCurrentPendingScope });
        try {
            await writeAccepted.promise;
            oldRead.resolve(Response.json({ pending: [{
                localId, recipient, content: { t: 'plain', v: rawRecord }, requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
            }] }));
            await Promise.all([refresh, mutation]);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([
                expect.objectContaining({ localId: freshLocalId }),
            ]);
        } finally {
            oldRead.resolve(Response.json({ pending: [] }));
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
            pendingRequestedAction: { v: 1, kind: 'enqueue' }, text: rawRecord.content.text, rawRecord,
        });
        const encryption = await createPendingQueueEncryption({ sessionId });
        const readStarted = createDeferred<void>();
        const oldRead = createDeferred<Response>();
        const bodyStarted = createDeferred<void>();
        const body = createDeferred<{ didUpdate: boolean; requestedAction: { v: 1; kind: 'send_now' } }>();
        const successfulPatch = Response.json({ didUpdate: true, requestedAction: { v: 1, kind: 'send_now' } });
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
            sessionId, localId, requestedAction: { v: 1, kind: 'send_now' }, request, outboxScope,
        });
        await bodyStarted.promise;
        try {
            const freshRefresh = fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
            oldRead.resolve(snapshot('enqueue'));
            await Promise.all([refresh, freshRefresh]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({ localId, pendingRequestedAction: { v: 1, kind: 'send_now' } }),
            ]);
        } finally {
            body.resolve({ didUpdate: true, requestedAction: { v: 1, kind: 'send_now' } });
            await mutation;
        }
    });

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

    it('keeps main and sibling-Run discarded rows when an exact-target pending fetch fails', async () => {
        const sessionId = 's_test_target_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        storage.getState().applyDiscardedPendingMessages(sessionId, [
            buildDiscardedPendingMessage(),
            { ...buildDiscardedPendingMessage(), id: 'd_run_b', localId: 'd_run_b', recipient: { kind: 'execution_run', runId: 'run_b' } },
            { ...buildDiscardedPendingMessage(), id: 'd_run_a', localId: 'd_run_a', recipient: { kind: 'execution_run', runId: 'run_a' } },
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            recipient: { kind: 'execution_run', runId: 'run_a' },
            request: async () => new Response('nope', { status: 404 }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect((pendingState?.discarded ?? []).map((message) => message.localId)).toEqual(['d1', 'd_run_b']);
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

    it.each([401, 403])('maps pending enqueue HTTP %s to a non-retryable auth HappyError', async (status) => {
        const sessionId = `s_test_enqueue_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                outboxScope,
                request: async () => new Response('auth failed', { status }),
            }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
            canTryAgain: false,
            status,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it.each([
        [403, 'session_access_authentication_required', false, 'auth'],
        [503, 'session_access_authentication_unavailable', true, 'config'],
    ] as const)('preserves Pending Team-auth continuation %s/%s', async (status, code, canTryAgain, kind) => {
        const sessionId = `s_test_enqueue_team_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            outboxScope,
            request: async () => new Response(JSON.stringify({ error: code }), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind,
            code,
            canTryAgain,
            status,
        });
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

    it.each([
        [403, 'session_access_authentication_required', false, 'auth'],
        [503, 'session_access_authentication_unavailable', true, 'config'],
    ] as const)('preserves Pending fetch Team-auth continuation %s/%s', async (status, code, canTryAgain, kind) => {
        const sessionId = `s_test_fetch_team_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await expect(fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify({ error: code }), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind,
            code,
            canTryAgain,
            status,
        });
    });

    it('keeps unknown pending delivery rows visible as blocked state', async () => {
        const sessionId = 's_test_fetch_unknown_delivery_state';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify({
                pending: [
                    {
                        localId: 'future-status',
                        content: {
                            t: 'plain',
                            v: {
                                role: 'user',
                                content: { type: 'text', text: 'future status' },
                                meta: {},
                            },
                        },
                        status: 'future_status',
                        position: 1,
                        createdAt: 10,
                        updatedAt: 11,
                        discardedAt: null,
                        discardedReason: null,
                    },
                    {
                        localId: 'future-delivery-state',
                        content: {
                            t: 'plain',
                            v: {
                                role: 'user',
                                content: { type: 'text', text: 'future delivery state' },
                                meta: {},
                            },
                        },
                        status: 'queued',
                        deliveryState: 'future_delivery_state',
                        deliveryBlockedReason: 'future_reason',
                        position: 2,
                        createdAt: 20,
                        updatedAt: 21,
                        discardedAt: null,
                        discardedReason: null,
                    },
                    {
                        localId: 'known-blocked',
                        content: {
                            t: 'plain',
                            v: {
                                role: 'user',
                                content: { type: 'text', text: 'known blocked' },
                                meta: {},
                            },
                        },
                        status: 'queued',
                        deliveryState: 'blocked',
                        deliveryBlockedReason: 'delivery_outcome_uncertain',
                        position: 3,
                        createdAt: 30,
                        updatedAt: 31,
                        discardedAt: null,
                        discardedReason: null,
                    },
                ],
            }), { status: 200 }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toEqual([
            expect.objectContaining({
                id: 'future-status',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'unknown',
                pendingDeliveryStatusRaw: 'future_status',
            }),
            expect.objectContaining({
                id: 'future-delivery-state',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'unknown',
                pendingDeliveryBlockedReasonRaw: 'future_reason',
                pendingDeliveryStatusRaw: 'future_delivery_state',
            }),
            expect.objectContaining({
                id: 'known-blocked',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
            }),
        ]);
    });

    it.each([401, 403] as const)('surfaces pending mutation auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_mutation_auth_${status}`;
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const request = async () => new Response(null, { status });

        const mutations = [
            async () => updatePendingMessageV2({ sessionId, pendingId: 'p1', text: 'new text', encryption, request }),
            async () => deletePendingMessageV2({ sessionId, pendingId: 'p1', request }),
            async () => discardPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            async () => restoreDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            async () => deleteDiscardedPendingMessageV2({ sessionId, pendingId: 'p1', encryption, request }),
            async () => reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption, request }),
        ];

        for (const runMutation of mutations) {
            await expectNotAuthenticated(runMutation(), status);
        }
    });

    it.each([400, 404] as const)('distinguishes acknowledged reorder rejection %s from an unknown transport outcome', async status => {
        const sessionId = 's_test_reorder_rejected';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const prior = storage.getState().sessionPending[sessionId];
        // The server rejects stale membership with HTTP 400 before changing queue positions.
        const rejection: unknown = await reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption,
            request: async () => new Response(JSON.stringify({ error: status === 400 ? 'invalid-params' : 'session-not-found' }), { status }),
        }).catch((error: unknown) => error);
        expect(rejection).toMatchObject({ kind: 'server', status, code: 'pending_reorder_rejected' });
        expect(resolveListReorderFailure(rejection, true)).toEqual({ status: 'refused', reason: 'pending_reorder_rejected' });
        expect(storage.getState().sessionPending[sessionId]).toBe(prior);

        const transportFailure = new Error('Connection lost after dispatch');
        const unknownOutcome: unknown = await reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption,
            request: async () => { throw transportFailure; },
        }).catch((error: unknown) => error);
        expect(unknownOutcome).toBe(transportFailure);
        expect(resolveListReorderFailure(unknownOutcome, true)).toEqual({ status: 'unknown', reason: 'reorder_failed' });
        expect(storage.getState().sessionPending[sessionId]).toBe(prior);

        // A 5xx can be emitted after a successful mutation, so it is not a definitive refusal.
        const serverFailure: unknown = await reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption,
            request: async () => new Response(null, { status: 500 }),
        }).catch((error: unknown) => error);
        expect(resolveListReorderFailure(serverFailure, true)).toEqual({ status: 'unknown', reason: 'reorder_failed' });
        expect(storage.getState().sessionPending[sessionId]).toBe(prior);
    });

    it.each([
        { status: 403, code: 'session_access_authentication_required' },
        { status: 503, code: 'session_access_authentication_unavailable' },
    ] as const)('reports explicit reorder Team continuation $code as refused before admission', async ({ status, code }) => {
        const sessionId = 's_test_reorder_team_continuation';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });
        insertEditablePendingMessage(sessionId);
        const prior = storage.getState().sessionPending[sessionId];
        const rejection: unknown = await reorderPendingMessagesV2({ sessionId, orderedLocalIds: ['p1'], encryption,
            request: async () => Response.json({ error: code }, { status }),
        }).catch((error: unknown) => error);
        expect(rejection).toMatchObject({ name: 'HappyError', status, code });
        expect(resolveListReorderFailure(rejection, true)).toEqual({ status: 'refused', reason: code });
        expect(storage.getState().sessionPending[sessionId]).toBe(prior);
    });

    it('keeps an external handoff visible when its fail-closed server DELETE is acknowledged', async () => {
        const sessionId = 's_test_delete_external_handoff';
        storage.getState().applySessions([buildSession({ sessionId })]);
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
    });

    it('keeps the local pending row when pending enqueue fails from transient connectivity', async () => {
        const sessionId = 's_test_enqueue_timeout';
        storage.getState().applySessions([buildSession({ sessionId })]);
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

    it('retains exact durable custody when a scoped request rejects after the transport may have committed', async () => {
        const sessionId = 's_test_enqueue_post_transport_scope_ambiguity';
        const localId = 'post-transport-scope-ambiguity';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });
        let transportReturned = false;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'durable once',
            encryption,
            outboxScope,
            request: async () => {
                await Promise.resolve(new Response(null, { status: 200 }));
                transportReturned = true;
                throw new Error('Pending owner server-account scope changed');
            },
        })).resolves.toEqual({ localId, accepted: false });

        expect(transportReturned).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({
                sessionId,
                localId,
                text: 'durable once',
                operation: 'enqueue',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                deliveryStatus: 'queued',
                sendState: 'unconfirmed',
                text: 'durable once',
            }),
        ]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('removes initial custody after a definitive non-success response', async () => {
        const sessionId = 's_test_enqueue_definitive_rejection';
        const localId = 'definitive-rejection';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 10 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'restore only this draft',
            encryption,
            outboxScope,
            request: async () => new Response(null, { status: 409 }),
        })).rejects.toThrow('Failed to enqueue pending message (409)');

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
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
            id: 'local-delete-ambiguous', localId: 'local-delete-ambiguous', createdAt: 111, updatedAt: 111,
            source: 'local_outbound', deliveryStatus: 'queued', text: 'possibly committed',
            rawRecord: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
            pendingOutboxScope: outboxScope,
        } as any);
        (await savePendingOutboxMessage({
            sessionId, localId: 'local-delete-ambiguous', createdAt: 111, text: 'possibly committed',
            rawRecord: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
            request: { v: 1, body: '{"localId":"local-delete-ambiguous","content":{"t":"plain","v":{}},"messageRole":"user"}' },
        }, outboxScope));

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: 'local-delete-ambiguous',
            request: async () => { throw new TypeError('Failed to fetch'); },
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
            request: async () => Response.json({
                pending: [{
                    localId: 'local-delete-ambiguous',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
                    },
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
            request: async () => Response.json({
                pending: [{
                    localId: 'local-delete-ambiguous',
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'possibly committed' }, meta: {} },
                    },
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

    it('keeps a server row visible when a concurrent refresh completes before DELETE fails', async () => {
        const sessionId = 's_test_delete_refresh_then_failure';
        const localId = 'delete-refresh-failure';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'still pending' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 111, updatedAt: 111,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'still pending', rawRecord,
        });
        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let failDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { failDelete = resolve; });
        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                deleteStarted();
                await deleteGate;
                throw new TypeError('Failed to fetch');
            },
        });
        await deleteStartedGate;

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    status: 'queued',
                    position: 0,
                    createdAt: 111,
                    updatedAt: 112,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, source: 'server_pending' }),
        ]);

        failDelete();
        await expect(deletion).rejects.toThrow('Failed to fetch');
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, source: 'server_pending' }),
        ]);
    });

    it('suppresses a stale captured row after DELETE succeeds', async () => {
        const sessionId = 's_test_delete_success_then_stale_refresh';
        const localId = 'delete-success-stale';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'delete me' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 111, updatedAt: 111,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'delete me', rawRecord,
        });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                await refreshGate;
                return Response.json({
                    pending: [{
                        localId,
                        content: { t: 'plain', v: rawRecord },
                        messageRole: 'user',
                        status: 'queued',
                        position: 0,
                        createdAt: 111,
                        updatedAt: 112,
                        discardedAt: null,
                        discardedReason: null,
                    }],
                });
            },
        });

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => new Response(null, { status: 204 }),
        });
        releaseRefresh();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
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
                return Response.json({
                    pending: { localId: 'local-pending-retry' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                });
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

    it.each([
        [
            'malformed JSON',
            () => new Response('{', { status: 200 }),
            'Server did not acknowledge the persisted Pending requested action',
        ],
        [
            'semantically invalid external-handoff state',
            () => Response.json({
                pending: { localId: 'external-retry', deliveryStatus: { status: 'queued' } },
                requestedAction: { v: 1, kind: 'enqueue' },
            }),
            'Server did not retain external handoff',
        ],
    ])('keeps a retry unconfirmed after a 2xx %s response', async (_case, makeResponse, expectedError) => {
        const sessionId = `s_test_retry_post_2xx_${String(_case).replaceAll(' ', '_')}`;
        const localId = 'external-retry';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'external retry' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 111, updatedAt: 111,
            source: 'local_outbound', deliveryStatus: 'queued', sendState: 'unconfirmed',
            pendingOutboxScope: outboxScope, text: 'external retry', rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId, localId, createdAt: 111, text: 'external retry', rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    deliveryMode: 'external_handoff',
                }),
            },
        }, outboxScope));

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope,
            request: async () => makeResponse(),
        })).rejects.toThrow(expectedError);

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toHaveLength(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, sendState: 'unconfirmed' }),
        ]);
    });

    it('keeps pre-existing ambiguous custody unconfirmed after a definitive rejoin failure', async () => {
        const sessionId = 's_test_rejoin_definitive_failure';
        const localId = 'ambiguous-rejoin-local';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'ambiguous first attempt',
            encryption,
            outboxScope,
            request: async () => { throw new TypeError('Failed to fetch'); },
        })).resolves.toEqual({ localId, accepted: false });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must rejoin frozen custody',
            encryption,
            outboxScope,
            request: async () => new Response(null, { status: 409 }),
        })).rejects.toThrow('Failed to enqueue pending message (409)');

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue', text: 'ambiguous first attempt' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'ambiguous first attempt', sendState: 'unconfirmed' }),
        ]);
    });

    it('cancels retained exact-scope custody before deleting its server-owned external handoff', async () => {
        const sessionId = 's_test_server_external_handoff_with_outbox';
        const localId = 'server-external-with-outbox';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'external handoff' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await savePendingOutboxMessage({
            sessionId, localId, createdAt: 111, text: 'external handoff', rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    deliveryMode: 'external_handoff',
                }),
            },
        }, outboxScope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 222, updatedAt: 222,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'external handoff', rawRecord,
        });
        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const firstDelete = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                deleteStarted();
                await deleteGate;
                throw new TypeError('Failed to fetch');
            },
        });
        await deleteStartedGate;
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        releaseDelete();
        await expect(firstDelete).rejects.toThrow('Failed to fetch');
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, pendingDeliveryStatus: 'external_handoff' }),
        ]);

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => new Response(null, { status: 404 }),
        });
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, pendingDeliveryStatus: 'external_handoff' }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, pendingDeliveryStatus: 'external_handoff' }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ pending: [] }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: outboxScope,
            }),
        ]);
    });

    it('removes a handled external-handoff row before applying an empty refresh', async () => {
        const sessionId = 's_test_handled_external_handoff';
        const localId = 'handled-external';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'handled' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'handled', rawRecord,
        });
        const paths: string[] = [];

        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId: localId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (path) => {
                paths.push(path);
                return path.endsWith('/delivery/handled')
                    ? new Response(null, { status: 204 })
                    : Response.json({ pending: [] });
            },
        });

        expect(paths).toHaveLength(2);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
    });

    it('uses the explicit dismissal route before refreshing uncertain delivery state', async () => {
        const sessionId = 's_test_dismiss_uncertain';
        const localId = 'dismiss-uncertain';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
            text: 'uncertain', rawRecord: { role: 'user', content: { type: 'text', text: 'uncertain' }, meta: {} },
        });
        const paths: string[] = [];

        await dismissPendingDeliveryV2({
            sessionId,
            pendingId: localId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path) => {
                paths.push(path);
                return path.endsWith('/delivery/dismiss')
                    ? new Response(null, { status: 204 })
                    : Response.json({ pending: [] });
            },
        });

        expect(paths).toEqual([
            `/v2/sessions/${sessionId}/pending/${localId}/delivery/dismiss`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
    });

    it('blocks the exact canonical local id before refreshing its current owner scope', async () => {
        const sessionId = 's_test_block_external_handoff';
        const localId = 'block-external';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: `server-projection:${localId}`, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'blocked', rawRecord: { role: 'user', content: { type: 'text', text: 'blocked' }, meta: {} },
        });
        const calls: Array<Readonly<{ path: string; init?: RequestInit }>> = [];

        await blockPendingDeliveryV2({
            sessionId,
            pendingId: `server-projection:${localId}`,
            reason: 'provider_unavailable_before_acceptance',
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path, init) => {
                calls.push({ path, init });
                return path.endsWith('/delivery/block')
                    ? new Response(null, { status: 204 })
                    : Response.json({ pending: [] });
            },
        });

        expect(calls.map(({ path }) => path)).toEqual([
            `/v2/sessions/${sessionId}/pending/${localId}/delivery/block`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
        ]);
        expect(calls[0]?.init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ reason: 'provider_unavailable_before_acceptance' }),
        });
    });

    it('preserves canonical authentication error mapping when delivery blocking is rejected', async () => {
        const sessionId = 's_test_block_auth_failure';
        const localId = 'block-auth-failure';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'blocked', rawRecord: { role: 'user', content: { type: 'text', text: 'blocked' }, meta: {} },
        });

        await expectNotAuthenticated(blockPendingDeliveryV2({
            sessionId,
            pendingId: localId,
            reason: 'delivery_outcome_uncertain',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
        }), 401);
    });

    it('handles the canonical server projection without retiring a diagnostic ordered before it', async () => {
        const sessionId = 's_test_handled_skips_quarantine_diagnostic';
        const localId = 'handled-skips-quarantine-diagnostic';
        const diagnosticRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'diagnostic' }, meta: {} };
        const serverRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'external' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        await savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'diagnostic', rawRecord: diagnosticRawRecord,
            // Persistence boundary: retained custody from an unsupported writer.
            operation: 'future-operation' as never,
            request: { v: 1, body: JSON.stringify({
                localId, content: { t: 'plain', v: diagnosticRawRecord }, messageRole: 'user',
                requestedAction: { v: 1, kind: 'enqueue' },
            }) },
        }, outboxScope);
        await replayPersistedPendingOutboxForSession(sessionId, outboxScope);
        const quarantinedCustody = await loadPendingOutboxForSession(sessionId, outboxScope);
        expect(quarantinedCustody).toEqual([expect.objectContaining({
            localId, operation: 'quarantined', quarantineReason: 'unsupported_persisted_operation',
        })]);
        const diagnostic = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(diagnostic).toMatchObject({
            localId, text: 'diagnostic', rawRecord: diagnosticRawRecord,
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 2, updatedAt: 2, pendingOutboxScope: outboxScope,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'external', rawRecord: serverRawRecord,
        });

        const paths: string[] = [];
        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId: localId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (path) => {
                paths.push(path);
                if (path.endsWith('/delivery/handled')) return new Response(null, { status: 204 });
                // Observe retirement before refresh can reconstruct the diagnostic from custody.
                expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([diagnostic]);
                return Response.json({ pending: [] });
            },
        });

        expect(paths).toEqual([
            `/v2/sessions/${sessionId}/pending/${localId}/delivery/handled`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([diagnostic]);
        expect(await loadPendingOutboxForSession(sessionId, outboxScope)).toEqual(quarantinedCustody);
    });

    it.each(['.', '..'])('rejects opaque pending id %j before issuing a request', async (pendingId) => {
        const sessionId = `s_test_invalid_path_${pendingId.length}`;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'invalid path',
            rawRecord: { role: 'user', content: { type: 'text', text: 'invalid path' }, meta: {} },
        });
        let requestCount = 0;

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                requestCount += 1;
                return new Response(null, { status: 204 });
            },
        })).rejects.toThrow('Pending message ID is invalid');
        expect(requestCount).toBe(0);
    });

    it.each(['.', '..'])('rejects collection enqueue id %j before persistence or request', async (localId) => {
        const sessionId = `s_test_invalid_collection_${localId.length}`;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        let requestCount = 0;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'invalid collection id',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope,
            request: async () => {
                requestCount += 1;
                return Response.json({ pending: {} });
            },
        })).rejects.toThrow('Pending message ID is invalid');

        expect(requestCount).toBe(0);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('treats direct server DELETE 404 as confirmed absence', async () => {
        const sessionId = 's_test_direct_delete_404';
        const pendingId = 'already-absent';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'already absent',
            rawRecord: { role: 'user', content: { type: 'text', text: 'already absent' }, meta: {} },
        });

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => new Response(null, { status: 404 }),
        })).resolves.toBeUndefined();

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('treats discarded DELETE 404 as confirmed absence', async () => {
        const sessionId = 's_test_discarded_delete_404';
        const discarded = { ...buildDiscardedPendingMessage(), id: 'gone', localId: 'gone' };
        storage.getState().applyPendingSnapshot(sessionId, { messages: [], discarded: [discarded] });
        let requestCount = 0;

        await expect(deleteDiscardedPendingMessageV2Impl({
            sessionId,
            pendingId: 'gone',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => {
                requestCount += 1;
                return requestCount === 1
                    ? new Response(null, { status: 404 })
                    : Response.json({ pending: [] });
            },
        })).resolves.toBeUndefined();

        expect(requestCount).toBe(2);
        expect(storage.getState().sessionPending[sessionId]?.discarded ?? []).toEqual([]);
    });

    it.each([401, 403] as const)('retains an ambiguous enqueue after retry auth failure %s', async (status) => {
        const sessionId = `s_test_retry_pending_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'local-pending-auth', localId: 'local-pending-auth', createdAt: 111, updatedAt: 111,
            source: 'local_outbound', deliveryStatus: 'queued', sendState: 'unconfirmed', text: 'retry after auth',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry after auth' }, meta: {} },
            pendingOutboxScope: outboxScope,
        } as any);
        (await savePendingOutboxMessage({
            sessionId, localId: 'local-pending-auth', createdAt: 111, text: 'retry after auth',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retry after auth' }, meta: {} },
            request: { v: 1, body: '{"localId":"local-pending-auth","content":{"t":"plain","v":{}},"messageRole":"user"}' },
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

    it('keeps canonical reorder localIds independent of a quarantined projection-id collider', async () => {
        const sessionId = 's_test_reorder_canonical_local_id_collision';
        const canonicalLocalId = 'reorder-canonical-local-id';
        const secondLocalId = 'reorder-second-local-id';
        const colliderLocalId = 'reorder-quarantined-collider-local-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined collider' }, meta: {} };
        (await savePendingOutboxMessage({
            sessionId,
            localId: colliderLocalId,
            createdAt: 1,
            text: 'quarantined collider',
            rawRecord,
            operation: 'future-operation' as never,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId: colliderLocalId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, outboxScope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalLocalId,
            localId: colliderLocalId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
            pendingOutboxScope: outboxScope,
            pendingOutboxOperation: undefined,
            sendState: undefined,
            text: 'quarantined collider',
            rawRecord,
        });

        const quarantinedCustody = await loadPendingOutboxForSession(sessionId, outboxScope);
        expect(quarantinedCustody).toEqual([expect.objectContaining({
            localId: colliderLocalId, operation: 'quarantined', quarantineReason: 'unsupported_persisted_operation',
        })]);
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        for (const [id, localId] of [
            ['reorder-canonical-projection', canonicalLocalId],
            ['reorder-second-projection', secondLocalId],
        ] as const) {
            storage.getState().upsertPendingMessage(sessionId, {
                id, localId, createdAt: 2, updatedAt: 2,
                source: 'server_pending', pendingOutboxScope: outboxScope,
                pendingDeliveryStatus: 'server_queued', text: localId,
                rawRecord: { role: 'user', content: { type: 'text', text: localId }, meta: {} },
            });
        }
        const orderedLocalIds = [secondLocalId, canonicalLocalId];
        const paths: string[] = [];

        await reorderPendingMessagesV2({
            sessionId,
            orderedLocalIds,
            encryption: await createPendingQueueEncryption({ sessionId }),
            isOutboxScopeCurrent: () => true,
            request: async (path, init) => {
                paths.push(path);
                if (path.endsWith('/reorder')) {
                    expect(JSON.parse(String(init?.body))).toEqual({ orderedLocalIds });
                    return Response.json({});
                }
                return Response.json({ pending: orderedLocalIds.map((localId, position) => ({
                    localId, position, status: 'queued', createdAt: 2, updatedAt: 3,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: localId }, meta: {} } },
                    requestedAction: { v: 1, kind: 'enqueue' }, discardedAt: null, discardedReason: null,
                })) });
            },
        });
        expect(paths).toEqual([
            `/v2/sessions/${sessionId}/pending/reorder`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages
            .filter((message) => message.source === 'server_pending')
            .map((message) => message.localId)).toEqual(orderedLocalIds);
        expect(storage.getState().sessionPending[sessionId]?.messages).toContainEqual(expect.objectContaining({
            localId: colliderLocalId, text: 'quarantined collider', rawRecord,
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
        }));
        expect(await loadPendingOutboxForSession(sessionId, outboxScope)).toEqual(quarantinedCustody);
    });
});
