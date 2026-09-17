import { execFile, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws-node';

import { withTempDir } from '@/testkit/fs/tempDir';

const bunExecutable = process.env.HAPPIER_TEST_BUN_EXECUTABLE?.trim() || 'bun';
const bunAvailable = spawnSync(bunExecutable, ['--version'], { encoding: 'utf8' }).status === 0;
const execFileAsync = promisify(execFile);

describe('Codex Unix WebSocket under Bun', (): void => {
    it.skipIf(!bunAvailable && !process.env.CI).each(['source', 'bundle', 'compiled'] as const)('%s exchanges frames over IPC without negotiating compression', async (mode: 'source' | 'bundle' | 'compiled'): Promise<void> => {
        await withTempDir('codex-ws-', async (root: string): Promise<void> => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\codex-ws-${process.pid}-${Date.now()}`
                : join(root, 'with space.sock');
            const server = createServer();
            const webSocketServer = new WebSocketServer({ server });
            const extensions: Array<string | string[] | undefined> = [];
            server.on('upgrade', (request: IncomingMessage): void => {
                extensions.push(request.headers['sec-websocket-extensions']);
            });
            webSocketServer.on('connection', (socket: WebSocket): void => {
                socket.on('message', (payload: RawData): void => {
                    if (String(payload) === 'ping') socket.send('pong');
                });
            });

            try {
                await new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
                    server.once('error', reject);
                    server.listen(socketPath, resolve);
                });
                const ownerPath = fileURLToPath(new URL('./createCodexUnixWebSocket.ts', import.meta.url));
                const loadOwner = mode !== 'bundle'
                    ? `const { createCodexUnixWebSocket } = await import(${JSON.stringify(ownerPath)});`
                    : [
                        // Loading from a data URL prevents accidental resolution from the source node_modules.
                        `const build = await Bun.build({ entrypoints: [${JSON.stringify(ownerPath)}], target: 'bun', write: false });`,
                        'if (!build.success) throw new AggregateError(build.logs, "Transport bundle failed");',
                        'const code = Buffer.from(await build.outputs[0].text()).toString("base64");',
                        'const { createCodexUnixWebSocket } = await import("data:text/javascript;base64," + code);',
                    ].join('\n');
                const source = [
                    loadOwner,
                    `const socket = createCodexUnixWebSocket(${JSON.stringify(socketPath)});`,
                    'try {',
                    '  const [, reply] = await Promise.all([',
                    '    new Promise((resolve, reject) => {',
                    '      socket.once("error", reject);',
                    '      socket.once("open", () => socket.send("ping", (error) => error ? reject(error) : resolve()));',
                    '    }),',
                    '    new Promise((resolve, reject) => {',
                    '      socket.once("error", reject);',
                    '      socket.once("message", (payload) => resolve(String(payload)));',
                    '    }),',
                    '  ]);',
                    '  console.log(reply);',
                    '} finally { socket.terminate(); }',
                ].join('\n');
                let executable = bunExecutable;
                let args = ['--eval', source];
                if (mode === 'compiled') {
                    const entrypoint = join(root, 'client.ts');
                    const binary = join(root, process.platform === 'win32' ? 'client.exe' : 'client');
                    await writeFile(entrypoint, source);
                    await execFileAsync(bunExecutable, ['build', '--compile', '--no-cache', entrypoint, '--outfile', binary], { timeout: 15_000 });
                    executable = binary;
                    args = [];
                }
                // The standalone executable runs directly, outside the repository and its node_modules.
                const result = await execFileAsync(executable, args, { cwd: root, timeout: 5_000 });

                expect(result.stdout.trim()).toBe('pong');
                expect(extensions).toEqual([undefined]);
            } finally {
                for (const socket of webSocketServer.clients) socket.terminate();
                await new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
                    webSocketServer.close((error?: Error): void => {
                        if (error) reject(error);
                        else resolve();
                    });
                });
                await new Promise<void>((resolve: () => void): void => {
                    server.close((): void => resolve());
                });
            }
        });
    });
});
