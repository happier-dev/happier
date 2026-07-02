import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

export async function resolveExternalSessionSurfaceOps(providerId: ExternalSessionsProviderId): Promise<ExternalSessionExecutionSurface> {
    const providerOps = (await resolveBackendExecutionSurfaces(providerId)).externalSession;
    if (!providerOps) {
        throw new Error(`Missing direct-session provider ops for ${providerId}`);
    }
    return providerOps;
}
