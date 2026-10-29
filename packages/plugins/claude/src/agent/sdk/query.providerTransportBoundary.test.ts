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
    const exit = deferred<ProcessExit>();
    const records: unknown[] = [];
    let nextWriteOutcome: ClaudeSdkJsonStreamWriteOutcome | null = null;
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
            records.push(record);
            writeStarted.resolve(record);
            if (nextWriteOutcome) {
                const outcome = nextWriteOutcome;
                nextWriteOutcome = null;
                return outcome;
            }
            return await write.promise;
        },
    };
    const handle: ClaudeSdkExecClientHandle = {
        client,
        process: {
            exit: exit.promise,
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
        records,
        rejectNextWrite(error: Error) { nextWriteOutcome = { kind: 'rejected_before_write', error }; },
        exit,
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
                uuid: 'initial-prompt',
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
    it.each(['single', 'batch'] as const)('accepts an attributed result without a replay echo and preserves its output (%s)', async attribution => {
        const transport = createControlledTransport();
        const onMessageReceived = vi.fn();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt(), onMessageReceived });
        let outcome: PromptTransportOutcome | undefined;
        void sdkQuery.promptTransportOutcome.then(value => { outcome = value; });
        try {
            await transport.writeStarted.promise;
            const result = { type: 'result', subtype: 'success', queued_turn_count: 1, result: 'Answered input',
                ...(attribution === 'single' ? { user_message_uuid: 'initial-prompt' } : { user_message_uuids: ['initial-prompt'] }) };
            for (const invalid of [
                { ...result, parent_tool_use_id: 'child' },
                { ...result, isSynthetic: true },
            ]) {
                await transport.emit(invalid);
                await sdkQuery.next();
            }
            expect(outcome).toBeUndefined();
            await transport.emit(result);
            await expect(sdkQuery.next()).resolves.toEqual({ done: false, value: result });
            expect(outcome).toEqual({ kind: 'accepted' });
            expect(onMessageReceived).toHaveBeenCalledWith(result);
        } finally {
            transport.write.resolve({ kind: 'written' });
            await sdkQuery.dispose();
        }
    });

    it.each([
        { user_message_uuid: ' initial-prompt ', user_message_uuids: [' initial-prompt '] },
        { user_message_uuid: 'initial-prompt', user_message_uuids: [] },
    ])('requires exact result IDs and honors an authoritative plural list (%j)', async attribution => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        let outcome: PromptTransportOutcome | undefined;
        void sdkQuery.promptTransportOutcome.then(value => { outcome = value; });
        try {
            await transport.writeStarted.promise;
            await transport.emit({ type: 'result', subtype: 'success', ...attribution });
            await sdkQuery.next();
            expect(outcome).toBeUndefined();
            await transport.emit({ type: 'result', subtype: 'success', user_message_uuid: 'initial-prompt' });
            await expect(sdkQuery.promptTransportOutcome).resolves.toEqual({ kind: 'accepted' });
        } finally {
            transport.write.resolve({ kind: 'written' });
            await sdkQuery.dispose();
        }
    });

    it('retains only unanswered submissions across out-of-order, duplicate, and buffered results', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        try {
            await transport.writeStarted.promise;
            transport.write.resolve({ kind: 'written' });
            await transport.emit({ type: 'user', uuid: 'initial-prompt' });
            await sdkQuery.promptTransportOutcome;
            const steer = sdkQuery.sendUserMessage('steer', 'steer-prompt');
            await new Promise<void>(resolve => setImmediate(resolve));
            await transport.emit({ type: 'user', uuid: 'steer-prompt' });
            await steer;
            const earlier = { type: 'result', subtype: 'success', user_message_uuid: 'initial-prompt', queued_turn_count: 0 };
            const latest = { type: 'result', subtype: 'success', user_message_uuids: ['steer-prompt'], queued_turn_count: 1 };
            // Native ingress may read ahead of the ordered runtime result consumer.
            await transport.emit(earlier);
            await transport.emit(latest);
            expect(sdkQuery.shouldRetainForegroundForResult(earlier)).toBe(true);
            expect(sdkQuery.shouldRetainForegroundForResult(earlier)).toBe(true);
            expect(sdkQuery.shouldRetainForegroundForResult(latest)).toBe(false);
            const next = sdkQuery.sendUserMessage('next turn', 'next-prompt');
            await new Promise<void>(resolve => setImmediate(resolve));
            await transport.emit({ type: 'user', uuid: 'next-prompt' });
            await next;
            expect(sdkQuery.shouldRetainForegroundForResult(latest)).toBe(true);
            expect(sdkQuery.shouldRetainForegroundForResult({ ...latest, user_message_uuids: ['next-prompt'] })).toBe(false);
        } finally {
            await sdkQuery.dispose();
        }
    });

    it('uses an empty queue to retire omitted older result IDs only after the latest submission was answered', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        try {
            await transport.writeStarted.promise;
            transport.write.resolve({ kind: 'written' });
            await transport.emit({ type: 'user', uuid: 'initial-prompt' });
            await sdkQuery.promptTransportOutcome;
            const steer = sdkQuery.sendUserMessage('latest', 'latest-prompt');
            await new Promise<void>(resolve => setImmediate(resolve));
            await transport.emit({ type: 'user', uuid: 'latest-prompt' });
            await steer;
            expect(sdkQuery.shouldRetainForegroundForResult({ type: 'result', user_message_uuid: 'latest-prompt', queued_turn_count: 1 })).toBe(true);
            expect(sdkQuery.shouldRetainForegroundForResult({ type: 'result', user_message_uuid: 'unrelated', queued_turn_count: 0 })).toBe(false);
        } finally {
            await sdkQuery.dispose();
        }
    });

    it('removes a definitely unwritten steer without losing the prior latest submitted prompt', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        try {
            await transport.writeStarted.promise;
            transport.write.resolve({ kind: 'written' });
            await transport.emit({ type: 'user', uuid: 'initial-prompt' });
            await sdkQuery.promptTransportOutcome;
            const firstSteer = sdkQuery.sendUserMessage('latest accepted', 'accepted-steer');
            await new Promise<void>(resolve => setImmediate(resolve));
            await transport.emit({ type: 'user', uuid: 'accepted-steer' });
            await firstSteer;
            expect(sdkQuery.shouldRetainForegroundForResult({ type: 'result', user_message_uuid: 'accepted-steer', queued_turn_count: 1 })).toBe(true);
            transport.rejectNextWrite(new Error('frame rejected before write'));
            await expect(sdkQuery.sendUserMessage('rejected', 'rejected-steer')).resolves.toMatchObject({ kind: 'rejected_before_effect' });
            expect(sdkQuery.shouldRetainForegroundForResult({ type: 'result', user_message_uuid: 'unrelated', queued_turn_count: 0 })).toBe(false);
        } finally {
            await sdkQuery.dispose();
        }
    });

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

    it('accepts only the exact main-chain provider acknowledgment and preserves its observation', async () => {
        const transport = createControlledTransport();
        const onMessageReceived = vi.fn();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt(), onMessageReceived });
        const transportOutcome = readPromptTransportOutcome(sdkQuery);
        let didSettle = false;
        void transportOutcome.then(() => { didSettle = true; });
        const attemptedRecord = await transport.writeStarted.promise;
        transport.write.resolve({ kind: 'written' });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(didSettle).toBe(false);

        const echo = { type: 'user', uuid: 'initial-prompt', parent_tool_use_id: null,
            isReplay: true, message: { role: 'user', content: 'exact queued prompt' } };
        for (const invalid of [
            { ...echo, uuid: '' }, { ...echo, uuid: 'other-prompt' },
            { ...echo, type: 'assistant' }, { ...echo, parent_tool_use_id: 'child' },
            { ...echo, isSynthetic: true },
        ]) await transport.emit(invalid);
        expect(didSettle).toBe(false);
        await transport.emit(echo);
        await expect(transportOutcome).resolves.toEqual({ kind: 'accepted' });
        expect(attemptedRecord).toMatchObject({ uuid: 'initial-prompt' });
        // Subscribers retain the provider record for their existing protocol observations.
        expect(onMessageReceived).toHaveBeenCalledWith(echo);
        await sdkQuery.dispose();
    });

    it.each(['exit', 'dispose'] as const)('accepts a native acknowledgment before %s even when write completion is lost', async (termination) => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        const outcome = readPromptTransportOutcome(sdkQuery);
        await transport.writeStarted.promise;
        const observed = transport.emit({ type: 'user', uuid: 'initial-prompt', parent_tool_use_id: null });
        if (termination === 'exit') transport.exit.resolve({ exitCode: 1, signal: null, stdout: '', stderr: 'exit after acknowledgment' });
        const disposed = termination === 'dispose' ? sdkQuery.dispose() : Promise.resolve();
        await observed;
        await expect(outcome).resolves.toEqual({ kind: 'accepted' });
        transport.write.resolve({ kind: 'write_may_have_occurred', error: new Error('write completion lost') });
        await new Promise<void>(resolve => setImmediate(resolve));
        await expect(outcome).resolves.toEqual({ kind: 'accepted' });
        await disposed;
        await sdkQuery.dispose();
    });

    it('correlates initial and in-flight sends independently when acknowledgments arrive out of order', async () => {
        const transport = createControlledTransport();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt() });
        const initialOutcome = readPromptTransportOutcome(sdkQuery);
        let initialSettled = false;
        let steerSettled = false;
        void initialOutcome.then(() => { initialSettled = true; });
        await transport.writeStarted.promise;
        transport.write.resolve({ kind: 'written' });
        const steerOutcome = sdkQuery.sendUserMessage('steer prompt', 'steer-prompt');
        void steerOutcome.then(() => { steerSettled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(initialSettled).toBe(false);
        expect(steerSettled).toBe(false);
        expect(transport.records).toContainEqual(expect.objectContaining({ uuid: 'steer-prompt' }));
        await transport.emit({ type: 'user', uuid: 'steer-prompt', parent_tool_use_id: null });
        await expect(steerOutcome).resolves.toEqual({ kind: 'accepted' });
        expect(initialSettled).toBe(false);
        await transport.emit({ type: 'user', uuid: 'initial-prompt', parent_tool_use_id: null });
        await expect(initialOutcome).resolves.toEqual({ kind: 'accepted' });
        transport.exit.resolve({ exitCode: 1, signal: null, stdout: '', stderr: 'later failure' });
        await expect(initialOutcome).resolves.toEqual({ kind: 'accepted' });
        await expect(steerOutcome).resolves.toEqual({ kind: 'accepted' });
        await sdkQuery.dispose();
    });

    it.each(['exit', 'abort', 'dispose'] as const)('keeps written but unacknowledged initial and steer sends ambiguous on %s', async (termination) => {
        const transport = createControlledTransport();
        const controller = new AbortController();
        const sdkQuery = query(transport.ctx, { prompt: exactPrompt(), options: { abort: controller.signal } });
        const initialOutcome = readPromptTransportOutcome(sdkQuery);
        let initialSettled = false;
        void initialOutcome.then(() => { initialSettled = true; });
        await transport.writeStarted.promise;
        transport.write.resolve({ kind: 'written' });
        const steerOutcome = sdkQuery.sendUserMessage('steer prompt', 'steer-prompt');
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(initialSettled).toBe(false);
        if (termination === 'exit') transport.exit.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' });
        if (termination === 'abort') controller.abort(new Error('cancelled after write'));
        if (termination === 'dispose') await sdkQuery.dispose();
        await expect(initialOutcome).resolves.toMatchObject({ kind: 'effect_may_have_occurred' });
        await expect(steerOutcome).resolves.toMatchObject({ kind: 'effect_may_have_occurred' });
        if (termination !== 'dispose') await sdkQuery.dispose();
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
            uuid: 'initial-prompt',
            message: { role: 'user', content: 'exact queued prompt' },
        });
        await sdkQuery.dispose();
    });
});
