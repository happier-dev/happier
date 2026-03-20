import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withCodexAppServerClient } from './withCodexAppServerClient';

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    bodyLines: string[];
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        ...params.bodyLines,
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

function makeClientEnv(fakeAppServer: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
    };
}

describe('withCodexAppServerClient', () => {
    it('initializes the app-server before running thread/list requests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-init-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'let initialized = false;',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") {',
                '    initialized = true;',
                '    continue;',
                '  }',
                '  if (msg.method === "thread/list") {',
                '    if (!initialized) {',
                '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "thread/list called before initialized" } }) + "\\n");',
                '      continue;',
                '    }',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ id: "thread-1" }], nextCursor: null } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const result = await withCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
            run: async (client) => {
                return await client.request('thread/list', { archived: false });
            },
        });

        expect(result).toEqual({ data: [{ id: 'thread-1' }], nextCursor: null });
    });

    it('correlates concurrent responses even when the server interleaves notifications', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-correlation-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "delayed/one") {',
                '    setTimeout(() => {',
                '      process.stdout.write(JSON.stringify({ method: "server/progress", params: { step: 1 } }) + "\\n");',
                '      process.stdout.write(JSON.stringify({ id: msg.id, result: "first" }) + "\\n");',
                '    }, 25);',
                '    continue;',
                '  }',
                '  if (msg.method === "delayed/two") {',
                '    setTimeout(() => {',
                '      process.stdout.write(JSON.stringify({ id: msg.id, result: "second" }) + "\\n");',
                '    }, 5);',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const result = await withCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
            run: async (client) => {
                return await Promise.all([
                    client.request('delayed/one'),
                    client.request('delayed/two'),
                ]);
            },
        });

        expect(result).toEqual(['first', 'second']);
    });

    it('sends notifications and answers server-initiated requests with registered handlers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-server-request-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'let sawHandlerResult = null;',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "client/ready") {',
                '    process.stdout.write(JSON.stringify({ id: "server-1", method: "server/compute", params: { value: 7 } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.id === "server-1") {',
                '    sawHandlerResult = msg.result;',
                '    continue;',
                '  }',
                '  if (msg.method === "thread/list") {',
                '    const reply = () => {',
                '      process.stdout.write(JSON.stringify({ id: msg.id, result: { handlerResult: sawHandlerResult } }) + "\\n");',
                '    };',
                '    if (sawHandlerResult !== null) {',
                '      reply();',
                '      continue;',
                '    }',
                '    setTimeout(reply, 25);',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const result = await withCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
            run: async (client) => {
                client.registerRequestHandler('server/compute', async (params) => {
                    const value = (params as { value: number }).value;
                    return { doubled: value * 2 };
                });
                await client.notify('client/ready', { ok: true });
                return await client.request('thread/list');
            },
        });

        expect(result).toEqual({ handlerResult: { doubled: 14 } });
    });

    it('delivers server notifications to registered handlers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-notifications-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "client/ready") {',
                '    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } }) + "\\n");',
                '    process.stdout.write(JSON.stringify({ id: msg.id ?? 99, result: { ok: true } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "thread/list") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [] } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const notifications: unknown[] = [];
        await withCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
            run: async (client) => {
                client.registerNotificationHandler('turn/started', (params) => {
                    notifications.push(params);
                });
                await client.notify('client/ready', { ok: true });
                await new Promise((resolve) => setTimeout(resolve, 25));
                await client.request('thread/list');
            },
        });

        expect(notifications).toEqual([{ threadId: 'thr_1', turn: { id: 'turn_1' } }]);
    });
});
