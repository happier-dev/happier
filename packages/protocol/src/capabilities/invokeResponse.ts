import type { CapabilitiesInvokeResponse } from './index.js';
import { readSessionRuntimeFailureCause } from '../sessions/control/runtimeIssueV1.js';
import { isRecord } from '../inputs/inputRecords.js';

export function parseCapabilitiesInvokeResponse(raw: unknown): CapabilitiesInvokeResponse | null {
    if (!isRecord(raw)) return null;
    const ok = raw.ok;
    if (typeof ok !== 'boolean') return null;
    if (ok) {
        return { ok: true, result: raw.result };
    }
    const error = raw.error;
    if (!isRecord(error) || typeof error.message !== 'string') return null;
    const code = error.code;
    const logPath = raw.logPath;
    const failureCause = readSessionRuntimeFailureCause(error);
    return {
        ok: false,
        error: { message: error.message, ...(typeof code === 'string' ? { code } : {}),
            ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
            ...(failureCause ? { failureCause } : {}) },
        ...((typeof logPath === 'string') ? { logPath } : {}),
    };
}
