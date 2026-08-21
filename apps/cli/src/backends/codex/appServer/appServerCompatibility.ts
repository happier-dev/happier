export type CodexAppServerRpcError = Error & Readonly<{
    code?: number;
    data?: unknown;
    method?: string;
}>;

const CODEX_APP_SERVER_RPC_ERROR = Symbol('CodexAppServerRpcError');

export function createCodexAppServerRpcError(params: Readonly<{
    method: string;
    code?: number;
    message?: string;
    data?: unknown;
}>): CodexAppServerRpcError {
    const error = new Error(params.message ?? `Codex app-server request failed: ${params.method}`) as CodexAppServerRpcError;
    if (typeof params.code === 'number') {
        Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    }
    Object.defineProperty(error, 'method', { value: params.method, enumerable: true });
    Object.defineProperty(error, CODEX_APP_SERVER_RPC_ERROR, { value: true });
    if (params.data !== undefined) {
        Object.defineProperty(error, 'data', { value: params.data, enumerable: true });
    }
    return error;
}

export function isCodexAppServerNoActiveTurnToSteerError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const method = (error as Partial<CodexAppServerRpcError>).method;
    if (typeof method === 'string' && method !== 'turn/steer') return false;
    return /\bno\s+active\s+turn\s+to\s+steer\b/i.test(error.message);
}

function readCode(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

function readDataText(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    const data = (error as { data?: unknown }).data;
    if (data === undefined) return '';
    if (typeof data === 'string') return data;
    try {
        return JSON.stringify(data);
    } catch {
        return '';
    }
}

function includesFieldName(value: string, fieldName: string): boolean {
    return value.toLowerCase().includes(fieldName.toLowerCase());
}

export function isCodexAppServerMethodNotFoundError(error: unknown): boolean {
    if (readCode(error) === -32601) return true;
    return /method\s+not\s+found/i.test(readMessage(error));
}

/**
 * A mutating request may be retried under a compatibility alias only after a
 * correlated JSON-RPC response conclusively says the method is absent. Text
 * alone can be emitted by transport/process failures and is not enough to
 * establish that no provider-side effect occurred.
 */
export function isCodexAppServerDefinitiveMethodNotFoundError(error: unknown, method: string): boolean {
    if (!error || typeof error !== 'object') return false;
    return readCode(error) === -32601
        && (error as { method?: unknown }).method === method
        && (error as { [CODEX_APP_SERVER_RPC_ERROR]?: unknown })[CODEX_APP_SERVER_RPC_ERROR] === true;
}

export function isCodexAppServerInvalidParamsError(error: unknown): boolean {
    if (readCode(error) === -32602) return true;
    return /invalid\s+params/i.test(readMessage(error));
}

export function isCodexAppServerInvalidParamsForFieldError(error: unknown, fieldName: string): boolean {
    if (!isCodexAppServerInvalidParamsError(error)) return false;
    return includesFieldName(readMessage(error), fieldName) || includesFieldName(readDataText(error), fieldName);
}

export function isCodexAppServerInvalidRequestForMethodError(error: unknown, method: string): boolean {
    if (readCode(error) !== -32600) return false;
    if (!error || typeof error !== 'object') return false;
    const errorMethod = (error as { method?: unknown }).method;
    if (errorMethod === method) return true;
    return readMessage(error).includes(method);
}

export function isCodexAppServerInvalidRequestMapExpectedStringError(error: unknown): boolean {
    if (readCode(error) !== -32600) return false;
    const message = readMessage(error);
    return /invalid\s+request/i.test(message)
        && /invalid\s+type:\s*map,\s*expected\s+a\s*string/i.test(message);
}

export function isCodexAppServerExperimentalApiUnavailableError(error: unknown): boolean {
    const message = readMessage(error);
    if (!/experimental/i.test(message)) return false;
    return isCodexAppServerMethodNotFoundError(error) || isCodexAppServerInvalidParamsError(error);
}

export function shouldRetryCodexAppServerRequestWithoutExperimentalParams(error: unknown): boolean {
    return isCodexAppServerMethodNotFoundError(error)
        || isCodexAppServerInvalidParamsError(error)
        || isCodexAppServerExperimentalApiUnavailableError(error);
}
