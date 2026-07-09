import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
    ExecLoopbackWebSocketEndpointV1,
    ExecLoopbackWebSocketJsonClientSpecV1,
    ExecProcessHandleV1,
} from '@happier-dev/plugin-sdk';

import { createPluginExecService } from '../context/exec';
import { encodeLoopbackHandshakeFrame } from './loopbackHandshake';
import {
    createLoopbackWebSocketJsonClient,
    createLoopbackWebSocketProcessClient,
} from './loopbackWebSocket';

const FIXTURE_SOURCE = String.raw`
const { createHash } = require('node:crypto');
const http = require('node:http');

const config = JSON.parse(process.env.HAPPIER_LOOPBACK_WS_FIXTURE_CONFIG || '{}');
let stdinBuffer = Buffer.alloc(0);
let handshakeHandled = false;
let responseWritten = false;

function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const prefix = Buffer.alloc(4);
  if (config.byteOrder === 'big-endian') {
    prefix.writeUInt32BE(body.length, 0);
  } else {
    prefix.writeUInt32LE(body.length, 0);
  }
  return Buffer.concat([prefix, body]);
}

function readFrameLength(buffer) {
  return config.byteOrder === 'big-endian'
    ? buffer.readUInt32BE(0)
    : buffer.readUInt32LE(0);
}

function writeHandshakeResponse(port) {
  responseWritten = true;
  const response = JSON.stringify({
    host: config.host || '127.0.0.1',
    port,
    path: config.path || '/runtime',
    protocol: config.protocol || 'ws',
    apiKey: config.apiKey,
    url: config.url,
  });
  process.stdout.write(encodeFrame(response));
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error('fixture supports small frames only');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function decodeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const length = buffer[1] & 0x7f;
  const masked = (buffer[1] & 0x80) !== 0;
  const headerLength = 2 + (masked ? 4 : 0);
  if (length >= 126) throw new Error('fixture supports small frames only');
  if (buffer.length < headerLength + length) return null;
  const mask = masked ? buffer.subarray(2, 6) : null;
  const payload = Buffer.from(buffer.subarray(headerLength, headerLength + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }
  return { opcode, text: payload.toString('utf8'), rest: buffer.subarray(headerLength + length) };
}

function acceptKey(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function startServer() {
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    if (request.url !== (config.path || '/runtime')) {
      socket.destroy();
      return;
    }
    if (request.headers['x-loopback-api-key'] !== config.apiKey) {
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(request.headers['sec-websocket-key']),
      '',
      '',
    ].join('\r\n'));
    let wsBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      wsBuffer = Buffer.concat([wsBuffer, chunk]);
      for (;;) {
        const decoded = decodeWsFrame(wsBuffer);
        if (!decoded) break;
        wsBuffer = decoded.rest;
        if (decoded.opcode === 0x8) {
          socket.end();
          continue;
        }
        const message = JSON.parse(decoded.text);
        if (message.kind === 'flood') {
          for (let index = 0; index < message.count; index += 1) {
            socket.write(encodeWsFrame(JSON.stringify({ index, payload: 'x'.repeat(message.payloadBytes || 1) })));
          }
          continue;
        }
        socket.write(encodeWsFrame(JSON.stringify({ echo: message, sawHeader: request.headers['x-loopback-api-key'] })));
      }
    });
  });
  const listenPort = config.listenPort === undefined ? 0 : config.listenPort;
  server.listen(listenPort, '127.0.0.1', () => {
    const address = server.address();
    const port = config.port === undefined ? address.port : config.port;
    if (!responseWritten) {
      setTimeout(() => writeHandshakeResponse(port), config.responseDelayMs || 0);
    }
  });
  process.stdin.on('end', () => {
    server.close(() => process.exit(0));
  });
}

function handleHandshakeFrame(payload) {
  handshakeHandled = true;
  if (config.stderrFlood) {
    process.stderr.write((config.secret || '') + ' flood-start\n');
    for (let index = 0; index < config.stderrFlood; index += 1) {
      process.stderr.write('stderr-line-' + index + ' ' + (config.secret || '') + '\n');
    }
  }
  if (config.exitAfterHandshake) {
    process.stderr.write('fixture exiting after handshake with ' + (config.secret || '') + '\n');
    process.exit(config.exitCode || 42);
  }
  if (config.expectHandshakeHex && payload.toString('hex') !== config.expectHandshakeHex) {
    process.stderr.write('unexpected handshake ' + payload.toString('hex') + '\n');
    process.exit(43);
  }
  if (config.invalidResponse) {
    process.stdout.write(encodeFrame(config.invalidResponse));
    return;
  }
  if (config.skipResponse) {
    return;
  }
  if (config.immediateResponseBeforeListen) {
    writeHandshakeResponse(config.port);
    setTimeout(startServer, config.listenDelayMs || 0);
    return;
  }
  setTimeout(startServer, config.listenDelayMs || 0);
}

process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  if (!handshakeHandled && stdinBuffer.length >= 4) {
    const length = readFrameLength(stdinBuffer);
    if (stdinBuffer.length >= 4 + length) {
      handleHandshakeFrame(stdinBuffer.subarray(4, 4 + length));
    }
  }
});
`;

