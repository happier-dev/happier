import {
    getRelayAccessProviderDescriptor,
} from '@happier-dev/cli-common/relayAccess/catalog';
import { normalizeRelayAccessCanonicalPublicServerUrl } from '@happier-dev/cli-common/relayAccess';
import type {
    RelayAccessConfig,
    RelayAccessProviderId,
    RelayAccessStatus,
} from '@happier-dev/cli-common/relayAccess';

import type {
    AccessEndpoint,
    AccessEndpointClientContext,
    AccessEndpointDiagnostic,
    AccessEndpointReachability,
    AccessEndpointRemediationAction,
    AccessEndpointStatus,
} from '../accessEndpointModel';
import { createAccessEndpointRemediationAction } from '../accessEndpointRemediation';
import {
    classifyAccessEndpointHostedHttpsCompatibility,
    deriveAccessEndpointWsBaseUrl,
} from '../classifyAccessEndpoint';

export type RelayAccessEndpointInput = Readonly<{
    config: RelayAccessConfig;
    status: RelayAccessStatus;
}>;

function relayAccessStatusToEndpointStatus(params: Readonly<{
    status: RelayAccessStatus;
    httpBaseUrl: string | null;
}>): AccessEndpointStatus {
    if (params.status.state === 'enabled' && !params.httpBaseUrl) return 'requires-configuration';

    switch (params.status.state) {
        case 'enabled':
            return 'available';
        case 'needs_auth':
            return 'needs-auth';
        case 'error':
            return 'unavailable';
        case 'unknown':
            return 'unknown';
        case 'disabled':
            return 'requires-configuration';
        default:
            return 'unknown';
    }
}

function relayAccessProviderReachability(providerId: RelayAccessProviderId): AccessEndpointReachability {
    switch (providerId) {
        case 'localOnly':
            return 'loopback';
        case 'lan':
            return 'lan';
        case 'tailscaleServe':
            return 'private-network';
        case 'tailscaleFunnel':
        case 'cloudflareNamed':
            return 'public';
        default:
            return 'public';
    }
}

function readDetailsReason(details: unknown): string | null {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const reason = (details as Readonly<Record<string, unknown>>).reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

function isTailscaleProvider(providerId: RelayAccessProviderId): boolean {
    return providerId === 'tailscaleServe' || providerId === 'tailscaleFunnel';
}

function isTailscaleInstallReason(reason: string | null): boolean {
    return reason === 'tailscale_not_installed' || reason === 'tailscale_command_not_found';
}

function relayAccessRemediationActions(params: Readonly<{
    providerId: RelayAccessProviderId;
    status: RelayAccessStatus;
    httpBaseUrl: string | null;
}>): readonly AccessEndpointRemediationAction[] {
    const reason = readDetailsReason(params.status.details);
    if (isTailscaleProvider(params.providerId) && isTailscaleInstallReason(reason)) {
        return [createAccessEndpointRemediationAction('tailscale.install')];
    }

    if (params.providerId === 'cloudflareNamed') {
        return params.status.state === 'enabled' && params.httpBaseUrl ? [] : [createAccessEndpointRemediationAction('cloudflare.configure')];
    }

    if (params.providerId === 'tailscaleServe') {
        if (reason === 'tailscale_serve_approval_required') {
            return [createAccessEndpointRemediationAction('tailscale.serve.approve')];
        }
        if (params.status.state === 'needs_auth') {
            return [createAccessEndpointRemediationAction('tailscale.login')];
        }
        return params.status.state === 'enabled' && params.httpBaseUrl ? [] : [createAccessEndpointRemediationAction('tailscale.serve.enable')];
    }

    if (params.providerId === 'tailscaleFunnel') {
        if (reason === 'tailscale_funnel_approval_required') {
            return [createAccessEndpointRemediationAction('tailscale.funnel.approve')];
        }
        if (params.status.state === 'needs_auth') {
            return [createAccessEndpointRemediationAction('tailscale.login')];
        }
        if (params.status.state === 'enabled' && !params.httpBaseUrl) {
            return [createAccessEndpointRemediationAction('tailscale.funnel.approve')];
        }
    }

    return [];
}

function relayAccessDiagnostics(status: RelayAccessStatus): readonly AccessEndpointDiagnostic[] | undefined {
    const reason = readDetailsReason(status.details);
    if (!reason) return undefined;
    return [{
        id: `relay-access.${reason}`,
        severity: status.state === 'error' ? 'error' : 'warning',
        message: `relay-access.${reason}`,
    }];
}

function relayAccessDiagnosticsWithUrlStatus(params: Readonly<{
    status: RelayAccessStatus;
    httpBaseUrl: string | null;
}>): readonly AccessEndpointDiagnostic[] | undefined {
    const diagnostics = relayAccessDiagnostics(params.status) ?? [];
    if (params.httpBaseUrl || params.status.state !== 'enabled') {
        return diagnostics.length > 0 ? diagnostics : undefined;
    }

    return [
        ...diagnostics,
        {
            id: 'relay-access.share-url.missing-or-invalid',
            severity: 'warning',
            message: 'relay-access.share-url.missing-or-invalid',
        },
    ];
}

export function buildRelayAccessEndpoints(params: Readonly<{
    relayAccess: readonly RelayAccessEndpointInput[];
    clientContext: AccessEndpointClientContext;
}>): readonly AccessEndpoint[] {
    const endpoints: AccessEndpoint[] = [];

    for (const input of params.relayAccess) {
        const providerId = input.config.providerId;
        const httpBaseUrl = normalizeRelayAccessCanonicalPublicServerUrl(input.status.shareUrl);
        const descriptor = getRelayAccessProviderDescriptor(providerId);
        const wsBaseUrl = httpBaseUrl ? deriveAccessEndpointWsBaseUrl(httpBaseUrl) : null;
        const remediationActions = relayAccessRemediationActions({ providerId, status: input.status, httpBaseUrl });
        const diagnostics = relayAccessDiagnosticsWithUrlStatus({
            status: input.status,
            httpBaseUrl,
        });
        const endpointHttpBaseUrl = httpBaseUrl ?? '';

        endpoints.push({
            id: `relay-access:${providerId}`,
            label: descriptor.title,
            source: 'relay-access',
            providerId,
            reachability: relayAccessProviderReachability(providerId),
            hostedHttpsCompatibility: httpBaseUrl
                ? classifyAccessEndpointHostedHttpsCompatibility({
                    httpBaseUrl,
                    clientContext: params.clientContext,
                })
                : 'requires-configuration',
            durability: 'persistent',
            status: relayAccessStatusToEndpointStatus({
                status: input.status,
                httpBaseUrl,
            }),
            httpBaseUrl: endpointHttpBaseUrl,
            ...(wsBaseUrl ? { wsBaseUrl } : {}),
            ...(diagnostics ? { diagnostics } : {}),
            ...(remediationActions.length > 0 ? { remediationActions } : {}),
        });
    }

    return endpoints;
}
