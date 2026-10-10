import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { resolveAuthEntry } from "./resolveAuthEntry";

const workosBoundary = vi.hoisted(() => ({ getOrganization: vi.fn() }));
// WorkOS is the network/SDK boundary. Catalog, policy, binding and routing remain real.
vi.mock("@workos-inc/node", () => ({ WorkOS: class {
    organizations = { getOrganization: workosBoundary.getOrganization };
} }));

const managedOidcConfig = {
    v: 1,
    kind: "oidc",
    issuer: "https://id.example.test",
    clientId: "happier",
    clientAuthenticationMethod: "client_secret_post",
    scopes: "openid profile email",
    httpTimeoutSeconds: 30,
    claims: { login: "preferred_username", email: "email", groups: "groups" },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: true,
    storeRefreshToken: false,
    ui: { buttonColor: "#0B5FFF", iconHint: "oidc" },
} as const;

describe("resolveAuthEntry managed Home providers (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-entry-managed-",
            initAuth: false,
            initEncrypt: true,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        workosBoundary.getOrganization.mockReset();
        await db.teamIdentityConnection.deleteMany({});
        await db.identityProviderInstance.deleteMany({});
        await db.homeGovernancePolicy.deleteMany({});
    });

    async function createHomeWorkos(name: string) {
        const provider = await db.identityProviderInstance.create({ data: {
            kind: "workos_sso", displayName: name, enabled: true, firstEnabledAt: new Date(),
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, enabled: true, firstEnabledAt: new Date(),
            externalReference: { v: 1, kind: "workos_sso", organizationId: `org_${provider.id}`, connectionId: `conn_${provider.id}` },
            settings: { v: 1, kind: "workos_sso" },
            lastObservation: { v: 1, kind: "workos_sso", presentation: {
                displayName: name, strategy: "SAML", status: "active", lastCheckedAt: "2026-10-09T00:00:00.000Z",
            }, successfulTest: null },
        } });
        return { provider, connection, organizationId: `org_${provider.id}` };
    }

    const workosEnv = {
        HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", WORKOS_API_KEY: "sk_test", WORKOS_CLIENT_ID: "client_test",
    };
    const routeByEmail = (email: string) => resolveAuthEntry({
        v: 1, scope: { kind: "home" }, email,
    }, { env: workosEnv, principal: { accountId: "existing-account" }, emailDeliveryReady: false });

    it("routes only a unique live verified domain to its exact Home connection and keeps ambiguity explicit", async () => {
        const first = await createHomeWorkos("First company");
        const second = await createHomeWorkos("Second company");
        workosBoundary.getOrganization.mockImplementation(async (id: string) => ({
            id, name: "Company", domains: [{
                organizationId: id, domain: id === first.organizationId ? "acme.example" : "other.example", state: "verified",
            }],
        }));
        const normal = await resolveAuthEntry({ v: 1, scope: { kind: "home" } }, {
            env: workosEnv, principal: { accountId: "existing-account" }, emailDeliveryReady: false,
        });
        expect(normal.state).toBe("ready");
        expect(workosBoundary.getOrganization).not.toHaveBeenCalled();
        const unique = await routeByEmail("Person@ACME.EXAMPLE");
        expect(unique.state).toBe("ready");
        if (unique.state !== "ready") throw new Error("expected domain choice");
        expect([...new Set(unique.actions.map((action) => action.methodId))]).toEqual([first.provider.id]);
        expect(unique.actions[0]?.presentation.displayName).toBe("First company");
        workosBoundary.getOrganization.mockImplementation(async (id: string) => ({
            id, name: "Company", domains: [{ organizationId: id, domain: "acme.example", state: "verified" }],
        }));
        const ambiguous = await routeByEmail("person@acme.example");
        expect(ambiguous.state).toBe("ready");
        if (ambiguous.state !== "ready") throw new Error("expected explicit choices");
        expect(new Set(ambiguous.actions.map((action) => action.methodId))).toEqual(new Set([first.provider.id, second.provider.id]));
        expect(ambiguous.autoRedirect).toBeNull();
    });

    it("fails routing closed for an unverified domain, wrong organization, SDK failure or changed binding", async () => {
        const target = await createHomeWorkos("Company");
        workosBoundary.getOrganization.mockResolvedValue({
            id: target.organizationId, name: "Company", domains: [{
                organizationId: target.organizationId, domain: "acme.example", state: "pending",
            }],
        });
        expect(await routeByEmail("person@acme.example")).toMatchObject({ state: "unavailable", autoRedirect: null });
        workosBoundary.getOrganization.mockResolvedValue({ id: "org_other", name: "Other", domains: [] });
        expect(await routeByEmail("person@acme.example")).toMatchObject({ state: "unavailable", autoRedirect: null });
        workosBoundary.getOrganization.mockRejectedValue(new Error("upstream unavailable"));
        expect(await routeByEmail("person@acme.example")).toMatchObject({ state: "unavailable", autoRedirect: null });
        workosBoundary.getOrganization.mockImplementation(async () => {
            await db.teamIdentityConnection.update({ where: { id: target.connection.id }, data: { revision: { increment: 1 } } });
            return { id: target.organizationId, name: "Company", domains: [{
                organizationId: target.organizationId, domain: "acme.example", state: "verified",
            }] };
        });
        expect(await routeByEmail("person@acme.example")).toMatchObject({ state: "unavailable", autoRedirect: null });
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it("projects an enabled managed OIDC provider through the async catalog and Home policy owner", async () => {
        const managed = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Company login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
                encryptedSecrets: null,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: managed.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", managed.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: "home" } },
            {
                env: {
                    HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                    AUTH_ANONYMOUS_SIGNUP_ENABLED: "true",
                },
                // `connect` is offered only to a signed-in caller; the managed
                // provider's full action table is the fact under test here.
                principal: { accountId: "account-without-row" },
            },
        );

        // teams-lane-03/01 §10.2: every projector carries the descriptor's
        // provider kind, display name, icon hint, connect-button colour and
        // profile-badge support; a client must not recreate them for a dynamic provider.
        const companyLoginPresentation = {
            displayName: "Company login",
            iconHint: "oidc",
            providerKind: "oidc",
            connectButtonColor: "#0B5FFF",
            supportsProfileBadge: false,
        };
        expect(projection.state).toBe("ready");
        if (projection.state !== "ready") throw new Error("expected ready projection");
        expect(projection.actions.filter((action) => action.methodId === managed.id)).toEqual([
            expect.objectContaining({
                methodId: managed.id,
                action: "connect",
                mode: "either",
                presentation: companyLoginPresentation,
            }),
            expect.objectContaining({
                methodId: managed.id,
                action: "provision",
                mode: "keyed",
                presentation: companyLoginPresentation,
            }),
        ]);
    });
});
