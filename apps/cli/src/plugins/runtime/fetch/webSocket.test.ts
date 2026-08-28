import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { constants as zlibConstants, deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
    createPluginWebSocketConnection,
    normalizePluginWebSocketOpenInput,
} from './webSocket';

type WireFrame = Readonly<{
    opcode: number;
    payload: Buffer;
}>;

function acceptWebSocketKey(key: string): string {
    return createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer, final = true, compressed = false): Buffer {
    if (payload.byteLength >= 126) throw new Error('Test frame is unexpectedly large');
    return Buffer.concat([
        Buffer.from([(final ? 0x80 : 0) | (compressed ? 0x40 : 0) | opcode, payload.byteLength]),
        payload,
    ]);
}

function readFrame(input: Buffer): Readonly<{ frame: WireFrame; rest: Buffer }> | null {
    if (input.byteLength < 2) return null;
    const opcode = input[0]! & 0x0f;
    const masked = (input[1]! & 0x80) !== 0;
    const payloadLength = input[1]! & 0x7f;
    if (payloadLength >= 126) throw new Error('Test peer received an unexpectedly large frame');
    const headerLength = 2 + (masked ? 4 : 0);
    if (input.byteLength < headerLength + payloadLength) return null;
    const payload = Buffer.from(input.subarray(headerLength, headerLength + payloadLength));
    if (masked) {
        const mask = input.subarray(2, 6);
        for (let index = 0; index < payload.byteLength; index += 1) {
            payload[index] = payload[index]! ^ mask[index % 4]!;
        }
    }
    return Object.freeze({
        frame: Object.freeze({ opcode, payload }),
        rest: input.subarray(headerLength + payloadLength),
    });
}

