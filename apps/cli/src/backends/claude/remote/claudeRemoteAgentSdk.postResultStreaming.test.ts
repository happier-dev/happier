import { describe, expect, it, vi } from 'vitest';

import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

type CreateQuery = NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;

describe('claudeRemoteAgentSdk post-result streaming', () => {
    it.each(['success', 'error_during_execution'] as const)('keeps the submitted turn active when a %s result reports queued user sends', async (subtype) => {
        let releaseQueuedTurn!: () => void;
        const queuedTurn = new Promise<void>((resolve) => { releaseQueuedTurn = resolve; });
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        let reachedQueuedContinuation = false;
        const createQuery = (({ prompt }: Parameters<CreateQuery>[0]) => ({
            async *[Symbol.asyncIterator]() {
                const input = await (prompt as AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>)[Symbol.asyncIterator]().next();
                if (input.done) throw new Error('Expected initial prompt');
                yield { ...input.value, isReplay: true, session_id: 'claude-resumed' };
                yield { type: 'system', subtype: 'init', session_id: 'claude-resumed' };
                yield { type: 'result', subtype, session_id: 'claude-resumed', queued_turn_count: 1, result: 'notification finished' };
                reachedQueuedContinuation = true;
                await queuedTurn;
                yield { type: 'result', subtype: 'success', session_id: 'claude-resumed', queued_turn_count: 0, result: 'user turn finished' };
                await inputFinished;
            },
            close() { finishInput(); },
        })) as unknown as NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;
        const onReady = vi.fn();
        const onMessage = vi.fn();
        const onCompletionEvent = vi.fn();
        const thinkingEvents: boolean[] = [];
        const acceptedLocalIds: Array<readonly string[]> = [];
        let firstInput = true;
        let laterInput = true;
        const nextMessage = vi.fn(async () => {
            if (firstInput) {
                firstInput = false;
                return { message: 'continue', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }), userMessageLocalIds: ['requested'] };
            }
            if (laterInput) {
                laterInput = false;
                return { message: 'later prompt', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }), userMessageLocalIds: ['later'] };
            }
            await inputFinished;
            return null;
        });
        const runner = claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: '/tmp', claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, nextMessage, onReady, onMessage, onCompletionEvent,
            onPromptAcceptedByProvider: ({ userMessageLocalIds }) => { acceptedLocalIds.push(userMessageLocalIds); },
            onThinkingChange: (thinking) => { thinkingEvents.push(thinking); },
            onSessionFound: () => {}, createQuery,
        });
        void runner.catch(() => {});
        try {
            await vi.waitFor(() => { expect(reachedQueuedContinuation).toBe(true); });
            expect(onReady).not.toHaveBeenCalled();
            expect(acceptedLocalIds).toEqual([['requested']]);
            expect(thinkingEvents).toEqual([true]);
            expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', queued_turn_count: 1 }));
            if (subtype === 'error_during_execution') {
                expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining(subtype));
            }
            releaseQueuedTurn();
            await vi.waitFor(() => { expect(onReady).toHaveBeenCalledOnce(); });
            expect(thinkingEvents.slice(0, 2)).toEqual([true, false]);
        } finally {
            releaseQueuedTurn(); finishInput();
            await runner;
        }
    });

    it('continues consuming post-result assistant output without reopening the foreground turn', async () => {
        let responseNextCalls = 0;
        let resolveDone: (() => void) | null = null;

        const createQuery = vi.fn((_params: any) => {
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
        const nextMessage = vi.fn(async (): Promise<{ message: string; mode: any } | null> => {
            if (!didSendFirst) {
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            return await secondMessagePromise;
        });
        const thinkingEvents: boolean[] = [];
        const onReady = vi.fn();
        const onMessage = vi.fn();

        const runnerPromise = claudeRemoteAgentSdk({
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
            onMessage,
            createQuery,
        } as any);

        try {
            // Wait for the runner to spawn the query and begin consuming the stream.
            for (let i = 0; i < 50 && createQuery.mock.calls.length === 0; i++) {
                await new Promise((r) => setTimeout(r, 0));
            }
            expect(createQuery).toHaveBeenCalledTimes(1);

            for (let i = 0; i < 50 && responseNextCalls < 2; i++) {
                await new Promise((r) => setTimeout(r, 0));
            }

            // Expect it to keep consuming the stream even though the next user message isn't available yet.
            expect(responseNextCalls).toBeGreaterThanOrEqual(2);
            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant' }));
            expect(thinkingEvents).toEqual([true, false]);
        } finally {
            resolveSecond(null);
            await runnerPromise;
        }
    });

    it('does not reopen the foreground turn for late post-result stream events without a follow-up prompt', async () => {
        let responseNextCalls = 0;
        let resolveDone: (() => void) | null = null;

        const createQuery = vi.fn((_params: any) => {
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
                                type: 'stream_event',
                                event: {
                                    type: 'content_block_delta',
                                    delta: { type: 'text_delta', text: 'after-result-stream' },
                                },
                            } as any,
                        };
                    }
                    if (responseNextCalls === 3) {
                        return {
                            done: false,
                            value: {
                                type: 'stream_event',
                                event: { type: 'message_stop' },
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
        const nextMessage = vi.fn(async (): Promise<{ message: string; mode: any } | null> => {
            if (!didSendFirst) {
                didSendFirst = true;
                return { message: 'hello', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            return await secondMessagePromise;
        });
        const thinkingEvents: boolean[] = [];
        const onReady = vi.fn();
        const onMessage = vi.fn();

        const runnerPromise = claudeRemoteAgentSdk({
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
            onMessage,
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(responseNextCalls).toBeGreaterThanOrEqual(3);
            });

            expect(onReady).toHaveBeenCalledTimes(1);
            expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant' }));
            expect(thinkingEvents).toEqual([true, false]);
        } finally {
            resolveSecond(null);
            await runnerPromise;
        }
    });

    it('reopens and completes the canonical turn for a new owned root message after a resume result', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 'happier-session',
            enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
        });
        await lifecycle.beginTurn({ provider: 'claude' });
        let reachedRoot = false;
        let releaseRoot!: () => void;
        const rootReady = new Promise<void>((resolve) => { releaseRoot = resolve; });
        let releaseResult!: () => void;
        const resultReady = new Promise<void>((resolve) => { releaseResult = resolve; });
        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => { finishInput = resolve; });
        let firstInput = true;
        const thinkingEvents: boolean[] = [];
        const rootStart = {
            type: 'stream_event', session_id: 'owned-session', parent_tool_use_id: null,
            event: { type: 'message_start', message: { role: 'assistant', content: [] } },
        };
        // Only the SDK query transport is stubbed; unused SDK control methods are omitted.
        const createQuery = () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                yield { type: 'result', session_id: 'owned-session' };
                yield { ...rootStart, parent_tool_use_id: 'child-task' };
                yield { ...rootStart, session_id: 'foreign-session' };
                yield { ...rootStart, isReplay: true };
                reachedRoot = true;
                await rootReady;
                yield rootStart;
                yield rootStart;
                await resultReady;
                yield { type: 'result', session_id: 'owned-session' };
                await inputFinished;
            },
            close() { finishInput(); },
        }) as unknown as ReturnType<NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>>;
        const runner = claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: '/tmp', claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (firstInput) {
                    firstInput = false;
                    return { message: 'continue', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
                }
                await inputFinished;
                return null;
            },
            onReady: async () => { await lifecycle.completeTurn({ provider: 'claude' }); },
            onProviderPromptStarted: async () => { await lifecycle.beginTurn({ provider: 'claude' }); },
            onThinkingChange: (thinking: boolean) => { thinkingEvents.push(thinking); },
            onSessionFound: () => {}, onMessage: () => {}, createQuery,
        });
        try {
            await vi.waitFor(() => { expect(mutations.map((m) => m.action)).toEqual(['begin', 'complete']); });
            await vi.waitFor(() => { expect(reachedRoot).toBe(true); });
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(thinkingEvents).toEqual([true, false]);
            releaseRoot();
            await vi.waitFor(() => { expect(lifecycle.hasActiveTurn()).toBe(true); });
            expect(thinkingEvents).toEqual([true, false, true]);
            releaseResult();
            await vi.waitFor(() => { expect(mutations.map((m) => m.action)).toEqual(['begin', 'complete', 'begin', 'complete']); });
            expect(lifecycle.hasActiveTurn()).toBe(false);
            expect(thinkingEvents).toEqual([true, false, true, false]);
        } finally {
            releaseRoot(); releaseResult(); finishInput();
            await runner;
        }
    });

    it('re-arms turn finalization for the next queued prompt so later results can release another turn', async () => {
        let releaseSecondTurnPrompt!: () => void;
        const secondTurnPromptReady = new Promise<void>((resolve) => {
            releaseSecondTurnPrompt = resolve;
        });

        let releaseClosed!: () => void;
        const responseClosed = new Promise<void>((resolve) => {
            releaseClosed = resolve;
        });

        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => {
            finishInput = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            let closed = false;
            const iterator = {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    if (closed) {
                        return { done: true, value: undefined };
                    }

                    if (!this.sentFirstResult) {
                        this.sentFirstResult = true;
                        return { done: false, value: { type: 'result' } as any };
                    }

                    if (!this.sentSecondPrompt) {
                        await secondTurnPromptReady;
                        this.sentSecondPrompt = true;
                        return {
                            done: false,
                            value: {
                                type: 'assistant',
                                message: { role: 'assistant', content: [{ type: 'text', text: 'second-turn' }] },
                            } as any,
                        };
                    }

                    if (!this.sentSecondResult) {
                        this.sentSecondResult = true;
                        return { done: false, value: { type: 'result' } as any };
                    }

                    return await responseClosed.then(() => ({ done: true, value: undefined }));
                },
                sentFirstResult: false,
                sentSecondPrompt: false,
                sentSecondResult: false,
            };

            return {
                ...iterator,
                close: vi.fn(() => {
                    closed = true;
                    releaseClosed();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) {
                return { message: 'first', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            if (callCount === 2) {
                releaseSecondTurnPrompt();
                return { message: 'second', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            await inputFinished;
            return null;
        });

        const onReady = vi.fn();

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(2);
            });
            await vi.waitFor(() => {
                expect(nextMessage).toHaveBeenCalledTimes(3);
            });
        } finally {
            finishInput();
            releaseClosed();
            await runnerPromise.catch(() => {});
        }
    });

    it('treats a result-only queued turn as a new turn so a second result can release the queue', async () => {
        let releaseSecondTurnPrompt!: () => void;
        const secondTurnPromptReady = new Promise<void>((resolve) => {
            releaseSecondTurnPrompt = resolve;
        });

        let releaseClosed!: () => void;
        const responseClosed = new Promise<void>((resolve) => {
            releaseClosed = resolve;
        });

        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => {
            finishInput = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            let closed = false;
            const iterator = {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    if (closed) {
                        return { done: true, value: undefined };
                    }

                    if (!this.sentFirstResult) {
                        this.sentFirstResult = true;
                        return { done: false, value: { type: 'result', result: 'first-result' } as any };
                    }

                    if (!this.sentSecondPrompt) {
                        await secondTurnPromptReady;
                        this.sentSecondPrompt = true;
                        return { done: false, value: { type: 'result', result: 'second-result-only-turn' } as any };
                    }

                    return await responseClosed.then(() => ({ done: true, value: undefined }));
                },
                sentFirstResult: false,
                sentSecondPrompt: false,
            };

            return {
                ...iterator,
                close: vi.fn(() => {
                    closed = true;
                    releaseClosed();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) {
                return { message: 'first', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            if (callCount === 2) {
                releaseSecondTurnPrompt();
                return { message: 'second', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            await inputFinished;
            return null;
        });

        const onReady = vi.fn();

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(2);
            });
            await vi.waitFor(() => {
                expect(nextMessage).toHaveBeenCalledTimes(3);
            });
        } finally {
            finishInput();
            releaseClosed();
            await runnerPromise.catch(() => {});
        }
    });

    it('treats a queued non-text user message as a new turn so the trailing result can release the queue', async () => {
        let releaseSecondTurnPrompt!: () => void;
        const secondTurnPromptReady = new Promise<void>((resolve) => {
            releaseSecondTurnPrompt = resolve;
        });

        let releaseClosed!: () => void;
        const responseClosed = new Promise<void>((resolve) => {
            releaseClosed = resolve;
        });

        let finishInput!: () => void;
        const inputFinished = new Promise<void>((resolve) => {
            finishInput = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            let closed = false;
            const iterator = {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    if (closed) {
                        return { done: true, value: undefined };
                    }

                    if (!this.sentFirstResult) {
                        this.sentFirstResult = true;
                        return { done: false, value: { type: 'result', result: 'first-result' } as any };
                    }

                    if (!this.sentSecondPrompt) {
                        await secondTurnPromptReady;
                        this.sentSecondPrompt = true;
                        return {
                            done: false,
                            value: {
                                type: 'user',
                                message: {
                                    role: 'user',
                                    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
                                },
                            } as any,
                        };
                    }

                    if (!this.sentSecondResult) {
                        this.sentSecondResult = true;
                        return { done: false, value: { type: 'result', result: 'second-turn-finished' } as any };
                    }

                    return await responseClosed.then(() => ({ done: true, value: undefined }));
                },
                sentFirstResult: false,
                sentSecondPrompt: false,
                sentSecondResult: false,
            };

            return {
                ...iterator,
                close: vi.fn(() => {
                    closed = true;
                    releaseClosed();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let callCount = 0;
        const nextMessage = vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) {
                return { message: 'first', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            if (callCount === 2) {
                releaseSecondTurnPrompt();
                return { message: 'second', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            await inputFinished;
            return null;
        });

        const onReady = vi.fn();

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeArgs: [],
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(2);
            });
            await vi.waitFor(() => {
                expect(nextMessage).toHaveBeenCalledTimes(3);
            });
        } finally {
            finishInput();
            releaseClosed();
            await runnerPromise.catch(() => {});
        }
    });
});
