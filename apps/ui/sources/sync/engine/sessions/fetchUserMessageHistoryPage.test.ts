import { describe, expect, it, vi } from 'vitest';

import { fetchUserMessageHistoryPage, USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE } from './fetchUserMessageHistoryPage';

function response(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

describe('fetchUserMessageHistoryPage', () => {
    it('requests only user-role session messages using a small page size', async () => {
        const request = vi.fn(async () => response({
            messages: [
                {
                    id: 'm2',
                    seq: 2,
                    localId: null,
                    messageRole: 'user',
                    content: { t: 'encrypted', c: 'cipher-2' },
                    createdAt: 20,
                },
            ],
            hasMore: true,
            nextBeforeSeq: 2,
        }));
        const decryptMessages = vi.fn(async () => [
            {
                id: 'm2',
                seq: 2,
                localId: null,
                content: { role: 'user', content: { type: 'text', text: 'second prompt' } },
                createdAt: 20,
            },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            beforeSeq: 10,
            request,
            getSessionEncryption: () => ({ decryptMessages }),
        });

        expect(request).toHaveBeenCalledWith(
            `/v1/sessions/s1/messages?scope=main&role=user&limit=${USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE}&beforeSeq=10`,
        );
        expect(decryptMessages).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'm2', messageRole: 'user' }),
        ]);
        expect(result).toEqual({
            status: 'loaded',
            entries: [{ seq: 2, createdAt: 20, text: 'second prompt' }],
            hasMore: true,
            nextBeforeSeq: 2,
        });
    });

    it('uses plaintext envelopes without requiring session encryption', async () => {
        const request = vi.fn(async () => response({
            messages: [
                {
                    id: 'm1',
                    seq: 1,
                    localId: null,
                    messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plain prompt' } } },
                    createdAt: 10,
                },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        }));

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        expect(result.status).toBe('loaded');
        expect(result.status === 'loaded' ? result.entries : []).toEqual([
            { seq: 1, createdAt: 10, text: 'plain prompt' },
        ]);
    });

    it('returns not_ready when encrypted session keys are unavailable', async () => {
        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            request: vi.fn(),
            getSessionEncryption: () => null,
        });

        expect(result).toEqual({ status: 'not_ready' });
    });

    it('treats old servers that reject the role query as unsupported', async () => {
        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            request: vi.fn(async () => response({ error: 'Invalid parameters' }, 400)),
            getSessionEncryption: () => ({ decryptMessages: vi.fn() }),
        });

        expect(result).toEqual({ status: 'unsupported' });
    });
});
