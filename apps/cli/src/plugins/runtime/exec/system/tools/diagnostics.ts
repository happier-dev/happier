import { basename } from 'node:path';

import type { SystemToolDiagnosticV1 } from '../../privateContract';

import { sanitizeExecDiagnosticText } from '@/plugins/runtime/exec/errors';

/** Safe fields owned by missing-tool resolution and retained by public failure adapters. */
export const MISSING_SYSTEM_TOOL_DETAILS = Object.freeze({
    kind: 'systemToolUnavailable',
    remedy: 'install_on_machine_and_add_to_daemon_path',
} as const);

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

/**
 * A runnable candidate (or a superseded executable name) observably belongs to
 * a retired generation: the ACP fingerprint or the missing current install
 * says so. The detail carries the provider-owned migration guidance; the
 * human-visible message is composed by the resolution owner.
 */
export function createLegacySystemToolDiagnostic(params: Readonly<{
    toolId: string;
    displayName: string;
    observedPath: string;
    guidance: string;
}>): SystemToolDiagnosticV1 {
    return createSystemToolDiagnostic({
        code: 'system_tool_legacy',
        severity: 'error',
        messageKey: 'plugins.exec.systemTools.legacy',
        detail: {
            toolId: params.toolId,
            displayName: params.displayName,
            observedPath: params.observedPath,
            guidance: params.guidance,
        },
    });
}

/**
 * Candidates exist but none answered the capability probe with a recognizable
 * fingerprint. Truthful by construction: the caller names the exact binary it
 * could not identify instead of guessing a generation.
 */
export function createUnidentifiedSystemToolDiagnostic(params: Readonly<{
    toolId: string;
    displayName: string;
    observedPath: string;
    guidance: string;
}>): SystemToolDiagnosticV1 {
    return createSystemToolDiagnostic({
        code: 'system_tool_unidentified',
        severity: 'error',
        messageKey: 'plugins.exec.systemTools.unidentified',
        detail: {
            toolId: params.toolId,
            displayName: params.displayName,
            observedPath: params.observedPath,
            guidance: params.guidance,
        },
    });
}
