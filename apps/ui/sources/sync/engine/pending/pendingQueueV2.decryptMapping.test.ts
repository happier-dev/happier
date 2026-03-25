import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import type { RawRecord } from '@/sync/typesRaw';

import { fetchAndApplyPendingMessagesV2 } from './pendingQueueV2';
import {
    createPendingQueueEncryption,
    encryptRawRecordForPending,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

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
});
