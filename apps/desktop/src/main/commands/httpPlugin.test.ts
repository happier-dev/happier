import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { HttpPluginState, parseChannelId, parseClientConfig, registerHttpPluginCommands } from './httpPlugin';
import type { CommandContext, CommandHandler } from './types';

type Delivered = { callbackId: number; payload: unknown };

function createContext(delivered: Delivered[]): CommandContext {
    return {
        window: null,
        sender: null as unknown as CommandContext['sender'],
        emitEvent: () => {},
        sendCallback: (callbackId, payload) => {
            delivered.push({ callbackId, payload });
        },
    };
}

async function withServer<T>(
    handle: (path: string) => { status: number; body: string },
    run: (origin: string) => Promise<T>,
): Promise<T> {
    const server = createServer((request, response) => {
        const result = handle(request.url ?? '/');
        response.writeHead(result.status, { 'Content-Type': 'application/json' });
        response.end(result.body);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
        return await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
}

test('a channel argument is read from both the Tauri string form and the context-isolated object form', () => {
    assert.equal(parseChannelId('__CHANNEL__:12'), 12);
    assert.equal(parseChannelId({ id: 12 }), 12);
    assert.equal(parseChannelId('12'), null);
    assert.equal(parseChannelId('__CHANNEL__:abc'), null);
    assert.equal(parseChannelId({ id: 'abc' }), null);
    assert.equal(parseChannelId(null), null);
});

test('a client config without a method or url is refused rather than half-executed', () => {
    assert.equal(parseClientConfig({ url: 'https://example.test' }), null);
    assert.equal(parseClientConfig({ method: 'GET' }), null);
    assert.deepEqual(parseClientConfig({ method: 'GET', url: 'https://example.test' }), {
        method: 'GET',
        url: 'https://example.test',
        headers: [],
        data: null,
    });
});

test('a request is performed on send and its body streams into the channel, terminated by a 1 byte', async () => {
    const registry = new Map<string, CommandHandler>();
    registerHttpPluginCommands(registry, new HttpPluginState());
    const delivered: Delivered[] = [];
    const context = createContext(delivered);

    await withServer(
        () => ({ status: 201, body: '{"ok":true}' }),
        async (origin) => {
            const rid = await registry.get('plugin:http|fetch')!(
                { clientConfig: { method: 'GET', url: `${origin}/probe`, headers: [['x-test', '1']], data: null } },
                context,
            );
            assert.equal(typeof rid, 'number');
            // Nothing is requested until `fetch_send`; the config is only recorded.
            assert.deepEqual(delivered, []);

            const sent = (await registry.get('plugin:http|fetch_send')!({ rid }, context)) as {
                status: number;
                url: string;
                headers: [string, string][];
                rid: number;
            };
            assert.equal(sent.status, 201);
            assert.equal(sent.url, `${origin}/probe`);
            assert.ok(sent.headers.some(([name]) => name === 'content-type'));

            await registry.get('plugin:http|fetch_read_body')!(
                { rid: sent.rid, streamChannel: { id: 9 } },
                context,
            );
        },
    );

    const indices = delivered.map((entry) => (entry.payload as { index: number }).index);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'channel messages must be strictly ordered');
    assert.ok(delivered.every((entry) => entry.callbackId === 9));

    const chunks = delivered
        .map((entry) => entry.payload as { message?: number[]; end?: true })
        .filter((payload): payload is { message: number[] } => Array.isArray(payload.message));
    const lastChunk = chunks.at(-1);
    assert.deepEqual(lastChunk?.message, [1], 'the stream must end with the plugin end-of-stream byte');

    const bodyBytes = chunks.slice(0, -1).flatMap((chunk) => chunk.message.slice(0, -1));
    assert.equal(Buffer.from(bodyBytes).toString('utf8'), '{"ok":true}');
    assert.equal((delivered.at(-1)?.payload as { end?: true }).end, true, 'the callback must be released at the end');
});

test('reading a body twice fails instead of silently returning an empty stream', async () => {
    const registry = new Map<string, CommandHandler>();
    registerHttpPluginCommands(registry, new HttpPluginState());
    const context = createContext([]);

    await withServer(
        () => ({ status: 200, body: 'x' }),
        async (origin) => {
            const rid = await registry.get('plugin:http|fetch')!(
                { clientConfig: { method: 'GET', url: origin, headers: [], data: null } },
                context,
            );
            const sent = (await registry.get('plugin:http|fetch_send')!({ rid }, context)) as { rid: number };
            await registry.get('plugin:http|fetch_read_body')!(
                { rid: sent.rid, streamChannel: '__CHANNEL__:1' },
                context,
            );

            await assert.rejects(
                async () =>
                    registry.get('plugin:http|fetch_read_body')!(
                        { rid: sent.rid, streamChannel: '__CHANNEL__:1' },
                        context,
                    ),
                /unknown response/,
            );
        },
    );
});
