import { type SessionMessageV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';

import { fetchAndApplyMessages } from './syncSessions';

function buildEncryptedApiMessage(id: string, seq: number, ciphertext: string): SessionMessageV1 {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'encrypted',
            c: ciphertext,
        },
        createdAt: 1_000 + seq,
        updatedAt: 2_000 + seq,
    };
}

describe('fetchAndApplyMessages (encrypted decrypt retry)', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        storage.getState().applySessions([createSessionFixture({
            id: 's1', encryptionMode: 'e2ee', encryptedContentAvailability: 'ready',
        })]);
    });
    afterEach(() => vi.restoreAllMocks());

    async function createEncryption(seed = 3) {
        const encryption = await Encryption.create(new Uint8Array(32).fill(seed));
        await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(seed + 1)]]));
        const sessionEncryption = encryption.getSessionEncryption('s1');
        if (!sessionEncryption) throw new Error('Encrypted Session fixture was not initialized');
        return { encryption, sessionEncryption };
    }

    it('decrypts initial transcript pages in large default batches', async () => {
        const { encryption, sessionEncryption } = await createEncryption();
        const messages = await Promise.all(Array.from({ length: 150 }, async (_, index) => {
            const id = `m${index + 1}`;
            const ciphertext = await sessionEncryption.encryptRawRecord({
                role: 'user', content: { type: 'text', text: `hello-${id}` },
            });
            return buildEncryptedApiMessage(id, index + 1, ciphertext);
        }));
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.spyOn(sessionEncryption, 'decryptMessages');

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: (id) => encryption.getSessionEncryption(id),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: (id, rows) => storage.getState().applyMessages(id, rows),
            markMessagesLoaded: (id) => storage.getState().applyMessagesLoaded(id),
            log: { log: () => {} },
        });

        expect(decryptMessages).toHaveBeenCalledTimes(3);
        expect(decryptMessages.mock.calls[0]?.[0]).toHaveLength(64);
        expect(decryptMessages.mock.calls[1]?.[0]).toHaveLength(64);
        expect(decryptMessages.mock.calls[2]?.[0]).toHaveLength(22);
        expect(Object.keys(storage.getState().sessionMessages.s1?.messagesById ?? {})).toHaveLength(150);
    });

    it('retries an unconsumed encrypted row after a content-authentication failure', async () => {
        const { encryption, sessionEncryption } = await createEncryption();
        const wrongKey = await createEncryption(9);
        const content = { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } };
        let ciphertext = await wrongKey.sessionEncryption.encryptRawRecord(content);
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [buildEncryptedApiMessage('m1', 1, ciphertext)],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        const params: Parameters<typeof fetchAndApplyMessages>[0] = {
            sessionId: 's1',
            getSessionEncryption: (id) => encryption.getSessionEncryption(id),
            request,
            sessionReceivedMessages,
            applyMessages: (id, rows) => storage.getState().applyMessages(id, rows),
            markMessagesLoaded: (id) => storage.getState().applyMessagesLoaded(id),
            log: { log: () => {} },
        };
        await expect(fetchAndApplyMessages(params)).rejects.toMatchObject({ name: 'SessionMessagePageDecryptionError' });
        expect(sessionReceivedMessages.get('s1')?.has('m1') ?? false).toBe(false);
        expect(readStoredSessionMessages(storage.getState(), 's1')).toEqual([]);

        ciphertext = await sessionEncryption.encryptRawRecord(content);
        await fetchAndApplyMessages(params);

        expect(readStoredSessionMessages(storage.getState(), 's1')).toEqual([
            expect.objectContaining({ realID: 'm1', kind: 'user-text', text: 'hello' }),
        ]);
        expect(sessionReceivedMessages.get('s1')?.has('m1')).toBe(true);
    });
});
