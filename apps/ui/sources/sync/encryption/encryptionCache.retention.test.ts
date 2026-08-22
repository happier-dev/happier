import { describe, expect, it } from 'vitest';

import { EncryptionCache } from './encryptionCache';
import type { DecryptedMessage } from '../domains/state/storageTypes';

/**
 * Retention contract for the decrypted-message cache.
 *
 * Ported by intent from the remote-dev investigation (2026-08-18). Measured there on a
 * warm re-open of a 307-message session: `decryptMessages.scan` reported
 * `toDecrypt: 287, cached: 20` — a 6.5% hit rate on messages decrypted moments earlier,
 * costing 2.6s. The cache was not missing; it was being emptied by its own bounds.
 *
 * This tree already owns the right bound — `maxMessageBytes`, a configurable
 * message-scoped byte budget — so the defects that remain here are the ones layered on
 * top of it:
 *
 *  1. A 1000-entry cap fires long before a 16MB byte budget, so the real resource never
 *     gets a say and one ordinary transcript evicts every other session's plaintext.
 *  2. Recency is stamped with `Date.now()`. Hundreds of inserts land inside one
 *     millisecond, every entry ties, and "oldest" degenerates into whatever iterates
 *     first — the cache evicts entries it was just asked for.
 *  3. Shedding to the byte budget calls an O(size) scan per evicted entry, so a large
 *     batch is quadratic in the number of entries it displaces.
 */

function message(id: string, text: string): DecryptedMessage {
    return {
        id,
        seq: 1,
        localId: null,
        messageRole: null,
        createdAt: 1,
        content: { role: 'agent', content: { type: 'text', text } } as never,
    } as DecryptedMessage;
}

type MessageCacheWriter = (
    messageId: string,
    data: DecryptedMessage,
    fingerprint: string,
    sessionId: string,
) => void;

function writeMessage(cache: EncryptionCache): MessageCacheWriter {
    return (messageId, data, fingerprint, sessionId) => {
        (cache.setCachedMessage as unknown as MessageCacheWriter).call(
            cache,
            messageId,
            data,
            fingerprint,
            sessionId,
        );
    };
}

describe('EncryptionCache decrypted-message retention', () => {
    it('holds a whole ordinary transcript, because the byte budget is the bound and not an entry count', () => {
        // The working set this must serve is what session retention keeps hydrated —
        // several transcripts at once — not one truncated one. Every entry here is tiny,
        // so nothing approaches the byte budget: anything missing was dropped by a count.
        const cache = new EncryptionCache({ maxMessageBytes: 32 * 1024 * 1024 });
        const write = writeMessage(cache);
        const total = 2_000;
        for (let i = 0; i < total; i += 1) {
            write(`m_${i}`, message(`m_${i}`, 'x'), 'fp', 'session-a');
        }

        let retained = 0;
        for (let i = 0; i < total; i += 1) {
            if (cache.getCachedMessage(`m_${i}`, 'fp') !== null) retained += 1;
        }
        expect(retained).toBe(total);
    });

    it('evicts what was used least recently, not whatever shares a millisecond with it', () => {
        // Everything below happens far inside one clock tick, which is exactly the
        // condition that makes a wall-clock recency stamp meaningless.
        const cache = new EncryptionCache({ maxMessageBytes: 4_000 });
        const write = writeMessage(cache);
        const body = 'y'.repeat(200);

        write('keep', message('keep', body), 'fp', 'session-a');
        for (let i = 0; i < 12; i += 1) {
            write(`filler_${i}`, message(`filler_${i}`, body), 'fp', 'session-a');
            // Reading `keep` is what makes it most recently USED.
            expect(cache.getCachedMessage('keep', 'fp')).not.toBeNull();
        }

        expect(cache.getCachedMessage('keep', 'fp')).not.toBeNull();
    });

    it('keeps the newest writes when a large batch displaces the budget', () => {
        const cache = new EncryptionCache({ maxMessageBytes: 3_000 });
        const write = writeMessage(cache);
        const body = 'z'.repeat(200);
        for (let i = 0; i < 200; i += 1) {
            write(`m_${i}`, message(`m_${i}`, body), 'fp', 'session-a');
        }

        expect(cache.getCachedMessage('m_199', 'fp')).not.toBeNull();
        expect(cache.getCachedMessage('m_0', 'fp')).toBeNull();
    });
});