async function createFixtureBinary(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happier-loopback-ws-fixture-'));
    const path = join(root, 'fixture.cjs');
    await writeFile(path, FIXTURE_SOURCE, 'utf8');
    await chmod(path, 0o755);
    return path;
}

async function reserveLoopbackPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    return address.port;
}

async function createRawLoopbackProbe(): Promise<{
    readonly port: number;
    readonly received: () => Buffer;
    readonly close: () => Promise<void>;
}> {
    const chunks: Buffer[] = [];
    const server = createServer((socket) => {
        socket.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
            socket.destroy();
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
        port: address.port,
        received: () => Buffer.concat(chunks),
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function createHangingUpgradeServer(): Promise<{
    readonly port: number;
    readonly close: () => Promise<void>;
}> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
        socket.on('data', () => {
            // Accept the TCP connection and request bytes but never complete the
            // WebSocket upgrade.
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
        port: address.port,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

function createCountingAbortSignal(): {
    readonly signal: AbortSignal;
    readonly activeAbortListeners: () => number;
} {
    const controller = new AbortController();
    const signal = controller.signal;
    const activeListeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
    const addEventListener = signal.addEventListener.bind(signal);
    const removeEventListener = signal.removeEventListener.bind(signal);

    signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
        const [type, listener] = args;
        if (type === 'abort' && listener) {
            activeListeners.add(listener);
        }
        return addEventListener(...args);
    }) as AbortSignal['addEventListener'];
    signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
        const [type, listener] = args;
        if (type === 'abort' && listener) {
            activeListeners.delete(listener);
        }
        return removeEventListener(...args);
    }) as AbortSignal['removeEventListener'];

    return {
        signal,
        activeAbortListeners: () => activeListeners.size,
    };
}

function decodeHandshake(bytes: Uint8Array): {
    host?: string;
    port?: number;
    path?: string;
    protocol?: string;
    apiKey?: string;
    url?: string;
} {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

function createSpec(
    executablePath: string,
    config: Record<string, unknown>,
): ExecLoopbackWebSocketJsonClientSpecV1<ExecLoopbackWebSocketEndpointV1> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : 'fixture-loopback-key';
    const byteOrder = config.byteOrder === 'big-endian' ? 'big-endian' : 'little-endian';
    return {
        launch: {
            kind: 'binary',
            executablePath: process.execPath,
            args: [executablePath],
            env: {
                HAPPIER_LOOPBACK_WS_FIXTURE_CONFIG: JSON.stringify({ ...config, apiKey }),
            },
        },
        transport: {
            kind: 'spawned-loopback-websocket',
            handshake: {
                byteOrder,
                requestFrames: [Uint8Array.from([0x61, 0x62, 0x63])],
                response: {
                    byteOrder,
                    maxFrameBytes: 4096,
                    timeoutMs: 500,
                },
            },
            connect: {
                timeoutMs: 600,
                retryInitialDelayMs: 5,
                retryMaxDelayMs: 25,
            },
            shutdown: {
                kind: 'close-stdin',
                graceMs: 300,
            },
            limits: {
                maxMessageBytes: 2048,
                maxPendingMessages: 8,
                maxBufferedBytes: 4096,
            },
        },
        protocol: {
            kind: 'json-websocket',
            endpoint: {
                decodeHandshakeResponse: decodeHandshake,
                buildHeaders(endpoint) {
                    const endpointApiKey = typeof endpoint.apiKey === 'string' ? endpoint.apiKey : apiKey;
                    return [
                        {
                            name: 'x-loopback-api-key',
                            value: endpointApiKey,
                            sensitive: true,
                        },
                    ];
                },
            },
        },
        lifecycle: {
            maxStderrBytes: 256,
            diagnostics: {
                sanitizer: {
                    redactedValues: [apiKey, String(config.secret ?? '')].filter((value) => value.length > 0),
                },
            },
        },
    };
}

async function createHandle(config: Record<string, unknown> = {}) {
    const fixture = await createFixtureBinary();
    const exec = createPluginExecService({
        allowedExecutablePaths: [process.execPath],
        allowPathRuntimeNames: ['node'],
    });
    const handle = await exec.spawnClient(createSpec(fixture, config));
    return handle;
}

function createAlreadyFlowingHandshakeProcess(
    responseFrame: Buffer,
): {
    readonly process: Parameters<typeof createLoopbackWebSocketProcessClient>[0]['process'];
    readonly wroteStdin: () => boolean;
} {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let stdinWritten = false;

    stdout.on('data', () => {
        // Simulates the generic bounded stdout diagnostics capture already flowing.
    });

    const exit = new Promise<Awaited<ExecProcessHandleV1['exit']>>(() => {
        // Keep the synthetic child alive long enough for the handshake timeout path.
    });
    const handle: ExecProcessHandleV1 = {
        pid: 12_345,
        exit,
        writeStdin: async () => {
            stdinWritten = true;
            stdout.write(responseFrame);
        },
        kill: () => false,
        dispose: async () => undefined,
    };

    return {
        process: {
            child: {
                stdin,
                stdout,
            },
            handle,
            readStderrPreview: () => 'synthetic stderr preview with token <redacted>',
        },
        wroteStdin: () => stdinWritten,
    };
}

describe('A.13p.10 spawned loopback WebSocket client transport', () => {
    it('performs a little-endian stdin/stdout handshake and exchanges JSON messages with child-advertised loopback credentials', async () => {
        const handle = await createHandle({
            expectHandshakeHex: '616263',
            apiKey: 'secret-loopback-api-key',
        });
        const received: unknown[] = [];
        const unsubscribe = handle.client.subscribe((message) => {
            received.push(message);
        });
        try {
            await handle.client.sendJson({ kind: 'ping' });
            await expect.poll(() => received).toEqual([
                {
                    echo: { kind: 'ping' },
                    sawHeader: 'secret-loopback-api-key',
                },
            ]);
        } finally {
            unsubscribe();
            await handle.dispose();
        }
    });

    it('performs a big-endian stdin/stdout handshake when advertised by the transport descriptor', async () => {
        const handle = await createHandle({
            byteOrder: 'big-endian',
            expectHandshakeHex: '616263',
            apiKey: 'secret-loopback-api-key',
        });
        const received: unknown[] = [];
        const unsubscribe = handle.client.subscribe((message) => {
            received.push(message);
        });
        try {
            await handle.client.sendJson({ kind: 'big-endian-ping' });
            await expect.poll(() => received).toEqual([
                {
                    echo: { kind: 'big-endian-ping' },
                    sawHeader: 'secret-loopback-api-key',
                },
            ]);
        } finally {
            unsubscribe();
            await handle.dispose();
        }
    });

    it('does not lose a synchronous child handshake response when stdout diagnostics are already flowing', async () => {
        const responseFrame = encodeLoopbackHandshakeFrame(
            Buffer.from(JSON.stringify({
                host: 'example.com',
                port: 12_345,
                path: '/runtime',
                apiKey: 'race-key',
            })),
            'little-endian',
        );
        const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
        const spec = createSpec(process.execPath, { apiKey: 'race-key' });

        await expect(createLoopbackWebSocketProcessClient({
            spec: {
                ...spec,
                transport: {
                    ...spec.transport,
                    handshake: {
                        ...spec.transport.handshake,
                        response: {
                            ...spec.transport.handshake.response,
                            timeoutMs: 25,
                        },
                    },
                },
            },
            process: fake.process,
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
        expect(fake.wroteStdin()).toBe(true);
    });

    it('rejects endpoint paths with HTTP control characters before sending a WebSocket upgrade request', async () => {
        const probe = await createRawLoopbackProbe();
        try {
            const responseFrame = encodeLoopbackHandshakeFrame(
                Buffer.from(JSON.stringify({
                    host: '127.0.0.1',
                    port: probe.port,
                    path: '/runtime\r\nX-Injected: yes',
                    apiKey: 'path-injection-key',
                })),
                'little-endian',
            );
            const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
            const spec = createSpec(process.execPath, { apiKey: 'path-injection-key' });

            await expect(createLoopbackWebSocketProcessClient({
                spec: {
                    ...spec,
                    transport: {
                        ...spec.transport,
                        connect: {
                            timeoutMs: 40,
                            retryInitialDelayMs: 5,
                            retryMaxDelayMs: 5,
                        },
                    },
                },
                process: fake.process,
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            });
            expect(probe.received().toString('latin1')).toBe('');
        } finally {
            await probe.close();
        }
    });

    it('retries WebSocket connect until the child loopback listener is ready', async () => {
        const handle = await createHandle({
            listenDelayMs: 75,
        });
        try {
            const received: unknown[] = [];
            handle.client.subscribe((message) => {
                received.push(message);
            });
            await handle.client.sendJson({ kind: 'after-ready' });
            await expect.poll(() => received).toEqual([
                expect.objectContaining({ echo: { kind: 'after-ready' } }),
            ]);
        } finally {
            await handle.dispose();
        }
    });

    it('does not retry a completed socket upgrade failure as loopback readiness', async () => {
        const probe = await createRawLoopbackProbe();
        try {
            const responseFrame = encodeLoopbackHandshakeFrame(
                Buffer.from(JSON.stringify({
                    host: '127.0.0.1',
                    port: probe.port,
                    path: '/runtime',
                    apiKey: 'upgrade-rejected-key',
                })),
                'little-endian',
            );
            const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
            const spec = createSpec(process.execPath, { apiKey: 'upgrade-rejected-key' });

            await expect(createLoopbackWebSocketProcessClient({
                spec: {
                    ...spec,
                    transport: {
                        ...spec.transport,
                        connect: {
                            timeoutMs: 80,
                            retryInitialDelayMs: 5,
                            retryMaxDelayMs: 5,
                        },
                    },
                },
                process: fake.process,
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            });
        } finally {
            await probe.close();
        }
    });

    it('times out when a loopback socket accepts TCP but never completes the WebSocket upgrade', async () => {
        const server = await createHangingUpgradeServer();
        const connectPromise = createLoopbackWebSocketJsonClient({
            endpoint: { url: `ws://127.0.0.1:${server.port}/runtime` },
            connect: {
                timeoutMs: 35,
                retryInitialDelayMs: 5,
                retryMaxDelayMs: 5,
            },
        });
        connectPromise.catch(() => undefined);

        try {
            const result: unknown = await Promise.race([
                connectPromise.catch((error: unknown) => error),
                new Promise((resolve) => {
                    setTimeout(() => resolve({ status: 'still_pending' }), 120);
                }),
            ]);

            expect(result).toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
            });
        } finally {
            await server.close();
        }
    });

    it('removes abort listeners after successful retry backoff delays', async () => {
        const fixture = await createFixtureBinary();
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });
        const port = await reserveLoopbackPort();
        const counting = createCountingAbortSignal();
        const handle = await exec.spawnClient(createSpec(fixture, {
            port,
            listenPort: port,
            immediateResponseBeforeListen: true,
            listenDelayMs: 75,
        }), {
            signal: counting.signal,
        });

        try {
            const received: unknown[] = [];
            handle.client.subscribe((message) => {
                received.push(message);
            });
            await handle.client.sendJson({ kind: 'after-retry-delay' });
            await expect.poll(() => received).toEqual([
                expect.objectContaining({ echo: { kind: 'after-retry-delay' } }),
            ]);
        } finally {
            await handle.dispose();
        }
        expect(counting.activeAbortListeners()).toBe(0);
    });

    it.each([
        ['non-loopback host', { host: 'example.com' }],
        ['out-of-range port', { port: 70000 }],
        ['credential-bearing URL', { url: 'ws://user:pass@127.0.0.1:1234/runtime' }],
        ['HTTP protocol', { protocol: 'http' }],
    ])('rejects %s before exposing a socket client', async (_label, config) => {
        const fixture = await createFixtureBinary();
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });

        await expect(exec.spawnClient(createSpec(fixture, config))).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('fails closed on bounded inbound backpressure instead of dropping WebSocket messages', async () => {
        const fixture = await createFixtureBinary();
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });
        const spec = createSpec(fixture, {});
        const handle = await exec.spawnClient({
            ...spec,
            transport: {
                ...spec.transport,
                limits: {
                    maxMessageBytes: 2048,
                    maxPendingMessages: 1,
                    maxBufferedBytes: 4096,
                },
            },
        });
        handle.client.subscribe(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        try {
            await handle.client.sendJson({ kind: 'flood', count: 5 });
            await expect(handle.client.closed).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED',
            });
        } finally {
            await handle.dispose();
        }
    });

    it('closes stdin for graceful shutdown and disposes the sidecar exactly once', async () => {
        const handle = await createHandle();
        const exits: unknown[] = [];
        handle.onExit((result) => {
            exits.push(result);
        });

        await handle.dispose({ message: 'done' });
        await handle.dispose({ message: 'done again' });

        await expect.poll(() => exits.length).toBe(1);
        expect(exits[0]).toMatchObject({
            exitCode: 0,
            signal: null,
        });
        expect(handle.status).toBe('disposed');
    });

    it('reports child exit diagnostics with redacted bounded stderr', async () => {
        const fixture = await createFixtureBinary();
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });
        const secret = 'loopback-diagnostic-secret';

        await expect(exec.spawnClient(createSpec(fixture, {
            exitAfterHandshake: true,
            stderrFlood: 100,
            secret,
        }))).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_EXITED',
            stderrPreview: expect.not.stringContaining(secret),
        });
    });

    it('does not expose arbitrary HTTP/S or non-loopback socket dialing through endpoint URLs', async () => {
        const fixture = await createFixtureBinary();
        const exec = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: ['node'],
        });

        await expect(exec.spawnClient(createSpec(fixture, {
            url: 'https://example.com/runtime',
        }))).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });
});
