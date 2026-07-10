import { describe, expect, it, vi } from 'vitest';
import type { ExecClientHandleV1, JsonStreamClientV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createClaudeExecutionRunBackend } from './createClaudeExecutionRunBackend.js';
import type { SDKMessage } from '../sdk/types.js';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await delay(1);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function createJsonStreamHandle() {
    const listeners = new Set<(record: unknown) => void | Promise<void>>();
    const written: unknown[] = [];
    const dispose = vi.fn(async () => undefined);
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
        dispose,
    };
    return {
        dispose,
        handle,
        written,
        listenerCount: () => listeners.size,
        async emit(record: unknown) {
            await Promise.all([...listeners].map((listener) => listener(record)));
        },
    };
}

function createContextFixture(stream = createJsonStreamHandle()) {
    const spawnClient = vi.fn(async () => stream.handle);
    const currentSession = {
        permissions: {
            requestDecision: vi.fn(),
            getMode: () => 'default',
        },
        writeStateField: vi.fn(async () => undefined),
    };
    return {
        ctx: {
            session: currentSession,
            sessions: {
                current: currentSession,
            },
            logger: {
                debug: vi.fn(),
            },
            agentRuntime: {
                exec: {
                    spawnClient,
                },
            },
        } as unknown as PluginContextV1,
        spawnClient,
        stream,
    };
}

describe('createClaudeExecutionRunBackend default SDK runtime', () => {
    it('submits prompts without waiting for the Claude SDK stream to complete', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
            },
        });

        const result = await Promise.race([
            backend.sendPrompt('claude-execution-run:run_1', 'review this').then(() => 'submitted' as const),
            delay(25).then(() => 'blocked' as const),
        ]);

        expect(result).toBe('submitted');
        expect(spawnClient).toHaveBeenCalledWith(expect.objectContaining({
            launch: expect.objectContaining({
                kind: 'agent-cli',
                agentId: 'claude',
                cwd: '/tmp/project',
            }),
            protocol: { kind: 'json-stream' },
            transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
        }), expect.anything());
        await backend.dispose();
        expect(stream.dispose).toHaveBeenCalled();
    });

    it('applies the execution-run model before the first SDK query', async () => {
        const { ctx, spawnClient, stream } = createContextFixture();
        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
                modelId: 'claude-opus-test',
            },
        });

        await backend.sendPrompt('claude-execution-run:run_1', 'review this');

        expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
            '--model',
            'claude-opus-test',
        ]));
        await backend.dispose();
        expect(stream.dispose).toHaveBeenCalled();
    });

    it('emits each SDK stream message once', async () => {
        const assistantMessage = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
            },
        } satisfies SDKMessage;
        const resultMessage = {
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-provider-session-1',
        } satisfies SDKMessage;
        const { ctx, stream } = createContextFixture();
        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
            },
        });
        const messages: SDKMessage[] = [];
        backend.subscribeMessages((message) => {
            messages.push(message as SDKMessage);
        });

        await backend.sendPrompt('claude-execution-run:run_1', 'review this');
        await waitForCondition(() => stream.listenerCount() > 0, 'Claude SDK stream subscription');
        await stream.emit(assistantMessage);
        await stream.emit(resultMessage);
        await backend.waitForTurnCompletion?.();

        expect(messages).toEqual([
            expect.objectContaining({
                kind: 'message-delta',
                sessionId: 'claude-execution-run:run_1',
                turnId: 'claude-agent-sdk-turn-1',
                delta: {
                    agentId: 'claude',
                    message: assistantMessage,
                },
            }),
            expect.objectContaining({
                kind: 'turn-complete',
                sessionId: 'claude-provider-session-1',
                turnId: 'claude-agent-sdk-turn-1',
                summary: {
                    agentId: 'claude',
                    result: null,
                },
            }),
        ]);
        await backend.dispose();
    });

    it.each(['safe-yolo', 'workspace-write', 'no_tools'] as const)(
        'submits %s prompts as stream-json when permission callbacks are enabled',
        async (permissionMode) => {
            const { ctx, spawnClient, stream } = createContextFixture();
            const backend = createClaudeExecutionRunBackend({
                ctx,
                executionRunParams: {
                    backendId: 'claude',
                    cwd: '/tmp/project',
                    permissionMode,
                    runId: 'run_1',
                },
            });

            await backend.sendPrompt('claude-execution-run:run_1', 'review this');
            await waitForCondition(() => stream.written.length > 0, 'Claude prompt stream write');
            await stream.emit({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'claude-provider-session-1',
            } satisfies SDKMessage);
            await backend.waitForTurnCompletion?.();

            expect(spawnClient).toHaveBeenCalledTimes(1);
            expect(spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
                '--permission-prompt-tool',
                'stdio',
                '--input-format',
                'stream-json',
            ]));
            expect(stream.written).toEqual([{
                type: 'user',
                message: { role: 'user', content: 'review this' },
            }]);
            await backend.dispose();
        },
    );

    it('bounds turn-completion waits with timeoutMs', async () => {
        const { ctx } = createContextFixture();
        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
            },
        });

        await backend.sendPrompt('claude-execution-run:run_1', 'review this');

        const result = await Promise.race([
            backend.waitForTurnCompletion?.(5).then(
                () => 'resolved',
                (error: unknown) => error instanceof Error ? error.message : String(error),
            ),
            delay(50).then(() => 'blocked'),
        ]);

        expect(result).toBe('Timed out after 5ms');
        await backend.dispose();
    });
});
