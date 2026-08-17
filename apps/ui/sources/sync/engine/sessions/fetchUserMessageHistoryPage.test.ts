import { describe, expect, it, vi } from 'vitest';

import {
    fetchUserMessageHistoryPage,
    SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY,
    USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
} from './fetchUserMessageHistoryPage';

function response(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

function userPromptContent(text: string) {
    return { role: 'user', content: { type: 'text', text } };
}

function agentTextContent(text: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: `assistant-${text}`,
                message: { role: 'assistant', content: [{ type: 'text', text }] },
            },
        },
    };
}

function agentThinkingContent(thinking: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: `thinking-${thinking}`,
                message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
            },
        },
    };
}

function agentToolCallContent(name: string, description: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: `tool-${name}`,
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: `call-${name}`, name, input: { description } }],
                },
            },
        },
    };
}

type StoredRow = Readonly<{
    id: string;
    seq: number;
    messageRole?: string | null;
    content: unknown;
    createdAt: number;
}>;

function storedRows(rows: readonly StoredRow[]) {
    return rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        localId: null,
        ...(row.messageRole === undefined ? {} : { messageRole: row.messageRole }),
        content: { t: 'plain', v: row.content },
        createdAt: row.createdAt,
    }));
}

function plainHistoryRequest(rows: readonly StoredRow[], page?: Readonly<{ hasMore?: boolean; nextBeforeSeq?: number | null }>) {
    return vi.fn(async (_path: string) => response({
        // A `beforeSeq` page comes back newest-first from the server.
        messages: [...storedRows(rows)].reverse(),
        hasMore: page?.hasMore ?? false,
        nextBeforeSeq: page?.nextBeforeSeq ?? null,
    }));
}

describe('fetchUserMessageHistoryPage', () => {
    it('asks for user rows and agent rows on one request so old servers still return user-only pages', async () => {
        const request = plainHistoryRequest([
            { id: 'm2', seq: 2, messageRole: 'user', content: userPromptContent('second prompt'), createdAt: 20 },
        ]);

        await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            beforeSeq: 10,
            request,
            getSessionEncryption: () => null,
        });

        const path = request.mock.calls[0]?.[0] ?? '';
        expect(path).toContain('role=user');
        expect(path).toContain(`roles=${encodeURIComponent(SESSION_MESSAGE_HISTORY_REMOTE_ROLES_QUERY)}`);
        expect(path).toContain(`limit=${USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE}`);
        expect(path).toContain('beforeSeq=10');
    });

    it('classifies returned rows client-side so an unfiltered server page still yields user and agent rows', async () => {
        const request = plainHistoryRequest([
            { id: 'm1', seq: 1, messageRole: 'user', content: userPromptContent('first prompt'), createdAt: 10 },
            { id: 'm2', seq: 2, messageRole: 'agent', content: agentTextContent('first answer'), createdAt: 20 },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        expect(result.status).toBe('loaded');
        expect(result.status === 'loaded' ? result.rows : []).toEqual([
            { messageId: 'm2', routeMessageId: 'server:m2', seq: 2, createdAt: 20, role: 'assistant', text: 'first answer' },
            { messageId: 'm1', routeMessageId: 'server:m1', seq: 1, createdAt: 10, role: 'user', text: 'first prompt' },
        ]);
    });

    it('returns page rows newest-first so composer history walks from the most recent prompt', async () => {
        const request = plainHistoryRequest([
            { id: 'm1', seq: 1, messageRole: 'user', content: userPromptContent('oldest prompt'), createdAt: 10 },
            { id: 'm2', seq: 2, messageRole: 'agent', content: agentTextContent('an answer'), createdAt: 20 },
            { id: 'm3', seq: 3, messageRole: 'user', content: userPromptContent('newest prompt'), createdAt: 30 },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        expect(result.status === 'loaded' ? result.rows.map((row) => row.seq) : []).toEqual([3, 2, 1]);
    });

    it('classifies legacy rows whose echoed messageRole is missing instead of dropping them', async () => {
        const request = plainHistoryRequest([
            { id: 'legacy-user', seq: 3, content: userPromptContent('legacy prompt'), createdAt: 30 },
            { id: 'legacy-agent', seq: 4, content: agentTextContent('legacy answer'), createdAt: 40 },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        expect(result.status === 'loaded' ? result.rows.map((row) => [row.role, row.text]) : []).toEqual([
            ['assistant', 'legacy answer'],
            ['user', 'legacy prompt'],
        ]);
    });

    it('skips thinking-only agent rows and falls back to the tool description for tool-only agent rows', async () => {
        const request = plainHistoryRequest([
            { id: 'think', seq: 5, messageRole: 'agent', content: agentThinkingContent('pondering'), createdAt: 50 },
            { id: 'tool', seq: 6, messageRole: 'agent', content: agentToolCallContent('Bash', 'Run the tests'), createdAt: 60 },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        expect(result.status === 'loaded' ? result.rows.map((row) => [row.messageId, row.role, row.text]) : []).toEqual([
            ['tool', 'tool', 'Run the tests'],
        ]);
    });

    it('clamps captured agent text but replays user prompts verbatim', async () => {
        const longAnswer = 'a'.repeat(4_000);
        const longPrompt = 'p'.repeat(4_000);
        const request = plainHistoryRequest([
            { id: 'u', seq: 7, messageRole: 'user', content: userPromptContent(longPrompt), createdAt: 70 },
            { id: 'a', seq: 8, messageRole: 'agent', content: agentTextContent(longAnswer), createdAt: 80 },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            sessionEncryptionMode: 'plain',
            request,
            getSessionEncryption: () => null,
        });

        const rows = result.status === 'loaded' ? result.rows : [];
        expect(rows.find((row) => row.role === 'user')?.text).toBe(longPrompt);
        expect(rows.find((row) => row.role === 'assistant')?.text.length).toBeLessThan(longAnswer.length);
    });

    it('decrypts encrypted pages through the shared session messages pipeline', async () => {
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
                messageRole: 'user' as const,
                content: userPromptContent('second prompt'),
                createdAt: 20,
            },
        ]);

        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            beforeSeq: 10,
            request,
            getSessionEncryption: () => ({ decryptMessages }),
        });

        expect(decryptMessages).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'm2', messageRole: 'user' }),
        ]);
        expect(result).toEqual({
            status: 'loaded',
            rows: [{ messageId: 'm2', routeMessageId: 'server:m2', seq: 2, createdAt: 20, role: 'user', text: 'second prompt' }],
            hasMore: true,
            nextBeforeSeq: 2,
        });
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

    it('keeps a session the current scope cannot see retryable instead of unsupported', async () => {
        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            request: vi.fn(async () => response({ error: 'Session not found' }, 404)),
            getSessionEncryption: () => ({ decryptMessages: vi.fn() }),
        });

        expect(result).toEqual({ status: 'error' });
    });

    it('reports transport failures as retryable errors', async () => {
        const result = await fetchUserMessageHistoryPage({
            sessionId: 's1',
            request: vi.fn(async () => {
                throw new Error('offline');
            }),
            getSessionEncryption: () => ({ decryptMessages: vi.fn() }),
        });

        expect(result).toEqual({ status: 'error' });
    });
});
