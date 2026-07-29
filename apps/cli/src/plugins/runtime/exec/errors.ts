import type { ExecClientDiagnosticSanitizerV1 } from './privateContract';

import { sanitizeRpcDiagnosticString } from './diagnostics/sanitize';

export type PluginExecClientErrorCode =
    | 'PLUGIN_EXEC_CLIENT_ABORTED'
    | 'PLUGIN_EXEC_CLIENT_DISPOSED'
    | 'PLUGIN_EXEC_CLIENT_EXITED'
    | 'PLUGIN_EXEC_CLIENT_METHOD_NOT_FOUND'
    | 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR'
    | 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT'
    | (string & {});

export class PluginExecClientError extends Error {
    readonly code: PluginExecClientErrorCode;
    readonly stderrPreview?: string;

    constructor(
        code: PluginExecClientErrorCode,
        message: string,
        options: Readonly<{ cause?: unknown; stderrPreview?: string }> = {},
    ) {
        super(message, { cause: options.cause });
        this.name = 'PluginExecClientError';
        this.code = code;
        this.stderrPreview = options.stderrPreview;
    }
}

export function sanitizeExecDiagnosticText(
    value: string,
    maxBytes: number,
    sanitizer?: ExecClientDiagnosticSanitizerV1,
): string {
    const sanitizerMaxBytes = typeof sanitizer?.maxStringBytes === 'number' && Number.isFinite(sanitizer.maxStringBytes) && sanitizer.maxStringBytes > 0
        ? Math.trunc(sanitizer.maxStringBytes)
        : undefined;
    const maxStringBytes = maxBytes < 0
        ? sanitizerMaxBytes ?? Number.MAX_SAFE_INTEGER
        : Math.min(sanitizerMaxBytes ?? maxBytes, maxBytes);
    const redacted = sanitizeRpcDiagnosticString(value, {
        ...(sanitizer ?? {}),
        maxStringBytes,
    });
    if (maxBytes < 0 || Buffer.byteLength(redacted) <= maxBytes) {
        return redacted;
    }
    return Buffer.from(redacted).subarray(0, maxBytes).toString('utf8');
}

export function createPluginExecClientAbortError(): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_ABORTED', 'Plugin exec client request was aborted');
}
