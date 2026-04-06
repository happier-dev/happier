import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationDefinition,
    EndpointReachabilityRemediationParams,
} from '../types';

function normalizeHostname(rawUrl: string): string | null {
    const value = String(rawUrl ?? '').trim();
    if (!value) return null;
    try {
        return new URL(value).hostname.trim().toLowerCase() || null;
    } catch {
        return null;
    }
}

function isTailscaleHostname(hostname: string | null): boolean {
    if (!hostname) return false;
    return hostname.endsWith('.ts.net');
}

function resolveTailscaleInstallUrl(platformOs: string): string {
    switch (platformOs) {
        case 'ios':
            return 'https://tailscale.com/download/ios';
        case 'android':
            return 'https://tailscale.com/download/android';
        default:
            return 'https://tailscale.com/download';
    }
}

function resolveTailscaleRemediation(
    params: EndpointReachabilityRemediationParams,
): EndpointReachabilityRemediation | null {
    if (params.readiness.status !== 'server_unreachable') {
        return null;
    }

    const platformOs = String(params.platformOs ?? '').trim().toLowerCase();
    if (params.isDesktopShell) {
        return {
            kind: 'tailscale_unreachable',
            provider: 'tailscale',
            titleKey: 'server.reachabilityRemediation.tailscale.title',
            bodyKey: 'server.reachabilityRemediation.tailscale.desktopBody',
            actions: [
                {
                    id: 'prepare_tailscale',
                    kind: 'callback',
                    labelKey: 'server.reachabilityRemediation.tailscale.desktopPrepareAction',
                    callbackSlot: 'tailscale.ensureReady',
                },
                {
                    id: 'retry',
                    kind: 'retry',
                    labelKey: 'common.retry',
                },
            ],
        };
    }

    return {
        kind: 'tailscale_unreachable',
        provider: 'tailscale',
        titleKey: 'server.reachabilityRemediation.tailscale.title',
        bodyKey: platformOs === 'web'
            ? 'server.reachabilityRemediation.tailscale.webBody'
            : 'server.reachabilityRemediation.tailscale.nativeBody',
        actions: [
            {
                id: 'install_tailscale',
                kind: 'external-url',
                labelKey: 'server.reachabilityRemediation.tailscale.installAction',
                url: resolveTailscaleInstallUrl(platformOs),
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ],
    };
}

export const tailscaleReachabilityRemediationDefinition: EndpointReachabilityRemediationDefinition = {
    providerId: 'tailscale',
    matchesEndpoint: (endpointUrl) => isTailscaleHostname(normalizeHostname(endpointUrl)),
    resolveRemediation: resolveTailscaleRemediation,
};
