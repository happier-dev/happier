import { describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import {
    activateSessionMessagesWindow,
    createInactiveSessionMessagesWindowState,
    resetSessionMessagesWindowForLiveTail,
    type SessionMessagesWindowState,
} from '@/sync/runtime/sessionMessagesWindowState';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { fetchAndApplyTargetWindowMessages } from './fetchAndApplyTargetWindowMessages';

function buildEncryptedApiMessage(params: { id: string; seq: number; updatedAt?: number }): ApiMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'encrypted',
            c: `cipher-${params.id}`,
        },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt ?? 2_000 + params.seq,
    };
}

function buildTextContent(message: ApiMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text: `hello-${message.id}` },
        },
    };
}

function buildToolCallContent(message: ApiMessage, toolId: string) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: `uuid-${toolId}`,
                    message: {
                        role: 'assistant',
                        content: [{
                            type: 'tool_use',
                            id: toolId,
                            name: 'Read',
                            input: {},
                        }],
                    },
                },
            },
        },
    };
}

function readRequestUrl(request: ReturnType<typeof vi.fn>, callIndex = 0): URL {
    const path = request.mock.calls[callIndex]?.[0];
    expect(path).toEqual(expect.any(String));
    return new URL(String(path), 'https://sync.test');
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('fetchAndApplyTargetWindowMessages', () => {
    it('materializes an initial target window with newer context when the target is at the older edge', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 1 });
        const newer = buildEncryptedApiMessage({ id: 'newer', seq: 2 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://example.test');
            if (url.searchParams.get('beforeSeq') === '2') {
                return new Response(
                    JSON.stringify({
                        messages: [target],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            if (url.searchParams.get('afterSeq') === '1') {
                return new Response(
                    JSON.stringify({
                        messages: [newer],
                        hasMore: true,
                        nextAfterSeq: 2,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw new Error(`unexpected target-window request ${path}`);
        });
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        let windowState = createInactiveSessionMessagesWindowState();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-1',
            target: { kind: 'seq', seq: 1 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledTimes(2);
        expect(readRequestUrl(request, 0).searchParams.get('beforeSeq')).toBe('2');
        expect(readRequestUrl(request, 1).searchParams.get('afterSeq')).toBe('1');
        expect(result).toMatchObject({
            status: 'loaded',
            targetSeq: 1,
            targetPresent: true,
            rawSeqs: [1, 2],
            appliedSeqs: [1, 2],
            olderCursor: null,
            newerCursor: 2,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            targetSeq: 1,
            windowMinSeq: 1,
            windowMaxSeq: 2,
            olderCursor: null,
            newerCursor: 2,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
    });

    it('loads the initial before-side target page through the shared pipeline and updates only target-window state', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100 });
        const older = buildEncryptedApiMessage({ id: 'older', seq: 99 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [],
                        hasMore: false,
                        nextAfterSeq: null,
                    }
                    : {
                        messages: [target, older],
                        hasMore: true,
                        nextBeforeSeq: 99,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        let windowState = createInactiveSessionMessagesWindowState();
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });
        const updateSessionMessagesPaginationFromPage = vi.fn(() => {
            throw new Error('target-window fetch must not update tail pagination');
        });
        const markSessionMaterializedMaxSeq = vi.fn(() => {
            throw new Error('target-window fetch must not advance live-tail materialized max');
        });
        const markMessagesLoaded = vi.fn(() => {
            throw new Error('target-window fetch must not mark initial hydration loaded');
        });

        const params = {
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq' as const, seq: 100 },
            direction: 'initial' as const,
            limit: 2,
            scope: 'main' as const,
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
            updateSessionMessagesPaginationFromPage,
            markSessionMaterializedMaxSeq,
            markMessagesLoaded,
        };

        const result = await fetchAndApplyTargetWindowMessages(params);

        const url = readRequestUrl(request);
        expect(url.pathname).toBe('/v1/sessions/s1/messages');
        expect(url.searchParams.get('scope')).toBe('main');
        expect(url.searchParams.get('beforeSeq')).toBe('101');
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.has('afterSeq')).toBe(false);

        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['older', 'target']);
        expect(applyMessages.mock.calls[0]?.[1].map((message) => message.seq)).toEqual([99, 100]);
        expect(result).toMatchObject({
            status: 'loaded',
            windowId: 'window-100',
            targetSeq: 100,
            targetPresent: true,
            rawSeqs: [100, 99],
            appliedSeqs: [99, 100],
            olderCursor: 99,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-100',
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 100,
            olderCursor: 99,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });
        expect(setWindowState).toHaveBeenCalledTimes(1);
        expect(updateSessionMessagesPaginationFromPage).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markMessagesLoaded).not.toHaveBeenCalled();
    });

    it('keeps raw target presence true when updated-at dedupe skips the already-received target row', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100, updatedAt: 2_100 });
        const older = buildEncryptedApiMessage({ id: 'older', seq: 99, updatedAt: 2_099 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [],
                        hasMore: false,
                        nextAfterSeq: null,
                    }
                    : {
                        messages: [target, older],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        sessionReceivedMessages.set('s1', new Map([['target', 2_100]]));

        let windowState = createInactiveSessionMessagesWindowState();
        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'initial',
            limit: 2,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['older']);
        expect(result).toMatchObject({
            status: 'loaded',
            targetPresent: true,
            rawSeqs: [100, 99],
            appliedSeqs: [99],
            olderCursor: null,
            hasMoreOlder: false,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 100,
        });
    });

    it('does not activate a seq target window when the fetched target row is not applied', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100 });
        const older = buildEncryptedApiMessage({ id: 'older', seq: 99 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [target, older],
                hasMore: true,
                nextBeforeSeq: 99,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: ApiMessage[]) =>
            messages.map((message) => (message.id === 'target' ? null : buildTextContent(message))),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        let windowState = createInactiveSessionMessagesWindowState();
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'initial',
            limit: 2,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['older', 'target']);
        expect(applyMessages.mock.calls[0]?.[1].map((message) => message.seq)).toEqual([99]);
        expect(result).toMatchObject({
            status: 'not_found',
            targetSeq: 100,
            targetPresent: false,
            rawSeqs: [100, 99],
            appliedSeqs: [99],
        });
        expect(setWindowState).not.toHaveBeenCalled();
        expect(windowState).toMatchObject({
            isWindowMode: false,
            windowId: null,
            targetSeq: null,
            olderCursor: null,
            newerCursor: null,
        });
    });

    it('does not treat a same-seq page row with the wrong server route id as the requested route target', async () => {
        const sameSeqWrongRoute = buildEncryptedApiMessage({ id: 'other-server-message', seq: 100 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [sameSeqWrongRoute],
                hasMore: false,
                nextBeforeSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        let windowState = createInactiveSessionMessagesWindowState();
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-route',
            target: { kind: 'route-message-id', routeMessageId: 'server:target-server-message', seqHint: 100 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(sameSeqWrongRoute)]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(result).toMatchObject({
            status: 'not_found',
            targetSeq: 100,
            targetPresent: false,
            rawSeqs: [100],
        });
        expect(setWindowState).not.toHaveBeenCalled();
        expect(windowState).toMatchObject({
            isWindowMode: false,
            windowId: null,
            targetSeq: null,
            olderCursor: null,
            newerCursor: null,
        });
    });

    it('detects a tool route target from the decrypted and normalized target page', async () => {
        const toolHost = buildEncryptedApiMessage({ id: 'tool-host-message', seq: 100 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [],
                        hasMore: false,
                        nextAfterSeq: null,
                    }
                    : {
                        messages: [toolHost],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        let windowState = createInactiveSessionMessagesWindowState();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-tool',
            target: { kind: 'route-message-id', routeMessageId: 'tool:read-src', seqHint: 100 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildToolCallContent(toolHost, 'read-src')]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(result).toMatchObject({
            status: 'loaded',
            targetSeq: 100,
            targetPresent: true,
            rawSeqs: [100],
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-tool',
            targetSeq: 100,
        });
    });

    it('keeps a deduped already-loaded tool route target present through the loaded route resolver', async () => {
        const toolHost = buildEncryptedApiMessage({ id: 'tool-host-message', seq: 100, updatedAt: 2_100 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [],
                        hasMore: false,
                        nextAfterSeq: null,
                    }
                    : {
                        messages: [toolHost],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        const decryptMessages = vi.fn(async () => [buildToolCallContent(toolHost, 'read-src')]);
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        sessionReceivedMessages.set('s1', new Map([['tool-host-message', 2_100]]));
        let windowState = createInactiveSessionMessagesWindowState();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-tool',
            target: { kind: 'route-message-id', routeMessageId: 'tool:read-src', seqHint: 100 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages }),
            isRouteMessageIdLoaded: (routeMessageId: string) => routeMessageId === 'tool:read-src',
            request,
            sessionReceivedMessages,
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(decryptMessages).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            status: 'loaded',
            targetPresent: true,
            appliedSeqs: [],
            rawSeqs: [100],
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-tool',
        });
    });

    it('activates target-window mode for an inactive older-side fetch even when direction is older', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100 });
        const older = buildEncryptedApiMessage({ id: 'older', seq: 99 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [],
                        hasMore: false,
                        nextAfterSeq: null,
                    }
                    : {
                        messages: [target, older],
                        hasMore: true,
                        nextBeforeSeq: 99,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        let windowState = createInactiveSessionMessagesWindowState();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'older',
            limit: 2,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async (messages: ApiMessage[]) => messages.map(buildTextContent)) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        const url = readRequestUrl(request);
        expect(request).toHaveBeenCalledTimes(2);
        expect(url.searchParams.get('beforeSeq')).toBe('101');
        expect(url.searchParams.has('afterSeq')).toBe(false);
        expect(readRequestUrl(request, 1).searchParams.get('afterSeq')).toBe('100');
        expect(result).toMatchObject({
            status: 'loaded',
            olderCursor: 99,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-100',
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 100,
            olderCursor: 99,
            newerCursor: 100,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });
    });

    it('activates target-window mode for an inactive newer-side fetch with initial target context', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100 });
        const newerOne = buildEncryptedApiMessage({ id: 'newer-101', seq: 101 });
        const newerTwo = buildEncryptedApiMessage({ id: 'newer-102', seq: 102 });
        const request = vi.fn(async (path: string) => {
            const url = new URL(path, 'https://sync.test');
            return new Response(
                JSON.stringify(url.searchParams.has('afterSeq')
                    ? {
                        messages: [newerOne, newerTwo],
                        hasMore: true,
                        nextAfterSeq: 102,
                    }
                    : {
                        messages: [target],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        let windowState = createInactiveSessionMessagesWindowState();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-route',
            target: { kind: 'route-message-id', routeMessageId: 'server:target', seqHint: 100 },
            direction: 'newer',
            limit: 2,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async (messages: ApiMessage[]) => messages.map(buildTextContent)) }),
            isRouteMessageIdLoaded: (routeMessageId) => routeMessageId === 'server:target',
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledTimes(2);
        const url = readRequestUrl(request);
        expect(url.searchParams.get('beforeSeq')).toBe('101');
        expect(url.searchParams.has('afterSeq')).toBe(false);
        expect(readRequestUrl(request, 1).searchParams.get('afterSeq')).toBe('100');
        expect(result).toMatchObject({
            status: 'loaded',
            targetSeq: 100,
            rawSeqs: [100, 101, 102],
            appliedSeqs: [100, 101, 102],
            olderCursor: null,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-route',
            targetSeq: 100,
            windowMinSeq: 100,
            windowMaxSeq: 102,
            olderCursor: null,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
    });

    it('skips target-window fetch without request or window mutation when the session is missing on the active server', async () => {
        const request = vi.fn(async () => {
            throw new Error('request should not run for missing sessions');
        });
        const setWindowState = vi.fn();

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 'missing-session',
            windowId: 'window-missing',
            target: { kind: 'seq', seq: 100 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            sessionEncryptionMode: 'plain',
            getSessionEncryption: () => {
                throw new Error('encryption should not resolve for missing sessions');
            },
            isSessionKnown: () => false,
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => createInactiveSessionMessagesWindowState(),
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        });

        expect(result).toMatchObject({
            status: 'skipped_missing_session',
            targetPresent: false,
            rawSeqs: [],
            appliedSeqs: [],
        });
        expect(request).not.toHaveBeenCalled();
        expect(setWindowState).not.toHaveBeenCalled();
    });

    it('continues newer-side target-window pages from the window cursor without reading or mutating the tail cursor', async () => {
        const message = buildEncryptedApiMessage({ id: 'newer', seq: 103 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [message],
                hasMore: true,
                nextAfterSeq: 103,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const tailPagination = { beforeSeq: 80, hasMoreOlder: true };
        let windowState = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-100',
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 102,
            olderCursor: 99,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'newer',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(message)]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        const url = readRequestUrl(request);
        expect(url.searchParams.get('afterSeq')).toBe('102');
        expect(url.searchParams.has('beforeSeq')).toBe(false);
        expect(tailPagination).toEqual({ beforeSeq: 80, hasMoreOlder: true });
        expect(result).toMatchObject({
            status: 'loaded',
            rawSeqs: [103],
            appliedSeqs: [103],
            olderCursor: 99,
            newerCursor: 103,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
        expect(windowState).toMatchObject({
            windowMinSeq: 99,
            windowMaxSeq: 103,
            olderCursor: 99,
            newerCursor: 103,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
    });

    it('continues older-side pages for the active window through the existing window-page path', async () => {
        const older = buildEncryptedApiMessage({ id: 'older', seq: 98 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [older],
                hasMore: false,
                nextBeforeSeq: 98,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        let windowState = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-100',
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 102,
            olderCursor: 99,
            newerCursor: 102,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });

        const result = await fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'older',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(older)]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => {
                windowState = next;
            },
            now: () => 12_345,
            log: { log: () => {} },
        });

        const url = readRequestUrl(request);
        expect(url.searchParams.get('beforeSeq')).toBe('99');
        expect(result).toMatchObject({
            status: 'loaded',
            olderCursor: 98,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-100',
            windowMinSeq: 98,
            windowMaxSeq: 102,
            olderCursor: 98,
            newerCursor: 102,
            hasMoreOlder: false,
            hasMoreNewer: true,
        });
    });

    it('drops the window-state commit when a different target window wins while the fetch is pending', async () => {
        const target = buildEncryptedApiMessage({ id: 'target', seq: 100 });
        const response = createDeferred<Response>();
        const request = vi.fn(() => response.promise);
        let windowState = createInactiveSessionMessagesWindowState();
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });

        const load = fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'initial',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(target)]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        });
        expect(request).toHaveBeenCalledTimes(1);

        windowState = activateSessionMessagesWindow(windowState, {
            windowId: 'window-500',
            targetSeq: 500,
            windowMinSeq: 500,
            windowMaxSeq: 500,
            olderCursor: 500,
            newerCursor: 500,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 12_400,
        });
        response.resolve(new Response(
            JSON.stringify({ messages: [target], hasMore: false, nextBeforeSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await expect(load).resolves.toMatchObject({
            status: 'stale',
            windowId: 'window-100',
            targetPresent: true,
            rawSeqs: [100],
            appliedSeqs: [100],
            olderCursor: 500,
            newerCursor: 500,
        });
        expect(setWindowState).not.toHaveBeenCalled();
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-500',
        });
    });

    it('drops a continuation commit after live-tail reset clears the active window while the fetch is pending', async () => {
        const older = buildEncryptedApiMessage({ id: 'older', seq: 98 });
        const response = createDeferred<Response>();
        const request = vi.fn(() => response.promise);
        let windowState = activateSessionMessagesWindow(createInactiveSessionMessagesWindowState(), {
            windowId: 'window-100',
            targetSeq: 100,
            windowMinSeq: 99,
            windowMaxSeq: 102,
            olderCursor: 99,
            newerCursor: 102,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 10,
        });
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });

        const load = fetchAndApplyTargetWindowMessages({
            sessionId: 's1',
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            direction: 'older',
            limit: 1,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(older)]) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        });
        expect(request).toHaveBeenCalledTimes(1);

        windowState = resetSessionMessagesWindowForLiveTail(windowState);
        response.resolve(new Response(
            JSON.stringify({ messages: [older], hasMore: false, nextBeforeSeq: 98 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await expect(load).resolves.toMatchObject({
            status: 'stale',
            windowId: 'window-100',
            targetPresent: true,
            rawSeqs: [98],
            appliedSeqs: [98],
            olderCursor: null,
            newerCursor: null,
        });
        expect(setWindowState).not.toHaveBeenCalled();
        expect(windowState).toMatchObject({
            isWindowMode: false,
            windowId: null,
            targetSeq: null,
            olderCursor: null,
            newerCursor: null,
        });
    });

    it('uses newest-initiated semantics when repeated first activations resolve out of order', async () => {
        const firstTarget = buildEncryptedApiMessage({ id: 'first-target', seq: 100 });
        const secondTarget = buildEncryptedApiMessage({ id: 'second-target', seq: 500 });
        const firstResponse = createDeferred<Response>();
        const secondResponse = createDeferred<Response>();
        const firstRequest = vi.fn(() => firstResponse.promise);
        const secondRequest = vi.fn((path: string) => {
            const url = new URL(path, 'https://sync.test');
            if (url.searchParams.has('afterSeq')) {
                return Promise.resolve(new Response(
                    JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ));
            }
            return secondResponse.promise;
        });
        let windowState = createInactiveSessionMessagesWindowState();
        const setWindowState = vi.fn((next: SessionMessagesWindowState) => {
            windowState = next;
        });
        const common = {
            sessionId: 's1',
            direction: 'initial' as const,
            limit: 1,
            scope: 'main' as const,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState,
            now: () => 12_345,
            log: { log: () => {} },
        };

        const firstLoad = fetchAndApplyTargetWindowMessages({
            ...common,
            windowId: 'window-100',
            target: { kind: 'seq', seq: 100 },
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(firstTarget)]) }),
            request: firstRequest,
        });
        const secondLoad = fetchAndApplyTargetWindowMessages({
            ...common,
            windowId: 'window-500',
            target: { kind: 'seq', seq: 500 },
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async () => [buildTextContent(secondTarget)]) }),
            request: secondRequest,
        });
        expect(firstRequest).toHaveBeenCalledTimes(1);
        expect(secondRequest).toHaveBeenCalledTimes(1);

        firstResponse.resolve(new Response(
            JSON.stringify({ messages: [firstTarget], hasMore: false, nextBeforeSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        await expect(firstLoad).resolves.toMatchObject({
            status: 'stale',
            windowId: 'window-100',
            targetPresent: true,
        });
        expect(windowState).toEqual(createInactiveSessionMessagesWindowState());

        secondResponse.resolve(new Response(
            JSON.stringify({ messages: [secondTarget], hasMore: false, nextBeforeSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        await expect(secondLoad).resolves.toMatchObject({
            status: 'loaded',
            windowId: 'window-500',
            targetPresent: true,
            olderCursor: null,
            newerCursor: 500,
        });
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-500',
            targetSeq: 500,
        });
    });
});
describe('F1: cursor seed guards (wrong-window cursor isolation)', () => {
    it('derives beforeSeq from targetSeq when window A is active but jump targets window B (direction older)', async () => {
        // F1 RED: window A currently active with olderCursor=50.
        // Jump to window B (different windowId) with direction 'older' must use
        // beforeSeq = targetSeq(B) + 1 = 201, NOT A's olderCursor=50.
        const targetB = buildEncryptedApiMessage({ id: 'target-b', seq: 200 });
        const olderB = buildEncryptedApiMessage({ id: 'older-b', seq: 199 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [targetB, olderB], hasMore: false, nextBeforeSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        // Window A is currently active with olderCursor=50. Must include activatedAtMs.
        let windowState: SessionMessagesWindowState = activateSessionMessagesWindow(
            createInactiveSessionMessagesWindowState(),
            {
                windowId: 'window-A',
                targetSeq: 30,
                windowMinSeq: 28,
                windowMaxSeq: 35,
                olderCursor: 50,
                newerCursor: 35,
                hasMoreOlder: true,
                hasMoreNewer: false,
                activatedAtMs: 1000,
            },
        );
        // Confirm window A is truly active with olderCursor
        expect(windowState.isWindowMode).toBe(true);
        expect((windowState as { olderCursor?: number }).olderCursor).toBe(50);

        await fetchAndApplyTargetWindowMessages({
            sessionId: 's-f1',
            windowId: 'window-B',
            target: { kind: 'seq', seq: 200 },
            direction: 'older',
            limit: 2,
            scope: 'main',
            getSessionEncryption: () => ({ decryptMessages: vi.fn(async (messages: ApiMessage[]) => messages.map(buildTextContent)) }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages: vi.fn(),
            getWindowState: () => windowState,
            setWindowState: (next: SessionMessagesWindowState) => { windowState = next; },
            now: () => 12_345,
            log: { log: () => {} },
        });

        const url = readRequestUrl(request);
        // Must use B's targetSeq-derived beforeSeq (200 + 1 = 201), NOT window A's olderCursor (50)
        expect(url.searchParams.get('beforeSeq')).toBe('201');
        expect(url.searchParams.has('afterSeq')).toBe(false);
        expect(windowState).toMatchObject({
            isWindowMode: true,
            windowId: 'window-B',
            targetSeq: 200,
        });
    });
});
