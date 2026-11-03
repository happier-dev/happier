import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createSavedSecretResourceInTx,
    listSavedSecretResourceMaterialsForAccountInTx,
    setSavedSecretResourceGrantsInTx,
} from "./savedSecretResourceService";

describe("Saved Secret resource audience lifecycle (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-saved-secret-audience-",
            initAuth: false,
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

    it("excludes Guests from a Team-wide grant while preserving their explicit Group grant", async () => {
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
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Explicit guests", nameKey: "explicit-guests" },
            select: { id: true },
        });
        await db.teamGroupMembership.createMany({
            data: [
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: ownerMembership.id },
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: guestMembership.id },
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
            teamGrants: [team.id],
            groupGrants: [group.id],
        }));
        expect(created).toMatchObject({ ok: true });
        await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, guest.id)))
            .resolves.toHaveLength(1);

        const groupRemoved = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_guest_scope",
            expectedRevision: 1,
            accountGrants: [],
            teamGrants: [team.id],
            groupGrants: [],
        }));
        expect(groupRemoved).toMatchObject({ ok: true });
        await expect(inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, guest.id)))
            .resolves.toEqual([]);
    });
});
