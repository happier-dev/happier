import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptString } from "@/modules/encrypt";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    describeLinkedIds,
    listProviderDescriptors,
    resolveIdentityRuntimeById,
    resolveOAuthRuntimeById,
    resolveRuntimeInTx,
} from "./identityProviderCatalog";
import { HOME_PROVIDER_CONTEXT } from "./providerReference";
import { resolveOAuthSecurityBinding } from "@/app/api/routes/connect/oauthExternal/oauthSecurityBinding";
import { inTx } from "@/storage/inTx";
import { encryptGitHubAppRegistrationSecretsV1 } from "@/app/integrations/github/githubManagedApp";

let harness: LightSqliteHarness;

const config = {
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
    ui: { buttonColor: null, iconHint: "oidc" },
} as const;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-managed-provider-catalog-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
beforeEach(async () => {
    await db.homeGovernancePolicy.create({
        data: {
            id: "home",
            teamProviderPolicy: {
                v: 1,
                allowedTeamProviderKinds: ["oidc", "workos_sso", "github_app_identity"],
                teamJitAllowed: false,
                approvedGitHubEnterpriseOrigins: ["https://github.enterprise.example"],
            },
        },
    });
});
afterEach(async () => {
    await db.teamIdentityConnection.deleteMany({});
    await db.identityProviderInstance.deleteMany({});
    await db.gitHubAppInstallation.deleteMany({});
    await db.gitHubAppRegistration.deleteMany({});
    await db.team.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
});

