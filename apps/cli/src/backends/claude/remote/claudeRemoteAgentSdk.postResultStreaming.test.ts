import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

describe('claudeRemoteAgentSdk post-result streaming', () => {
    it('continues consuming the response stream after a result while waiting for nextMessage', async () => {
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

            const runnerPromise = claudeRemoteAgentSdk({
                sessionId: null,
                transcriptPath: null,
                path: '/tmp',
                claudeArgs: [],
                claudeExecutablePath: '/tmp/claude',
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                isAborted: () => false,
                nextMessage,
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
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
        } finally {
            resolveSecond(null);
            await runnerPromise;
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
            releaseClosed();
            await runnerPromise.catch(() => {});
        }
    });
});
