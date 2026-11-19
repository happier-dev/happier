import type { WorkspaceSyncSeedCarrierV1 } from '@happier-dev/protocol/socketRpc';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { resolvePeerRouteFeatureId } from '@happier-dev/protocol/machines/peer/mediation/routeFeature';

import type { readCurrentWorkspaceSyncSeedAuthorization } from '@/app/auth/externalActionExecutionAuthorization';
import { isServerFeatureEnabledForRequest, readHomeEffectiveEnv } from '@/app/features/catalog/serverFeatureGate';
import { readAvailableMachineIrohEndpointAuthority } from '@/app/machines/machineStateGuards';
import { mintDirectRouteGrantV2, resolvePeerMediationGrantSigningConfig } from './mintDirectRouteGrantV1';

type SeedAdmission = NonNullable<Awaited<ReturnType<typeof readCurrentWorkspaceSyncSeedAuthorization>>>;

/** The admitted seed owns filesystem authority. This grant opens its existing transfer carrier. */
export async function mintWorkspaceSyncSeedCarrier(
    { writer, physicalTarget }: SeedAdmission,
    ephemeralPublicKeyBase64Url: string,
): Promise<WorkspaceSyncSeedCarrierV1 | undefined> {
    if (writer.machineId === physicalTarget.machineId) return undefined;
    const flowKind = 'bounded_transfer';
    const routeKind = 'iroh_peer';
    const env = await readHomeEffectiveEnv();
    if (!isServerFeatureEnabledForRequest(resolvePeerRouteFeatureId({ flowKind, routeKind }), env)) return undefined;
    const nowMs = Date.now();
    const signing = resolvePeerMediationGrantSigningConfig(env, nowMs);
    if (!signing.ok) return undefined;

    const [source, target] = await Promise.all([
        readAvailableMachineIrohEndpointAuthority({ machineId: writer.machineId, accountId: writer.custodianAccountId, installationId: writer.installationId }),
        readAvailableMachineIrohEndpointAuthority({ machineId: physicalTarget.machineId, accountId: physicalTarget.custodianAccountId, installationId: physicalTarget.installationId }),
    ]);
    if (!source || !target) return undefined;
    const { revision: _revision, ...endpoint } = source;
    const minted = mintDirectRouteGrantV2({
        accountId: writer.custodianAccountId,
        machineId: writer.machineId,
        flowKind,
        routeKind,
        endpointFingerprint: endpoint.endpointId,
        scope: { kind: 'bounded_transfer', mode: 'carrier' },
        iroh: {
            operationKind: 'finite_transfer',
            initiator: { kind: 'machine', machineId: physicalTarget.machineId, endpointId: target.endpointId },
            target: { machineId: writer.machineId, endpointId: endpoint.endpointId },
        },
        ephemeralPublicKeyBase64Url,
        nowMs,
        ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
        serverGateEnabled: true,
        signingKey: { keyId: signing.keyId, secretKey: signing.secretKey, expiresAt: signing.capability.expiresAt },
    });
    return minted.ok ? { endpoint, grant: minted.grant } : undefined;
}
