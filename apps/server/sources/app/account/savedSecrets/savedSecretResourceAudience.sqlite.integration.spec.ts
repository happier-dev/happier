import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { SavedSecretResourceOwedEnvelopeCensusResponseV1Schema } from "@happier-dev/protocol/account/settings/savedSecretCatalogV1";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SavedSecretResourceMaterialsResponseV1Schema } from "@happier-dev/protocol";
import { registerSavedSecretResourceRoutes } from "@/app/api/routes/account/registerSavedSecretResourceRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createSavedSecretResourceInTx,
    listSavedSecretResourceEnvelopeCensusInTx,
    listSavedSecretResourceMaterialsForAccountInTx,
    setSavedSecretResourceGrantsInTx,
} from "./savedSecretResourceService";

describe("Saved Secret resource audience lifecycle (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-saved-secret-audience-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(),
            () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(),
            () => db.savedSecretResource.deleteMany(),
            () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.userRelationship.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createPlainResource(ownerAccountId: string, accountGrants: readonly string[] = []) {
        return inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: ownerAccountId,
            resourceId: "resource_audience_lifecycle",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "value" },
            },
            accountGrants,
        }));
    }

    it("atomically replaces direct grants and removes future material access from a removed recipient", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const removed = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const added = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: owner.id, toUserId: removed.id, status: "friend" },
                { fromUserId: owner.id, toUserId: added.id, status: "friend" },
            ],
        });
        expect(await createPlainResource(owner.id, [removed.id])).toMatchObject({ ok: true });

        const replaced = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_audience_lifecycle",
            expectedRevision: 1,
            accountGrants: [added.id],
            teamGrants: [],
            groupGrants: [],
        }));

        expect(replaced).toEqual({ ok: true, value: { resourceId: "resource_audience_lifecycle", revision: 2 } });
        await expect(db.savedSecretAccountGrant.findMany({
            where: { resourceId: "resource_audience_lifecycle" },
            select: { accountId: true },
        })).resolves.toEqual([{ accountId: added.id }]);
        await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, removed.id))).resolves.toEqual([]);
        await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, added.id)))
            .resolves.toHaveLength(1);
        await expect(db.accountChange.findMany({
            where: { entityId: "resource_audience_lifecycle", kind: "savedSecretResource" },
            select: { accountId: true },
        })).resolves.toEqual(expect.arrayContaining([
            { accountId: owner.id },
            { accountId: removed.id },
            { accountId: added.id },
        ]));
    });

    it("validates the full replacement before CAS and leaves the old audience intact on rejection", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const retained = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const unrelated = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: retained.id, status: "friend" },
        });
        expect(await createPlainResource(owner.id, [retained.id])).toMatchObject({ ok: true });

        const rejected = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_audience_lifecycle",
            expectedRevision: 1,
            accountGrants: [unrelated.id],
            teamGrants: [],
            groupGrants: [],
        }));

        expect(rejected).toEqual({ ok: false, error: "forbidden" });
        await expect(db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_audience_lifecycle" },
            select: { revision: true },
        })).resolves.toEqual({ revision: 1 });
        await expect(db.savedSecretAccountGrant.findMany({
            where: { resourceId: "resource_audience_lifecycle" },
            select: { accountId: true },
        })).resolves.toEqual([{ accountId: retained.id }]);
    });

    it("keeps audience widening with the source owner, not a Team administrator", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const manager = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({ data: { name: "Managed team" }, select: { id: true } });
        await db.teamMembership.createMany({
            data: [
                { teamId: team.id, accountId: owner.id, role: "member" },
                { teamId: team.id, accountId: manager.id, role: "admin" },
            ],
        });
        expect(await createPlainResource(owner.id)).toMatchObject({ ok: true });

        const result = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: manager.id,
            resourceId: "resource_audience_lifecycle",
            expectedRevision: 1,
            accountGrants: [],
            teamGrants: [team.id],
            groupGrants: [],
        }));

        // The administrator has no access to the owner's private resource, so it learns nothing about it.
        expect(result).toEqual({ ok: false, error: "resource_not_found" });
        await expect(db.savedSecretTeamGrant.count()).resolves.toBe(0);
    });

    // Coordination 2026-11-07 17:04Z: an explicit Group grant admits guests; a Team grant does not.
    it("admits Guests through explicit Group grants but not Team grants, and admits members through both", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_TEAMS__ENABLED: "1" });
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const guest = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({ data: { name: "Guest audience" }, select: { id: true } });
        const ownerMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
            select: { id: true },
        });
        const guestMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: guest.id, role: "guest" },
            select: { id: true },
        });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const memberMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Explicit guests") },
            select: { id: true },
        });
        await db.teamGroupMembership.createMany({
            data: [
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: ownerMembership.id },
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: guestMembership.id },
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: memberMembership.id },
            ],
        });

        const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_guest_scope",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "value" },
            },
            teamGrants: [],
            groupGrants: [group.id],
        }));
        expect(created).toMatchObject({ ok: true });
        const app = createAuthenticatedTestApp({ authentication: "real" });
        registerSavedSecretResourceRoutes(app);
        const guestToken = await createAccountTokenForTests(guest.id, { kind: "account", authority: "present_user" });
        const readGuestMaterial = async (expectedRevision: number) => app.inject({
            method: "GET",
            url: `/v1/account/saved-secrets/resources/materials?resourceId=resource_guest_scope&expectedRevision=${expectedRevision}`,
            headers: { authorization: `Bearer ${guestToken}` },
        });
        try {
            const groupMaterial = await readGuestMaterial(1);
            expect(groupMaterial.statusCode).toBe(200);
            expect(SavedSecretResourceMaterialsResponseV1Schema.parse(groupMaterial.json()).resources)
                .toMatchObject([{ storedContent: { t: "plain", v: { value: "value" } } }]);
            // Listing also exercises the audience predicate that exact material reads bypass.
            await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, guest.id)))
                .resolves.toMatchObject([{ storedContent: { t: "plain", v: { value: "value" } } }]);
            await expect(inTx(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, member.id, undefined, ["resource_guest_scope"])))
                .resolves.toHaveLength(1);
            await expect(db.accountChange.findMany({
                where: { entityId: "resource_guest_scope", kind: "savedSecretResource", accountId: guest.id },
                select: { accountId: true },
            })).resolves.toEqual([{ accountId: guest.id }]);

            await db.accountChange.deleteMany({ where: { accountId: guest.id } });

            const groupRemoved = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
                accountId: owner.id,
                resourceId: "resource_guest_scope",
                expectedRevision: 1,
                accountGrants: [],
                teamGrants: [team.id],
                groupGrants: [],
            }));
            expect(groupRemoved).toMatchObject({ ok: true });
            const teamMaterial = await readGuestMaterial(2);
            expect(teamMaterial.statusCode).toBe(404);
            expect(teamMaterial.json()).toEqual({ error: "resource_not_found" });
            await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, guest.id)))
                .resolves.toEqual([]);
            await expect(inTx(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, member.id, undefined, ["resource_guest_scope"])))
                .resolves.toMatchObject([{ storedContent: { t: "plain", v: { value: "value" } } }]);
            await expect(db.accountChange.findMany({
                where: { entityId: "resource_guest_scope", kind: "savedSecretResource", accountId: guest.id },
                select: { accountId: true },
            })).resolves.toEqual([{ accountId: guest.id }]);

            await db.userRelationship.create({
                data: { fromUserId: owner.id, toUserId: guest.id, status: "friend" },
            });
            expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, {
                accountId: owner.id,
                resourceId: "resource_guest_scope",
                expectedRevision: 2,
                accountGrants: [guest.id],
                teamGrants: [team.id],
                groupGrants: [],
            }))).toMatchObject({ ok: true });
            const directMaterial = await readGuestMaterial(3);
            expect(directMaterial.statusCode).toBe(200);
            expect(SavedSecretResourceMaterialsResponseV1Schema.parse(directMaterial.json()).resources)
                .toMatchObject([{ storedContent: { t: "plain", v: { value: "value" } } }]);
        } finally {
            await app.close();
        }
    });

    it("includes explicit Group guests in the envelope census but excludes Team-only guests and inactive members", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee" } });
        const guest = await db.account.create({ data: { encryptionMode: "e2ee" } });
        const member = await db.account.create({ data: { encryptionMode: "e2ee" } });
        const team = await db.team.create({ data: { name: "Envelope audience" } });
        const memberships = await Promise.all([
            db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } }),
            db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } }),
        ]);
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Explicit audience") } });
        await db.teamGroupMembership.createMany({ data: memberships.map(membership => ({
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
        })) });
        // The census reads persisted audience metadata, not ciphertext or key material.
        for (const arm of ["team", "group"] as const) {
            await db.savedSecretResource.create({ data: {
                id: `resource_census_${arm}`, ownerAccountId: owner.id, displayName: "Envelope census",
                kind: "token", encryptionMode: "e2ee", storedContent: "{}",
                ...(arm === "team"
                    ? { teamGrants: { create: { teamId: team.id, createdByAccountId: owner.id } } }
                    : { groupGrants: { create: { teamGroupId: group.id, createdByAccountId: owner.id } } }),
            } });
        }
        async function recipientIds(arm: "team" | "group") {
            const census = await inTx(tx => listSavedSecretResourceEnvelopeCensusInTx(tx, {
                accountId: owner.id, resourceId: `resource_census_${arm}`, limit: 20,
            }));
            expect(census.ok).toBe(true);
            return census.ok ? census.value.recipients.map(recipient => recipient.account.accountId).sort() : [];
        }
        await expect(recipientIds("team")).resolves.toEqual([owner.id, member.id].sort());
        await expect(recipientIds("group")).resolves.toEqual([owner.id, guest.id, member.id].sort());
        await db.teamMembership.update({ where: { id: memberships[0].id }, data: { status: "suspended" } });
        await expect(recipientIds("group")).resolves.toEqual([owner.id, member.id].sort());
        await db.teamMembership.update({ where: { id: memberships[0].id }, data: { status: "active" } });
        await db.account.update({ where: { id: guest.id }, data: { status: "suspended" } });
        await expect(recipientIds("group")).resolves.toEqual([owner.id, member.id].sort());
    });
    // The Saved Secrets repair sweep asks once for everything this custodian owes, not once per resource.
    it("answers every owned E2EE resource's owed envelopes in one read, omitting resources that owe nothing", async () => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(keys.publicKey) } });
        const ready = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const unready = await db.account.create({ data: { encryptionMode: "e2ee" } });
        const other = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const envelopeFor = (account: typeof owner) => {
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            if (readiness.status !== "available") throw new Error("Fixture recipient is unavailable");
            return { recipientAccountId: account.id, recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
                encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: account.contentPublicKey!, randomBytes: tweetnacl.randomBytes })) };
        };
        const resource = (id: string, ownerAccountId: string, encryptionMode: "e2ee" | "plain", grants: readonly string[], envelopes: readonly ReturnType<typeof envelopeFor>[]) =>
            db.savedSecretResource.create({ data: { id, ownerAccountId, displayName: id, kind: "token", encryptionMode, storedContent: "{}",
                accountGrants: { create: grants.map(accountId => ({ accountId, createdByAccountId: ownerAccountId })) },
                keyEnvelopes: { create: envelopes.map(envelope => envelope) } } });
        await resource("owes_ready", owner.id, "e2ee", [ready.id, unready.id], [envelopeFor(owner)]);
        await resource("all_prepared", owner.id, "e2ee", [ready.id], [envelopeFor(owner), envelopeFor(ready)]);
        await resource("unshared", owner.id, "e2ee", [], [envelopeFor(owner)]);
        await resource("plain_shared", owner.id, "plain", [ready.id], []);
        await resource("someone_elses", other.id, "e2ee", [ready.id], [envelopeFor(other)]);
        const app = createAuthenticatedTestApp({ authentication: "real" });
        registerSavedSecretResourceRoutes(app);
        try {
            const response = await app.inject({ method: "GET", url: "/v1/account/saved-secrets/resources/envelope-census/owed",
                headers: { authorization: `Bearer ${await createAccountTokenForTests(owner.id, { kind: "account", authority: "present_user" })}` } });
            expect(response.statusCode).toBe(200);
            const census = SavedSecretResourceOwedEnvelopeCensusResponseV1Schema.parse(response.json());
            expect(census.resources.map(row => ({ resourceId: row.resourceId, recipients: row.recipients.map(recipient => recipient.account.accountId) })))
                .toEqual([{ resourceId: "owes_ready", recipients: [ready.id] }]);
            expect(census.resources[0]).toMatchObject({ revision: 1, recipients: [{ readiness: { status: "available" }, envelopeStatus: "missing" }] });
        } finally {
            await app.close();
        }
    });
});
