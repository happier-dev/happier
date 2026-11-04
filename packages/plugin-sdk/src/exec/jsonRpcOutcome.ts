/** @moduleRealm daemon */
/** @realm any */

export type JsonRpcApplicationError = Error & Readonly<{
    code?: number | string;
    data?: unknown;
    method?: string;
}>;

/** Created only for a correlated JSON-RPC error response, never transport loss. */
export function createJsonRpcApplicationError(params: Readonly<{
    method?: string;
    code?: number | string;
    message?: string;
    data?: unknown;
    cause?: unknown;
}>): JsonRpcApplicationError {
    const error: JsonRpcApplicationError = new Error(params.message ?? 'JSON-RPC request failed',
        params.cause === undefined ? undefined : { cause: params.cause });
    error.name = 'JsonRpcApplicationError';
    if ((typeof params.code === 'number' && Number.isFinite(params.code)) || typeof params.code === 'string') {
        Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    }
    if (params.method !== undefined) Object.defineProperty(error, 'method', { value: params.method, enumerable: true });
    if (params.data !== undefined) Object.defineProperty(error, 'data', { value: params.data, enumerable: true });
    return error;
}

export type JsonRpcApplicationRejectionDetails = Readonly<{
    /** JSON-RPC specifies a numeric error code; arbitrary string codes are not safe diagnostics. */
    providerErrorCode?: number;
    method: string;
    messageClass: 'JsonRpcApplicationError';
}>;

/** A content-free projection; neither response prose, data nor cause escapes. */
export function readJsonRpcApplicationRejection(error: unknown): JsonRpcApplicationRejectionDetails | null {
    if (!(error instanceof Error) || error.name !== 'JsonRpcApplicationError') return null;
    const response: JsonRpcApplicationError = error;
    if (typeof response.method !== 'string' || response.method.length === 0) return null;
    return {
        ...(typeof response.code === 'number' && Number.isFinite(response.code) ? { providerErrorCode: response.code } : {}),
        method: response.method,
        messageClass: 'JsonRpcApplicationError',
    };
}

/** Correlated provider effects take precedence over an otherwise definite refusal. */
export function classifyJsonRpcSubmissionFailure(error: unknown, request: Readonly<{
    method: string;
    effectObserved: boolean;
}>): Readonly<{ kind: 'rejected_before_effect'; details: JsonRpcApplicationRejectionDetails }>
    | Readonly<{ kind: 'effect_may_have_occurred' }> {
    const details = readJsonRpcApplicationRejection(error);
    return !request.effectObserved && details?.method === request.method
        ? { kind: 'rejected_before_effect', details }
        : { kind: 'effect_may_have_occurred' };
}
