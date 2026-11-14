import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createOidcOAuthProvider } from "@/app/oauth/providers/oidc/oidcOAuthProvider";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";

import { describeIdentityConnectionTestDiagnostics } from "./identityConnectionTestDiagnostics";
import type { OAuthSecurityBinding } from "./oauthExternalSchemas";

function oidcInstance(
    allow: Partial<OidcAuthProviderInstanceConfig["allow"]> = {},
): OidcAuthProviderInstanceConfig {
    return {
        id: "acme-oidc",
        type: "oidc",
        displayName: "Acme OIDC",
        issuer: "https://issuer.example.test",
        clientId: "client",
        clientSecret: "secret",
        clientAuthenticationMethod: "client_secret_post",
        redirectUrl: "https://api.example.test/v1/oauth/acme-oidc/callback",
        scopes: "openid profile email groups",
        httpTimeoutSeconds: 10,
        claims: { login: "preferred_username", email: "email", groups: "groups" },
        allow: {
            usersAllowlist: [],
            emailDomains: [],
            groupsAny: [],
            groupsAll: [],
            ...allow,
        },
        fetchUserInfo: false,
        storeRefreshToken: false,
        ui: { buttonColor: null, iconHint: null },
    };
}

function teamBinding(input: Readonly<{ teamId: string; connectionId: string }>): OAuthSecurityBinding {
    return {
        provider: {
            id: "acme-oidc",
            source: "managed",
            runtimeFingerprint: "runtime-1",
            context: { kind: "team", teamId: input.teamId },
        },
        connection: { id: input.connectionId, revision: 1 },
        admission: null,
        purpose: "identity_connection_test",
    };
}

