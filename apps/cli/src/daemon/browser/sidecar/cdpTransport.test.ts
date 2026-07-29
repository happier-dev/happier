import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { LoopbackWebSocketJsonClientV1 } from '@/plugins/runtime/exec/privateContract';
import { describe, expect, it, vi } from 'vitest';

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
        requestTimeoutMs?: number;
        maxResponseBytes?: number;
    }>) => CdpTransport;
    connectBrowserSidecarCdpTransport?: (input: Readonly<{
        endpoint: Readonly<{ url: string }>;
        requestTimeoutMs?: number;
        connectTimeoutMs?: number;
        maxMessageBytes?: number;
    }>) => Promise<CdpTransport>;
}>;

type SentMessage = Record<string, unknown> & Readonly<{ id: number; method: string }>;

async function loadTransportModule(): Promise<CdpTransportModule | null> {
    return import('./cdpTransport') as Promise<CdpTransportModule | null>;
}

function createFakeJsonClient(): {
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
                sent.push(message as SentMessage);
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
    if (payload.byteLength >= 126) throw new Error('test server supports small frames only');
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
                socket.write(encodeServerFrame(
                    typeof response === 'string'
                        ? response
                        : JSON.stringify(response),
                ));
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
    it('opens a focused page through Target.createTarget, attachToTarget, and activateTarget', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const fake = createFakeJsonClient();
        const transport = mod.createBrowserSidecarCdpTransport({
            client: fake.client,
            requestTimeoutMs: 250,
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
            requestTimeoutMs: 250,
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
            requestTimeoutMs: 250,
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
            requestTimeoutMs: 250,
            maxResponseBytes: 512,
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

    it('rejects unknown response ids, malformed responses, oversize responses, close, timeout, and dispose', async () => {
        const mod = await loadTransportModule();

        expect(mod?.createBrowserSidecarCdpTransport).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpTransport) return;

        const unknownIdClient = createFakeJsonClient();
        const unknownIdTransport = mod.createBrowserSidecarCdpTransport({
            client: unknownIdClient.client,
            requestTimeoutMs: 250,
        });
        const unknownIdCommand = unknownIdTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(unknownIdClient.sent, 1);
        unknownIdClient.emit({ id: unknownIdClient.sent[0].id + 100, result: {} });
        await expect(unknownIdCommand).rejects.toMatchObject({ code: 'cdp_protocol_error' });

        const malformedClient = createFakeJsonClient();
        const malformedTransport = mod.createBrowserSidecarCdpTransport({
            client: malformedClient.client,
            requestTimeoutMs: 250,
        });
        const malformedCommand = malformedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(malformedClient.sent, 1);
        malformedClient.emit('not a json-rpc response');
        await expect(malformedCommand).rejects.toMatchObject({ code: 'cdp_malformed_response' });

        const oversizedClient = createFakeJsonClient();
        const oversizedTransport = mod.createBrowserSidecarCdpTransport({
            client: oversizedClient.client,
            requestTimeoutMs: 250,
            maxResponseBytes: 32,
        });
        const oversizedCommand = oversizedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(oversizedClient.sent, 1);
        oversizedClient.emit({ id: oversizedClient.sent[0].id, result: { payload: 'x'.repeat(100) } });
        await expect(oversizedCommand).rejects.toMatchObject({ code: 'cdp_response_too_large' });

        const closedClient = createFakeJsonClient();
        const closedTransport = mod.createBrowserSidecarCdpTransport({
            client: closedClient.client,
            requestTimeoutMs: 250,
        });
        const closedCommand = closedTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' });
        await waitForSent(closedClient.sent, 1);
        closedClient.close(new Error('socket closed at ws://127.0.0.1:9222/devtools/browser/token'));
        await expect(closedCommand).rejects.toMatchObject({ code: 'cdp_transport_closed' });
        await expect(closedCommand).rejects.not.toThrow(/ws:\/\//u);

        const timeoutClient = createFakeJsonClient();
        const timeoutTransport = mod.createBrowserSidecarCdpTransport({
            client: timeoutClient.client,
            requestTimeoutMs: 5,
        });
        await expect(timeoutTransport.dispatchBrowserCommand({ method: 'Browser.getVersion' }))
            .rejects.toMatchObject({ code: 'cdp_request_timeout' });

        const disposedClient = createFakeJsonClient();
        const disposedTransport = mod.createBrowserSidecarCdpTransport({
            client: disposedClient.client,
            requestTimeoutMs: 250,
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
                requestTimeoutMs: 250,
                connectTimeoutMs: 250,
                maxMessageBytes: 512,
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
