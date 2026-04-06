import { tailscaleReachabilityRemediationDefinition } from './providers/tailscaleReachabilityRemediation.ts';
import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationDefinition,
    EndpointReachabilityRemediationParams,
    EndpointReachabilityRemediationProviderId,
} from './types';

const reachabilityRemediationDefinitions: ReadonlyArray<EndpointReachabilityRemediationDefinition> = [
    tailscaleReachabilityRemediationDefinition,
];

export type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from './types';

export function getEndpointReachabilityProvider(
    endpointUrl: string,
): EndpointReachabilityRemediationProviderId | null {
    return reachabilityRemediationDefinitions.find((definition) => definition.matchesEndpoint(endpointUrl))?.providerId ?? null;
}

export function resolveEndpointReachabilityRemediation(
    params: EndpointReachabilityRemediationParams,
): EndpointReachabilityRemediation | null {
    const definition = reachabilityRemediationDefinitions.find((candidate) => candidate.matchesEndpoint(params.endpointUrl));
    if (!definition) {
        return null;
    }

    return definition.resolveRemediation(params);
}
