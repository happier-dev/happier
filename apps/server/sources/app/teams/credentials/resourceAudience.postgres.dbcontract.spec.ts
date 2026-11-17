import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateTeamCredentialAudienceDraftInTx } from "./resourceAudience";
import { resolveTeamMembershipContextInTx } from "../memberships/effectiveMembership";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Team credential member audience validation (PostgreSQL)", () => {
    let client: PrismaClientType;
    let selects = 0;
    beforeAll(async () => {
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, event => { if (/^SELECT\b/i.test(event.query.trimStart())) selects++; });
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    async function fixture(recipientCount: number) {
        const team = await client.team.create({ data: { name: "Audience cost fixture" } });
        const accountIds = Array.from({ length: recipientCount }, () => randomUUID());
        await client.account.createMany({ data: accountIds.map(id => ({ id, encryptionMode: "plain" })) });
        const members = accountIds.map(accountId => ({ id: randomUUID(), accountId, teamId: team.id, role: "member" as const }));
        await client.teamMembership.createMany({ data: members });
        return { team, members };
    }

    async function validate(teamId: string, membershipIds: readonly string[], groupIds: readonly string[] = []) {
        selects = 0;
        const result = await client.$transaction(tx => validateTeamCredentialAudienceDraftInTx(tx, {
            teamId, deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] }, brokerPlacement: null,
            audience: { allMembersAllowedRoutes: null,
                memberGrants: membershipIds.map(teamMembershipId => ({ teamMembershipId, allowedRoutes: ['direct'] })),
                groupGrants: groupIds.map(teamGroupId => ({ teamGroupId, allowedRoutes: ['direct'] })),
            },
        }), { isolationLevel: "RepeatableRead" });
        return { result, selects };
    }

    it("keeps SQL constant for 1 and 123 recipients and observes a newly admitted recipient", async () => {
        const measurements = [];
        for (const recipientCount of [1, 123]) {
            const f = await fixture(recipientCount);
            // Grant order is unrelated to the owner's database result order.
            const ids = f.members.map(member => member.id).reverse();
            const initial = await validate(f.team.id, ids);
            expect(initial.result).toEqual({ ok: true });
            measurements.push({ recipientCount, selects: initial.selects });
            const account = await client.account.create({ data: { encryptionMode: "plain" } });
            const next = await client.teamMembership.create({ data: { teamId: f.team.id, accountId: account.id, role: "guest" } });
            const changed = await validate(f.team.id, [...ids, next.id]);
            expect(changed.result).toEqual({ ok: true });
            measurements.push({ recipientCount: recipientCount + 1, selects: changed.selects });
        }
        console.info("WFMEMBATCH_AUDIENCE_SQL", JSON.stringify(measurements));
        expect(measurements[0]!.selects).toBeGreaterThan(0);
        expect(measurements.map(measurement => measurement.selects)).toEqual(Array(4).fill(measurements[0]!.selects));
    });

    it("keeps lifetime, Team, Account and group revocation checks fresh across requests", async () => {
        const f = await fixture(2);
        const [member, other] = f.members;
        const ids = f.members.map(value => value.id);
        const denied = { ok: false, error: "invalid_audience" };
        const read = () => validate(f.team.id, ids);
        expect((await read()).result).toEqual({ ok: true });
        expect((await validate(f.team.id, [])).result).toEqual({ ok: true });
        expect((await validate(f.team.id, [...ids, member!.id])).result).toEqual(denied);
        expect((await validate(f.team.id, [...ids, randomUUID()])).result).toEqual(denied);

        await client.teamMembership.update({ where: { id: member!.id }, data: { status: "suspended" } });
        expect((await read()).result).toEqual(denied);
        await client.teamMembership.update({ where: { id: member!.id }, data: { status: "active" } });
        expect((await read()).result).toEqual({ ok: true });
        await client.account.update({ where: { id: member!.accountId }, data: { status: "suspended" } });
        expect((await read()).result).toEqual(denied);
        await client.account.update({ where: { id: member!.accountId }, data: { status: "active" } });
        expect((await read()).result).toEqual({ ok: true });
        await client.team.update({ where: { id: f.team.id }, data: { archivedAt: new Date() } });
        expect((await read()).result).toEqual(denied);
        await client.team.update({ where: { id: f.team.id }, data: { archivedAt: null } });
        expect((await read()).result).toEqual({ ok: true });

        const foreign = await fixture(1);
        expect((await validate(f.team.id, [...ids, foreign.members[0]!.id])).result).toEqual(denied);
        const group = await client.teamGroup.create({ data: { teamId: f.team.id, name: storedPlainPrivateLabel("Recipients") } });
        expect((await validate(f.team.id, ids, [group.id])).result).toEqual({ ok: true });
        await client.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        expect((await validate(f.team.id, ids, [group.id])).result).toEqual(denied);

        // An exact expected-Account subject must never follow a moved lifetime.
        const replacement = await client.account.create({ data: { encryptionMode: "plain", status: "suspended" } });
        await client.teamMembership.update({ where: { id: member!.id }, data: { accountId: replacement.id } });
        expect(await client.$transaction(tx => resolveTeamMembershipContextInTx(tx, {
            teamId: f.team.id, teamMembershipId: member!.id, expectedAccountId: member!.accountId,
        }))).toEqual({ ok: false, error: "team_membership_account_changed" });
        expect((await read()).result).toEqual(denied);
        await client.account.update({ where: { id: replacement.id }, data: { status: "active" } });
        // Draft grants name a current lifetime, not an expected Account address.
        expect((await read()).result).toEqual({ ok: true });

        await client.teamMembership.delete({ where: { id: other!.id } });
        expect((await read()).result).toEqual(denied);
        const rejoined = await client.teamMembership.create({ data: { teamId: f.team.id, accountId: other!.accountId, role: "member" } });
        expect((await read()).result).toEqual(denied);
        expect((await validate(f.team.id, [member!.id, rejoined.id])).result).toEqual({ ok: true });
    });

    it("validates every requested lifetime across the portable SQL bind boundary", async () => {
        const f = await fixture(1_001);
        const ids = f.members.map(member => member.id).reverse();
        expect((await validate(f.team.id, ids)).result).toEqual({ ok: true });
        await client.teamMembership.update({ where: { id: ids.at(-1)! }, data: { status: "suspended" } });
        expect((await validate(f.team.id, ids)).result).toEqual({ ok: false, error: "invalid_audience" });
    });
});
