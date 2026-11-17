import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getTeamMemberForActorInTx, listTeamMembersForActorInTx } from "./memberAdministration";
import { listTeamsForActorInTx } from "../queries";
import { readTeamSummaryForActorInTx } from "../lifecycle";
import { listTeamInvitationsForActorInTx } from "../invitations/invitationService";
import { listTeamGroupsForActorInTx } from "../groups/groupService";
import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Team member admitted-context read cost (PostgreSQL)", () => {
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

    it("reads a roster and member detail without reacquiring the admitted active-owner count", async () => {
        const accounts = await Promise.all([0, 1, 2].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const [owner, reader, stranger] = accounts;
        const team = await client.team.create({ data: { name: `Roster cost ${randomUUID()}` } });
        const workers = Array.from({ length: 120 }, () => ({ id: randomUUID(), publicKey: randomUUID(), encryptionMode: "plain" }));
        try {
            const ownerMembership = await client.teamMembership.create({ data: { teamId: team.id, accountId: owner!.id, role: "owner" } });
            const readerMembership = await client.teamMembership.create({ data: { teamId: team.id, accountId: reader!.id, role: "member" } });
            const groups = Array.from({ length: 120 }, (_, index) => ({ id: randomUUID(), teamId: team.id, name: storedPlainPrivateLabel(`Group ${index}`) }));
            const invitations = Array.from({ length: 120 }, () => ({ teamId: team.id, tokenHash: randomBytes(32), role: "member" as const,
                historyAccess: "from_membership" as const, createdByAccountId: owner!.id, expiresAt: new Date("2099-01-01T00:00:00.000Z") }));
            await client.teamGroup.createMany({ data: groups.slice(0, 1) });
            await client.teamInvitation.createMany({ data: invitations.slice(0, 1) });
            const routeOwnerCosts = async () => {
                const costs: Record<string, number> = {};
                for (const route of ["teams.list", "teams.get", "teams.invitations.list", "teams.groups.list"] as const) {
                    selects = 0;
                    const result = await client.$transaction(async tx => {
                        switch (route) {
                            case "teams.list": return listTeamsForActorInTx(tx, { v: 1, actorAccountId: owner!.id, scope: "member", archived: "active" });
                            case "teams.get": return readTeamSummaryForActorInTx(tx, { teamId: team.id, actorAccountId: owner!.id });
                            case "teams.invitations.list": return listTeamInvitationsForActorInTx(tx, { teamId: team.id, actorAccountId: owner!.id, cursor: null, limit: 50 });
                            case "teams.groups.list": return listTeamGroupsForActorInTx(tx, { teamId: team.id, actorAccountId: owner!.id, archived: "active", limit: 50 });
                        }
                    }, { isolationLevel: "RepeatableRead" });
                    expect(result.ok).toBe(true);
                    costs[route] = selects;
                }
                return costs;
            };
            const smallOwnerCosts = await routeOwnerCosts();
            const page = async (actorAccountId = owner!.id) => {
                selects = 0;
                const result = await client.$transaction(tx => listTeamMembersForActorInTx(tx, { teamId: team.id, actorAccountId, filter: "all" }), { isolationLevel: "RepeatableRead" });
                return { result, selects };
            };
            const small = await page();
            expect(small.result).toMatchObject({ ok: true, value: { items: expect.arrayContaining([
                expect.objectContaining({ id: ownerMembership.id, capabilities: expect.objectContaining({ suspend: false, remove: false }) }),
            ]) } });
            await client.account.createMany({ data: workers });
            await client.teamMembership.createMany({ data: workers.map(worker => ({ teamId: team.id, accountId: worker.id, role: "member" as const })) });
            await client.teamGroup.createMany({ data: groups.slice(1) });
            await client.teamInvitation.createMany({ data: invitations.slice(1) });
            const largeOwnerCosts = await routeOwnerCosts();
            console.info("TEAM_PAGE_OWNER_PHYSICAL_SELECTS", { fixture: { members: [2, 122], invitations: [1, 120], groups: [1, 120] }, small: smallOwnerCosts, large: largeOwnerCosts });
            const large = await page();
            selects = 0;
            const detail = await client.$transaction(tx => getTeamMemberForActorInTx(tx, { teamId: team.id, actorAccountId: owner!.id, membershipId: readerMembership.id }), { isolationLevel: "RepeatableRead" });
            const detailSelects = selects;
            expect(detail).toMatchObject({ ok: true, value: { id: readerMembership.id, capabilities: { suspend: true } } });
            console.info("TEAM_MEMBERS_ADMITTED_CONTEXT_COST", { members: [2, 122], pageSelects: [small.selects, large.selects], detailSelects });
            expect([small.selects, large.selects, detailSelects]).toEqual([6, 6, 6]);

            // A non-admin reader retains visibility but never gains management.
            expect((await page(reader!.id)).result).toMatchObject({ ok: true, value: { items: expect.arrayContaining([
                expect.objectContaining({ id: ownerMembership.id, capabilities: expect.objectContaining({ suspend: false, remove: false }) }),
            ]) } });
            expect((await page(stranger!.id)).result).toEqual({ ok: false, error: "team_not_found" });
            await client.teamMembership.update({ where: { id: readerMembership.id }, data: { status: "suspended" } });
            expect((await page(reader!.id)).result).toEqual({ ok: false, error: "team_not_found" });
            await client.teamMembership.delete({ where: { id: readerMembership.id } });
            expect((await page(reader!.id)).result).toEqual({ ok: false, error: "team_not_found" });
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [...accounts.map(account => account.id), ...workers.map(worker => worker.id)] } } });
        }
    });
});
