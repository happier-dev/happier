import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveTeamCredentialEntitlementInTx } from "./resourceAccess";
import { resolveTeamGroupMembershipsForAccountInTx } from "../groups/effectiveGroupMembership";
import { retainEntitledTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Team credential audience query cost (PostgreSQL)", () => {
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    let selects = 0;
    client.$on("query", event => { if (/^SELECT\b/i.test(event.query)) selects++; });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    async function recipientFixture(recipientCount: number) {
        const custodian = await client.account.create({ data: { encryptionMode: "plain" } });
        const team = await client.team.create({ data: { name: "Recipient retention costs" } });
        await client.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const members = Array.from({ length: recipientCount }, () => ({ id: randomUUID(), accountId: randomUUID(), teamId: team.id, role: "member" as const }));
        await client.account.createMany({ data: members.map(member => ({ id: member.accountId, encryptionMode: "plain" })) });
        await client.teamMembership.createMany({ data: members });
        const group = await client.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Direct recipients") } });
        await client.teamGroupMembership.createMany({ data: members.map(member => ({ teamId: team.id,
            teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true })) });
        const resource = await client.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Retention cost fixture",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed", sourceBindingJson: "{}",
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: "direct" } },
        } });
        const material = (recipientAccountId: string) => ({ resourceId: resource.id, recipientAccountId,
            sourceMemberKey: "member", sourceVersion: "version", recipientMode: "plain", storedMaterial: new Uint8Array([123, 125]) });
        await client.teamCredentialRecipientMaterial.createMany({ data: members.map(member => material(member.accountId)) });
        const retain = async () => {
            selects = 0;
            await client.$transaction(tx => retainEntitledTeamCredentialRecipientMaterialInTx(tx, { resourceId: resource.id }),
                { isolationLevel: "RepeatableRead" });
            const count = selects;
            const rows = await client.teamCredentialRecipientMaterial.findMany({ where: { resourceId: resource.id },
                select: { recipientAccountId: true } });
            return { selects: count, accountIds: rows.map(row => row.recipientAccountId).sort() };
        };
        return { custodian, team, members, group, resource, material, retain };
    }

    it("retains entitled material with constant SQL at 1 and 123 recipients and sees new recipients", async () => {
        const measurements = [];
        for (const recipientCount of [1, 123]) {
            const f = await recipientFixture(recipientCount);
            const initial = await f.retain();
            expect(initial.accountIds).toEqual(f.members.map(member => member.accountId).sort());
            measurements.push({ recipientCount, selects: initial.selects });
            const account = await client.account.create({ data: { encryptionMode: "plain" } });
            const member = await client.teamMembership.create({ data: { teamId: f.team.id, accountId: account.id, role: "guest" } });
            await client.teamCredentialMemberGrant.create({ data: { resourceId: f.resource.id, teamMembershipId: member.id, deliveryMode: "direct" } });
            await client.teamCredentialRecipientMaterial.create({ data: f.material(account.id) });
            const changed = await f.retain();
            expect(changed.accountIds).toEqual([...initial.accountIds, account.id].sort());
            measurements.push({ recipientCount: recipientCount + 1, selects: changed.selects });
        }
        console.info("WFMEMBATCH_RETENTION_SQL", JSON.stringify(measurements));
        expect(measurements[0]!.selects).toBeGreaterThan(0);
        expect(measurements.map(measurement => measurement.selects)).toEqual(Array(4).fill(measurements[0]!.selects));
    });

    it("withdraws material for revoked groups, removed lifetimes, wrong Teams and changed or suspended Accounts", async () => {
        const f = await recipientFixture(6);
        const [revoked, suspended, removed, changed, stable, memberSuspended] = f.members;
        const foreign = await recipientFixture(1);
        await client.teamCredentialRecipientMaterial.create({ data: f.material(foreign.members[0]!.accountId) });
        await client.teamGroupMembership.delete({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: revoked!.id,
        } } });
        await client.account.update({ where: { id: suspended!.accountId }, data: { status: "suspended" } });
        await client.teamMembership.delete({ where: { id: removed!.id } });
        const replacement = await client.account.create({ data: { encryptionMode: "plain" } });
        await client.teamMembership.update({ where: { id: changed!.id }, data: { accountId: replacement.id } });
        await client.teamCredentialRecipientMaterial.create({ data: f.material(replacement.id) });
        await client.teamMembership.update({ where: { id: memberSuspended!.id }, data: { status: "suspended" } });
        expect((await f.retain()).accountIds).toEqual([stable!.accountId, replacement.id].sort());

        await client.teamCredentialGroupGrant.deleteMany({ where: { resourceId: f.resource.id } });
        expect((await f.retain()).accountIds).toEqual([]);
        await client.teamCredentialGroupGrant.create({ data: { resourceId: f.resource.id, teamGroupId: f.group.id, deliveryMode: "direct" } });
        await client.teamCredentialRecipientMaterial.create({ data: f.material(stable!.accountId) });
        expect((await f.retain()).accountIds).toEqual([stable!.accountId]);
        await client.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: new Date() } });
        expect((await f.retain()).accountIds).toEqual([]);
        await client.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: null } });
        await client.teamCredentialRecipientMaterial.create({ data: f.material(stable!.accountId) });
        await client.teamMembership.update({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.custodian.id } }, data: { status: "suspended" } });
        expect((await f.retain()).accountIds).toEqual([]);
    });

    it("preserves all recipient and Group contexts across the portable SQL bind boundary", async () => {
        const f = await recipientFixture(1_001);
        expect((await f.retain()).accountIds).toEqual(f.members.map(member => member.accountId).sort());
        const member = f.members.at(-1)!;
        await client.teamGroupMembership.delete({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: f.group.id, teamMembershipId: member.id,
        } } });
        expect((await f.retain()).accountIds).toEqual(f.members.slice(0, -1).map(value => value.accountId).sort());
    });

    it("uses a constant SQL budget for 120 Group grants and preserves revocation", async () => {
        const [custodian, recipient] = await Promise.all([0, 1].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await client.team.create({ data: { name: `Credential cost ${randomUUID()}` } });
        try {
            await client.teamMembership.create({ data: { teamId: team.id, accountId: custodian!.id, role: "owner" } });
            const membership = await client.teamMembership.create({ data: { teamId: team.id, accountId: recipient!.id, role: "guest" } });
            const groups = Array.from({ length: 120 }, (_, index) => ({ id: randomUUID(), teamId: team.id, name: storedPlainPrivateLabel(`Group ${index}`) }));
            await client.teamGroup.createMany({ data: groups });
            const resource = await client.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: custodian!.id, displayName: "Cost fixture",
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed", sourceBindingJson: "{}",
                groupGrants: { create: { teamGroupId: groups[0]!.id, deliveryMode: "brokered" } },
            } });
            const read = async () => {
                const input = { resourceId: resource.id, accountId: recipient!.id };
                selects = 0;
                const entitlement = await client.$transaction(tx => resolveTeamCredentialEntitlementInTx(tx, input), { isolationLevel: "RepeatableRead" });
                const entitlementSelects = selects;
                return { entitlement, entitlementSelects };
            };
            const single = await read();
            await client.teamCredentialGroupGrant.createMany({ data: groups.slice(1).map(group => ({ resourceId: resource.id, teamGroupId: group.id, deliveryMode: "brokered" })) });
            const page = await read();
            console.info("TEAM_CREDENTIAL_AUDIENCE_QUERY_COST", { single: single.entitlementSelects, groups120: page.entitlementSelects });
            expect(page.entitlement).toEqual({ ok: false, reason: "access_removed" });
            expect(page.entitlementSelects).toBe(single.entitlementSelects);
            await client.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: groups[119]!.id, teamMembershipId: membership.id, nativeContribution: true } });
            expect(await read()).toMatchObject({ entitlement: { ok: true, mayBroker: true } });
            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect(await read()).toMatchObject({ entitlement: { ok: false, reason: "access_removed" } });
            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            await client.teamGroup.update({ where: { id: groups[119]!.id }, data: { archivedAt: new Date() } });
            expect(await read()).toMatchObject({ entitlement: { ok: false, reason: "access_removed" } });
            await client.teamGroup.update({ where: { id: groups[119]!.id }, data: { archivedAt: null } });
            const unrelatedGroup = await client.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Not granted") } });
            await client.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: unrelatedGroup.id, teamMembershipId: membership.id, nativeContribution: true } });
            selects = 0;
            const selected = await client.$transaction(tx => resolveTeamGroupMembershipsForAccountInTx(tx, {
                teamId: team.id, accountId: recipient!.id, credentialResourceId: resource.id,
            }), { isolationLevel: "RepeatableRead" });
            expect(selected).toHaveLength(1);
            expect(selected[0]).toMatchObject({ teamGroupId: groups[119]!.id, teamMembershipId: membership.id, effective: true });
            console.info("TEAM_CREDENTIAL_MEMBERSHIP_DEMAND", { grants: 120, actorMemberships: 2, returnedMemberships: selected.length, selects });
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [custodian!.id, recipient!.id] } } });
        }
    });
});
