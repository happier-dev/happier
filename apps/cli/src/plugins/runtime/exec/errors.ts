import { trimBugReportTextHeadToMaxBytes } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';

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

/**
 * Exec-client failures cross the plugin ABI, so they ARE canonical PluginErrors:
 * the `PLUGIN_EXEC_CLIENT_*` vocabulary lives in `PluginError.code` and the class
 * only adds the private exec diagnostics the host protocol adapters read back.
 * Never assign `name` here - `isPluginError` recognizes the contract by name+data.
 */
export class PluginExecClientError extends PluginError {
    readonly stderrPreview?: string;
    readonly cleanProcessExit?: boolean;

    constructor(
        code: PluginExecClientErrorCode,
        message: string,
        options: Readonly<{
            cause?: unknown;
            stderrPreview?: string;
            cleanProcessExit?: boolean;
            details?: JsonValue;
        }> = {},
    ) {
        super(
            {
                code,
                message,
                ...(options.details === undefined ? {} : { details: options.details }),
            },
            { cause: options.cause },
        );
        this.stderrPreview = options.stderrPreview;
        this.cleanProcessExit = options.cleanProcessExit;
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
    return trimBugReportTextHeadToMaxBytes(redacted, maxBytes);
}

export function createPluginExecClientAbortError(): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_ABORTED', 'Plugin exec client request was aborted');
}

export function createPluginExecClientExitError(
    termination: Readonly<{
        exitCode: number | null;
        signal: string | null;
        diagnostic?: string;
    }>,
    stderrPreview?: string,
): PluginExecClientError {
    const terminalDescription = termination.exitCode !== null
        ? `exited with exit code ${termination.exitCode}`
        : termination.signal !== null
            ? `terminated by signal ${termination.signal}`
            : termination.diagnostic
                ? `failed: ${termination.diagnostic}`
                : 'terminated without an exit code or signal';
    const preview = stderrPreview?.trim();
    return new PluginExecClientError(
        'PLUGIN_EXEC_CLIENT_EXITED',
        `Plugin exec client process ${terminalDescription}${preview ? `: ${preview}` : ''}`,
        {
            ...(preview ? { stderrPreview: preview } : {}),
            cleanProcessExit: termination.exitCode === 0
                && termination.signal === null
                && termination.diagnostic === undefined,
        },
    );
}
