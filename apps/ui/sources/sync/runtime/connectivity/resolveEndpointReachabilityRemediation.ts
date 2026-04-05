import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import type { TranslationKey } from '@/text/i18n';

type ReachabilityFailureStatus = Extract<ReadinessProbeResult['status'], 'server_unreachable' | 'retry_later' | 'auth_failed'>;

export type EndpointReachabilityRemediationAction = Readonly<
    | {
        id: 'retry';
        kind: 'retry';
        labelKey: 'common.retry';
    }
    | {
        id: 'install_tailscale';
        kind: 'external-url';
        labelKey: 'server.reachabilityRemediation.tailscale.installAction';
        url: string;
    }
    | {
        id: 'prepare_tailscale';
        kind: 'callback';
        labelKey: 'server.reachabilityRemediation.tailscale.desktopPrepareAction';
        callbackSlot: 'tailscale.ensureReady';
    }
>;

export type EndpointReachabilityRemediation = Readonly<{
    kind: 'tailscale_unreachable';
    provider: 'tailscale';
    titleKey: TranslationKey;
    bodyKey: TranslationKey;
    actions: ReadonlyArray<EndpointReachabilityRemediationAction>;
}>;

type EndpointReachabilityRemediationParams = Readonly<{
    endpointUrl: string;
    readiness: Readonly<{
        status: ReachabilityFailureStatus;
        errorMessage?: string | null;
    }>;
    platformOs?: string;
    isDesktopShell?: boolean;
}>;

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

export function resolveEndpointReachabilityRemediation(
    params: EndpointReachabilityRemediationParams,
): EndpointReachabilityRemediation | null {
    if (params.readiness.status !== 'server_unreachable') {
        return null;
    }

    const hostname = normalizeHostname(params.endpointUrl);
    if (!isTailscaleHostname(hostname)) {
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
