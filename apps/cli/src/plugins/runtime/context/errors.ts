type PluginRuntimeErrorKind =
    | 'abort'
    | 'timeout'
    | 'permission'
    | 'network'
    | 'unsupported'
    | 'transient'
    | 'unknown';

export type ClassifiedPluginRuntimeError = Readonly<{
    kind: PluginRuntimeErrorKind;
    code: string | null;
    message: string;
    retryable: boolean;
}>;

type PluginErrorsService = Readonly<{
    classify(error: unknown): ClassifiedPluginRuntimeError;
    wrap(error: unknown, fallbackCode?: string): Error;
    report(error: unknown, fields?: Readonly<Record<string, unknown>>): void;
}>;

export class PluginContextServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PluginContextServiceError';
        this.code = code;
    }
}

function readErrorCode(error: unknown): string | null {
    if (!(error instanceof Error)) {
        return null;
    }
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' && code.trim().length > 0 ? code : null;
}

export function classifyRuntimeError(error: unknown): ClassifiedPluginRuntimeError {
    const code = readErrorCode(error);
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'AbortError' || code === 'ABORT_ERR') {
        return Object.freeze({ kind: 'abort', code, message, retryable: false });
    }
    if (code === 'ETIMEDOUT' || code === 'PLUGIN_TIMEOUT') {
        return Object.freeze({ kind: 'timeout', code, message, retryable: true });
    }
    if (code?.includes('PERMISSION') || code?.includes('DENIED')) {
        return Object.freeze({ kind: 'permission', code, message, retryable: false });
    }
    if (code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
        return Object.freeze({ kind: 'network', code, message, retryable: true });
    }
    if (code === 'UNSUPPORTED' || code?.includes('UNAVAILABLE')) {
        return Object.freeze({ kind: 'unsupported', code, message, retryable: false });
    }
    if (code === 'EPIPE' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
        return Object.freeze({ kind: 'transient', code, message, retryable: true });
    }
    return Object.freeze({ kind: 'unknown', code, message, retryable: false });
}

export function createPluginErrorsService(params?: Readonly<{
    report?: (classification: ClassifiedPluginRuntimeError, fields?: Readonly<Record<string, unknown>>) => void;
}>): PluginErrorsService {
    const service: PluginErrorsService = Object.freeze({
        classify: classifyRuntimeError,
        wrap(error: unknown, fallbackCode?: string): Error {
            if (error instanceof Error) {
                return error;
            }
            return new PluginContextServiceError(fallbackCode ?? 'PLUGIN_RUNTIME_ERROR', String(error));
        },
        report(error: unknown, fields?: Readonly<Record<string, unknown>>): void {
            params?.report?.(classifyRuntimeError(error), fields);
        },
    });
    return service;
}
