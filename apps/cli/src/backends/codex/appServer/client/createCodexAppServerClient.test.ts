import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { waitForCondition } from '@/testkit/async/waitFor';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createCodexAppServerClient } from './createCodexAppServerClient';
import {
    createCodexAppServerProcessEnv,
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

describe('createCodexAppServerClient', () => {
    it('initializes once and reuses the same app-server process across multiple requests', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-init-', async (root) => {
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
                importLines: ['import { writeFile } from "node:fs/promises";'],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
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
    });

    it('always includes a params field in JSON-RPC requests (Codex app-server rejects missing params)', async () => {
        await withTempDir('happier-codex-app-server-client-requires-params-', async (root) => {
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
                    '  if (!("params" in msg)) {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: missing field `params`" } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "state/read") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true, params: msg.params } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true, params: {} });
            } finally {
                await client.dispose();
            }
        });
    });

    it('serializes circular request params without crashing the transport', async () => {
        await withTempDir('happier-codex-app-server-client-circular-params-', async (root) => {
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
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { params: msg.params } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const circularParams: { nested: { ok: boolean }; self?: unknown } = {
                nested: { ok: true },
            };
            circularParams.self = circularParams;

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            try {
                await expect(client.request('state/read', circularParams)).resolves.toEqual({
                    params: {
                        nested: { ok: true },
                        self: '[Circular]',
                    },
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('keeps handlers active until unregistered', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-handlers-', async (root) => {
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
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
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

                let state: {
                    serverRequestReplies: Array<unknown>;
                } = { serverRequestReplies: [] };
                await waitForCondition(
                    async () => {
                        state = await client.request('state/read') as {
                            serverRequestReplies: Array<unknown>;
                        };
                        return state.serverRequestReplies.length === 2;
                    },
                    { label: 'server request replies', timeoutMs: 500, intervalMs: 25 },
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
    });

    it('rejects in-flight requests and future calls after dispose', async () => {
        await withTempDir('happier-codex-app-server-client-persistent-dispose-', async (root) => {
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
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            const pending = client.request('slow/request');
            const pendingExpectation = expect(pending).rejects.toThrow('disposed');
            await client.dispose();

            await pendingExpectation;
            await expect(client.request('slow/request')).rejects.toThrow('disposed');
            await expect(client.notify('client/trigger')).rejects.toThrow('disposed');
            await expect(client.dispose()).resolves.toBeUndefined();
        });
    });

    it('reads RPC timeout from the passed processEnv instead of global process.env', async () => {
        await withTempDir('happier-codex-app-server-client-timeout-env-', async (root) => {
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

            const envScope = createCodexAppServerTestEnvScope();
            envScope.patch({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250' });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
                }),
            });

            try {
                await expect(client.request('slow/request')).resolves.toEqual({ ok: true });
            } finally {
                envScope.restore();
                await client.dispose();
            }
        });
    });

    it('uses the startup RPC timeout for slow thread/start requests', async () => {
        await withTempDir('happier-codex-app-server-client-thread-start-timeout-', async (root) => {
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
                    '  if (msg.method === "thread/start") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-slow-start" } }) + "\\n");',
                    '    }, 700);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                    HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '1200',
                }),
            });

            try {
                await expect(client.request('thread/start')).resolves.toEqual({ threadId: 'thread-slow-start' });
            } finally {
                await client.dispose();
            }
        });
    });

    it('disposes the child process when initialize times out', async () => {
        await withTempDir('happier-codex-app-server-client-init-timeout-', async (root) => {
            const pidFile = join(root, 'pid.txt');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');`,
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") { continue; }',
                    '}',
                ],
                importLines: ['import { writeFileSync } from "node:fs";'],
            });

            await expect(createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                }),
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
    });

    it('strips inherited Codex thread attach env from the app-server child process', async () => {
        await withTempDir('happier-codex-app-server-client-sanitize-env-', async (root) => {
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
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    CODEX_THREAD_ID: 'poisoned-parent-thread',
                    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'poisoned-originator',
                }),
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
    });

    it('passes config overrides through as repeated -c flags to codex app-server', async () => {
        await withTempDir('happier-codex-app-server-client-config-overrides-', async (root) => {
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
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                configOverrides: [
                    'mcp_servers.happier.command="echo"',
                    'mcp_servers.happier.enabled=true',
                ],
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({
                    argv: [
                        'app-server',
                        '--listen',
                        'stdio://',
                        '-c',
                        'mcp_servers.happier.command="echo"',
                        '-c',
                        'mcp_servers.happier.enabled=true',
                    ],
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('can disable user MCP servers from CODEX_HOME/config.toml so app-server startup stays lightweight', async () => {
        await withTempDir('happier-codex-app-server-client-disable-user-mcp-', async (root) => {
            const codexHome = join(root, 'codex-home');
            await mkdir(codexHome, { recursive: true });
            await writeFile(
                join(codexHome, 'config.toml'),
                [
                    '[mcp_servers.context7]',
                    'url = "https://mcp.context7.com/mcp"',
                    '',
                    '[mcp_servers.context7.env_http_headers]',
                    'CONTEXT7_API_KEY = "CONTEXT7_API_KEY"',
                    '',
                    '[mcp_servers.playwright]',
                    'command = "npx"',
                    'args = ["-y", "@playwright/mcp@latest", "--isolated"]',
                    '',
                    '[mcp_servers.sequential-thinking]',
                    'command = "npx"',
                    'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
                    '',
                ].join('\n'),
                'utf8',
            );

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
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome }),
                disableUserMcpServers: true,
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({
                    argv: [
                        'app-server',
                        '--listen',
                        'stdio://',
                        '-c',
                        'mcp_servers.context7.enabled=false',
                        '-c',
                        'mcp_servers.playwright.enabled=false',
                        '-c',
                        'mcp_servers.sequential-thinking.enabled=false',
                    ],
                });
            } finally {
                await client.dispose();
            }
        });
    });

    it('logs JSON-RPC traffic when HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH is set', async () => {
        await withTempDir('happier-codex-app-server-client-rpc-log-', async (root) => {
            const requestLogPath = join(root, 'rpc.jsonl');
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
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });

            const client = await createCodexAppServerClient({
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: requestLogPath,
                }),
            });

            try {
                await expect(client.request('state/read')).resolves.toEqual({ ok: true });
            } finally {
                await client.dispose();
            }

            const lines = (await readFile(requestLogPath, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { direction: string; method?: string; result?: unknown });

            const directions = new Set(lines.map((entry) => entry.direction));
            expect(directions).toEqual(new Set(['outgoing', 'incoming']));
            expect(lines).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ direction: 'outgoing', method: 'initialize' }),
                    expect.objectContaining({ direction: 'outgoing', method: 'initialized' }),
                    expect.objectContaining({ direction: 'outgoing', method: 'state/read' }),
                ]),
            );
        });
    });
});
