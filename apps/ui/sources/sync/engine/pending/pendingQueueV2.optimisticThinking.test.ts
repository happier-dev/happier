import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';

import {
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
} from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    currentPendingEnqueueAck,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

const testOutboxScope = { serverId: 'server-test', accountId: 'account-test' } as const;
const enqueuePendingMessageV2 = (
    params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'outboxScope' | 'serverWireMode'>,
) => enqueuePendingMessageV2Impl({ ...params, outboxScope: testOutboxScope, serverWireMode: 'pending_input_v1' });
const retryPendingOutboxOperationV2 = (
    params: Omit<Parameters<typeof retryPendingOutboxOperationV2Impl>[0], 'serverWireMode'>,
) => retryPendingOutboxOperationV2Impl({ ...params, serverWireMode: 'pending_input_v1' });
const deletePendingMessageV2 = (
    params: Omit<Parameters<typeof deletePendingMessageV2Impl>[0], 'outboxScope'>,
) => deletePendingMessageV2Impl({ ...params, outboxScope: testOutboxScope });

function plainPendingBody(localId: string, text: string): string {
    return JSON.stringify({
        localId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: {} } },
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'enqueue' },
    });
}

function persistLocalPending(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    scope: ServerAccountScope;
    operation?: 'enqueue' | 'cancel';
}>): void {
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: params.text }, meta: {} };
    savePendingOutboxMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord,
        ...(params.operation ? { operation: params.operation } : {}),
        request: { v: 1, body: plainPendingBody(params.localId, params.text) },
    }, params.scope);
    storage.getState().upsertPendingMessage(params.sessionId, {
        id: params.localId,
        localId: params.localId,
        createdAt: 111,
        updatedAt: 111,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        pendingOutboxScope: params.scope,
        pendingOutboxOperation: params.operation ?? 'enqueue',
        text: params.text,
        rawRecord,
    });
}

