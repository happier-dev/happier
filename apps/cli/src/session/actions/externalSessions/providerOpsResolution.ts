import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { ExternalSessionProviderOps } from '@/session/external/providerOps';

export async function getExternalSessionProviderOps(providerId: ExternalSessionsProviderId): Promise<ExternalSessionProviderOps> {
    const providerOps = (await resolveBackendExecutionSurfaces(providerId)).externalSessions;
    if (!providerOps) {
        throw new Error(`Missing direct-session provider ops for ${providerId}`);
    }
    return providerOps;
}
