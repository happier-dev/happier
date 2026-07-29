import { describe, expect, it, vi } from 'vitest';

import {
    query,
    type ClaudeSdkExecClientHandle,
    type ClaudeSdkJsonStreamClient,
} from './query.js';
import type { SDKMessage } from './types.js';

function createJsonStreamHandle() {
    const listeners = new Set<(record: unknown) => void | Promise<void>>();
    const written: unknown[] = [];
    let resolveExit: ((result: Readonly<{
        exitCode: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
    }>) => void) | null = null;
    const exit = new Promise<Readonly<{
        exitCode: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
    }>>((resolve) => {
        resolveExit = resolve;
    });
    const client: ClaudeSdkJsonStreamClient = {
        closed: new Promise(() => undefined),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async writeRecord(record) {
            written.push(record);
            return { kind: 'written' };
        },
    };
    const handle: ClaudeSdkExecClientHandle = {
        client,
        process: {
            pid: 123,
            exit,
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
        async exitWith(result: Readonly<{
            exitCode: number | null;
            signal: string | null;
            stdout?: string;
            stderr?: string;
        }>) {
            resolveExit?.({
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
            });
            await exit;
        },
    };
}

function createContextFixture(stream = createJsonStreamHandle()) {
    const spawnClient = vi.fn(async () => stream.handle);
    const ctx = {
        agentRuntime: {
            exec: {
                spawnClient,
            },
        },
    } satisfies Parameters<typeof query>[0];
    return { ctx, spawnClient, stream };
}

async function* prompt() {
    yield {
        type: 'user',
        message: { role: 'user', content: 'hello' },
    } satisfies SDKMessage;
}

describe('Claude plugin SDK query', () => {
    it('spawns Claude through ctx.agentRuntime.exec json-stream instead of opening a process locally', async () => {
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

    it('maps the released advanced Agent SDK options to the native Claude launch without control-plane overrides', async () => {
        const { ctx, spawnClient } = createContextFixture();

        query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
                customSystemPrompt: 'canonical prompt replaced by the released advanced override',
                settingsJson: '{"ultracode":true}',
                plugins: [{ type: 'local', path: '/tmp/plugin' }],
                betas: ['beta-a'],
                maxBudgetUsd: 3.5,
                sandbox: { enabled: true },
                additionalDirectories: ['/tmp/extra'],
                permissionPromptToolName: 'stdio',
                tools: ['Read', 'Edit'],
                systemPrompt: 'Be concise',
                debug: true,
                debugFile: '/tmp/claude-debug.log',
            },
        });

        const args = spawnClient.mock.calls[0]?.[0].launch.args as string[];
        expect(args).toEqual(expect.arrayContaining([
            '--plugin-dir', '/tmp/plugin',
            '--betas', 'beta-a',
            '--max-budget-usd', '3.5',
            '--add-dir', '/tmp/extra',
            '--permission-prompt-tool', 'stdio',
            '--tools', 'Read,Edit',
            '--system-prompt', 'Be concise',
            '--debug',
            '--debug-file', '/tmp/claude-debug.log',
        ]));
        const settingsIndex = args.indexOf('--settings');
        expect(settingsIndex).toBeGreaterThanOrEqual(0);
        expect(JSON.parse(args[settingsIndex + 1] ?? '')).toEqual({
            ultracode: true,
            sandbox: { enabled: true },
        });
        expect(args).not.toContain('canonical prompt replaced by the released advanced override');
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

    it('answers Claude oauth_token_refresh control requests through the configured OAuth callback', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const getOAuthToken = vi.fn(async () => 'fresh-access-token');

        query(ctx, {
            prompt: prompt(),
            options: {
                env: { EXISTING_ENV: 'kept' },
                getOAuthToken,
            },
        });
        await spawnClient.mock.results[0]?.value;

        expect(spawnClient.mock.calls[0]?.[0].launch.env).toEqual({
            EXISTING_ENV: 'kept',
            CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        });

        await stream.emit({
            type: 'control_request',
            request_id: 'oauth-1',
            request: {
                subtype: 'oauth_token_refresh',
            },
        });

        expect(getOAuthToken).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
        expect(stream.written).toContainEqual({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'oauth-1',
                response: {
                    accessToken: 'fresh-access-token',
                },
            },
        });
    });

    it('requests and resolves Claude live context usage through the SDK control channel', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const sdkQuery = query(ctx, { prompt: prompt() });
        await spawnClient.mock.results[0]?.value;

        const responsePromise = sdkQuery.getContextUsage();
        await vi.waitFor(() => {
            expect(stream.written).toContainEqual(expect.objectContaining({
                type: 'control_request',
                request_id: expect.any(String),
                request: { subtype: 'get_context_usage' },
            }));
        });
        const request = stream.written.find((record) =>
            (record as { request?: { subtype?: string } }).request?.subtype === 'get_context_usage') as {
                request_id: string;
            };
        const response = {
            totalTokens: 48_000,
            maxTokens: 200_000,
            model: 'claude-sonnet-4-6',
            isAutoCompactEnabled: true,
            categories: [{ name: 'Messages', tokens: 30_000, color: 'blue' }],
        };

        await stream.emit({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request.request_id,
                response,
            },
        });

        await expect(responsePromise).resolves.toEqual(response);
    });

    it('propagates spawn failures to the SDK message iterator', async () => {
        const failure = new Error('spawn failed');
        const ctx = {
            agentRuntime: {
                exec: {
                    spawnClient: vi.fn(async () => {
                        throw failure;
                    }),
                },
            },
        } satisfies Parameters<typeof query>[0];

        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
            },
        });

        await expect(sdkQuery.next()).rejects.toThrow('spawn failed');
    });

    it('propagates failed Claude process exits with stderr to the SDK message iterator', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();

        const sdkQuery = query(ctx, {
            prompt: prompt(),
            options: {
                cwd: '/tmp/project',
            },
        });
        await spawnClient.mock.results[0]?.value;

        const nextMessage = sdkQuery.next();
        await stream.exitWith({
            exitCode: 1,
            signal: null,
            stderr: 'Claude Code login expired',
        });

        await expect(nextMessage).rejects.toThrow('Claude Code login expired');
    });
});