describe('pendingQueueV2 optimistic thinking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetPendingQueueState();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('keeps optimistic thinking and marks the pending row accepted after successful enqueue', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('marks encrypted pending enqueue payloads as user messages', async () => {
        const sessionId = 's_test_encrypted_message_role';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return currentPendingEnqueueAck(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            ciphertext: expect.any(String),
            messageRole: 'user',
        }));
    });

    it('requires the server to atomically claim an external handoff before acknowledging enqueue', async () => {
        const sessionId = 's_test_external_handoff';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const bodies: unknown[] = [];

        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return currentPendingEnqueueAck(init, { deliveryStatus: { status: 'external_handoff' } });
            },
        });

        expect(bodies).toEqual([expect.objectContaining({
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
        })]);
        expect(result).toEqual({
            localId: 'voice-local-1',
            accepted: true,
            externalHandoffClaimed: true,
        });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingDeliveryStatus)
            .toBe('external_handoff');
    });

    it('fails closed when an external handoff enqueue response lacks the claimed state', async () => {
        const sessionId = 's_test_external_handoff_unclaimed';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init, { deliveryStatus: { status: 'queued' } }),
        })).resolves.toEqual({ localId: 'voice-local-1', accepted: false });
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId: 'voice-local-1', operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'voice-local-1', source: 'local_outbound' }),
        ]);
    });

    it('uses the frozen external-handoff mode when rejoining an existing outbox row', async () => {
        const sessionId = 's_test_frozen_external_handoff';
        const localId = 'voice-frozen-local';
        const rawRecord = { role: 'user', content: { type: 'text', text: 'frozen' }, meta: {} } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'frozen',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryMode: 'external_handoff',
                }),
            },
        }, testOutboxScope);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'ignored replacement',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init, {
                deliveryStatus: { status: 'external_handoff' },
            }),
        })).resolves.toEqual({
            localId,
            accepted: true,
            externalHandoffClaimed: true,
        });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingDeliveryStatus)
            .toBe('external_handoff');
    });

    it.each(['initial', 'replay'] as const)(
        'preserves a confirmed external handoff when concurrent cancellation succeeds during %s enqueue',
        async (attempt) => {
            const sessionId = `s_test_external_handoff_cancel_${attempt}`;
            const localId = `voice-cancel-${attempt}`;
            const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'provider custody' }, meta: {} };
            storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
            if (attempt === 'replay') {
                savePendingOutboxMessage({
                    sessionId,
                    localId,
                    createdAt: 111,
                    text: 'provider custody',
                    rawRecord,
                    request: {
                        v: 1,
                        body: JSON.stringify({
                            localId,
                            content: { t: 'plain', v: rawRecord },
                            messageRole: 'user',
                            requestedAction: { v: 1, kind: 'enqueue' },
                            deliveryMode: 'external_handoff',
                        }),
                    },
                }, testOutboxScope);
                replayPersistedPendingOutboxForSession(sessionId, testOutboxScope);
            }

            let postStarted!: () => void;
            const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
            let releasePost!: () => void;
            const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
            const request = async (_path: string, init?: RequestInit) => {
                if (init?.method === 'POST') {
                    postStarted();
                    await postGate;
                    return currentPendingEnqueueAck(init, { deliveryStatus: { status: 'external_handoff' } });
                }
                return new Response(null, { status: 204 });
            };
            const enqueue = attempt === 'initial'
                ? enqueuePendingMessageV2({
                    sessionId,
                    localId,
                    text: 'provider custody',
                    deliveryMode: 'external_handoff',
                    encryption: await createPendingQueueEncryption({ sessionId }),
                    request,
                })
                : retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    request,
                    outboxScope: testOutboxScope,
                });
            await postStartedGate;
            const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
            releasePost();

            await Promise.all([enqueue, cancellation]);

            expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    source: 'server_pending',
                    pendingDeliveryStatus: 'external_handoff',
                }),
            ]);
        },
    );

    it('preserves refreshed canonical external-handoff content through concurrent successful DELETE and POST acknowledgement', async () => {
        const sessionId = 's_test_external_handoff_refresh_delete_race';
        const localId = 'voice-refresh-delete';
        const localRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'local auxiliary content' },
            meta: {},
        };
        const serverRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'canonical server content' },
            meta: { canonical: true },
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                postStarted();
                await postGate;
                return currentPendingEnqueueAck(init, { deliveryStatus: { status: 'external_handoff' } });
            }
            if (init?.method === 'DELETE') return new Response(null, { status: 204 });
            return Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: serverRawRecord },
                    status: 'queued',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: localRawRecord.content.text,
            deliveryMode: 'external_handoff',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request,
        });
        await postStartedGate;
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(18)),
            request,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
        });
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
        await deletePendingMessageV2({ sessionId, pendingId: localId, request });
        releasePost();
        await enqueue;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: serverRawRecord.content.text,
                rawRecord: serverRawRecord,
            }),
        ]);
    });

    it('keeps a newly enqueued pending row in queued delivery state until the server accepts it', async () => {
        const sessionId = 's_test_delivery_state';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                await requestGate;
                return currentPendingEnqueueAck(init);
            },
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('queued');

        acceptRequest();
        await promise;

        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('notifies when the local pending row is projected before the server accepts it', async () => {
        const sessionId = 's_test_projection_notify';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });
        const localProjections: Array<{ localId: string; acceptedRows: number }> = [];

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                await requestGate;
                return currentPendingEnqueueAck(init);
            },
            onLocalPendingProjectionCreated: ({ localId }) => {
                localProjections.push({
                    localId,
                    acceptedRows: (storage.getState().sessionPending[sessionId]?.messages ?? [])
                        .filter((message) => message.deliveryStatus === 'accepted').length,
                });
            },
        });

        expect(localProjections).toEqual([{
            localId: expect.any(String),
            acceptedRows: 0,
        }]);

        acceptRequest();
        await promise;

        expect(localProjections).toHaveLength(1);
    });

    it('durably records remove while POST is held and reloads as cancel before scoped DELETE', async () => {
        const sessionId = 's_test_delete_during_enqueue';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => {
            postStarted = resolve;
        });
        let releaseRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST') {
                postStarted();
                await requestGate;
                return currentPendingEnqueueAck(init);
            }
            return new Response(null, { status: 200 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            text: 'delete me',
            encryption,
            request,
        });

        const localId = storage.getState().sessionPending[sessionId]?.messages[0]?.localId;
        expect(localId).toEqual(expect.any(String));

        await postStartedGate;

        const deletePromise = deletePendingMessageV2({
            sessionId,
            pendingId: localId!,
            request,
        });

        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);

        storage.getState().removePendingMessage(sessionId, localId!);
        replayPersistedPendingOutboxForSession(sessionId, testOutboxScope);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, pendingOutboxOperation: 'cancel' }),
        ]);

        releaseRequest();
        const [enqueueResult] = await Promise.all([enqueuePromise, deletePromise]);

        expect(enqueueResult).toEqual({ localId, accepted: true, cancelled: true });
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(requestCalls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
        ]);
    });

    it('suppresses a queued POST when remove becomes durable before that operation starts', async () => {
        const sessionId = 's_test_delete_before_post';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        let releaseFirstPost!: () => void;
        const firstPostGate = new Promise<void>((resolve) => {
            releaseFirstPost = resolve;
        });
        let firstPostStarted!: () => void;
        const firstPostStartedGate = new Promise<void>((resolve) => {
            firstPostStarted = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST' && path.endsWith('/pending')) {
                firstPostStarted();
                await firstPostGate;
                return currentPendingEnqueueAck(init);
            }
            return new Response(null, { status: 200 });
        };

        const firstEnqueue = enqueuePendingMessageV2({
            sessionId,
            localId: 'first-local',
            text: 'first',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            request,
        });
        await firstPostStartedGate;

        persistLocalPending({ sessionId, localId: 'second-local', text: 'second', scope: testOutboxScope });
        const queuedRetry = retryPendingOutboxOperationV2({
            sessionId,
            localId: 'second-local',
            request,
            outboxScope: testOutboxScope,
        });
        const remove = deletePendingMessageV2({ sessionId, pendingId: 'second-local', request });

        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual(expect.arrayContaining([
            expect.objectContaining({ localId: 'second-local', operation: 'cancel' }),
        ]));

        releaseFirstPost();
        await Promise.all([firstEnqueue, queuedRetry, remove]);

        expect(requestCalls.filter((call) => call.method === 'POST')).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
        ]);
        expect(requestCalls).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/second-local`,
            method: 'DELETE',
        });
    });

    it('keeps remove authoritative when an empty refresh lands before the first envelope is persisted', async () => {
        const sessionId = 's_test_delete_during_encryption';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => {
            encryptionStarted = resolve;
        });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => {
            releaseEncryption = resolve;
        });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    return 'cipher-after-remove';
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'GET') {
                return new Response(JSON.stringify({ pending: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(null, { status: 200 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            localId: 'encrypting-local',
            text: 'remove before persistence',
            encryption,
            request,
        });
        await encryptionStartedGate;
        const removePromise = deletePendingMessageV2({
            sessionId,
            pendingId: 'encrypting-local',
            request,
        });
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
        });
        releaseEncryption();
        await Promise.all([enqueuePromise, removePromise]);

        expect(requestCalls.filter((call) => call.method === 'POST')).toEqual([]);
        expect(requestCalls).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/encrypting-local`,
            method: 'DELETE',
        });

    });

    it('canonicalizes a collision-allocated scoped projection id before cancelling pre-persistence custody', async () => {
        const sessionId = 's_test_delete_during_encryption_projection_collision';
        const localId = 'encrypting-projection-collision';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'unscoped server collision' },
            meta: {},
        };
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId: 'unrelated-unscoped-local',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'unscoped server collision',
            rawRecord,
        });

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => {
            encryptionStarted = resolve;
        });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => {
            releaseEncryption = resolve;
        });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    return 'cipher-after-colliding-remove';
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            return new Response(null, { status: 200 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'remove exact scoped enqueue before persistence',
            encryption,
            request,
        });
        await encryptionStartedGate;

        const exactScopedProjection = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.localId === localId
            && message.pendingOutboxScope?.serverId === testOutboxScope.serverId
            && message.pendingOutboxScope?.accountId === testOutboxScope.accountId);
        expect(exactScopedProjection).toMatchObject({
            source: 'local_outbound',
            deliveryStatus: 'queued',
        });
        expect(exactScopedProjection?.id).not.toBe(localId);

        const removePromise = deletePendingMessageV2({
            sessionId,
            pendingId: exactScopedProjection!.id,
            request,
        });
        releaseEncryption();
        await Promise.all([enqueuePromise, removePromise]);

        expect(requestCalls.filter((call) => call.method === 'POST')).toEqual([]);
        expect(requestCalls).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/${localId}`,
            method: 'DELETE',
        });
    });

    it('invalidates an older in-flight snapshot before successful enqueue retires local custody', async () => {
        const sessionId = 's_test_enqueue_invalidates_snapshot';
        const localId = 'newly-accepted-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => 'newly-accepted-ciphertext',
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'older row' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const olderRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId: 'older-row',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: 'older-ciphertext' },
                    status: 'queued',
                    position: 0,
                    createdAt: 100,
                    updatedAt: 100,
                }],
            }),
        });
        await decryptStartedGate;

        await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'newly accepted',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });
        releaseDecrypt();
        await olderRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'newly accepted', deliveryStatus: 'accepted' }),
        ]);
    });

    it('invalidates an older in-flight empty snapshot before successful retry retires local custody', async () => {
        const sessionId = 's_test_retry_invalidates_snapshot';
        const localId = 'newly-accepted-retry-local';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        persistLocalPending({
            sessionId,
            localId,
            text: 'newly accepted retry',
            scope: testOutboxScope,
        });
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 22 });
        let refreshStarted!: () => void;
        const refreshStartedGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const olderRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => {
                refreshStarted();
                await refreshGate;
                return Response.json({ pending: [] });
            },
        });
        await refreshStartedGate;

        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: testOutboxScope,
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });
        releaseRefresh();
        await olderRefresh;

        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                text: 'newly accepted retry',
                deliveryStatus: 'accepted',
            }),
        ]);
    });

    it.each(['partial', 'complete'] as const)(
        'requires a captured snapshot to represent every accepted retry localId after capture (%s)',
        async (snapshotShape) => {
            const sessionId = `s_test_retry_multi_accept_${snapshotShape}`;
            const localIds = ['accepted-after-capture-a', 'accepted-after-capture-b'] as const;
            storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
            for (const localId of localIds) {
                persistLocalPending({
                    sessionId,
                    localId,
                    text: `local ${localId}`,
                    scope: testOutboxScope,
                });
            }
            const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 23 });
            let refreshStarted!: () => void;
            const refreshStartedGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
            let releaseRefresh!: () => void;
            const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
            const snapshotLocalIds = snapshotShape === 'complete' ? localIds : localIds.slice(0, 1);
            const olderRefresh = fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                outboxScope: testOutboxScope,
                isOutboxScopeCurrent: () => true,
                request: async () => {
                    refreshStarted();
                    await refreshGate;
                    return Response.json({
                        pending: snapshotLocalIds.map((localId, position) => ({
                            localId,
                            messageRole: 'user',
                            content: {
                                t: 'plain',
                                v: {
                                    role: 'user',
                                    content: { type: 'text', text: `canonical ${localId}` },
                                    meta: {},
                                },
                            },
                            status: 'queued',
                            position,
                            createdAt: 100 + position,
                            updatedAt: 100 + position,
                        })),
                    });
                },
            });
            await refreshStartedGate;

            for (const localId of localIds) {
                await retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    outboxScope: testOutboxScope,
                    request: async (_path, init) => currentPendingEnqueueAck(init),
                });
            }
            releaseRefresh();
            await olderRefresh;

            expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual(
                expect.arrayContaining(localIds.map((localId) => expect.objectContaining({
                    localId,
                    source: snapshotShape === 'complete' ? 'server_pending' : 'local_outbound',
                    text: `${snapshotShape === 'complete' ? 'canonical' : 'local'} ${localId}`,
                }))),
            );
            expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(2);
        },
    );

    it('clears cancellation intent when encryption fails before the outbox row exists', async () => {
        const sessionId = 's_test_cancel_before_failed_encryption';
        const localId = 'failed-encryption-local';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
        const failingEncryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    throw new Error('encryption failed before persistence');
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requests: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push({ path, method: init?.method });
            return currentPendingEnqueueAck(init);
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'will fail before persistence',
            encryption: failingEncryption,
            request,
        });
        await encryptionStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        releaseEncryption();
        await expect(enqueue).rejects.toThrow('encryption failed before persistence');
        await expect(cancellation).resolves.toBeUndefined();

        await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'reuse after failed persistence',
            encryption: await createPendingQueueEncryption({ sessionId, seedByte: 19 }),
            request,
        });
        expect(requests.filter((call) => call.method === 'POST')).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
        ]);
    });

    it('does not apply a server snapshot captured before a confirmed deletion', async () => {
        const sessionId = 's_test_stale_snapshot_after_delete';
        const localId = 'stale-delete-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => 'unused',
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'stale snapshot' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'encrypted', c: 'cipher-before-delete' },
                    messageRole: 'user',
                    status: 'queued',
                    position: 0,
                    createdAt: 111,
                    updatedAt: 111,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;
        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => new Response(null, { status: 200 }),
        });
        releaseDecrypt();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not resurrect a discarded row captured before its confirmed deletion', async () => {
        const sessionId = 's_test_stale_discarded_snapshot_after_delete';
        const localId = 'stale-discarded-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => 'unused',
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'stale discarded' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const staleRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'encrypted', c: 'discarded-cipher-before-delete' },
                    messageRole: 'user',
                    status: 'discarded',
                    position: 0,
                    createdAt: 111,
                    updatedAt: 112,
                    discardedAt: 112,
                    discardedReason: 'manual',
                }],
            }),
        });
        await decryptStartedGate;
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId: localId,
            encryption,
            outboxScope: testOutboxScope,
            request: async (_path, init) => init?.method === 'DELETE'
                ? new Response(null, { status: 200 })
                : Response.json({ pending: [] }),
        });
        releaseDecrypt();
        await staleRefresh;

        expect(storage.getState().sessionPending[sessionId]?.discarded ?? []).toEqual([]);
    });

    it('lets the exact-scope server row retire colliding durable enqueue custody', async () => {
        const sessionId = 's_test_scoped_refresh_collision';
        const localId = 'same-refresh-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        persistLocalPending({
            sessionId,
            localId,
            text: 'durable projection',
            scope: testOutboxScope,
        });
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(JSON.stringify({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'server projection' }, meta: {} },
                    },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 222,
                }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'server projection',
                pendingOutboxScope: testOutboxScope,
                pendingDeliveryStatus: 'server_queued',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
    });

    it('publishes server-discarded authority while retaining durable cancellation custody', async () => {
        const sessionId = 's_test_scoped_discarded_collision';
        const localId = 'same-discarded-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        persistLocalPending({
            sessionId,
            localId,
            text: 'durable cancellation',
            scope: testOutboxScope,
            operation: 'cancel',
        });
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(JSON.stringify({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'server discarded row' }, meta: {} },
                    },
                    status: 'discarded',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: 223,
                    discardedReason: 'manual',
                }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        expect(storage.getState().sessionPending[sessionId]).toEqual(expect.objectContaining({
            messages: [],
            discarded: [expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'server discarded row',
                pendingOutboxScope: testOutboxScope,
            })],
        }));
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
    });

    it('follows an ambiguously committed held POST with DELETE and retains cancel until confirmation', async () => {
        const sessionId = 's_test_ambiguous_post_then_delete';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 14 });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => {
            postStarted = resolve;
        });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST') {
                postStarted();
                await postGate;
                throw new TypeError('response lost after commit');
            }
            return new Response(null, { status: 404 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            localId: 'ambiguous-local',
            text: 'possibly committed',
            encryption,
            request,
        });
        await postStartedGate;
        const removePromise = deletePendingMessageV2({ sessionId, pendingId: 'ambiguous-local', request });
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId: 'ambiguous-local', operation: 'cancel' }),
        ]);

        releasePost();
        await expect(enqueuePromise).resolves.toEqual({ localId: 'ambiguous-local', accepted: false });
        await expect(removePromise).resolves.toBeUndefined();
        expect(requestCalls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/ambiguous-local`, method: 'DELETE' },
        ]);
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
    });

    it('serializes server-owned retained-outbox cancellation behind an in-flight POST', async () => {
        const sessionId = 's_test_server_owned_cancel_behind_post';
        const localId = 'server-owned-held-post';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const calls: Array<{ method: string | undefined; path: string }> = [];
        const request = async (path: string, init?: RequestInit) => {
            calls.push({ method: init?.method, path });
            if (init?.method === 'POST') {
                postStarted();
                await postGate;
                return currentPendingEnqueueAck(init);
            }
            return new Response(null, { status: 404 });
        };
        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'held post',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            request,
        });
        await postStartedGate;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'server authoritative',
            rawRecord: { role: 'user', content: { type: 'text', text: 'server authoritative' }, meta: {} },
        });

        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect(calls).toEqual([{ path: `/v2/sessions/${sessionId}/pending`, method: 'POST' }]);

        releasePost();
        await expect(enqueue).resolves.toMatchObject({ accepted: true, cancelled: true });
        await expect(cancellation).resolves.toBeUndefined();
        expect(calls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
        ]);
        expect(loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not share operation ordering or cancellation across server-account scopes', async () => {
        const sessionId = 'same-session';
        const localId = 'same-local';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        persistLocalPending({ sessionId, localId, text: 'cancel A', scope: scopeA });

        let deleteAStarted!: () => void;
        const deleteAStartedGate = new Promise<void>((resolve) => {
            deleteAStarted = resolve;
        });
        let releaseDeleteA!: () => void;
        const deleteAGate = new Promise<void>((resolve) => {
            releaseDeleteA = resolve;
        });
        const deleteA = deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            outboxScope: scopeA,
            request: async (_path, init) => {
                if (init?.method === 'DELETE') {
                    deleteAStarted();
                    await deleteAGate;
                }
                return new Response(null, { status: 200 });
            },
        });
        await deleteAStartedGate;

        let scopeBPostCount = 0;
        const enqueueB = enqueuePendingMessageV2Impl({
            serverWireMode: 'pending_input_v1',
            sessionId,
            localId,
            text: 'send B',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            outboxScope: scopeB,
            request: async (_path, init) => {
                if (init?.method === 'POST') {
                    scopeBPostCount += 1;
                    return currentPendingEnqueueAck(init);
                }
                return new Response(null, { status: 200 });
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(scopeBPostCount).toBe(1);
        await enqueueB;
        expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([]);

        releaseDeleteA();
        await Promise.all([deleteA, enqueueB]);
    });

    it('does not remove another scope projection when scoped cancellation completes', async () => {
        const sessionId = 'same-session-cancel-projection';
        const localId = 'same-local-cancel-projection';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        persistLocalPending({ sessionId, localId, text: 'cancel A', scope: scopeA });

        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const cancellation = deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            outboxScope: scopeA,
            request: async (_path, init) => {
                if (init?.method === 'DELETE') {
                    deleteStarted();
                    await deleteGate;
                }
                return new Response(null, { status: 200 });
            },
        });
        await deleteStartedGate;

        persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB });
        releaseDelete();
        await cancellation;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([
            expect.objectContaining({ localId, text: 'keep B', operation: 'enqueue' }),
        ]);
    });

    it('does not start cancellation from a colliding projection owned by another scope', async () => {
        const sessionId = 'same-session-cancel-entry';
        const localId = 'same-local-cancel-entry';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB });
        const request = vi.fn(async () => new Response(null, { status: 200 }));

        await deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            request,
            outboxScope: scopeA,
        });

        expect(request).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scopeB)).toHaveLength(1);
    });

    it('does not replace another scope projection when scoped enqueue is accepted', async () => {
        const sessionId = 'same-session-accept-projection';
        const localId = 'same-local-accept-projection';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const enqueueA = enqueuePendingMessageV2Impl({
            serverWireMode: 'pending_input_v1',
            sessionId,
            localId,
            text: 'accept A',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            outboxScope: scopeA,
            request: async (_path, init) => {
                if (init?.method === 'POST') {
                    postStarted();
                    await postGate;
                    return currentPendingEnqueueAck(init);
                }
                return new Response(null, { status: 200 });
            },
        });
        await postStartedGate;

        persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB });
        releasePost();
        await enqueueA;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([
            expect.objectContaining({ localId, text: 'keep B', operation: 'enqueue' }),
        ]);
    });

    it('keeps queued pending messages in call order even when earlier encryption resolves later', async () => {
        const sessionId = 's_test_enqueue_order';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = () => resolve();
        });

        const requestCiphertexts: string[] = [];
        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async (rawRecord: any) => {
                        const text = rawRecord?.content?.text;
                        if (text === 'first') {
                            await firstGate;
                        }
                        return `cipher-${String(text)}`;
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        const request = async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? 'null')) as any;
            requestCiphertexts.push(String(body?.ciphertext ?? ''));
            return currentPendingEnqueueAck(init);
        };

        const promiseFirst = enqueuePendingMessageV2({
            sessionId,
            text: 'first',
            encryption,
            request,
        });
        const promiseSecond = enqueuePendingMessageV2({
            sessionId,
            text: 'second',
            encryption,
            request,
        });

        releaseFirst();

        await Promise.all([promiseFirst, promiseSecond]);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((m) => m.text)).toEqual(['first', 'second']);
        expect(requestCiphertexts).toEqual(['cipher-first', 'cipher-second']);
    });

    it('coalesces concurrent enqueues that share one explicit local ID', async () => {
        const sessionId = 's_test_concurrent_same_local_id';
        const localId = 'same-explicit-local';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const bodies: unknown[] = [];
        let firstPostStarted!: () => void;
        const firstPostStartedGate = new Promise<void>((resolve) => { firstPostStarted = resolve; });
        let releaseFirstPost!: () => void;
        const firstPostGate = new Promise<void>((resolve) => { releaseFirstPost = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body ?? 'null')));
            if (bodies.length === 1) {
                firstPostStarted();
                await firstPostGate;
            }
            return currentPendingEnqueueAck(init);
        };
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 23 });

        const first = enqueuePendingMessageV2({ sessionId, localId, text: 'first identity owner', encryption, request });
        const second = enqueuePendingMessageV2({ sessionId, localId, text: 'must rejoin first', encryption, request });
        await firstPostStartedGate;
        releaseFirstPost();
        await Promise.all([first, second]);

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            localId,
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({ content: expect.objectContaining({ text: 'first identity owner' }) }),
            }),
        }));
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'first identity owner' }),
        ]);
    });

    it('clears optimistic thinking when encryption fails', async () => {
        const sessionId = 's_test_encrypt_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async () => {
                        throw new Error('encrypt-failed');
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init),
        }).catch(() => null);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('includes provider-specific message meta extras for queued sends', async () => {
        const sessionId = 's_test_provider_meta';
        storage.getState().applySessions([
            {
                ...buildSession({ sessionId }),
                metadata: { path: '/tmp', host: 'h', flavor: 'claude' } as Session['metadata'],
            },
        ]);
        storage.setState(
            {
                ...storage.getState(),
                settings: settingsParse({
                    claudeRemoteAgentSdkEnabled: true,
                    claudeRemoteSettingSourcesV2: ['project'],
                }),
            },
            true,
        );

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect(metadata?.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(metadata?.claudeRemoteSettingSources).toBe('project');
        expect(metadata?.claudeRemoteSettingSourcesV2).toEqual(['project']);
    });

    it('includes metaOverrides (e.g. meta.happier) for queued sends', async () => {
        const sessionId = 's_test_meta_overrides';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId, comments: [] },
                },
            },
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect((metadata as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('removes queued pending message and clears optimistic thinking when enqueue request fails', async () => {
        const sessionId = 's_test_request_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status: 500 }),
            }),
        ).rejects.toThrow('Failed to enqueue pending message (500)');

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sends plaintext pending payloads when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return currentPendingEnqueueAck(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });

    it('does not require a session encryption key when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send_no_key';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        const bodies: unknown[] = [];
        const encryptionWithoutSessionKey = {
            getSessionEncryption: () => null,
        } as unknown as Encryption;
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption: encryptionWithoutSessionKey,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return currentPendingEnqueueAck(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });

    it('maps the full server snapshot before the final delete tombstone publication so a failed DELETE restores its row', async () => {
        const sessionId = 's_failed_delete_refresh_race';
        const localId = 'delete-refresh-target';
        const blockerId = 'delete-refresh-blocker';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'authoritative',
            rawRecord: { role: 'user', content: { type: 'text', text: 'authoritative' }, meta: {} },
        });
        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
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

        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'blocker' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [
                {
                    localId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'authoritative' }, meta: {} } },
                    status: 'queued', position: 0, createdAt: 1, updatedAt: 2,
                },
                {
                    localId: blockerId,
                    content: { t: 'encrypted', c: 'held-ciphertext' },
                    status: 'queued', position: 1, createdAt: 2, updatedAt: 2,
                },
            ] }),
        });
        await decryptStartedGate;
        releaseDelete();
        await expect(deletion).rejects.toThrow('Failed to fetch');
        releaseDecrypt();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.localId)).toEqual([
            localId,
            blockerId,
        ]);
    });
});
