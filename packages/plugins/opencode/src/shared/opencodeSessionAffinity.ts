import {
    readOpenCodeSessionAffinityFromMetadata,
    type OpenCodeSessionAffinity,
} from '@happier-dev/agents';

type OpenCodeBackendMode = OpenCodeSessionAffinity['backendMode'];

export { readOpenCodeSessionAffinityFromMetadata };
export type { OpenCodeSessionAffinity };

export function buildOpenCodeSessionEnvironmentVariables(params: Readonly<{
    backendMode: OpenCodeBackendMode | null;
    serverBaseUrl?: string | null;
    serverBaseUrlExplicit?: boolean;
}>): Record<string, string> {
    return {
        ...(params.backendMode ? { HAPPIER_OPENCODE_BACKEND_MODE: params.backendMode } : {}),
        ...(params.serverBaseUrl ? { HAPPIER_OPENCODE_SERVER_URL: params.serverBaseUrl } : {}),
        ...(params.serverBaseUrl && params.serverBaseUrlExplicit ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
    };
}

export function applyOpenCodeSessionAffinityMetadata(params: Readonly<{
    backendMode: OpenCodeBackendMode | null;
    vendorSessionId?: string | null;
    serverBaseUrl?: string | null;
    serverBaseUrlExplicit?: boolean;
}>): Readonly<Record<string, unknown>> {
    const nextVendorSessionId = typeof params.vendorSessionId === 'string' ? params.vendorSessionId.trim() : '';
    const nextServerBaseUrl = params.serverBaseUrlExplicit ? params.serverBaseUrl : null;

    return {
        ...(nextVendorSessionId ? { opencodeSessionId: nextVendorSessionId } : {}),
        ...(params.backendMode ? { opencodeBackendMode: params.backendMode } : {}),
        ...(nextServerBaseUrl ? { opencodeServerBaseUrl: nextServerBaseUrl } : {}),
        ...(nextServerBaseUrl ? { opencodeServerBaseUrlExplicit: true } : {}),
    };
}
