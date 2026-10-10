import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SavedSecretResourceMaterialsResponseV1Schema, SharedSavedSecretListOutputV1Schema } from "@happier-dev/protocol";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { registerSavedSecretResourceRoutes } from "./registerSavedSecretResourceRoutes";

describe("Saved Secret personal availability with Teams disabled (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "saved-secret-disabled-teams-gate-",
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "0" },
            initAuth: false,
            initEncrypt: true,
        });
    }, 180_000);

    afterAll(async () => { await harness?.close(); });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(), () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(), () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(), () => db.savedSecretResource.deleteMany(),
            () => db.teamMembership.deleteMany(), () => db.team.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("allows standalone personal create, list, material read and update for a Solo Account", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const headers = { "x-test-user-id": owner.id };
        const resource = { resourceId: "solo-personal-token", displayName: "Personal token", kind: "token",
            encryptionMode: "plain", storedContent: { t: "plain", v: { v: 1, name: "Personal token", kind: "token", value: "solo-private" } } };
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            // Standalone global CRUD is independent of selecting a credential for a source binding.
            const created = await app.inject({ method: "POST", url: homeDomainActionPathForMethod("secrets.shared.create", "POST"), headers, payload: resource });
            expect({ status: created.statusCode, body: created.json() }).toEqual({ status: 200, body: { resourceId: resource.resourceId, revision: 1 } });
            const listed = await app.inject({ method: "GET", url: homeDomainActionPathForMethod("secrets.shared.list", "GET"), headers });
            expect(listed.statusCode).toBe(200);
            expect(SharedSavedSecretListOutputV1Schema.parse(listed.json()).resources).toHaveLength(1);
            const materials = await app.inject({ method: "GET", url: "/v1/account/saved-secrets/resources/materials", headers });
            expect(materials.statusCode).toBe(200);
            expect(SavedSecretResourceMaterialsResponseV1Schema.parse(materials.json()).resources).toEqual([
                expect.objectContaining({ resourceId: resource.resourceId, storedContent: resource.storedContent }),
            ]);
            const updated = await app.inject({ method: "POST", url: homeDomainActionPathForMethod("secrets.shared.update", "POST"), headers,
                payload: { resourceId: resource.resourceId, expectedRevision: 1, displayName: "Rotated personal token", kind: "token",
                    storedContent: { t: "plain", v: { v: 1, name: "Rotated personal token", kind: "token", value: "rotated-private" } } } });
            expect({ status: updated.statusCode, body: updated.json() }).toEqual({ status: 200, body: { resourceId: resource.resourceId, revision: 2 } });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("withholds Team-derived resources and refuses Team grants while retaining the custodian's personal access", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Credential audience" } });
        await db.teamMembership.createMany({ data: [
            { accountId: owner.id, teamId: team.id, role: "owner" },
            { accountId: member.id, teamId: team.id, role: "member" },
        ] });
        const resource = { accountId: owner.id, resourceId: "team-derived-token", displayName: "Team token", kind: "token" as const,
            encryptionMode: "plain" as const, storedContent: { t: "plain" as const,
                v: { v: 1 as const, name: "Team token", kind: "token" as const, value: "team-private" } }, teamGrants: [team.id] };
        harness.resetEnv({ HAPPIER_FEATURE_TEAMS__ENABLED: "1" });
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, resource))).toMatchObject({ ok: true });
        harness.resetEnv();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { ...resource, resourceId: "disabled-team-grant" })))
            .toEqual({ ok: false, error: "forbidden" });
        expect(await db.savedSecretResource.count()).toBe(1);
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            const materials = async (accountId: string) => {
                const response = await app.inject({ method: "GET", url: "/v1/account/saved-secrets/resources/materials",
                    headers: { "x-test-user-id": accountId } });
                expect(response.statusCode).toBe(200);
                return SavedSecretResourceMaterialsResponseV1Schema.parse(response.json()).resources;
            };
            expect(await materials(member.id)).toEqual([]);
            expect(await materials(owner.id)).toEqual([expect.objectContaining({ resourceId: resource.resourceId })]);
            expect(await db.savedSecretTeamGrant.count()).toBe(1);
        } finally {
            await app.close();
        }
    });
});
