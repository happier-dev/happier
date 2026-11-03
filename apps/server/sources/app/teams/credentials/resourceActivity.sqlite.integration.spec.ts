import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { initEncrypt } from "@/modules/encrypt";
import { readTeamCredentialActivityInTx } from "./resourceActivity";
import * as resourceActivity from "./resourceActivity";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";

const TEST_AUTHENTICATION = { authenticationAuthority: "present_user", authenticationEvidence: [] } as const;

describe("Team credential activity reads", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "team-resource-activity-" });
        harness.resetEnv({ HANDY_MASTER_SECRET: "happier-disposable-disclosure-contract-master" });
        await initEncrypt();
    }, 120_000);
    afterAll(async () => { harness?.resetEnv(); await harness?.close(); });

    it("uses the live resource Team even before the first activity event exists", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Live activity team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "admin" } });
        await db.teamCredentialResource.create({ data: {
            id: "live-resource-without-history",
            teamId: team.id,
            custodianAccountId: actor.id,
            displayName: "Live resource",
            disclosureCeiling: "broker_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                providerId: "example",
                connectionId: "current",
                connectionRevision: "1",
            }),
        } });

        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId: "live-resource-without-history",
            actorAccountId: actor.id,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true, page: { items: [], nextCursor: null } });
    });

    it("authorizes managers after resource deletion and paginates newest first", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain", name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" } });
        const team = await db.team.create({ data: { name: "Activity team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "admin" } });
        const resourceId = "deleted-resource";
        await db.teamCredentialActivityEvent.createMany({ data: [
            { teamId: team.id, resourceId, kind: "resource_created", actorAccountId: actor.id, subjectDisplayName: "Shared" },
            { teamId: team.id, resourceId, kind: "resource_deleted", actorAccountId: actor.id, subjectDisplayName: "Shared" },
        ] });
        const first = await inTx(tx => readTeamCredentialActivityInTx(tx, { resourceId, actorAccountId: actor.id, limit: 1, authentication: TEST_AUTHENTICATION }));
        expect(first).toMatchObject({ ok: true, page: { items: [{ kind: "resource_deleted", actorDisplayName: "Ada Lovelace" }] } });
        if (!first.ok) throw new Error("expected first page");
        expect(first.page.nextCursor).toEqual(expect.any(String));
        const second = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId, actorAccountId: actor.id, limit: 1, cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }));
        expect(second).toMatchObject({ ok: true, page: { items: [{ kind: "resource_created" }], nextCursor: null } });

        const wrongResource = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId: "other-resource", actorAccountId: actor.id, limit: 1,
            cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }));
        expect(wrongResource).toEqual({ ok: false, error: "resource_not_found" });

        const legacyLooseCursor = Buffer.from(JSON.stringify({
            v: 1,
            resourceId,
            createdAt: new Date().toISOString(),
            id: "event-id",
            extra: true,
        }), "utf8").toString("base64url");
        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId, actorAccountId: actor.id, cursor: legacyLooseCursor, authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: "invalid_resource_input" });
    });

    it("does not expose history to a non-manager", async () => {
        const admin = await db.account.create({ data: { encryptionMode: "plain" } });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Private activity team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: admin.id, role: "admin" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        await db.teamCredentialActivityEvent.create({ data: {
            teamId: team.id, resourceId: "private-resource", kind: "resource_created",
            actorAccountId: admin.id, subjectDisplayName: "Private",
        } });
        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, { resourceId: "private-resource", actorAccountId: member.id, authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: false, error: "resource_forbidden" });
    });

    it("distinguishes the current unnamed disclosure actor from other and erased actors", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const namedActor = await db.account.create({ data: { encryptionMode: "plain", name: "History reviewer" } });
        const unnamedActor = await db.account.create({ data: { encryptionMode: "plain" } });
        const erasedActor = await db.account.create({ data: { encryptionMode: "plain", name: "Former reviewer" } });
        const resourceId = "saved-secret-disclosure-attribution";
        const created = await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId, displayName: "Login", kind: "password", encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Login", kind: "password", value: "attribution-private-value" } },
        }));
        if (!created.ok) throw new Error("Expected the disclosure fixture resource");
        const ownDisclosure = await inTx(tx => resourceActivity.recordSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, expectedRevision: created.value.revision,
            deviceId: "history-device", outcome: "displayed", authentication: TEST_AUTHENTICATION,
        }));
        if (!ownDisclosure.ok) throw new Error("Expected the current person's disclosure");
        // Retained activity can outlive its actor. Use the real storage boundary to
        // verify that the reader never infers self from an absent display profile.
        for (const [id, actorAccountId] of [
            ["disclosure-named-actor", namedActor.id],
            ["disclosure-unnamed-actor", unnamedActor.id],
            ["disclosure-erased-actor", erasedActor.id],
        ] as const) {
            await db.teamCredentialActivityEvent.create({ data: {
                id, subjectKind: "saved_secret", ownerAccountId: owner.id, resourceId,
                resourceRevision: created.value.revision, actorAccountId, deviceId: "other-device",
                kind: "secret_reveal", outcome: "displayed", subjectDisplayName: "Login",
            } });
        }
        await db.account.delete({ where: { id: erasedActor.id } });
        const history = await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, authentication: TEST_AUTHENTICATION,
        }));
        expect(history).toMatchObject({ ok: true, page: { items: expect.arrayContaining([
            expect.objectContaining({ id: ownDisclosure.historyEntryId, actorDisplayName: null, actorIsSelf: true }),
            expect.objectContaining({ id: "disclosure-named-actor", actorDisplayName: "History reviewer", actorIsSelf: false }),
            expect.objectContaining({ id: "disclosure-unnamed-actor", actorDisplayName: null, actorIsSelf: false }),
            expect.objectContaining({ id: "disclosure-erased-actor", actorDisplayName: null, actorIsSelf: false }),
        ]) } });
        expect(JSON.stringify(history)).not.toContain("attribution-private-value");
        expect(JSON.stringify(history)).not.toContain(owner.id);
    });

    it("records exact Saved Secret disclosure and same-entry Copy without changing resource currentness", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" } });
        const resourceId = "saved-secret-disclosure-history";
        const created = await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId, displayName: "Login", kind: "password", encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Login", kind: "password", value: "history-must-not-contain-value" } },
            accountGrants: [recipient.id],
        }));
        expect(created.ok).toBe(true);
        const baseline = await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId } });
        const publications = await db.accountChange.count({ where: { kind: "savedSecretResource", entityId: resourceId } });
        const entries: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const event = await inTx(tx => resourceActivity.recordSavedSecretDisclosureActivityInTx(tx, {
                actorAccountId: owner.id, resourceId, expectedRevision: baseline.revision,
                deviceId: "host-device", outcome: "displayed", authentication: TEST_AUTHENTICATION,
            }));
            expect(event).toMatchObject({ ok: true });
            if (!event.ok) throw new Error("expected disclosure history");
            entries.push(event.historyEntryId);
        }
        const beforeCopy = await db.teamCredentialActivityEvent.findMany({ where: { resourceId }, orderBy: { id: "asc" } });
        expect(await inTx(tx => resourceActivity.recordSavedSecretCopyActivityInTx(tx, {
            historyEntryId: entries[0]!, actorAccountId: owner.id, resourceId, expectedRevision: baseline.revision,
            deviceId: "host-device", outcome: "succeeded", authentication: TEST_AUTHENTICATION,
        }))).toMatchObject({ ok: true });
        const afterCopy = await db.teamCredentialActivityEvent.findMany({ where: { resourceId }, orderBy: { id: "asc" } });
        expect(afterCopy).toHaveLength(3);
        expect(afterCopy.filter(row => row.id !== entries[0])).toEqual(beforeCopy.filter(row => row.id !== entries[0]));
        const historyPublications = await db.accountChange.count({ where: { kind: "account", entityId: { startsWith: "saved-secret-activity:" } } });
        expect(await inTx(tx => resourceActivity.recordSavedSecretCopyActivityInTx(tx, {
            historyEntryId: entries[0]!, actorAccountId: owner.id, resourceId, expectedRevision: baseline.revision,
            deviceId: "host-device", outcome: "succeeded", authentication: TEST_AUTHENTICATION,
        }))).toMatchObject({ ok: true });
        expect(await db.teamCredentialActivityEvent.findMany({ where: { resourceId }, orderBy: { id: "asc" } })).toEqual(afterCopy);
        expect(await db.accountChange.count({ where: { kind: "account", entityId: { startsWith: "saved-secret-activity:" } } })).toBe(historyPublications);
        expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId } })).toEqual(baseline);
        expect(await db.accountChange.count({ where: { kind: "savedSecretResource", entityId: resourceId } })).toBe(publications);
        const history = await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, authentication: TEST_AUTHENTICATION,
        }));
        expect(history).toMatchObject({ ok: true, page: { items: expect.arrayContaining([
            expect.objectContaining({ id: entries[0], deviceId: "host-device", resourceRevision: baseline.revision, copyOutcome: "succeeded" }),
        ]) } });
        expect(JSON.stringify(history)).not.toContain("history-must-not-contain-value");
        expect(await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: recipient.id, resourceId, authentication: TEST_AUTHENTICATION,
        }))).toEqual({ ok: false, error: "resource_forbidden" });
        expect(await inTx(tx => resourceActivity.recordSavedSecretCopyActivityInTx(tx, {
            historyEntryId: entries[0]!, actorAccountId: owner.id, resourceId, expectedRevision: baseline.revision + 1,
            deviceId: "host-device", outcome: "requested", authentication: TEST_AUTHENTICATION,
        }))).toEqual({ ok: false, error: "resource_changed" });
        const team = await db.team.create({ data: { name: "Same-id Team subject" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin" } });
        await db.teamCredentialActivityEvent.create({ data: { teamId: team.id, resourceId,
            kind: "resource_created", actorAccountId: owner.id, subjectDisplayName: "Team credential" } });
        const first = await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, limit: 1, authentication: TEST_AUTHENTICATION,
        }));
        if (!first.ok || !first.page.nextCursor) throw new Error("Expected paged Saved Secret history");
        const second = await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, limit: 1, cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }));
        expect(second).toMatchObject({ ok: true, page: { items: [{ resourceRevision: baseline.revision }] } });
        if (!second.ok) throw new Error("Expected second history page");
        expect(second.page.items[0]?.id).not.toBe(first.page.items[0]?.id);
        expect(await inTx(tx => readTeamCredentialActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, authentication: TEST_AUTHENTICATION,
        }))).toMatchObject({ ok: true, page: { items: [{ kind: "resource_created", subjectDisplayName: "Team credential" }] } });
        await db.savedSecretResource.delete({ where: { id: resourceId } });
        expect(await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, authentication: TEST_AUTHENTICATION,
        }))).toMatchObject({ ok: true, page: { items: expect.arrayContaining([expect.objectContaining({ id: entries[0] })]) } });
        const replacement = await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: recipient.id, resourceId, displayName: "Different owner", kind: "password", encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Different owner", kind: "password", value: "other-owner-value" } },
        }));
        if (!replacement.ok) throw new Error("Expected same-id resource in another owning scope");
        const otherDisclosure = await inTx(tx => resourceActivity.recordSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: recipient.id, resourceId, expectedRevision: replacement.value.revision,
            deviceId: "other-device", outcome: "displayed", authentication: TEST_AUTHENTICATION,
        }));
        if (!otherDisclosure.ok) throw new Error("Expected second owning scope's disclosure");
        const retainedHistory = await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: owner.id, resourceId, authentication: TEST_AUTHENTICATION,
        }));
        expect(retainedHistory).toMatchObject({ ok: true, page: { items: expect.arrayContaining([expect.objectContaining({ id: entries[0] })]) } });
        expect(JSON.stringify(retainedHistory)).not.toContain(otherDisclosure.historyEntryId);
        expect(await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: recipient.id, resourceId, authentication: TEST_AUTHENTICATION,
        }))).toMatchObject({ ok: true, page: { items: [{ id: otherDisclosure.historyEntryId }] } });
        expect(await inTx(tx => resourceActivity.readSavedSecretDisclosureActivityInTx(tx, {
            actorAccountId: recipient.id, resourceId, cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }))).toEqual({ ok: false, error: "invalid_resource_input" });
        await db.account.delete({ where: { id: owner.id } });
        expect(await db.teamCredentialActivityEvent.count({ where: { subjectKind: "saved_secret", resourceId, ownerAccountId: owner.id } })).toBe(0);
        expect(await db.teamCredentialActivityEvent.count({ where: { subjectKind: "saved_secret", resourceId, ownerAccountId: recipient.id } })).toBe(1);
        expect(await db.teamCredentialActivityEvent.count({ where: { subjectKind: "team_credential", resourceId } })).toBe(1);
    });
});
