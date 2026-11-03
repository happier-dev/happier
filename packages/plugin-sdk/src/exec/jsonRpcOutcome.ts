/** @moduleRealm daemon */
/** @realm any */

export type JsonRpcApplicationError = Error & Readonly<{
    code?: number | string;
    data?: unknown;
    method?: string;
}>;

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
