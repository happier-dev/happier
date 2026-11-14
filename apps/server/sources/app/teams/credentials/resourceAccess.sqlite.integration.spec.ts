import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveTeamCredentialEntitlementInTx } from "./resourceAccess";

describe("Team credential transactional entitlement", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-resource-access-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it("re-reads Group, Account, custodian and Team lifecycle on an existing resource", async () => {
        const custodian = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Credential access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "guest" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Developers") } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Shared connection",
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "pc_source", connectionSecurityFingerprint: "connection-security:v1:source", credentialSlotId: "apiKey" }),
            groupGrants: { create: { teamGroupId: group.id, deliveryMode: "brokered" } },
        } });
        const resolve = () => inTx(tx => resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: recipient.id }));
        await expect(resolve()).resolves.toMatchObject({ ok: true, mayBroker: true, mayReceiveDirect: false });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        await db.account.update({ where: { id: recipient.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.account.update({ where: { id: recipient.id }, data: { status: "active" } });
        await db.account.update({ where: { id: custodian.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "source_owner_required" });
        await db.account.update({ where: { id: custodian.id }, data: { status: "active" } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
    });

    it("excludes guests from Team-wide access and never transfers an exact grant to a new membership lifetime", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const guest = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Guest credential access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const firstMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Guest-scoped connection",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            allMembersDeliveryMode: "brokered",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "pc_guest",
                connectionSecurityFingerprint: "connection-security:v1:guest",
                credentialSlotId: "apiKey",
            }),
        } });
        const resolve = () => inTx(tx => resolveTeamCredentialEntitlementInTx(tx, {
            resourceId: resource.id,
            accountId: guest.id,
        }));

        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
        await db.teamCredentialMemberGrant.create({ data: {
            resourceId: resource.id,
            teamMembershipId: firstMembership.id,
            deliveryMode: "brokered",
        } });
        await expect(resolve()).resolves.toMatchObject({
            ok: true,
            matchedGrants: [{ kind: "team_member", teamMembershipId: firstMembership.id }],
        });

        await db.teamMembership.delete({ where: { id: firstMembership.id } });
        const rejoinedMembership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: guest.id,
            role: "guest",
        } });
        expect(rejoinedMembership.id).not.toBe(firstMembership.id);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: resource.id } })).toBe(0);
        await expect(resolve()).resolves.toEqual({ ok: false, reason: "access_removed" });
    });
});
