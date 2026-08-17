import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { fetchAndApplyMessages } from './syncSessions';
import { advanceSessionReceivedMessageCurrentness } from './sessionMessageCurrentness';

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

function buildPlainApiMessage(params: { id: string; seq: number; text: string }): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: params.text } },
        },
        createdAt: 1_000 + params.seq,
        updatedAt: 2_000 + params.seq,
    };
}

describe('fetchAndApplyMessages (updatedAt dedupe)', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

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

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

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

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.initial).toBe(1);
        expect(requestEvent?.fields.scopeMain).toBe(1);
        const responseJsonEvent = events.find((event) => event.name === 'sync.sessions.messages.responseJson');
        expect(responseJsonEvent?.fields.status).toBe(200);
        const parseResponseEvent = events.find((event) => event.name === 'sync.sessions.messages.parseResponse');
        expect(parseResponseEvent?.fields.initial).toBe(1);
        const pageEvent = events.find((event) => event.name === 'sync.sessions.messages.page');
        expect(pageEvent?.fields.fetched).toBe(1);
        const dedupeEvent = events.find((event) => event.name === 'sync.sessions.messages.dedupe');
        expect(dedupeEvent?.fields.toDecrypt).toBe(1);
        expect(dedupeEvent?.fields.skipped).toBe(0);
        const decryptEvent = events.find((event) => event.name === 'sync.sessions.messages.decrypt');
        expect(decryptEvent?.fields.messages).toBe(1);
        const normalizeEvent = events.find((event) => event.name === 'sync.sessions.messages.normalize');
        expect(normalizeEvent?.fields.decrypted).toBe(1);
        const applyEvent = events.find((event) => event.name === 'sync.sessions.messages.apply');
        expect(applyEvent?.fields.normalized).toBe(1);
    });

    it('keeps a newer socket watermark when an initial snapshot finishes decrypting later', async () => {
        const stalePageMessage = buildApiMessage({ id: 'm1', seq: 1, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [stalePageMessage] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        type DecryptedPageMessage = {
            id: string;
            seq: number;
            localId: string | null;
            createdAt: number;
            content: unknown;
        };
        let releaseDecryption!: (messages: DecryptedPageMessage[]) => void;
        const pendingDecryption = new Promise<DecryptedPageMessage[]>((resolve) => {
            releaseDecryption = resolve;
        });
        const decryptMessages = vi.fn((_messages: ApiMessage[]) => pendingDecryption);
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['m1', 2_009]])],
        ]);
        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();

        const pendingResult = fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        await vi.waitFor(() => expect(decryptMessages).toHaveBeenCalledWith([stalePageMessage]));
        advanceSessionReceivedMessageCurrentness(sessionReceivedMessages, 's1', 'm1', 2_011);
        releaseDecryption([{
            id: stalePageMessage.id,
            seq: stalePageMessage.seq,
            localId: stalePageMessage.localId ?? null,
            createdAt: stalePageMessage.createdAt,
            content: { role: 'user', content: { type: 'text', text: 'older snapshot text' } },
        }]);

        await pendingResult;

        expect(applyMessages).toHaveBeenLastCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')?.get('m1')).toBe(2_011);
        expect(markMessagesLoaded).toHaveBeenCalledWith('s1');
    });

    it('drops an initial snapshot that loses session visibility during decryption', async () => {
        const message = buildApiMessage({ id: 'deleted-during-decrypt', seq: 2, updatedAt: 2_012 });
        let sessionKnown = true;
        let releaseDecryption!: (messages: Array<{
            id: string;
            seq: number;
            localId: string | null;
            createdAt: number;
            content: unknown;
        }>) => void;
        const pendingDecryption = new Promise<Array<{
            id: string;
            seq: number;
            localId: string | null;
            createdAt: number;
            content: unknown;
        }>>((resolve) => {
            releaseDecryption = resolve;
        });
        const decryptMessages = vi.fn(() => pendingDecryption);
        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();
        const onMessagesPage = vi.fn();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const pendingResult = fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({ decryptMessages }),
            isSessionKnown: () => sessionKnown,
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            onMessagesPage,
            log: { log: () => {} },
        });

        await vi.waitFor(() => expect(decryptMessages).toHaveBeenCalledWith([message]));
        sessionKnown = false;
        releaseDecryption([{
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            createdAt: message.createdAt,
            content: { role: 'user', content: { type: 'text', text: 'deleted response' } },
        }]);

        await pendingResult;

        expect(onMessagesPage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markMessagesLoaded).not.toHaveBeenCalled();
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('does not mark a transcript loaded after its page apply loses session visibility', async () => {
        const message = buildApiMessage({ id: 'deleted-after-apply', seq: 3, updatedAt: 2_013 });
        let sessionKnown = true;
        const applyMessages = vi.fn(() => {
            queueMicrotask(() => {
                sessionKnown = false;
            });
        });
        const markMessagesLoaded = vi.fn();

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    createdAt: message.createdAt,
                    content: { role: 'user', content: { type: 'text', text: 'page applied before delete' } },
                }],
            }),
            isSessionKnown: () => sessionKnown,
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markMessagesLoaded).not.toHaveBeenCalled();
    });

    it('does not advance row currentness when applying an initial row is rejected', async () => {
        const message = buildApiMessage({ id: 'apply-rejected', seq: 2, updatedAt: 2_012 });
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        await expect(fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: () => ({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    createdAt: message.createdAt,
                    content: { role: 'user', content: { type: 'text', text: 'initial row' } },
                }],
            }),
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages: () => {
                throw new Error('reducer rejected initial row');
            },
            markMessagesLoaded: vi.fn(),
            log: { log: () => {} },
        })).rejects.toThrow('reducer rejected initial row');

        expect(sessionReceivedMessages.get('s1')?.get('apply-rejected')).toBeUndefined();
    });

    it('applies plaintext message pages without touching the encryption registry', async () => {
        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();
        const getSessionEncryption = vi.fn(() => null);
        const request = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    messages: [buildPlainApiMessage({ id: 'm_plain', seq: 1, text: 'hello plain' })],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await fetchAndApplyMessages({
            sessionId: 's_plain',
            sessionEncryptionMode: 'plain',
            getSessionEncryption,
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'm_plain',
            role: 'user',
            seq: 1,
        });
        expect(markMessagesLoaded).toHaveBeenCalledWith('s_plain');
    });
});
