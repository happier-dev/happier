import {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/plugins/ui';

import { log } from '@/log';

/**
 * The single Plugin UI diagnostic formatter and sink.
 *
 * Both the plugin-authored `hostApi.diagnostic` producer and the host's own
 * surface-failure reporting name the same three identifiers, are redacted and
 * byte-capped by the same rule, and land in the same `/dev/logs` buffer. Keeping
 * one owner is what makes a failed surface attributable at all: before this,
 * a host-side load/render failure named nothing anywhere.
 */

/** Attribution every Plugin UI diagnostic carries. Structurally a `PluginUiSurfaceContextV1` subset. */
export type PluginSurfaceDiagnosticIdentity = Readonly<{
    pluginId: string | null;
    contributionId: string | null;
    surfaceId: string;
}>;

export function formatPluginSurfaceDiagnosticLogMessage(
    surface: PluginSurfaceDiagnosticIdentity,
    diagnostic: unknown,
): string {
    const raw = `[plugin-ui-host-api] ${JSON.stringify({
        pluginId: surface.pluginId,
        contributionId: surface.contributionId,
        surfaceId: surface.surfaceId,
        diagnostic,
    })}`;
    return trimBugReportTextToMaxBytes(
        redactBugReportSensitiveText(raw),
        PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1,
    );
}

/** Reports one diagnostic. Returns whether the sink accepted it; it never throws at a caller. */
export function logPluginSurfaceDiagnostic(
    surface: PluginSurfaceDiagnosticIdentity,
    diagnostic: unknown,
): boolean {
    try {
        log.log(formatPluginSurfaceDiagnosticLogMessage(surface, diagnostic));
        return true;
    } catch {
        return false;
    }
}

/**
 * The attributable part of a thrown value. The stack stays out: it names host
 * bundle internals rather than the plugin, and would dominate the byte cap.
 */
export function readPluginSurfaceDiagnosticError(
    error: unknown,
): Readonly<{ name: string; message: string }> | null {
    if (error instanceof Error) {
        return Object.freeze({ name: error.name, message: error.message });
    }
    if (typeof error === 'string' && error.length > 0) {
        return Object.freeze({ name: 'string', message: error });
    }
    return null;
}
