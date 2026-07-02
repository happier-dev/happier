import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: loggerDebug,
        error: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
    },
}));

import { runClaudeRemoteAgentSdk } from './runAgentSdk';
import { makeMode } from './testkit';

type Release = () => void;

function createQueryFromEvents(events: unknown[], holdOpen?: Promise<void>) {
    // Agent SDK tests use partial SDK payloads intentionally: the SDK is the external boundary here.
    return vi.fn((_params: unknown) => ({
        async *[Symbol.asyncIterator]() {
            for (const event of events) {
                yield event as any;
            }
            if (holdOpen) {
                await holdOpen;
            }
        },
        close: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        supportedCommands: vi.fn(async () => []),
        supportedModels: vi.fn(async () => []),
    } as any));
}

function createNextMessage() {
    let didSendFirst = false;
    return vi.fn(async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
    });
}

function createHoldOpen(): { promise: Promise<void>; release: Release } {
    let release: Release | null = null;
    return {
        promise: new Promise<void>((resolve) => {
            release = resolve;
        }),
        release: () => release?.(),
    };
}

describe('runAgentSdk subagent turn completion', () => {
    beforeEach(() => {
        loggerDebug.mockClear();
    });

    it('keeps the parent turn working when provider output continues after a result while next prompt is pending', async () => {
        let responseNextCalls = 0;
        let resolveDone: (() => void) | null = null;

        const createQuery = vi.fn((_params: unknown) => {
            let closed = false;
            const iterator = {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    if (closed) {
                        return { done: true, value: undefined };
                    }
                    responseNextCalls += 1;
                    if (responseNextCalls === 1) {
                        return { done: false, value: { type: 'result' } as any };
                    }
                    if (responseNextCalls === 2) {
                        return {
                            done: false,
                            value: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'after-result' }] },
                            } as any,
                        };
                    }
                    return await new Promise((resolve) => {
                        resolveDone = () => resolve({ done: true, value: undefined });
                    });
                },
            };

            return {
                ...iterator,
                close: vi.fn(() => {
                    closed = true;
                    resolveDone?.();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        let resolveSecond!: (value: { message: string; mode: any } | null) => void;
        const secondMessagePromise = new Promise<{ message: string; mode: any } | null>((resolve) => {
            resolveSecond = resolve;
        });
        const nextMessage = vi.fn(async () => {
            if (!didSendFirst) {
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            return await secondMessagePromise;
        });
        const thinkingEvents: boolean[] = [];
        const onReady = vi.fn();

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(responseNextCalls).toBeGreaterThanOrEqual(2);
            });

            expect(onReady).toHaveBeenCalledTimes(1);
            expect(thinkingEvents).toEqual([true, false, true]);
        } finally {
            resolveSecond(null);
            await runnerPromise;
        }
    });

    it('keeps the parent turn in flight when a subagent task_notification completes', async () => {
        const holdOpen = createHoldOpen();
        const callOrder: string[] = [];
        const onReady = vi.fn(() => callOrder.push('ready'));
        const onSubagentFlush = vi.fn(() => {
            callOrder[callOrder.length] = 'subagentFlush';
        });
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' },
        ], holdOpen.promise);

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        await vi.waitFor(() => {
            expect(onSubagentFlush).toHaveBeenCalledTimes(1);
        });

        expect(onReady).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['subagentFlush']);
        expect(thinkingEvents).toEqual([true]);

        holdOpen.release();
        await runnerPromise;
    });

    it('flushes subagents before emitting ready for the parent result', async () => {
        const callOrder: string[] = [];
        const onReady = vi.fn(() => callOrder.push('ready'));
        const onSubagentFlush = vi.fn(() => {
            callOrder[callOrder.length] = 'subagentFlush';
        });

        await runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                { type: 'system', subtype: 'task_started', task_id: 'task_1' },
                { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' },
                { type: 'system', subtype: 'task_started', task_id: 'task_2' },
                { type: 'system', subtype: 'task_notification', task_id: 'task_2', status: 'completed' },
                { type: 'result' },
            ]),
        } as any);

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onSubagentFlush).toHaveBeenCalledTimes(2);
        expect(callOrder).toEqual(['subagentFlush', 'subagentFlush', 'ready']);
    });

    it('emits ready once for a parent result without subagents', async () => {
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();

        await runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([{ type: 'result' }]),
        } as any);

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onSubagentFlush).not.toHaveBeenCalled();
    });

    it('releases a deferred parent result when a provider task notification reports succeeded', async () => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'succeeded' },
            { type: 'result' },
        ], holdOpen.promise);

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).toHaveBeenCalledTimes(1);
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('does not keep a provider task active when the task event patch is already terminal', async () => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1', patch: { status: 'succeeded' } },
            { type: 'result' },
        ], holdOpen.promise);

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('keeps the parent turn active when a result arrives while a background task is still running', async () => {
        const releaseBackgroundTask = createHoldOpen();
        const releaseClosed = createHoldOpen();
        const releaseQueuedPromptWait = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];
        let nextMessageCalls = 0;
        const nextMessage = vi.fn(async () => {
            nextMessageCalls += 1;
            if (nextMessageCalls === 1) {
                return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
            }
            await releaseQueuedPromptWait.promise;
            return null;
        });

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                    },
                    tool_use_result: {
                        assistantAutoBackgrounded: true,
                        backgroundTaskId: 'task_1',
                        interrupted: false,
                        stderr: '',
                        stdout: '',
                    },
                } as any;
                yield { type: 'result' } as any;
                await releaseBackgroundTask.promise;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await releaseClosed.promise;
            },
            close: vi.fn(() => {
                releaseBackgroundTask.release();
                releaseClosed.release();
            }),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            expect(thinkingEvents).toEqual([true]);
            const resultSummary = loggerDebug.mock.calls
                .map((call) => call[1])
                .find((summary) => (
                    summary
                    && typeof summary === 'object'
                    && (summary as { resultObserved?: unknown }).resultObserved === true
                ));
            expect(resultSummary).toMatchObject({
                activeProviderTaskBlockers: [
                    {
                        taskId: 'task_1',
                        sources: expect.arrayContaining([
                            'system-task-started',
                            'assistant-auto-backgrounded-tool-result',
                        ]),
                    },
                ],
                activeProviderTaskCount: 1,
                deferredCompletionForActiveProviderTasks: true,
            });

            releaseBackgroundTask.release();

            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onSubagentFlush).toHaveBeenCalledTimes(1);
        } finally {
            releaseBackgroundTask.release();
            releaseClosed.release();
            releaseQueuedPromptWait.release();
            await runnerPromise.catch(() => {});
        }
    });

    it.each([
        ['snake_case', { hook_event_name: 'Stop', background_tasks: [] }],
        ['camelCase', { hookEventName: 'Stop', backgroundTasks: [] }],
    ])('releases a deferred parent result when a Stop hook reports no background tasks with %s fields', async (_caseName, stopHook) => {
        const holdOpen = createHoldOpen();
        const onReady = vi.fn();
        const onSubagentFlush = vi.fn();
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
                },
                tool_use_result: {
                    assistantAutoBackgrounded: true,
                    backgroundTaskId: 'task_1',
                    interrupted: false,
                    stderr: '',
                    stdout: '',
                },
            },
            { type: 'result' },
            stopHook,
        ], holdOpen.promise);

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush,
            onThinkingChange: (thinking: boolean) => thinkingEvents.push(thinking),
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(thinkingEvents).toEqual([true, false]);
            });
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onSubagentFlush).not.toHaveBeenCalled();
        } finally {
            holdOpen.release();
            await runnerPromise;
        }
    });

    it('rejects Agent SDK error result subtypes instead of completing the turn normally', async () => {
        const onReady = vi.fn();

        await expect(runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                { type: 'result', subtype: 'error_max_turns', result: 'maximum turns reached' },
            ]),
        } as any)).rejects.toThrow(/error_max_turns/);

        expect(onReady).not.toHaveBeenCalled();
    });

    it('rejects Agent SDK execution errors instead of completing the turn normally', async () => {
        const onReady = vi.fn();

        await expect(runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                { type: 'result', subtype: 'error_during_execution', result: 'tool runner failed' },
            ]),
        } as any)).rejects.toThrow(/error_during_execution/);

        expect(onReady).not.toHaveBeenCalled();
    });

    it('includes Agent SDK result errors in execution failures', async () => {
        const onReady = vi.fn();

        await expect(runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady,
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery: createQueryFromEvents([
                {
                    type: 'result',
                    subtype: 'error_during_execution',
                    errors: ['Cannot resume the requested Claude conversation.'],
                },
            ]),
        } as any)).rejects.toThrow(/Cannot resume the requested Claude conversation/u);

        expect(onReady).not.toHaveBeenCalled();
    });

    it('keeps the latest active subagent interrupt target when an earlier subagent completes', async () => {
        const holdOpen = createHoldOpen();
        const stopTask = vi.fn(async () => {});
        let capturedTurnInterrupt: (() => Promise<void>) | null = null;

        const createQuery = vi.fn((_params: unknown) => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'task_started', task_id: 'task_1' } as any;
                yield { type: 'system', subtype: 'task_started', task_id: 'task_2' } as any;
                yield { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' } as any;
                await holdOpen.promise;
            },
            stopTask,
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        const runnerPromise = runClaudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: createNextMessage(),
            onReady: () => {},
            onSubagentFlush: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            setTurnInterrupt: (next: (() => Promise<void>) | null) => {
                capturedTurnInterrupt = next;
            },
            createQuery,
        } as any);

        await vi.waitFor(() => {
            expect(capturedTurnInterrupt).toBeTypeOf('function');
        });

        await vi.waitFor(() => {
            expect(createQuery).toHaveBeenCalled();
        });

        await (capturedTurnInterrupt as unknown as () => Promise<void>)();
        expect(stopTask).toHaveBeenCalledWith('task_2');

        holdOpen.release();
        await runnerPromise;
    });
});
