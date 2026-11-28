import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { RAW_INVOKE_BODY_ARG } from '../../shared/bridge';
import { HttpTransportState, parseChannelId, parseClientConfig, registerHttpTransportCommands } from './httpTransport';
import type { CommandContext, CommandHandler } from './types';

/** The renderer's `desktop_http_fetch` payload as the preload forwards it: one raw request frame. */
function requestFrame(head: Readonly<Record<string, unknown>>, body: Uint8Array = new Uint8Array()) {
    const encodedHead = Buffer.from(JSON.stringify(head), 'utf8');
    const frame = new Uint8Array(4 + encodedHead.byteLength + body.byteLength);
    new DataView(frame.buffer).setUint32(0, encodedHead.byteLength, true);
    frame.set(encodedHead, 4);
    frame.set(body, 4 + encodedHead.byteLength);
    return { [RAW_INVOKE_BODY_ARG]: frame };
}

type Delivered = { callbackId: number; payload: unknown };

function createContext(delivered: Delivered[]): CommandContext {
    return {
        window: null,
        sender: { id: 1 } as unknown as CommandContext['sender'],
        emitEvent: () => {},
        sendCallback: (callbackId, payload) => {
            delivered.push({ callbackId, payload });
        },
    };
}

async function withServer<T>(handle: (response: ServerResponse, request: IncomingMessage) => void, run: (origin: string) => Promise<T>): Promise<T> {
    const server = createServer((request, response) => handle(response, request));
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
        return await run(`http://127.0.0.1:${port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
}

function decodeFrame(value: unknown): { head: Record<string, unknown>; body: string } {
    assert.ok(value instanceof Uint8Array);
    const headLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, true);
    return {
        head: JSON.parse(Buffer.from(value.subarray(4, 4 + headLength)).toString('utf8')),
        body: Buffer.from(value.subarray(4 + headLength)).toString('utf8'),
    };
}

function setup() {
    const registry = new Map<string, CommandHandler>();
    const state = new HttpTransportState();
    registerHttpTransportCommands(registry, state);
    const delivered: Delivered[] = [];
    return { registry, state, delivered, context: createContext(delivered) };
}

test('a channel argument is read from both the Tauri string form and the context-isolated object form', () => {
    assert.equal(parseChannelId('__CHANNEL__:12'), 12);
    assert.equal(parseChannelId({ id: 12 }), 12);
    assert.equal(parseChannelId('12'), null);
    assert.equal(parseChannelId({ id: 'abc' }), null);
});

test('a client config without a method or url is refused rather than half-executed', () => {
    assert.equal(parseClientConfig({ url: 'https://example.test' }), null);
    assert.equal(parseClientConfig({ method: 'GET' }), null);
});

test('a request frame delivers its exact body bytes and a malformed frame is refused', async () => {
    const { registry, context } = setup();
    const body = new Uint8Array([0, 255, 10, 13, 128]);
    let received: Buffer | undefined;
    await withServer(
        (response, request) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                received = Buffer.concat(chunks);
                response.writeHead(204);
                response.end();
            });
        },
        async (origin) => {
            const frame = decodeFrame(await registry.get('desktop_http_fetch')!(
                requestFrame({ requestId: 4, method: 'PUT', url: origin, headers: [] }, body), context));
            assert.equal(frame.head.status, 204);
        },
    );
    assert.deepEqual([...received!], [...body]);
    assert.throws(() => registry.get('desktop_http_fetch')!({ [RAW_INVOKE_BODY_ARG]: new Uint8Array([9, 0]) }, context), /request frame/);
    assert.throws(() => registry.get('desktop_http_fetch')!({ requestId: 5, clientConfig: { method: 'GET', url: 'https://example.test' } }, context), /request frame/);
});

test('a declared small body comes back with status and headers in the one fetch answer', async () => {
    const { registry, state, delivered, context } = setup();
    await withServer(
        (response) => {
            const body = '{"ok":true}';
            response.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            response.end(body);
        },
        async (origin) => {
            const frame = decodeFrame(await registry.get('desktop_http_fetch')!(
                requestFrame({ requestId: 1, method: 'GET', url: `${origin}/probe`, headers: [['x-test', '1']] }),
                context,
            ));
            assert.equal(frame.head.status, 201);
            assert.equal(frame.head.streamed, false);
            assert.equal(frame.head.url, `${origin}/probe`);
            assert.equal(frame.body, '{"ok":true}');
        },
    );
    assert.deepEqual(delivered, []);
    assert.equal(state.inFlightCount, 0);
});

test('an undeclared body streams into the channel in order and ends with the end byte', async () => {
    const { registry, state, delivered, context } = setup();
    await withServer(
        (response) => {
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            response.write('{"a":1}\n');
            response.end('{"b":2}\n');
        },
        async (origin) => {
            const frame = decodeFrame(await registry.get('desktop_http_fetch')!(
                requestFrame({ requestId: 2, method: 'GET', url: origin, headers: [] }),
                context,
            ));
            assert.equal(frame.head.streamed, true);
            assert.equal(frame.body, '');
            await registry.get('desktop_http_read_body')!({ requestId: 2, channel: { id: 9 } }, context);
        },
    );
    const payloads = delivered.map((entry) => entry.payload as { index: number; message?: Uint8Array; end?: true });
    assert.ok(delivered.every((entry) => entry.callbackId === 9));
    assert.deepEqual(payloads.map((payload) => payload.index), payloads.map((_payload, index) => index));
    assert.equal(payloads.at(-1)?.end, true, 'the callback is released at the end');
    const messages = payloads.flatMap((payload) => (payload.message ? [payload.message] : []));
    assert.deepEqual([...messages.at(-1)!], [1]);
    const body = Buffer.concat(messages.slice(0, -1).map((message) => {
        assert.equal(message.at(-1), 0);
        return message.subarray(0, -1);
    })).toString('utf8');
    assert.equal(body, '{"a":1}\n{"b":2}\n');
    assert.equal(state.inFlightCount, 0);
});

test('a cancel ends a request that is waiting for its response', async () => {
    const { registry, state, context } = setup();
    await withServer(
        () => {},
        async (origin) => {
            const pending = registry.get('desktop_http_fetch')!(
                requestFrame({ requestId: 3, method: 'GET', url: origin, headers: [] }),
                context,
            );
            assert.equal(state.inFlightCount, 1);
            await registry.get('desktop_http_cancel')!({ requestId: 3 }, context);
            await assert.rejects(async () => pending, /Request cancelled/);
        },
    );
    assert.equal(state.inFlightCount, 0);
});
