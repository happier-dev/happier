import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import type { RawRecord } from '@/sync/typesRaw';

import { fetchAndApplyPendingMessagesV2 as fetchAndApplyPendingMessagesV2Impl } from './pendingQueueV2';
import {
    createPendingQueueEncryption,
    encryptRawRecordForPending,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-test', accountId: 'account-test' } as const;
const fetchAndApplyPendingMessagesV2 = (
    params: Omit<Parameters<typeof fetchAndApplyPendingMessagesV2Impl>[0], 'outboxScope'>,
) => fetchAndApplyPendingMessagesV2Impl({
    ...params,
    outboxScope,
    isOutboxScopeCurrent: () => true,
});

describe('pendingQueueV2 decrypt mapping', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it('retains decrypted rows that cannot be coerced to a RawRecord user-text message as explicit failures', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });

        const valid: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'ok' },
            meta: { displayText: 'OK' },
        };
        const validCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: valid,
        });

        const invalidCiphertext = await sessionEncryption.encryptRaw({
            content: { text: 'should-not-render' },
            meta: { displayText: 'bad' },
        });

        const responseJson = {
            pending: [
                {
                    localId: 'a',
                    content: { t: 'encrypted', c: validCiphertext },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    localId: 'b',
                    content: { t: 'encrypted', c: invalidCiphertext },
                    status: 'queued',
                    position: 1,
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify(responseJson), { status: 200 }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((m) => m.localId)).toEqual(['a', 'b']);
        expect(messages[0]?.text).toBe('ok');
        expect(messages[0]?.displayText).toBe('OK');
        expect(messages[1]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
    });

    it('maps plaintext pending rows without decrypting', async () => {
        const sessionId = 's_plain_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        const responseJson = {
            pending: [
                {
                    localId: 'a',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify(responseJson), { status: 200 }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((m) => m.localId)).toEqual(['a']);
        expect(messages[0]?.text).toBe('ok');
    });

    it('hides a send-as-new idempotency tombstone returned by an older server', async () => {
        const sessionId = 's_send_as_new_compat';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [
                    {
                        localId: 'replacement',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send once' } } },
                        status: 'queued',
                        position: 1,
                        createdAt: 2,
                        updatedAt: 2,
                    },
                    {
                        localId: 'original',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send once' } } },
                        status: 'discarded',
                        discardedReason: 'resent_as_new',
                        position: 0,
                        createdAt: 1,
                        updatedAt: 2,
                        discardedAt: 2,
                    },
                ],
            }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['replacement']);
        expect(pendingState?.discarded).toEqual([]);
    });

    it('retains an explicit malformed requested action as blocked unsupported work', async () => {
        const sessionId = 's_malformed_pending_action';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [{
                    localId: 'malformed-action',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'keep visible' } } },
                    requestedActionMalformed: true,
                    deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                }],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            localId: 'malformed-action',
            text: 'keep visible',
            requestedActionMalformed: true,
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unsupported_action',
        });
        expect(messages[0]?.requestedAction).toBeUndefined();
    });

    it('preserves an acknowledged local external handoff across an empty refresh', async () => {
        const sessionId = 's_external_handoff_empty_refresh';
        const encryption = await createPendingQueueEncryption({ sessionId });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-local',
            localId: 'external-local',
            createdAt: 1,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: outboxScope,
            text: 'still unresolved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'still unresolved' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-other-account',
            localId: 'external-other-account',
            createdAt: 1,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: { serverId: 'server-test', accountId: 'other-account' },
            text: 'must not leak',
            rawRecord: { role: 'user', content: { type: 'text', text: 'must not leak' }, meta: {} },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId: 'external-local',
                pendingDeliveryStatus: 'external_handoff',
                text: 'still unresolved',
            }),
        ]);
    });

    it('reallocates retained external-handoff and legacy-unscoped projections that collide with server rows', async () => {
        const sessionId = 's_external_handoff_server_projection_collision';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const serverLocalId = 'server-local-id';
        const externalLocalId = 'external-local-id';
        const legacyServerLocalId = 'legacy-server-local-id';
        const legacyLocalId = 'legacy-local-id';
        const externalRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'retained handoff content' },
            meta: { custody: 'external' },
        };
        storage.getState().upsertPendingMessage(sessionId, {
            id: serverLocalId,
            localId: externalLocalId,
            createdAt: 1,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: outboxScope,
            text: 'retained handoff content',
            rawRecord: externalRawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: legacyServerLocalId,
            localId: legacyLocalId,
            createdAt: 1,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            text: 'retained legacy content',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retained legacy content' },
                meta: { custody: 'legacy' },
            },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [
                    {
                        localId: serverLocalId,
                        content: {
                            t: 'plain',
                            v: { role: 'user', content: { type: 'text', text: 'unrelated server row' } },
                        },
                        status: 'queued',
                        position: 0,
                        createdAt: 3,
                        updatedAt: 4,
                    },
                    {
                        localId: legacyServerLocalId,
                        content: {
                            t: 'plain',
                            v: { role: 'user', content: { type: 'text', text: 'another server row' } },
                        },
                        status: 'discarded',
                        position: 1,
                        createdAt: 3,
                        updatedAt: 4,
                        discardedAt: 4,
                        discardedReason: 'manual',
                    },
                ],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toHaveLength(3);
        expect(messages).toContainEqual(expect.objectContaining({
            id: serverLocalId,
            localId: serverLocalId,
            source: 'server_pending',
            text: 'unrelated server row',
        }));
        expect(messages).toContainEqual(expect.objectContaining({
            id: expect.not.stringMatching(new RegExp(`^${serverLocalId}$`)),
            localId: externalLocalId,
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: outboxScope,
            text: 'retained handoff content',
            rawRecord: externalRawRecord,
        }));
        const legacyProjection = messages.find((message) => message.localId === legacyLocalId);
        expect(legacyProjection).toEqual(expect.objectContaining({
            localId: legacyLocalId,
            text: 'retained legacy content',
            rawRecord: expect.objectContaining({ meta: { custody: 'legacy' } }),
        }));
        expect(legacyProjection?.id).not.toBe(legacyServerLocalId);
        expect(legacyProjection?.pendingOutboxScope).toBeUndefined();
        expect(storage.getState().sessionPending[sessionId]?.discarded).toContainEqual(
            expect.objectContaining({ id: legacyServerLocalId, localId: legacyServerLocalId }),
        );
    });

    it('removes a settled Pending row when the canonical server snapshot no longer retains it', async () => {
        const sessionId = 's_settled_pending_disappears';
        const encryption = await createPendingQueueEncryption({ sessionId });
        let pending = [{
            localId: 'settled-row',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'settled' } } },
            status: 'delivering',
            position: 0,
            createdAt: 1,
            updatedAt: 1,
        }];
        const request = async () => new Response(JSON.stringify({ pending }), { status: 200 });

        await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.localId))
            .toEqual(['settled-row']);

        pending = [];
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('maps old-server queued rows without delivery fields to visible server queued messages', async () => {
        const sessionId = 's_old_server_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'old-queued',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy row' } } },
                                status: 'queued',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => message.localId)).toEqual(['old-queued']);
        expect(messages[0]?.text).toBe('legacy row');
        expect((messages[0] as any)?.pendingDeliveryStatus).toBe('server_queued');
    });

    it('fails closed by keeping unknown newer pending statuses visible as blocked', async () => {
        const sessionId = 's_future_status_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'blocked-known',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'blocked known' } } },
                                status: 'blocked',
                                deliveryBlockedReason: 'terminal_host_unreachable',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'blocked-future',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'blocked future' } } },
                                status: 'awaiting_moon_phase',
                                deliveryBlockedReason: 'newer_runtime_reason',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => message.localId)).toEqual(['blocked-known', 'blocked-future']);
        expect(messages.map((message) => (message as any).pendingDeliveryStatus)).toEqual(['blocked', 'blocked']);
        expect((messages[0] as any).pendingDeliveryBlockedReason).toBe('terminal_host_unreachable');
        expect((messages[1] as any).pendingDeliveryBlockedReason).toBe('unknown');
        expect((messages[1] as any).pendingDeliveryStatusRaw).toBe('awaiting_moon_phase');
    });

    it('uses additive deliveryState over legacy queued status for mixed-version-safe rows', async () => {
        const sessionId = 's_additive_delivery_state_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'provider-owned',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'provider owned' } } },
                                status: 'queued',
                                deliveryState: 'delivering',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'blocked-additive',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'blocked additive' } } },
                                status: 'queued',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'payload_too_large',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => (message as any).pendingDeliveryStatus)).toEqual(['server_delivering', 'blocked']);
        expect(messages.map((message) => message.deliveryStatus)).toEqual([undefined, undefined]);
        expect((messages[1] as any).pendingDeliveryBlockedReason).toBe('payload_too_large');
    });

    it('uses typed deliveryStatus over raw deliveryState fields when projecting UI status', async () => {
        const sessionId = 's_typed_delivery_status_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'typed-delivering',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed delivering' } } },
                                status: 'queued',
                                deliveryState: null,
                                deliveryStatus: { status: 'delivering', detail: 'custody_observed' },
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'typed-blocked',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed blocked' } } },
                                status: 'queued',
                                deliveryState: null,
                                deliveryBlockedReason: null,
                                deliveryStatus: { status: 'blocked', reason: 'runtime_disposed_before_delivery' },
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                            {
                                localId: 'typed-queued',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed queued' } } },
                                status: 'queued',
                                deliveryState: 'delivering',
                                deliveryStatus: { status: 'queued' },
                                position: 2,
                                createdAt: 3,
                                updatedAt: 3,
                            },
                            {
                                localId: 'typed-external-handoff',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed external handoff' } } },
                                status: 'queued',
                                deliveryState: 'external_handoff',
                                deliveryStatus: { status: 'external_handoff' },
                                position: 3,
                                createdAt: 4,
                                updatedAt: 4,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => (message as any).pendingDeliveryStatus)).toEqual([
            'server_delivering',
            'blocked',
            'server_queued',
            'external_handoff',
        ]);
        expect(messages[0]?.pendingDeliveryDetail).toBe('custody_observed');
        expect((messages[1] as any).pendingDeliveryBlockedReason).toBe('runtime_disposed_before_delivery');
    });

    it('skips malformed pending rows and keeps valid rows while retaining decrypt failures explicitly', async () => {
        const sessionId = 's_test_mixed';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        const queuedRecord: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'queued' },
        };
        const discardedRecord: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'discarded' },
        };

        const queuedCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: queuedRecord,
        });
        const discardedCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: discardedRecord,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            { status: 'queued', position: 0, createdAt: 1, updatedAt: 1 }, // malformed (missing localId/content)
                            {
                                localId: 'queued-valid',
                                content: { t: 'encrypted', c: queuedCiphertext },
                                status: 'queued',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                            {
                                localId: 'queued-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'queued',
                                position: 2,
                                createdAt: 3,
                                updatedAt: 3,
                            },
                            {
                                localId: 'discarded-valid',
                                content: { t: 'encrypted', c: discardedCiphertext },
                                status: 'discarded',
                                position: 3,
                                createdAt: 4,
                                updatedAt: 4,
                                discardedAt: 5,
                                discardedReason: 'runtime_switch',
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-valid', 'queued-bad-cipher']);
        expect(pendingState?.messages[0]?.text).toBe('queued');
        expect(pendingState?.messages[1]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
        expect(pendingState?.discarded.map((message) => message.localId)).toEqual(['discarded-valid']);
        expect(pendingState?.discarded[0]?.discardedReason).toBe('runtime_switch');
    });

    it('retains queued and discarded rows with an explicit failure state when decrypt fails', async () => {
        const sessionId = 's_test_decrypt_failures';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'queued-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'queued',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'discarded-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'discarded',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                                discardedAt: 3,
                                discardedReason: 'manual',
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-bad-cipher']);
        expect(pendingState?.discarded.map((message) => message.localId)).toEqual(['discarded-bad-cipher']);

        const queuedFailure = pendingState?.messages[0] as (typeof pendingState.messages)[number] & {
            pendingDecryptFailure?: { kind: string };
        };
        const discardedFailure = pendingState?.discarded[0] as (typeof pendingState.discarded)[number] & {
            pendingDecryptFailure?: { kind: string };
        };

        expect(queuedFailure?.displayText).toBeTruthy();
        expect(queuedFailure?.text).toBe('');
        expect(queuedFailure?.pendingDecryptFailure).toEqual({ kind: 'decrypt_failed' });
        expect(discardedFailure?.displayText).toBeTruthy();
        expect(discardedFailure?.text).toBe('');
        expect(discardedFailure?.pendingDecryptFailure).toEqual({ kind: 'decrypt_failed' });
    });

    it('retains encrypted pending rows as decrypt failures when session encryption is unavailable', async () => {
        const sessionId = 's_missing_session_encryption';
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'queued-missing-key',
                                content: { t: 'encrypted', c: 'any-ciphertext' },
                                status: 'queued',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-missing-key']);
        expect(pendingState?.messages[0]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
    });
});
