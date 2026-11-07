import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { getMachineSocketRoom, getUserMachinesSocketRoom } from '@/app/api/socketRooms';
import type { MachineDaemonPresenceSocketServer } from "../machineDaemonPresence";
import type { MachinePoolCreateInputV1 } from "@happier-dev/protocol";
import {
    createMachinePool,
    deleteMachinePool,
    getMachinePool,
    getMachinePoolCandidateSnapshot,
    getMachinePoolCandidateSnapshots,
    listMachinePools,
    resolveMachinePool,
    updateMachinePool,
} from "./machinePoolService";
import { getMachinePoolMemberEligibility } from './machinePoolMemberAdmission';

vi.mock("@/app/events/connectionEventRouter", () => ({ eventRouter: { emitUpdate: vi.fn() } }));

const ownerId = "pool-owner";
const otherId = "pool-other";
const poolId = "99d55938-f860-4af8-8023-01fecec86f35";

function io(machineIds: readonly string[] = []): MachineDaemonPresenceSocketServer {
    return {
        in: () => ({
            fetchSockets: async () => machineIds.map((machineId) => ({
                data: { clientType: "machine-scoped", userId: ownerId, machineId },
            })),
        }),
    };
}

describe("machinePoolService (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-pools-", initAuth: false });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.machinePoolMember.deleteMany(),
            () => db.machinePool.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seed() {
        await db.account.createMany({ data: [
            { id: ownerId, publicKey: null, encryptionMode: "plain" },
            { id: otherId, publicKey: null, encryptionMode: "plain" },
        ] });
        await db.machine.createMany({ data: [
            { id: "m-fast", accountId: ownerId, metadata: "{}", active: false },
            { id: "m-slow", accountId: ownerId, metadata: "{}", active: true },
            { id: "m-foreign", accountId: otherId, metadata: "{}" },
        ] });
    }

    it("reports the same pool admission eligibility for owned, foreign, missing and retired Machines", async () => {
        await seed();
        await db.machine.createMany({ data: [
            { id: "m-temporary", accountId: ownerId, metadata: "{}", kind: "ephemeral_session_runner" },
            { id: "m-revoked", accountId: ownerId, metadata: "{}", revokedAt: new Date() },
            { id: "m-replaced", accountId: ownerId, metadata: "{}", replacedByMachineId: "m-fast" },
        ] });
        const machineIds = ["m-fast", "m-foreign", "m-missing", "m-temporary", "m-revoked", "m-replaced"];
        const result = await getMachinePoolMemberEligibility({ accountId: ownerId, machineIds });
        expect(result).toEqual([
            { machineId: "m-fast", eligible: true },
            { machineId: "m-foreign", eligible: false, reason: "not_owned_or_missing" },
            { machineId: "m-missing", eligible: false, reason: "not_owned_or_missing" },
            { machineId: "m-temporary", eligible: false, reason: "temporary" },
            { machineId: "m-revoked", eligible: false, reason: "revoked" },
            { machineId: "m-replaced", eligible: false, reason: "replaced" },
        ]);
        for (const member of result) {
            const created = await createMachinePool({ accountId: ownerId, io: io(), input: {
                poolId: crypto.randomUUID(), name: "Admission", members: [{ machineId: member.machineId, enabled: true, priorityTier: 0 }],
            } });
            expect(created.ok).toBe(member.eligible);
        }
    });

    it("does not select worker purposes through the server-only Session resolver", async () => {
        await seed();
        await createMachinePool({ accountId: ownerId,
            input: { poolId, name: "Worker", members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }] },
            io: io(["m-fast"]),
        });
        await expect(resolveMachinePool({ accountId: ownerId, io: io(["m-fast"]), input: {
            poolId, requestKey: "worker", purpose: "finite", workspace: { serverId: "home", refId: "checkout" },
        } })).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
    });

    it("rejects ephemeral members and never selects an ephemeral Machine from a stored Pool", async () => {
        await seed();
        await db.machine.update({ where: { id: "m-fast" }, data: { kind: "ephemeral_session_runner" } });
        const input: MachinePoolCreateInputV1 = {
            poolId, name: "Persistent only", members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }],
        };
        await expect(createMachinePool({ accountId: ownerId, input, io: io(["m-fast"]) })).resolves.toMatchObject({
            ok: false, error: { code: "member_machine_not_eligible", machineIds: ["m-fast"] },
        });
        expect(await db.machinePool.count()).toBe(0);
        await db.machinePool.create({ data: {
            id: poolId, accountId: ownerId, name: input.name,
            members: { create: input.members },
        } });
        await expect(resolveMachinePool({ accountId: ownerId, input: { poolId, requestKey: "request" }, io: io(["m-fast"]) }))
            .resolves.toMatchObject({ ok: true, value: { kind: "unavailable", reason: "no_available_machine" } });
    });

    it("atomically creates, replays, conflicts, mutates by revision, and marks actual changes", async () => {
        await seed();
        const input: MachinePoolCreateInputV1 = {
            poolId,
            name: " Fast pool ",
            description: "   ",
            members: [
                { machineId: "m-slow", priorityTier: 2, enabled: true },
                { machineId: "m-fast", priorityTier: 0, enabled: true },
            ],
        };
        const created = await createMachinePool({ accountId: ownerId, input, io: io(["m-fast"]) });
        expect(created).toMatchObject({
            ok: true,
            value: {
                pool: { name: "Fast pool", description: null, revision: 0 },
                availability: { state: "known", connectedCount: 1, enabledCount: 2 },
            },
        });
        expect(await db.accountChange.count({ where: { accountId: ownerId, kind: "machinePool" } })).toBe(1);

        await expect(createMachinePool({ accountId: ownerId, input, io: io() })).resolves.toMatchObject({ ok: true });
        expect(await db.accountChange.count({ where: { accountId: ownerId, kind: "machinePool" } })).toBe(1);
        await expect(createMachinePool({
            accountId: ownerId,
            input: { ...input, name: "Different" },
            io: io(),
        })).resolves.toMatchObject({ ok: false, error: { code: "pool_changed", current: { pool: { name: "Fast pool" } } } });

        const updated = await updateMachinePool({
            accountId: ownerId,
            input: { ...input, expectedRevision: 0, name: "Updated", members: input.members },
            io: io(),
        });
        expect(updated).toMatchObject({ ok: true, value: { pool: { revision: 1, name: "Updated" } } });
        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                ...input,
                expectedRevision: 0,
                name: "Stale",
                members: [{ machineId: "m-slow", priorityTier: 99, enabled: false }],
            },
            io: io(),
        })).resolves.toMatchObject({ ok: false, error: { code: "pool_changed", current: { pool: { revision: 1 } } } });
        await expect(db.machinePool.findUniqueOrThrow({
            where: { id: poolId },
            include: { members: { orderBy: { machineId: "asc" } } },
        })).resolves.toMatchObject({
            name: "Updated",
            revision: 1,
            members: [
                { machineId: "m-fast", priorityTier: 0, enabled: true },
                { machineId: "m-slow", priorityTier: 2, enabled: true },
            ],
        });
        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                ...input,
                expectedRevision: 1,
                name: "Must roll back",
                members: [{ machineId: "m-foreign", priorityTier: 0, enabled: true }],
            },
            io: io(),
        })).resolves.toEqual({
            ok: false,
            error: { code: "member_machine_not_eligible", machineIds: ["m-foreign"] },
        });
        await expect(db.machinePool.findUniqueOrThrow({
            where: { id: poolId },
            include: { members: true },
        })).resolves.toMatchObject({ name: "Updated", revision: 1, members: expect.arrayContaining([
            expect.objectContaining({ machineId: "m-fast", priorityTier: 0 }),
            expect.objectContaining({ machineId: "m-slow", priorityTier: 2 }),
        ]) });
        await expect(updateMachinePool({
            accountId: ownerId,
            input: { ...input, expectedRevision: 0, name: "Updated", members: input.members },
            io: io(),
        })).resolves.toMatchObject({ ok: true, value: { pool: { revision: 1 } } });
        expect(await db.account.findUniqueOrThrow({ where: { id: ownerId }, select: { seq: true } })).toEqual({ seq: 2 });

        await expect(deleteMachinePool({
            accountId: ownerId,
            input: { poolId, expectedRevision: 0 },
            io: io(),
        })).resolves.toMatchObject({ ok: false, error: { code: "pool_changed" } });
        await expect(deleteMachinePool({
            accountId: ownerId,
            input: { poolId, expectedRevision: 1 },
            io: io(),
        })).resolves.toEqual({ ok: true, value: { poolId, deleted: true } });
        expect(await db.account.findUniqueOrThrow({ where: { id: ownerId }, select: { seq: true } })).toEqual({ seq: 3 });
        await expect(deleteMachinePool({
            accountId: ownerId,
            input: { poolId, expectedRevision: 1 },
            io: io(),
        })).resolves.toEqual({ ok: true, value: { poolId, deleted: true } });
        expect(await db.account.findUniqueOrThrow({ where: { id: ownerId }, select: { seq: true } })).toEqual({ seq: 3 });
    });

    it("does not disclose or admit foreign Machines and pool ids", async () => {
        await seed();
        await expect(createMachinePool({
            accountId: ownerId,
            input: { poolId, name: "No", members: [{ machineId: "m-foreign", priorityTier: 0, enabled: true }] },
            io: io(),
        })).resolves.toEqual({
            ok: false,
            error: { code: "member_machine_not_eligible", machineIds: ["m-foreign"] },
        });
        await createMachinePool({ accountId: otherId, input: { poolId, name: "Private", members: [] }, io: io() });
        await expect(getMachinePool({ accountId: ownerId, poolId, io: io() })).resolves.toEqual({
            ok: false,
            error: { code: "pool_not_found" },
        });
        await expect(createMachinePool({ accountId: ownerId, input: { poolId, name: "Mine", members: [] }, io: io() }))
            .resolves.toEqual({ ok: false, error: { code: "pool_changed" } });
        await expect(deleteMachinePool({
            accountId: ownerId,
            input: { poolId, expectedRevision: 0 },
            io: io(),
        })).resolves.toEqual({ ok: true, value: { poolId, deleted: true } });
        expect(await db.machinePool.findUnique({ where: { id: poolId } })).toMatchObject({ accountId: otherId });
        expect(await db.accountChange.count({ where: { accountId: ownerId, kind: "machinePool" } })).toBe(0);
    });

    it("rolls back credential invalidation when the Pool delete CAS loses", async () => {
        await seed();
        await createMachinePool({
            accountId: ownerId,
            input: { poolId, name: "Broker Pool", members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }] },
            io: io(["m-fast"]),
        });
        const team = await db.team.create({ data: { name: `Pool CAS ${crypto.randomUUID()}` } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: ownerId,
            displayName: "Pool resource",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "connection",
                connectionSecurityFingerprint: "connection-security:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                credentialSlotId: "apiKey",
            }),
            brokerPoolId: poolId,
        } });
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "machine_pool_delete_cas_loss"
            BEFORE DELETE ON "MachinePool"
            BEGIN
                UPDATE "MachinePool" SET "revision" = "revision" + 1 WHERE "id" = OLD."id";
                SELECT RAISE(IGNORE);
            END
        `);
        try {
            await expect(deleteMachinePool({
                accountId: ownerId,
                input: { poolId, expectedRevision: 0 },
                io: io(["m-fast"]),
            })).resolves.toMatchObject({ ok: false, error: { code: "pool_changed" } });
            await expect(db.teamCredentialResource.findUniqueOrThrow({
                where: { id: resource.id },
                select: { brokerPoolId: true, revision: true },
            })).resolves.toEqual({ brokerPoolId: poolId, revision: 0 });
            await expect(db.machinePool.findUniqueOrThrow({
                where: { id: poolId }, select: { revision: true },
            })).resolves.toEqual({ revision: 0 });
        } finally {
            await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "machine_pool_delete_cas_loss"`);
        }
    });

    it("uses exact live sockets over stale active bits and excludes revoked members", async () => {
        await seed();
        await createMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                name: "Resolve",
                members: [
                    { machineId: "m-fast", priorityTier: 0, enabled: true },
                    { machineId: "m-slow", priorityTier: 1, enabled: true },
                ],
            },
            io: io(),
        });
        await expect(getMachinePool({ accountId: ownerId, poolId, io: io() })).resolves.toMatchObject({
            ok: true,
            value: {
                pool: {
                    members: [
                        { machineId: "m-fast", priorityTier: 0, enabled: true, state: "offline" },
                        { machineId: "m-slow", priorityTier: 1, enabled: true, state: "offline" },
                    ],
                },
                availability: { state: "known", enabledCount: 2, connectedCount: 0 },
            },
        });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "a" },
            io: io(["m-fast"]),
        })).resolves.toEqual({ ok: true, value: { kind: "resolved", poolId, machineId: "m-fast", priorityTier: 0 } });
        await db.machine.update({ where: { id: "m-fast" }, data: { revokedAt: new Date() } });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "a" },
            io: io(["m-fast", "m-slow"]),
        })).resolves.toEqual({ ok: true, value: { kind: "resolved", poolId, machineId: "m-slow", priorityTier: 1 } });
        await db.machine.update({ where: { id: "m-slow" }, data: { replacedByMachineId: "m-replacement" } });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "a" },
            io: io(["m-fast", "m-slow"]),
        })).resolves.toEqual({ ok: true, value: { kind: "unavailable", poolId, reason: "no_available_machine" } });
        await expect(getMachinePool({ accountId: ownerId, poolId, io: io(["m-fast", "m-slow"]) })).resolves.toMatchObject({
            ok: true,
            value: {
                pool: {
                    members: [
                        { machineId: "m-fast", state: "revoked" },
                        { machineId: "m-slow", state: "replaced" },
                    ],
                },
                availability: { state: "known", connectedCount: 0 },
            },
        });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "a" },
            io: { in: () => ({ fetchSockets: async () => { throw new Error("redis down"); } }) },
        })).resolves.toEqual({ ok: true, value: { kind: "unavailable", poolId, reason: "presence_unavailable" } });
    });

    it("resolves from the current Pool revision across member edits, disconnect, and reconnect", async () => {
        await seed();
        await createMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                name: "Moving definition",
                members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }],
            },
            io: io(),
        });

        let releasePresence!: (machineIds: readonly string[]) => void;
        let markPresenceStarted!: () => void;
        const presenceStarted = new Promise<void>((resolve) => {
            markPresenceStarted = resolve;
        });
        const presenceResult = new Promise<readonly string[]>((resolve) => {
            releasePresence = resolve;
        });
        const pendingResolve = resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "same-request" },
            io: {
                in: () => ({
                    fetchSockets: async () => {
                        markPresenceStarted();
                        return (await presenceResult).map((machineId) => ({
                            data: { clientType: "machine-scoped", userId: ownerId, machineId },
                        }));
                    },
                }),
            },
        });

        await presenceStarted;
        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                expectedRevision: 0,
                name: "Moving definition",
                members: [{ machineId: "m-slow", priorityTier: 7, enabled: true }],
            },
            io: io(),
        })).resolves.toMatchObject({ ok: true, value: { pool: { revision: 1 } } });
        releasePresence(["m-fast", "m-slow"]);

        await expect(pendingResolve).resolves.toEqual({
            ok: true,
            value: { kind: "resolved", poolId, machineId: "m-slow", priorityTier: 7 },
        });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "same-request" },
            io: io(),
        })).resolves.toEqual({
            ok: true,
            value: { kind: "unavailable", poolId, reason: "no_available_machine" },
        });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "same-request" },
            io: io(["m-slow"]),
        })).resolves.toEqual({
            ok: true,
            value: { kind: "resolved", poolId, machineId: "m-slow", priorityTier: 7 },
        });
    });

    it('rereads Pool policy after the conditional census and keeps newly added members unknown', async () => {
        await seed();
        await createMachinePool({ accountId: ownerId, input: { poolId, name: 'Moving twice',
            members: [{ machineId: 'm-fast', priorityTier: 0, enabled: true }] }, io: io() });
        let firstStarted!: () => void;
        let secondStarted!: () => void;
        const firstStart = new Promise<void>(resolve => { firstStarted = resolve; });
        const secondStart = new Promise<void>(resolve => { secondStarted = resolve; });
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const first = new Promise<void>(resolve => { releaseFirst = resolve; });
        const second = new Promise<void>(resolve => { releaseSecond = resolve; });
        const queriedRooms: (string | string[])[] = [];
        const pending = getMachinePoolCandidateSnapshot({ accountId: ownerId, poolId, io: {
            in: room => ({ fetchSockets: async () => {
                queriedRooms.push(room);
                const machineId = queriedRooms.length === 1 ? 'm-fast' : 'm-slow';
                if (queriedRooms.length === 1) { firstStarted(); await first; }
                else if (queriedRooms.length === 2) { secondStarted(); await second; }
                else throw new Error('A changed Pool must settle without a discovery loop');
                return [{ data: { userId: ownerId, clientType: 'machine-scoped', machineId } }];
            } }),
        } });
        await firstStart;
        await updateMachinePool({ accountId: ownerId, input: { poolId, expectedRevision: 0, name: 'Moving twice',
            members: [{ machineId: 'm-slow', priorityTier: 7, enabled: true }] }, io: io() });
        releaseFirst();
        await secondStart;
        await updateMachinePool({ accountId: ownerId, input: { poolId, expectedRevision: 1, name: 'Moving twice',
            members: [{ machineId: 'm-fast', priorityTier: 9, enabled: true }] }, io: io() });
        releaseSecond();
        expect(await pending).toMatchObject({ ok: true, value: {
            revision: 2,
            members: [{ machineId: 'm-fast', priorityTier: 9, enabled: true }],
            presenceState: 'partial', availableMachineIds: new Set(),
        } });
        expect(queriedRooms).toEqual([`machine:m-fast:${ownerId}`, `machine:m-slow:${ownerId}`]);
    });

    it('shares one exact enabled-member union across many requested Pools and never widens empty demand', async () => {
        await seed();
        await db.machine.update({ where: { id: 'm-fast' }, data: {
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '1'.repeat(64) } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
        await db.machinePool.createMany({ data: ids.map(id => ({ id, accountId: ownerId, name: 'Bulk snapshot' })) });
        await db.machinePoolMember.createMany({ data: ids.flatMap(poolId => ['m-fast', 'm-slow'].map(machineId => ({
            poolId, machineId, enabled: true, priorityTier: 0,
        }))) });
        const foreign = await db.machinePool.create({ data: { id: crypto.randomUUID(), accountId: otherId, name: 'Foreign' } });
        const rooms: string[][] = [];
        let transportedIdentities = 0;
        const transport: MachineDaemonPresenceSocketServer = { in: room => ({ fetchSockets: async () => {
            const selected = typeof room === 'string' ? [room] : room;
            rooms.push(selected);
            const candidates = ['m-fast', 'm-slow', ...Array.from({ length: 1000 }, (_, index) => `unrelated-${index}`)];
            const matching = candidates.filter(machineId => selected.includes(getUserMachinesSocketRoom(ownerId))
                || selected.includes(getMachineSocketRoom(ownerId, machineId)));
            transportedIdentities += matching.length;
            return matching.map(machineId => ({ data: { clientType: 'machine-scoped', userId: ownerId, machineId } }));
        } }) };
        const snapshots = await getMachinePoolCandidateSnapshots({ accountId: ownerId, poolIds: [...ids, foreign.id], io: transport });
        expect(snapshots.size).toBe(ids.length);
        expect(snapshots.has(foreign.id)).toBe(false);
        for (const snapshot of snapshots.values()) expect(snapshot).toMatchObject({
            presenceState: 'known', availableMachineIds: new Set(['m-fast', 'm-slow']),
            machineEndpointIds: new Map([['m-fast', '1'.repeat(64)], ['m-slow', null]]),
        });
        expect(rooms.map(scope => scope.slice().sort())).toEqual([['m-fast', 'm-slow'].map(id => getMachineSocketRoom(ownerId, id)).sort()]);
        expect(transportedIdentities).toBe(2);
        rooms.length = 0;
        await db.machinePoolMember.updateMany({ where: { poolId: { in: ids } }, data: { enabled: false } });
        const disabled = await getMachinePoolCandidateSnapshots({ accountId: ownerId, poolIds: ids, io: transport });
        expect(disabled.size).toBe(ids.length);
        expect([...disabled.values()].every(snapshot => snapshot.availableMachineIds.size === 0 && snapshot.presenceState === 'known')).toBe(true);
        expect(await getMachinePoolCandidateSnapshots({ accountId: ownerId, poolIds: [], io: transport })).toEqual(new Map());
        expect(rooms).toEqual([]);
    });

    it('reads final bulk Pool definitions after a second exact census without looping for newly added members', async () => {
        await seed();
        const secondPoolId = crypto.randomUUID();
        await db.machine.create({ data: { id: 'm-final', accountId: ownerId, metadata: '{}' } });
        for (const id of [poolId, secondPoolId]) await db.machinePool.create({ data: {
            id, accountId: ownerId, name: 'Moving bulk Pool', members: { create: { machineId: 'm-fast', priorityTier: 0, enabled: true } },
        } });
        const rooms: string[][] = [];
        const transport: MachineDaemonPresenceSocketServer = { in: room => ({ fetchSockets: async () => {
            rooms.push(typeof room === 'string' ? [room] : room);
            if (rooms.length === 1) {
                await db.machinePoolMember.deleteMany({ where: { poolId: { in: [poolId, secondPoolId] } } });
                await db.machinePoolMember.createMany({ data: [poolId, secondPoolId].map(id => ({ poolId: id, machineId: 'm-slow', priorityTier: 7, enabled: true })) });
                await db.machinePool.updateMany({ where: { id: { in: [poolId, secondPoolId] } }, data: { revision: 1 } });
                return [{ data: { clientType: 'machine-scoped', userId: ownerId, machineId: 'm-fast' } }];
            }
            if (rooms.length !== 2) throw new Error('Bulk Pool discovery must settle without a retry loop');
            await db.machinePoolMember.deleteMany({ where: { poolId } });
            await db.machinePoolMember.create({ data: { poolId, machineId: 'm-final', priorityTier: 9, enabled: true } });
            await db.machinePool.update({ where: { id: poolId }, data: { revision: 2 } });
            return [{ data: { clientType: 'machine-scoped', userId: ownerId, machineId: 'm-slow' } }];
        } }) };
        const snapshots = await getMachinePoolCandidateSnapshots({ accountId: ownerId, poolIds: [poolId, secondPoolId], io: transport });
        expect(rooms).toEqual([[getMachineSocketRoom(ownerId, 'm-fast')], [getMachineSocketRoom(ownerId, 'm-slow')]]);
        expect(snapshots.get(poolId)).toMatchObject({ revision: 2, presenceState: 'partial', availableMachineIds: new Set(),
            members: [{ machineId: 'm-final', priorityTier: 9, enabled: true }] });
        expect(snapshots.get(secondPoolId)).toMatchObject({ revision: 1, presenceState: 'known', availableMachineIds: new Set(['m-slow']),
            members: [{ machineId: 'm-slow', priorityTier: 7, enabled: true }] });
    });

    it("resolves empty and all-disabled pools as empty without consulting presence", async () => {
        await seed();
        const emptyPoolId = "622138f7-acf4-4a1b-93f1-b84332616225";
        const presenceLookup = vi.fn(async () => {
            throw new Error("presence should not be consulted");
        });
        const unavailablePresence = { in: () => ({ fetchSockets: presenceLookup }) };

        await createMachinePool({
            accountId: ownerId,
            input: { poolId: emptyPoolId, name: "Empty", members: [] },
            io: io(),
        });
        await createMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                name: "Disabled",
                members: [{ machineId: "m-fast", priorityTier: 0, enabled: false }],
            },
            io: io(),
        });

        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId: emptyPoolId, requestKey: "empty" },
            io: unavailablePresence,
        })).resolves.toEqual({ ok: true, value: { kind: "unavailable", poolId: emptyPoolId, reason: "empty" } });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "disabled" },
            io: unavailablePresence,
        })).resolves.toEqual({ ok: true, value: { kind: "unavailable", poolId, reason: "empty" } });
        expect(presenceLookup).not.toHaveBeenCalled();
    });

    it("rejects temporary Machines and preserves a saved temporary member as visibly unavailable", async () => {
        await seed();
        const rejectedPoolId = "d54f045d-2865-409a-94dd-719d436ed7a8";
        await db.machine.create({
            data: {
                id: "m-temporary",
                kind: "ephemeral_session_runner",
                accountId: ownerId,
                metadata: "{}",
                active: true,
            },
        });

        await expect(createMachinePool({
            accountId: ownerId,
            input: {
                poolId: rejectedPoolId,
                name: "Must reject temporary",
                members: [{ machineId: "m-temporary", priorityTier: 0, enabled: true }],
            },
            io: io(["m-temporary"]),
        })).resolves.toEqual({
            ok: false,
            error: { code: "member_machine_not_eligible", machineIds: ["m-temporary"] },
        });
        expect(await db.machinePool.findUnique({ where: { id: rejectedPoolId } })).toBeNull();

        await createMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                name: "Becomes temporary",
                members: [{ machineId: "m-fast", priorityTier: 2147483647, enabled: true }],
            },
            io: io(),
        });
        await db.machine.update({
            where: { id: "m-fast" },
            data: { kind: "ephemeral_session_runner" },
        });

        await expect(getMachinePool({ accountId: ownerId, poolId, io: io(["m-fast"]) })).resolves.toMatchObject({
            ok: true,
            value: {
                pool: { members: [{ machineId: "m-fast", enabled: true, state: "temporary" }] },
                availability: { state: "known", enabledCount: 1, connectedCount: 0 },
            },
        });
        await expect(resolveMachinePool({
            accountId: ownerId,
            input: { poolId, requestKey: "temporary" },
            io: io(["m-fast"]),
        })).resolves.toEqual({
            ok: true,
            value: { kind: "unavailable", poolId, reason: "no_available_machine" },
        });
        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                expectedRevision: 0,
                name: "Renamed despite temporary member",
                members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }],
            },
            io: io(["m-fast"]),
        })).resolves.toMatchObject({
            ok: true,
            value: {
                pool: {
                    revision: 1,
                    name: "Renamed despite temporary member",
                    members: [{ machineId: "m-fast", enabled: true, state: "temporary" }],
                },
                availability: { state: "known", enabledCount: 1, connectedCount: 0 },
            },
        });

        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                expectedRevision: 1,
                name: "Disabled temporary member",
                members: [{ machineId: "m-fast", priorityTier: 0, enabled: false }],
            },
            io: io(["m-fast"]),
        })).resolves.toMatchObject({
            ok: true,
            value: { pool: { revision: 2, members: [{ machineId: "m-fast", enabled: false, state: "temporary" }] } },
        });
        await expect(updateMachinePool({
            accountId: ownerId,
            input: {
                poolId,
                expectedRevision: 2,
                name: "Must not re-enable temporary",
                members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }],
            },
            io: io(["m-fast"]),
        })).resolves.toEqual({
            ok: false,
            error: { code: "member_machine_not_eligible", machineIds: ["m-fast"] },
        });
    });

    it("settles concurrent writers at one revision without mixing aggregate members", async () => {
        await seed();
        await createMachinePool({
            accountId: ownerId,
            input: { poolId, name: "Base", members: [{ machineId: "m-fast", priorityTier: 0, enabled: true }] },
            io: io(),
        });
        const [left, right] = await Promise.all([
            updateMachinePool({
                accountId: ownerId,
                input: {
                    poolId,
                    expectedRevision: 0,
                    name: "Left",
                    members: [{ machineId: "m-fast", priorityTier: 10, enabled: true }],
                },
                io: io(),
            }),
            updateMachinePool({
                accountId: ownerId,
                input: {
                    poolId,
                    expectedRevision: 0,
                    name: "Right",
                    members: [{ machineId: "m-slow", priorityTier: 20, enabled: true }],
                },
                io: io(),
            }),
        ]);
        expect([left.ok, right.ok].sort()).toEqual([false, true]);
        const stored = await db.machinePool.findUniqueOrThrow({ where: { id: poolId }, include: { members: true } });
        expect(stored.revision).toBe(1);
        expect([
            { name: "Left", members: [{ machineId: "m-fast", priorityTier: 10 }] },
            { name: "Right", members: [{ machineId: "m-slow", priorityTier: 20 }] },
        ]).toContainEqual({
            name: stored.name,
            members: stored.members.map(({ machineId, priorityTier }) => ({ machineId, priorityTier })),
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: ownerId }, select: { seq: true } })).toEqual({ seq: 2 });
    });

    it("uses pool id as the stable total-order tie-break for equal creation times", async () => {
        await seed();
        const createdAt = new Date("2026-09-08T10:00:00.000Z");
        await db.machinePool.createMany({
            data: [
                { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", accountId: ownerId, name: "Later id", createdAt, updatedAt: createdAt },
                { id: "00000000-0000-4000-8000-000000000000", accountId: ownerId, name: "Earlier id", createdAt, updatedAt: createdAt },
            ],
        });

        await expect(listMachinePools({ accountId: ownerId, io: io() })).resolves.toMatchObject([
            { pool: { id: "00000000-0000-4000-8000-000000000000" } },
            { pool: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
        ]);
    });

    it("atomically saves an aggregate beyond SQLite's historical bind boundary", async () => {
        await seed();
        const members = Array.from({ length: 1_001 }, (_, index) => ({
            machineId: `m-large-${index.toString().padStart(4, "0")}`,
            priorityTier: index % 3,
            enabled: true,
        }));
        for (let index = 0; index < members.length; index += 150) {
            await db.machine.createMany({
                data: members.slice(index, index + 150).map((member) => ({
                    id: member.machineId,
                    accountId: ownerId,
                    metadata: "{}",
                })),
            });
        }

        const created = await createMachinePool({
            accountId: ownerId,
            input: { poolId, name: "Large aggregate", members },
            io: io(),
        });
        expect(created).toMatchObject({ ok: true, value: { pool: { revision: 0 } } });
        if (!created.ok) throw new Error("Expected the large Machine Pool aggregate to be created");
        expect(created.value.pool.members).toHaveLength(1_001);
        expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1_001);
        expect(await db.accountChange.count({ where: { accountId: ownerId, kind: "machinePool" } })).toBe(1);
    });
});
