import { basename } from 'node:path';

import type { SystemToolDiagnosticV1 } from '../../privateContract';

import { sanitizeExecDiagnosticText } from '@/plugins/runtime/exec/errors';

const DIAGNOSTIC_DETAIL_MAX_BYTES = 240;

function sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return sanitizeExecDiagnosticText(value, DIAGNOSTIC_DETAIL_MAX_BYTES);
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            out[key] = sanitizeValue(nestedValue);
        }
        return Object.freeze(out);
    }
    return value;
}

export function createSystemToolDiagnostic(params: Readonly<{
    code: string;
    severity: SystemToolDiagnosticV1['severity'];
    messageKey: string;
    detail?: Readonly<Record<string, unknown>>;
}>): SystemToolDiagnosticV1 {
    return Object.freeze({
        code: params.code,
        severity: params.severity,
        messageKey: params.messageKey,
        ...(params.detail ? { detail: sanitizeValue(params.detail) as Readonly<Record<string, unknown>> } : {}),
    });
}

export function createMissingSystemToolDiagnostic(params: Readonly<{
    toolId: string;
    displayName: string;
    executablePath?: string | null;
    lookupNames?: readonly string[];
}>): SystemToolDiagnosticV1 {
    return createSystemToolDiagnostic({
        code: 'system_tool_missing',
        severity: 'error',
        messageKey: 'plugins.exec.systemTools.missing',
        detail: {
            toolId: params.toolId,
            displayName: params.displayName,
            executableName: params.executablePath ? basename(params.executablePath) : null,
            lookupNames: params.lookupNames ?? [],
        },
    });
}
