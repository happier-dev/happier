import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
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
