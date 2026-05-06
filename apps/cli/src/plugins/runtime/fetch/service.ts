import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
    PluginApiRequestInterceptorRegistrationV1,
    PluginFetchNextV1,
} from '@happier-dev/plugin-sdk';

export type PluginFetchErrorCode =
    | 'PLUGIN_FETCH_PERMISSION_DENIED'
    | 'PLUGIN_FETCH_ADAPTER_UNAVAILABLE'
    | 'PLUGIN_FETCH_URL_SCOPE_DENIED';

export class PluginFetchError extends Error {
    readonly code: PluginFetchErrorCode;

    constructor(code: PluginFetchErrorCode, message: string) {
        super(message);
        this.name = 'PluginFetchError';
        this.code = code;
    }
}

export type CreatePluginFetchServiceParams = Readonly<{
    networkAllowed: boolean;
    adapter?: FetchRuntimeServiceV1 | null;
    interceptors?: readonly PluginApiRequestInterceptorRegistrationV1[];
    pluginId?: string | null;
    allowedUrlOrigins?: readonly string[];
    retry?: Readonly<{
        maxAttempts: number;
        baseDelayMs?: number;
    }>;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin fetch request was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function mergeAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.length === 0) {
        return undefined;
    }
    if (activeSignals.length === 1) {
        return activeSignals[0];
    }
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason);
        }
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort(signal);
            break;
        }
        signal.addEventListener('abort', () => abort(signal), { once: true });
    }
    return controller.signal;
}

function withTimeout(request: FetchRuntimeRequestV1): Readonly<{
    request: FetchRuntimeRequestV1;
    dispose: () => void;
}> {
    if (request.timeoutMs === undefined) {
        return { request, dispose: () => undefined };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(createAbortError());
    }, Math.max(0, request.timeoutMs));
    return {
        request: {
            ...request,
            signal: mergeAbortSignals([request.signal, controller.signal]),
        },
        dispose: () => clearTimeout(timer),
    };
}

function assertUrlAllowed(params: Readonly<{
    request: FetchRuntimeRequestV1;
    allowedUrlOrigins: readonly string[] | undefined;
    pluginId: string | null | undefined;
}>): void {
    const allowedUrlOrigins = params.allowedUrlOrigins;
    if (!allowedUrlOrigins || allowedUrlOrigins.length === 0) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch without a declared URL origin scope`,
        );
    }
    if (allowedUrlOrigins.includes('*')) {
        return;
    }
    let origin: string;
    try {
        origin = new URL(params.request.url).origin;
    } catch {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch with an invalid URL`,
        );
    }
    if (!allowedUrlOrigins.includes(origin)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch for undeclared URL origin '${origin}'`,
        );
    }
}

function isTransientFetchError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = String((error as Error & { code?: unknown }).code ?? '');
    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    if (ms <= 0) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    assertNotAborted(signal);
    if (!signal) {
        return await operation;
    }
    return await new Promise<T>((resolve, reject) => {
        const abort = () => {
            cleanup();
            reject(createAbortError());
        };
        const cleanup = () => {
            signal.removeEventListener('abort', abort);
        };
        signal.addEventListener('abort', abort, { once: true });
        operation.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
}

function sortInterceptors(
    interceptors: readonly PluginApiRequestInterceptorRegistrationV1[],
): readonly PluginApiRequestInterceptorRegistrationV1[] {
    return Object.freeze([...interceptors].sort((left, right) => (
        (right.priority ?? 0) - (left.priority ?? 0)
        || left.id.localeCompare(right.id)
    )));
}

function createTerminalFetchAdapter(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    return async (request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
        assertNotAborted(request.signal);
        assertUrlAllowed({
            request,
            allowedUrlOrigins: params.allowedUrlOrigins,
            pluginId: params.pluginId,
        });
        if (!params.adapter) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_ADAPTER_UNAVAILABLE',
                'ctx.fetch network access is unavailable in this host context because no host fetch adapter is bound',
            );
        }
        return await params.adapter(request);
    };
}

function applyInterceptors(
    terminal: PluginFetchNextV1,
    interceptors: readonly PluginApiRequestInterceptorRegistrationV1[],
): PluginFetchNextV1 {
    return interceptors.reduceRight<PluginFetchNextV1>(
        (next, registration) => async (request) => {
            assertNotAborted(request.signal);
            return await registration.intercept(request, next);
        },
        terminal,
    );
}

export function createPluginFetchService(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    const interceptors = sortInterceptors(params.interceptors ?? []);
    const fetchThroughHost = applyInterceptors(createTerminalFetchAdapter(params), interceptors);

    return async (request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
        assertNotAborted(request.signal);
        if (!params.networkAllowed) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_PERMISSION_DENIED',
                `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch without declaring network permission`,
            );
        }
        assertUrlAllowed({
            request,
            allowedUrlOrigins: params.allowedUrlOrigins,
            pluginId: params.pluginId,
        });
        const timeout = withTimeout(request);
        const maxAttempts = Math.max(1, params.retry?.maxAttempts ?? 1);
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(timeout.request.signal);
                try {
                    return await raceWithAbort(fetchThroughHost({
                        ...timeout.request,
                        metadata: Object.freeze({
                            ...(timeout.request.metadata ?? {}),
                            attempt,
                        }),
                    }), timeout.request.signal);
                } catch (error) {
                    if (attempt >= maxAttempts || !isTransientFetchError(error)) {
                        throw error;
                    }
                    await delay(params.retry?.baseDelayMs ?? 0, timeout.request.signal);
                }
            }
        } finally {
            timeout.dispose();
        }
        throw new PluginFetchError(
            'PLUGIN_FETCH_ADAPTER_UNAVAILABLE',
            'ctx.fetch retry exhausted without a terminal result',
        );
    };
}
