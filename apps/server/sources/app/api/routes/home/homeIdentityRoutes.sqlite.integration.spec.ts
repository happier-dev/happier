import type { WorkOS } from "@workos-inc/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerHomeIdentityRoutes } from "./homeIdentityRoutes";

describe("Home company-sign-in transport", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    const generateLink = vi.fn(async () => ({ link: "https://setup.workos.test/portal" }));
    const createOrganization = vi.fn(async () => ({ id: "org_home", domains: [] }));

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-home-identity-routes-",
            initAuth: false,
            initEncrypt: true,
        });
        harness.resetEnv({
            HAPPIER_WEBAPP_URL: "https://app.example.test",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_FEATURE_TEAMS__ENABLED: "0",
            WORKOS_API_KEY: "sk_test_exact",
            WORKOS_CLIENT_ID: "client_exact",
        });
        app = createAuthenticatedTestApp();
        registerHomeIdentityRoutes(app, {
            resolvePlatform: () => ({
                available: true,
                clientId: "client_exact",
                runtimeFingerprint: "workos-platform:v1:exact",
                // WorkOS is an external SDK boundary; all domain services and storage remain real.
                client: {
                    organizations: {
                        getOrganizationByExternalId: vi.fn(async () => { throw { status: 404 }; }),
                        createOrganization,
                    },
                    adminPortal: { generateLink },
                    sso: { listConnections: vi.fn(), getConnection: vi.fn(), deleteConnection: vi.fn() },
                } as unknown as WorkOS,
            }),
            resolveServerIdentityId: async () => "server_home",
        });
        await app.ready();
    }, 120_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    it("creates and lists a Home-owned binding without a Team and permits only owner writes", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const admin = await db.account.create({ data: { homeRole: "admin" } });
        const member = await db.account.create({ data: {} });
        const request = (actorAccountId: string, path: string, payload: unknown) => app.inject({
            method: "POST", url: `/v1/home/identity/${path}`,
            headers: { "x-test-user-id": actorAccountId }, payload,
        });
        const create = await request(owner.id, "workos/connection/create", { v: 1, displayName: "Company SSO" });
        expect(create.statusCode).toBe(200);
        const connection = create.json().connection;
        expect(connection).toMatchObject({ teamId: null, provider: { kind: "workos_sso", displayName: "Company SSO" } });
        expect(connection.allowedActions.every((id: string) => id.startsWith("home.identity."))).toBe(true);
        await expect(db.team.count()).resolves.toBe(0);
        await expect(db.identityProviderInstance.findUnique({ where: { id: connection.provider.id } }))
            .resolves.toMatchObject({ ownerTeamId: null });

        const list = await request(admin.id, "connections/list", { v: 1 });
        expect(list.statusCode).toBe(200);
        expect(list.json()).toMatchObject({
            items: [expect.objectContaining({ id: connection.id, teamId: null, allowedActions: [] })],
        });
        expect(list.json()).not.toHaveProperty('admissionModeApplicability');
        expect(list.json()).not.toHaveProperty('memberSignInUrl');
        const denied = await request(admin.id, "workos/connection/create", { v: 1, displayName: "Forbidden" });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual({ error: "home_forbidden" });
        expect((await request(member.id, "connections/list", { v: 1 })).statusCode).toBe(403);
        expect((await request(owner.id, "workos/connection/create", { v: 1, displayName: "Wrong scope", teamId: "team_other" })).statusCode).toBe(400);
        await expect(db.teamIdentityConnection.count({ where: { teamId: null } })).resolves.toBe(1);
    });

    it("returns a no-store Portal bearer and rejects Home directory setup", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const create = await app.inject({
            method: "POST", url: "/v1/home/identity/workos/connection/create",
            headers: { "x-test-user-id": owner.id }, payload: { v: 1, displayName: "Portal company" },
        });
        expect(create.statusCode).toBe(200);
        const connectionId = create.json().connection.id;
        const portal = await app.inject({
            method: "POST", url: "/v1/home/identity/workos/admin-portal-link/create",
            headers: { "x-test-user-id": owner.id }, payload: { v: 1, connectionId, intent: "sso" },
        });
        expect(portal.statusCode).toBe(200);
        expect(portal.headers["cache-control"]).toBe("no-store");
        expect(portal.json()).toEqual({ url: "https://setup.workos.test/portal" });
        const dsync = await app.inject({
            method: "POST", url: "/v1/home/identity/workos/admin-portal-link/create",
            headers: { "x-test-user-id": owner.id }, payload: { v: 1, connectionId, intent: "dsync" },
        });
        expect(dsync.statusCode).toBe(400);
        expect(JSON.stringify(await db.teamIdentityConnection.findUnique({ where: { id: connectionId } })))
            .not.toContain("setup.workos.test");
    });
});
