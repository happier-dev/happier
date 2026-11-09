import type { LoopbackTunnelProbeResult } from '@/sync/runtime/nativeLoopbackTunnels/types';

import { createEndpointReadinessProbe } from '@/sync/runtime/connectivity/createEndpointReadinessProbe';
import { probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import type { IrohHomeTunnelRequest } from './types';

export type IrohHomeTunnelProbeFailureReason =
    | 'health-unavailable'
    | 'auth-failed'
    | 'identity-mismatch'
    | 'features-unavailable';

/**
 * Shared Home endpoint verification for a native lease or declared HTTPS, in order:
 * 1. public `/v1/features` through the exact transport origin, whose
 *    `serverIdentityId` must equal the expected Home identity; a different Home
 *    is refused before any credential leaves;
 * 2. real endpoint readiness against that same origin: `/v1/auth/ping` with the
 *    scoped token for an enrolled caller, or `/health` for pre-token enrollment
 *    (authenticated readiness subsumes health).
 *
 * Both existing probe owners are composed (never duplicated): the combined
 * mode-aware readiness probe and the explicit-endpoint feature probe with the
 * canonical URL kept as the cache/profile key and the selected origin as transport.
 */
export async function probeIrohHomeTunnelOrigin(
    url: string,
    request: Pick<IrohHomeTunnelRequest, 'homeServerIdentityId' | 'canonicalServerUrl' | 'remoteHostId' | 'verification'>,
): Promise<LoopbackTunnelProbeResult<IrohHomeTunnelProbeFailureReason>> {
    const homeServerIdentityId = request.homeServerIdentityId.trim();
    const token = request.verification.kind === 'authenticated'
        ? request.verification.token.trim()
        : null;
    if (!homeServerIdentityId || (request.verification.kind === 'authenticated' && !token)) {
        // Authenticated acquisition requires its scoped token; both modes
        // require the expected Home identity before any request is made.
        return { ok: false, reason: 'auth-failed' };
    }

    const features = await probeServerFeaturesAtUrl(request.canonicalServerUrl, {
        runtimeOrigin: url,
        serverId: request.remoteHostId,
        force: true,
    });
    if (features.status !== 'ready') {
        return { ok: false, reason: 'features-unavailable' };
    }
    if ((features.serverIdentityId ?? null) !== homeServerIdentityId) {
        return { ok: false, reason: 'identity-mismatch' };
    }

    const readiness = await createEndpointReadinessProbe({ endpoint: url, token })();
    if (readiness.status === 'auth_failed') {
        return { ok: false, reason: 'auth-failed' };
    }
    if (readiness.status !== 'ready') {
        return { ok: false, reason: 'health-unavailable' };
    }
    return { ok: true };
}
