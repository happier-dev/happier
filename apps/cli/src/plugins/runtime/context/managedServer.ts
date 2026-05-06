import type {
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    ManagedServerHandleV1,
    ManagedServerRuntimeServiceV1,
    ManagedServerSnapshotV1,
    ManagedServerSpecV1,
} from '@happier-dev/plugin-sdk';

import { createPluginExecService } from './exec';

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
        const timer = setTimeout(resolve, Math.max(0, ms));
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason ?? createAbortError());
        }
    };
    for (const signal of signals) {
        if (!signal) {
            continue;
        }
        if (signal.aborted) {
            abort(signal);
            break;
        }
        signal.addEventListener('abort', () => abort(signal), { once: true });
    }
    return controller.signal;
}

function isSuccessfulCommandHealth(result: ExecRunResultV1): boolean {
    return result.exitCode === 0;
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized === '[::1]'
        || normalized === '127.0.0.1'
        || normalized.startsWith('127.');
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
    const signal = composeAbortSignals([params.signal, timeoutController.signal]);
    try {
        const response = await fetch(healthCheck.url, {
            method: 'GET',
            signal,
        });
        return response.ok;
    } catch (error) {
        if (signal.aborted && params.signal?.aborted === true) {
            throw createAbortError();
        }
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export function createPluginManagedServerService(
    params: CreatePluginManagedServerServiceParams = {},
): ManagedServerRuntimeServiceV1 {
    const exec = params.exec ?? createPluginExecService();
    const service: ManagedServerRuntimeServiceV1 = Object.freeze({
        async supervise(spec: ManagedServerSpecV1): Promise<ManagedServerHandleV1> {
            if (spec.restart === 'on_failure') {
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
