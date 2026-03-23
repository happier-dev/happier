import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { fetchAndApplyMessages } from './syncSessions';

function buildApiMessage(params: { id: string; seq: number; updatedAt: number }): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: null,
        content: { t: 'encrypted', c: `cipher-${params.id}-${params.updatedAt}` },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt,
    };
}

describe('fetchAndApplyMessages (updatedAt dedupe)', () => {
    it('re-applies a previously-seen message when updatedAt increases', async () => {
        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();
        const request = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    messages: [buildApiMessage({ id: 'm1', seq: 1, updatedAt: 3_000 })],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const decryptMessages = vi.fn(async (apiMessages: ApiMessage[]) =>
            apiMessages.map((m) => ({
                id: m.id,
                seq: m.seq,
                localId: m.localId ?? null,
                createdAt: m.createdAt,
                content: { role: 'user', content: { type: 'text', text: `hello-${m.updatedAt ?? 'unknown'}` } },
            })),
        );

        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        sessionReceivedMessages.set('s1', new Map([['m1', 2_000]]));

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({ decryptMessages } as any),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(decryptMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]?.id).toBe('m1');
        expect(markMessagesLoaded).toHaveBeenCalledTimes(1);
    });
});