async function createWebSocketPeer(options: Readonly<{
    respondToClose?: boolean;
    perMessageDeflate?: boolean;
}> = {}): Promise<Readonly<{
    url: string;
    receivedHeader(name: string): string | undefined;
    sendText(text: string): void;
    sendBinary(data: Uint8Array): void;
    sendFragmentedText(first: string, second: string): void;
    sendIncompleteTextFragmentAndTerminate(text: string): void;
    sendTooManyTextFragments(): void;
    sendCompressedText(text: string): void;
    sendClose(code: number, reason: string): void;
    sendPing(text: string): void;
    nextReceived(): Promise<WireFrame>;
    close(): Promise<void>;
}>> {
    let socket: Duplex | null = null;
    let input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headers: Readonly<Record<string, string | string[] | undefined>> = Object.freeze({});
    let serverInitiatedClose = false;
    const received: WireFrame[] = [];
    let waiting: ((frame: WireFrame) => void) | null = null;
    const receive = (frame: WireFrame) => {
        const resolve = waiting;
        waiting = null;
        if (resolve) resolve(frame);
        else received.push(frame);
    };
    const server = createServer();
    server.on('upgrade', (request, upgradedSocket) => {
        const key = request.headers['sec-websocket-key'];
        if (typeof key !== 'string') {
            upgradedSocket.destroy();
            return;
        }
        socket = upgradedSocket;
        headers = Object.freeze({ ...request.headers });
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptWebSocketKey(key)}`,
            'Sec-WebSocket-Protocol: fixture-v1',
            ...(options.perMessageDeflate ? ['Sec-WebSocket-Extensions: permessage-deflate'] : []),
            '',
            '',
        ].join('\r\n'));
        socket.on('data', (chunk) => {
            input = Buffer.concat([input, Buffer.from(chunk)]);
            for (;;) {
                const decoded = readFrame(input);
                if (!decoded) return;
                input = decoded.rest;
                receive(decoded.frame);
                if (
                    decoded.frame.opcode === 0x8
                    && options.respondToClose !== false
                    && !serverInitiatedClose
                    && socket?.writableEnded !== true
                ) {
                    socket?.write(encodeFrame(0x8, decoded.frame.payload));
                    socket?.end();
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
    const write = (frame: Buffer) => {
        if (!socket) throw new Error('WebSocket peer has not accepted the client connection');
        socket.write(frame);
    };
    return Object.freeze({
        url: `ws://127.0.0.1:${address.port}/fixture`,
        receivedHeader(name) {
            const value = headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value;
        },
        sendText(text) {
            write(encodeFrame(0x1, Buffer.from(text)));
        },
        sendBinary(data) {
            write(encodeFrame(0x2, Buffer.from(data)));
        },
        sendFragmentedText(first, second) {
            write(encodeFrame(0x1, Buffer.from(first), false));
            write(encodeFrame(0x0, Buffer.from(second)));
        },
        sendIncompleteTextFragmentAndTerminate(text) {
            write(encodeFrame(0x1, Buffer.from(text), false));
            socket?.end();
        },
        sendTooManyTextFragments() {
            const fragments: Buffer[] = [];
            for (let index = 0; index <= 1024; index += 1) {
                fragments.push(encodeFrame(index === 0 ? 0x1 : 0x0, Buffer.alloc(0), index === 1024));
            }
            write(Buffer.concat(fragments));
        },
        sendCompressedText(text) {
            const compressed = deflateRawSync(Buffer.from(text), {
                flush: zlibConstants.Z_SYNC_FLUSH,
                finishFlush: zlibConstants.Z_SYNC_FLUSH,
            });
            const suffix = Buffer.from([0x00, 0x00, 0xff, 0xff]);
            if (!compressed.subarray(-suffix.byteLength).equals(suffix)) {
                throw new Error('Test peer did not produce a permessage-deflate frame suffix');
            }
            write(encodeFrame(0x1, compressed.subarray(0, -suffix.byteLength), true, true));
        },
        sendClose(code, reason) {
            const reasonBytes = Buffer.from(reason);
            const payload = Buffer.alloc(2 + reasonBytes.byteLength);
            payload.writeUInt16BE(code, 0);
            reasonBytes.copy(payload, 2);
            serverInitiatedClose = true;
            write(encodeFrame(0x8, payload));
            socket?.end();
        },
        sendPing(text) {
            write(encodeFrame(0x9, Buffer.from(text)));
        },
        async nextReceived() {
            const queued = received.shift();
            if (queued) return queued;
            return await new Promise<WireFrame>((resolve) => { waiting = resolve; });
        },
        async close() {
            socket?.destroy();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

async function createHangingUpgradePeer(): Promise<Readonly<{
    url: string;
    upgraded: Promise<void>;
    close(): Promise<void>;
}>> {
    let socket: Duplex | null = null;
    let markUpgraded!: () => void;
    const upgraded = new Promise<void>((resolve) => { markUpgraded = resolve; });
    const server = createServer();
    server.on('upgrade', (_request, upgradedSocket) => {
        socket = upgradedSocket;
        markUpgraded();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return Object.freeze({
        url: `ws://127.0.0.1:${address.port}/hanging-upgrade`,
        upgraded,
        async close() {
            socket?.destroy();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

async function createRejectedUpgradePeer(options: Readonly<{
    status?: number;
    location?: string;
}> = {}): Promise<Readonly<{
    url: string;
    requests(): number;
    close(): Promise<void>;
}>> {
    const status = options.status ?? 401;
    let requests = 0;
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
        requests += 1;
        socket.end([
            `HTTP/1.1 ${status} Rejected`,
            'Connection: close',
            'Content-Length: 0',
            ...(options.location ? [`Location: ${options.location}`] : []),
            '',
            '',
        ].join('\r\n'));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return Object.freeze({
        url: `ws://127.0.0.1:${address.port}/rejected`,
        requests: () => requests,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

async function createUntrustedTlsPeer(): Promise<Readonly<{
    url: string;
    close(): Promise<void>;
}>> {
    const server = createSecureServer({
        key: readFileSync(new URL('../../../../../../packages/tests/fixtures/cliproxyapi-mitm/leaf.key', import.meta.url)),
        cert: readFileSync(new URL('../../../../../../packages/tests/fixtures/cliproxyapi-mitm/leaf.crt', import.meta.url)),
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return Object.freeze({
        url: `wss://127.0.0.1:${address.port}/fixture`,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

async function createPlaintextHttpPeer(): Promise<Readonly<{
    url: string;
    close(): Promise<void>;
}>> {
    const server = createServer();
    server.on('clientError', (_error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return Object.freeze({
        url: `wss://127.0.0.1:${address.port}/fixture`,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket terminal state')), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

describe('plugin WebSocket host adapter', () => {
    it('normalizes secure target origin and rejects credential-bearing/insecure non-loopback URLs and invalid headers before transport creation', () => {
        expect(normalizePluginWebSocketOpenInput({
            url: 'wss://gateway.example.test/socket',
        }).targetOrigin).toBe('https://gateway.example.test');
        expect(() => normalizePluginWebSocketOpenInput({
            url: 'wss://token@example.test/socket',
        })).toThrow(expect.objectContaining({ code: 'plugin_websocket_invalid_url' }));
        expect(() => normalizePluginWebSocketOpenInput({
            url: 'ws://example.test/socket',
        })).toThrow(expect.objectContaining({ code: 'plugin_websocket_insecure_url_denied' }));
        expect(() => normalizePluginWebSocketOpenInput({
            url: 'wss://example.test/socket',
            headers: [{ name: 'x-api-key', value: 'abc\r\ndef' }],
        })).toThrow(expect.objectContaining({ code: 'plugin_websocket_invalid_header' }));
    });

    it('bounds the encoded offered-protocol header together with UTF-8 custom header lines', () => {
        const header = Object.freeze({ name: 'x-boundary', value: 'é' });
        const protocolTokenBytesJustUnderLimit = (64 * 1024)
            - Buffer.byteLength(`${header.name}: ${header.value}\r\n`)
            - Buffer.byteLength('Sec-WebSocket-Protocol: ,b\r\n')
            - 1;
        const justUnder = 'a'.repeat(protocolTokenBytesJustUnderLimit);

        expect(normalizePluginWebSocketOpenInput({
            url: 'wss://gateway.example.test/socket',
            protocols: [justUnder, 'b'],
            headers: [header],
        })).toMatchObject({
            protocols: [justUnder, 'b'],
            headers: { 'x-boundary': 'é' },
        });
        expect(normalizePluginWebSocketOpenInput({
            url: 'wss://gateway.example.test/socket',
            protocols: [`${justUnder}a`, 'b'],
            headers: [header],
        })).toMatchObject({
            protocols: [`${justUnder}a`, 'b'],
        });
        expect(() => normalizePluginWebSocketOpenInput({
            url: 'wss://gateway.example.test/socket',
            protocols: [`${justUnder}aa`, 'b'],
            headers: [header],
        })).toThrow(expect.objectContaining({ code: 'plugin_websocket_invalid_header' }));
    });

    it('uses the bounded neutral connection for fragmented messages, ping/pong, binary sends, and lifecycle retirement', async () => {
        const peer = await createWebSocketPeer();
        const lifecycle = new AbortController();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
                headers: [{ name: 'x-fixture-token', value: 'fixture-secret', sensitive: true }],
                maxMessageBytes: 256,
                maxPendingMessages: 4,
                maxPendingBytes: 512,
                maxBufferedSendBytes: 512,
            }, { lifecycleSignal: lifecycle.signal });

            expect(connection.protocol).toBe('fixture-v1');
            expect(peer.receivedHeader('x-fixture-token')).toBe('fixture-secret');
            peer.sendFragmentedText('frag', 'mented');
            await expect(connection.receive()).resolves.toEqual({ kind: 'text', text: 'fragmented' });

            peer.sendBinary(Uint8Array.from([0, 1, 255]));
            await expect(connection.receive()).resolves.toEqual({
                kind: 'binary',
                data: Uint8Array.from([0, 1, 255]),
            });

            peer.sendPing('heartbeat');
            await expect(peer.nextReceived()).resolves.toMatchObject({
                opcode: 0xA,
                payload: Buffer.from('heartbeat'),
            });

            await connection.send({ kind: 'binary', data: Uint8Array.from([0, 1, 255]) });
            await expect(peer.nextReceived()).resolves.toMatchObject({
                opcode: 0x2,
                payload: Buffer.from([0, 1, 255]),
            });

            lifecycle.abort(Object.freeze({ kind: 'generationRetired' as const }));
            await expect(connection.closed).resolves.toMatchObject({
                kind: 'generationRetired',
                wasClean: false,
                diagnostic: { code: 'plugin_websocket_lifecycle_closed' },
            });
        } finally {
            await peer.close();
        }
    });

    it('connects only through an admitted address while retaining the original WebSocket hostname', async () => {
        const peer = await createWebSocketPeer();
        const peerUrl = new URL(peer.url);
        try {
            const connection = await createPluginWebSocketConnection({
                url: `ws://pinned.invalid:${peerUrl.port}${peerUrl.pathname}`,
                protocols: ['fixture-v1'],
                allowInsecureWs: true,
            }, { validatedAddresses: ['127.0.0.1'] });

            expect(connection.url).toBe(`ws://pinned.invalid:${peerUrl.port}${peerUrl.pathname}`);
            expect(peer.receivedHeader('host')).toBe(`pinned.invalid:${peerUrl.port}`);
            connection.dispose();
            await connection.closed;
        } finally {
            await peer.close();
        }
    });

    it('never falls back to ordinary DNS when admission supplies an empty address set', async () => {
        await expect(createPluginWebSocketConnection({
            url: 'wss://unresolved.example.test/socket',
        }, { validatedAddresses: [] })).rejects.toMatchObject({
            code: 'plugin_websocket_connect_failed',
        });
    });

    it('does not disclose an already-buffered message after lifecycle retirement', async () => {
        const peer = await createWebSocketPeer();
        const lifecycle = new AbortController();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            }, { lifecycleSignal: lifecycle.signal });

            peer.sendText('queued-before-retirement');
            // RFC frame order gives the auto-pong a real transport barrier: the
            // preceding complete message has reached the connection owner.
            peer.sendPing('queue-barrier');
            await expect(peer.nextReceived()).resolves.toMatchObject({
                opcode: 0xA,
                payload: Buffer.from('queue-barrier'),
            });

            lifecycle.abort(Object.freeze({ kind: 'generationRetired' as const }));

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'generationRetired',
                wasClean: false,
            });
            await expect(connection.receive()).resolves.toMatchObject({
                kind: 'closed',
                close: { kind: 'generationRetired' },
            });
        } finally {
            await peer.close();
        }
    });

    it('preserves a clean remote close through the neutral terminal owner', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });

            peer.sendClose(1000, 'finished');

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'remote',
                code: 1000,
                reason: 'finished',
                wasClean: true,
            });
        } finally {
            await peer.close();
        }
    });

    it('allows a cancelled receive to be retried without leaving a waiter behind', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });
            const cancellation = new AbortController();
            const receiving = connection.receive({ signal: cancellation.signal });

            cancellation.abort();

            await expect(receiving).rejects.toMatchObject({ name: 'AbortError' });
            peer.sendText('after-cancel');
            await expect(connection.receive()).resolves.toEqual({ kind: 'text', text: 'after-cancel' });
            connection.dispose();
        } finally {
            await peer.close();
        }
    });

    it('aborts a connection draft before the upgrade can settle', async () => {
        const peer = await createHangingUpgradePeer();
        const cancellation = new AbortController();
        try {
            const opening = createPluginWebSocketConnection({
                url: peer.url,
                connectTimeoutMs: 1_000,
            }, { signal: cancellation.signal });

            await peer.upgraded;
            cancellation.abort();

            await expect(opening).rejects.toMatchObject({ code: 'plugin_websocket_aborted' });
        } finally {
            await peer.close();
        }
    });

    it('preserves a clean local close through the terminal owner', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });

            connection.close({ code: 1000, reason: 'finished' });

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'local',
                code: 1000,
                reason: 'finished',
                wasClean: true,
            });
        } finally {
            await peer.close();
        }
    });

    it('fails closed when the inbound pending-message bound is exceeded', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
                maxPendingMessages: 1,
                maxPendingBytes: 128,
            });
            peer.sendText('first');
            peer.sendText('second');

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'error',
                code: 1009,
                diagnostic: { code: 'plugin_websocket_backpressure_exceeded' },
            });
        } finally {
            await peer.close();
        }
    });

    it('reports an abrupt close during a fragmented message as a protocol failure', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });

            peer.sendIncompleteTextFragmentAndTerminate('unfinished');

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'error',
                wasClean: false,
                diagnostic: { code: 'plugin_websocket_protocol_error' },
            });
        } finally {
            await peer.close();
        }
    });

    it('fails closed when a message exceeds the fixed 1,024-fragment driver bound', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });

            peer.sendTooManyTextFragments();

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'error',
                code: 1008,
                wasClean: false,
                diagnostic: { code: 'plugin_websocket_fragment_limit_exceeded' },
            });
        } finally {
            await peer.close();
        }
    });

    it('enforces the admitted post-inflation payload bound for permessage-deflate', async () => {
        const peer = await createWebSocketPeer({ perMessageDeflate: true });
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
                maxMessageBytes: 64,
            });

            peer.sendCompressedText('x'.repeat(1024));

            await expect(connection.closed).resolves.toMatchObject({
                kind: 'error',
                code: 1009,
                wasClean: false,
                diagnostic: { code: 'plugin_websocket_message_too_large' },
            });
        } finally {
            await peer.close();
        }
    });

    it('preserves an HTTP upgrade refusal instead of reporting a generic connect failure', async () => {
        const peer = await createRejectedUpgradePeer();
        try {
            await expect(createPluginWebSocketConnection({ url: peer.url })).rejects.toMatchObject({
                code: 'plugin_websocket_upgrade_rejected',
            });
        } finally {
            await peer.close();
        }
    });

    it('does not follow HTTP redirects outside the already-admitted target', async () => {
        const peer = await createRejectedUpgradePeer({ status: 302, location: '/redirected' });
        try {
            await expect(createPluginWebSocketConnection({ url: peer.url })).rejects.toMatchObject({
                code: 'plugin_websocket_upgrade_rejected',
            });
            expect(peer.requests()).toBe(1);
        } finally {
            await peer.close();
        }
    });

    it('reports an untrusted wss certificate as a typed TLS failure without echoing sensitive headers', async () => {
        const peer = await createUntrustedTlsPeer();
        try {
            await expect(createPluginWebSocketConnection({
                url: peer.url,
                headers: [{ name: 'authorization', value: 'fixture-secret', sensitive: true }],
            })).rejects.toSatisfy((error: unknown) => {
                expect(error).toMatchObject({ code: 'plugin_websocket_tls_error' });
                expect(String(error)).not.toContain('fixture-secret');
                expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('fixture-secret');
                return true;
            });
        } finally {
            await peer.close();
        }
    });

    it('keeps wss certificate verification enabled when the process environment opts out globally', async () => {
        const peer = await createUntrustedTlsPeer();
        const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
            await expect(createPluginWebSocketConnection({ url: peer.url })).rejects.toMatchObject({
                code: 'plugin_websocket_tls_error',
            });
        } finally {
            if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
            await peer.close();
        }
    });

    it('reports a plaintext endpoint addressed with wss as a typed TLS failure', async () => {
        const peer = await createPlaintextHttpPeer();
        try {
            await expect(createPluginWebSocketConnection({ url: peer.url })).rejects.toMatchObject({
                code: 'plugin_websocket_tls_error',
            });
        } finally {
            await peer.close();
        }
    });

    it('rejects an outgoing message before it exceeds the configured driver-buffer bound', async () => {
        const peer = await createWebSocketPeer();
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
                maxBufferedSendBytes: 1,
            });

            await expect(connection.send({ kind: 'text', text: 'too-large-for-buffer' }))
                .rejects.toMatchObject({ code: 'plugin_websocket_backpressure_exceeded' });

            connection.dispose();
        } finally {
            await peer.close();
        }
    });

    it('settles dispose through the terminal owner when the peer ignores the close handshake', async () => {
        const peer = await createWebSocketPeer({ respondToClose: false });
        try {
            const connection = await createPluginWebSocketConnection({
                url: peer.url,
                protocols: ['fixture-v1'],
            });

            connection.dispose();

            await expect(resolveWithin(connection.closed, 75)).resolves.toMatchObject({
                kind: 'local',
                wasClean: false,
            });
        } finally {
            await peer.close();
        }
    });
});
