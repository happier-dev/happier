export type CodexAppServerRpcError = Error & Readonly<{
    code?: number | string;
    data?: unknown;
    method?: string;
}>;

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

export function isCodexAppServerNoActiveTurnToInterruptError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const method = (error as Partial<CodexAppServerRpcError>).method;
    if (typeof method === 'string' && method !== 'turn/interrupt') return false;
    return /\bno\s+active\s+turn\s+to\s+interrupt\b/i.test(error.message);
}

function readCode(error: unknown): number | string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && Number.isFinite(code)) return code;
    if (typeof code === 'string' && code.trim()) return code.trim();
    const nestedCode = (error as { error?: { code?: unknown } }).error?.code;
    if (typeof nestedCode === 'number' && Number.isFinite(nestedCode)) return nestedCode;
    if (typeof nestedCode === 'string' && nestedCode.trim()) return nestedCode.trim();
    return null;
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

export function isCodexAppServerInvalidParamsError(error: unknown): boolean {
    const code = readCode(error);
    if (code === -32602 || code === 'InvalidParams' || code === 'invalid_params') return true;
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

export function isCodexAppServerApplicationRejectionForMethod(
    error: unknown,
    method: string,
): boolean {
    if (!(error instanceof Error) || error.name !== 'JsonRpcApplicationError') return false;
    return (error as Partial<CodexAppServerRpcError>).method === method;
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
