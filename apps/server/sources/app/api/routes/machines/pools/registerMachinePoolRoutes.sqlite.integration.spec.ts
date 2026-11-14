import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { plainPrivateLabel, storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";

const readLabel = (value: string) => ({ kind: "available", label: { content: { t: "plain", v: value }, recipientEnvelope: null } });
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type { MachineDaemonPresenceSocketServer } from "@/app/machines/machineDaemonPresence";
import { createAuthenticatedTestApp } from "../../../testkit/sqliteFastify";
import { registerMachinePoolRoutes } from "./registerMachinePoolRoutes";

const accountId = "pool-http-owner";
const otherAccountId = "pool-http-other";
const machineId = "pool-http-machine";
const fallbackMachineId = "pool-http-fallback";
const foreignMachineId = "pool-http-foreign";
const poolId = "72ca3a14-59d7-4aef-bcd3-589a84605545";

const headers = { "x-test-user-id": accountId };
const otherHeaders = { "x-test-user-id": otherAccountId };

/**
 * Socket.IO is the only genuine system boundary faked here: everything below the route — the
 * Machine Pool domain service, its transaction, the selector and SQLite persistence — is real.
 */
function presenceOf(connectedMachineIds: readonly string[]): MachineDaemonPresenceSocketServer {
    return {
        in: () => ({
            fetchSockets: async () => connectedMachineIds.map((connectedId) => ({
                data: { clientType: "machine-scoped", userId: accountId, machineId: connectedId },
            })),
        }),
    };
}

async function withPoolRoutes(
    run: (app: ReturnType<typeof createAuthenticatedTestApp>) => Promise<void>,
    io: MachineDaemonPresenceSocketServer = presenceOf([machineId]),
): Promise<void> {
    const app = createAuthenticatedTestApp();
    registerMachinePoolRoutes(app, { io });
    await app.ready();
    try {
        await run(app);
    } finally {
        await app.close();
    }
}

async function seedAccounts(): Promise<void> {
    await db.account.createMany({
        data: [
            { id: accountId, publicKey: null, encryptionMode: "plain" },
            { id: otherAccountId, publicKey: null, encryptionMode: "plain" },
        ],
    });
    await db.machine.createMany({
        data: [
            { id: machineId, accountId, metadata: "{}", active: false },
            { id: fallbackMachineId, accountId, metadata: "{}", active: false },
            { id: foreignMachineId, accountId: otherAccountId, metadata: "{}", active: false },
        ],
    });
}

async function countOwnerChanges(): Promise<number> {
    return await db.accountChange.count({ where: { accountId, kind: "machinePool" } });
}

describe("Machine Pool HTTP routes (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-pool-http-", initAuth: false });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        delete process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED;
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.machinePoolMember.deleteMany(),
            () => db.machinePool.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it.each(['connected', 'offline', 'unavailable'] as const)('shares aggregate %s availability without Machine identities or controller resolution', async presence => {
        await seedAccounts();
        const team = await db.team.create({ data: { name: 'Build team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId, role: 'admin' },
            { teamId: team.id, accountId: otherAccountId, role: 'member' },
        ] });
        await withPoolRoutes(async app => {
            const definition = { poolId, name: plainPrivateLabel('Shared builders'), audience: { kind: 'team', teamId: team.id },
                members: [{ machineId, priorityTier: 0, enabled: true }] };
            const created = await app.inject({ method: 'POST', url: '/v1/machines/pools/create', headers, payload: definition });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toMatchObject({ pool: { audience: definition.audience },
                access: { canManage: true, canResolve: true, canViewMembers: true } });
            const memberRead = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } });
            expect(memberRead.statusCode).toBe(200);
            expect(memberRead.json()).toMatchObject({ pool: { name: { kind: 'available', label: { content: definition.name.content, recipientEnvelope: null } }, audience: definition.audience, members: [] },
                availability: presence === 'unavailable' ? { state: 'unknown' }
                    : { state: 'known', enabledCount: 1, connectedCount: presence === 'connected' ? 1 : 0 },
                access: { canManage: false, canResolve: false, canViewMembers: false } });
            expect(JSON.stringify(memberRead.json())).not.toContain(machineId);
            const listed = await app.inject({ method: 'POST', url: '/v1/machines/pools/list', headers: otherHeaders, payload: {} });
            expect(listed.json()).toEqual({ pools: [memberRead.json()] });
            const resolved = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve', headers: otherHeaders,
                payload: { poolId, requestKey: 'member-must-not-spawn' } });
            expect(resolved.statusCode).toBe(404);
            expect(resolved.json()).toEqual({ code: 'pool_not_found' });
            const edited = await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers: otherHeaders,
                payload: { ...definition, expectedRevision: 0, members: [] } });
            expect(edited.statusCode).toBe(404);
            expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1);
            await db.teamMembership.deleteMany({ where: { accountId: otherAccountId } });
            const removed = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } });
            expect(removed.statusCode).toBe(404);
            expect(removed.json()).toEqual({ code: 'pool_not_found' });
            const ownerRead = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers, payload: { poolId } });
            expect(ownerRead.statusCode).toBe(200);
            await db.teamMembership.create({ data: { teamId: team.id, accountId: otherAccountId, role: 'member' } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 99 } } });
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/list', headers: otherHeaders, payload: {} })).json()).toEqual({ pools: [] });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: 'inherit' }, archivedAt: new Date() } });
            const archived = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } });
            expect(archived.statusCode).toBe(404);
            expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId } })).toBe(0);
        }, presence === 'unavailable' ? { in: () => ({ fetchSockets: async () => { throw new Error('presence unavailable'); } }) }
            : presenceOf(presence === 'connected' ? [machineId] : []));
    });

    it.each(['removed', 'suspended'] as const)('makes a %s custodian publication unavailable to the Team while preserving custodian management', async withdrawal => {
        await seedAccounts();
        const team = await db.team.create({ data: { name: 'Former Team' } });
        const retainedTeam = await db.team.create({ data: { name: 'Current Team' } });
        for (const teamId of [team.id, retainedTeam.id]) await db.teamMembership.createMany({ data: [
            { teamId, accountId, role: 'admin' },
            { teamId, accountId: otherAccountId, role: 'member' },
        ] });
        await withPoolRoutes(async app => {
            const definition = { poolId, name: plainPrivateLabel('Published builders'), audience: { kind: 'team', teamId: team.id },
                members: [{ machineId, priorityTier: 0, enabled: true }] };
            const retainedPoolId = '589396c1-a343-4d42-83e6-27d90bbc2e16';
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/create', headers, payload: definition })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/create', headers, payload: {
                ...definition, poolId: retainedPoolId, audience: { kind: 'team', teamId: retainedTeam.id },
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } })).statusCode).toBe(200);
            if (withdrawal === 'removed') await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId } } });
            else await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId } }, data: { status: 'suspended' } });
            const unavailable = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } });
            expect(unavailable.statusCode).toBe(404);
            expect(unavailable.json()).toEqual({ code: 'pool_not_found' });
            const listed = await app.inject({ method: 'POST', url: '/v1/machines/pools/list', headers: otherHeaders, payload: {} });
            expect(listed.json().pools.map((pool: { pool: { id: string } }) => pool.pool.id)).toEqual([retainedPoolId]);
            expect(listed.json().pools[0]).toMatchObject({ pool: { members: [] }, access: { canViewMembers: false } });
            expect(JSON.stringify(listed.json())).not.toContain(machineId);
            const ownerRead = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers, payload: { poolId } });
            expect(ownerRead.statusCode).toBe(200);
            expect(ownerRead.json()).toMatchObject({ pool: { members: [{ machineId }] }, access: { canManage: true, canViewMembers: true } });
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers, payload: {
                ...definition, name: plainPrivateLabel('Still owned'), expectedRevision: 0,
            } })).statusCode).toBe(200);
        });
    });

    it('publishes sharing and withdrawal to both audiences and refuses a non-admin Team publication', async () => {
        await seedAccounts();
        const team = await db.team.create({ data: { name: 'Build team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId, role: 'member' },
            { teamId: team.id, accountId: otherAccountId, role: 'member' },
        ] });
        await withPoolRoutes(async app => {
            const definition = { poolId, name: plainPrivateLabel('Builders'), members: [{ machineId, priorityTier: 0, enabled: true }] };
            const denied = await app.inject({ method: 'POST', url: '/v1/machines/pools/create', headers,
                payload: { ...definition, audience: { kind: 'team', teamId: team.id } } });
            expect(denied.statusCode).toBe(404);
            expect(await db.machinePool.count()).toBe(0);
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/create', headers, payload: definition })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } })).statusCode).toBe(404);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId } }, data: { role: 'admin' } });
            const shared = await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers,
                payload: { ...definition, expectedRevision: 0, audience: { kind: 'team', teamId: team.id } } });
            expect(shared.statusCode).toBe(200);
            expect(await db.accountChange.count({ where: { accountId: otherAccountId, kind: 'machinePool', entityId: poolId } })).toBe(1);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId } }, data: { role: 'member' } });
            const explicitUnchangedAudience = await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers,
                payload: { ...definition, name: plainPrivateLabel('Renamed builders'), expectedRevision: 1, audience: { kind: 'team', teamId: team.id } } });
            expect(explicitUnchangedAudience.statusCode).toBe(200);
            const omittedAudience = await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers,
                payload: { ...definition, name: plainPrivateLabel('Renamed again'), expectedRevision: 2 } });
            expect(omittedAudience.statusCode).toBe(200);
            expect(omittedAudience.json().pool.audience).toEqual(explicitUnchangedAudience.json().pool.audience);
            const before = await db.account.findUniqueOrThrow({ where: { id: otherAccountId }, select: { seq: true } });
            const withdrawn = await app.inject({ method: 'POST', url: '/v1/machines/pools/update', headers,
                payload: { ...definition, expectedRevision: 3, audience: { kind: 'private' } } });
            expect(withdrawn.statusCode).toBe(200);
            const after = await db.account.findUniqueOrThrow({ where: { id: otherAccountId }, select: { seq: true } });
            expect(after.seq).toBeGreaterThan(before.seq);
            const hidden = await app.inject({ method: 'POST', url: '/v1/machines/pools/get', headers: otherHeaders, payload: { poolId } });
            expect(hidden.statusCode).toBe(404);
            expect(hidden.json()).toEqual({ code: 'pool_not_found' });
            expect((await app.inject({ method: 'POST', url: '/v1/machines/pools/list', headers: otherHeaders, payload: {} })).json()).toEqual({ pools: [] });
        });
    });

    it("creates, lists, gets, resolves, updates and deletes one aggregate through the authenticated contract", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            const created = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: {
                    poolId,
                    name: plainPrivateLabel("HTTP pool"),
                    description: null,
                    members: [
                        { machineId: fallbackMachineId, priorityTier: 3, enabled: true },
                        { machineId, priorityTier: 0, enabled: true },
                    ],
                },
            });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toEqual({
                pool: {
                    id: poolId,
                    name: readLabel("HTTP pool"),
                    description: null,
                    audience: { kind: 'private' },
                    revision: 0,
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                    members: [
                        { machineId, priorityTier: 0, enabled: true, state: "connected" },
                        { machineId: fallbackMachineId, priorityTier: 3, enabled: true, state: "offline" },
                    ],
                },
                availability: { state: "known", enabledCount: 2, connectedCount: 1 },
                access: { canManage: true, canResolve: true, canViewMembers: true },
            });
            expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(2);
            expect(await countOwnerChanges()).toBe(1);

            const listed = await app.inject({ method: "POST", url: "/v1/machines/pools/list", headers, payload: {} });
            expect(listed.statusCode).toBe(200);
            expect(listed.json()).toEqual({ pools: [created.json()] });

            const eligibility = await app.inject({ method: "POST", url: "/v1/machines/pools/list", headers,
                payload: { memberMachineIds: [machineId, "not-owned-or-missing"] } });
            expect(eligibility.statusCode).toBe(200);
            expect(eligibility.json()).toMatchObject({ memberEligibility: [
                { machineId, eligible: true },
                { machineId: "not-owned-or-missing", eligible: false, reason: "not_owned_or_missing" },
            ] });

            const fetched = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/get",
                headers,
                payload: { poolId },
            });
            expect(fetched.statusCode).toBe(200);
            expect(fetched.json()).toEqual(created.json());

            const resolved = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/resolve",
                headers,
                payload: { poolId, requestKey: "http-request" },
            });
            expect(resolved.statusCode).toBe(200);
            expect(resolved.json()).toEqual({ kind: "resolved", poolId, machineId, priorityTier: 0 });

            const updated = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/update",
                headers,
                payload: {
                    poolId,
                    expectedRevision: 0,
                    name: plainPrivateLabel("Renamed pool"),
                    description: plainPrivateLabel("Primary then fallback"),
                    members: [{ machineId: fallbackMachineId, priorityTier: 0, enabled: true }],
                },
            });
            expect(updated.statusCode).toBe(200);
            expect(updated.json()).toMatchObject({
                pool: {
                    revision: 1,
                    name: readLabel("Renamed pool"),
                    description: readLabel("Primary then fallback"),
                    members: [{ machineId: fallbackMachineId, priorityTier: 0, enabled: true, state: "offline" }],
                },
                availability: { state: "known", enabledCount: 1, connectedCount: 0 },
            });
            expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(1);
            // AccountChange is the canonical coalesced per-entity projection: each
            // mutation advances Account.seq and replaces this Pool's one change row.
            expect(await countOwnerChanges()).toBe(1);

            // A pool whose members are all disconnected is a successful observation, not an HTTP failure.
            const unavailable = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/resolve",
                headers,
                payload: { poolId, requestKey: "http-request" },
            });
            expect(unavailable.statusCode).toBe(200);
            expect(unavailable.json()).toEqual({ kind: "unavailable", poolId, reason: "no_available_machine" });

            const deleted = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/delete",
                headers,
                payload: { poolId, expectedRevision: 1 },
            });
            expect(deleted.statusCode).toBe(200);
            expect(deleted.json()).toEqual({ poolId, deleted: true });
            expect(await db.machinePool.findUnique({ where: { id: poolId } })).toBeNull();
            expect(await db.machinePoolMember.count({ where: { poolId } })).toBe(0);
            expect(await countOwnerChanges()).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
                .toEqual({ seq: 3 });
        });
    });

    it("settles a lost-response retry of the same create and delete without duplicating durable effects", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            const payload = {
                poolId,
                name: plainPrivateLabel("Retried pool"),
                members: [{ machineId, priorityTier: 0, enabled: true }],
            };
            const first = await app.inject({ method: "POST", url: "/v1/machines/pools/create", headers, payload });
            expect(first.statusCode).toBe(200);

            const replay = await app.inject({ method: "POST", url: "/v1/machines/pools/create", headers, payload });
            expect(replay.statusCode).toBe(200);
            expect(replay.json()).toEqual(first.json());
            expect(await db.machinePool.count({ where: { accountId } })).toBe(1);
            expect(await countOwnerChanges()).toBe(1);

            // The same ID carrying a different definition is a conflict, never a silent overwrite.
            const diverged = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { ...payload, name: plainPrivateLabel("Different definition") },
            });
            expect(diverged.statusCode).toBe(409);
            expect(diverged.json()).toMatchObject({
                code: "pool_changed",
                current: { pool: { name: readLabel("Retried pool"), revision: 0 } },
            });

            for (const attempt of [0, 1]) {
                const deleted = await app.inject({
                    method: "POST",
                    url: "/v1/machines/pools/delete",
                    headers,
                    payload: { poolId, expectedRevision: 0 },
                });
                expect(deleted.statusCode, `delete attempt ${attempt}`).toBe(200);
                expect(deleted.json()).toEqual({ poolId, deleted: true });
            }
            expect(await countOwnerChanges()).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
                .toEqual({ seq: 2 });
        });
    });

    it("maps stale revisions to 409 and rolls the whole aggregate back on an ineligible member", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { poolId, name: plainPrivateLabel("Guarded"), members: [{ machineId, priorityTier: 0, enabled: true }] },
            });
            await app.inject({
                method: "POST",
                url: "/v1/machines/pools/update",
                headers,
                payload: {
                    poolId,
                    expectedRevision: 0,
                    name: plainPrivateLabel("Guarded v1"),
                    members: [{ machineId, priorityTier: 1, enabled: true }],
                },
            });

            const staleUpdate = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/update",
                headers,
                payload: {
                    poolId,
                    expectedRevision: 0,
                    name: plainPrivateLabel("Stale writer"),
                    members: [{ machineId, priorityTier: 9, enabled: false }],
                },
            });
            expect(staleUpdate.statusCode).toBe(409);
            expect(staleUpdate.json()).toMatchObject({
                code: "pool_changed",
                current: { pool: { name: readLabel("Guarded v1"), revision: 1 } },
            });

            const staleDelete = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/delete",
                headers,
                payload: { poolId, expectedRevision: 0 },
            });
            expect(staleDelete.statusCode).toBe(409);
            expect(staleDelete.json()).toMatchObject({ code: "pool_changed", current: { pool: { revision: 1 } } });

            const ineligible = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/update",
                headers,
                payload: {
                    poolId,
                    expectedRevision: 1,
                    name: plainPrivateLabel("Must roll back"),
                    members: [
                        { machineId: fallbackMachineId, priorityTier: 0, enabled: true },
                        { machineId: foreignMachineId, priorityTier: 1, enabled: true },
                    ],
                },
            });
            expect(ineligible.statusCode).toBe(400);
            expect(ineligible.json()).toEqual({
                code: "member_machine_not_eligible",
                machineIds: [foreignMachineId],
            });

            const unchanged = await db.machinePool.findUniqueOrThrow({
                where: { id: poolId },
                include: { members: true },
            });
            expect(unchanged).toMatchObject({ name: storedPlainPrivateLabel("Guarded v1"), revision: 1 });
            expect(unchanged.members).toEqual([
                expect.objectContaining({ machineId, priorityTier: 1, enabled: true }),
            ]);
            expect(await countOwnerChanges()).toBe(1);

            const missing = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/get",
                headers,
                payload: { poolId: "9dd3f4bb-0f2b-4f0e-a34c-7b52c0d7f5b6" },
            });
            expect(missing.statusCode).toBe(404);
            expect(missing.json()).toEqual({ code: "pool_not_found" });
        });
    });

    it("keeps another Account's Pool undiscoverable and unmutable", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            const foreign = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers: otherHeaders,
                payload: { poolId, name: plainPrivateLabel("Private pool"), members: [] },
            });
            expect(foreign.statusCode).toBe(200);

            const read = await app.inject({ method: "POST", url: "/v1/machines/pools/get", headers, payload: { poolId } });
            expect(read.statusCode).toBe(404);
            expect(read.json()).toEqual({ code: "pool_not_found" });

            const listed = await app.inject({ method: "POST", url: "/v1/machines/pools/list", headers, payload: {} });
            expect(listed.statusCode).toBe(200);
            expect(listed.json()).toEqual({ pools: [] });

            const collision = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { poolId, name: plainPrivateLabel("Mine now"), members: [] },
            });
            expect(collision.statusCode).toBe(409);
            // The nondisclosing conflict carries no data owned by the other Account.
            expect(collision.json()).toEqual({ code: "pool_changed" });

            const hijack = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/update",
                headers,
                payload: { poolId, expectedRevision: 0, name: plainPrivateLabel("Hijacked"), members: [] },
            });
            expect(hijack.statusCode).toBe(404);
            expect(hijack.json()).toEqual({ code: "pool_not_found" });

            const resolve = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/resolve",
                headers,
                payload: { poolId, requestKey: "foreign" },
            });
            expect(resolve.statusCode).toBe(404);
            expect(resolve.json()).toEqual({ code: "pool_not_found" });

            const destroy = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/delete",
                headers,
                payload: { poolId, expectedRevision: 0 },
            });
            expect(destroy.statusCode).toBe(200);
            expect(destroy.json()).toEqual({ poolId, deleted: true });

            expect(await db.machinePool.findUniqueOrThrow({ where: { id: poolId } }))
                .toMatchObject({ accountId: otherAccountId, name: storedPlainPrivateLabel("Private pool") });
            expect(await countOwnerChanges()).toBe(0);
        });
    });

    it("refuses malformed and unknown-field requests before the domain owner runs", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            const malformedId = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/get",
                headers,
                payload: { poolId: "not-a-uuid" },
            });
            expect(malformedId.statusCode).toBe(400);
            expect(malformedId.json()).toMatchObject({ code: "invalid_request" });

            const unknownField = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: {
                    poolId,
                    name: plainPrivateLabel("Unknown field"),
                    accountId: otherAccountId,
                    members: [{ machineId, priorityTier: 0, enabled: true }],
                },
            });
            expect(unknownField.statusCode).toBe(400);
            expect(unknownField.json()).toMatchObject({ code: "invalid_request" });

            const unknownMemberField = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: {
                    poolId,
                    name: plainPrivateLabel("Unknown member field"),
                    members: [{ machineId, priorityTier: 0, enabled: true, weight: 5 }],
                },
            });
            expect(unknownMemberField.statusCode).toBe(400);

            const duplicateMember = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: {
                    poolId,
                    name: plainPrivateLabel("Duplicate member"),
                    members: [
                        { machineId, priorityTier: 0, enabled: true },
                        { machineId, priorityTier: 1, enabled: true },
                    ],
                },
            });
            expect(duplicateMember.statusCode).toBe(400);

            const blankName = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { poolId, name: { content: { t: "encrypted", c: "malformed" }, recipients: [] }, members: [] },
            });
            expect(blankName.statusCode).toBe(400);

            const missingRevision = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/delete",
                headers,
                payload: { poolId },
            });
            expect(missingRevision.statusCode).toBe(400);

            expect(await db.machinePool.count()).toBe(0);
            expect(await countOwnerChanges()).toBe(0);
        });
    });

    it("rejects unauthenticated callers on every Pool operation without touching persistence", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { poolId, name: plainPrivateLabel("Owned"), members: [{ machineId, priorityTier: 0, enabled: true }] },
            });

            for (const [url, payload] of [
                ["/v1/machines/pools/list", {}],
                ["/v1/machines/pools/get", { poolId }],
                ["/v1/machines/pools/create", { poolId, name: plainPrivateLabel("Anonymous"), members: [] }],
                ["/v1/machines/pools/update", { poolId, expectedRevision: 0, name: plainPrivateLabel("Anonymous"), members: [] }],
                ["/v1/machines/pools/delete", { poolId, expectedRevision: 0 }],
                ["/v1/machines/pools/resolve", { poolId, requestKey: "anonymous" }],
            ] as const) {
                const response = await app.inject({ method: "POST", url, payload });
                expect(response.statusCode, url).toBe(401);
            }

            expect(await db.machinePool.findUniqueOrThrow({ where: { id: poolId }, include: { members: true } }))
                .toMatchObject({ name: storedPlainPrivateLabel("Owned"), revision: 0, members: [expect.objectContaining({ machineId })] });
            expect(await countOwnerChanges()).toBe(1);
        });
    });

    it("fails closed for an authenticated owner while the Machine Pool feature is disabled", async () => {
        await seedAccounts();

        await withPoolRoutes(async (app) => {
            await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: { poolId, name: plainPrivateLabel("Existing"), members: [{ machineId, priorityTier: 0, enabled: true }] },
            });

            process.env.HAPPIER_FEATURE_MACHINES_POOLS__ENABLED = "0";

            const listed = await app.inject({ method: "POST", url: "/v1/machines/pools/list", headers, payload: {} });
            expect(listed.statusCode).toBe(404);
            expect(listed.json()).toEqual({ error: "not_found" });

            const created = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/create",
                headers,
                payload: {
                    poolId: "6e8b8e8f-6b1a-4c53-9f0b-6bd47a58f4d2",
                    name: plainPrivateLabel("Blocked"),
                    members: [],
                },
            });
            expect(created.statusCode).toBe(404);

            const destroyed = await app.inject({
                method: "POST",
                url: "/v1/machines/pools/delete",
                headers,
                payload: { poolId, expectedRevision: 0 },
            });
            expect(destroyed.statusCode).toBe(404);

            expect(await db.machinePool.count({ where: { accountId } })).toBe(1);
            expect(await db.machinePool.findUniqueOrThrow({ where: { id: poolId } })).toMatchObject({ name: storedPlainPrivateLabel("Existing") });
            expect(await countOwnerChanges()).toBe(1);
        });
    });
});
