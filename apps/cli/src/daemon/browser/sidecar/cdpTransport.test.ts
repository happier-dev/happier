import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { LoopbackWebSocketJsonClientV1 } from '@/plugins/runtime/exec/privateContract';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { connectBrowserSidecarCdpTransport, createBrowserSidecarCdpTransport } from './cdpTransport';
import { createBrowserSidecarCdpControlAdapter } from './controlAdapter';

type CdpPageHandle = Readonly<{
    targetId: string;
    sessionId?: string;
}>;

type CdpTransport = Readonly<{
    openPage(input: Readonly<{ url: string; focus: boolean }>): Promise<CdpPageHandle>;
    dispatchPageCommand(input: CdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
    dispatchBrowserCommand(input: Readonly<{
        method: string;
        params?: Record<string, unknown>;
        deadlineMs?: number;
        signal?: AbortSignal;
    }>): Promise<unknown>;
    subscribeCdpEvents(listener: (notification: Readonly<{
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
    }>) => void): () => void;
    dispose(): void;
}>;

type CdpTransportModule = Readonly<{
    createBrowserSidecarCdpTransport?: (input: Readonly<{
        client: LoopbackWebSocketJsonClientV1;
    }>) => CdpTransport;
    connectBrowserSidecarCdpTransport?: (input: Readonly<{
        endpoint: Readonly<{ url: string }>;
        connectTimeoutMs?: number;
    }>) => Promise<CdpTransport>;
}>;

type SentMessage = Record<string, unknown> & Readonly<{ id: number; method: string }>;

async function loadTransportModule(): Promise<CdpTransportModule | null> {
    return import('./cdpTransport') as Promise<CdpTransportModule | null>;
}

function createFakeJsonClient(reply?: (message: SentMessage) => Record<string, unknown> | undefined): {
    readonly client: LoopbackWebSocketJsonClientV1;
    readonly sent: readonly SentMessage[];
    emit(message: unknown): void;
    close(error?: Error): void;
} {
    const listeners = new Set<(message: unknown) => void | Promise<void>>();
    const sent: SentMessage[] = [];
    let settleClosed: (() => void) | null = null;
    let rejectClosed: ((error: Error) => void) | null = null;
    const closed = new Promise<void>((resolve, reject) => {
        settleClosed = resolve;
        rejectClosed = reject;
    });
    closed.catch(() => undefined);

    return {
        client: {
            closed,
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            async sendJson(message) {
                const command = message as SentMessage;
                sent.push(command);
                const result = reply?.(command);
                if (result !== undefined) {
                    for (const listener of [...listeners]) await listener({ id: command.id, result });
                }
            },
        },
        sent,
        emit(message) {
            for (const listener of [...listeners]) {
                void listener(message);
            }
        },
        close(error) {
            if (error) {
                rejectClosed?.(error);
            } else {
                settleClosed?.();
            }
        },
    };
}

async function waitForSent(sent: readonly SentMessage[], count: number): Promise<void> {
    await expect.poll(() => sent.length).toBe(count);
}

function responseFor(message: SentMessage, result: unknown): Readonly<{ id: number; result: unknown }> {
    return { id: message.id, result };
}

function encodeServerFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    if (payload.byteLength > 65_535) {
        const header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
        return Buffer.concat([header, payload]);
    }
    if (payload.byteLength >= 126) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.byteLength, 2);
        return Buffer.concat([header, payload]);
    }
    return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
}

function decodeClientFrame(buffer: Buffer<ArrayBufferLike>): null | Readonly<{
    opcode: number;
    text: string;
    rest: Buffer<ArrayBufferLike>;
}> {
    if (buffer.byteLength < 2) return null;
    const opcode = buffer[0] & 0x0f;
    const length = buffer[1] & 0x7f;
    const masked = (buffer[1] & 0x80) !== 0;
    if (length >= 126) throw new Error('test server supports small frames only');
    const offset = 2 + (masked ? 4 : 0);
    if (buffer.byteLength < offset + length) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
        const mask = buffer.subarray(2, 6);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = payload[index] ^ mask[index % 4];
        }
    }
    return {
        opcode,
        text: payload.toString('utf8'),
        rest: buffer.subarray(offset + length),
    };
}

