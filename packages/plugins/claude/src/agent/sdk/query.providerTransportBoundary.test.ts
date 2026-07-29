import { describe, expect, it, vi } from 'vitest';

import {
    query,
    type ClaudeSdkExecClientHandle,
    type ClaudeSdkJsonStreamClient,
    type ClaudeSdkJsonStreamWriteOutcome,
} from './query.js';
import type { SDKMessage } from './types.js';

type PromptTransportOutcome =
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'rejected_before_effect'; error: Error }>
    | Readonly<{ kind: 'effect_may_have_occurred'; error: Error }>;

type ProcessExit = Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}>;

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function createControlledTransport() {
    const write = deferred<ClaudeSdkJsonStreamWriteOutcome>();
    const writeStarted = deferred<unknown>();
    const exit = new Promise<ProcessExit>(() => undefined);
    let subscriber: ((record: unknown) => void | Promise<void>) | null = null;
    const client: ClaudeSdkJsonStreamClient = {
        closed: new Promise(() => undefined),
        subscribe(listener) {
            subscriber = listener;
            return () => {
                subscriber = null;
            };
        },
        async writeRecord(record) {
            writeStarted.resolve(record);
            return await write.promise;
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
    const spawnClient = vi.fn(async () => handle);
    const ctx = {
        agentRuntime: { exec: { spawnClient } },
    } satisfies Parameters<typeof query>[0];
    return {
        ctx,
        spawnClient,
        write,
        writeStarted,
        async emit(record: unknown) {
            await subscriber?.(record);
        },
    };
}

function exactPrompt(onPumpComplete?: () => void): AsyncIterable<SDKMessage> {
    return {
        async *[Symbol.asyncIterator]() {
            yield {
                type: 'user',
                message: { role: 'user', content: 'exact queued prompt' },
            } satisfies SDKMessage;
            onPumpComplete?.();
        },
    };
}

function readPromptTransportOutcome(sdkQuery: unknown): Promise<PromptTransportOutcome> {
    if (
        !sdkQuery
        || typeof sdkQuery !== 'object'
        || !('promptTransportOutcome' in sdkQuery)
    ) {
        throw new Error('Claude SDK query did not expose its exact prompt transport outcome.');
    }
    return (sdkQuery as Readonly<{ promptTransportOutcome: Promise<PromptTransportOutcome> }>)
        .promptTransportOutcome;
}

describe('Claude plugin SDK provider transport boundary', () => {
    it('sends the provider-native stop_task control request for an exact background task', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: 'keep the stream open' });
        const stopTask = (sdkQuery as unknown as { stopTask?: (taskId: string) => Promise<void> }).stopTask;

        expect(stopTask).toBeTypeOf('function');
        const stopped = stopTask?.call(sdkQuery, 'task-1');
        await expect(transport.writeStarted.promise).resolves.toEqual({
            type: 'control_request',
            request_id: 'claude-sdk-control-1',
            request: { subtype: 'stop_task', task_id: 'task-1' },
        });
        transport.write.resolve({ kind: 'written' });
        await transport.emit({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'claude-sdk-control-1',
                response: {},
            },
        });
        await stopped;
        await sdkQuery.dispose();
    });

    it('publishes exact acceptance only after client.writeRecord completes', async () => {
        const transport = createControlledTransport();
        const pumpCompleted = deferred<void>();
        const sdkQuery = query(transport.ctx, {
            prompt: exactPrompt(() => pumpCompleted.resolve()),
        });
        const transportOutcome = readPromptTransportOutcome(sdkQuery);
        let didSettleTransportOutcome = false;
        void transportOutcome.then(() => {
            didSettleTransportOutcome = true;
        });
        const attemptedRecord = await transport.writeStarted.promise;

        expect(attemptedRecord).toEqual({
            type: 'user',
            message: { role: 'user', content: 'exact queued prompt' },
        });
        await Promise.resolve();
        expect(didSettleTransportOutcome).toBe(false);

        transport.write.resolve({ kind: 'written' });
        await pumpCompleted.promise;
        await expect(transportOutcome).resolves.toEqual({ kind: 'accepted' });
        await sdkQuery.dispose();
    });

    it('rejects before effect when process creation fails before writeRecord is attempted', async () => {
        const spawnFailure = new Error('process creation failed before prompt transport');
        const spawnClient = vi.fn(async () => {
            throw spawnFailure;
        });
        const ctx = {
            agentRuntime: { exec: { spawnClient } },
        } satisfies Parameters<typeof query>[0];

        const sdkQuery = query(ctx, { prompt: exactPrompt() });

        await expect(readPromptTransportOutcome(sdkQuery)).resolves.toMatchObject({
            kind: 'rejected_before_effect',
            error: spawnFailure,
        });
        await expect(sdkQuery.next()).rejects.toThrow('process creation failed before prompt transport');
        expect(spawnClient).toHaveBeenCalledOnce();
    });

    it('rejects before effect when cancellation wins before writeRecord is attempted', async () => {
        const transport = createControlledTransport();
        const controller = new AbortController();
        const iterationStarted = deferred<void>();
        const releasePrompt = deferred<void>();
        const prompt: AsyncIterable<SDKMessage> = {
            async *[Symbol.asyncIterator]() {
                iterationStarted.resolve();
                await releasePrompt.promise;
                yield {
                    type: 'user',
                    message: { role: 'user', content: 'cancelled queued prompt' },
                };
            },
        };
        const sdkQuery = query(transport.ctx, {
            prompt,
            options: { abort: controller.signal },
        });
        let outcome: PromptTransportOutcome | null = null;
        void readPromptTransportOutcome(sdkQuery).then((value) => {
            outcome = value;
        });
        await iterationStarted.promise;

        const cancellation = new Error('cancelled before prompt transport');
        controller.abort(cancellation);
        await Promise.resolve();

        expect(outcome).toMatchObject({
            kind: 'rejected_before_effect',
            error: cancellation,
        });
        releasePrompt.resolve();
        await sdkQuery.dispose();
    });

    it('rejects before effect when the host rejects the record before the process write', async () => {
        const preWriteFailure = new Error('record exceeded the host frame limit');
        const transport = createControlledTransport();
        transport.write.resolve({
            kind: 'rejected_before_write',
            error: preWriteFailure,
        });
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        const nextMessage = sdkQuery.next();

        await expect(readPromptTransportOutcome(sdkQuery)).resolves.toEqual({
            kind: 'rejected_before_effect',
            error: preWriteFailure,
        });
        await expect(nextMessage).rejects.toThrow('record exceeded the host frame limit');
        await sdkQuery.dispose();
    });

    it('does not report successful handoff when writeRecord was attempted but completion is ambiguous', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        const nextMessage = sdkQuery.next();
        const attemptedRecord = await transport.writeStarted.promise;

        transport.write.resolve({
            kind: 'write_may_have_occurred',
            error: new Error('write completion lost after transport attempt'),
        });

        await expect(readPromptTransportOutcome(sdkQuery)).resolves.toMatchObject({
            kind: 'effect_may_have_occurred',
            error: expect.objectContaining({
                message: 'write completion lost after transport attempt',
            }),
        });
        await expect(nextMessage).rejects.toThrow('write completion lost after transport attempt');
        expect(attemptedRecord).toEqual({
            type: 'user',
            message: { role: 'user', content: 'exact queued prompt' },
        });
        await sdkQuery.dispose();
    });
});
