import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { Context } from "@/context";
import { createOidcIdentityProvider } from "./oidcIdentityProvider";
import { createOidcIdentityProfile, normalizeOidcIdentityClaims } from "./normalizeOidcIdentityClaims";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("oidcIdentityProvider.connect (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-connect-",
            initEncrypt: true,
            initAuth: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("updates the stored identity when reconnecting the same provider user", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-oidc-reconnect` },
            select: { id: true },
        });

        const provider = createOidcIdentityProvider({
            id: "oidc-test",
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        } as any, "test-runtime");

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-1", preferred_username: "alice" },
            accessToken: "access-token",
        });

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-1", preferred_username: "alice2" },
            accessToken: "access-token",
        });

        const identity = await db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: "oidc-test" },
            select: { providerUserId: true, providerLogin: true },
        });
        expect(identity?.providerUserId).toBe("sub-1");
        expect(identity?.providerLogin).toBe("alice2");
        const change = await db.accountChange.findUnique({
            where: { accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "linked-identities" } },
        });
        expect(change?.hint).toEqual({ linkedProviders: true });
    });

    it("uses the configured subject claim as released group evidence", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-oidc-protected-group-claim` },
            select: { id: true },
        });
        const provider = createOidcIdentityProvider({
            id: "oidc-test",
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile",
            claims: { login: "preferred_username", email: "email", groups: "sub" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: ["case-sensitive-subject"], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        }, "test-runtime");

        await expect(provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "Case-Sensitive-Subject" },
            accessToken: "access-token",
        })).resolves.toBeUndefined();

        await expect(db.accountIdentity.findFirstOrThrow({
            where: { accountId: account.id, provider: "oidc-test" },
            select: { providerUserId: true },
        })).resolves.toEqual({ providerUserId: "Case-Sensitive-Subject" });
    });

    it("does not satisfy an email-domain restriction with unverified email evidence", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-oidc-unverified-email` },
            select: { id: true },
        });
        const provider = createOidcIdentityProvider({
            id: "oidc-test",
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile email",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: ["example.test"], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        }, "test-runtime");

        await expect(provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "subject", email: "user@example.test", email_verified: false },
            accessToken: "access-token",
        })).rejects.toThrow("not-eligible");
        await expect(db.accountIdentity.count({ where: { accountId: account.id } })).resolves.toBe(0);
    });

    it("preserves an allowlisted login when configured login and email claims overlap standard fields", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-oidc-overlapping-claims` },
            select: { id: true },
        });
        const claims = { login: "email", email: "mail", groups: "groups" };
        const provider = createOidcIdentityProvider({
            id: "oidc-test",
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile email",
            claims,
            allow: { usersAllowlist: ["login@example.test"], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        }, "test-runtime");
        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                email: "Login@Example.Test",
                mail: "Mailbox@Example.Test",
                email_verified: true,
            },
            claims,
        });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        await provider.connect({
            ctx: Context.create(account.id),
            profile: createOidcIdentityProfile(normalized.value, claims),
            accessToken: "access-token",
        });

        await expect(db.accountIdentity.findFirstOrThrow({
            where: { accountId: account.id, provider: "oidc-test" },
            select: { providerLogin: true },
        })).resolves.toEqual({ providerLogin: "login@example.test" });
    });

    it("replaces only the signing-in member's mapped Group contributions from complete Team claims", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-oidc-groups` } });
        const team = await db.team.create({ data: { name: "OIDC Group Team" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "member" },
        });
        const instance = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "OIDC Test",
                enabled: true,
                config: {
                    v: 1, kind: "oidc", issuer: "https://issuer.example.test", clientId: "cid",
                    scopes: "openid profile", httpTimeoutSeconds: 5,
                    claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: false, storeRefreshToken: false,
                    ui: { buttonColor: null, iconHint: null },
                },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: instance.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
                enabled: true,
            },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Engineering", nameKey: "engineering" },
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: group.id,
                teamIdentityConnectionId: connection.id,
                externalGroupId: "Engineering-Claim",
                bindingMode: "native_target",
            },
        });
        const provider = createOidcIdentityProvider({
            id: instance.id,
            type: "oidc",
            displayName: "OIDC Test",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret: "secret",
            redirectUrl: "https://server.example.test/v1/oauth/oidc-test/callback",
            scopes: "openid profile",
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
            httpTimeoutSeconds: 5,
        }, "test-runtime", undefined, {
            teamId: team.id,
            connectionId: connection.id,
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
        });

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-groups", groups: ["Engineering-Claim"] },
            accessToken: "access-token",
        });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: { teamGroupId_teamMembershipId_externalGroupBindingId: {
                teamGroupId: group.id,
                teamMembershipId: membership.id,
                externalGroupBindingId: binding.id,
            } },
        })).resolves.not.toBeNull();

        await provider.connect({
            ctx: Context.create(account.id),
            profile: { sub: "sub-groups", groups: [] },
            accessToken: "access-token",
        });
        await expect(db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id },
        })).resolves.toBe(0);
    });
});
