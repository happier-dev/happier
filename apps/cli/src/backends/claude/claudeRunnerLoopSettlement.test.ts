import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { fatal: vi.fn(), debug: vi.fn() },
}));

import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { settleClaudeRunnerLoop } from './claudeRunnerLoopSettlement';

function startRunner() {
    const fakeProcess = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const loopAbort = new AbortController();
    let terminationRequested = false;
    const loop = new Promise<number>((resolve) => {
        loopAbort.signal.addEventListener('abort', () => resolve(0), { once: true });
    });
    const handlers = registerRunnerTerminationHandlers({
        process: fakeProcess,
        exit,
        onTerminationRequested: () => {
            terminationRequested = true;
        },
        // Real runner cleanup aborts the provider loop and awaits it before tearing down.
        onTerminate: async () => {
            loopAbort.abort();
            await loop;
        },
    });
    const settlement = settleClaudeRunnerLoop(loop, {
        isRequested: () => terminationRequested,
        whenTerminated: handlers.whenTerminated,
    });
    return { fakeProcess, exit, loopAbort, handlers, settlement };
}

describe('settleClaudeRunnerLoop', () => {
    it.each(['crash', 'stop'] as const)('yields a late %s during normal cleanup to the termination owner', async (kind) => {
        const fakeProcess = new EventEmitter();
        const exit = vi.fn<(code: number) => void>();
        let terminationRequested = false;
        let finishTransportClose = () => {};
        const transportClose = vi.fn(() => new Promise<void>((resolve) => { finishTransportClose = resolve; }));
        let cleanupPromise: Promise<void> | null = null;
        const cleanupOnce = () => cleanupPromise ??= transportClose();
        const handlers = registerRunnerTerminationHandlers({
            process: fakeProcess,
            exit,
            onTerminationRequested: () => { terminationRequested = true; },
            onTerminate: cleanupOnce,
        });
        try {
            const settlement = settleClaudeRunnerLoop(Promise.resolve(0), {
                isRequested: () => terminationRequested,
                whenTerminated: handlers.whenTerminated,
            }, cleanupOnce);
            // Let ordinary loop completion reach its asynchronous transport cleanup.
            await Promise.resolve();
            await Promise.resolve();
            if (kind === 'crash') fakeProcess.emit('uncaughtException', new Error('late crash'));
            else handlers.requestTermination({ kind: 'killSession' });
            await Promise.resolve();
            finishTransportClose();

            await expect(settlement).resolves.toEqual({ kind: 'terminated' });
            expect(transportClose).toHaveBeenCalledTimes(1);
            expect(exit.mock.calls).toEqual([[kind === 'crash' ? 1 : 0]]);
        } finally {
            finishTransportClose();
            handlers.dispose();
        }
    });

    it('preserves an ordinary loop failure after normal cleanup', async () => {
        const error = new Error('provider failed');
        const closeTransport = vi.fn(async () => {});
        await expect(settleClaudeRunnerLoop(Promise.reject(error), {
            isRequested: () => false,
            whenTerminated: new Promise(() => {}),
        }, closeTransport)).resolves.toEqual({ kind: 'failed', error });
        expect(closeTransport).toHaveBeenCalledTimes(1);
    });

    it('propagates ordinary cleanup failure', async () => {
        const error = new Error('transport close failed');
        await expect(settleClaudeRunnerLoop(Promise.resolve(0), {
            isRequested: () => false,
            whenTerminated: new Promise(() => {}),
        }, async () => { throw error; })).rejects.toBe(error);
    });

    it('yields a termination-driven loop exit to the termination owner and its exit code', async () => {
        const runner = startRunner();
        try {
            runner.fakeProcess.emit('uncaughtException', new Error('boom'));

            await expect(runner.settlement).resolves.toEqual({ kind: 'terminated' });
            expect(runner.exit).toHaveBeenCalledTimes(1);
            expect(runner.exit).toHaveBeenCalledWith(1);
        } finally {
            runner.handlers.dispose();
        }
    });

    it('returns an ordinary loop exit to the runner without termination', async () => {
        const runner = startRunner();
        try {
            runner.loopAbort.abort();

            await expect(runner.settlement).resolves.toEqual({ kind: 'completed', value: 0 });
            expect(runner.exit).not.toHaveBeenCalled();
        } finally {
            runner.handlers.dispose();
        }
    });
});
