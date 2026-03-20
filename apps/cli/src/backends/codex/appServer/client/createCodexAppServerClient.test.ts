import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCodexAppServerClient } from './createCodexAppServerClient';

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    bodyLines: string[];
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import { writeFile } from "node:fs/promises";',
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

async function waitForState<T>(readState: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const value = await readState();
        if (predicate(value)) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await readState();
}

describe('createCodexAppServerClient', () => {
    it('initializes once and reuses the same app-server process across multiple requests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-persistent-init-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'let initializeCount = 0;',
                'let initializedCount = 0;',
                'let initializeParams = null;',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    initializeCount += 1;',
                '    initializeParams = msg.params ?? null;',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") {',
                '    initializedCount += 1;',
                '    continue;',
                '  }',
                '  if (msg.method === "state/read") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { pid: process.pid, initializeCount, initializedCount, initializeParams } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const client = await createCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
        });

        try {
            const first = await client.request('state/read');
            const second = await client.request('state/read');

            expect(first).toEqual({
                pid: expect.any(Number),
                initializeCount: 1,
                initializedCount: 1,
                initializeParams: {
                    clientInfo: {
                        name: 'happier_cli',
                        title: 'Happier',
                        version: '0.1.0',
                    },
                    capabilities: {
                        experimentalApi: true,
                    },
                },
            });
            expect(second).toEqual(first);
        } finally {
            await client.dispose();
        }
    });

    it('keeps handlers active until unregistered', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-persistent-handlers-'));
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'const serverRequestReplies = [];',
                'const triggerRequestIds = new Map();',
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "client/trigger") {',
                '    const suffix = String(msg.params?.suffix ?? "one");',
                '    triggerRequestIds.set(suffix, msg.id);',
                '    process.stdout.write(JSON.stringify({ method: "turn/started", params: { suffix } }) + "\\n");',
                '    process.stdout.write(JSON.stringify({ id: `server-${suffix}`, method: "server/compute", params: { suffix } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (typeof msg.id === "string" && msg.id.startsWith("server-")) {',
                '    serverRequestReplies.push(msg.error ? { id: msg.id, error: msg.error } : { id: msg.id, result: msg.result });',
                '    const suffix = msg.id.slice("server-".length);',
                '    const triggerRequestId = triggerRequestIds.get(suffix);',
                '    if (triggerRequestId !== undefined) {',
                '      process.stdout.write(JSON.stringify({ id: triggerRequestId, result: { acknowledged: suffix } }) + "\\n");',
                '      triggerRequestIds.delete(suffix);',
                '    }',
                '    continue;',
                '  }',
                '  if (msg.method === "state/read") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverRequestReplies } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const notifications: string[] = [];
        const client = await createCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
        });

        try {
            const unregisterNotification = client.registerNotificationHandler('turn/started', (params: unknown) => {
                notifications.push((params as { suffix: string }).suffix);
            });
            const unregisterRequest = client.registerRequestHandler('server/compute', (params: unknown) => {
                return { handled: (params as { suffix: string }).suffix };
            });

            await expect(client.request('client/trigger', { suffix: 'one' })).resolves.toEqual({ acknowledged: 'one' });

            unregisterNotification();
            unregisterRequest();

            await expect(client.request('client/trigger', { suffix: 'two' })).resolves.toEqual({ acknowledged: 'two' });

            const state = await waitForState(
                async () => {
                    return await client.request('state/read') as {
                        serverRequestReplies: Array<unknown>;
                    };
                },
                (value) => value.serverRequestReplies.length === 2,
            );

            expect(state).toEqual({
                serverRequestReplies: [
                    { id: 'server-one', result: { handled: 'one' } },
                    { id: 'server-two', error: { code: -32601, message: 'No handler registered for server/compute' } },
                ],
            });
            expect(notifications).toEqual(['one']);
        } finally {
            await client.dispose();
        }
    });

    it('rejects in-flight requests and future calls after dispose', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-persistent-dispose-'));
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
                '  if (msg.method === "slow/request") {',
                '    setTimeout(() => {',
                '      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                '    }, 250);',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const client = await createCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
        });

        const pending = client.request('slow/request');
        const pendingExpectation = expect(pending).rejects.toThrow('disposed');
        await client.dispose();

        await pendingExpectation;
        await expect(client.request('slow/request')).rejects.toThrow('disposed');
        await expect(client.notify('client/trigger')).rejects.toThrow('disposed');
        await expect(client.dispose()).resolves.toBeUndefined();
    });

    it('reads RPC timeout from the passed processEnv instead of global process.env', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-timeout-env-'));
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
                '  if (msg.method === "slow/request") {',
                '    setTimeout(() => {',
                '      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                '    }, 700);',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const originalGlobalTimeout = process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '250';

        const client = await createCodexAppServerClient({
            processEnv: {
                ...makeClientEnv(fakeAppServer),
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
            },
        });

        try {
            await expect(client.request('slow/request')).resolves.toEqual({ ok: true });
        } finally {
            if (originalGlobalTimeout === undefined) {
                delete process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = originalGlobalTimeout;
            }
            await client.dispose();
        }
    });

    it('disposes the child process when initialize times out', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-init-timeout-'));
        const pidFile = join(root, 'pid.txt');
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                `await writeFile(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") { continue; }',
                '}',
            ],
        });

        await expect(createCodexAppServerClient({
            processEnv: {
                ...makeClientEnv(fakeAppServer),
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
            },
        })).rejects.toThrow();

        const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
        expect(Number.isFinite(pid)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        let alive = true;
        try {
            process.kill(pid, 0);
        } catch {
            alive = false;
        }
        expect(alive).toBe(false);
    });

    it('strips inherited Codex thread attach env from the app-server child process', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-sanitize-env-'));
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
                '  if (msg.method === "state/read") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const client = await createCodexAppServerClient({
            processEnv: {
                ...makeClientEnv(fakeAppServer),
                CODEX_THREAD_ID: 'poisoned-parent-thread',
                CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'poisoned-originator',
            },
        });

        try {
            await expect(client.request('state/read')).resolves.toEqual({
                CODEX_THREAD_ID: null,
                CODEX_INTERNAL_ORIGINATOR_OVERRIDE: null,
            });
        } finally {
            await client.dispose();
        }
    });

    it('passes config overrides through as repeated -c flags to codex app-server', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-client-config-overrides-'));
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
                '  if (msg.method === "state/read") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { argv: process.argv.slice(2) } }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const client = await createCodexAppServerClient({
            processEnv: makeClientEnv(fakeAppServer),
            configOverrides: [
                'mcp_servers.happier__happier.command="echo"',
                'mcp_servers.happier__happier.enabled=true',
            ],
        } as any);

        try {
            await expect(client.request('state/read')).resolves.toEqual({
                argv: [
                    'app-server',
                    '--listen',
                    'stdio://',
                    '-c',
                    'mcp_servers.happier__happier.command="echo"',
                    '-c',
                    'mcp_servers.happier__happier.enabled=true',
                ],
            });
        } finally {
            await client.dispose();
        }
    });
});
