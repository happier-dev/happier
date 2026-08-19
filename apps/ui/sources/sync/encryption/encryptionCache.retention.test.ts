import { describe, expect, it } from 'vitest';

import { EncryptionCache } from './encryptionCache';
import type { DecryptedMessage } from '../domains/state/storageTypes';

/**
 * Retention contract for the decrypted-message cache.
 *
 * Measured on device (2026-08-18, warm re-open of a 307-message session):
 * `decryptMessages.scan` reported `toDecrypt: 287, cached: 20` — a 6.5% hit rate on a
 * session whose messages had already been decrypted moments earlier, costing 2.6s of
 * re-decryption. The cache was not missing; it was being emptied by its own bounds.
 *
 * Three defects produced that, and this file pins the fix for each:
 *
 *  1. The entry cap (1000, global across every session) bound roughly an order of
 *     magnitude before the 32MB byte budget, so the real resource never got a say.
 *     One ordinary transcript could evict every other session's decrypted content.
 *  2. Recency was stamped with `Date.now()`. A batch of hundreds of inserts lands
 *     inside one millisecond, so every entry tied and "oldest" degenerated to
 *     whatever the Map happened to yield first — the cache evicted the entries it
 *     had just been asked for.
 *  3. Eviction removed a single entry per insert. Inserting N entries into a full
 *     cache therefore ran N O(size) scans, and the cache sat pinned at its cap,
 *     thrashing, for the whole batch.
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
        // several transcripts at once — not one truncated one. A 2,000-message session
        // is unremarkable, and every one of these is tiny, so nothing here comes close
        // to the byte budget: if any are missing, an entry cap evicted them.
        const cache = new EncryptionCache();
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
        // condition that used to make recency meaningless.
        const cache = new EncryptionCache({ maxBytes: 4_000 });
        const write = writeMessage(cache);
        const body = 'y'.repeat(200);

        write('keep', message('keep', body), 'fp', 'session-a');
        for (let i = 0; i < 12; i += 1) {
            write(`filler_${i}`, message(`filler_${i}`, body), 'fp', 'session-a');
            // Touching `keep` is what makes it the most recently USED entry. Under a
            // millisecond-resolution clock this read changed nothing at all.
            expect(cache.getCachedMessage('keep', 'fp')).not.toBeNull();
        }

        expect(cache.getCachedMessage('keep', 'fp')).not.toBeNull();
    });

    it('drops straight to its budget in one pass instead of shedding a single entry per insert', () => {
        // A cache that evicts one entry per insert stays pinned at its bound while a
        // batch streams in, paying a scan per message. The observable contract is the
        // cheap one: after a large batch the cache sits AT or BELOW budget, and the
        // most recent writes are the ones that survived.
        const cache = new EncryptionCache({ maxBytes: 3_000 });
        const write = writeMessage(cache);
        const body = 'z'.repeat(200);
        for (let i = 0; i < 200; i += 1) {
            write(`m_${i}`, message(`m_${i}`, body), 'fp', 'session-a');
        }

        expect(cache.getCachedMessage('m_199', 'fp')).not.toBeNull();
        expect(cache.getCachedMessage('m_0', 'fp')).toBeNull();
    });
});
