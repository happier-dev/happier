import {
    relayAccessProviderDescriptors,
    parseRelayAccessConfig,
    type RelayAccessProviderDescriptor,
} from '@happier-dev/cli-common/relayAccess/catalog';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { normalizeRelayAccessCanonicalPublicServerUrl } from '@happier-dev/cli-common/relayAccess/normalizePublicServerUrl';
import type {
    RelayAccessConfig,
    RelayAccessStatus,
} from '@happier-dev/cli-common/relayAccess';

import type {
    AccessEndpoint,
    AccessEndpointClientContext,
    AccessEndpointDiagnostic,
    AccessEndpointReachability,
    AccessEndpointRemediationAction,
    AccessEndpointStatus,
} from '../model';
import { createAccessEndpointRemediationAction } from '../remediation';
import {
    classifyAccessEndpointHostedHttpsCompatibility,
    deriveAccessEndpointWsBaseUrl,
} from '../classify';

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

function relayAccessProviderReachability(exposure: RelayAccessProviderDescriptor['definition']['exposure']): AccessEndpointReachability {
    switch (exposure) {
        case 'local': return 'loopback';
        case 'lan': return 'lan';
        case 'privateNetwork': return 'private-network';
        case 'public': return 'public';
    }
}

function readDetailsReason(details: unknown): string | null {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const reason = (details as Readonly<Record<string, unknown>>).reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

function relayAccessRemediationActions(params: Readonly<{
    descriptor: RelayAccessProviderDescriptor;
    status: RelayAccessStatus;
    httpBaseUrl: string | null;
}>): readonly AccessEndpointRemediationAction[] {
    const reason = readDetailsReason(params.status.details);
    const remedies = params.descriptor.remedies;
    const remedy = (reason ? remedies?.reasons?.[reason] : undefined)
        ?? (params.status.state === 'needs_auth' ? remedies?.needsAuth : undefined)
        ?? (params.status.state === 'enabled' && !params.httpBaseUrl ? remedies?.missingShareUrl : undefined)
        ?? (params.status.state !== 'enabled' || !params.httpBaseUrl ? remedies?.notConfigured : undefined);
    return remedy ? [createAccessEndpointRemediationAction(remedy)] : [];
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
        const selection = parseRelayAccessConfig(input.config);
        if (!selection) continue;
        const descriptor = relayAccessProviderDescriptors.find(candidate => accessProviderRefsEqualV1(candidate.provider, selection.provider));
        if (!descriptor) continue;
        const providerId = descriptor.id;
        const httpBaseUrl = normalizeRelayAccessCanonicalPublicServerUrl(input.status.shareUrl);
        const wsBaseUrl = httpBaseUrl ? deriveAccessEndpointWsBaseUrl(httpBaseUrl) : null;
        const remediationActions = relayAccessRemediationActions({ descriptor, status: input.status, httpBaseUrl });
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
            reachability: relayAccessProviderReachability(descriptor.definition.exposure),
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
