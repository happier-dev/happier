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
            claudeEnvVars: {},
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
});
