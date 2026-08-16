import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

describe('claudeRemoteAgentSdk stream events', () => {
    const runAgentSdkStreamForCompactionEvents = async (
        streamMessages: unknown[],
        options?: Readonly<{ initialMessage?: string }>,
    ) => {
        const onCompletionEvent = vi.fn();
        let didSendPrompt = false;
        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    for (const message of streamMessages) {
                        yield message as any;
                    }
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: options?.initialMessage ?? 'hello',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onCompletionEvent,
            createQuery,
        } as any);

        return onCompletionEvent.mock.calls
            .map((call) => call[0])
            .filter((event): event is Record<string, unknown> =>
                Boolean(event && typeof event === 'object' && (event as { type?: unknown }).type === 'context-compaction')
            );
    };

    it('confirms provider acceptance only after the Agent SDK exact process-transport write callback succeeds', async () => {
        const onPromptAcceptedByProvider = vi.fn();
        let didSendPrompt = false;
        let acceptedAtCreateQuery = -1;
        let confirmWrite: (() => void) | null = null;
        let didWriteExactPrompt = false;
        let resolveWriteObserved: (() => void) | null = null;
        const writeObserved = new Promise<void>((resolve) => {
            resolveWriteObserved = resolve;
        });
        const stdin = new EventEmitter() as EventEmitter & {
            write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
            end: () => void;
            writableEnded: boolean;
        };
        stdin.writableEnded = false;
        stdin.write = (chunk, callback) => {
            didWriteExactPrompt = chunk.includes('agent-sdk-local-12') === false && chunk.includes('hello');
            confirmWrite = () => callback?.(null);
            resolveWriteObserved?.();
            return true;
        };
        stdin.end = () => {
            stdin.writableEnded = true;
        };
        const spawnedProcess = Object.assign(new EventEmitter(), {
            stdin,
            stdout: Readable.from([]),
            killed: false,
            exitCode: null,
            kill: vi.fn(() => true),
        });
        const spawnClaudeCodeProcess = vi.fn(() => spawnedProcess as any);
        const createQuery = vi.fn((params: any) => {
            acceptedAtCreateQuery = onPromptAcceptedByProvider.mock.calls.length;
            if (typeof params.options.spawnClaudeCodeProcess !== 'function') {
                throw new Error('missing Agent SDK prompt transport spawn seam');
            }
            const process = params.options.spawnClaudeCodeProcess({
                command: '/managed/js-runtime',
                args: ['/resolved/claude-cli.js'],
                cwd: '/tmp',
                env: {},
                signal: new AbortController().signal,
            });
            return {
                async *[Symbol.asyncIterator]() {
                    const consumed = await (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
                    if (consumed.done) throw new Error('expected exact Agent SDK prompt');
                    process.stdin.write(`${JSON.stringify({
                        type: 'control_response',
                        response: { request_id: 'control-before-user' },
                    })}\n`);
                    process.stdin.write(`${JSON.stringify(consumed.value)}\n`);
                    await new Promise<void>((resolve) => {
                        const poll = () => {
                            if (onPromptAcceptedByProvider.mock.calls.length > 0) {
                                resolve();
                                return;
                            }
                            setImmediate(poll);
                        };
                        poll();
                    });
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        const run = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'hello',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                    maxUserMessageSeq: 12,
                    userMessageLocalIds: ['agent-sdk-local-12'],
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onPromptAcceptedByProvider,
            spawnClaudeCodeProcess,
            createQuery,
        } as any);

        await Promise.race([
            writeObserved,
            run.then(
                () => { throw new Error('Agent SDK run completed before writing the exact prompt'); },
                (error) => { throw error; },
            ),
        ]);
        expect(createQuery).toHaveBeenCalledTimes(1);
        expect(spawnClaudeCodeProcess).toHaveBeenCalledTimes(1);
        expect(acceptedAtCreateQuery).toBe(0);
        expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
        expect(didWriteExactPrompt).toBe(true);
        (confirmWrite as (() => void) | null)?.();
        spawnedProcess.emit('error', new Error('later process failure after confirmed write'));
        await run;
        expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
        expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
            maxUserMessageSeq: 12,
            userMessageLocalIds: ['agent-sdk-local-12'],
        });
    });

    it('reports Agent SDK stdin callback failure after the write attempt as effect-ambiguous', async () => {
        const onPromptAcceptedByProvider = vi.fn();
        const onPromptTransportFailure = vi.fn();
        let didSendPrompt = false;
        const stdin = new EventEmitter() as EventEmitter & {
            write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
            end: () => void;
            writableEnded: boolean;
        };
        stdin.writableEnded = false;
        stdin.write = (_chunk, callback) => {
            callback?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
            return true;
        };
        stdin.end = () => {
            stdin.writableEnded = true;
        };
        const spawnedProcess = Object.assign(new EventEmitter(), {
            stdin,
            stdout: Readable.from([]),
            killed: false,
            exitCode: null,
            kill: vi.fn(() => true),
        });
        const createQuery = vi.fn((params: any) => {
            if (typeof params.options.spawnClaudeCodeProcess !== 'function') {
                throw new Error('missing Agent SDK prompt transport spawn seam');
            }
            const process = params.options.spawnClaudeCodeProcess({
                command: '/managed/js-runtime',
                args: ['/resolved/claude-cli.js'],
                cwd: '/tmp',
                env: {},
                signal: new AbortController().signal,
            });
            return {
                async *[Symbol.asyncIterator]() {
                    const consumed = await (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
                    if (consumed.done) throw new Error('expected exact Agent SDK prompt');
                    process.stdin.write(`${JSON.stringify(consumed.value)}\n`);
                    throw new Error('Agent SDK transport failed');
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'hello',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                    maxUserMessageSeq: 12,
                    userMessageLocalIds: ['agent-sdk-local-12'],
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onPromptAcceptedByProvider,
            onPromptTransportFailure,
            spawnClaudeCodeProcess: vi.fn(() => spawnedProcess as any),
            createQuery,
        } as any)).rejects.toThrow('Agent SDK transport failed');

        expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
        expect(onPromptTransportFailure).toHaveBeenCalledWith({
            kind: 'effect_may_have_occurred',
            maxUserMessageSeq: 12,
            userMessageLocalIds: ['agent-sdk-local-12'],
        });
    });

    it('reports a process error before the exact write callback as effect-ambiguous', async () => {
        const onPromptAcceptedByProvider = vi.fn();
        const onPromptTransportFailure = vi.fn();
        let didSendPrompt = false;
        const stdin = new EventEmitter() as EventEmitter & {
            write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
            end: () => void;
            writableEnded: boolean;
        };
        stdin.writableEnded = false;
        stdin.write = () => true;
        stdin.end = () => {
            stdin.writableEnded = true;
        };
        const spawnedProcess = Object.assign(new EventEmitter(), {
            stdin,
            stdout: Readable.from([]),
            killed: false,
            exitCode: null,
            kill: vi.fn(() => true),
        });
        const createQuery = vi.fn((params: any) => {
            const process = params.options.spawnClaudeCodeProcess({
                command: '/managed/js-runtime',
                args: ['/resolved/claude-cli.js'],
                cwd: '/tmp',
                env: {},
                signal: new AbortController().signal,
            });
            return {
                async *[Symbol.asyncIterator]() {
                    const consumed = await (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
                    if (consumed.done) throw new Error('expected exact Agent SDK prompt');
                    process.stdin.write(`${JSON.stringify(consumed.value)}\n`);
                    spawnedProcess.emit('error', new Error('process failed before write callback'));
                    throw new Error('Agent SDK process failed');
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'hello',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                    maxUserMessageSeq: 12,
                    userMessageLocalIds: ['agent-sdk-local-12'],
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onPromptAcceptedByProvider,
            onPromptTransportFailure,
            spawnClaudeCodeProcess: vi.fn(() => spawnedProcess as any),
            createQuery,
        } as any)).rejects.toThrow('Agent SDK process failed');

        expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
        expect(onPromptTransportFailure).toHaveBeenCalledExactlyOnceWith({
            kind: 'effect_may_have_occurred',
            maxUserMessageSeq: 12,
            userMessageLocalIds: ['agent-sdk-local-12'],
        });
    });

    it('streams an exact steer action into the active Agent SDK turn without interrupting it', async () => {
        let nextMessageCall = 0;
        let receivedSecondPrompt: any = null;
        let secondPromptArrivedBeforeResult = false;
        const steerabilityChanges: boolean[] = [];
        const interrupt = vi.fn(async () => {});
        const createQuery = vi.fn((params: any) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                await promptIterator.next();
                const timeout = Symbol('timeout');
                const second = await Promise.race([
                    promptIterator.next(),
                    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 100)),
                ]);
                if (second !== timeout && !second.done) {
                    receivedSecondPrompt = second.value;
                    secondPromptArrivedBeforeResult = true;
                }
                yield { type: 'result' } as any;
            },
            interrupt,
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        }));

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                nextMessageCall += 1;
                if (nextMessageCall === 1) {
                    return { message: 'initial', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
                }
                if (nextMessageCall === 2) {
                    return {
                        message: 'steer this turn',
                        mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                        pendingProviderAction: 'steer' as const,
                        userMessageLocalIds: ['steer-local'],
                    };
                }
                return await new Promise<never>(() => {});
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onInFlightSteerAvailabilityChange: (available: boolean) => steerabilityChanges.push(available),
            createQuery,
        } as any);

        expect(secondPromptArrivedBeforeResult).toBe(true);
        expect(receivedSecondPrompt).toEqual(expect.objectContaining({
            message: expect.objectContaining({
                content: [expect.objectContaining({ text: 'steer this turn' })],
            }),
        }));
        expect(interrupt).not.toHaveBeenCalled();
        expect(steerabilityChanges).toContain(true);
    });

    it('interrupts the active Agent SDK turn before streaming an exact interrupt-and-send action', async () => {
        let nextMessageCall = 0;
        let didInterrupt = false;
        let interruptObservedBeforeSecondPrompt = false;
        const interrupt = vi.fn(async () => {
            didInterrupt = true;
        });
        const createQuery = vi.fn((params: any) => ({
            async *[Symbol.asyncIterator]() {
                const promptIterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                await promptIterator.next();
                const timeout = Symbol('timeout');
                const second = await Promise.race([
                    promptIterator.next(),
                    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 100)),
                ]);
                if (second !== timeout && !second.done) {
                    interruptObservedBeforeSecondPrompt = didInterrupt;
                }
                yield {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    result: 'Request interrupted by user',
                } as any;
                yield { type: 'result' } as any;
            },
            interrupt,
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        }));

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                nextMessageCall += 1;
                if (nextMessageCall === 1) {
                    return { message: 'initial', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
                }
                if (nextMessageCall === 2) {
                    return {
                        message: 'interrupt then run this',
                        mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                        pendingProviderAction: 'interrupt_and_send' as const,
                        userMessageLocalIds: ['interrupt-local'],
                    };
                }
                return await new Promise<never>(() => {});
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            createQuery,
        } as any);

        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(interruptObservedBeforeSecondPrompt).toBe(true);
        expect(createQuery).toHaveBeenCalledTimes(1);
    });

    it('keeps Agent SDK provider input closed when Runtime Activity observer activation rejects', async () => {
        let providerReadSettled = false;
        let didSendPrompt = false;
        const readinessOrder: string[] = [];
        const createQuery = vi.fn((params: any) => {
            readinessOrder.push('query-installed');
            void (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next().then(() => {
                providerReadSettled = true;
            });
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });
        const runtimeActivityAdapter = {
            activateObservation: vi.fn(async () => {
                readinessOrder.push('runtime-offered');
                throw new Error('observer activation failed');
            }),
            observeActivity: vi.fn(async () => {}),
            publishCurrent: vi.fn(async () => {}),
            handleRuntimeLoss: vi.fn(async () => {}),
        };
        const onPromptAcceptedByProvider = vi.fn();

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'must remain closed',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            onPromptAcceptedByProvider,
            onWorkflowActivityObserverReady: () => { readinessOrder.push('workflow-armed'); },
            runtimeActivityAdapter,
            createQuery,
        })).rejects.toThrow('observer activation failed');

        await Promise.resolve();
        expect(createQuery).toHaveBeenCalledTimes(1);
        expect(runtimeActivityAdapter.activateObservation).toHaveBeenCalledTimes(1);
        expect(readinessOrder).toEqual(['query-installed', 'workflow-armed', 'runtime-offered']);
        expect(providerReadSettled).toBe(false);
        expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
    });

    it('does not replace an exact terminal result with Runtime Activity observation loss', async () => {
        let didSendPrompt = false;
        const runtimeActivityAdapter = {
            activateObservation: vi.fn(async () => {}),
            observeActivity: vi.fn(async () => {}),
            publishCurrent: vi.fn(async () => {}),
            handleRuntimeLoss: vi.fn(async () => {}),
        };
        const createQuery = vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    result: 'rate limited',
                } as any;
            },
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'continue',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityAdapter,
            createQuery,
        } as any)).rejects.toThrow('error_during_execution: rate limited');

        expect(runtimeActivityAdapter.publishCurrent).toHaveBeenCalledWith('claude_agent_sdk_foreground_result');
        expect(runtimeActivityAdapter.handleRuntimeLoss).not.toHaveBeenCalled();
    });

    it('keeps Runtime Activity fail-closed when the Agent SDK stream fails without a terminal result', async () => {
        let didSendPrompt = false;
        const runtimeActivityAdapter = {
            activateObservation: vi.fn(async () => {}),
            observeActivity: vi.fn(async () => {}),
            publishCurrent: vi.fn(async () => {}),
            handleRuntimeLoss: vi.fn(async () => {}),
        };
        const createQuery = vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
                throw new Error('stream failed before result');
            },
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'continue',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityAdapter,
            createQuery,
        } as any)).rejects.toThrow('stream failed before result');

        expect(runtimeActivityAdapter.publishCurrent).not.toHaveBeenCalled();
        expect(runtimeActivityAdapter.handleRuntimeLoss).toHaveBeenCalledWith('claude_agent_sdk_stream_finalized');
    });

    it('keeps Runtime Activity fail-closed when terminal-result reconciliation fails', async () => {
        let didSendPrompt = false;
        const runtimeActivityAdapter = {
            activateObservation: vi.fn(async () => {}),
            observeActivity: vi.fn(async () => {}),
            publishCurrent: vi.fn(async () => { throw new Error('runtime activity publish failed'); }),
            handleRuntimeLoss: vi.fn(async () => {}),
        };
        const createQuery = vi.fn(() => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    result: 'rate limited',
                } as any;
            },
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        await expect(claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return {
                    message: 'continue',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            runtimeActivityAdapter,
            createQuery,
        } as any)).rejects.toThrow('runtime activity publish failed');

        expect(runtimeActivityAdapter.handleRuntimeLoss).toHaveBeenCalledWith('claude_agent_sdk_stream_finalized');
    });

    it('streams Agent SDK stream_event text deltas through StreamedTranscriptWriter (no synthetic partial messages)', async () => {
        const onMessage = vi.fn();
        const streamedTranscriptWriter = {
            appendAssistantDelta: vi.fn(),
            appendThinkingDelta: vi.fn(),
            overrideAssistantText: vi.fn(),
            overrideThinkingText: vi.fn(),
            flushAll: vi.fn(async () => {}),
        };

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'Hel' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_2',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'lo' },
                        },
                    } as any;
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            streamedTranscriptWriter,
            createQuery,
        } as any);

        expect(createQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                includePartialMessages: true,
            }),
        }));
        expect(onMessage.mock.calls.some(([msg]) => msg?.type === 'stream_event')).toBe(false);
        expect(streamedTranscriptWriter.appendAssistantDelta).toHaveBeenCalledWith('Hel', { sidechainId: null });
        expect(streamedTranscriptWriter.appendAssistantDelta).toHaveBeenCalledWith('lo', { sidechainId: null });
        expect(streamedTranscriptWriter.overrideAssistantText).toHaveBeenCalledWith('Hello', { sidechainId: null });
        expect(streamedTranscriptWriter.flushAll).toHaveBeenCalledWith({ reason: 'turn-end' });
    });

    it('streams Agent SDK thinking deltas and overrides the final thinking text when assembled assistant arrives', async () => {
        const onMessage = vi.fn();
        const streamedTranscriptWriter = {
            appendAssistantDelta: vi.fn(),
            appendThinkingDelta: vi.fn(),
            overrideAssistantText: vi.fn(() => true),
            overrideThinkingText: vi.fn(() => true),
            flushAll: vi.fn(async () => {}),
        };

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_t1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'thinking_delta', thinking: 'I should ' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_t2',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'thinking_delta', thinking: 'respond.' },
                        },
                    } as any;
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'thinking', thinking: 'I should respond.' },
                                { type: 'text', text: 'Done.' },
                            ],
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            streamedTranscriptWriter,
            createQuery,
        } as any);

        expect(streamedTranscriptWriter.appendThinkingDelta).toHaveBeenCalledWith('I should ', { sidechainId: null });
        expect(streamedTranscriptWriter.appendThinkingDelta).toHaveBeenCalledWith('respond.', { sidechainId: null });
        expect(streamedTranscriptWriter.overrideThinkingText).toHaveBeenCalledWith('I should respond.', { sidechainId: null });
        expect(streamedTranscriptWriter.overrideAssistantText).toHaveBeenCalledWith('Done.', { sidechainId: null });
        expect(streamedTranscriptWriter.flushAll).toHaveBeenCalledWith({ reason: 'turn-end' });
    });

    it('does not re-emit streamed assistant text after a tool boundary flushed its writer segment', async () => {
        const onMessage = vi.fn();
        let writerSegmentFlushed = false;
        const streamedTranscriptWriter = {
            appendAssistantDelta: vi.fn(),
            appendThinkingDelta: vi.fn(),
            overrideAssistantText: vi.fn(() => !writerSegmentFlushed),
            overrideThinkingText: vi.fn(() => !writerSegmentFlushed),
            flushAll: vi.fn(async ({ reason }: { reason: string }) => {
                if (reason === 'tool-call-boundary') writerSegmentFlushed = true;
            }),
        };

        const createQuery = vi.fn((_params: any) => ({
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'stream_event',
                    uuid: 'evt_text',
                    session_id: 'sess_1',
                    parent_tool_use_id: null,
                    event: {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: 'I will inspect that.' },
                    },
                } as any;
                yield {
                    type: 'stream_event',
                    uuid: 'evt_tool',
                    session_id: 'sess_1',
                    parent_tool_use_id: null,
                    event: {
                        type: 'content_block_start',
                        content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
                    },
                } as any;
                yield {
                    type: 'assistant',
                    session_id: 'sess_1',
                    parent_tool_use_id: null,
                    message: {
                        role: 'assistant',
                        content: [
                            { type: 'text', text: 'I will inspect that.' },
                            { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
                        ],
                    },
                } as any;
                yield { type: 'result' } as any;
            },
            close: vi.fn(),
            setPermissionMode: vi.fn(),
            setModel: vi.fn(),
            setMaxThinkingTokens: vi.fn(),
            supportedCommands: vi.fn(async () => []),
            supportedModels: vi.fn(async () => []),
        } as any));

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            streamedTranscriptWriter,
            createQuery,
        } as any);

        const assembledAssistant = onMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'assistant' && message?.message?.content?.some(
                (block: any) => block?.type === 'tool_use' && block?.id === 'tool_1',
            ));
        expect(assembledAssistant).toBeDefined();
        expect(assembledAssistant.message.content).toEqual([
            expect.objectContaining({ type: 'tool_use', id: 'tool_1' }),
        ]);
    });

    it('keeps assembled assistant text/thinking when no live streamed segment exists to replace them', async () => {
        const onMessage = vi.fn();
        const streamedTranscriptWriter = {
            appendAssistantDelta: vi.fn(),
            appendThinkingDelta: vi.fn(),
            overrideAssistantText: vi.fn(() => false),
            overrideThinkingText: vi.fn(() => false),
            flushAll: vi.fn(async () => {}),
        };

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'thinking', thinking: 'Reasoning' },
                                { type: 'text', text: 'Answer' },
                            ],
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            streamedTranscriptWriter,
            createQuery,
        } as any);

        expect(streamedTranscriptWriter.overrideThinkingText).toHaveBeenCalledWith('Reasoning', { sidechainId: null });
        expect(streamedTranscriptWriter.overrideAssistantText).toHaveBeenCalledWith('Answer', { sidechainId: null });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [
                    expect.objectContaining({ type: 'thinking', thinking: 'Reasoning' }),
                    expect.objectContaining({ type: 'text', text: 'Answer' }),
                ],
            }),
        }));
    });

    it('synthesizes an assistant message from stream_event text when no assembled assistant arrives and no content_block_stop is emitted', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'text', text: 'He' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'llo' },
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Hello' })],
            }),
        }));
    });

    it('does not emit a duplicate synthetic assistant when a later assembled assistant covers the buffered stream text', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'text', text: 'He' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'llo' },
                        },
                    } as any;
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Hello' }],
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const assistantMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant');

        expect(assistantMessages).toHaveLength(1);
        expect(assistantMessages[0]).toEqual(expect.objectContaining({
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Hello' })],
            }),
        }));
    });

    it('flushes a streamed assistant reply when the Agent SDK ends the message without a content_block_stop event', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'Hel' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_2',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'lo' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_message_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'message_stop',
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Hello' })],
            }),
        }));
    });

    it('falls back to the result text when Claude never emits an assembled assistant message or text stream deltas', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_t1',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'thinking_delta', thinking: 'Let me think.' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_message_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'message_stop',
                        },
                    } as any;
                    yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'Final fallback answer',
                    } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Final fallback answer' })],
            }),
        }));
    });

    it('flushes any buffered stream text before shutdown when the iterator ends without a terminal boundary', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'text', text: 'Hel' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'lo' },
                        },
                    } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'text', text: 'Hello' })],
            }),
        }));
    });

    it('keeps buffered stream-event assistant messages isolated per sidechain when stream events interleave', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'text', text: 'Main ' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_sidechain_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_1',
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'text', text: 'Sidechain ' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'reply' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_sidechain_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_1',
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'reply' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'message_stop',
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_sidechain_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_1',
                        event: {
                            type: 'message_stop',
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const assistantMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant');

        expect(assistantMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                parent_tool_use_id: null,
                message: expect.objectContaining({
                    content: [expect.objectContaining({ type: 'text', text: 'Main reply' })],
                }),
            }),
            expect.objectContaining({
                parent_tool_use_id: 'tool_1',
                message: expect.objectContaining({
                    content: [expect.objectContaining({ type: 'text', text: 'Sidechain reply' })],
                }),
            }),
        ]));
    });

    it('reconstructs tool_use blocks from stream_event tool deltas so tool trace is not lost', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_stop',
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.type === 'stream_event')).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            uuid: 'toolu_1',
            message: expect.objectContaining({
                model: 'claude-3',
                content: [expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: 'Bash' })],
            }),
        }));
    });

    it('keeps streamed tool_use reconstruction isolated per sidechain when tool stream events interleave', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_main', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"pwd\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: ' tool_parent_1\n',
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_side', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: ' tool_parent_1\n',
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"ls\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_alias_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_alias', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_alias_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo alias\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: ' tool_parent_1\n',
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_alias_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use'));

        expect(toolUseMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                parent_tool_use_id: null,
                uuid: 'toolu_main',
                message: expect.objectContaining({
                    content: [expect.objectContaining({
                        type: 'tool_use',
                        id: 'toolu_main',
                        name: 'Bash',
                        input: { command: 'pwd' },
                    })],
                }),
            }),
            expect.objectContaining({
                parent_tool_use_id: ' tool_parent_1\n',
                uuid: 'toolu_side',
                message: expect.objectContaining({
                    content: [expect.objectContaining({
                        type: 'tool_use',
                        id: 'toolu_side',
                        name: 'Bash',
                        input: { command: 'ls' },
                    })],
                }),
            }),
            expect.objectContaining({
                parent_tool_use_id: 'tool_parent_1',
                uuid: 'toolu_alias',
                message: expect.objectContaining({
                    content: [expect.objectContaining({
                        type: 'tool_use',
                        id: 'toolu_alias',
                        name: 'Bash',
                        input: { command: 'echo alias' },
                    })],
                }),
            }),
        ]));
    });

    it('normalizes Claude Agent Teams tool_use names while reconstructing tool_use blocks from stream_event', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'TeamCreate', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.type === 'stream_event')).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: 'AgentTeamCreate' })],
            }),
        }));
    });

    it('does not emit duplicate tool_use when the assembled SDK assistant message also includes the same tool_use block', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Some Agent SDK versions emit the assembled assistant message containing tool_use
                    // in addition to the raw stream events.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
                    } as any;

                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('does not emit duplicate tool_use when system/status messages interleave before the assembled assistant tool_use message', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Interleaving system messages can appear before the assembled assistant message.
                    yield {
                        type: 'system',
                        subtype: 'status',
                        session_id: 'sess_1',
                        uuid: 'sys_1',
                    } as any;

                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
                    } as any;

                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('does not emit duplicate tool_use when stream events for a tool_use arrive after the assembled assistant tool_use message', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    // Assembled assistant tool_use arrives first.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
                        },
                    } as any;

                    // Late stream events for the same tool_use should not cause a synthetic duplicate.
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1'));

        expect(toolUseMessages).toHaveLength(1);
    });

    it('strips duplicate tool_use blocks from later assistant messages that also include non-tool content', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    // Tool use arrives as raw stream events only (so we synthesize a tool_use message).
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo hi\"}' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_tool_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;

                    // Tool result is delivered as an assembled user message. This forces the synthetic tool_use flush.
                    yield {
                        type: 'user',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'user',
                            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'OK', is_error: false }],
                        },
                    } as any;

                    // Some Agent SDK versions can later emit an assistant message that contains both text and a tool_use
                    // block we've already emitted. The duplicate tool_use must be stripped while preserving the text.
                    yield {
                        type: 'assistant',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'text', text: 'Ran tool.' },
                                { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
                            ],
                        },
                    } as any;

                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolUseBlocksSeen = onMessage.mock.calls
            .map(([msg]) => msg)
            .flatMap((msg) => (Array.isArray(msg?.message?.content) ? msg.message.content : []))
            .filter((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1');

        expect(toolUseBlocksSeen).toHaveLength(1);

        const laterAssistant = onMessage.mock.calls
            .map(([msg]) => msg)
            .find((msg) => msg?.type === 'assistant' && Array.isArray(msg?.message?.content) && msg.message.content.some((c: any) => c?.type === 'text'));

        expect(laterAssistant).toBeTruthy();
        expect(laterAssistant.message.content.some((c: any) => c?.type === 'tool_use' && c?.id === 'toolu_1')).toBe(false);
        expect(laterAssistant.message.content.some((c: any) => c?.type === 'text' && c?.text === 'Ran tool.')).toBe(true);
    });

    it('reconstructs tool_result blocks from stream_event deltas so tool trace is not lost', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_result', tool_use_id: 'toolu_1' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'OK' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_stop',
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.some(([msg]) => msg?.happierPartial === true)).toBe(false);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
                content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_1' })],
            }),
        }));
    });

    it('captures initial tool_result content from content_block_start when no text_delta events are emitted', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Spawned successfully.\nagent_id: Alpha@team\n' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_stop',
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolResult = onMessage.mock.calls
            .map(([msg]) => msg)
            .find((msg) => msg?.type === 'user' && Array.isArray((msg as any)?.message?.content) && (msg as any).message.content.some((c: any) => c?.type === 'tool_result'));
        expect(toolResult).toBeTruthy();
        const block = (toolResult as any).message.content.find((c: any) => c?.type === 'tool_result' && c?.tool_use_id === 'toolu_1');
        expect(block?.content).toContain('Spawned successfully');
        expect(block?.content).toContain('agent_id:');
    });

    it('keeps streamed tool_result reconstruction isolated per sidechain when tool result stream events interleave', async () => {
        const onMessage = vi.fn();

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_result', tool_use_id: 'toolu_main' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'PWD' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_start',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: {
                            type: 'content_block_start',
                            content_block: { type: 'tool_result', tool_use_id: 'toolu_side' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_delta',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'LS' },
                        },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_main_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: null,
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_side_stop',
                        session_id: 'sess_1',
                        parent_tool_use_id: 'tool_parent_1',
                        event: { type: 'content_block_stop' },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        const toolResultMessages = onMessage.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'user' && Array.isArray(msg?.message?.content))
            .filter((msg) => msg.message.content.some((c: any) => c?.type === 'tool_result'));

        expect(toolResultMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                parent_tool_use_id: null,
                uuid: 'toolu_main',
                message: expect.objectContaining({
                    content: [expect.objectContaining({
                        type: 'tool_result',
                        tool_use_id: 'toolu_main',
                        content: 'PWD',
                    })],
                }),
            }),
            expect.objectContaining({
                parent_tool_use_id: 'tool_parent_1',
                uuid: 'toolu_side',
                message: expect.objectContaining({
                    content: [expect.objectContaining({
                        type: 'tool_result',
                        tool_use_id: 'toolu_side',
                        content: 'LS',
                    })],
                }),
            }),
        ]));
    });

    it('allows standalone /compact session init to finish so queued prompts keep flowing without waiting for stop', async () => {
        const onReady = vi.fn();
        const onSessionFound = vi.fn();

        let releaseStream!: () => void;
        const streamClosed = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'system',
                        subtype: 'init',
                        session_id: 'sess_compacted_2',
                    } as any;
                    await streamClosed;
                },
                close: vi.fn(() => {
                    releaseStream();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (!didSendFirst) {
                didSendFirst = true;
                return {
                    message: '/compact',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            }

            return {
                message: 'follow-up after compaction',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            };
        });

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound,
            onMessage: () => {},
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            await vi.waitFor(() => {
                // One additional long-lived wait arms exact active-turn actions; it does not
                // send the ordinary follow-up before the compact boundary releases the turn.
                expect(nextMessage).toHaveBeenCalledTimes(3);
            });
            expect(onSessionFound).toHaveBeenCalledWith('sess_compacted_2', expect.anything());
        } finally {
            releaseStream();
            await runnerPromise.catch(() => {});
        }
    });

    it('does not let stream_event-only next-turn output keep the result-finalize guard stuck after compaction (queued prompts keep flowing)', async () => {
        const onReady = vi.fn();

        let releaseStream!: () => void;
        const streamClosed = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    // Standalone /compact can finish without a normal result, then the next queued
                    // prompt may emit stream_event output before an assembled assistant message.
                    yield {
                        type: 'system',
                        subtype: 'init',
                        session_id: 'sess_compacted_2',
                    } as any;

                    // Next turn starts emitting assistant output as stream events only (no assembled
                    // assistant message), then ends with a result message.
                    yield {
                        type: 'stream_event',
                        uuid: 'evt_text_1',
                        session_id: 'sess_compacted_2',
                        parent_tool_use_id: null,
                        event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'ok' },
                        },
                    } as any;
                    yield { type: 'result' } as any;

                    await streamClosed;
                },
                close: vi.fn(() => {
                    releaseStream();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let call = 0;
        const nextMessage = vi.fn(async () => {
            call++;
            if (call === 1) {
                return { message: '/compact', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            if (call === 2) {
                return { message: 'follow-up after compaction', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            if (call === 3) {
                return { message: 'third queued prompt', mode: makeMode({ claudeRemoteAgentSdkEnabled: true }) };
            }
            return null;
        });

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
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
                expect(nextMessage).toHaveBeenCalledTimes(4);
            });
            expect(onReady).toHaveBeenCalled();
        } finally {
            releaseStream();
            await runnerPromise.catch(() => {});
        }
    });

    it('keeps AskUserQuestion work active after provider auto compact_boundary', async () => {
        const onReady = vi.fn();
        const onSessionFound = vi.fn();
        const onCompletionEvent = vi.fn();
        const onThinkingChange = vi.fn();
        const onMessage = vi.fn();

        let releaseStream!: () => void;
        const streamClosed = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'system',
                        subtype: 'compact_boundary',
                        session_id: 'sess_compacted_boundary_2',
                        compact_metadata: {
                            trigger: 'auto',
                            pre_tokens: 175_000,
                        },
                    } as any;
                    yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id: 'sess_compacted_boundary_2',
                        uuid: 'assistant_after_compact_question',
                        message: {
                            id: 'msg_after_compact_question',
                            type: 'message',
                            role: 'assistant',
                            model: 'fake-claude',
                            content: [{
                                type: 'tool_use',
                                id: 'toolu_question_after_compact',
                                name: 'AskUserQuestion',
                                input: { questions: [{ question: 'Continue?', options: [] }] },
                            }],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 1, output_tokens: 1 },
                        },
                    } as any;
                    await streamClosed;
                },
                close: vi.fn(() => {
                    releaseStream();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        const nextMessage = vi.fn(async () => ({
            message: 'long-running prompt that auto-compacts',
            mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
        }));

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound,
            onMessage,
            onCompletionEvent,
            onThinkingChange,
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'context-compaction',
                    phase: 'completed',
                }));
            });
            expect(onSessionFound).toHaveBeenCalledWith('sess_compacted_boundary_2', expect.objectContaining({
                source: 'compact',
            }));
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'context-compaction',
                phase: 'completed',
                provider: 'claude',
                source: 'provider-event',
                trigger: 'auto',
                providerSessionId: 'sess_compacted_boundary_2',
                tokenCountBefore: 175_000,
                tokenCountSource: 'claude-compact-metadata.pre_tokens',
                lifecycleId: expect.any(String),
            }));
            expect(onReady).not.toHaveBeenCalled();
            expect(nextMessage).toHaveBeenCalledTimes(2);
            expect(onThinkingChange.mock.calls.map((call) => call[0])).toEqual([true]);
            expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'assistant',
                message: expect.objectContaining({
                    content: expect.arrayContaining([
                        expect.objectContaining({
                            type: 'tool_use',
                            name: 'AskUserQuestion',
                        }),
                    ]),
                }),
            }));
        } finally {
            releaseStream();
            await runnerPromise.catch(() => {});
        }
    });

    it('derives replayed compact_boundary lifecycle identity from the raw boundary evidence', async () => {
        const firstBoundary = {
            type: 'system',
            subtype: 'compact_boundary',
            session_id: 'sess_replayed_compaction',
            uuid: 'f93ad896-fae2-4eb4-82ce-03d4b7ce356e',
            timestamp: '2026-07-07T14:42:06.029Z',
        };
        const replayedBoundary = {
            type: 'system',
            subtype: 'compact_boundary',
            session_id: 'sess_replayed_compaction',
            uuid: 'e11e1611-a694-4a9d-9ebc-8e7d882fff91',
            timestamp: '2026-07-07T14:56:33.493Z',
        };

        const firstRunEvents = await runAgentSdkStreamForCompactionEvents([
            firstBoundary,
            replayedBoundary,
            { type: 'result' },
        ]);
        const replayRunEvents = await runAgentSdkStreamForCompactionEvents([
            replayedBoundary,
            { type: 'result' },
        ]);

        expect(firstRunEvents).toHaveLength(2);
        expect(replayRunEvents).toHaveLength(1);
        expect(firstRunEvents[1]).toMatchObject({
            phase: 'completed',
            providerEventId: 'claude:context-compaction:boundary:session:sess_replayed_compaction:uuid:e11e1611-a694-4a9d-9ebc-8e7d882fff91:timestamp:2026-07-07T14%3A56%3A33.493Z',
            lifecycleId: 'claude:context-compaction:boundary:session:sess_replayed_compaction:uuid:e11e1611-a694-4a9d-9ebc-8e7d882fff91:timestamp:2026-07-07T14%3A56%3A33.493Z',
        });
        expect(replayRunEvents[0]).toMatchObject({
            providerEventId: firstRunEvents[1]?.providerEventId,
            lifecycleId: firstRunEvents[1]?.lifecycleId,
        });
    });

    it('does not infer compaction completion from an isCompactSummary resume row alone', async () => {
        const compactionEvents = await runAgentSdkStreamForCompactionEvents([
            {
                type: 'user',
                isCompactSummary: true,
                parentUuid: 'e11e1611-a694-4a9d-9ebc-8e7d882fff91',
                timestamp: '2026-07-07T14:56:33.492Z',
                message: {
                    role: 'user',
                    content: 'Compaction summary',
                },
            },
            { type: 'result' },
        ]);

        expect(compactionEvents).toEqual([]);
    });

    it('does not collapse multiple compact_boundary events when boundary-specific evidence is missing', async () => {
        const compactionEvents = await runAgentSdkStreamForCompactionEvents([
            {
                type: 'system',
                subtype: 'compact_boundary',
                session_id: 'sess_without_boundary_uuid',
            },
            {
                type: 'system',
                subtype: 'compact_boundary',
                session_id: 'sess_without_boundary_uuid',
            },
            { type: 'result' },
        ]);

        expect(compactionEvents).toHaveLength(2);
        expect(compactionEvents[0]?.providerEventId).toBeUndefined();
        expect(compactionEvents[1]?.providerEventId).toBeUndefined();
        expect(compactionEvents[0]?.lifecycleId).toBe('claude:context-compaction:sess_without_boundary_uuid:1');
        expect(compactionEvents[1]?.lifecycleId).toBe('claude:context-compaction:sess_without_boundary_uuid:2');
    });

    it('allows standalone /compact compact_boundary to finish before pumping queued prompts', async () => {
        const onReady = vi.fn();
        const onSessionFound = vi.fn();
        const onCompletionEvent = vi.fn();
        const onThinkingChange = vi.fn();

        let releaseStream!: () => void;
        const streamClosed = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'system',
                        subtype: 'compact_boundary',
                        session_id: 'sess_manual_compacted_boundary_2',
                        compact_metadata: {
                            trigger: 'manual',
                            pre_tokens: 175_000,
                        },
                    } as any;
                    await streamClosed;
                },
                close: vi.fn(() => {
                    releaseStream();
                }),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        let didSendFirst = false;
        const nextMessage = vi.fn(async () => {
            if (!didSendFirst) {
                didSendFirst = true;
                return {
                    message: '/compact',
                    mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
                };
            }

            return {
                message: 'follow-up after compact boundary',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true }),
            };
        });

        const runnerPromise = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage,
            onReady,
            onSessionFound,
            onMessage: () => {},
            onCompletionEvent,
            onThinkingChange,
            createQuery,
        } as any);

        try {
            await vi.waitFor(() => {
                expect(onReady).toHaveBeenCalledTimes(1);
            });
            await vi.waitFor(() => {
                expect(nextMessage).toHaveBeenCalledTimes(3);
            });
            expect(onSessionFound).toHaveBeenCalledWith('sess_manual_compacted_boundary_2', expect.anything());
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'context-compaction',
                phase: 'started',
                provider: 'claude',
                source: 'user-command',
                trigger: 'manual',
                lifecycleId: expect.any(String),
            }));
            expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'context-compaction',
                phase: 'completed',
                provider: 'claude',
                source: 'provider-event',
                trigger: 'manual',
                providerSessionId: 'sess_manual_compacted_boundary_2',
                tokenCountBefore: 175_000,
                tokenCountSource: 'claude-compact-metadata.pre_tokens',
                lifecycleId: onCompletionEvent.mock.calls[0]?.[0]?.lifecycleId,
            }));
            expect(onThinkingChange.mock.calls.map((call) => call[0]).slice(0, 2)).toEqual([true, false]);
        } finally {
            releaseStream();
            await runnerPromise.catch(() => {});
        }
    });

    it('does not surface Claude compact hook stdout as transcript content', async () => {
        const onMessage = vi.fn();
        const compactHookStdout = [
            '<local-command-stdout>Compacted PreCompact [/Users/leeroy/.vibe-island/bin/vibe-island-bridge --source claude] completed successfully',
            "PreCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully",
            "PostCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully</local-command-stdout>",
        ].join('\n');

        const createQuery = vi.fn((_params: any) => {
            return {
                async *[Symbol.asyncIterator]() {
                    yield {
                        type: 'assistant',
                        uuid: 'hook_stdout',
                        session_id: 'sess_compact_hooks',
                        message: {
                            role: 'assistant',
                            model: 'claude-sonnet',
                            content: [{ type: 'text', text: compactHookStdout }],
                        },
                    } as any;
                    yield { type: 'result' } as any;
                },
                close: vi.fn(),
                setPermissionMode: vi.fn(),
                setModel: vi.fn(),
                setMaxThinkingTokens: vi.fn(),
                supportedCommands: vi.fn(async () => []),
                supportedModels: vi.fn(async () => []),
            } as any;
        });

        await claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => ({
                message: 'hello',
                mode: makeMode({ claudeRemoteAgentSdkEnabled: true, model: 'claude-3' } as any),
            }),
            onReady: () => {},
            onSessionFound: () => {},
            onMessage,
            createQuery,
        } as any);

        expect(onMessage.mock.calls.map(([message]) => JSON.stringify(message)).join('\n')).not.toContain('<local-command-stdout>');
        expect(onMessage.mock.calls.map(([message]) => JSON.stringify(message)).join('\n')).not.toContain('PreCompact');
    });
});
