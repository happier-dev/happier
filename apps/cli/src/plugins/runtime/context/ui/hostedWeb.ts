import type {
    PluginLocalServicesService,
    PluginLocalServiceRuntimeSnapshot,
} from '../localServices';
import type { PluginHostedWebRuntimeModeV1 } from '@happier-dev/protocol/plugins/ui';

export type HostedWebRuntimeEndpointResolution =
    | Readonly<{
        state: 'ready';
        endpointUrl: string;
        expiresAt: number | null;
        diagnostics: readonly string[];
    }>
    | Readonly<{
        state: 'fallback';
        reason: 'static_asset_unavailable' | 'managed_service_unavailable' | 'managed_service_starting' | 'managed_service_unhealthy' | 'preview_expired' | 'preview_unavailable';
        diagnostics: readonly string[];
    }>;

export type HostedWebRuntimeEndpointPreview = Readonly<{
    accessUrl?: string | null;
    expiresAt?: number | null;
}>;

export type HostedWebRegisteredEndpointPreviewResolver = Readonly<{
    resolve(
        endpointIdPath: string,
    ): Promise<HostedWebRuntimeEndpointPreview | null> | HostedWebRuntimeEndpointPreview | null;
}>;

function normalizeDiagnostics(snapshot: PluginLocalServiceRuntimeSnapshot): readonly string[] {
    return snapshot.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) => code.trim().length > 0);
}

function resolveReadyPreview(params: Readonly<{
    preview?: HostedWebRuntimeEndpointPreview | null;
    nowMs: number;
}>): HostedWebRuntimeEndpointResolution | null {
    const expiresAt = params.preview?.expiresAt ?? null;
    if (typeof expiresAt === 'number' && expiresAt <= params.nowMs) {
        return Object.freeze({
            state: 'fallback',
            reason: 'preview_expired',
            diagnostics: Object.freeze(['hosted_web_preview_expired']),
        });
    }
    const accessUrl = params.preview?.accessUrl?.trim();
    if (accessUrl) {
        return Object.freeze({
            state: 'ready',
            endpointUrl: accessUrl,
            expiresAt,
            diagnostics: Object.freeze([]),
        });
    }
    return null;
}

function classifyManagedSnapshot(snapshot: PluginLocalServiceRuntimeSnapshot): HostedWebRuntimeEndpointResolution {
    const diagnostics = normalizeDiagnostics(snapshot);
    if (snapshot.phase === 'starting' || snapshot.phase === 'detecting' || snapshot.phase === 'stopped') {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_starting',
            diagnostics: Object.freeze(diagnostics.length > 0 ? diagnostics : ['hosted_web_managed_service_starting']),
        });
    }
    if (snapshot.phase === 'unhealthy') {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_unhealthy',
            diagnostics: Object.freeze(diagnostics.length > 0 ? diagnostics : ['hosted_web_managed_service_unhealthy']),
        });
    }
    return Object.freeze({
        state: 'fallback',
        reason: 'managed_service_unavailable',
        diagnostics: Object.freeze(diagnostics.length > 0 ? diagnostics : ['hosted_web_managed_service_unavailable']),
    });
}

function readyAccessUrl(accessUrl: string | null | undefined): HostedWebRuntimeEndpointResolution | null {
    const endpointUrl = accessUrl?.trim();
    if (!endpointUrl) {
        return null;
    }
    return Object.freeze({
        state: 'ready',
        endpointUrl,
        expiresAt: null,
        diagnostics: Object.freeze([]),
    });
}

export async function resolveHostedWebRuntimeEndpoint(input: Readonly<{
    runtimeMode: PluginHostedWebRuntimeModeV1;
    preview?: HostedWebRuntimeEndpointPreview | null;
    registeredEndpointPreview?: HostedWebRegisteredEndpointPreviewResolver | null;
    localServices?: PluginLocalServicesService | null;
    nowMs?: () => number;
}>): Promise<HostedWebRuntimeEndpointResolution> {
    const nowMs = input.nowMs?.() ?? Date.now();
    const readyPreview = resolveReadyPreview({ preview: input.preview, nowMs });
    if (readyPreview) {
        return readyPreview;
    }

    if (input.runtimeMode.kind === 'installedStaticAssets') {
        // §6.1: installed static-asset endpoints are served by the daemon
        // static-asset server and surfaced through the local-service preview
        // registry (`mintPrivatePreviewAccessUrl`), never as a raw loopback URL
        // baked into the runtime context. A static-asset mode with no ready
        // preview is simply not served yet.
        return Object.freeze({
            state: 'fallback',
            reason: 'static_asset_unavailable',
            diagnostics: Object.freeze(['static_asset_preview_access_url_unavailable']),
        });
    }

    if (input.runtimeMode.kind === 'registeredSessionEndpoint') {
        const registeredPreview = await input.registeredEndpointPreview?.resolve(input.runtimeMode.endpointIdPath);
        const readyRegisteredPreview = resolveReadyPreview({ preview: registeredPreview, nowMs });
        if (readyRegisteredPreview) {
            return readyRegisteredPreview;
        }
        return Object.freeze({
            state: 'fallback',
            reason: 'preview_unavailable',
            diagnostics: Object.freeze(['registered_endpoint_preview_access_url_unavailable']),
        });
    }

    if (!input.localServices) {
        return Object.freeze({
            state: 'fallback',
            reason: 'managed_service_unavailable',
            diagnostics: Object.freeze(['local_services_runtime_unavailable']),
        });
    }

    const handle = await input.localServices.start(input.runtimeMode.localServiceId);
    const snapshot = handle.snapshot();
    if (snapshot.phase === 'running') {
        const readyEndpoint = readyAccessUrl(snapshot.url);
        return readyEndpoint ?? Object.freeze({
            state: 'fallback',
            reason: 'preview_unavailable',
            diagnostics: Object.freeze(['managed_service_preview_access_url_unavailable']),
        });
    }
    return classifyManagedSnapshot(snapshot);
}
