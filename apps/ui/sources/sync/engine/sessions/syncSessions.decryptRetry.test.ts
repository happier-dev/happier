import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyMessages } from './syncSessions';

function buildEncryptedApiMessage(id: string, seq: number): ApiMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            t: 'encrypted',
            c: `cipher-${id}`,
        },
        createdAt: 1_000 + seq,
    };
}

describe('fetchAndApplyMessages (encrypted decrypt retry)', () => {
    it('retries encrypted messages that previously failed to decrypt', async () => {
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [buildEncryptedApiMessage('m1', 1)],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        let canDecrypt = false;
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) => {
            return messages.map((m) => ({
                id: m.id,
                seq: m.seq,
                localId: null,
                createdAt: m.createdAt,
                content: canDecrypt
                    ? { role: 'user', content: { type: 'text', text: 'hello' } }
                    : null,
            }));
        });

        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();
        const sessionReceivedMessages = new Map<string, Set<string>>();

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(decryptMessages.mock.calls[0]?.[0]).toHaveLength(1);
        expect(applyMessages.mock.calls[0]?.[1]).toHaveLength(0);

        canDecrypt = true;

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(decryptMessages.mock.calls[1]?.[0]).toHaveLength(1);
        expect(applyMessages.mock.calls[1]?.[1]?.[0]?.id).toBe('m1');
    });
});
