import type { DirectSessionsProviderId } from '@happier-dev/protocol';

import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { DirectSessionProviderOps } from '@/session/external/providerOps';

export async function getDirectSessionProviderOps(providerId: DirectSessionsProviderId): Promise<DirectSessionProviderOps> {
    const providerOps = (await resolveBackendExecutionSurfaces(providerId)).directSessions;
    if (!providerOps) {
        throw new Error(`Missing direct-session provider ops for ${providerId}`);
    }
    return providerOps;
}
