import { describe, expect, it } from 'vitest';
import { createBackgroundServiceProcessExecution } from './backgroundServiceProcessExecution';
import { channelBoundary } from './backgroundServiceProcessChannel.testkit';
import { createBackgroundServiceProcessServiceClient, type BackgroundServiceProcessBridgeValue } from './backgroundServiceProcessBridge';

async function flush() {
    for (let index = 0; index < 15; index += 1) await Promise.resolve();
}

describe('background service process execution transport', () => {
    it.each(['stop', 'dispose'] as const)('keeps actual channel custody failures observable during %s', async action => {
        const boundary = channelBoundary();
        const failure = new Error('OS could not terminate the created child');
        let failTermination = true;
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => ({ ...boundary.channel, terminate: async () => {
                if (failTermination) throw failure;
                await boundary.channel.terminate();
            } }),
        });
        const running = execution.run({ signal: new AbortController().signal });
        const settled = running.catch(() => undefined);
        await flush();
        if (action === 'dispose') { boundary.emit({ kind: 'settled', id: '1' }); await running; }
        try {
            await expect(execution[action]()).rejects.toBe(failure);
            expect(execution.isReleased()).toBe(false);
        } finally {
            failTermination = false;
            await execution.stop();
            await settled;
        }
    });

    it('definitively stops a worker that ignores cooperative cancellation and joins physical cleanup', async () => {
        const boundary = channelBoundary();
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => boundary.channel, services: {},
        });
        const running = execution.run({ signal: new AbortController().signal });
        void running.catch(() => undefined);
        await flush();
        try {
            await execution.stop();
            expect(boundary.terminated).toBe(true);
            await expect(running).rejects.toMatchObject({ code: 'background_service_stopped' });
            expect(boundary.messages).toContainEqual({ kind: 'abort', id: '1' });
        } finally {
            boundary.emit({ kind: 'settled', id: '1' });
            await running.catch(() => undefined);
            await execution.dispose();
        }
    });

    it('binds fresh admitted service policy for each coalesced run', async () => {
        const boundary = channelBoundary();
        const firstSignal = new AbortController().signal;
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => boundary.channel,
            prepareRun: context => ({ additionalServices: { probe: { admission: context.signal === firstSignal ? 'first' : 'second' } } }),
        });
        try {
            for (const [index, signal] of [firstSignal, new AbortController().signal].entries()) {
                const context = { signal, materialization: {
                    pluginId: 'acme.indexer', machineId: 'machine-observer', materializationId: `installation-${index}`,
                }, caller: { kind: 'plugin', pluginId: 'acme.caller', materialization: {
                    pluginId: 'acme.caller', machineId: 'machine-caller', materializationId: 'caller-installation',
                } } };
                const running = execution.run(context);
                // Assertion failure still retires the active physical run below.
                void running.catch(() => undefined);
                await flush();
                const sent = boundary.messages.at(-1);
                expect(sent?.kind).toBe('run');
                if (sent?.kind !== 'run') throw new Error('Missing run');
                expect(sent.context).toMatchObject({ materialization: context.materialization, caller: context.caller });
                const child = createBackgroundServiceProcessServiceClient<Readonly<{ probe: Readonly<{ admission: string }> }>>({
                    description: sent.services as BackgroundServiceProcessBridgeValue, send() {},
                });
                expect(child.services.probe.admission).toBe(index === 0 ? 'first' : 'second');
                await child.dispose();
                boundary.emit({ kind: 'settled', id: String(index + 1) });
                await running;
            }
        } finally { await execution.dispose(); }
    });

    it('starts only on demand, crosses abort, reuses one child across followups and closes after settlement', async () => {
        const boundary = channelBoundary();
        let births = 0;
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => { births += 1; return boundary.channel; }, services: {},
        });
        expect(births).toBe(0);
        const controller = new AbortController();
        const running = execution.run({ signal: controller.signal });
        await flush();
        expect(boundary.messages.map(message => message.kind)).toEqual(['initialize', 'run']);
        controller.abort();
        expect(boundary.messages.at(-1)).toEqual({ kind: 'abort', id: '1' });
        boundary.emit({ kind: 'settled', id: '1' });
        await running;
        const followup = execution.run({ signal: new AbortController().signal });
        await flush();
        boundary.emit({ kind: 'settled', id: '2' });
        await followup;
        expect(births).toBe(1);
        await execution.dispose();
        expect(boundary.messages.at(-1)).toEqual({ kind: 'stop' });
        expect(boundary.terminated).toBe(true);
    });

    it('rejects an interrupted run on physical death without replaying its effects', async () => {
        const boundary = channelBoundary();
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => boundary.channel, services: {},
        });
        const running = execution.run({ signal: new AbortController().signal });
        const failed = expect(running).rejects.toMatchObject({ code: 'background_service_process_exited' });
        await flush();
        boundary.finish({ type: 'exited', code: 23 });
        await failed;
        expect(boundary.messages.filter(message => message.kind === 'run')).toHaveLength(1);
        await execution.dispose();
    });

    it('retires a child that is still bootstrapping when the demand is cancelled', async () => {
        const boundary = channelBoundary(false);
        const execution = createBackgroundServiceProcessExecution({
            bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: 'test',
            spawnChannel: async () => boundary.channel, services: {},
        });
        const controller = new AbortController();
        const running = execution.run({ signal: controller.signal });
        const failed = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        controller.abort();
        await flush();
        try {
            expect(boundary.terminated).toBe(true);
        } finally {
            boundary.emit({ kind: 'ready', pid: 43123 });
            await failed;
            await execution.dispose();
        }
    });
});
