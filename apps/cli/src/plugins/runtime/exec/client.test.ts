import { access, chmod, constants, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { ExecClientSpecV1, ExecJsonRpcClientSpecV1, ExecProcessHandleV1 } from '@happier-dev/plugin-sdk';

import { createPluginExecService } from '../context/exec';
import { PluginExecClientError } from './errors';
import { createJsonRpcProcessClient } from './jsonRpc';

async function firstExecutablePath(candidates: readonly string[]): Promise<string> {
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Try the next platform-specific candidate.
        }
    }
    throw new Error(`No executable candidate found: ${candidates.join(', ')}`);
}

type JsonRpcMessageHookFixture = Readonly<{
    onMessage?: (
        message: unknown,
        context: Readonly<{ phase: 'incoming' | 'outgoing' }>,
    ) => 'pass' | 'suppress' | Readonly<{ kind: 'replace'; message: unknown }>;
}>;

function createInMemoryJsonRpcProcess(params?: Readonly<{
    hooks?: JsonRpcMessageHookFixture;
    maxFrameBytes?: number;
}>) {
    const stdout = new PassThrough();
    const writes: string[] = [];
    const process: ExecProcessHandleV1 = {
        pid: 1,
        exit: new Promise(() => undefined),
        async writeStdin(input) {
            writes.push(typeof input === 'string' ? input : Buffer.from(input).toString('utf8'));
        },
        kill: () => undefined,
        dispose: async () => undefined,
    };
    const protocol = createJsonRpcProcessClient({
        process,
        stdout,
        write: process.writeStdin,
        requestTimeoutMs: 25,
        maxFrameBytes: params?.maxFrameBytes,
        ...(params?.hooks ? { hooks: params.hooks } : {}),
    } as Parameters<typeof createJsonRpcProcessClient>[0] & {
        hooks?: JsonRpcMessageHookFixture;
    });
    return { stdout, writes, protocol };
}

