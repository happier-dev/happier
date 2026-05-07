import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    sanitizeServerUrlForShareableLink,
    normalizeShareableServerUrlValidationTarget,
} from '@/sync/domains/server/url/shareableServerUrl';

import type {
    AccessEndpoint,
    AccessEndpointClientContext,
    AccessEndpointDiagnostic,
    AccessEndpointStatus,
} from '../model';
import { createAccessEndpointRemediationAction } from '../remediation';
import {
    classifyAccessEndpointHostedHttpsCompatibility,
    classifyAccessEndpointReachability,
    deriveAccessEndpointWsBaseUrl,
} from '../classify';

export type ServerProfileAccessEndpointInput = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    shareableServerUrl?: string | null;
    shareableServerUrlValidatedAgainstServerUrl?: string | null;
}>;

function buildEndpoint(params: Readonly<{
    id: string;
    label: string;
    httpBaseUrl: string;
    status: AccessEndpointStatus;
    clientContext: AccessEndpointClientContext;
    diagnostics?: readonly AccessEndpointDiagnostic[];
}>): AccessEndpoint {
    const wsBaseUrl = deriveAccessEndpointWsBaseUrl(params.httpBaseUrl);
    return {
        id: params.id,
        label: params.label,
        source: 'server-profile',
        reachability: classifyAccessEndpointReachability(params.httpBaseUrl),
        hostedHttpsCompatibility: classifyAccessEndpointHostedHttpsCompatibility({
            httpBaseUrl: params.httpBaseUrl,
            clientContext: params.clientContext,
        }),
        durability: 'persistent',
        status: params.status,
        httpBaseUrl: params.httpBaseUrl,
        ...(wsBaseUrl ? { wsBaseUrl } : {}),
        ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
        ...(params.status === 'requires-configuration'
            ? { remediationActions: [createAccessEndpointRemediationAction('serverProfile.configureShareableUrl')] }
            : {}),
    };
}

function isShareableUrlValidated(profile: ServerProfileAccessEndpointInput): boolean {
    const validatedAgainst = normalizeShareableServerUrlValidationTarget(profile.shareableServerUrlValidatedAgainstServerUrl);
    const current = normalizeShareableServerUrlValidationTarget(profile.serverUrl);
    return Boolean(validatedAgainst && current && validatedAgainst === current);
}

export function buildServerProfileAccessEndpoints(params: Readonly<{
    profiles: readonly ServerProfileAccessEndpointInput[];
    clientContext: AccessEndpointClientContext;
}>): readonly AccessEndpoint[] {
    const endpoints: AccessEndpoint[] = [];

    for (const profile of params.profiles) {
        const canonical = canonicalizeServerUrl(profile.serverUrl);
        const shareable = sanitizeServerUrlForShareableLink(profile.shareableServerUrl ?? null);
        if (shareable && shareable !== canonical) {
            const validated = isShareableUrlValidated(profile);
            endpoints.push(buildEndpoint({
                id: `server-profile:${profile.id}:shareable`,
                label: profile.name,
                httpBaseUrl: shareable,
                status: validated ? 'available' : 'requires-configuration',
                clientContext: params.clientContext,
                ...(validated
                    ? {}
                    : {
                        diagnostics: [{
                            id: 'server-profile.shareable-url.stale-validation',
                            severity: 'warning',
                            message: 'server-profile.shareable-url.stale-validation',
                        }],
                    }),
            }));
        }

        if (canonical) {
            endpoints.push(buildEndpoint({
                id: `server-profile:${profile.id}:canonical`,
                label: profile.name,
                httpBaseUrl: canonical,
                status: 'available',
                clientContext: params.clientContext,
            }));
        }
    }

    return endpoints;
}