async function startCdpWebSocketServer(onMessage: (message: Record<string, unknown>) => unknown | string): Promise<Readonly<{
    endpoint: Readonly<{ url: string }>;
    close(): Promise<void>;
}>> {
    const server = http.createServer();
    const sockets = new Set<Duplex>();
    server.on('upgrade', (request, socket) => {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
        const key = String(request.headers['sec-websocket-key'] ?? '');
        const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
        ].join('\r\n'));

        let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const decoded = decodeClientFrame(buffer);
                if (!decoded) return;
                buffer = decoded.rest;
                if (decoded.opcode === 0x8) {
                    socket.end();
                    return;
                }
                const requestMessage = JSON.parse(decoded.text) as Record<string, unknown>;
                const response = onMessage(requestMessage);
                for (const frame of Array.isArray(response) ? response : [response]) {
                    if (frame === undefined) continue;
                    socket.write(encodeServerFrame(typeof frame === 'string' ? frame : JSON.stringify(frame)));
                }
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        endpoint: { url: `ws://127.0.0.1:${address.port}/devtools/browser/server-token` },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}

describe('browser sidecar CDP JSON-RPC transport', () => {
    it('drains issued navigation acknowledgements on cancellation and honors the containing deadline without closing unrelated requests', async () => {
        vi.useFakeTimers();
        const fake = createFakeJsonClient(command => {
            if (command.method === 'Target.createTarget') return { targetId: 'target_1' };
            if (command.method === 'Target.attachToTarget') return { sessionId: 'session_1' };
            if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_1', url: 'https://example.test' } } };
            if (command.method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'https://example.test', title: 'Fixture' }] };
            if (command.method === 'Page.navigate') return undefined;
            if (command.method === 'Browser.getVersion') return { product: 'healthy' };
            return {};
        });
        const transport = createBrowserSidecarCdpTransport({ client: fake.client });
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1', transport });
        try {
            const opened = adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId: 'browser_session_1', viewId: 'view_1', platform: 'web', focus: false,
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test' } });
            await opened;
            const automation = createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter }) });
            const controller = new AbortController();
            let cancelledResult: unknown;
            const cancelled = automation.execute({ v: 1, automationRequestId: 'cancel', browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 1, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent_1' }, actionKind: 'navigate', payload: { url: 'https://example.test/cancel' }, timeoutMs: 10_000 }, { deadlineMs: Date.now() + 10_000, signal: controller.signal })
                .then(result => { cancelledResult = result; });
            await vi.advanceTimersByTimeAsync(0);
            const heldNavigation = fake.sent.find(command => command.method === 'Page.navigate');
            expect(heldNavigation).toBeDefined();
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            expect(cancelledResult).toBeUndefined();
            await expect(transport.dispatchBrowserCommand({ method: 'Browser.getVersion' })).resolves.toEqual({ product: 'healthy' });
            fake.emit(responseFor(heldNavigation!, {}));
            await cancelled;
            expect(cancelledResult).toMatchObject({ status: 'canceled', errorCode: 'user_canceled', interruptionCompletion: 'uncertain' });
            let navigationResult: unknown;
            const navigation = Promise.resolve(adapter.dispatchCommand({ kind: 'navigate', commandId: 'navigate', browserSessionId: 'browser_session_1', viewId: 'view_1', url: 'https://example.test/next' }, { deadlineMs: Date.now() + 20 }))
                .then((result) => { navigationResult = result; });
            await vi.advanceTimersByTimeAsync(20);
            expect(navigationResult).toMatchObject({ status: 'failed' });
            await navigation;
            const healthy = transport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
            await expect(healthy).resolves.toEqual({ product: 'healthy' });
        } finally {
            adapter.dispose();
            transport.dispose();
            vi.useRealTimers();
        }
    });
    it('distinguishes pre-dispatch abort from aborting a sent command while preserving AbortError', async () => {
        const fake = createFakeJsonClient();
        const transport = createBrowserSidecarCdpTransport({ client: fake.client });
        try {
            const preflight = new AbortController();
            preflight.abort();
            await expect(transport.dispatchBrowserCommand({ method: 'Input.insertText', signal: preflight.signal }))
                .rejects.toMatchObject({ name: 'AbortError', dispatchStatus: 'not_dispatched' });
            expect(fake.sent).toEqual([]);
            const issued = new AbortController();
            const command = transport.dispatchBrowserCommand({ method: 'Input.insertText', signal: issued.signal });
            const canceled = expect(command).rejects.toMatchObject({ name: 'AbortError', dispatchStatus: 'unknown' });
            await waitForSent(fake.sent, 1);
            issued.abort();
            await canceled;
            expect(fake.sent).toHaveLength(1);
        } finally { transport.dispose(); }
    });

    it('distinguishes proven pre-send refusal from an outstanding command losing its acknowledgement', async () => {
        const fake = createFakeJsonClient();
        const transport = createBrowserSidecarCdpTransport({ client: fake.client });
        try {
            await expect(transport.dispatchBrowserCommand({ method: 'Input.insertText', deadlineMs: Date.now() - 1 }))
                .rejects.toMatchObject({ code: 'cdp_request_timeout', dispatchStatus: 'not_dispatched' });
            expect(fake.sent).toEqual([]);
            const pending = transport.dispatchBrowserCommand({ method: 'Input.insertText', params: { text: 'ordinary text' } });
            const failed = expect(pending).rejects.toMatchObject({ code: 'cdp_transport_closed', dispatchStatus: 'unknown' });
            await waitForSent(fake.sent, 1);
            fake.close();
            await failed;
            await expect(transport.dispatchBrowserCommand({ method: 'Input.insertText' }))
                .rejects.toMatchObject({ code: 'cdp_transport_closed', dispatchStatus: 'not_dispatched' });
            expect(fake.sent).toHaveLength(1);
        } finally { transport.dispose(); }
    });

    it('keeps large screenshot responses and screencast events healthy alongside unrelated responses on a real socket', async () => {
        const data = 'A'.repeat(1024 * 1024 + 4);
        let screenshotId: unknown;
        const server = await startCdpWebSocketServer((message) => {
            if (message.method === 'Page.captureScreenshot') {
                screenshotId = message.id;
                return undefined;
            }
            return [
                { method: 'Page.screencastFrame', sessionId: 'page', params: { data } },
                { id: screenshotId, result: { data } },
                { id: message.id, result: { product: 'Chrome/Test' } },
            ];
        });
        const transport = await connectBrowserSidecarCdpTransport({ endpoint: server.endpoint });
        try {
            const events: unknown[] = [];
            transport.subscribeCdpEvents((event) => events.push(event));
            const screenshot = transport.dispatchBrowserCommand({ method: 'Page.captureScreenshot' });
            const version = transport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
            const results = await Promise.allSettled([screenshot, version]);
            expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
            if (results[0].status === 'fulfilled') expect(results[0].value).toEqual({ data });
            if (results[1].status === 'fulfilled') expect(results[1].value).toEqual({ product: 'Chrome/Test' });
            expect(events).toEqual([{ method: 'Page.screencastFrame', sessionId: 'page', params: { data } }]);
        } finally {
            transport.dispose();
            await server.close();
        }
    });

    it('uses the containing deadline beyond five seconds and isolates cancellation and late replies', async () => {
        vi.useFakeTimers();
        const fake = createFakeJsonClient();
        const transport = createBrowserSidecarCdpTransport({ client: fake.client });
        try {
            const abort = new AbortController();
            const long = transport.dispatchBrowserCommand({ method: 'Long', deadlineMs: Date.now() + 10_000 });
            const cancelled = transport.dispatchBrowserCommand({ method: 'Cancelled', signal: abort.signal });
            const cancelledResult = Promise.allSettled([cancelled]);
            const longResult = Promise.allSettled([long]);
            await vi.advanceTimersByTimeAsync(6_000);
            abort.abort();
            expect(await cancelledResult).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }]);
            fake.emit(responseFor(fake.sent[1], {}));
            fake.emit(responseFor(fake.sent[0], { finished: true }));
            expect(await longResult).toEqual([{ status: 'fulfilled', value: { finished: true } }]);
            const timed = transport.dispatchBrowserCommand({ method: 'Timed', deadlineMs: Date.now() + 10 });
            const timedResult = Promise.allSettled([timed]);
            await vi.advanceTimersByTimeAsync(10);
            expect(await timedResult).toMatchObject([{ status: 'rejected', reason: { code: 'cdp_request_timeout' } }]);
            fake.emit(responseFor(fake.sent[2], {}));
            const next = transport.dispatchBrowserCommand({ method: 'Next' });
            fake.emit(responseFor(fake.sent[3], { healthy: true }));
            await expect(next).resolves.toEqual({ healthy: true });
        } finally {
            transport.dispose();
            vi.useRealTimers();
        }
    });

    it('opens a focused page through Target.createTarget, attachToTarget, and activateTarget', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const fake = createFakeJsonClient();
        const transport = mod.createBrowserSidecarCdpTransport({
            client: fake.client,
        });

        const opened = transport.openPage({
            url: 'https://browser.example.test/open',
            focus: true,
        });

        await waitForSent(fake.sent, 1);
        expect(fake.sent[0]).toMatchObject({
            method: 'Target.createTarget',
            params: { url: 'https://browser.example.test/open' },
        });
        fake.emit(responseFor(fake.sent[0], { targetId: 'target_secret' }));

        await waitForSent(fake.sent, 2);
        expect(fake.sent[1]).toMatchObject({
            method: 'Target.attachToTarget',
            params: { targetId: 'target_secret', flatten: true },
        });
        fake.emit(responseFor(fake.sent[1], { sessionId: 'session_secret' }));

        await waitForSent(fake.sent, 3);
        expect(fake.sent[2]).toMatchObject({
            method: 'Target.activateTarget',
            params: { targetId: 'target_secret' },
        });
        fake.emit(responseFor(fake.sent[2], {}));

        await expect(opened).resolves.toEqual({
            targetId: 'target_secret',
            sessionId: 'session_secret',
        });
    });

    it('correlates response ids, ignores CDP events, and dispatches page commands on the flattened session', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const fake = createFakeJsonClient();
        const transport = mod.createBrowserSidecarCdpTransport({
            client: fake.client,
        });

        const result = transport.dispatchPageCommand({
            targetId: 'target_secret',
            sessionId: 'session_secret',
            method: 'Page.navigate',
            params: { url: 'https://browser.example.test/next' },
        });

        await waitForSent(fake.sent, 1);
        expect(fake.sent[0]).toMatchObject({
            sessionId: 'session_secret',
            method: 'Page.navigate',
            params: { url: 'https://browser.example.test/next' },
        });

        fake.emit({
            method: 'Target.targetInfoChanged',
            params: { targetId: 'unrelated_target' },
        });
        fake.emit(responseFor(fake.sent[0], { frameId: 'frame_1' }));

        await expect(result).resolves.toEqual({ frameId: 'frame_1' });
    });

    it('delivers CDP event notifications to subscribers and stops after unsubscribe', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const fake = createFakeJsonClient();
        const transport = mod.createBrowserSidecarCdpTransport({
            client: fake.client,
        });

        const received: Array<Record<string, unknown>> = [];
        const unsubscribe = transport.subscribeCdpEvents((notification) => {
            received.push(notification);
        });

        // A response (with id) is correlated, not delivered as an event.
        const command = transport.dispatchPageCommand({
            targetId: 'target_secret',
            sessionId: 'session_secret',
            method: 'Page.navigate',
            params: { url: 'https://browser.example.test/next' },
        });
        await waitForSent(fake.sent, 1);
        fake.emit(responseFor(fake.sent[0], { frameId: 'frame_1' }));
        await expect(command).resolves.toEqual({ frameId: 'frame_1' });

        fake.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'session_secret',
            params: { requestId: 'r1', request: { url: 'https://browser.example.test/a' } },
        });
        expect(received).toEqual([{
            method: 'Network.requestWillBeSent',
            sessionId: 'session_secret',
            params: { requestId: 'r1', request: { url: 'https://browser.example.test/a' } },
        }]);

        unsubscribe();
        fake.emit({ method: 'Network.responseReceived', sessionId: 'session_secret', params: {} });
        expect(received).toHaveLength(1);
    });

    it('rejects protocol failures without leaking endpoint, target, or session details', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const fake = createFakeJsonClient();
        const transport = mod.createBrowserSidecarCdpTransport({
            client: fake.client,
        });

        const command = transport.dispatchPageCommand({
            targetId: 'target_secret',
            sessionId: 'session_secret',
            method: 'Page.navigate',
            params: { url: 'https://browser.example.test/next' },
        });
        await waitForSent(fake.sent, 1);
        fake.emit({
            id: fake.sent[0].id,
            error: {
                code: -32000,
                message: 'raw failure ws://127.0.0.1:9222/devtools/browser/token session_secret target_secret',
            },
        });

        await expect(command).rejects.toMatchObject({
            code: 'cdp_command_failed',
        });
        await expect(command).rejects.not.toThrow(/ws:\/\/|session_secret|target_secret/u);
    });

    it('rejects unknown response ids, malformed responses, close, containing deadline, and dispose', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const unknownIdClient = createFakeJsonClient();
        const unknownIdTransport = mod.createBrowserSidecarCdpTransport({
            client: unknownIdClient.client,
        });
        const unknownIdCommand = unknownIdTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(unknownIdClient.sent, 1);
        unknownIdClient.emit({ id: unknownIdClient.sent[0].id + 100, result: {} });
        await expect(unknownIdCommand).rejects.toMatchObject({ code: 'cdp_protocol_error' });

        const malformedClient = createFakeJsonClient();
        const malformedTransport = mod.createBrowserSidecarCdpTransport({
            client: malformedClient.client,
        });
        const malformedCommand = malformedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(malformedClient.sent, 1);
        malformedClient.emit('not a json-rpc response');
        await expect(malformedCommand).rejects.toMatchObject({ code: 'cdp_malformed_response' });

        const closedClient = createFakeJsonClient();
        const closedTransport = mod.createBrowserSidecarCdpTransport({
            client: closedClient.client,
        });
        const closedCommand = closedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(closedClient.sent, 1);
        closedClient.close(new Error('socket closed at ws://127.0.0.1:9222/devtools/browser/token'));
        await expect(closedCommand).rejects.toMatchObject({ code: 'cdp_transport_closed' });
        await expect(closedCommand).rejects.not.toThrow(/ws:\/\//u);

        const timeoutClient = createFakeJsonClient();
        const timeoutTransport = mod.createBrowserSidecarCdpTransport({
            client: timeoutClient.client,
        });
        await expect(timeoutTransport.dispatchBrowserCommand({ method: 'Browser.getVersion', deadlineMs: Date.now() + 5 }))
            .rejects.toMatchObject({ code: 'cdp_request_timeout' });

        const disposedClient = createFakeJsonClient();
        const disposedTransport = mod.createBrowserSidecarCdpTransport({
            client: disposedClient.client,
        });
        const disposedCommand = disposedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(disposedClient.sent, 1);
        disposedTransport.dispose();
        await expect(disposedCommand).rejects.toMatchObject({ code: 'cdp_transport_disposed' });
    });

    it('connects to an already-discovered loopback DevTools endpoint and rejects malformed JSON privately', async () => {
        const mod = await loadTransportModule();

        expect(mod?.connectBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.connectBrowserSidecarCdpTransport) return;

        const server = await startCdpWebSocketServer((message) => {
            if (message.method === 'Browser.getVersion') {
                return { id: message.id, result: { product: 'Chrome/Test' } };
            }
            return 'not-json';
        });
        try {
            const transport = await mod.connectBrowserSidecarCdpTransport({
                endpoint: server.endpoint,
                connectTimeoutMs: 250,
            });
            await expect(transport.dispatchBrowserCommand({ method: 'Browser.getVersion' }))
                .resolves.toEqual({ product: 'Chrome/Test' });

            const malformed = transport.dispatchBrowserCommand({ method: 'Malformed.response' });
            await expect(malformed).rejects.toMatchObject({ code: 'cdp_malformed_response' });
            await expect(malformed).rejects.not.toThrow(/ws:\/\/|server-token/u);
            transport.dispose();
        } finally {
            await server.close();
        }
    });
});
