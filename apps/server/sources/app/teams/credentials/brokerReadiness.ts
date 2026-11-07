import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';

import type { Fastify } from '@/app/api/types';
import { getMachineDaemonPresenceInventory, type MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { inTx } from '@/storage/inTx';
import { getMachinePoolCandidateSnapshots, type MachinePoolCandidateSnapshot } from '@/app/machines/pools/machinePoolService';

import { readTeamCredentialBrokerPlacement, resolveTeamCredentialBrokerPlacementInTx,
    type TeamCredentialBrokerPlacementResource } from './brokerPlacementResolver';
import type { readTeamCredentialCatalogInTx } from './resourceRead';
import { sourceRequiresReconnect } from './sourceReadiness';

type CatalogRead = Extract<Awaited<ReturnType<typeof readTeamCredentialCatalogInTx>>, { ok: true }>;
type BrokerReadinessObservation = Readonly<{
    unavailable: ReadonlyMap<string, TeamCredentialResourceReadinessV1>;
    presenceByAccount: ReadonlyMap<string, MachineDaemonPresenceInventory>;
    poolSnapshots: ReadonlyMap<string, MachinePoolCandidateSnapshot>;
}>;
export type TeamCredentialCatalogReadinessProjection = CatalogRead & Readonly<{ brokerReadiness: BrokerReadinessObservation }>;

/**
 * Generic and application-specific reads consume launch's placement decision.
 * Source/model eligibility may further restrict a reachable route; it cannot
 * turn an offline broker into an available one. Direct delivery is independent.
 */
export async function readTeamCredentialBrokerReadiness(
    app: Fastify,
    resources: readonly TeamCredentialBrokerPlacementResource[],
    currentPresence?: ReadonlyMap<string, MachineDaemonPresenceInventory>,
    wholeAccountIds: ReadonlySet<string> = new Set(),
    currentPoolSnapshots?: ReadonlyMap<string, MachinePoolCandidateSnapshot>,
): Promise<BrokerReadinessObservation> {
    // One observation for resources sharing the same placement; resource ids
    // do not change exact-Machine admission or Pool candidate discovery.
    const groups = new Map<string, TeamCredentialBrokerPlacementResource[]>();
    for (const resource of resources) {
        const key = JSON.stringify([resource.custodianAccountId, resource.brokerMachineId, resource.brokerPoolId]);
        const group = groups.get(key) ?? [];
        group.push(resource);
        groups.set(key, group);
    }
    const demands = [...groups.values()].map(group => ({ resource: group[0]!, group }));
    const machineIdsByAccount = new Map<string, Set<string>>();
    const poolIdsByAccount = new Map<string, Set<string>>();
    for (const { resource } of demands) {
        const read = readTeamCredentialBrokerPlacement(resource);
        if (!read.ok || read.placement === null) continue;
        if (read.placement.kind === 'machine') {
            const ids = machineIdsByAccount.get(resource.custodianAccountId) ?? new Set<string>();
            ids.add(read.placement.machineId);
            machineIdsByAccount.set(resource.custodianAccountId, ids);
        } else {
            const ids = poolIdsByAccount.get(resource.custodianAccountId) ?? new Set<string>();
            ids.add(read.placement.poolId);
            poolIdsByAccount.set(resource.custodianAccountId, ids);
        }
    }
    for (const accountId of wholeAccountIds) if (!machineIdsByAccount.has(accountId)) machineIdsByAccount.set(accountId, new Set());
    const presenceByAccount = currentPresence ?? new Map(await Promise.all([...machineIdsByAccount].map(async ([accountId, machineIds]) => (
        [accountId, await getMachineDaemonPresenceInventory({ accountId,
            ...(wholeAccountIds.has(accountId) ? {} : { machineIds: [...machineIds] }), io: app.machineDaemonPresence })] as const
    ))));
    const unavailable = new Map<string, TeamCredentialResourceReadinessV1>();
    const poolSnapshots = new Map(currentPoolSnapshots);
    if (!currentPoolSnapshots) await Promise.all([...poolIdsByAccount].map(async ([accountId, poolIds]) => {
        // Pool acquisition owns roster changes during discovery and exact room
        // demand. Only an actual Direct read needs the whole Account inventory.
        const snapshots = await getMachinePoolCandidateSnapshots({ accountId, poolIds: [...poolIds],
            ...(wholeAccountIds.has(accountId) ? { presence: presenceByAccount.get(accountId)! } : { io: app.machineDaemonPresence }) });
        for (const [poolId, snapshot] of snapshots) poolSnapshots.set(`${accountId}\u0000${poolId}`, snapshot);
    }));
    if (demands.length === 0) return { unavailable, presenceByAccount, poolSnapshots };
    await inTx(async tx => {
        for (const { resource, group } of demands) {
            const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
                resource, presence: presenceByAccount.get(resource.custodianAccountId) ?? { state: 'unavailable' },
                requestKey: `credential-catalog\u0000${resource.id}`,
                ...(resource.brokerPoolId && poolSnapshots.has(`${resource.custodianAccountId}\u0000${resource.brokerPoolId}`)
                    ? { poolSnapshotForProjection: poolSnapshots.get(`${resource.custodianAccountId}\u0000${resource.brokerPoolId}`)! } : {}),
            });
            if (placement.ok && placement.poolSnapshot && resource.brokerPoolId) {
                poolSnapshots.set(`${resource.custodianAccountId}\u0000${resource.brokerPoolId}`, placement.poolSnapshot);
            }
            const refusal: TeamCredentialResourceReadinessV1 | null = !placement.ok
                ? placement.error === 'update_required' ? { kind: 'update_required' }
                    : placement.error === 'resource_unavailable' ? { kind: 'resource_corrupt' }
                    : { kind: 'broker_unavailable', ...('refusalReason' in placement
                        && placement.refusalReason === 'broker_presence_unknown' ? { reason: 'projection_unavailable' as const } : {}) }
                : placement.broker === null && placement.candidateMachineIds.length === 0
                    ? { kind: 'broker_unavailable', ...(placement.poolSnapshot?.presenceState !== 'known'
                        ? { reason: 'projection_unavailable' as const } : {}) } : null;
            if (refusal) for (const member of group) unavailable.set(member.id, refusal);
        }
    });
    return { unavailable, presenceByAccount, poolSnapshots };
}

