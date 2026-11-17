import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertTeamOwnershipAllowsAccountErasureInTx, readTeamOwnershipErasureDecisionsInTx } from "./erasurePrecondition";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Team owner continuity query cost (PostgreSQL)", () => {
    let client: PrismaClientType;
    let selects = 0;
    beforeAll(async () => {
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, event => { if (/^\s*SELECT\b/i.test(event.query)) selects++; });
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("decides a staffed Team in one SELECT and keeps People and the real erasure guard identical", async () => {
        const [target, survivor, guest] = await Promise.all([0, 1, 2].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await client.team.create({ data: { name: `Ownership cost ${randomUUID()}` } });
        try {
            const owner = await client.teamMembership.create({ data: { teamId: team.id, accountId: target!.id, role: "owner" } });
            const secondOwner = await client.teamMembership.create({ data: { teamId: team.id, accountId: survivor!.id, role: "owner", status: "suspended" } });
            await client.teamMembership.create({ data: { teamId: team.id, accountId: guest!.id, role: "guest" } });
            const assertDecision = async (blocked: boolean) => {
                selects = 0;
                const page = await client.$transaction(tx => readTeamOwnershipErasureDecisionsInTx(tx, { accountIds: [target!.id, guest!.id] }), { isolationLevel: "RepeatableRead" });
                const pageSelects = selects;
                const guard = await client.$transaction(tx => assertTeamOwnershipAllowsAccountErasureInTx(tx, { accountId: target!.id }), { isolationLevel: "RepeatableRead" });
                expect(page.get(target!.id)).toEqual(guard);
                expect(page.get(guest!.id)).toEqual({ status: "ok" });
                expect(guard).toEqual(blocked ? { status: "rejected", code: "team_owner_transfer_required", teamIds: [team.id] } : { status: "ok" });
                expect(pageSelects).toBe(1);
                return pageSelects;
            };
            const small = await assertDecision(true);
            const workers = Array.from({ length: 120 }, () => ({ id: randomUUID(), publicKey: randomUUID(), encryptionMode: "plain" }));
            await client.account.createMany({ data: workers });
            try {
                await client.teamMembership.createMany({ data: workers.map(worker => ({ teamId: team.id, accountId: worker.id, role: "member" as const })) });
                expect(await assertDecision(true)).toBe(small);
                await client.teamMembership.update({ where: { id: owner.id }, data: { status: "suspended" } });
                await client.account.update({ where: { id: target!.id }, data: { status: "disabled" } });
                await assertDecision(true); // An already-retired erasure retry must still be refused.
                await client.teamMembership.update({ where: { id: secondOwner.id }, data: { status: "active" } });
                await assertDecision(false);
                await client.account.update({ where: { id: survivor!.id }, data: { status: "suspended" } });
                await assertDecision(true);
                await client.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
                await assertDecision(false);
                await client.team.update({ where: { id: team.id }, data: { archivedAt: null } });
                await client.teamMembership.deleteMany({ where: { teamId: team.id, role: "member" } });
                await assertDecision(true); // The guest alone is still somebody left to strand.
                await client.teamMembership.deleteMany({ where: { teamId: team.id, role: "guest" } });
                await assertDecision(false); // No other structurally active member remains.
                console.info("TEAM_ERASURE_OWNER_QUERY_COST", { memberCounts: [3, 123], selectsPerPage: small });
            } finally {
                await client.account.deleteMany({ where: { id: { in: workers.map(worker => worker.id) } } });
            }
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [target!.id, survivor!.id, guest!.id] } } });
        }
    });

    it("does not transport or bind a 35,000-Team ownership inventory", async () => {
        const prefix = `owner-cost-${randomUUID()}-`;
        const [target, worker] = await Promise.all([0, 1].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        try {
            // Disposable PostgreSQL fixture: seed at its real set boundary, avoiding
            // a test-side parameter list larger than the product query we audit.
            await client.$executeRaw`INSERT INTO "Team" ("id", "name", "updatedAt")
                SELECT ${prefix} || n::text, ${prefix} || n::text, CURRENT_TIMESTAMP FROM generate_series(1, 35000) AS n`;
            await client.$executeRaw`INSERT INTO "TeamMembership" ("id", "teamId", "accountId", "role")
                SELECT ${prefix} || n::text, ${prefix} || n::text, ${target!.id}, 'owner'::"TeamRole" FROM generate_series(1, 35000) AS n`;
            await client.teamMembership.create({ data: { teamId: `${prefix}1`, accountId: worker!.id, role: "member" } });
            selects = 0;
            const decisions = await client.$transaction(tx => readTeamOwnershipErasureDecisionsInTx(tx, { accountIds: [target!.id, worker!.id] }), { isolationLevel: "RepeatableRead" });
            expect(decisions.get(target!.id)).toEqual({ status: "rejected", code: "team_owner_transfer_required", teamIds: [`${prefix}1`] });
            expect(decisions.get(worker!.id)).toEqual({ status: "ok" });
            expect(selects).toBe(1);
            console.info("TEAM_ERASURE_OWNER_BIND_BOUNDARY", { ownedTeams: 35_000, selects, blockedTeams: 1 });
        } finally {
            await client.team.deleteMany({ where: { id: { startsWith: prefix } } });
            await client.account.deleteMany({ where: { id: { in: [target!.id, worker!.id] } } });
        }
    });
});
