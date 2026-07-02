import type {
    PluginRequestInterceptorTargetV1,
    RequestInterceptorRequestPatchV1,
    RequestPolicyResultV1,
} from '@happier-dev/protocol';

export type FetchRuntimeHeadersV1 = Readonly<Record<string, string>>;

export type FetchRuntimeRequestV1 = Readonly<{
    url: string;
    method?: string;
    headers?: FetchRuntimeHeadersV1;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type FetchRuntimeResponseV1 = Readonly<{
    ok: boolean;
    status: number;
    statusText?: string;
    headers: FetchRuntimeHeadersV1;
    body?: unknown;
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type FetchRuntimeServiceV1 = (
    request: FetchRuntimeRequestV1,
) => Promise<FetchRuntimeResponseV1>;

export type RequestPolicyCallerV1 =
    Readonly<{
        scope: 'plugin-fetch';
        pluginId?: string;
    }>;

export type RequestPolicyOperationContextV1 = Readonly<{
    id: string;
    attempt: number;
}>;

export type RequestPolicyHandlerInputV1 = Readonly<{
    interceptorId: string;
    pluginId: string;
    target: PluginRequestInterceptorTargetV1;
    originalRequest: FetchRuntimeRequestV1;
    effectiveRequest: FetchRuntimeRequestV1;
    caller: RequestPolicyCallerV1;
    operation: RequestPolicyOperationContextV1;
}>;

export type PluginFetchRequestPolicyHandlerV1 = (
    input: RequestPolicyHandlerInputV1,
) => Promise<RequestPolicyResultV1> | RequestPolicyResultV1;

export type PluginApiRequestInterceptorRegistrationV1 = Readonly<{
    id: string;
    handle: PluginFetchRequestPolicyHandlerV1;
}>;

export type {
    RequestInterceptorRequestPatchV1,
    RequestPolicyResultV1,
};