export async function projectTeamCredentialCatalogBrokerReadiness(app: Fastify, result: CatalogRead): Promise<TeamCredentialCatalogReadinessProjection> {
    const brokerReadiness = await readTeamCredentialBrokerReadiness(app,
        result.brokerReadinessRequests.map(request => request.resource), undefined,
        new Set(result.projectionRequests.filter(request => request.deliveryMode === 'direct').map(request => request.custodianAccountId)));
    const { unavailable } = brokerReadiness;
    const directResourceIds = new Set(result.brokerReadinessRequests.filter(request => request.hasCurrentDirectMaterial).map(request => request.resource.id));
    return {
        ...result,
        brokerReadiness,
        projectionRequests: result.projectionRequests.filter(request => request.deliveryMode !== 'brokered' || !unavailable.has(request.resourceId)),
        page: { ...result.page, resources: result.page.resources.map(resource => {
            const refusal = unavailable.get(resource.id);
            if (!refusal || sourceRequiresReconnect(resource.readiness)) return resource;
            // An unavailable-only row keeps its configured choice for recovery.
            // When Direct remains ready, withdraw only the unavailable brokered
            // choice so resource-wide readiness cannot admit that route.
            const connectedServiceSelections = directResourceIds.has(resource.id)
                ? resource.connectedServiceSelections.filter(selection => selection.deliveryMode !== 'brokered')
                : resource.connectedServiceSelections;
            if (directResourceIds.has(resource.id)
                || (resource.readiness.kind !== 'available' && resource.readiness.kind !== 'source_unavailable'
                    && resource.readiness.kind !== 'broker_unavailable')) return { ...resource, connectedServiceSelections };
            return { ...resource, readiness: refusal, connectedServiceSelections,
                recoveryAction: refusal.kind === 'update_required' ? 'update_required' as const
                    : refusal.kind === 'resource_corrupt'
                        || (refusal.kind === 'broker_unavailable' && refusal.reason === undefined)
                        ? 'source_owner_action' as const : 'retry' as const };
        }) },
    };
}
