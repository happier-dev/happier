import { describe, expect, it, vi } from 'vitest';
import type { ExecClientHandleV1, JsonStreamClientV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import { query } from './query.js';
import type { SDKMessage } from './types.js';

function createJsonStreamHandle() {
    const listeners = new Set<(record: unknown) => void | Promise<void>>();
    const written: unknown[] = [];
    const client: JsonStreamClientV1 = {
        closed: new Promise(() => undefined),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async writeRecord(record) {
            written.push(record);
        },
    };
    const handle: ExecClientHandleV1<JsonStreamClientV1> = {
        client,
        process: {
            pid: 123,
            exit: new Promise(() => undefined),
            async writeStdin() {},
            kill() {},
            async dispose() {},
        },
        status: 'running',
        onExit() {
            return () => undefined;
        },
        async dispose() {},
    };
    return {
        handle,
        written,
        async emit(record: unknown) {
            await Promise.all([...listeners].map((listener) => listener(record)));
        },
    };
}

function createContextFixture(stream = createJsonStreamHandle()) {
    const spawnClient = vi.fn(async () => stream.handle);
    const ctx = {
        exec: {
            spawnClient,
        },
    } as unknown as PluginContextV1;
    return { ctx, spawnClient, stream };
}

async function* prompt() {
    yield {
        type: 'user',
        message: { role: 'user', content: 'hello' },
    } satisfies SDKMessage;
}

describe('Claude plugin SDK query', () => {
    it('spawns Claude through ctx.exec json-stream instead of opening a process locally', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'sonnet',
                permissionMode: 'acceptEdits',
            },
        });

        expect(spawnClient).toHaveBeenCalledWith(expect.objectContaining({
            launch: expect.objectContaining({
                kind: 'agent-cli',
                agentId: 'claude',
                cwd: '/tmp/project',
            }),
            transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
            protocol: { kind: 'json-stream' },
        }), expect.anything());
        expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
            '--output-format',
            'stream-json',
            '--input-format',
            'stream-json',
            '--model',
            'sonnet',
            '--permission-mode',
            'acceptEdits',
        ]));
    });

    it('emits the --effort flag for the reasoning effort query option', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-opus-4-8',
                effort: 'xhigh',
            },
        });

        expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
            '--effort',
            'xhigh',
        ]));
    });

    it('emits a single inline --settings overlay for the settingsJson query option', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-opus-4-8',
                settingsJson: '{"ultracode":true}',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
        expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    });

    it('lets an explicit settingsPath win over settingsJson (one --settings only)', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                settingsPath: '/tmp/settings.json',
                settingsJson: '{"ultracode":true}',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining(['--settings', '/tmp/settings.json']));
        expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
        expect(args).not.toContain('{"ultracode":true}');
    });

    it('passes a [1m] extended-context model id through --model unmutated', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                model: 'claude-sonnet-4-6[1m]',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4-6[1m]']));
    });

    it('answers Claude can_use_tool control requests through the configured permission callback', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const canCallTool = vi.fn(async () => ({
            behavior: 'allow' as const,
            updatedInput: { path: 'README.md' },
        }));

        query(ctx, {
            prompt: prompt(),
            options: {
                canCallTool,
            },
        });
        await spawnClient.mock.results[0]?.value;

        await stream.emit({
            type: 'control_request',
            request_id: 'req-1',
            request: {
                subtype: 'can_use_tool',
                tool_name: 'Read',
                input: { path: 'README.md' },
            },
        });

        expect(canCallTool).toHaveBeenCalledWith('Read', { path: 'README.md' }, expect.objectContaining({
            requestId: 'req-1',
            signal: expect.any(AbortSignal),
        }));
        expect(stream.written).toContainEqual({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'req-1',
                response: {
                    behavior: 'allow',
                    updatedInput: { path: 'README.md' },
                },
            },
        });
    });

    it('propagates spawn failures to the SDK message iterator', async () => {
        const failure = new Error('spawn failed');
        const ctx = {
            exec: {
                spawnClient: vi.fn(async () => {
                    throw failure;
                }),
            },
        } as unknown as PluginContextV1;

        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
            },
        });

        await expect(sdkQuery.next()).rejects.toThrow('spawn failed');
    });
});
