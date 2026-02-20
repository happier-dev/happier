import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
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

    it('ignores decrypted rows that are not valid RawRecord user-text messages', async () => {
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
        expect(messages.map((m) => m.localId)).toEqual(['a']);
        expect(messages[0]?.text).toBe('ok');
        expect(messages[0]?.displayText).toBe('OK');
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

    it('skips malformed pending rows and keeps valid queued + discarded rows after mixed decrypt outcomes', async () => {
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
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-valid']);
        expect(pendingState?.messages[0]?.text).toBe('queued');
        expect(pendingState?.discarded.map((message) => message.localId)).toEqual(['discarded-valid']);
        expect(pendingState?.discarded[0]?.discardedReason).toBe('switch_to_local');
    });
});