describe('A.13p spawned protocol client runtime', () => {
    it('sends JSON-RPC requests through the object-shaped spawnClient spec', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const spec = {
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while IFS= read -r line; do printf "%s\\n" \'{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"pong\":true}}\'; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        } satisfies ExecJsonRpcClientSpecV1;
        const handle = await exec.spawnClient(spec);
        try {
            await expect(handle.client.request('ping', { value: 1 })).resolves.toEqual({ pong: true });
        } finally {
            await handle.dispose();
        }
    });

    it('accepts spawnClient launches returned by systemTools.resolve', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.rpc',
                    displayName: 'Acme RPC',
                    executablePath: shellPath,
                    source: 'system',
                },
            ],
        });
        const grant = await exec.systemTools.resolve({
            toolId: 'acme.rpc',
            purpose: 'spawn JSON-RPC fixture',
        });

        const handle = await exec.spawnClient({
            launch: {
                ...grant.launch,
                args: ['-c', 'while IFS= read -r line; do printf "%s\\n" \'{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"granted\":true}}\'; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        });
        try {
            await expect(handle.client.request('ping', {})).resolves.toEqual({ granted: true });
        } finally {
            await handle.dispose();
        }
    });

    it('writes sanitized JSON-RPC diagnostics when lifecycle rpcLog is configured', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-spawn-client-rpc-log-'));
        const logPath = join(root, 'rpc.log');
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
            rpcLogAllowedDirectories: [root],
        });
        const spec = {
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while IFS= read -r line; do printf "%s\\n" \'{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"accessToken\":\"response-token\",\"path\":\"/Users/leeroy/private\",\"providerSessionId\":\"provider-thread-secret\",\"safe\":true}}\'; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
            lifecycle: {
                diagnostics: {
                    rpcLog: {
                        kind: 'file',
                        path: logPath,
                    },
                    sanitizer: {
                        redactedValues: ['known-secret-value'],
                    },
                },
            },
        } satisfies ExecJsonRpcClientSpecV1;
        const handle = await exec.spawnClient(spec);
        try {
            await expect(handle.client.request('child/secret', {
                accessToken: 'request-token',
                cwd: '/Users/leeroy/project',
                note: 'known-secret-value',
            })).resolves.toEqual({
                accessToken: 'response-token',
                path: '/Users/leeroy/private',
                providerSessionId: 'provider-thread-secret',
                safe: true,
            });
        } finally {
            await handle.dispose();
        }

        const logText = await readFile(logPath, 'utf8');
        expect(logText).toContain('"method":"child/secret"');
        expect(logText).not.toContain('request-token');
        expect(logText).not.toContain('response-token');
        expect(logText).not.toContain('known-secret-value');
        expect(logText).not.toContain('/Users/leeroy');
        expect(logText).not.toContain('provider-thread-secret');
        expect(logText).toContain('[REDACTED]');
        expect(logText).toContain('[REDACTED_LOCAL_PATH]');
        expect(logText).toContain('[REDACTED_PROVIDER_RESUME_ID]');
    });

    it('rejects JSON-RPC diagnostics file paths outside host-approved directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-spawn-client-rpc-log-reject-'));
        const logPath = join(root, 'plugin-controlled.log');
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });

        await expect(exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while IFS= read -r line; do printf "%s\\n" \'{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\'; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
            lifecycle: {
                diagnostics: {
                    rpcLog: {
                        kind: 'file',
                        path: logPath,
                    },
                },
            },
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('redacts diagnostic sanitizer values from fatal stderr previews', async () => {
        const secret = 'known-stderr-secret-value';
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', `printf "%s\\n" "${secret}" >&2; printf "not-json\\n"; sleep 1`],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
            lifecycle: {
                diagnostics: {
                    sanitizer: {
                        redactedValues: [secret],
                    },
                },
            },
        });
        try {
            await expect(handle.client.request('child/fail', {})).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                stderrPreview: expect.not.stringContaining(secret),
            });
        } finally {
            await handle.dispose();
        }
    });

    it('rotates JSON-RPC diagnostics before appending beyond the configured cap', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-spawn-client-rpc-log-rotation-'));
        const logPath = join(root, 'rpc.log');
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
            rpcLogAllowedDirectories: [root],
        });
        const spec = {
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while IFS= read -r line; do :; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
            lifecycle: {
                diagnostics: {
                    rpcLog: {
                        kind: 'file',
                        path: logPath,
                        maxBytes: 420,
                        rotateCount: 1,
                    },
                },
            },
        } satisfies ExecJsonRpcClientSpecV1;
        const handle = await exec.spawnClient(spec);
        try {
            for (let index = 0; index < 5; index += 1) {
                await handle.client.notify('child/rotate', { index, payload: 'payload'.repeat(6) });
            }
        } finally {
            await handle.dispose();
        }

        await expect(stat(logPath)).resolves.toMatchObject({ size: expect.any(Number) });
        await expect(stat(`${logPath}.1`)).resolves.toMatchObject({ size: expect.any(Number) });
    });

    it('resolves agent-cli launches through the host provider CLI grant without manifest process scopes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-agent-cli-spawn-'));
        const cursorPath = join(root, 'cursor-agent');
        await writeFile(
            cursorPath,
            [
                '#!/bin/sh',
                'while IFS= read -r line; do',
                '  printf "%s\\n" \'{"jsonrpc":"2.0","id":1,"result":{"source":"agent-cli"}}\'',
                'done',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(cursorPath, 0o755);
        const previousCursorPath = process.env.HAPPIER_CURSOR_PATH;
        process.env.HAPPIER_CURSOR_PATH = cursorPath;
        const exec = createPluginExecService();
        try {
            const handle = await exec.spawnClient({
                launch: {
                    kind: 'agent-cli',
                    agentId: 'cursor',
                    args: ['acp'],
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                    encoding: 'utf8',
                },
                protocol: { kind: 'json-rpc-2.0' },
            });
            try {
                await expect(handle.client.request('ping', {})).resolves.toEqual({ source: 'agent-cli' });
            } finally {
                await handle.dispose();
            }
        } finally {
            if (previousCursorPath === undefined) {
                delete process.env.HAPPIER_CURSOR_PATH;
            } else {
                process.env.HAPPIER_CURSOR_PATH = previousCursorPath;
            }
        }
    });

    it('rejects legacy launch-only spawnClient inputs before spawning an inert protocol client', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });

        const legacyLaunch = {
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'exit 0'],
        } as const;

        await expect(exec.spawnClient(
            legacyLaunch as unknown as Parameters<typeof exec.spawnClient>[0],
        )).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('writes JSON-RPC notifications without allocating request ids', async () => {
        const { writes, protocol } = createInMemoryJsonRpcProcess();

        await protocol.client.notify('host/ready', { ok: true });

        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0] ?? '')).toEqual({
            jsonrpc: '2.0',
            method: 'host/ready',
            params: { ok: true },
        });
        protocol.dispose();
    });

    it('dispatches child-to-host JSON-RPC notifications without writing responses', async () => {
        const { stdout, writes, protocol } = createInMemoryJsonRpcProcess();
        const received: unknown[] = [];
        protocol.client.registerNotificationHandler('host/status', (params) => {
            received.push(params);
        });

        stdout.write('{"jsonrpc":"2.0","method":"host/status","params":{"ready":true}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(received).toEqual([{ ready: true }]);
        expect(writes).toEqual([]);
        protocol.dispose();
    });

    it('dispatches child-to-host JSON-RPC requests and writes responses', async () => {
        const { stdout, writes, protocol } = createInMemoryJsonRpcProcess();
        protocol.client.registerRequestHandler('host/question', (params, context) => ({
            accepted: params,
            requestId: context.requestId,
        }));

        stdout.write('{"jsonrpc":"2.0","id":"child-1","method":"host/question","params":{"value":7}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0] ?? '')).toEqual({
            jsonrpc: '2.0',
            id: 'child-1',
            result: { accepted: { value: 7 }, requestId: 'child-1' },
        });
        protocol.dispose();
    });

    it('rejects child-to-host JSON-RPC request handlers that return undefined results', async () => {
        const { stdout, writes, protocol } = createInMemoryJsonRpcProcess();
        protocol.client.registerRequestHandler('host/undefined', () => undefined as never);

        stdout.write('{"jsonrpc":"2.0","id":"child-1","method":"host/undefined","params":{}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0] ?? '')).toEqual({
            jsonrpc: '2.0',
            id: 'child-1',
            error: {
                code: -32000,
                message: 'JSON-RPC request handler for host/undefined returned undefined',
            },
        });
        protocol.dispose();
    });

    it('handles split and batched JSON-RPC response frames at the exec-client composition layer', async () => {
        const { stdout, protocol } = createInMemoryJsonRpcProcess();

        const first = protocol.client.request('child/one', {});
        const second = protocol.client.request('child/two', {});

        stdout.write('{"jsonrpc":"2.0","id":1,"res');
        stdout.write('ult":{"one":true}}\n{"jsonrpc":"2.0","id":2,"result":{"two":true}}\n');

        await expect(first).resolves.toEqual({ one: true });
        await expect(second).resolves.toEqual({ two: true });
        protocol.dispose();
    });

    it('preserves child JSON-RPC response error code, message, data, and request method', async () => {
        const { stdout, protocol } = createInMemoryJsonRpcProcess();

        const pending = protocol.client.request('child/fail', { input: 'bad' });
        stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
                code: -32602,
                message: 'invalid params: unsupported structured input',
                data: { field: 'input' },
            },
        }) + '\n');

        await expect(pending).rejects.toMatchObject({
            code: -32602,
            message: 'invalid params: unsupported structured input',
            data: { field: 'input' },
            method: 'child/fail',
        });
        protocol.dispose();
    });

    it('rejects pending requests when the JSON-RPC stream ends with a trailing partial frame', async () => {
        const { stdout, protocol } = createInMemoryJsonRpcProcess();

        const pending = protocol.client.request('child/wait', {});
        stdout.end('{"jsonrpc":"2.0","id":1,"result":');

        await expect(pending).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('redacts handler failure messages before writing JSON-RPC errors to the child', async () => {
        const { stdout, writes, protocol } = createInMemoryJsonRpcProcess();
        protocol.client.registerRequestHandler('host/secret', () => {
            throw new Error('failed with API_KEY=super-secret-token');
        });

        stdout.write('{"jsonrpc":"2.0","id":"child-1","method":"host/secret","params":{}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writes).toHaveLength(1);
        const response = JSON.parse(writes[0] ?? '') as {
            error?: { message?: string };
        };
        expect(response).toMatchObject({
            jsonrpc: '2.0',
            id: 'child-1',
            error: {
                code: -32000,
            },
        });
        expect(response.error?.message).toContain('API_KEY=');
        expect(response.error?.message).not.toContain('super-secret-token');
        protocol.dispose();
    });

    it('applies provider-neutral JSON-RPC message hooks before dispatching incoming frames', async () => {
        const decisions: unknown[] = [];
        const { stdout, writes, protocol } = createInMemoryJsonRpcProcess({
            hooks: {
                onMessage: (message, context) => {
                    decisions.push({ message, context });
                    if ((message as { method?: unknown }).method === 'host/suppressed') {
                        return 'suppress';
                    }
                    if ((message as { method?: unknown }).method === 'host/replace') {
                        return {
                            kind: 'replace',
                            message: {
                                ...(message as Record<string, unknown>),
                                method: 'host/question',
                            },
                        };
                    }
                    return 'pass';
                },
            },
        });
        protocol.client.registerRequestHandler('host/suppressed', () => ({ shouldNotWrite: true }));
        protocol.client.registerRequestHandler('host/question', (params) => ({ accepted: params }));

        stdout.write('{"jsonrpc":"2.0","id":"child-1","method":"host/suppressed","params":{"value":1}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(writes).toEqual([]);

        stdout.write('{"jsonrpc":"2.0","id":"child-2","method":"host/replace","params":{"value":2}}\n');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0] ?? '')).toEqual({
            jsonrpc: '2.0',
            id: 'child-2',
            result: { accepted: { value: 2 } },
        });
        expect(decisions).toEqual([
            {
                message: {
                    jsonrpc: '2.0',
                    id: 'child-1',
                    method: 'host/suppressed',
                    params: { value: 1 },
                },
                context: { phase: 'incoming' },
            },
            {
                message: {
                    jsonrpc: '2.0',
                    id: 'child-2',
                    method: 'host/replace',
                    params: { value: 2 },
                },
                context: { phase: 'incoming' },
            },
            {
                message: {
                    jsonrpc: '2.0',
                    id: 'child-2',
                    result: { accepted: { value: 2 } },
                },
                context: { phase: 'outgoing' },
            },
        ]);
        protocol.dispose();
    });

    it('rejects pending requests when a malformed frame arrives', async () => {
        const { stdout, protocol } = createInMemoryJsonRpcProcess();

        const pending = protocol.client.request('child/work', {});
        stdout.write('not-json\n');

        await expect(pending).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('rejects only the matching JSON-RPC request when a response frame exceeds maxFrameBytes before newline', async () => {
        const { stdout, protocol } = createInMemoryJsonRpcProcess({ maxFrameBytes: 64 });

        const oversized = protocol.client.request('child/huge', {}, { timeoutMs: 1000 });
        stdout.write('{"jsonrpc":"2.0","id":1,"result":{"payload":"');
        stdout.write('x'.repeat(128));

        await expect(oversized).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            message: expect.stringContaining('exceeded the configured size limit'),
        });

        const next = protocol.client.request('child/ok', {});
        stdout.write('discarded-rest"} }\n');
        stdout.write('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n');

        await expect(next).resolves.toEqual({ ok: true });
        protocol.dispose();
    });

    it('rejects pending requests on request timeout', async () => {
        const { protocol } = createInMemoryJsonRpcProcess();

        await expect(protocol.client.request('child/slow', {}, { timeoutMs: 1 })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
        });
        protocol.dispose();
    });

    it('does not write JSON-RPC requests when the request signal is already aborted', async () => {
        const { writes, protocol } = createInMemoryJsonRpcProcess();
        const abortController = new AbortController();
        abortController.abort();

        await expect(protocol.client.request('child/aborted', {}, { signal: abortController.signal })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_ABORTED',
        });

        expect(writes).toEqual([]);
        protocol.dispose();
    });

    it('rejects pending requests when the process exits', async () => {
        const { protocol } = createInMemoryJsonRpcProcess();

        const pending = protocol.client.request('child/wait', {});
        protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'process exited'));

        await expect(pending).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_EXITED',
        });
    });

    it('streams JSON records through the provider-neutral json-stream protocol', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'printf \'{"ready":\'; printf \'true}\\n{"second":2}\\n\'; while IFS= read -r line; do printf "%s\\n" "$line"; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: {
                kind: 'json-stream',
            },
        });
        const streamClient = handle.client;
        const records: unknown[] = [];
        const unsubscribe = streamClient.subscribe((record) => {
            records.push(record);
        });
        try {
            await expect.poll(() => records).toEqual([{ ready: true }, { second: 2 }]);

            unsubscribe();
            await streamClient.writeRecord({ echoed: true });
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(records).toEqual([{ ready: true }, { second: 2 }]);
        } finally {
            await handle.dispose();
        }
    });

    it('rejects json-stream clients when stdout ends with a trailing partial record', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'printf \'{"partial":\''],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: {
                kind: 'json-stream',
            },
        });
        const streamClient = handle.client;

        await expect(streamClient.closed).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('rejects json-stream writes that exceed maxFrameBytes before writing stdin', async () => {
        const catPath = await firstExecutablePath(['/bin/cat', '/usr/bin/cat']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [catPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: catPath,
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
                maxFrameBytes: 8,
            },
            protocol: {
                kind: 'json-stream',
            },
        });
        try {
            await expect(handle.client.writeRecord({ tooLarge: true })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            });
        } finally {
            await handle.dispose();
        }
    });

    it('preserves binary frames through the framed-bytes protocol', async () => {
        const catPath = await firstExecutablePath(['/bin/cat', '/usr/bin/cat']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [catPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: catPath,
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'framed-bytes' },
                maxFrameBytes: 16,
            },
            protocol: {
                kind: 'framed-bytes',
            },
        });
        const bytesClient = handle.client;
        const frames: Uint8Array[] = [];
        bytesClient.subscribe((frame) => {
            frames.push(frame);
        });
        try {
            await bytesClient.writeFrame(Uint8Array.from([0, 255, 13]));
            await bytesClient.writeFrame(Uint8Array.from([]));

            await expect.poll(() => frames.map((frame) => [...frame])).toEqual([
                [0, 255, 13],
                [],
            ]);
        } finally {
            await handle.dispose();
        }
    });

    it('rejects framed-bytes clients when a frame exceeds maxFrameBytes', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'printf "\\000\\000\\000\\005abcde"'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'framed-bytes' },
                maxFrameBytes: 4,
            },
            protocol: {
                kind: 'framed-bytes',
            },
        });
        const bytesClient = handle.client;

        await expect(bytesClient.closed).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('makes object-shaped exec client dispose idempotent', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while true; do sleep 1; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        });

        await handle.dispose();
        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(handle.status).toBe('disposed');
    });

    it('uses the supplied exec-client dispose reason for pending JSON-RPC requests', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'while IFS= read -r line; do sleep 10; done'],
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        });

        const pendingOutcome = handle.client.request('child/wait', {}).then(
            (value) => value,
            (error) => error,
        );
        await handle.dispose({
            code: 'PLUGIN_ACP_RUNTIME_DISPOSED',
            message: 'ACP runtime disposed',
        });

        await expect(pendingOutcome).resolves.toMatchObject({
            code: 'PLUGIN_ACP_RUNTIME_DISPOSED',
            message: 'ACP runtime disposed',
        });
    });

    it('reports spawn errors through a terminal exec-client lifecycle result', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-missing-exec-'));
        const missingExecutable = join(root, 'missing-agent');
        const exec = createPluginExecService({
            allowedExecutablePaths: [missingExecutable],
        });
        const handle = await exec.spawnClient({
            launch: {
                kind: 'binary',
                executablePath: missingExecutable,
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        });
        const exitResults: unknown[] = [];
        handle.onExit((result) => {
            exitResults.push(result);
        });

        await expect(handle.process.exit).rejects.toBeTruthy();

        await expect.poll(() => handle.status).toBe('exited');
        await expect.poll(() => exitResults.length).toBe(1);
        expect(exitResults[0]).toMatchObject({
            exitCode: null,
            signal: null,
            stdout: '',
        });
    });

    it('rejects ipc launch specs as explicitly unsupported by the process-backed exec host', async () => {
        const exec = createPluginExecService();

        await expect(exec.spawnClient({
            launch: {
                kind: 'ipc',
                endpoint: 'happier://exec/fixture',
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNSUPPORTED_LAUNCH',
        });
    });

    it.each([
        ['content-length'],
        ['length-prefix'],
        ['null-delimited'],
        ['framed-bytes'],
    ] as const)('rejects unsupported exec client framing %s before launching', async (framingKind) => {
        const exec = createPluginExecService();
        const spec = {
            launch: {
                kind: 'binary',
                executablePath: '/not-spawned',
            },
            transport: {
                kind: 'stdio',
                framing: { kind: framingKind },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
        } as unknown as ExecClientSpecV1;

        await expect(exec.spawnClient(spec)).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it.each([
        ['acme-provider-protocol'],
    ] as const)('rejects unsupported exec client protocol %s before launching', async (protocolKind) => {
        const exec = createPluginExecService();
        const spec = {
            launch: {
                kind: 'binary',
                executablePath: '/not-spawned',
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: protocolKind },
        } as unknown as ExecClientSpecV1;

        await expect(exec.spawnClient(spec)).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });
});
