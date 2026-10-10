import type { Prisma } from "@prisma/client";
import { isPersistentMachine } from "@happier-dev/protocol";
import type {
    MachinePoolCreateInputV1,
    MachinePoolDeleteInputV1,
    MachinePoolDeleteOutputV1,
    MachinePoolErrorV1,
    MachinePoolResolveInputV1,
    MachinePoolResolveResultV1,
    MachinePoolUpdateInputV1,
    MachinePoolViewV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    getMachineDaemonPresenceInventory,
    type MachineDaemonPresenceInventory,
    type MachineDaemonPresenceSocketServer,
} from "../machineDaemonPresence";
import { selectMachinePoolCandidate } from "@happier-dev/protocol/machines/pools";
import { clearTeamCredentialBrokerPoolReferencesInTx } from "@/app/teams/credentials/resourceBrokerPoolLifecycle";
import { acquireMachinePoolMutationFenceInTx } from "./machinePoolMutationFence";

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
type PoolResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: MachinePoolErrorV1 }>;
type StoredPoolMember = StoredPool["members"][number];

class MachinePoolDeleteCasLost extends Error {}

export type MachinePoolCandidateSnapshot = Readonly<{
    poolId: string;
    revision: number;
    members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[];
    availableMachineIds: ReadonlySet<string>;
    presenceState: "known" | "unavailable";
}>;

type MachinePoolCandidateSnapshotInput = Readonly<{
    accountId: string;
    poolId: string;
    presence: MachineDaemonPresenceInventory;
}>;

function normalizeDescription(description: string | null | undefined): string | null {
    const normalized = description?.trim() ?? "";
    return normalized.length > 0 ? normalized : null;
}

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
    input: Readonly<{ name: string; description?: string | null; members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[] }>,
): boolean {
    return stored.name === input.name.trim()
        && stored.description === normalizeDescription(input.description)
        && JSON.stringify(normalizedMembers(stored.members)) === JSON.stringify(normalizedMembers(input.members));
}

function classifyPoolMemberState(member: StoredPoolMember, inventory: MachineDaemonPresenceInventory) {
    const lifecycle = classifyMachineAvailabilityState(member.machine);
    if (lifecycle === "revoked") return "revoked" as const;
    if (lifecycle === "replaced") return "replaced" as const;
    if (!isPersistentMachine(member.machine)) return "temporary" as const;
    if (inventory.state === "unavailable") return "unknown" as const;
    return inventory.machineIds.has(member.machineId) ? "connected" as const : "offline" as const;
}

function projectPool(stored: StoredPool, inventory: MachineDaemonPresenceInventory): MachinePoolViewV1 {
    const members = [...stored.members]
        .sort((left, right) => left.priorityTier - right.priorityTier || left.machineId.localeCompare(right.machineId))
        .map((member) => ({
            machineId: member.machineId,
            priorityTier: member.priorityTier,
            enabled: member.enabled,
            state: classifyPoolMemberState(member, inventory),
        }));
    const availability = inventory.state === "unavailable"
        ? { state: "unknown" as const }
        : {
            state: "known" as const,
            enabledCount: members.filter((member) => member.enabled).length,
            connectedCount: members.filter((member) => member.enabled && member.state === "connected").length,
        };
    return {
        pool: {
            id: stored.id,
            name: stored.name,
            description: stored.description,
            revision: stored.revision,
            createdAt: stored.createdAt.getTime(),
            updatedAt: stored.updatedAt.getTime(),
            members,
        },
        availability,
    };
}

async function readOwnedPool(client: Tx | typeof db, accountId: string, poolId: string): Promise<StoredPool | null> {
    return await client.machinePool.findFirst({
        where: { id: poolId, accountId },
        ...poolAggregate,
    });
}

