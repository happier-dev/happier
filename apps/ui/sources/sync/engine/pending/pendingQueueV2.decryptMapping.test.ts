import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { Encryption } from '@/sync/encryption/encryption';
import type { RawRecord } from '@/sync/typesRaw';

import {
    fetchAndApplyPendingMessagesV2 as fetchAndApplyPendingMessagesV2Impl,
    replayPersistedPendingOutboxForSession,
} from './pendingQueueV2';
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

    it('projects the server-owned requested action and marks malformed non-null actions', async () => {
        const sessionId = 's_pending_actions';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [
                    {
                        localId: 'send-now',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send' } } },
                        requestedAction: { v: 1, kind: 'send_now' },
                        status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
                    },
                    {
                        localId: 'malformed',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bad' } } },
                        requestedActionMalformed: true,
                        status: 'queued',
                        deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
                        position: 1, createdAt: 2, updatedAt: 2,
                    },
                ],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages[0]).toMatchObject({ pendingRequestedAction: { v: 1, kind: 'send_now' } });
        expect(messages[1]).toMatchObject({
            pendingRequestedActionMalformed: true,
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unsupported_action',
        });
        expect(messages[1]?.pendingRequestedAction).toBeUndefined();
    });

    it('maps provider-owned rows from server delivery state without local accepted delivery metadata', async () => {
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
        expect(messages.map((message) => message.localId)).toEqual(['provider-owned', 'blocked-additive']);
        expect(messages.map((message) => message.pendingDeliveryStatus)).toEqual(['server_delivering', 'blocked']);
        expect(messages.map((message) => message.deliveryStatus)).toEqual([undefined, undefined]);
        expect(messages[1]?.pendingDeliveryBlockedReason).toBe('payload_too_large');
    });

    it('prefers typed delivery status while retaining raw-field fallback', async () => {
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
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'payload_too_large',
                                deliveryStatus: { status: 'delivering', detail: 'custody_observed' },
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'raw-blocked',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'raw blocked' } } },
                                status: 'queued',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'runtime_config_blocked',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                            {
                                localId: 'typed-external-handoff',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed external handoff' } } },
                                status: 'queued',
                                deliveryState: 'external_handoff',
                                deliveryStatus: { status: 'external_handoff' },
                                position: 2,
                                createdAt: 3,
                                updatedAt: 3,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => message.localId)).toEqual(['typed-delivering', 'raw-blocked', 'typed-external-handoff']);
        expect(messages.map((message) => message.pendingDeliveryStatus)).toEqual(['server_delivering', 'blocked', 'external_handoff']);
        expect(messages[0]?.pendingDeliveryDetail).toBe('custody_observed');
        expect(messages[0]?.pendingDeliveryBlockedReason).toBeUndefined();
        expect(messages[1]?.pendingDeliveryBlockedReason).toBe('runtime_config_blocked');
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
                                discardedReason: 'switch_to_local',
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
        expect(pendingState?.discarded[0]?.discardedReason).toBe('switch_to_local');
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

    it('treats a same-ID server row with malformed content as persisted and retires enqueue custody into an explicit failure', async () => {
        const sessionId = 's_malformed_server_row_retires_custody';
        const localId = 'malformed-server-row';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'local custody' }, meta: {} };
        savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 1,
            text: 'local custody',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }),
            },
        }, outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ pending: [{
                localId,
                content: { t: 'future-content-envelope', value: 'unsupported' },
                status: 'queued',
                position: 0,
                createdAt: 2,
                updatedAt: 2,
            }] }),
        });

        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDecryptFailure: { kind: 'decrypt_failed' },
            }),
        ]);
    });
});
