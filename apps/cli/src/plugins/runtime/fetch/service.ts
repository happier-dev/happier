import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
    PluginApiRequestInterceptorRegistrationV1,
    PluginFetchNextV1,
} from '@happier-dev/plugin-sdk';

export type PluginFetchErrorCode =
    | 'PLUGIN_FETCH_PERMISSION_DENIED'
    | 'PLUGIN_FETCH_ADAPTER_UNAVAILABLE';

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
        return await fetchThroughHost(request);
    };
}