async function validateMembersInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[];
    current?: StoredPool;
}>): Promise<readonly string[]> {
    if (params.members.length === 0) return [];
    const machines = await params.tx.machine.findMany({
        where: { accountId: params.accountId, id: { in: params.members.map((member) => member.machineId) } },
        select: { id: true, kind: true, revokedAt: true, replacedByMachineId: true },
    });
    const machineById = new Map(machines.map((machine) => [machine.id, machine]));
    const currentById = new Map(params.current?.members.map((member) => [member.machineId, member]));
    return params.members.flatMap((member) => {
        const machine = machineById.get(member.machineId);
        if (!machine) return [member.machineId];
        if (isPersistentMachine(machine) && classifyMachineAvailabilityState(machine) === "available") return [];
        const existing = currentById.get(member.machineId);
        // Tier edits and disabling a saved reference do not admit a Machine.
        // A new reference or re-enable still requires current eligibility.
        return existing && (existing.enabled || !member.enabled)
            ? []
            : [member.machineId];
    });
}

async function inventoryFor(accountId: string, io: MachineDaemonPresenceSocketServer) {
    return await getMachineDaemonPresenceInventory({ accountId, io });
}

export async function listMachinePools(params: Readonly<{
    accountId: string;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<readonly MachinePoolViewV1[]> {
    const [stored, inventory] = await Promise.all([
        db.machinePool.findMany({
            where: { accountId: params.accountId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            ...poolAggregate,
        }),
        inventoryFor(params.accountId, params.io),
    ]);
    return stored.map((pool) => projectPool(pool, inventory));
}

export async function getMachinePool(params: Readonly<{
    accountId: string;
    poolId: string;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolViewV1>> {
    const [stored, inventory] = await Promise.all([
        readOwnedPool(db, params.accountId, params.poolId),
        inventoryFor(params.accountId, params.io),
    ]);
    return stored
        ? { ok: true, value: projectPool(stored, inventory) }
        : { ok: false, error: { code: "pool_not_found" } };
}

async function settleCreateCollision(params: Readonly<{
    accountId: string;
    input: MachinePoolCreateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolViewV1>> {
    const owned = await readOwnedPool(db, params.accountId, params.input.poolId);
    if (!owned) return { ok: false, error: { code: "pool_changed" } };
    const current = projectPool(owned, await inventoryFor(params.accountId, params.io));
    return sameDefinition(owned, params.input)
        ? { ok: true, value: current }
        : { ok: false, error: { code: "pool_changed", current } };
}

export async function createMachinePool(params: Readonly<{
    accountId: string;
    input: MachinePoolCreateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolViewV1>> {
    let stored: StoredPool;
    try {
        const result = await inTx(async (tx) => {
            const existing = await tx.machinePool.findUnique({ where: { id: params.input.poolId }, ...poolAggregate });
            if (existing) return { kind: "collision" as const };
            const invalid = await validateMembersInTx({ tx, accountId: params.accountId, members: params.input.members });
            if (invalid.length > 0) return { kind: "invalid" as const, machineIds: invalid };
            await tx.machinePool.create({
                data: {
                    id: params.input.poolId,
                    accountId: params.accountId,
                    name: params.input.name.trim(),
                    description: normalizeDescription(params.input.description),
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
            await markAccountChanged(tx, { accountId: params.accountId, kind: "machinePool", entityId: created.id });
            return { kind: "created" as const, stored: created };
        });
        if (result.kind === "collision") return await settleCreateCollision(params);
        if (result.kind === "invalid") {
            return { ok: false, error: { code: "member_machine_not_eligible", machineIds: [...result.machineIds] } };
        }
        stored = result.stored;
    } catch (error) {
        if (!isPrismaUniqueConstraintError(error)) throw error;
        return await settleCreateCollision(params);
    }
    return { ok: true, value: projectPool(stored, await inventoryFor(params.accountId, params.io)) };
}

export async function updateMachinePool(params: Readonly<{
    accountId: string;
    input: MachinePoolUpdateInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolViewV1>> {
    const result = await inTx(async (tx) => {
        const current = await readOwnedPool(tx, params.accountId, params.input.poolId);
        if (!current) return { kind: "not_found" as const };
        if (sameDefinition(current, params.input)) return { kind: "settled" as const, stored: current };
        if (current.revision !== params.input.expectedRevision) return { kind: "conflict" as const, stored: current };
        const invalid = await validateMembersInTx({
            tx,
            accountId: params.accountId,
            members: params.input.members,
            current,
        });
        if (invalid.length > 0) return { kind: "invalid" as const, machineIds: invalid };
        const updated = await tx.machinePool.updateMany({
            where: { id: current.id, accountId: params.accountId, revision: params.input.expectedRevision },
            data: {
                name: params.input.name.trim(),
                description: normalizeDescription(params.input.description),
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
        await markAccountChanged(tx, { accountId: params.accountId, kind: "machinePool", entityId: current.id });
        return { kind: "updated" as const, stored };
    });
    if (result.kind === "not_found") return { ok: false, error: { code: "pool_not_found" } };
    if (result.kind === "invalid") return { ok: false, error: { code: "member_machine_not_eligible", machineIds: [...result.machineIds] } };
    if (result.kind === "cas_lost") {
        const current = await getMachinePool({ accountId: params.accountId, poolId: params.input.poolId, io: params.io });
        return current.ok
            ? { ok: false, error: { code: "pool_changed", current: current.value } }
            : current;
    }
    const current = projectPool(result.stored, await inventoryFor(params.accountId, params.io));
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
        if (!current) return { kind: "not_found" as const };
        if (current.revision !== params.input.expectedRevision) return { kind: "conflict" as const, stored: current };
        if (!await acquireMachinePoolMutationFenceInTx({
            tx,
            accountId: params.accountId,
            poolId: current.id,
        })) return { kind: "not_found" as const };
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
        await markAccountChanged(tx, { accountId: params.accountId, kind: "machinePool", entityId: current.id });
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
                    current: projectPool(current, await inventoryFor(params.accountId, params.io)),
                },
            }
            : settled;
    }
    if (result.kind === "conflict") {
        return {
            ok: false,
            error: { code: "pool_changed", current: projectPool(result.stored, await inventoryFor(params.accountId, params.io)) },
        };
    }
    return settled;
}

async function readMachinePoolCandidateSnapshot(
    client: Tx | typeof db,
    params: MachinePoolCandidateSnapshotInput,
): Promise<PoolResult<MachinePoolCandidateSnapshot>> {
    const stored = await readOwnedPool(client, params.accountId, params.poolId);
    if (!stored) return { ok: false, error: { code: "pool_not_found" } };
    return { ok: true, value: projectMachinePoolCandidateSnapshot(stored, params.presence) };
}

function projectMachinePoolCandidateSnapshot(
    stored: StoredPool,
    presence: MachineDaemonPresenceInventory,
): MachinePoolCandidateSnapshot {
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
        presenceState: presence.state,
    });
}

/** Reads a request's owned Pool candidates in one canonical persistence query. */
export async function getMachinePoolCandidateSnapshots(params: Readonly<{
    accountId: string;
    poolIds: readonly string[];
    presence: MachineDaemonPresenceInventory;
}>): Promise<ReadonlyMap<string, MachinePoolCandidateSnapshot>> {
    const poolIds = [...new Set(params.poolIds)];
    if (poolIds.length === 0) return new Map();
    const stored = await db.machinePool.findMany({
        where: { accountId: params.accountId, id: { in: poolIds } },
        ...poolAggregate,
    });
    return new Map(stored.map(pool => [pool.id, projectMachinePoolCandidateSnapshot(pool, params.presence)]));
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
    const initial = await readOwnedPool(db, params.accountId, params.poolId);
    if (!initial) return { ok: false, error: { code: "pool_not_found" } };
    if (!initial.members.some((member) => member.enabled)) {
        return {
            ok: true,
            value: Object.freeze({
                poolId: initial.id,
                revision: initial.revision,
                members: Object.freeze(initial.members.map((member) => Object.freeze({
                    machineId: member.machineId,
                    priorityTier: member.priorityTier,
                    enabled: member.enabled,
                }))),
                availableMachineIds: new Set<string>(),
                presenceState: "known" as const,
            }),
        };
    }
    const inventory = params.presence ?? await inventoryFor(params.accountId, params.io);
    return await readMachinePoolCandidateSnapshot(db, {
        accountId: params.accountId,
        poolId: params.poolId,
        presence: inventory,
    });
}

export async function resolveMachinePool(params: Readonly<{
    accountId: string;
    input: MachinePoolResolveInputV1;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<PoolResult<MachinePoolResolveResultV1>> {
    // Worker selection needs exact target status at the Action caller, not server presence alone.
    if (params.input.purpose === "finite" || params.input.purpose === "service-start") {
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
    if (stored.presenceState === "unavailable") {
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
