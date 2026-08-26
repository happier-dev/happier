import {
    PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
    projectPluginFailureMessage,
    projectPluginFailureText,
    trimBugReportTextHeadToMaxBytes,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import {
    findPluginDiagnosticSourceLocation,
    normalizePluginDiagnosticSourceRoot,
    prefixPluginDiagnosticSourceLocation,
    type PluginDiagnosticSourceLocation,
} from '../../validation/diagnostics/sourceLocation';

/**
 * Small shared utilities used across the plugin activation lifecycle modules
 * (contribution reading, activation policy resolution, disposal, and the
 * orchestration entrypoints in `manager.ts`). Kept in one place so extracted
 * lifecycle modules do not each grow their own duplicate copy.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

export {
    PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
    projectPluginFailureMessage,
    projectPluginFailureText,
} from '@happier-dev/protocol';

/**
 * The local-development realm marker. A caller supplies the author's
 * authenticated project root ONLY for a locally trusted development plugin;
 * every other caller omits it and receives the ordinary redacted projection.
 */
export type PluginFailureDiagnosticRealm = Readonly<{
    localDevelopmentSourceRoot?: string;
}>;

export type PluginFailureDiagnosticProjection = Readonly<{
    message: string;
    source?: PluginDiagnosticSourceLocation;
    stack?: string;
}>;

function readPluginFailureErrorField(
    error: unknown,
    field: 'message' | 'stack' | 'cause',
): unknown {
    try {
        if (!(error instanceof Error)) return null;
        return (error as Error & Readonly<Record<typeof field, unknown>>)[field];
    } catch {
        return null;
    }
}

function readPluginFailureText(error: unknown, field: 'message' | 'stack'): string | null {
    const value = readPluginFailureErrorField(error, field);
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The diagnostic texts a failure can hide a source location in, most
 * authoritative first. Jiti and the module loader report a location in the
 * wrapper's message; the underlying syntax or resolution error carries it on
 * the cause's stack.
 */
function readPluginFailureLocationTexts(error: unknown): readonly (string | null)[] {
    const cause = readPluginFailureErrorField(error, 'cause');
    return [
        readPluginFailureText(error, 'message'),
        readPluginFailureText(error, 'stack'),
        readPluginFailureText(cause, 'message'),
        readPluginFailureText(cause, 'stack'),
    ];
}

/**
 * Rebase a stack onto the author's own project root, then redact it.
 *
 * Frames inside the authenticated root become root-relative and stay readable;
 * every remaining absolute path belongs to the host or to another project and
 * is removed by the same redactor that owns the message. Only a
 * local-development caller ever reaches this function.
 */
function projectLocalDevelopmentStack(
    error: unknown,
    sourceRoot: string,
): string | undefined {
    try {
        const normalizedRoot = normalizePluginDiagnosticSourceRoot(sourceRoot);
        const cause = readPluginFailureErrorField(error, 'cause');
        const candidates = [
            readPluginFailureText(error, 'stack'),
            readPluginFailureText(cause, 'stack'),
        ].filter((value): value is string => value !== null)
            .map((value) => value.replaceAll('\\', '/'));
        // An Error's stack opens with its own message, so "mentions the root"
        // is not evidence that this stack has author frames. Prefer the stack
        // whose CALL FRAMES name the root — with a wrapped module-load failure
        // that is the cause, never the wrapper.
        const stack = candidates.find((value) => value
            .split('\n')
            .some((line) => /^\s*at\s/u.test(line) && line.includes(normalizedRoot)))
            ?? candidates.find((value) => value.includes(normalizedRoot))
            ?? candidates[0];
        if (!stack) return undefined;
        const rebased = stack
            .replaceAll(`${normalizedRoot}/`, '')
            .replaceAll(normalizedRoot, '.');
        const redacted = projectPluginFailureMessage(rebased).trim();
        if (!redacted) return undefined;
        const bounded = trimBugReportTextHeadToMaxBytes(
            redacted,
            PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
        ).trim();
        return bounded || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The one lifecycle projection of a plugin failure into a publishable
 * diagnostic. It always produces the redacted message; it additionally
 * produces an author-actionable source location and stack when — and only
 * when — the caller identified the failure as belonging to a locally trusted
 * development plugin by supplying its authenticated project root.
 *
 * The location is repeated as a `file:line:column: ` message prefix because
 * published diagnostic sinks (the protocol diagnostic record, the daemon log,
 * the CLI stage report's human text) carry text only. Both come from this one
 * resolution, so the structured field and the message can never disagree.
 */
export function projectPluginFailureDiagnostic(
    error: unknown,
    realm: PluginFailureDiagnosticRealm = {},
): PluginFailureDiagnosticProjection {
    const message = projectPluginFailureText(error);
    const sourceRoot = realm.localDevelopmentSourceRoot?.trim();
    if (!sourceRoot) return { message };
    const source = findPluginDiagnosticSourceLocation({
        texts: readPluginFailureLocationTexts(error),
        sourceRoot,
    });
    const stack = projectLocalDevelopmentStack(error, sourceRoot);
    if (!source) {
        return { message, ...(stack ? { stack } : {}) };
    }
    const located = trimBugReportTextHeadToMaxBytes(
        prefixPluginDiagnosticSourceLocation(source, message),
        PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
    ).trim();
    return {
        message: located || message,
        source,
        ...(stack ? { stack } : {}),
    };
}

function readDaemonModuleLoadErrorCode(error: unknown): string {
    try {
        if (!(error instanceof Error)) return '';
        const code = (error as Error & { code?: unknown }).code;
        return typeof code === 'string' ? code : '';
    } catch {
        return '';
    }
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

export function mapDaemonModuleLoadErrorToDiagnostic(
    error: unknown,
    options: PluginFailureDiagnosticRealm = {},
): PluginCompatibilityDiagnostic {
    const errorCode = readDaemonModuleLoadErrorCode(error);
    const projected = projectPluginFailureDiagnostic(error, options);
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
        ...projected,
    };
}
