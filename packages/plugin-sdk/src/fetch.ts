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
