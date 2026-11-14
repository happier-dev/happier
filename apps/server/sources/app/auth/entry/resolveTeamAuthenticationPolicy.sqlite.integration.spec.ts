import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setTeamPolicyInTx } from "@/app/teams/policy";
import { encryptString } from "@/modules/encrypt";
import { auth } from "@/app/auth/auth";

import { resolveTeamAuthenticationPolicyInTx } from "./resolveTeamAuthenticationPolicy";
import { qualifyTeamAuthenticationInTx, qualifyTeamAuthenticationsInTx } from "./qualifyTeamAuthentication";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

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
    ui: { buttonColor: null, iconHint: "oidc" },
} as const;

const managedEnv = {
    HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
};

describe("Team authentication policy catalog resolution (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-authentication-policy-",
            initAuth: false,
            initEncrypt: true,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.homeGovernancePolicy.deleteMany({});
        await db.accountIdentity.deleteMany({});
        await db.teamIdentityConnection.deleteMany({});
        await db.identityProviderInstance.deleteMany({});
        await db.team.deleteMany({});
        await db.account.deleteMany({});
    });

    afterAll(async () => await harness.close());

    it("resolves a current native Home method and intersects optional Account facts", async () => {
        const policy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [{ kind: "home_method" as const, methodId: "key_challenge" }],
        };
        const env = { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" };

        await expect(inTx(async (tx) => await resolveTeamAuthenticationPolicyInTx(tx, {
            env,
            teamId: "team-not-needed-for-native-choice",
            policy,
        }))).resolves.toMatchObject({
            resolution: {
                status: "restricted",
                choices: [{ availability: "usable" }],
            },
            activationReadiness: "ready",
        });
        await expect(inTx(async (tx) => await resolveTeamAuthenticationPolicyInTx(tx, {
            env,
            teamId: "team-not-needed-for-native-choice",
            policy,
            accountFacts: { usableHomeMethodIds: [], usableTeamConnectionIds: [] },
        }))).resolves.toMatchObject({
            resolution: {
                status: "restricted",
                choices: [{ availability: "unavailable" }],
            },
            activationReadiness: "unavailable",
        });
    });

    it("qualifies an external Home method only at its persisted current fingerprint and security revision", async () => {
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Company login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
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
        const descriptor = await inTx(async (tx) => (await listProviderDescriptorsInTx(tx, managedEnv))
            .find((candidate) => candidate.reference.id === provider.id));
        expect(descriptor).toBeDefined();
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: {
                lastSuccessfulTestAt: new Date("2026-09-06T00:01:00.000Z"),
                lastSuccessfulTestRuntimeFingerprint: descriptor!.reference.runtimeFingerprint,
                lastSuccessfulTestSecurityRevision: provider.securityRevision,
            },
        });
        const policy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [{ kind: "home_method" as const, methodId: provider.id }],
        };

        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: "team-not-needed-for-home-choice",
            policy,
        }))).resolves.toMatchObject({ activationReadiness: "ready" });

        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const identity = await db.accountIdentity.create({
            data: { accountId: account.id, provider: provider.id, providerUserId: "home-subject" },
        });
        const team = await db.team.create({ data: { name: "Home evidence", authenticationPolicy: policy } });
        const evidence = [{
            kind: "provider" as const,
            providerId: provider.id,
            identityId: identity.id,
            runtimeFingerprint: descriptor!.reference.runtimeFingerprint,
        }];
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "satisfied" });
        await inTx(async (tx) => {
            // Persistence is the boundary: policy, catalog and qualification logic stay real.
            const readIdentity = vi.spyOn(tx.accountIdentity, "findMany")
                .mockRejectedValueOnce(new Error("Identity storage temporarily unavailable"));
            try {
                await expect(qualifyTeamAuthenticationInTx(tx, {
                    env: managedEnv,
                    team,
                    accountId: account.id,
                    verifiedCredentialEvidence: evidence,
                    operationContext: { kind: "present_user" },
                })).resolves.toEqual({ status: "unavailable" });
            } finally {
                readIdentity.mockRestore();
            }
        });
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { encryptedSecrets: new Uint8Array([1, 2, 3]) },
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "authentication_required" });
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", provider.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });

        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { securityRevision: { increment: 1 } },
        });
        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: "team-not-needed-for-home-choice",
            policy,
        }))).resolves.toMatchObject({
            resolution: { choices: [{ availability: "usable" }] },
            activationReadiness: "provider_test_required",
        });
    });

    it("qualifies a Team connection only at its current runtime fingerprint", async () => {
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const team = await db.team.create({ data: { name: "Exact Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Team login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
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
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const descriptor = await inTx(async (tx) => (await listProviderDescriptorsInTx(
            tx,
            managedEnv,
            { kind: "team", teamId: team.id },
        )).find((candidate) => candidate.reference.id === provider.id));
        expect(descriptor).toBeDefined();
        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: {
                lastSuccessfulTestAt: new Date("2026-09-06T00:01:00.000Z"),
                lastObservation: {
                    v: 1,
                    kind: "oidc",
                    successfulTest: {
                        runtimeFingerprint: descriptor!.reference.runtimeFingerprint,
                    },
                },
            },
        });
        const policy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [{ kind: "team_connection" as const, connectionId: connection.id }],
        };

        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: team.id,
            policy,
        }))).resolves.toMatchObject({ activationReadiness: "ready" });

        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: { revision: { increment: 1 } },
        });
        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: team.id,
            policy,
        }))).resolves.toMatchObject({
            resolution: { choices: [{ availability: "usable" }] },
            activationReadiness: "provider_test_required",
        });
    });

    it("returns the typed test-required result before the policy writer considers activation", async () => {
        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" },
        });
        const team = await db.team.create({ data: { name: "Policy Team" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "owner" },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Untested login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
            },
        });

        await expect(inTx(async (tx) => setTeamPolicyInTx(tx, {
            actorAccountId: account.id,
            teamId: team.id,
            env: managedEnv,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: provider.id }],
            },
        }))).resolves.toEqual({
            ok: false,
            error: "team_authentication_policy_unavailable",
            details: { reason: "provider_test_required" },
        });
    });

    it("distinguishes unreadable referenced catalog state from a proven unavailable choice", async () => {
        const team = await db.team.create({ data: { name: "Unreadable Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Unreadable provider",
                enabled: true,
                config: { v: 1, kind: "oidc" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
            },
        });

        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: team.id,
            policy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "team_connection", connectionId: connection.id }],
            },
        }))).resolves.toEqual({
            resolution: { status: "unavailable" },
            activationReadiness: "unavailable",
        });
    });

    it("keeps a usable accepted alternative when another accepted instance is unreadable", async () => {
        const usableProvider = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Company login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
            },
        });
        await db.identityProviderInstance.update({
            where: { id: usableProvider.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", usableProvider.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });
        const descriptor = await inTx(async (tx) => (await listProviderDescriptorsInTx(tx, managedEnv))
            .find((candidate) => candidate.reference.id === usableProvider.id));
        expect(descriptor).toBeDefined();
        await db.identityProviderInstance.update({
            where: { id: usableProvider.id },
            data: {
                lastSuccessfulTestAt: new Date("2026-09-06T00:01:00.000Z"),
                lastSuccessfulTestRuntimeFingerprint: descriptor!.reference.runtimeFingerprint,
                lastSuccessfulTestSecurityRevision: usableProvider.securityRevision,
            },
        });
        const unreadableProvider = await db.identityProviderInstance.create({
            data: {
                kind: "oidc",
                displayName: "Unreadable login",
                enabled: true,
                config: { v: 1, kind: "oidc" },
            },
        });
        const policy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [
                { kind: "home_method" as const, methodId: unreadableProvider.id },
                { kind: "home_method" as const, methodId: usableProvider.id },
            ],
        };

        const mixed = await inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: "team-not-needed-for-home-choices",
            policy,
        }));
        if (mixed.resolution.status !== "restricted") throw new Error("Expected a restricted resolution");
        // `normalizeTeamAuthenticationPolicyV1` sorts the accepted set by its
        // canonical key, so the assertion is keyed by reference rather than by
        // the order the policy was authored in.
        expect(new Map(mixed.resolution.choices.map((choice) => [
            choice.reference.kind === "home_method" ? choice.reference.methodId : choice.reference.connectionId,
            choice.availability,
        ]))).toEqual(new Map([
            [usableProvider.id, "usable"],
            [unreadableProvider.id, "unavailable"],
        ]));
        expect(mixed.activationReadiness).toBe("ready");

        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const identity = await db.accountIdentity.create({
            data: { accountId: account.id, provider: usableProvider.id, providerUserId: "home-subject" },
        });
        const team = await db.team.create({ data: { name: "Mixed readability", authenticationPolicy: policy } });
        const evidence = [{
            kind: "provider" as const,
            providerId: usableProvider.id,
            identityId: identity.id,
            runtimeFingerprint: descriptor!.reference.runtimeFingerprint,
        }];
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "satisfied",
            matched: { kind: "home_method", methodId: usableProvider.id },
        });

        // Removing the one usable alternative leaves an unreadable read as the
        // only fact, and that stays fail-closed at both owners.
        const unreadableOnly = {
            ...policy,
            accepted: [{ kind: "home_method" as const, methodId: unreadableProvider.id }],
        };
        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: managedEnv,
            teamId: "team-not-needed-for-home-choices",
            policy: unreadableOnly,
        }))).resolves.toEqual({
            resolution: { status: "unavailable" },
            activationReadiness: "unavailable",
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: { id: team.id, authenticationPolicy: unreadableOnly },
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({ status: "unavailable" });
    });

    it("treats a connected choice the provider catalog does not offer as unavailable, not unreadable", async () => {
        const team = await db.team.create({ data: { name: "Catalog omission Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Catalog omitted provider",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });

        await expect(inTx(async (tx) => resolveTeamAuthenticationPolicyInTx(tx, {
            env: {},
            teamId: team.id,
            policy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "team_connection", connectionId: connection.id }],
            },
        }))).resolves.toEqual({
            resolution: {
                status: "restricted",
                choices: [{
                    reference: { kind: "team_connection", connectionId: connection.id },
                    availability: "unavailable",
                }],
            },
            activationReadiness: "unavailable",
        });
    });

    it("qualifies one current credential evidence item and invalidates its exact identity lifetime", async () => {
        harness.resetEnv(managedEnv);
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const team = await db.team.create({ data: { name: "Credential Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Credential login",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: managedOidcConfig,
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
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const descriptor = await inTx(async (tx) => (await listProviderDescriptorsInTx(
            tx,
            managedEnv,
            { kind: "team", teamId: team.id },
        )).find((candidate) => candidate.reference.id === provider.id));
        expect(descriptor).toBeDefined();
        const identity = await db.accountIdentity.create({
            data: { accountId: account.id, provider: provider.id, providerUserId: "subject" },
        });
        const restrictedPolicy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [{ kind: "team_connection" as const, connectionId: connection.id }],
        };
        const restrictedTeam = await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: restrictedPolicy,
            },
            select: { id: true, authenticationPolicy: true },
        });
        const evidence = [{
            kind: "provider" as const,
            providerId: provider.id,
            identityId: identity.id,
            runtimeFingerprint: descriptor!.reference.runtimeFingerprint,
            teamConnectionId: connection.id,
        }];

        // Released pre-marker and current V1 credentials both project no
        // authentication evidence. Ordinary Home compatibility must not turn
        // that absence into restricted-Team qualification.
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: undefined,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "authentication_required",
            accepted: [{ kind: "team_connection", connectionId: connection.id }],
        });

        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "satisfied",
            matched: { kind: "team_connection", connectionId: connection.id },
        });

        const otherTeam = await db.team.create({
            data: { name: "Other exact Team", authenticationPolicy: restrictedPolicy },
            select: { id: true, authenticationPolicy: true },
        });
        const exactTeamBatch = await inTx((tx) => qualifyTeamAuthenticationsInTx(tx, {
            env: managedEnv,
            teams: [restrictedTeam, otherTeam],
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }));
        expect(exactTeamBatch.get(restrictedTeam.id)).toEqual({
            status: "satisfied",
            matched: { kind: "team_connection", connectionId: connection.id },
        });
        expect(exactTeamBatch.get(otherTeam.id)).toEqual({ status: "unavailable" });

        await db.accountIdentity.update({
            where: { id: identity.id },
            data: { eligibilityStatus: "ineligible" },
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "authentication_required",
            accepted: [{ kind: "team_connection", connectionId: connection.id }],
        });
        await expect(auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: await preparePlainAccountApiTokenLabel(account.id, "Ineligible identity"),
            authenticationEvidence: evidence,
        })).rejects.toMatchObject({ code: "credential_authentication_evidence_unavailable" });
        await expect(db.accountApiToken.count({ where: { accountId: account.id } })).resolves.toBe(0);

        await db.accountIdentity.update({
            where: { id: identity.id },
            data: { eligibilityStatus: "unknown" },
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "satisfied",
            matched: { kind: "team_connection", connectionId: connection.id },
        });
        const unknownEligibilityPat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: await preparePlainAccountApiTokenLabel(account.id, "Transient identity state"),
            authenticationEvidence: evidence,
        });
        await expect(db.accountApiToken.findUnique({
            where: { id: unknownEligibilityPat.tokenId },
            select: { authenticationEvidence: true },
        })).resolves.toEqual({ authenticationEvidence: { v: 1, evidence } });
        await db.accountApiToken.delete({ where: { id: unknownEligibilityPat.tokenId } });
        await db.accountIdentity.update({
            where: { id: identity.id },
            data: { eligibilityStatus: "eligible" },
        });

        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "authentication_required" });
        await db.account.update({ where: { id: account.id }, data: { status: "active" } });

        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "account_automation" },
        }))).resolves.toEqual({
            status: "satisfied",
            matched: { kind: "team_connection", connectionId: connection.id },
        });

        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { encryptedSecrets: new Uint8Array([1, 2, 3]) },
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "authentication_required" });
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: {
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", provider.id, "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "secret" }),
                ),
            },
        });

        for (const teamProviderPolicy of [
            { v: 1, allowedTeamProviderKinds: [], teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [] },
            { v: 999 },
        ]) {
            await db.homeGovernancePolicy.upsert({
                where: { id: "home" },
                create: { id: "home", teamProviderPolicy },
                update: { teamProviderPolicy },
            });
            await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
                env: managedEnv,
                team: restrictedTeam,
                accountId: account.id,
                verifiedCredentialEvidence: evidence,
                operationContext: { kind: "present_user" },
            }))).resolves.toMatchObject({ status: "unavailable" });
        }
        await db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });

        await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "owner" },
        });
        await expect(inTx((tx) => setTeamPolicyInTx(tx, {
            actorAccountId: account.id,
            teamId: team.id,
            env: managedEnv,
            previousAuthenticationPolicy: restrictedPolicy,
            authenticationPolicy: null,
            authentication: {
                authenticationEvidence: [{ ...evidence[0], runtimeFingerprint: "stale-fingerprint" }],
                authenticationAuthority: "present_user",
            },
        }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        await expect(inTx((tx) => setTeamPolicyInTx(tx, {
            actorAccountId: account.id,
            teamId: team.id,
            env: managedEnv,
            previousAuthenticationPolicy: restrictedPolicy,
            authenticationPolicy: null,
            authentication: {
                authenticationEvidence: evidence,
                authenticationAuthority: "present_user",
            },
        }))).resolves.toMatchObject({ ok: true });

        await db.accountIdentity.delete({ where: { id: identity.id } });
        await db.accountIdentity.create({
            data: { accountId: account.id, provider: provider.id, providerUserId: "subject" },
        });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: managedEnv,
            team: restrictedTeam,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "authentication_required" });
    });

    it("invalidates native Home-method evidence when the owning Account is inactive", async () => {
        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" },
        });
        const team = await db.team.create({
            data: {
                name: "Native credential Team",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
            select: { id: true, authenticationPolicy: true },
        });
        const evidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];
        const env = { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" };

        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env,
            team,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toMatchObject({ status: "satisfied" });

        await db.account.update({ where: { id: account.id }, data: { status: "suspended" } });
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env,
            team,
            accountId: account.id,
            verifiedCredentialEvidence: evidence,
            operationContext: { kind: "present_user" },
        }))).resolves.toEqual({
            status: "authentication_required",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        });
    });

    it("batch-qualifies mixed inherited, restricted, disabled, and malformed Team policies", async () => {
        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" },
        });
        const teams = [
            { id: "batch-inherit", authenticationPolicy: null },
            {
                id: "batch-restricted-current",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
            {
                id: "batch-restricted-disabled",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            },
            { id: "batch-malformed", authenticationPolicy: { v: 99, mode: "restricted" } },
        ];
        const env = {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "0",
        };
        const current = await inTx((tx) => qualifyTeamAuthenticationsInTx(tx, {
            env,
            teams,
            accountId: account.id,
            verifiedCredentialEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            operationContext: { kind: "present_user" },
        }));
        expect(current.get("batch-inherit")).toEqual({ status: "satisfied", matched: null });
        expect(current.get("batch-restricted-current")).toEqual({
            status: "satisfied",
            matched: { kind: "home_method", methodId: "key_challenge" },
        });
        expect(current.get("batch-restricted-disabled")).toEqual({ status: "unavailable" });
        expect(current.get("batch-malformed")).toEqual({ status: "unavailable" });

        const missingEvidence = await inTx((tx) => qualifyTeamAuthenticationsInTx(tx, {
            env,
            teams: [teams[1]!],
            accountId: account.id,
            verifiedCredentialEvidence: [],
            operationContext: { kind: "present_user" },
        }));
        expect(missingEvidence.get("batch-restricted-current")).toEqual({
            status: "authentication_required",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        });
    });

    it("keeps inherited policy satisfied without manufacturing authentication evidence", async () => {
        await expect(inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
            env: {},
            team: { id: "team", authenticationPolicy: null },
            accountId: "account",
            verifiedCredentialEvidence: undefined,
            operationContext: { kind: "account_automation" },
        }))).resolves.toEqual({ status: "satisfied", matched: null });
    });
});