describe("identity-connection test diagnostics", () => {
    let harness: LightSqliteHarness;
    let teamId = "";
    let connectionId = "";
    let otherConnectionId = "";
    let engineeringGroupId = "";

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-identity-test-diagnostics-",
            initAuth: false,
        });
        const team = await db.team.create({ data: { name: "Acme" } });
        teamId = team.id;
        const otherTeam = await db.team.create({ data: { name: "Other" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Acme OIDC",
                config: { v: 1, kind: "oidc" },
            },
        });
        const otherProvider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Second Acme OIDC",
                config: { v: 1, kind: "oidc" },
            },
        });
        const otherTeamProvider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: otherTeam.id,
                kind: "oidc",
                displayName: "Other Team OIDC",
                config: { v: 1, kind: "oidc" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc" },
            },
        });
        connectionId = connection.id;
        const otherConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: otherProvider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc" },
            },
        });
        otherConnectionId = otherConnection.id;
        const otherTeamConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: otherTeam.id,
                providerInstanceId: otherTeamProvider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc" },
            },
        });

        const engineering = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering") },
        });
        engineeringGroupId = engineering.id;
        const design = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Design") },
        });
        const otherTeamGroup = await db.teamGroup.create({
            data: { teamId: otherTeam.id, name: storedPlainPrivateLabel("Engineering") },
        });
        await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: engineering.id,
                teamIdentityConnectionId: connection.id,
                externalGroupId: "Engineering",
                bindingMode: "native_target",
            },
        });
        // A binding on a sibling connection of the same Team must not leak into the preview.
        await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: design.id,
                teamIdentityConnectionId: otherConnection.id,
                externalGroupId: "design",
                bindingMode: "native_target",
            },
        });
        // Neither may another Team's identical external key.
        await db.teamExternalGroupBinding.create({
            data: {
                teamId: otherTeam.id,
                teamGroupId: otherTeamGroup.id,
                teamIdentityConnectionId: otherTeamConnection.id,
                externalGroupId: "engineering",
                bindingMode: "native_target",
            },
        });
    }, 120_000);
    afterAll(async () => await harness.close());

    const describeTest = async (input: Readonly<{
        instance?: OidcAuthProviderInstanceConfig;
        profile: unknown;
        securityBinding: OAuthSecurityBinding;
    }>) => await describeIdentityConnectionTestDiagnostics({
        provider: createOidcOAuthProvider(input.instance ?? oidcInstance(), "runtime-1"),
        env: process.env,
        profile: input.profile,
        securityBinding: input.securityBinding,
    });

    it("maps only this Team connection's bindings and never returns claim values", async () => {
        const diagnostics = await describeTest({
            instance: oidcInstance({ emailDomains: ["acme.test"], groupsAny: ["engineering"] }),
            profile: {
                sub: "subject-do-not-return",
                preferred_username: "Ada",
                email: "ada@ACME.test",
                email_verified: true,
                groups: ["Engineering", "design", "Design"],
            },
            securityBinding: teamBinding({ teamId, connectionId }),
        });

        expect(diagnostics).toEqual({
            subjectPresent: true,
            loginAvailable: true,
            emailAvailable: true,
            emailVerified: true,
            groups: { state: "complete", count: 2 },
            eligibility: {
                status: "eligible",
                rules: [
                    { kind: "email_domains", matched: true },
                    { kind: "groups_any", matched: true },
                ],
            },
            mappedGroups: [{ id: engineeringGroupId, name: "Engineering" }],
        });
        const serialized = JSON.stringify(diagnostics);
        expect(serialized).not.toContain("subject-do-not-return");
        expect(serialized).not.toContain("ada@");
        expect(serialized).not.toContain("Ada");
    });

    it("reports a denied eligibility without mapping anything the observation cannot decide", async () => {
        const incomplete = await describeTest({
            instance: oidcInstance({ groupsAll: ["engineering"] }),
            profile: {
                sub: "subject-2",
                _claim_names: { groups: "src1" },
                _claim_sources: { src1: { endpoint: "https://issuer.example.test/claims" } },
            },
            securityBinding: teamBinding({ teamId, connectionId }),
        });
        expect(incomplete).toMatchObject({
            groups: { state: "incomplete", count: null },
            eligibility: { status: "ineligible", rules: [{ kind: "groups_all", matched: false }] },
            mappedGroups: [],
        });

        const absent = await describeTest({
            instance: oidcInstance({ usersAllowlist: ["someone-else"] }),
            profile: { sub: "subject-3", preferred_username: "ada" },
            securityBinding: teamBinding({ teamId, connectionId }),
        });
        expect(absent).toMatchObject({
            groups: { state: "absent", count: null },
            eligibility: { status: "ineligible", rules: [{ kind: "users", matched: false }] },
            mappedGroups: [],
        });
    });

    it("maps nothing for a Home-owned test and writes no Team facts", async () => {
        const before = await Promise.all([
            db.teamGroupMembership.count(),
            db.teamMembership.count(),
            db.accountIdentity.count(),
            db.teamExternalGroupBinding.count(),
        ]);
        const diagnostics = await describeTest({
            profile: { sub: "subject-4", groups: ["Engineering"] },
            securityBinding: {
                provider: {
                    id: "acme-oidc",
                    source: "managed",
                    runtimeFingerprint: "runtime-1",
                    context: { kind: "home" },
                },
                connection: null,
                admission: null,
                purpose: "identity_connection_test",
            },
        });
        expect(diagnostics).toMatchObject({
            groups: { state: "complete", count: 1 },
            mappedGroups: [],
        });

        const otherConnectionDiagnostics = await describeTest({
            profile: { sub: "subject-5", groups: ["Engineering"] },
            securityBinding: teamBinding({ teamId, connectionId: otherConnectionId }),
        });
        expect(otherConnectionDiagnostics?.mappedGroups).toEqual([]);

        await expect(Promise.all([
            db.teamGroupMembership.count(),
            db.teamMembership.count(),
            db.accountIdentity.count(),
            db.teamExternalGroupBinding.count(),
        ])).resolves.toEqual(before);
    });

    it("produces no diagnostics for a provider that does not describe its test", async () => {
        const provider = createOidcOAuthProvider(oidcInstance(), "runtime-1");
        const { describeIdentityTest: _omitted, ...withoutDescribe } = provider;
        await expect(describeIdentityConnectionTestDiagnostics({
            provider: withoutDescribe,
            env: process.env,
            profile: { sub: "subject-6" },
            securityBinding: teamBinding({ teamId, connectionId }),
        })).resolves.toBeNull();
    });
});
