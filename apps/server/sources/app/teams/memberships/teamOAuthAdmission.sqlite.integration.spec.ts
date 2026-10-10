import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx } from "@/storage/inTx";
import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";

import {
    finalizeTeamOAuthAdmissionInTx,
    requireTeamOAuthAdmissionInTx,
} from "./teamOAuthAdmission";
import {
    projectTeamMembershipManagementV1,
    TEAM_MEMBERSHIP_ROW_SELECT,
} from "./project";
import { provisionFreshAccountInTx } from "@/app/auth/provisionFreshAccountInTx";
import { isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { encryptString } from "@/modules/encrypt";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { digestTeamInvitationToken, mintTeamInvitationToken } from "@/app/teams/invitations/token";

describe("team OAuth admission continuation", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-oauth-admission-",
            initAuth: false,
            initEncrypt: true,
            initFiles: false,
        });
    });

    afterEach(async () => {
        await db.accountIdentity.deleteMany({});
        await db.teamMembership.deleteMany({});
        await db.teamProvisionedIdentity.deleteMany({});
        await db.teamDirectorySource.deleteMany({});
        await db.teamIdentityConnection.deleteMany({});
        await db.identityProviderInstance.deleteMany({});
        await db.team.deleteMany({});
        await db.account.deleteMany({});
        await db.homeGovernancePolicy.deleteMany({});
    });

    afterAll(async () => await harness.close());

    it.each(["builtin", "home_company"] as const)("requires an existing Account invitation through %s to remain current without consuming it", async (method) => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            AUTH_SIGNUP_PROVIDERS: "github",
            WORKOS_API_KEY: "sk_test",
            WORKOS_CLIENT_ID: "client_test",
        });
        const company = method === "home_company" ? await db.identityProviderInstance.create({ data: {
            ownerTeamId: null, kind: "workos_sso", displayName: "Company Home", enabled: true,
            firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } }) : null;
        const connection = company ? await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: company.id, enabled: true,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_home", connectionId: "conn_home" },
            settings: { v: 1, kind: "workos_sso" },
        } }) : null;
        const providerId = company?.id ?? "github";
        const provider = await resolveOAuthRuntimeById(process.env, providerId);
        expect(provider?.reference.context).toEqual({ kind: "home" });
        const account = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: providerId,
                providerUserId: "existing-invitation-user",
                providerLogin: "existing-invitation-user",
                profile: { id: 7100, login: "existing-invitation-user" },
            },
        });
        const team = await db.team.create({
            data: { name: "Explicit Join Team", admissionMode: "invite_only" },
        });
        const token = mintTeamInvitationToken();
        const tokenHash = new Uint8Array(digestTeamInvitationToken(token));
        const invitation = await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash,
                role: "member",
                historyAccess: "from_membership",
                expiresAt: new Date(Date.now() + 60_000),
            },
        });
        const admission = {
            kind: "team_invitation" as const,
            teamId: team.id,
            providerId,
            providerOrigin: "home" as const,
            connectionId: null,
            connectionRevision: null,
            admissionMode: "invite_only" as const,
            invitationId: invitation.id,
            tokenHash: Buffer.from(tokenHash).toString("hex"),
        };

        const result = await inTx((tx) => requireTeamOAuthAdmissionInTx(tx, {
            env: process.env,
            accountId: account.id,
            provider: provider!.reference,
            connection: connection ? { id: connection.id, revision: connection.revision } : null,
            admission,
        }));
        expect(result).toEqual({
            authenticationEvidence: [expect.objectContaining({ kind: "provider", providerId })],
            invitationRequired: true,
        });
        expect(result.authenticationEvidence[0]).not.toHaveProperty("teamConnectionId");
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
        await expect(db.teamInvitation.findUnique({ where: { id: invitation.id } }))
            .resolves.toMatchObject({ acceptedAt: null, acceptedByAccountId: null });

        await db.teamInvitation.update({
            where: { id: invitation.id },
            data: { revokedAt: new Date() },
        });
        await expect(inTx((tx) => requireTeamOAuthAdmissionInTx(tx, {
            env: process.env,
            accountId: account.id,
            provider: provider!.reference,
            connection: connection ? { id: connection.id, revision: connection.revision } : null,
            admission,
        }))).rejects.toMatchObject({ code: "team_authentication_required" });
        expect(await db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toBeNull();
    });

    it("rolls back a fresh Account when Teams becomes unavailable before OAuth finalization", async () => {
        const team = await db.team.create({ data: { name: "Disabled during OAuth", admissionMode: "invite_only" } });
        const accountId = crypto.randomUUID();

        await expect(inTx((tx) => provisionFreshAccountInTx(tx, {
            insertSemantics: { kind: "must_create", accountId },
            publicKey: crypto.randomUUID(),
            encryptionMode: "plain",
            teamOAuthAdmission: {
                env: { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" },
                provider: {
                    id: "github",
                    source: "deployment",
                    runtimeFingerprint: "deployment:github:test",
                    context: { kind: "home" },
                },
                connection: null,
                source: {
                    kind: "team_invitation",
                    teamId: team.id,
                    providerId: "github",
                    providerOrigin: "home",
                    connectionId: null,
                    connectionRevision: null,
                    admissionMode: "invite_only",
                    invitationId: crypto.randomUUID(),
                    tokenHash: "a".repeat(64),
                },
            },
        }))).rejects.toMatchObject({ code: "team_authentication_unavailable" });

        await expect(db.account.findUnique({ where: { id: accountId } })).resolves.toBeNull();
        await expect(db.teamMembership.count({ where: { teamId: team.id } })).resolves.toBe(0);
    });

    it("does not turn authentication into invite-only membership and admits JIT only when Home policy enables it", async () => {
        harness.resetEnv({ HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" });
        const team = await db.team.create({ data: { name: "Admission Team", admissionMode: "invite_only" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Admission SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                config: {
                    v: 1, kind: "oidc", issuer: "https://id.example.test", clientId: "client", clientAuthenticationMethod: "client_secret_post", scopes: "openid",
                    httpTimeoutSeconds: 30, claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: false, storeRefreshToken: false, ui: { buttonColor: null, iconHint: null },
                },
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
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            },
        });
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const invitationTokenHash = Buffer.from("a".repeat(64), "hex");
        const invitation = await db.teamInvitation.create({
            data: {
                teamId: team.id,
                tokenHash: invitationTokenHash,
                role: "member",
                historyAccess: "from_membership",
                expiresAt: new Date(Date.now() + 60_000),
            },
        });

        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: {
                kind: "team_invitation",
                teamId: team.id,
                providerId: provider.id,
                providerOrigin: "team",
                connectionId: connection.id,
                connectionRevision: connection.revision,
                admissionMode: "invite_only",
                invitationId: invitation.id,
                tokenHash: invitationTokenHash.toString("hex"),
            },
        }))).resolves.toEqual({ status: "invitation_required" });
        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: account.id } })).toBe(0);

        await db.team.update({ where: { id: team.id }, data: { admissionMode: "jit" } });
        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: null,
        }))).resolves.toEqual({ status: "admission_required" });

        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const contextualAdmission = {
            kind: "team_jit_identity" as const,
            teamId: team.id,
            providerId: provider.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            admissionMode: "jit" as const,
            authAttemptId: "oauth-state-attempt-1",
        };
        await expect(inTx((tx) => isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
            env: process.env,
            methodId: provider.id,
            actionId: "provision",
            mode: "keyed",
        }))).resolves.toBe(false);
        await expect(inTx((tx) => isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
            env: process.env,
            methodId: provider.id,
            actionId: "provision",
            mode: "keyed",
            admission: contextualAdmission,
        }))).resolves.toBe(true);
        await expect(inTx((tx) => isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
            env: process.env,
            methodId: provider.id,
            actionId: "provision",
            mode: "keyed",
            admission: { ...contextualAdmission, connectionId: "wrong-connection" },
        }))).resolves.toBe(false);
        for (const admission of [
            { ...contextualAdmission, teamId: "wrong-team" },
            { ...contextualAdmission, providerId: "wrong-provider" },
            {
                kind: "team_provisioned_identity" as const,
                teamId: team.id,
                providerId: provider.id,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                admissionMode: "provisioned" as const,
                provisionedIdentityId: "wrong-mode-identity",
            },
        ]) {
            await expect(inTx((tx) => isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env: process.env,
                methodId: provider.id,
                actionId: "provision",
                mode: "keyed",
                admission,
            }))).resolves.toBe(false);
        }
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { enabled: false } });
        await expect(inTx((tx) => isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
            env: process.env,
            methodId: provider.id,
            actionId: "provision",
            mode: "keyed",
            admission: contextualAdmission,
        }))).resolves.toBe(false);
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { enabled: true } });
        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: {
                kind: "team_jit_identity",
                teamId: team.id,
                providerId: provider.id,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                admissionMode: "jit",
                authAttemptId: "oauth-state-attempt-1",
            },
        }))).resolves.toMatchObject({ status: "admitted", outcome: "added" });
        const admittedMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
            select: TEAM_MEMBERSHIP_ROW_SELECT,
        });
        expect(projectTeamMembershipManagementV1(admittedMembership)).toEqual({
            kind: "identity_connection",
            identityConnectionId: connection.id,
            label: "Admission SSO",
        });

        await db.team.update({ where: { id: team.id }, data: { admissionMode: "invite_only" } });
        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: null,
        }))).resolves.toEqual({ status: "qualified_existing_member" });
        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: account.id } })).toBe(1);
    });

    it("admits only the exact live provisioning owner evidence", async () => {
        const team = await db.team.create({ data: { name: "Provisioned Team", admissionMode: "provisioned" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id,
            kind: "workos_sso",
            displayName: "Directory SSO",
            enabled: true,
            firstEnabledAt: new Date(),
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id,
            providerInstanceId: provider.id,
            enabled: true,
            firstEnabledAt: new Date(),
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org_provisioned",
                connectionId: "conn_provisioned",
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id,
            kind: "workos_directory",
            state: "active",
            displayName: "Directory",
            externalSourceKey: `workos:${team.id}`,
            bindingConfig: { v: 1, kind: "workos_directory" },
            teamIdentityConnectionId: connection.id,
        } });
        const identity = await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: source.id,
            teamId: team.id,
            externalUserId: "directory-user-1",
            externalSubjectId: "directory-user-1",
            state: "active",
        } });
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        await db.teamProvisionedIdentity.update({
            where: { id: identity.id },
            data: { boundAccountId: account.id },
        });
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

        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: {
                kind: "team_provisioned_identity",
                teamId: team.id,
                providerId: provider.id,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                admissionMode: "provisioned",
                provisionedIdentityId: identity.id,
            },
        }))).resolves.toEqual({ status: "admission_required" });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: identity.id } }))
            .resolves.toMatchObject({ boundAccountId: account.id, teamMembershipId: null });
        await expect(db.teamMembership.count({ where: { teamId: team.id, accountId: account.id } }))
            .resolves.toBe(0);
    });

    it("throws inside the caller transaction so denied Team admission rolls back identity and Account writes", async () => {
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
        const team = await db.team.create({ data: { name: "Atomic Team", admissionMode: "provisioned" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Atomic SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                config: {
                    v: 1, kind: "oidc", issuer: "https://id.example.test", clientId: "client", clientAuthenticationMethod: "client_secret_post", scopes: "openid",
                    httpTimeoutSeconds: 30, claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: false, storeRefreshToken: false, ui: { buttonColor: null, iconHint: null },
                },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date(),
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            },
        });
        const reference = await inTx(async (tx) => (await listProviderDescriptorsInTx(
            tx,
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            { kind: "team", teamId: team.id },
        )).find((item) => item.reference.id === provider.id)?.reference);
        expect(reference).toBeDefined();
        const accountId = crypto.randomUUID();

        await expect(inTx(async (tx) => {
            await provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: "must_create", accountId },
                publicKey: crypto.randomUUID(),
                encryptionMode: "plain",
                identityConnection: {
                    connectInTx: async (identityTx) => {
                        await identityTx.accountIdentity.create({
                            data: { accountId, provider: provider.id, providerUserId: "atomic-subject" },
                        });
                    },
                },
                teamOAuthAdmission: {
                    env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
                    provider: reference!,
                    connection: { id: connection.id, revision: connection.revision },
                    source: null,
                },
            });
        })).rejects.toMatchObject({ code: "team_authentication_required" });
        expect(await db.account.count({ where: { id: accountId } })).toBe(0);
        expect(await db.accountIdentity.count({ where: { accountId } })).toBe(0);
        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId } })).toBe(0);
    });

    it("admits provisioned membership when the exact active source and bound identity agree", async () => {
        const team = await db.team.create({ data: { name: "Provisioned Admit Team", admissionMode: "provisioned" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id,
            kind: "workos_sso",
            displayName: "Directory SSO",
            enabled: true,
            firstEnabledAt: new Date(),
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id,
            providerInstanceId: provider.id,
            enabled: true,
            firstEnabledAt: new Date(),
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org_admit",
                connectionId: "conn_admit",
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id,
            kind: "workos_directory",
            state: "active",
            displayName: "Directory",
            externalSourceKey: `workos:${team.id}:admit`,
            bindingConfig: { v: 1, kind: "workos_directory" },
            teamIdentityConnectionId: connection.id,
        } });
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const identity = await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: source.id,
            teamId: team.id,
            externalUserId: "directory-admit-1",
            externalSubjectId: "directory-admit-1",
            state: "active",
            boundAccountId: account.id,
        } });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });

        await expect(inTx((tx) => finalizeTeamOAuthAdmissionInTx(tx, {
            teamId: team.id,
            connectionId: connection.id,
            connectionRevision: connection.revision,
            providerInstanceId: provider.id,
            accountId: account.id,
            source: {
                kind: "team_provisioned_identity",
                teamId: team.id,
                providerId: provider.id,
                connectionId: connection.id,
                connectionRevision: connection.revision,
                admissionMode: "provisioned",
                provisionedIdentityId: identity.id,
            },
        }))).resolves.toEqual({ status: "admitted", outcome: "added" });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toMatchObject({ status: "active" });
    });

    it("rolls back fresh-Account JIT admission when the connection revision is stale", async () => {
        harness.resetEnv({ HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" });
        const team = await db.team.create({ data: { name: "Stale Revision Team", admissionMode: "jit" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Stale SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                config: {
                    v: 1, kind: "oidc", issuer: "https://id.example.test", clientId: "client", clientAuthenticationMethod: "client_secret_post", scopes: "openid",
                    httpTimeoutSeconds: 30, claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: false, storeRefreshToken: false, ui: { buttonColor: null, iconHint: null },
                },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date(),
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const reference = await inTx(async (tx) => (await listProviderDescriptorsInTx(
            tx,
            { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            { kind: "team", teamId: team.id },
        )).find((item) => item.reference.id === provider.id)?.reference);
        expect(reference).toBeDefined();
        const accountId = crypto.randomUUID();
        const staleRevision = connection.revision + 1;

        await expect(inTx(async (tx) => {
            await provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: "must_create", accountId },
                publicKey: crypto.randomUUID(),
                encryptionMode: "plain",
                identityConnection: {
                    connectInTx: async (identityTx) => {
                        await identityTx.accountIdentity.create({
                            data: { accountId, provider: provider.id, providerUserId: "stale-revision-subject" },
                        });
                    },
                },
                teamOAuthAdmission: {
                    env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
                    provider: reference!,
                    connection: { id: connection.id, revision: staleRevision },
                    source: {
                        kind: "team_jit_identity",
                        teamId: team.id,
                        providerId: provider.id,
                        connectionId: connection.id,
                        connectionRevision: staleRevision,
                        admissionMode: "jit",
                        authAttemptId: "oauth-state-attempt-stale",
                    },
                },
            });
        })).rejects.toMatchObject({ code: "team_authentication_unavailable" });
        expect(await db.account.count({ where: { id: accountId } })).toBe(0);
        expect(await db.accountIdentity.count({ where: { accountId } })).toBe(0);
        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId } })).toBe(0);
    });
});
