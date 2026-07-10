import type { ExternalSessionsAgentId } from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

export async function resolveExternalSessionSurfaceOps(agentId: ExternalSessionsAgentId): Promise<ExternalSessionExecutionSurface> {
    const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(agentId)).externalSession;
    if (!providerOps) {
        throw new Error(`Missing direct-session provider ops for ${agentId}`);
    }
    return providerOps;
}
