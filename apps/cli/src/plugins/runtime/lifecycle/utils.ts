import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';

/**
 * Small shared utilities used across the plugin activation lifecycle modules
 * (contribution reading, activation policy resolution, disposal, and the
 * orchestration entrypoints in `manager.ts`). Kept in one place so extracted
 * lifecycle modules do not each grow their own duplicate copy.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

export function appendDiagnostic(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
    diagnostic: PluginCompatibilityDiagnostic,
): void {
    const existing = diagnosticsByPluginId[pluginId];
    if (existing) {
        existing.push(diagnostic);
        return;
    }
    diagnosticsByPluginId[pluginId] = [diagnostic];
}

export function appendDiagnostics(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
    diagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    for (const diagnostic of diagnostics) {
        appendDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
    }
}

export function normalizePositiveTimeoutMs(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.trunc(value));
}

export async function runWithOptionalTimeout<T>(
    timeoutMs: number | null,
    operation: () => Promise<T>,
    createTimeoutError: () => Error,
): Promise<T> {
    if (timeoutMs === null) {
        return await operation();
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => reject(createTimeoutError()), timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export function mapDaemonModuleLoadErrorToDiagnostic(error: unknown): PluginCompatibilityDiagnostic {
    const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
    return {
        code:
            errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
                ? 'plugin_trust_approval_required'
                : errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
                    ? 'plugin_untrusted'
                    : errorCode === 'PLUGIN_DAEMON_ENTRY_MISSING'
                        ? 'plugin_source_missing'
                        : errorCode === 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
                            ? 'plugin_source_kind_unsupported'
                            : 'plugin_daemon_module_load_failed',
        message: error instanceof Error ? error.message : 'Failed to load plugin daemon module',
    };
}
