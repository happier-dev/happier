import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import type { TranslationKey } from '@/text/i18n';

export type ReachabilityFailureStatus = Extract<
    ReadinessProbeResult['status'],
    'server_unreachable' | 'retry_later' | 'auth_failed'
>;

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

export type EndpointReachabilityRemediationParams = Readonly<{
    endpointUrl: string;
    readiness: Readonly<{
        status: ReachabilityFailureStatus;
        errorMessage?: string | null;
    }>;
    platformOs?: string;
    isDesktopShell?: boolean;
}>;

export type EndpointReachabilityRemediationProviderId = EndpointReachabilityRemediation['provider'];

export type EndpointReachabilityRemediationDefinition = Readonly<{
    providerId: EndpointReachabilityRemediationProviderId;
    matchesEndpoint: (endpointUrl: string) => boolean;
    resolveRemediation: (
        params: EndpointReachabilityRemediationParams,
    ) => EndpointReachabilityRemediation | null;
}>;
