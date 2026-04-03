import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AbortError } from '@anthropic-ai/claude-agent-sdk';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { getProjectPath } from '../utils/path';

function createDeferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason?: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitForInterruptHandler(
    getter: () => (() => Promise<void>) | null,
    maxAttempts = 50,
): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const handler = getter();
        if (handler) return handler;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('interrupt handler was not registered');
}

describe('claudeRemoteAgentSdk abort repair', () => {
    it('appends an interrupted tool_result when aborting a turn mid-tool', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-abort-repair-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const dir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(dir, { recursive: true });
        const transcriptPath = join(getProjectPath(dir, claudeConfigDir), 'sess_1.jsonl');
        await mkdir(dirname(transcriptPath), { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

        let interval: NodeJS.Timeout | null = null;
        try {
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

        let interruptHandler: (() => Promise<void>) | null = null;
        let abortGateResolve: (() => void) | null = null;
        let abortRequested = false;

        const createQuery = vi.fn((_params: any) => {
            const waitForAbort = async () => {
                if (abortRequested) return;
                await new Promise<void>((resolve) => {
                    abortGateResolve = resolve;
                });
            };

            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'assistant',
                        uuid: 'asst_1',
                        message: {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'tool_use',
                                    id: 'toolu_1',
                                    name: 'Bash',
                                    input: { command: 'sleep 1000' },
                                },
                            ],
                        },
                    } as any;
                    await waitForAbort();
                    throw new AbortError('aborted');
                },
                interrupt: vi.fn(async () => {
                    abortRequested = true;
                    abortGateResolve?.();
                }),
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

            const runPromise = claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath,
                path: dir,
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                setTurnInterrupt: (handler: () => Promise<void>) => {
                    interruptHandler = handler;
                },
                createQuery,
            } as any);

            const handler = await waitForInterruptHandler(() => interruptHandler);
            await handler();
            await runPromise;

            const contents = await readFile(transcriptPath, 'utf8');
            const lines = contents
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => JSON.parse(line));

        const hasInterruptedToolResult = lines.some((entry: any) => {
            const blocks = entry?.message?.content;
            if (!Array.isArray(blocks)) return false;
            return blocks.some((b: any) => b?.type === 'tool_result' && b?.tool_use_id === 'toolu_1');
        });

            expect(hasInterruptedToolResult).toBe(true);
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('does not append an interrupted tool_result when the tool writes a real tool_result after interrupt', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-abort-repair-no-dupe-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const dir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(dir, { recursive: true });
        const transcriptPath = join(getProjectPath(dir, claudeConfigDir), 'sess_1.jsonl');
        await mkdir(dirname(transcriptPath), { recursive: true });
        const allowToolResultWrite = createDeferred<void>();
        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

        let interval: NodeJS.Timeout | null = null;
        try {
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

        let interruptHandler: (() => Promise<void>) | null = null;
        let interruptGateResolve: (() => void) | null = null;

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'assistant',
                        uuid: 'asst_1',
                        message: {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'tool_use',
                                    id: 'toolu_1',
                                    name: 'Bash',
                                    input: { command: 'sleep 1000' },
                                },
                            ],
                        },
                    } as any;

                    await new Promise<void>((resolve) => {
                        interruptGateResolve = resolve;
                    });

                    await allowToolResultWrite.promise;
                    await appendFile(
                        transcriptPath,
                        `${JSON.stringify({
                            type: 'user',
                            uuid: 'toolu_1',
                            isSidechain: false,
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: 'toolu_1',
                                        content: 'Real tool result',
                                        is_error: false,
                                    },
                                ],
                            },
                        })}\n`,
                        'utf8',
                    );
                    return;
                },
                interrupt: vi.fn(async () => {
                    interruptGateResolve?.();
                }),
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

            const runPromise = claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath,
                path: dir,
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                setTurnInterrupt: (handler: () => Promise<void>) => {
                    interruptHandler = handler;
                },
                createQuery,
            } as any);

            const handler = await waitForInterruptHandler(() => interruptHandler);
            await handler();

            allowToolResultWrite.resolve(undefined);
            await runPromise;

            const contents = await readFile(transcriptPath, 'utf8');
            expect(contents).toContain('Real tool result');

        const toolResultBlocks = contents
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line) as any;
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .flatMap((entry: any) => (Array.isArray(entry?.message?.content) ? entry.message.content : []))
            .filter((block: any) => block?.type === 'tool_result' && block?.tool_use_id === 'toolu_1');

            expect(toolResultBlocks).toHaveLength(1);
            expect(toolResultBlocks[0]?.content).toBe('Real tool result');
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('uses stopTask(taskId) for active background tasks and does not always fall back to interrupt()', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-claude-stop-task-'));
        const transcriptPath = join(dir, 'sess_1.jsonl');

        await writeFile(transcriptPath, '', 'utf8');

        let interruptHandler: (() => Promise<void>) | null = null;
        const taskStartedYielded = createDeferred<void>();
        const stopGate = createDeferred<void>();
        const stopTaskCalled = createDeferred<void>();

        const stopTask = vi.fn(async (_taskId: string) => {
            stopTaskCalled.resolve(undefined);
            stopGate.resolve(undefined);
        });
        const interrupt = vi.fn(async () => {});

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    taskStartedYielded.resolve(undefined);
                    yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                    yield {
                        type: 'assistant',
                        uuid: 'asst_1',
                        message: {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'tool_use',
                                    id: 'toolu_1',
                                    name: 'Bash',
                                    input: { command: 'sleep 1000' },
                                },
                            ],
                        },
                    } as any;

                    await stopGate.promise;
                    return;
                },
                stopTask,
                interrupt,
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        const runPromise = claudeRemoteAgentSdk({
            sessionId: 'sess_1',
            transcriptPath,
            path: dir,
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (handler: () => Promise<void>) => {
                interruptHandler = handler;
            },
            createQuery,
        } as any);

        await taskStartedYielded.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const handler = await waitForInterruptHandler(() => interruptHandler);
        await handler();
        await Promise.race([
            stopTaskCalled.promise,
            new Promise<void>((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('stopTask was not called')), 2000);
                timer.unref?.();
            }),
        ]);
        await runPromise;

        expect(stopTask).toHaveBeenCalledTimes(1);
        expect(stopTask).toHaveBeenCalledWith('task_1');
        expect(interrupt).not.toHaveBeenCalled();
    });

    it('falls back to interrupt() when stopTask(taskId) throws', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-claude-stop-task-throws-'));
        const transcriptPath = join(dir, 'sess_1.jsonl');

        await writeFile(transcriptPath, '', 'utf8');

        let interruptHandler: (() => Promise<void>) | null = null;
        const taskStartedYielded = createDeferred<void>();
        const stopGate = createDeferred<void>();

        const stopTask = vi.fn(async (_taskId: string) => {
            throw new Error('stopTask failed');
        });
        const interrupt = vi.fn(async () => {
            stopGate.resolve(undefined);
        });

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    taskStartedYielded.resolve(undefined);
                    yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                    yield {
                        type: 'assistant',
                        uuid: 'asst_1',
                        message: {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'tool_use',
                                    id: 'toolu_1',
                                    name: 'Bash',
                                    input: { command: 'sleep 1000' },
                                },
                            ],
                        },
                    } as any;

                    await stopGate.promise;
                    throw new AbortError('aborted');
                },
                stopTask,
                interrupt,
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

        const runPromise = claudeRemoteAgentSdk({
            sessionId: 'sess_1',
            transcriptPath,
            path: dir,
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (handler: () => Promise<void>) => {
                interruptHandler = handler;
            },
            createQuery,
        } as any);

        await taskStartedYielded.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const handler = await waitForInterruptHandler(() => interruptHandler);

        await handler();

        // Ensure the stream can terminate even if the interrupt path is buggy.
        stopGate.resolve(undefined);

        await runPromise;

        expect(stopTask).toHaveBeenCalledTimes(1);
        expect(stopTask).toHaveBeenCalledWith('task_1');
        expect(interrupt).toHaveBeenCalledTimes(1);
    });

    it('repairs missing tool_result on best-effort interrupt even when the Agent SDK does not throw AbortError', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-interrupt-repair-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const dir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(dir, { recursive: true });
        const transcriptPath = join(getProjectPath(dir, claudeConfigDir), 'sess_1.jsonl');
        await mkdir(dirname(transcriptPath), { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

        let interval: NodeJS.Timeout | null = null;
        try {
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

        let interruptHandler: (() => Promise<void>) | null = null;
        let interruptGateResolve: (() => void) | null = null;

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'assistant',
                        uuid: 'asst_1',
                        message: {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'tool_use',
                                    id: 'toolu_1',
                                    name: 'Bash',
                                    input: { command: 'sleep 1000' },
                                },
                            ],
                        },
                    } as any;

                    await new Promise<void>((resolve) => {
                        interruptGateResolve = resolve;
                    });

                    // End the stream without throwing AbortError (best-effort interrupt path).
                    return;
                },
                interrupt: vi.fn(async () => {
                    interruptGateResolve?.();
                }),
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (didSendFirst) return null;
            didSendFirst = true;
            return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
        });

            const runPromise = claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath,
                path: dir,
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                setTurnInterrupt: (handler: () => Promise<void>) => {
                    interruptHandler = handler;
                },
                createQuery,
            } as any);

            const handler = await waitForInterruptHandler(() => interruptHandler);
            await handler();
            await runPromise;

            const contents = await readFile(transcriptPath, 'utf8');
            expect(contents).toMatch(/\"type\":\"tool_result\"/);
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('repairs the transcript even when transcriptPath is missing (derive from CLAUDE_CONFIG_DIR + cwd)', async () => {
        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-abort-repair-derived-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        try {
            const transcriptPath = join(getProjectPath(workDir, claudeConfigDir), 'sess_1.jsonl');
            await mkdir(dirname(transcriptPath), { recursive: true });

            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

            let interruptHandler: (() => Promise<void>) | null = null;
            let abortGateResolve: (() => void) | null = null;
            let abortRequested = false;

            const createQuery = vi.fn((_params: any) => {
                const waitForAbort = async () => {
                    if (abortRequested) return;
                    await new Promise<void>((resolve) => {
                        abortGateResolve = resolve;
                    });
                };

                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: 'assistant',
                            uuid: 'asst_1',
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_1',
                                        name: 'Bash',
                                        input: { command: 'sleep 1000' },
                                    },
                                ],
                            },
                        } as any;
                        await waitForAbort();
                        throw new AbortError('aborted');
                    },
                    interrupt: vi.fn(async () => {
                        abortRequested = true;
                        abortGateResolve?.();
                    }),
                    close: vi.fn(),
                    setPermissionMode: vi.fn(),
                    setModel: vi.fn(),
                    setMaxThinkingTokens: vi.fn(),
                } as any;
            });

            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
            });

            const runPromise = claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath: null,
                path: workDir,
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                setTurnInterrupt: (handler: () => Promise<void>) => {
                    interruptHandler = handler;
                },
                createQuery,
            } as any);

            const handler = await waitForInterruptHandler(() => interruptHandler);
            await handler();
            await runPromise;

            const contents = await readFile(transcriptPath, 'utf8');
            expect(contents).toMatch(/\"type\":\"tool_result\"/);
        } finally {
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
        }
    });

    it('repairs only after the query is closed when the transcript is still being written until close()', async () => {
        const previousTimeout = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
        const previousPoll = process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = '50';
        process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = '10';

        const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-abort-repair-close-first-'));
        const claudeConfigDir = join(baseDir, 'claude-config');
        const workDir = join(baseDir, 'work');
        await mkdir(claudeConfigDir, { recursive: true });
        await mkdir(workDir, { recursive: true });
        const transcriptPath = join(getProjectPath(workDir, claudeConfigDir), 'sess_1.jsonl');
        await mkdir(dirname(transcriptPath), { recursive: true });

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

        let interval: NodeJS.Timeout | null = null;
        try {
            await writeFile(
                transcriptPath,
                `${JSON.stringify({
                    type: 'assistant',
                    uuid: 'asst_1',
                    isSidechain: false,
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'toolu_1',
                                name: 'Bash',
                                input: { command: 'sleep 1000' },
                            },
                        ],
                    },
                })}\n`,
            );

            let interruptHandler: (() => Promise<void>) | null = null;
            let interruptGateResolve: (() => void) | null = null;
            let closeCalled = false;

            const close = vi.fn(async () => {
                closeCalled = true;
                if (interval) {
                    clearInterval(interval);
                    interval = null;
                }
            });

            const createQuery = vi.fn((_params: any) => {
                interval = setInterval(() => {
                    if (closeCalled) return;
                    void appendFile(
                        transcriptPath,
                        `${JSON.stringify({
                            type: 'system',
                            uuid: `tick_${Date.now()}`,
                            isSidechain: false,
                            message: { role: 'system', content: [{ type: 'text', text: 'busy' }] },
                        })}\n`,
                        'utf8',
                    ).catch(() => {});
                }, 5);

                return {
                    async *[Symbol.asyncIterator]() {
                        yield {
                            type: 'assistant',
                            uuid: 'asst_1',
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: 'toolu_1',
                                        name: 'Bash',
                                        input: { command: 'sleep 1000' },
                                    },
                                ],
                            },
                        } as any;
                        await new Promise<void>((resolve) => {
                            interruptGateResolve = resolve;
                        });
                        return;
                    },
                    interrupt: vi.fn(async () => {
                        interruptGateResolve?.();
                    }),
                    close,
                    setPermissionMode: vi.fn(),
                    setModel: vi.fn(),
                    setMaxThinkingTokens: vi.fn(),
                } as any;
            });

            let didSendFirst = false;
            const nextMessage = vi.fn(async () => {
                if (didSendFirst) return null;
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
            });

            const runPromise = claudeRemoteAgentSdk({
                sessionId: 'sess_1',
                transcriptPath,
                path: workDir,
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
                onReady: () => {},
                onSessionFound: () => {},
                onMessage: () => {},
                setTurnInterrupt: (handler: () => Promise<void>) => {
                    interruptHandler = handler;
                },
                createQuery,
            } as any);

            const handler = await waitForInterruptHandler(() => interruptHandler);
            await handler();
            await runPromise;

            const contents = await readFile(transcriptPath, 'utf8');
            expect(contents).toMatch(/\"type\":\"tool_result\"/);
            expect(close).toHaveBeenCalled();
        } finally {
            if (interval) clearInterval(interval);
            if (previousClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
            }
            if (previousTimeout === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_TIMEOUT_MS = previousTimeout;
            }
            if (previousPoll === undefined) {
                delete process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS;
            } else {
                process.env.HAPPIER_CLAUDE_TRANSCRIPT_REPAIR_WAIT_TOOL_USE_IDS_POLL_INTERVAL_MS = previousPoll;
            }
        }
    });
});
