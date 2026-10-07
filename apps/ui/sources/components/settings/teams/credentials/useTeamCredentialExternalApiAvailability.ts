import {
    resolveTeamCredentialExternalApiAvailability,
    type TeamCredentialExternalApiAvailabilityV1,
} from '@happier-dev/protocol/features/payload/capabilities/teamCredentialCapabilities';

import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';

const UNAVAILABLE = Object.freeze({
    available: false as const,
    reason: 'deployment_readiness_unavailable' as const,
});

/** Exact-Home operation availability; neither URL profiles nor UI policy infer it. */
export function useTeamCredentialExternalApiAvailability(
    serverId: string,
): TeamCredentialExternalApiAvailabilityV1 {
    return useFeatureDetails({
        featureId: 'teams.credentialResources.externalApi',
        fallback: UNAVAILABLE,
        select: resolveTeamCredentialExternalApiAvailability,
        scope: { scopeKind: 'spawn', serverId },
    });
}
