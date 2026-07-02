import type {
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    ManagedServerHandleV1,
    ManagedServerRuntimeServiceV1,
    ManagedServerSnapshotV1,
    ManagedServerSpecV1,
} from '@happier-dev/plugin-sdk';
import { LocalServiceLoopbackHostV1Schema } from '@happier-dev/protocol';

import { createPluginExecService } from '../exec';

type PluginManagedServerDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

export type PluginManagedServerErrorCode =
    | 'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED'
    | 'PLUGIN_MANAGED_SERVER_HEALTH_TIMEOUT'
    | 'PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED';

export class PluginManagedServerError extends Error {
    readonly code: PluginManagedServerErrorCode;

    constructor(code: PluginManagedServerErrorCode, message: string) {
        super(message);
        this.name = 'PluginManagedServerError';
        this.code = code;
    }
}

export type CreatePluginManagedServerServiceParams = Readonly<{
    exec?: ExecRuntimeServiceV1;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginManagedServerDisposable) => unknown;
}>;

function createSnapshot(params: ManagedServerSnapshotV1): ManagedServerSnapshotV1 {
    return Object.freeze({ ...params });
}

function createAbortError(): Error {
    const error = new Error('Plugin managed server operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };
        const finish = (handler: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            handler();
        };
        const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
        const onAbort = () => {
            clearTimeout(timer);
            finish(() => reject(createAbortError()));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

type ComposedAbortSignal = Readonly<{
    signal: AbortSignal;
    dispose: () => void;
}>;

function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): ComposedAbortSignal {
    const controller = new AbortController();
    const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const entry of listeners) {
            entry.signal.removeEventListener('abort', entry.listener);
        }
        listeners.length = 0;
    };
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason ?? createAbortError());
        }
        dispose();
    };
    for (const signal of signals) {
        if (!signal) {
            continue;
        }
        if (signal.aborted) {
            abort(signal);
            break;
        }
        const listener = () => abort(signal);
        signal.addEventListener('abort', listener, { once: true });
        listeners.push({ signal, listener });
    }
    return Object.freeze({
        signal: controller.signal,
        dispose,
    });
}

function isSuccessfulCommandHealth(result: ExecRunResultV1): boolean {
    return result.exitCode === 0;
}

function isLoopbackHostname(hostname: string): boolean {
    return LocalServiceLoopbackHostV1Schema.safeParse(hostname).success;
}

function assertLoopbackHttpHealthCheck(url: string): void {
    const parsed = new URL(url);
    if (!isLoopbackHostname(parsed.hostname)) {
        throw new Error(`ctx.managedServer HTTP health checks must target loopback URLs, received '${parsed.origin}'`);
    }
}

async function runHealthCheck(params: Readonly<{
    spec: ManagedServerSpecV1;
    exec: ExecRuntimeServiceV1;
    signal: AbortSignal | undefined;
}>): Promise<boolean> {
    const healthCheck = params.spec.healthCheck;
    if (!healthCheck) {
        throw new PluginManagedServerError(
            'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED',
            `Managed server '${params.spec.id}' cannot report healthy without a declared health check`,
        );
    }
    if (healthCheck.kind === 'command') {
        const result = await params.exec.run(healthCheck.launch, {
            signal: params.signal,
            timeoutMs: healthCheck.timeoutMs,
        });
        return isSuccessfulCommandHealth(result);
    }
    assertLoopbackHttpHealthCheck(healthCheck.url);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(createAbortError()), Math.max(0, healthCheck.timeoutMs ?? 1_000));
    const composed = composeAbortSignals([params.signal, timeoutController.signal]);
    try {
        const response = await fetch(healthCheck.url, {
            method: 'GET',
            signal: composed.signal,
        });
        return response.ok;
    } catch (error) {
        if (composed.signal.aborted && params.signal?.aborted === true) {
            throw createAbortError();
        }
        return false;
    } finally {
        clearTimeout(timer);
        composed.dispose();
    }
}

export function createPluginManagedServerService(
    params: CreatePluginManagedServerServiceParams = {},
): ManagedServerRuntimeServiceV1 {
    const exec = params.exec ?? createPluginExecService();
    const service: ManagedServerRuntimeServiceV1 = Object.freeze({
        async supervise(spec: ManagedServerSpecV1): Promise<ManagedServerHandleV1> {
            const restart = (spec as unknown as Readonly<{ restart?: unknown }>).restart;
            if (restart !== undefined && restart !== 'never') {
                throw new PluginManagedServerError(
                    'PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED',
                    `Managed server '${spec.id}' restart policy is not supported by this host binding yet`,
                );
            }
            const startedAt = Date.now();
            let disposed = false;
            let snapshot = createSnapshot({
                id: spec.id,
                state: 'starting',
                pid: null,
                startedAt,
                lastHealthyAt: null,
                lastErrorMessage: null,
            });
            const processHandle = await exec.spawn(spec.launch, {
                signal: spec.signal ?? params.signal,
            });
            snapshot = createSnapshot({
                ...snapshot,
                pid: processHandle.pid,
            });
            const handle: ManagedServerHandleV1 = Object.freeze({
                snapshot: () => snapshot,
                async waitUntilHealthy(options) {
                    const timeoutMs = options?.timeoutMs ?? spec.startupTimeoutMs ?? 30_000;
                    const deadline = Date.now() + Math.max(0, timeoutMs);
                    while (Date.now() <= deadline) {
                        assertNotAborted(options?.signal ?? spec.signal ?? params.signal);
                        let healthy: boolean;
                        try {
                            healthy = await runHealthCheck({
                                spec,
                                exec,
                                signal: options?.signal ?? spec.signal ?? params.signal,
                            });
                        } catch (error) {
                            snapshot = createSnapshot({
                                ...snapshot,
                                state: 'unhealthy',
                                lastErrorMessage: error instanceof Error ? error.message : 'Managed server health check failed',
                            });
                            throw error;
                        }
                        if (healthy) {
                            snapshot = createSnapshot({
                                ...snapshot,
                                state: 'healthy',
                                lastHealthyAt: Date.now(),
                                lastErrorMessage: null,
                            });
                            return snapshot;
                        }
                        await delay(Math.min(25, Math.max(0, deadline - Date.now())), options?.signal ?? spec.signal ?? params.signal);
                    }
                    const error = new PluginManagedServerError(
                        'PLUGIN_MANAGED_SERVER_HEALTH_TIMEOUT',
                        `Managed server '${spec.id}' did not become healthy before startup timeout`,
                    );
                    snapshot = createSnapshot({
                        ...snapshot,
                        state: 'unhealthy',
                        lastErrorMessage: error.message,
                    });
                    throw error;
                },
                async dispose() {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    await processHandle.dispose();
                    snapshot = createSnapshot({
                        ...snapshot,
                        state: 'stopped',
                    });
                },
            });
            params.addDisposable?.(handle);
            return handle;
        },
    });
    return service;
}
