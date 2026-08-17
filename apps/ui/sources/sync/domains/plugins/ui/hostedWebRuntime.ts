import type { PluginUiHostedWebProjection } from './projection';

export type HostedWebRuntimeDiagnosticCode =
    | 'hosted_web_bridge_policy_absent'
    | 'hosted_web_fallback_rendering'
    | 'hosted_web_preview_expired'
    | 'hosted_web_preview_unavailable';

export type HostedWebRuntimeDiagnosticState =
    | Readonly<{
        state: 'ready';
        endpointUrl: string;
        diagnostics: readonly HostedWebRuntimeDiagnosticCode[];
    }>
    | Readonly<{
        state: 'fallback';
        reason: 'preview_expired' | 'preview_unavailable';
        diagnostics: readonly string[];
    }>;

const EMPTY_HOSTED_WEB_RUNTIME_DIAGNOSTICS: readonly HostedWebRuntimeDiagnosticCode[] = Object.freeze([]);
const BRIDGE_POLICY_ABSENT_DIAGNOSTICS: readonly HostedWebRuntimeDiagnosticCode[] = Object.freeze([
    'hosted_web_bridge_policy_absent',
]);

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function hasBridgePolicy(hostedWeb: PluginUiHostedWebProjection): boolean {
    const allowedMessages = readRecord(hostedWeb.bridge)?.allowedMessages;
    return Array.isArray(allowedMessages)
        && allowedMessages.some((message) => typeof message === 'string' && message.length > 0);
}

function hasRenderableFallback(hostedWeb: PluginUiHostedWebProjection): boolean {
    const fallbackKind = readRecord(hostedWeb.fallback)?.kind;
    return fallbackKind === 'descriptor'
        || fallbackKind === 'structuredMessage'
        || fallbackKind === 'hostedWeb';
}

function withFallbackDiagnostic(
    hostedWeb: PluginUiHostedWebProjection,
    diagnostics: readonly string[],
): readonly string[] {
    return hasRenderableFallback(hostedWeb)
        ? Object.freeze([...diagnostics, 'hosted_web_fallback_rendering'])
        : diagnostics;
}

function readEndpointUrl(endpointUrl: string | null | undefined): string | null {
    if (typeof endpointUrl !== 'string' || endpointUrl.trim().length === 0) {
        return null;
    }
    try {
        const parsed = new URL(endpointUrl);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? endpointUrl : null;
    } catch {
        return null;
    }
}

export function resolveHostedWebRuntimeDiagnostics(input: Readonly<{
    hostedWeb: PluginUiHostedWebProjection;
    endpointUrl?: string | null;
    expiresAt?: number | null;
    nowMs: number;
}>): HostedWebRuntimeDiagnosticState {
    if (typeof input.expiresAt === 'number' && input.expiresAt <= input.nowMs) {
        return Object.freeze({
            state: 'fallback',
            reason: 'preview_expired',
            diagnostics: withFallbackDiagnostic(input.hostedWeb, ['hosted_web_preview_expired']),
        });
    }

    const endpointUrl = readEndpointUrl(input.endpointUrl);
    if (endpointUrl) {
        return Object.freeze({
            state: 'ready',
            endpointUrl,
            diagnostics: hasBridgePolicy(input.hostedWeb)
                ? EMPTY_HOSTED_WEB_RUNTIME_DIAGNOSTICS
                : BRIDGE_POLICY_ABSENT_DIAGNOSTICS,
        });
    }

    // Frame-adapter readiness is projected by the daemon from the UI's exact
    // host fact. This endpoint consumer must not recreate a competing
    // platform-based adapter decision: an admitted frame can still lack an
    // Artifact/preview endpoint, which is a separate runtime failure.
    return Object.freeze({
        state: 'fallback',
        reason: 'preview_unavailable',
        diagnostics: withFallbackDiagnostic(input.hostedWeb, ['hosted_web_preview_unavailable']),
    });
}
