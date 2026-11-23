import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { z } from 'zod/mini';
import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';

import type { Fastify } from '@/app/api/types';
import { getMachineDaemonPresenceInventory, type MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { inTx } from '@/storage/inTx';
import { getMachinePoolCandidateSnapshots, type MachinePoolCandidateSnapshot } from '@/app/machines/pools/machinePoolService';

import { readTeamCredentialBrokerPlacement, resolveTeamCredentialBrokerPlacementInTx,
    type TeamCredentialBrokerPlacementResource } from './brokerPlacementResolver';
import type { readTeamCredentialCatalogInTx } from './resourceRead';

type CatalogRead = Extract<Awaited<ReturnType<typeof readTeamCredentialCatalogInTx>>, { ok: true }>;
type BrokerReadinessObservation = Readonly<{
    unavailable: ReadonlyMap<string, TeamCredentialResourceReadinessV1>;
    presenceByAccount: ReadonlyMap<string, MachineDaemonPresenceInventory>;
    poolSnapshots: ReadonlyMap<string, MachinePoolCandidateSnapshot>;
}>;
export type TeamCredentialCatalogReadinessProjection = CatalogRead & Readonly<{ brokerReadiness: BrokerReadinessObservation }>;

export type TeamCredentialBrokerEligibility = z.infer<typeof DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema>;

export async function readTeamCredentialBrokerSourceEligibility(
    app: Fastify,
    input: Readonly<{
        custodianAccountId: string;
        machineIds: readonly string[];
        teamId: string;
        resourceId: string;
        resourceRevision: number;
        source: TeamCredentialSourceBindingV1;
    }>,
): Promise<readonly Readonly<{ machineId: string; eligibility: TeamCredentialBrokerEligibility | null }>[]> {
    return await Promise.all(input.machineIds.map(async machineId => {
        const rpc = await app.forwardRpcForUser({
            userId: input.custodianAccountId,
            method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`,
            params: {
                machineId,
                teamId: input.teamId,
                resourceId: input.resourceId,
                expectedResourceRevision: input.resourceRevision,
                source: input.source,
                scope: input.source.kind === 'connected_account' && !input.source.providerPurpose
                    ? 'source_credential'
                    : 'source_any',
            },
        });
        if (!rpc.ok) return { machineId, eligibility: null };
        const parsed = DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.safeParse(rpc.result);
        return { machineId, eligibility: parsed.success ? parsed.data : null };
    }));
}

export function projectTeamCredentialBrokerSourceRefusal(
    candidates: readonly Readonly<{ eligibility: TeamCredentialBrokerEligibility | null }>[],
): Extract<TeamCredentialResourceReadinessV1, { kind: 'source_unavailable' }> | null {
    // Pool candidates can disagree. A working source takes precedence, and an
    // unanswered observation cannot establish that the source is unavailable.
    if (candidates.length === 0 || candidates.some(({ eligibility }) => eligibility?.status !== 'unavailable')) return null;
    if (candidates.every(({ eligibility }) => eligibility?.status === 'unavailable'
        && eligibility.reason === 'connected_service_credential_reconnect_required')) {
        return { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' };
    }
    return candidates.every(({ eligibility }) => eligibility?.status === 'unavailable'
        && (eligibility.reason === 'source_changed' || eligibility.reason === 'source_unavailable'))
        ? { kind: 'source_unavailable' }
        : null;
}

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
): Promise<BrokerReadinessObservation & Readonly<{ candidateMachineIds: ReadonlyMap<string, readonly string[]> }>> {
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
    const candidateMachineIds = new Map<string, readonly string[]>();
    const poolSnapshots = new Map(currentPoolSnapshots);
    if (!currentPoolSnapshots) await Promise.all([...poolIdsByAccount].map(async ([accountId, poolIds]) => {
        // Pool acquisition owns roster changes during discovery and exact room
        // demand. Only an actual Direct read needs the whole Account inventory.
        const snapshots = await getMachinePoolCandidateSnapshots({ accountId, poolIds: [...poolIds],
            ...(wholeAccountIds.has(accountId) ? { presence: presenceByAccount.get(accountId)! } : { io: app.machineDaemonPresence }) });
        for (const [poolId, snapshot] of snapshots) poolSnapshots.set(`${accountId}\u0000${poolId}`, snapshot);
    }));
    if (demands.length === 0) return { unavailable, presenceByAccount, poolSnapshots, candidateMachineIds };
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
            if (refusal) {
                for (const member of group) unavailable.set(member.id, refusal);
            } else if (placement.ok) {
                const machineIds = placement.candidateMachineIds.length > 0
                    ? placement.candidateMachineIds
                    : placement.broker ? [placement.broker.machineId] : [];
                for (const member of group) candidateMachineIds.set(member.id, machineIds);
            }
        }
    });
    return { unavailable, presenceByAccount, poolSnapshots, candidateMachineIds };
}

export async function projectTeamCredentialCatalogBrokerReadiness(app: Fastify, result: CatalogRead): Promise<TeamCredentialCatalogReadinessProjection> {
    const brokerReadiness = await readTeamCredentialBrokerReadiness(app,
        result.brokerReadinessRequests.map(request => request.resource), undefined,
        new Set(result.projectionRequests.filter(request => request.deliveryMode === 'direct').map(request => request.custodianAccountId)));
    const unavailable = new Map(brokerReadiness.unavailable);
    await Promise.all(result.brokerReadinessRequests.map(async request => {
        const { resource, credentialSource } = request;
        // Provider applications own their own model and connection observations.
        // An unqualified Connected Account uses the same source observation as administration.
        if (!credentialSource || request.hasCurrentDirectMaterial) return;
        const machineIds = brokerReadiness.candidateMachineIds.get(resource.id);
        if (!machineIds?.length) return;
        const observations = await readTeamCredentialBrokerSourceEligibility(app, {
            ...credentialSource, resourceId: resource.id, custodianAccountId: resource.custodianAccountId, machineIds,
        });
        const refusal = projectTeamCredentialBrokerSourceRefusal(observations);
        if (refusal) unavailable.set(resource.id, refusal);
    }));
    const directResourceIds = new Set(result.brokerReadinessRequests.filter(request => request.hasCurrentDirectMaterial).map(request => request.resource.id));
    return {
        ...result,
        brokerReadiness,
        projectionRequests: result.projectionRequests.filter(request => request.deliveryMode !== 'brokered' || !unavailable.has(request.resourceId)),
        page: { ...result.page, resources: result.page.resources.map(resource => {
            const refusal = unavailable.get(resource.id);
            if (!refusal || resource.readiness.kind === 'source_unavailable') return resource;
            // An unavailable-only row keeps its configured choice for recovery.
            // When Direct remains ready, withdraw only the unavailable brokered
            // choice so resource-wide readiness cannot admit that route.
            const connectedServiceSelections = directResourceIds.has(resource.id)
                ? resource.connectedServiceSelections.filter(selection => selection.deliveryMode !== 'brokered')
                : resource.connectedServiceSelections;
            if (directResourceIds.has(resource.id)
                || (resource.readiness.kind !== 'available' && resource.readiness.kind !== 'broker_unavailable')) return { ...resource, connectedServiceSelections };
            if (refusal.kind === 'source_unavailable') return {
                ...resource, readiness: refusal, connectedServiceSelections: [], recoveryAction: 'source_owner_action' as const,
            };
            return { ...resource, readiness: refusal, connectedServiceSelections,
                recoveryAction: refusal.kind === 'update_required' ? 'update_required' as const
                    : refusal.kind === 'resource_corrupt'
                        || (refusal.kind === 'broker_unavailable' && refusal.reason === undefined)
                        ? 'source_owner_action' as const : 'retry' as const };
        }) },
    };
}
