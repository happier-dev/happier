import type { PluginUiHostedWebProjection } from './projection';

export type HostedWebRuntimeDiagnosticCode =
    | 'hosted_web_bridge_policy_absent'
    | 'hosted_web_fallback_rendering'
    | 'hosted_web_managed_service_starting'
    | 'hosted_web_managed_service_unavailable'
    | 'hosted_web_managed_service_unhealthy'
    | 'hosted_web_preview_expired'
    | 'hosted_web_preview_unavailable'
    | 'hosted_web_static_asset_unavailable';

export type HostedWebRuntimeDiagnosticState =
    | Readonly<{
        state: 'ready';
        endpointUrl: string;
        diagnostics: readonly HostedWebRuntimeDiagnosticCode[];
    }>
    | Readonly<{
        state: 'fallback';
        reason: 'static_asset_unavailable' | 'managed_service_starting' | 'managed_service_unavailable' | 'managed_service_unhealthy' | 'preview_expired' | 'preview_unavailable';
        diagnostics: readonly string[];
    }>;

type LocalServiceDiagnostic = Readonly<{ code: string }>;
type LocalServiceSnapshot = Readonly<{
    id: string;
    phase: string;
    diagnostics: readonly LocalServiceDiagnostic[];
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

function readServiceKind(hostedWeb: PluginUiHostedWebProjection): string | null {
    const service = readRecord(hostedWeb.service);
    const kind = service?.kind;
    return typeof kind === 'string' ? kind : null;
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

function managedServiceDiagnostic(
    hostedWeb: PluginUiHostedWebProjection,
    localService: LocalServiceSnapshot | null | undefined,
): HostedWebRuntimeDiagnosticState {
    if (!localService) {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_unavailable',
            diagnostics: withFallbackDiagnostic(hostedWeb, ['hosted_web_managed_service_unavailable']),
        });
    }

    const serviceDiagnostics = localService.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) => code.trim().length > 0);
    if (localService.phase === 'starting' || localService.phase === 'detecting' || localService.phase === 'stopped') {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_starting',
            diagnostics: withFallbackDiagnostic(hostedWeb, ['hosted_web_managed_service_starting', ...serviceDiagnostics]),
        });
    }
    if (localService.phase === 'unhealthy' || localService.phase === 'failed') {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_unhealthy',
            diagnostics: withFallbackDiagnostic(hostedWeb, ['hosted_web_managed_service_unhealthy', ...serviceDiagnostics]),
        });
    }
    return Object.freeze({
        state: 'fallback',
        reason: 'preview_unavailable',
        diagnostics: withFallbackDiagnostic(hostedWeb, ['hosted_web_preview_unavailable']),
    });
}

export function resolveHostedWebRuntimeDiagnostics(input: Readonly<{
    hostedWeb: PluginUiHostedWebProjection;
    endpointUrl?: string | null;
    expiresAt?: number | null;
    localService?: LocalServiceSnapshot | null;
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

    const serviceKind = readServiceKind(input.hostedWeb);
    if (serviceKind === 'managedService') {
        return managedServiceDiagnostic(input.hostedWeb, input.localService);
    }
    if (serviceKind === 'staticAssets') {
        return Object.freeze({
            state: 'fallback',
            reason: 'static_asset_unavailable',
            diagnostics: withFallbackDiagnostic(input.hostedWeb, ['hosted_web_static_asset_unavailable']),
        });
    }
    return Object.freeze({
        state: 'fallback',
        reason: 'preview_unavailable',
        diagnostics: withFallbackDiagnostic(input.hostedWeb, ['hosted_web_preview_unavailable']),
    });
}