describe("managed identity-provider catalog source", () => {
    it("publishes only an enabled exact Home WorkOS binding and invalidates its OAuth proof when changed", async () => {
        const provider = await db.identityProviderInstance.create({ data: {
            kind: "workos_sso", displayName: "Acme company sign-in", enabled: true,
            firstEnabledAt: new Date(), securityRevision: 3, config: { v: 1, kind: "workos_sso" },
        } });
        const env = {
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            WORKOS_API_KEY: "sk_test_catalog", WORKOS_CLIENT_ID: "client_catalog",
        };
        expect((await listProviderDescriptors(env)).some(({ reference }) => reference.id === provider.id)).toBe(false);
        await expect(resolveOAuthRuntimeById(env, provider.id)).resolves.toBeNull();
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, enabled: true, firstEnabledAt: new Date(), revision: 4,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_home", connectionId: "conn_home" },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const listed = (await listProviderDescriptors(env)).find(({ reference }) => reference.id === provider.id);
        expect(listed).toMatchObject({
            providerKind: "workos_sso",
            descriptor: { ui: { displayName: "Acme company sign-in" } },
            reference: { context: { kind: "home" } },
        });
        const runtime = await resolveOAuthRuntimeById(env, provider.id);
        expect(runtime?.reference).toEqual(listed?.reference);
        const binding = { provider: runtime!.reference, connection: { id: connection.id, revision: 4 }, admission: null, purpose: "identity_connection_test" } as const;
        await expect(resolveOAuthSecurityBinding({ env, providerId: provider.id, binding, purpose: "identity_connection_test", stage: "oauth_callback" }))
            .resolves.toMatchObject({ securityBinding: binding });
        const otherTeam = await db.team.create({ data: { name: "Unrelated Team" } });
        const otherConnection = await db.teamIdentityConnection.create({ data: {
            teamId: otherTeam.id, providerInstanceId: provider.id, enabled: true, revision: 4,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_team", connectionId: "conn_team" },
            settings: { v: 1, kind: "workos_sso" },
        } });
        await expect(resolveOAuthSecurityBinding({ env, providerId: provider.id,
            binding: { ...binding, connection: { id: otherConnection.id, revision: 4 } },
            purpose: "identity_connection_test", stage: "oauth_callback" })).resolves.toBeNull();
        await db.teamIdentityConnection.update({ where: { id: connection.id }, data: { enabled: false, revision: 5 } });
        expect((await listProviderDescriptors(env)).some(({ reference }) => reference.id === provider.id)).toBe(false);
        await expect(resolveOAuthRuntimeById(env, provider.id)).resolves.toBeNull();
        await expect(resolveOAuthRuntimeById(env, provider.id, HOME_PROVIDER_CONTEXT, "identity_connection_test"))
            .resolves.toMatchObject({ reference: { id: provider.id, context: { kind: "home" } } });
        await expect(resolveOAuthSecurityBinding({ env, providerId: provider.id, binding,
            purpose: "identity_connection_test", stage: "oauth_finalize" })).resolves.toBeNull();
    });
    it("resolves an enabled Home OIDC instance and isolates a malformed sibling", async () => {
        const managed = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Company login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config,
                encryptedSecrets: null,
            },
        });
        // Rebind the provider-id domain after Prisma creates the opaque ID.
        await db.identityProviderInstance.update({
            where: { id: managed.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", managed.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Broken",
                enabled: true,
                config: { ...config, v: 9 },
                encryptedSecrets: new Uint8Array([1, 2, 3]),
            },
        });

        const runtimes = await listProviderDescriptors(
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            HOME_PROVIDER_CONTEXT,
        );
        expect(runtimes.map(({ reference }) => reference.id)).toContain(managed.id);
        expect(runtimes.filter(({ reference }) => reference.source === "managed")).toHaveLength(1);

        const resolved = await resolveOAuthRuntimeById(
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            managed.id,
            HOME_PROVIDER_CONTEXT,
        );
        expect(resolved?.reference).toMatchObject({
            id: managed.id,
            source: "managed",
            context: { kind: "home" },
        });
        await expect(inTx(async (tx) => await resolveRuntimeInTx(tx, {
            env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            reference: resolved!.reference,
            purpose: "oauth_finalize",
        }))).resolves.toMatchObject({ ok: true });
        await expect(resolveOAuthSecurityBinding({
            env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            providerId: managed.id,
            binding: undefined,
            purpose: null,
            stage: "oauth_finalize",
        })).resolves.toBeNull();
    });

    it("lists safe managed descriptors without decrypting unrelated ciphertext", async () => {
        const valid = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Valid provider",
                enabled: true,
                firstEnabledAt: new Date(),
                config,
                encryptedSecrets: new Uint8Array([1, 2, 3]),
            },
        });
        const unrelated = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Unreadable secret",
                enabled: true,
                firstEnabledAt: new Date(),
                config: { ...config, issuer: "https://other.example.test" },
                encryptedSecrets: new Uint8Array([4, 5, 6]),
            },
        });

        const listed = await listProviderDescriptors(
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            HOME_PROVIDER_CONTEXT,
        );
        expect(listed.filter(({ reference }) => reference.source === "managed").map(({ reference }) => reference.id))
            .toEqual([valid.id, unrelated.id]);
        await expect(resolveOAuthRuntimeById(
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            valid.id,
            HOME_PROVIDER_CONTEXT,
        )).resolves.toBeNull();
    });

    it("selects a configured disabled draft only for an identity-connection test", async () => {
        const draft = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Draft provider",
                enabled: false,
                config,
                encryptedSecrets: null,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: draft.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", draft.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        const env = { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };

        await expect(resolveOAuthRuntimeById(env, draft.id, HOME_PROVIDER_CONTEXT))
            .resolves.toBeNull();
        const selected = await resolveOAuthRuntimeById(
            env,
            draft.id,
            HOME_PROVIDER_CONTEXT,
            "identity_connection_test",
        );
        expect(selected?.reference).toMatchObject({ id: draft.id, source: "managed" });
        await expect(inTx(async (tx) => await resolveRuntimeInTx(tx, {
            env,
            reference: selected!.reference,
            purpose: "identity_connection_test",
        }))).resolves.toMatchObject({ ok: true });
        await expect(inTx(async (tx) => await resolveRuntimeInTx(tx, {
            env,
            reference: selected!.reference,
            purpose: "oauth_start",
        }))).resolves.toEqual({ ok: false, code: "auth_provider_unavailable" });
    });

    it("excludes both sides of a non-reserved deployment and managed id collision", async () => {
        const otherTeam = await db.team.create({ data: { name: "Other Team" } });
        await db.identityProviderInstance.create({
            data: {
                id: "acme-collision",
                ownerTeamId: otherTeam.id,
                kind: "oidc",
                displayName: "Managed Acme",
                enabled: false,
                firstEnabledAt: null,
                config,
                encryptedSecrets: new Uint8Array([1, 2, 3]),
            },
        });
        const env = {
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                id: "acme-collision",
                type: "oidc",
                displayName: "Deployment Acme",
                issuer: "https://deployment.example.test",
                clientId: "client",
                clientSecret: "secret",
                redirectUrl: "https://home.example.test/v1/oauth/acme-collision/callback",
            }]),
        };

        expect((await listProviderDescriptors(env, HOME_PROVIDER_CONTEXT))
            .some(({ reference }) => reference.id === "acme-collision")).toBe(false);
        await expect(resolveOAuthRuntimeById(env, "acme-collision", HOME_PROVIDER_CONTEXT)).resolves.toBeNull();
    });

    it("enumerates and resolves a WorkOS runtime only through its exact enabled Team connection", async () => {
        const team = await db.team.create({ data: { name: "WorkOS Team" } });
        const bound = await db.identityProviderInstance.create({
            data: {
                kind: "workos_sso",
                displayName: "Acme SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                securityRevision: 3,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const unbound = await db.identityProviderInstance.create({
            data: {
                kind: "workos_sso",
                displayName: "Other SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const unboundOidc = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Unbound Team OIDC",
                enabled: true,
                firstEnabledAt: new Date(),
                config,
                encryptedSecrets: null,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: unboundOidc.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", unboundOidc.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: bound.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_acme",
                    connectionId: "conn_acme",
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date(),
                revision: 6,
            },
        });
        const env = {
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            WORKOS_API_KEY: "sk_test_catalog",
            WORKOS_CLIENT_ID: "client_catalog",
        };
        const context = { kind: "team" as const, teamId: team.id };

        const listed = await listProviderDescriptors(env, context);
        const managedListed = listed.filter(({ reference }) => reference.source === "managed");
        expect(managedListed.map(({ reference }) => reference.id)).toEqual([bound.id]);
        expect(managedListed[0]?.reference).toMatchObject({
            source: "managed",
            context,
            runtimeFingerprint: expect.stringContaining(":3:6:"),
        });
        await expect(resolveOAuthRuntimeById(env, unbound.id, context)).resolves.toBeNull();
        await expect(resolveOAuthRuntimeById(env, unboundOidc.id, context)).resolves.toBeNull();
        await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: unboundOidc.id,
                enabled: true,
                firstEnabledAt: new Date(),
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });
        await expect(resolveOAuthRuntimeById(env, unboundOidc.id, context))
            .resolves.toMatchObject({ reference: { id: unboundOidc.id, context } });
        const resolved = await resolveOAuthRuntimeById(env, bound.id, context);
        expect(resolved?.provider.id).toBe(bound.id);

        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: { revision: 7 },
        });
        const rotated = await resolveOAuthRuntimeById(env, bound.id, context);
        expect(rotated?.reference.runtimeFingerprint).not.toBe(resolved?.reference.runtimeFingerprint);
    });

    it("stops resolving a Team runtime once the Home narrows away its provider kind", async () => {
        // Advertisement already omits a prohibited kind; execution must refuse
        // it through the same policy owner, or a Home decision is visible on
        // every read surface while the sign-in flow still starts and finalizes.
        const team = await db.team.create({ data: { name: "Narrowed Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Company login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config,
                encryptedSecrets: null,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", provider.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });
        const env = { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };
        const context = { kind: "team" as const, teamId: team.id };
        await expect(resolveOAuthRuntimeById(env, provider.id, context))
            .resolves.toMatchObject({ reference: { id: provider.id, context } });

        await db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const listed = await listProviderDescriptors(env, context);
        expect(listed.map(({ reference }) => reference.id)).not.toContain(provider.id);
        await expect(resolveOAuthRuntimeById(env, provider.id, context)).resolves.toBeNull();
        await expect(resolveOAuthRuntimeById(env, provider.id, context, "identity_connection_test"))
            .resolves.toBeNull();
        // The Home's own use of its provider is not governed by the Team ceiling.
        await expect(resolveOAuthRuntimeById(env, provider.id, HOME_PROVIDER_CONTEXT))
            .resolves.toMatchObject({ reference: { id: provider.id, context: { kind: "home" } } });
    });

    it("binds Team OIDC callbacks to the exact current connection revision", async () => {
        const team = await db.team.create({ data: { name: "OIDC Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Team OIDC",
                enabled: true,
                firstEnabledAt: new Date(),
                securityRevision: 3,
                config,
                encryptedSecrets: null,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", provider.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date(),
                revision: 4,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });
        const env = { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };
        const context = { kind: "team" as const, teamId: team.id };
        const listed = (await listProviderDescriptors(env, context))
            .find(({ reference }) => reference.id === provider.id);
        const runtime = await resolveOAuthRuntimeById(env, provider.id, context);
        expect(runtime?.reference).toEqual(listed?.reference);

        const binding = {
            provider: runtime!.reference,
            connection: null,
            admission: null,
            purpose: "team_admission" as const,
        };
        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: {
                revision: { increment: 1 },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: ["alice"],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });
        await expect(resolveOAuthSecurityBinding({
            env,
            providerId: provider.id,
            binding,
            purpose: "team_admission",
            stage: "oauth_callback",
        })).resolves.toBeNull();

        const afterEdit = await resolveOAuthRuntimeById(env, provider.id, context);
        expect(afterEdit?.reference.runtimeFingerprint).not.toBe(runtime?.reference.runtimeFingerprint);
        const identityAfterEdit = await resolveIdentityRuntimeById(env, provider.id, context);
        await expect(identityAfterEdit!.provider.prepareConnect({
            ctx: Context.create("account-not-written"),
            profile: { sub: "subject-bob", preferred_username: "bob" },
            accessToken: "access-token",
        })).rejects.toThrow("not-eligible");
        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: { enabled: false, revision: { increment: 1 } },
        });
        await expect(inTx(async (tx) => await resolveRuntimeInTx(tx, {
            env,
            reference: afterEdit!.reference,
            purpose: "oauth_callback",
        }))).resolves.toEqual({ ok: false, code: "auth_provider_unavailable" });

        await db.teamIdentityConnection.delete({ where: { id: connection.id } });
        await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date(),
                revision: 5,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: ["alice"],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });
        await expect(resolveOAuthSecurityBinding({
            env,
            providerId: provider.id,
            binding: { ...binding, provider: afterEdit!.reference },
            purpose: "team_admission",
            stage: "oauth_callback",
        })).resolves.toBeNull();
    });

    it("lists and resolves Home GitHub identity only from the same verified safe runtime metadata", async () => {
        const registrationId = "catalog-home-github-registration";
        const registration = await db.gitHubAppRegistration.create({
            data: {
                id: registrationId,
                githubHost: "https://github.com",
                githubAppId: 9901n,
                githubClientId: "Iv1.catalog",
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({
                    registrationId,
                    secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
                }),
                state: "verified",
                lastVerifiedAt: new Date(),
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 9902n,
                githubOrganizationId: 9903n,
                githubOrganizationLogin: "Catalog",
                repositorySelection: "all",
                state: "verified",
                verifiedPermissions: { members: "read" },
                lastVerifiedAt: new Date(),
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "github_app_identity",
                displayName: "Catalog GitHub",
                enabled: true,
                firstEnabledAt: new Date(),
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        const env = { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };

        const listed = (await listProviderDescriptors(env, HOME_PROVIDER_CONTEXT))
            .find(({ reference }) => reference.id === provider.id);
        expect(listed).toMatchObject({
            descriptor: { configured: true, enabled: true },
            reference: { source: "managed", context: HOME_PROVIDER_CONTEXT },
        });
        const runtime = await resolveOAuthRuntimeById(env, provider.id, HOME_PROVIDER_CONTEXT);
        expect(runtime?.reference).toEqual(listed?.reference);

        await db.gitHubAppRegistration.update({
            where: { id: registration.id },
            data: {
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: false,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
            },
        });
        expect((await listProviderDescriptors(env, HOME_PROVIDER_CONTEXT))
            .some(({ reference }) => reference.id === provider.id)).toBe(false);
        await expect(resolveOAuthRuntimeById(env, provider.id, HOME_PROVIDER_CONTEXT)).resolves.toBeNull();
    });

    it("presents a linked Team GitHub identity through its managed GHES provider after disablement", async () => {
        const team = await db.team.create({ data: { name: "Catalog presentation" } });
        const registration = await db.gitHubAppRegistration.create({
            data: {
                id: "catalog-team-github-registration",
                ownerTeamId: team.id,
                githubHost: "https://github.enterprise.example",
                githubAppId: 9911n,
                githubClientId: "Iv1.catalog-team",
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({
                    registrationId: "catalog-team-github-registration",
                    secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
                }),
                state: "verified",
                lastVerifiedAt: new Date(),
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 9912n,
                githubOrganizationId: 9913n,
                githubOrganizationLogin: "Catalog",
                repositorySelection: "all",
                state: "verified",
                verifiedPermissions: { members: "read" },
                lastVerifiedAt: new Date(),
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "github_app_identity",
                displayName: "Catalog GHES",
                enabled: false,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });

        const presentation = await describeLinkedIds({
            env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            providerIds: [provider.id],
        });

        expect(presentation.get(provider.id)?.extractLinkedProvider?.({
            profile: { id: 77, login: "octocat", name: "Octo Cat", avatar_url: "avatar" },
            providerLogin: "octocat",
        })).toEqual({
            displayName: "Octo Cat",
            avatarUrl: "avatar",
            profileUrl: "https://github.enterprise.example/octocat",
        });
        expect(presentation.get(provider.id)?.extractProfileBadge?.({
            profile: { id: 77, login: "octocat", name: "Octo Cat", avatar_url: "avatar" },
            providerLogin: "octocat",
        })).toEqual({
            label: "@octocat",
            url: "https://github.enterprise.example/octocat",
        });
    });

    it("presents an already-linked managed WorkOS identity without rebuilding a live provider runtime", async () => {
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "workos_sso",
                displayName: "Acme SSO",
                enabled: false,
                config: { v: 1, kind: "workos_sso" },
            },
        });

        const presentation = await describeLinkedIds({
            env: {},
            providerIds: [provider.id],
        });

        expect(presentation.get(provider.id)?.extractLinkedProvider?.({
            profile: { email: "member@acme.example" },
            providerLogin: "member@acme.example",
        })).toEqual({
            displayName: "member@acme.example",
            avatarUrl: null,
            profileUrl: null,
        });
    });
});
