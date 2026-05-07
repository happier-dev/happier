import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

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

describe('claudeRemoteAgentSdk subagent turn completion', () => {
    it('keeps the parent turn in flight when a subagent task_notification completes', async () => {
        const holdOpen = createHoldOpen();
        const callOrder: string[] = [];
        const onReady = vi.fn(() => callOrder.push('ready'));
        const onSubagentFlush = vi.fn(() => callOrder.push('subagentFlush'));
        const thinkingEvents: boolean[] = [];

        const createQuery = createQueryFromEvents([
            { type: 'system', subtype: 'task_started', task_id: 'task_1' },
            { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'completed' },
        ], holdOpen.promise);

        const runnerPromise = claudeRemoteAgentSdk({
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
        const onSubagentFlush = vi.fn(() => callOrder.push('subagentFlush'));

        await claudeRemoteAgentSdk({
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

        await claudeRemoteAgentSdk({
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

        const runnerPromise = claudeRemoteAgentSdk({
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
