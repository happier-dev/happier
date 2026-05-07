import type {
    AccessEndpoint,
    AccessEndpointClientContext,
    AccessEndpointReachability,
} from '../model';
import {
    classifyAccessEndpointHostedHttpsCompatibility,
    classifyAccessEndpointReachability,
    deriveAccessEndpointWsBaseUrl,
    normalizeAccessEndpointHttpBaseUrl,
} from '../classify';

export type LocalRuntimeAccessEndpointCandidate = Readonly<{
    url: string;
    source: 'tailscale-serve' | 'tailscale-ip' | 'lan' | 'network-interface' | string;
    label: string;
    detail: string | null;
    verified: boolean;
}>;

function localRuntimeReachability(candidate: LocalRuntimeAccessEndpointCandidate, httpBaseUrl: string): AccessEndpointReachability {
    if (candidate.source === 'tailscale-serve' || candidate.source === 'tailscale-ip') return 'private-network';
    if (candidate.source === 'lan' || candidate.source === 'network-interface') return 'lan';
    return classifyAccessEndpointReachability(httpBaseUrl);
}

export function buildLocalRuntimeAccessEndpoints(params: Readonly<{
    candidates: readonly LocalRuntimeAccessEndpointCandidate[];
    clientContext: AccessEndpointClientContext;
}>): readonly AccessEndpoint[] {
    const endpoints: AccessEndpoint[] = [];

    for (const candidate of params.candidates) {
        const httpBaseUrl = normalizeAccessEndpointHttpBaseUrl(candidate.url);
        if (!httpBaseUrl) continue;
        const wsBaseUrl = deriveAccessEndpointWsBaseUrl(httpBaseUrl);
        endpoints.push({
            id: `local-runtime:${candidate.source}:${httpBaseUrl}`,
            label: candidate.label,
            source: 'local-runtime',
            reachability: localRuntimeReachability(candidate, httpBaseUrl),
            hostedHttpsCompatibility: classifyAccessEndpointHostedHttpsCompatibility({
                httpBaseUrl,
                clientContext: params.clientContext,
            }),
            durability: 'session',
            status: candidate.verified ? 'available' : 'unknown',
            httpBaseUrl,
            ...(wsBaseUrl ? { wsBaseUrl } : {}),
            ...(candidate.detail
                ? {
                    diagnostics: [{
                        id: 'local-runtime.candidate-detail',
                        severity: 'info',
                        message: 'local-runtime.candidate-detail',
                        detail: candidate.detail,
                    }],
                }
                : {}),
        });
    }

    return endpoints;
}
