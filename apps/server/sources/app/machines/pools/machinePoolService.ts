import type { Prisma } from "@prisma/client";
import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { serializePrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import type { MachinePoolCreateInputV1, MachinePoolDeleteInputV1, MachinePoolDeleteOutputV1, MachinePoolErrorV1, MachinePoolPrivateLabelStoredV1, MachinePoolPrivateViewV1, MachinePoolResolveInputV1, MachinePoolResolveResultV1, MachinePoolUpdateInputV1 } from '@happier-dev/protocol/machines/pools/v1';

import { acquireAccountChangePublicationLocksInTx, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { readActiveTeamMembershipsInTx } from '@/app/teams/actorContext';
import {
    getMachineDaemonPresenceInventory,
    classifyMachineDaemonPresence,
    type MachineDaemonPresenceInventory,
    type MachineDaemonPresenceSocketServer,
} from "../machineDaemonPresence";
import { selectMachinePoolCandidate } from "@happier-dev/protocol/machines/pools";
import { acquireTeamCredentialBrokerPoolAdmissionInTx, clearTeamCredentialBrokerPoolReferencesInTx } from "@/app/teams/credentials/resourceBrokerPoolLifecycle";
import { acquireMachinePoolMutationFenceInTx } from "./machinePoolMutationFence";
import { validateMachinePoolMembersInTx } from './machinePoolMemberAdmission';
import { canReadMachinePoolTeamInTx, canSetMachinePoolAudienceInTx, CUSTODIAN_POOL_ACCESS, TEAM_POOL_ACCESS, machinePoolAudience, readableMachinePoolTeamsInTx,
    readMachinePoolPublicationAudienceInTx, resolveMachinePoolAccessInTx, type MachinePoolActor } from './machinePoolAccess';
import type { MachinePoolAccessV1, MachinePoolAudienceV1 } from '@happier-dev/protocol/machines/pools/v1';
import { prepareMachinePoolPrivateLabelsForWriteInTx, projectMachinePoolPrivateLabelForRecipient } from './privateLabels';

const poolAggregate = {
    include: {
        members: {
            include: {
                machine: {
                    select: {
                        accountId: true,
                        kind: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    },
                },
            },
        },
    },
} as const satisfies Prisma.MachinePoolDefaultArgs;

type StoredPool = Prisma.MachinePoolGetPayload<typeof poolAggregate>;
const poolCandidateAggregate = {
    include: {
        members: {
            include: {
                machine: {
                    select: {
                        ...poolAggregate.include.members.include.machine.select,
                        operationProtocolCapabilities: true,
                        operationProtocolCapabilitiesRevision: true,
                    },
                },
            },
        },
    },
} as const satisfies Prisma.MachinePoolDefaultArgs;
type StoredCandidatePool = Prisma.MachinePoolGetPayload<typeof poolCandidateAggregate>;
type PoolResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: MachinePoolErrorV1 }>;
type StoredPoolMember = StoredPool["members"][number];

class MachinePoolDeleteCasLost extends Error {}

export type MachinePoolCandidateSnapshot = Readonly<{
    poolId: string;
    revision: number;
    members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[];
    availableMachineIds: ReadonlySet<string>;
    machineEndpointIds: ReadonlyMap<string, string | null>;
    machineOperationProtocolCapabilities?: ReadonlyMap<string, unknown>;
    presenceState: "known" | "partial" | "unavailable";
}>;

type MachinePoolCandidateSnapshotInput = Readonly<{
    accountId: string;
    poolId: string;
    presence: MachineDaemonPresenceInventory;
}>;

function normalizedMembers(members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[]) {
    return [...members]
        .map((member) => ({
            machineId: member.machineId,
            priorityTier: member.priorityTier,
            enabled: member.enabled,
        }))
        .sort((left, right) => left.machineId.localeCompare(right.machineId));
}

function sameDefinition(
    stored: StoredPool,
    input: Readonly<{ name: MachinePoolPrivateLabelStoredV1; description?: MachinePoolPrivateLabelStoredV1 | null; audience?: MachinePoolAudienceV1; members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[] }>,
): boolean {
    return stored.name === serializePrivateLabelStoredV1(input.name)
        && stored.description === (input.description === undefined || input.description === null
            ? null
            : serializePrivateLabelStoredV1(input.description))
        && (input.audience === undefined || stored.teamId === (input.audience.kind === 'team' ? input.audience.teamId : null))
        && JSON.stringify(normalizedMembers(stored.members)) === JSON.stringify(normalizedMembers(input.members));
}

function classifyPoolMemberState(member: StoredPoolMember, inventory: MachineDaemonPresenceInventory) {
    const lifecycle = classifyMachineAvailabilityState(member.machine);
    if (lifecycle === "revoked") return "revoked" as const;
    if (lifecycle === "replaced") return "replaced" as const;
    if (!isPersistentMachine(member.machine)) return "temporary" as const;
    const presence = classifyMachineDaemonPresence(inventory, member.machineId);
    return presence === 'disconnected' ? 'offline' as const : presence;
}

function projectPool(stored: StoredPool, inventory: MachineDaemonPresenceInventory,
    access: MachinePoolAccessV1 = CUSTODIAN_POOL_ACCESS, recipientAccountId = stored.accountId): MachinePoolPrivateViewV1 {
    const members = [...stored.members]
        .sort((left, right) => left.priorityTier - right.priorityTier || left.machineId.localeCompare(right.machineId))
        .map((member) => ({
            machineId: member.machineId,
            priorityTier: member.priorityTier,
            enabled: member.enabled,
            state: classifyPoolMemberState(member, inventory),
        }));
    const availability = inventory.state !== "known"
        ? { state: "unknown" as const }
        : {
            state: "known" as const,
            enabledCount: members.filter((member) => member.enabled).length,
            connectedCount: members.filter((member) => member.enabled && member.state === "connected").length,
        };
    return {
        pool: {
            id: stored.id,
            name: projectMachinePoolPrivateLabelForRecipient({
                serialized: stored.name,
                recipientAccountId,
            }),
            description: stored.description === null ? null : projectMachinePoolPrivateLabelForRecipient({
                serialized: stored.description,
                recipientAccountId,
            }),
            revision: stored.revision,
            createdAt: stored.createdAt.getTime(),
            updatedAt: stored.updatedAt.getTime(),
            audience: machinePoolAudience(stored),
            members: access.canViewMembers ? members : [],
        },
        availability,
        access,
    };
}

async function readOwnedPool(client: Tx | typeof db, accountId: string, poolId: string): Promise<StoredPool | null> {
    return await client.machinePool.findFirst({
        where: { id: poolId, accountId },
        ...poolAggregate,
    });
}

async function inventoryFor(accountId: string, io: MachineDaemonPresenceSocketServer, pools: readonly StoredPool[]) {
    return await getMachineDaemonPresenceInventory({ accountId, io,
        machineIds: pools.flatMap(pool => pool.members.map(member => member.machineId)) });
}

async function publishMachinePoolChangedInTx(tx: Tx, pool: StoredPool, previous?: StoredPool): Promise<void> {
    const accountIds = [...new Set([
        ...await readMachinePoolPublicationAudienceInTx(tx, pool),
        ...(previous ? await readMachinePoolPublicationAudienceInTx(tx, previous) : []),
    ])];
    await markAccountsChanged(tx, { accountIds, kind: 'machinePool', entityId: pool.id });
}

export async function listMachinePools(params: Readonly<{
    accountId: string;
    authentication?: MachinePoolActor['authentication'];
    io: MachineDaemonPresenceSocketServer;
}>): Promise<readonly MachinePoolPrivateViewV1[]> {
    const stored = await inReadSnapshot(async tx => {
        const teamIds = await readableMachinePoolTeamsInTx(tx, params);
        const owned = await tx.machinePool.findMany({
            where: { accountId: params.accountId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            ...poolAggregate,
        });
        const shared: StoredPool[] = [];
        for (const ids of portableQueryChunks({ values: teamIds, bindingsPerValue: 1, fixedBindings: 2 })) {
            const rows = await tx.machinePool.findMany({ where: { teamId: { in: [...ids] }, accountId: { not: params.accountId } }, ...poolAggregate });
            shared.push(...rows);
        }
        const activeCustodians = await readActiveTeamMembershipsInTx(tx, { memberships: shared.flatMap(pool => pool.teamId
            ? [{ teamId: pool.teamId, accountId: pool.accountId }] : []) });
        const available = shared.filter(pool => pool.teamId && activeCustodians.get(pool.teamId)?.has(pool.accountId));
        return [...owned, ...available].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    });
    // Presence belongs to each custodian, even when the viewer may see only aggregate availability.
    const poolsByCustodian = new Map<string, StoredPool[]>();
    for (const pool of stored) {
        const pools = poolsByCustodian.get(pool.accountId);
        if (pools) pools.push(pool);
        else poolsByCustodian.set(pool.accountId, [pool]);
    }
    const inventories = new Map(await Promise.all([...poolsByCustodian].map(async ([accountId, pools]) =>
        [accountId, await inventoryFor(accountId, params.io, pools)] as const)));
    return stored.map(pool => projectPool(pool, inventories.get(pool.accountId)!, pool.accountId === params.accountId
        ? CUSTODIAN_POOL_ACCESS : TEAM_POOL_ACCESS, params.accountId));
}

export async function getMachinePool(params: Readonly<{
    accountId: string;
    authentication?: MachinePoolActor['authentication'];
    poolId: string;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolPrivateViewV1>> {
    const result = await inReadSnapshot(async tx => {
        const stored = await tx.machinePool.findUnique({ where: { id: params.poolId }, ...poolAggregate });
        if (!stored) return null;
        const access = await resolveMachinePoolAccessInTx(tx, params, stored);
        return access ? { stored, access } : null;
    });
    return result
        ? { ok: true, value: projectPool(result.stored,
            await inventoryFor(result.stored.accountId, params.io, [result.stored]), result.access, params.accountId) }
        : { ok: false, error: { code: "pool_not_found" } };
}

async function settleCreateCollision(params: Readonly<{
    accountId: string;
    input: MachinePoolCreateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolPrivateViewV1>> {
    const owned = await readOwnedPool(db, params.accountId, params.input.poolId);
    if (!owned) return { ok: false, error: { code: "pool_changed" } };
    const current = projectPool(owned, await inventoryFor(params.accountId, params.io, [owned]), CUSTODIAN_POOL_ACCESS, params.accountId);
    return sameDefinition(owned, params.input)
        ? { ok: true, value: current }
        : { ok: false, error: { code: "pool_changed", current } };
}

export async function createMachinePool(params: Readonly<{
    accountId: string;
    authentication?: MachinePoolActor['authentication'];
    input: MachinePoolCreateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolPrivateViewV1>> {
    let stored: StoredPool;
    try {
        const result = await inTx(async (tx) => {
            await acquireAccountChangePublicationLocksInTx(tx, await readMachinePoolPublicationAudienceInTx(tx, {
                accountId: params.accountId, teamId: params.input.audience?.kind === 'team' ? params.input.audience.teamId : null,
            }), { includeSingleAccount: true });
            const existing = await tx.machinePool.findUnique({ where: { id: params.input.poolId }, ...poolAggregate });
            if (existing) return { kind: "collision" as const };
            if (!await canSetMachinePoolAudienceInTx(tx, params, params.input.audience)) return { kind: 'not_found' as const };
            const labels = await prepareMachinePoolPrivateLabelsForWriteInTx({
                tx,
                authorAccountId: params.accountId,
                teamId: params.input.audience?.kind === 'team' ? params.input.audience.teamId : null,
                name: params.input.name,
                description: params.input.description,
            });
            if (labels.kind !== 'ready') return { kind: 'invalid_labels' as const, labels };
            const invalid = await validateMachinePoolMembersInTx({ tx, accountId: params.accountId, members: params.input.members });
            if (invalid.length > 0) return { kind: "invalid" as const, machineIds: invalid };
            await tx.machinePool.create({
                data: {
                    id: params.input.poolId,
                    accountId: params.accountId,
                    teamId: params.input.audience?.kind === 'team' ? params.input.audience.teamId : null,
                    name: labels.name,
                    description: labels.description,
                },
            });
            if (params.input.members.length > 0) {
                // Use the provider's bulk-write path instead of issuing one nested write per
                // member. The enclosing transaction still makes the Pool, members and
                // AccountChange atomic.
                await tx.machinePoolMember.createMany({
                    data: normalizedMembers(params.input.members).map((member) => ({
                        poolId: params.input.poolId,
                        ...member,
                    })),
                });
            }
            const created = await readOwnedPool(tx, params.accountId, params.input.poolId);
            if (!created) throw new Error("machine_pool_create_missing");
            await publishMachinePoolChangedInTx(tx, created);
            return { kind: "created" as const, stored: created };
        });
        if (result.kind === "collision") return await settleCreateCollision(params);
        if (result.kind === 'not_found') return { ok: false, error: { code: 'pool_not_found' } };
        if (result.kind === 'invalid_labels') {
            return { ok: false, error: { code: 'invalid_request', message: result.labels.kind === 'invalid_mode'
                ? 'Machine Pool labels do not match the Account encryption mode.'
                : 'Machine Pool label recipients are not current.' } };
        }
        if (result.kind === "invalid") {
            return { ok: false, error: { code: "member_machine_not_eligible", machineIds: [...result.machineIds] } };
        }
        stored = result.stored;
    } catch (error) {
        if (!isPrismaUniqueConstraintError(error)) throw error;
        return await settleCreateCollision(params);
    }
    return { ok: true, value: projectPool(stored, await inventoryFor(params.accountId, params.io, [stored]), CUSTODIAN_POOL_ACCESS, params.accountId) };
}

export async function updateMachinePool(params: Readonly<{
    accountId: string;
    authentication?: MachinePoolActor['authentication'];
    input: MachinePoolUpdateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolPrivateViewV1>> {
    const result = await inTx(async (tx) => {
        const current = await readOwnedPool(tx, params.accountId, params.input.poolId);
        if (!current) return { kind: "not_found" as const };
        await acquireAccountChangePublicationLocksInTx(tx, [
            ...await readMachinePoolPublicationAudienceInTx(tx, current),
            ...await readMachinePoolPublicationAudienceInTx(tx, { accountId: params.accountId,
                teamId: params.input.audience?.kind === 'team' ? params.input.audience.teamId : null }),
        ], { includeSingleAccount: true });
        if (params.input.audience?.kind === 'team' && params.input.audience.teamId !== current.teamId
            && !await canSetMachinePoolAudienceInTx(tx, params, params.input.audience)) return { kind: 'not_found' as const };
        const labels = await prepareMachinePoolPrivateLabelsForWriteInTx({
            tx,
                authorAccountId: params.accountId,
            teamId: params.input.audience === undefined
                ? current.teamId
                : params.input.audience.kind === 'team' ? params.input.audience.teamId : null,
            name: params.input.name,
            description: params.input.description,
        });
        if (labels.kind !== 'ready') return { kind: 'invalid_labels' as const, labels };
        if (sameDefinition(current, params.input)) return { kind: "settled" as const, stored: current };
        if (current.revision !== params.input.expectedRevision) return { kind: "conflict" as const, stored: current };
        const invalid = await validateMachinePoolMembersInTx({
            tx,
            accountId: params.accountId,
            members: params.input.members,
            current,
        });
        if (invalid.length > 0) return { kind: "invalid" as const, machineIds: invalid };
        const updated = await tx.machinePool.updateMany({
            where: { id: current.id, accountId: params.accountId, revision: params.input.expectedRevision },
            data: {
                name: labels.name,
                description: labels.description,
                ...(params.input.audience === undefined ? {} : { teamId: params.input.audience.kind === 'team' ? params.input.audience.teamId : null }),
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) return { kind: "cas_lost" as const };
        await tx.machinePoolMember.deleteMany({ where: { poolId: current.id } });
        if (params.input.members.length > 0) {
            await tx.machinePoolMember.createMany({
                data: normalizedMembers(params.input.members).map((member) => ({ poolId: current.id, ...member })),
            });
        }
        const stored = await readOwnedPool(tx, params.accountId, current.id);
        if (!stored) throw new Error("machine_pool_update_missing");
        await publishMachinePoolChangedInTx(tx, stored, current);
        return { kind: "updated" as const, stored };
    });
    if (result.kind === "not_found") return { ok: false, error: { code: "pool_not_found" } };
    if (result.kind === 'invalid_labels') {
        return { ok: false, error: { code: 'invalid_request', message: result.labels.kind === 'invalid_mode'
            ? 'Machine Pool labels do not match the Account encryption mode.'
            : 'Machine Pool label recipients are not current.' } };
    }
    if (result.kind === "invalid") return { ok: false, error: { code: "member_machine_not_eligible", machineIds: [...result.machineIds] } };
    if (result.kind === "cas_lost") {
        const current = await getMachinePool({ accountId: params.accountId, poolId: params.input.poolId, io: params.io });
        return current.ok
            ? { ok: false, error: { code: "pool_changed", current: current.value } }
            : current;
    }
    const current = projectPool(result.stored, await inventoryFor(params.accountId, params.io, [result.stored]), CUSTODIAN_POOL_ACCESS, params.accountId);
    return result.kind === "conflict"
        ? { ok: false, error: { code: "pool_changed", current } }
        : { ok: true, value: current };
}

export async function deleteMachinePool(params: Readonly<{
    accountId: string;
    input: MachinePoolDeleteInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolDeleteOutputV1>> {
    const result = await inTx(async (tx) => {
        const current = await readOwnedPool(tx, params.accountId, params.input.poolId);
        if (!current) return { kind: 'not_found' as const };
        await acquireAccountChangePublicationLocksInTx(tx, await readMachinePoolPublicationAudienceInTx(tx, current), { includeSingleAccount: true });
        const resourceScope = { custodianAccountId: params.accountId, poolId: params.input.poolId };
        const recheckAdmission = await acquireTeamCredentialBrokerPoolAdmissionInTx(tx, resourceScope);
        if (current.revision !== params.input.expectedRevision) return { kind: "conflict" as const, stored: current };
        if (!await acquireMachinePoolMutationFenceInTx({
            tx,
            accountId: params.accountId,
            poolId: current.id,
        })) return { kind: "not_found" as const };
        await recheckAdmission();
        await clearTeamCredentialBrokerPoolReferencesInTx(tx, {
            custodianAccountId: params.accountId,
            poolId: current.id,
        });
        const deleted = await tx.machinePool.deleteMany({
            where: { id: current.id, accountId: params.accountId, revision: params.input.expectedRevision },
        });
        // Returning would commit the resource invalidations above. Throwing is
        // the transaction boundary's rollback signal; map it back to the
        // established optimistic-concurrency result outside the transaction.
        if (deleted.count !== 1) throw new MachinePoolDeleteCasLost();
        await publishMachinePoolChangedInTx(tx, current);
        return { kind: "deleted" as const };
    }).catch((error: unknown) => {
        if (error instanceof MachinePoolDeleteCasLost) return { kind: "cas_lost" as const };
        throw error;
    });
    const settled = { ok: true as const, value: { poolId: params.input.poolId, deleted: true as const } };
    if (result.kind === "not_found") return settled;
    if (result.kind === "cas_lost") {
        const current = await readOwnedPool(db, params.accountId, params.input.poolId);
        return current
            ? {
                ok: false,
                error: {
                    code: "pool_changed",
                    current: projectPool(current, await inventoryFor(params.accountId, params.io, [current]), CUSTODIAN_POOL_ACCESS, params.accountId),
                },
            }
            : settled;
    }
    if (result.kind === "conflict") {
        return {
            ok: false,
            error: { code: "pool_changed", current: projectPool(result.stored, await inventoryFor(params.accountId, params.io, [result.stored]), CUSTODIAN_POOL_ACCESS, params.accountId) },
        };
    }
    return settled;
}

async function readMachinePoolCandidateSnapshot(
    client: Tx | typeof db,
    params: MachinePoolCandidateSnapshotInput,
): Promise<PoolResult<MachinePoolCandidateSnapshot>> {
    const stored = await readOwnedCandidatePool(client, params.accountId, params.poolId);
    if (!stored) return { ok: false, error: { code: "pool_not_found" } };
    return { ok: true, value: projectMachinePoolCandidateSnapshot(stored, params.presence) };
}

async function readOwnedCandidatePool(client: Tx | typeof db, accountId: string, poolId: string): Promise<StoredCandidatePool | null> {
    return await client.machinePool.findFirst({ where: { id: poolId, accountId }, ...poolCandidateAggregate });
}

function projectMachinePoolCandidateSnapshot(
    stored: StoredCandidatePool,
    presence: MachineDaemonPresenceInventory,
): MachinePoolCandidateSnapshot {
    const queriedMachineIds = presence.state === 'known' ? presence.queriedMachineIds : undefined;
    const availableMachineIds = new Set(stored.members.flatMap((member) => (
        classifyPoolMemberState(member, presence) === "connected" ? [member.machineId] : []
    )));
    return Object.freeze({
        poolId: stored.id,
        revision: stored.revision,
        members: Object.freeze(stored.members.map((member) => Object.freeze({
            machineId: member.machineId,
            priorityTier: member.priorityTier,
            enabled: member.enabled,
        }))),
        availableMachineIds,
        machineOperationProtocolCapabilities: new Map(stored.members.map(member => [member.machineId, member.machine.operationProtocolCapabilities])),
        machineEndpointIds: new Map(stored.members.map(member => [member.machineId, readMachineIrohEndpointAuthorityV1({
            capabilities: member.machine.operationProtocolCapabilities,
            revision: member.machine.operationProtocolCapabilitiesRevision,
        })?.endpointId ?? null])),
        presenceState: queriedMachineIds
            && stored.members.some(member => member.enabled && !queriedMachineIds.has(member.machineId))
            ? 'partial' : presence.state,
    });
}

/** Internal preset admission reads candidates without granting the requester controller access. */
export async function resolveMachinePoolForManagedPresetInTx(tx: Tx, params: Readonly<{
    actorAccountId: string;
    teamId?: string;
    poolId: string;
    presence: MachineDaemonPresenceInventory;
    authentication?: MachinePoolActor['authentication'];
}>): Promise<PoolResult<Readonly<{ custodianAccountId: string; snapshot: MachinePoolCandidateSnapshot }>>> {
    const stored = await tx.machinePool.findUnique({ where: { id: params.poolId }, ...poolCandidateAggregate });
    if (!stored || (params.teamId ? stored.teamId !== params.teamId : stored.accountId !== params.actorAccountId)) {
        return { ok: false, error: { code: 'pool_not_found' } };
    }
    // A Team preset retains its Team boundary even when its custodian is the caller.
    if (params.teamId) {
        if (!await canReadMachinePoolTeamInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication }, params.teamId)) {
            return { ok: false, error: { code: 'pool_not_found' } };
        }
    }
    return { ok: true, value: { custodianAccountId: stored.accountId,
        snapshot: projectMachinePoolCandidateSnapshot(stored, params.presence) } };
}

async function readOwnedPools(accountId: string, poolIds: readonly string[]): Promise<StoredCandidatePool[]> {
    const stored: StoredCandidatePool[] = [];
    // The native aggregate query binds the Account and OFFSET in addition to IDs.
    for (const ids of portableQueryChunks({ values: poolIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        stored.push(...await db.machinePool.findMany({
            where: { accountId, id: { in: [...ids] } },
            ...poolCandidateAggregate,
        }));
    }
    return stored;
}

/** Acquires one request's owned Pool candidates and shared presence demand. */
export async function getMachinePoolCandidateSnapshots(params: Readonly<{
    accountId: string;
    poolIds: readonly string[];
} & (
    | { io: MachineDaemonPresenceSocketServer; presence?: never }
    | { presence: MachineDaemonPresenceInventory; io?: never }
)>): Promise<ReadonlyMap<string, MachinePoolCandidateSnapshot>> {
    const poolIds = [...new Set(params.poolIds)];
    if (poolIds.length === 0) return new Map();
    let stored = await readOwnedPools(params.accountId, poolIds);
    if (params.presence) {
        const inventory = params.presence;
        return new Map(stored.map(pool => [pool.id, projectMachinePoolCandidateSnapshot(pool, inventory)]));
    }
    const machineIds = [...new Set(stored.flatMap(pool => pool.members.flatMap(member => (
        member.enabled ? [member.machineId] : []
    ))))];
    const initialDemand = new Set(machineIds);
    let presence = await getMachineDaemonPresenceInventory({ accountId: params.accountId, io: params.io, machineIds });
    stored = await readOwnedPools(params.accountId, poolIds);
    const currentMachineIds = [...new Set(stored.flatMap(pool => pool.members.flatMap(member => (
        member.enabled ? [member.machineId] : []
    ))))];
    if (currentMachineIds.some(machineId => !initialDemand.has(machineId))) {
        presence = await getMachineDaemonPresenceInventory({
            accountId: params.accountId, io: params.io, machineIds: currentMachineIds,
        });
        stored = await readOwnedPools(params.accountId, poolIds);
    }
    const inventory = presence;
    return new Map(stored.map(pool => [pool.id, projectMachinePoolCandidateSnapshot(pool, inventory)]));
}

/** Transaction-scoped read used by broker admission after presence is captured. */
export async function getMachinePoolCandidateSnapshotInTx(
    tx: Tx,
    params: MachinePoolCandidateSnapshotInput,
): Promise<PoolResult<MachinePoolCandidateSnapshot>> {
    return await readMachinePoolCandidateSnapshot(tx, params);
}

export async function getMachinePoolCandidateSnapshot(params: Readonly<{
    accountId: string;
    poolId: string;
} & (
    | { io: MachineDaemonPresenceSocketServer; presence?: never }
    | { presence: MachineDaemonPresenceInventory; io?: never }
)>): Promise<PoolResult<MachinePoolCandidateSnapshot>> {
    const initial = await readOwnedCandidatePool(db, params.accountId, params.poolId);
    if (!initial) return { ok: false, error: { code: "pool_not_found" } };
    if (!initial.members.some((member) => member.enabled)) {
        return {
            ok: true,
            value: projectMachinePoolCandidateSnapshot(initial, { state: 'known', machineIds: new Set() }),
        };
    }
    if (params.presence) return await readMachinePoolCandidateSnapshot(db, {
        accountId: params.accountId, poolId: params.poolId, presence: params.presence,
    });
    const machineIds = initial.members.filter(member => member.enabled).map(member => member.machineId);
    const initialDemand = new Set(machineIds);
    let inventory = await getMachineDaemonPresenceInventory({ accountId: params.accountId, io: params.io, machineIds });
    let current = await readOwnedCandidatePool(db, params.accountId, params.poolId);
    if (!current) return { ok: false, error: { code: 'pool_not_found' } };
    const currentMachineIds = current.members.filter(member => member.enabled).map(member => member.machineId);
    if (currentMachineIds.some(machineId => !initialDemand.has(machineId))) {
        // Membership can change while transport discovery is pending. The existing
        // current-definition read remains authoritative; observe its new candidates
        // through the same exact census instead of treating them as disconnected.
        inventory = await getMachineDaemonPresenceInventory({ accountId: params.accountId, io: params.io,
            machineIds: currentMachineIds });
        current = await readOwnedCandidatePool(db, params.accountId, params.poolId);
        if (!current) return { ok: false, error: { code: 'pool_not_found' } };
    }
    return { ok: true, value: projectMachinePoolCandidateSnapshot(current, inventory) };
}

export async function resolveMachinePool(params: Readonly<{
    accountId: string;
    input: MachinePoolResolveInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolResolveResultV1>> {
    // Worker selection needs exact target status at the Action caller, not server presence alone.
    if (params.input.purpose === "finite" || params.input.purpose === "service-start" || params.input.purpose === 'managed-preset') {
        return { ok: false, error: { code: "invalid_request", message: "Worker placement requires the Action resolver." } };
    }
    const snapshot = await getMachinePoolCandidateSnapshot({
        accountId: params.accountId,
        poolId: params.input.poolId,
        io: params.io,
    });
    if (!snapshot.ok) return snapshot;
    const stored = snapshot.value;
    if (!stored.members.some((member) => member.enabled)) {
        return { ok: true, value: { kind: "unavailable", poolId: stored.poolId, reason: "empty" } };
    }
    if (stored.presenceState !== 'known' && stored.availableMachineIds.size === 0) {
        return { ok: true, value: { kind: "unavailable", poolId: stored.poolId, reason: "presence_unavailable" } };
    }
    if (stored.availableMachineIds.size === 0) {
        return { ok: true, value: { kind: "unavailable", poolId: stored.poolId, reason: "no_available_machine" } };
    }
    const selected = selectMachinePoolCandidate({
        purpose: "session",
        members: stored.members,
        availableMachineIds: stored.availableMachineIds,
        requestKey: params.input.requestKey,
    });
    if (selected) return { ok: true, value: { kind: "resolved", poolId: stored.poolId, ...selected } };
    return {
        ok: true,
        value: {
            kind: "unavailable",
            poolId: stored.poolId,
            reason: "no_available_machine",
        },
    };
}
