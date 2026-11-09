import type { BackgroundServiceProcessBootstrap } from './backgroundServiceProcessBootstrap';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSupervisedProcess } from '@/subprocess/supervision/supervisedProcess';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { spawnBackgroundServiceProcessChannel, type BackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';
import { createBackgroundServiceProcessServiceHost } from './backgroundServiceProcessBridge';
import {
    createBackgroundServiceProcessFrameDecoder,
    encodeBackgroundServiceProcessFrame,
    parseBackgroundServiceProcessMessage,
    type BackgroundServiceProcessMessage,
} from './backgroundServiceProcessProtocol';
import type { BackgroundServiceProcessLocalPolicy } from './backgroundServiceProcessServices';
import { projectBackgroundServiceProcessProxiedServices } from './backgroundServiceProcessPolicy';

export type BackgroundServiceProcessRunContext = Readonly<{
    signal: AbortSignal;
    isOccurrenceCurrent?(): boolean;
    services?: object;
}>;

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function executionError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

/** Placement only: admission, demand coalescing and retirement remain with the runner host. */
export function createBackgroundServiceProcessExecution(params: Readonly<{
    bootstrap: BackgroundServiceProcessBootstrap;
    serviceId: string;
    pluginId?: string;
    services?: Readonly<Record<string, unknown>>;
    prepareRun?(context: BackgroundServiceProcessRunContext): Readonly<{
        localServicesPolicy?: BackgroundServiceProcessLocalPolicy;
        additionalServices?: Readonly<Record<string, unknown>>;
    }> | Promise<Readonly<{
        localServicesPolicy?: BackgroundServiceProcessLocalPolicy;
        additionalServices?: Readonly<Record<string, unknown>>;
    }>>;
    /** The real OS/process boundary, also used by the composed transport harness. */
    spawnChannel?: typeof spawnBackgroundServiceProcessChannel;
}>): Readonly<{
    run(context: BackgroundServiceProcessRunContext): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    isReleased(): boolean;
}> {
    let channelPromise: Promise<BackgroundServiceProcessChannel> | undefined;
    let channel: BackgroundServiceProcessChannel | undefined;
    const ready = deferred<void>();
    // A spawn failure can precede the first waiter reaching readiness.
    void ready.promise.catch(() => undefined);
    let failure: unknown;
    let disposed = false;
    let disposing: Promise<void> | undefined;
    let stopRequested = false;
    let stopping: Promise<void> | undefined;
    let released = true;
    let sequence = 0;
    let active: Readonly<{
        id: string;
        settlement: ReturnType<typeof deferred<void>>;
        services: ReturnType<typeof createBackgroundServiceProcessServiceHost>;
    }> | undefined;

    const send = (message: BackgroundServiceProcessMessage): void => {
        if (!channel) throw executionError('background_service_worker_unavailable', 'Background service process is unavailable');
        channel.send(encodeBackgroundServiceProcessFrame(message));
    };
    const fail = (error: unknown): void => {
        failure ??= error;
        ready.reject(error);
        active?.settlement.reject(error);
    };

    const spawnWorker = async (): Promise<BackgroundServiceProcessChannel> => {
        released = false;
        channelPromise ??= (params.spawnChannel ?? spawnBackgroundServiceProcessChannel)({
            serviceId: params.serviceId,
            ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        });
        channel = await timeWebLatencyPhase('backgroundService.process.spawn', () => channelPromise!);
        const decoder = createBackgroundServiceProcessFrameDecoder();
        channel.onData(chunk => {
            if (disposed) return;
            try {
                for (const frame of decoder.push(chunk)) {
                    const message = parseBackgroundServiceProcessMessage(frame);
                    switch (message.kind) {
                        case 'ready': ready.resolve(); break;
                        case 'services': active?.services.receive(message.message); break;
                        case 'settled':
                            if (active?.id !== message.id) throw new Error('background_service_protocol_run_mismatch');
                            active.settlement.resolve();
                            break;
                        case 'failed': {
                            const error = executionError(message.error.code, message.error.message);
                            if (message.id === 'initialize') fail(error);
                            else if (active?.id === message.id) active.settlement.reject(error);
                            else throw new Error('background_service_protocol_run_mismatch');
                            break;
                        }
                        default: throw new Error('background_service_protocol_direction_invalid');
                    }
                }
            } catch (error) {
                fail(error);
                void channel?.terminate().catch(fail);
            }
        });
        send({ kind: 'initialize', bootstrap: params.bootstrap });
        return channel;
    };
    const supervisor = createSupervisedProcess({
        id: params.serviceId,
        policy: {
            kind: 'other', restart: { mode: 'never' },
            logging: { logTerminationEvents: false }, artifacts: { captureStderr: false },
            // This supervisor observes only. The shared channel owns termination; no local grace timer.
            terminateGraceMs: 0,
        },
        spawn: spawnWorker,
        onTermination(event) {
            if (!disposed) fail(executionError('background_service_process_exited',
                `Background service process exited before disposal (${event.type})`));
        },
    });
    let startup: Promise<void> | undefined;

    const stop = (): Promise<void> => {
        if (stopping) return stopping;
        stopRequested = true;
        disposed = true;
        supervisor.markStopRequested({ reason: 'shutdown', requestedAtMs: Date.now() });
        const stopped = executionError('background_service_stopped', 'Background service process was stopped');
        if (active) {
            try { send({ kind: 'abort', id: active.id }); }
            catch { /* A physically absent child is joined by the same custody owner below. */ }
        }
        fail(stopped);
        const attempt = (async () => {
            try {
                const current = await channelPromise;
                await current?.terminate();
                released = true;
            } finally { supervisor.dispose(); }
        })();
        stopping = attempt.catch(error => {
            // Failed custody release remains retryable; it is never reported as a successful Stop.
            stopping = undefined;
            throw error;
        });
        return stopping;
    };

    return {
        async run(context) {
            if (disposed) throw executionError('background_service_retired', 'Background service process is retired');
            if (failure) throw failure;
            if (active) throw new Error('background_service_run_overlap');
            if (context.signal.aborted) throw context.signal.reason;
            const abortStartup = (): void => {
                fail(context.signal.reason);
                void channelPromise?.then(current => current.terminate()).catch(fail);
            };
            context.signal.addEventListener('abort', abortStartup, { once: true });
            try {
                if (!startup) {
                    supervisor.start();
                    startup = ready.promise;
                }
                await timeWebLatencyPhase('backgroundService.process.ready', () => startup!);
            } finally {
                context.signal.removeEventListener('abort', abortStartup);
            }
            if (context.signal.aborted) throw context.signal.reason;
            if (failure) throw failure;
            const prepared = await params.prepareRun?.(context);
            if (context.signal.aborted) throw context.signal.reason;
            const localPolicy = prepared?.localServicesPolicy;
            const id = String(++sequence);
            const bound = params.services ?? {
                ...projectBackgroundServiceProcessProxiedServices(context.services ?? {}),
                ...prepared?.additionalServices,
            };
            const services = createBackgroundServiceProcessServiceHost({
                services: bound,
                signal: context.signal,
                send: message => send({ kind: 'services', message }),
            });
            const settlement = deferred<void>();
            active = { id, services, settlement };
            const abort = () => {
                try { send({ kind: 'abort', id }); }
                catch (error) { fail(error); }
            };
            context.signal.addEventListener('abort', abort, { once: true });
            const metadata = Object.fromEntries(Object.entries(context).filter(([key]) => (
                ['plugin', 'contribution', 'materialization', 'surface', 'invokedAtMs', 'invocationId', 'caller'].includes(key)
            )));
            try {
                send({ kind: 'run', id, context: metadata, services: services.description,
                    ...(localPolicy ? { localPolicy } : {}) });
                if (context.signal.aborted) abort();
                await settlement.promise;
            } finally {
                context.signal.removeEventListener('abort', abort);
                try { await services.dispose(); }
                finally { active = undefined; }
            }
        },
        stop,
        isReleased: () => released,
        dispose() {
            disposing ??= (async () => {
                if (stopRequested || active) { await stop(); return; }
                if (disposed) return;
                disposed = true;
                supervisor.markStopRequested({ reason: 'shutdown', requestedAtMs: Date.now() });
                if (!channelPromise) return;
                const current = await channelPromise;
                try {
                    // A failed run already published its semantic failure. Join custody
                    // without reclassifying that crash as a new graceful-shutdown failure.
                    if (!failure) {
                        send({ kind: 'stop' });
                        await current.close();
                    }
                } finally {
                    try {
                        await current.terminate();
                        released = true;
                    }
                    finally { supervisor.dispose(); }
                }
            })();
            return disposing;
        },
    };
}
