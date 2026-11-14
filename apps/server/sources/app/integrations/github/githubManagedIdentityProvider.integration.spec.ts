import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
    app: vi.fn(),
    appRequest: vi.fn(),
    octokit: vi.fn(),
    defaults: vi.fn(),
    installationRequest: vi.fn(),
}));

vi.mock("octokit", () => ({
    App: github.app,
    Octokit: Object.assign(github.octokit, { defaults: github.defaults }),
}));

import { Context } from "@/context";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { encryptGitHubAppRegistrationSecretsV1 } from "./githubManagedApp";
import {
    createManagedGitHubIdentityProviderModule,
    resolveManagedGitHubIdentityProviderRuntimeMetadataInTx,
    resolveManagedGitHubIdentityProviderModuleInTx,
} from "./githubManagedIdentityProvider";

const networkPolicy = {
    address: { kind: "publicOnly" as const },
    allowedPorts: [443],
    allowLoopbackHttp: false,
    maxResponseBytes: 1024 * 1024,
    maxHeaderBytes: 32 * 1024,
    timeoutMs: 30_000,
};

describe("managed GitHub identity provider", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-managed-github-identity-",
            initAuth: false,
            initEncrypt: true,
        });
        github.defaults.mockReturnValue(github.octokit);
        github.app.mockImplementation(() => ({ octokit: { request: github.appRequest } }));
        github.octokit.mockImplementation(() => ({ request: github.installationRequest }));
    });
    afterAll(async () => await harness.close());

    it("admits the exact organization user, discards the user token, and refreshes mapped Groups", async () => {
        const account = await db.account.create({ data: { publicKey: "managed-github-user", status: "active" } });
        const team = await db.team.create({ data: { name: "Managed GitHub Team" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "member" },
        });
        const registration = await db.gitHubAppRegistration.create({
            data: {
                ownerTeamId: team.id,
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.identity",
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
                encryptedSecrets: Uint8Array.from([1]),
                state: "verified",
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 301n,
                githubOrganizationId: 401n,
                githubOrganizationLogin: "Acme",
                repositorySelection: "all",
                state: "verified",
                verifiedPermissions: { members: "read" },
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "github_app_identity",
                displayName: "Acme GitHub",
                enabled: true,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
                settings: { v: 1, kind: "github_app_identity", organizationLogin: "Acme" },
                enabled: true,
            },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering") },
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: group.id,
                teamIdentityConnectionId: connection.id,
                externalGroupId: "501",
                bindingMode: "native_target",
            },
        });
        const module = createManagedGitHubIdentityProviderModule({
            providerId: provider.id,
            callbackProviderId: "github-app",
            displayName: provider.displayName,
            context: { kind: "team", teamId: team.id },
            connectionId: connection.id,
            githubHost: registration.githubHost,
            githubAppId: registration.githubAppId,
            githubClientId: registration.githubClientId,
            clientSecret: "client-secret",
            privateKey: "private-key",
            githubInstallationId: installation.githubInstallationId,
            githubAppInstallationRecordId: installation.id,
            githubOrganizationId: installation.githubOrganizationId,
            githubOrganizationLogin: installation.githubOrganizationLogin,
            redirectUrl: `https://home.example.test/v1/oauth/${provider.id}/callback`,
            networkPolicy,
        });
        expect(module.oauth?.callbackProviderId).toBe("github-app");
        github.appRequest.mockResolvedValue({ data: { token: "installation-token" } });
        github.installationRequest
            .mockResolvedValueOnce({ data: { state: "active", role: "member", user: { id: 42 } } })
            .mockResolvedValueOnce({ data: { state: "active", role: "member" } });

        const prepared = await module.identity!.prepareConnect({
            ctx: Context.create(account.id),
            profile: { id: 42, login: "Octocat" },
            accessToken: "ephemeral-user-token",
            refreshToken: "ephemeral-refresh-token",
        });
        await inTx(prepared.connectInTx);

        await expect(db.accountIdentity.findFirst({
            where: { accountId: account.id, provider: provider.id },
            select: { providerUserId: true, providerLogin: true, token: true },
        })).resolves.toEqual({ providerUserId: "42", providerLogin: "octocat", token: null });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: group.id,
                    teamMembershipId: membership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.not.toBeNull();
    });

    it("resolves a live module only from verified canonical installation state and fingerprints every security owner", async () => {
        const registrationId = "managed-github-registration-resolver";
        const registration = await db.gitHubAppRegistration.create({
            data: {
                id: registrationId,
                githubHost: "https://github.com",
                githubAppId: 144n,
                githubClientId: "Iv1.resolver",
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
                securityRevision: 4,
                lastVerifiedAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 1301n,
                githubOrganizationId: 1401n,
                githubOrganizationLogin: "Resolver",
                repositorySelection: "all",
                state: "verified",
                revision: 5,
                verifiedPermissions: { members: "read" },
                lastVerifiedAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const providerRow = await db.identityProviderInstance.create({
            data: {
                kind: "github_app_identity",
                displayName: "Resolver GitHub",
                enabled: true,
                securityRevision: 3,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        const provider = {
            id: providerRow.id,
            owner: { kind: "home" as const },
            kind: "github_app_identity" as const,
            displayName: providerRow.displayName,
            enabled: providerRow.enabled,
            firstEnabledAt: providerRow.firstEnabledAt,
            securityRevision: providerRow.securityRevision,
            revision: providerRow.revision,
            lastSuccessfulTest: null,
            config: { v: 1 as const, kind: "github_app_identity" as const },
            githubAppInstallationId: providerRow.githubAppInstallationId,
            createdByAccountId: providerRow.createdByAccountId,
            createdAt: providerRow.createdAt,
            updatedAt: providerRow.updatedAt,
        };

        const metadataInput = {
            env: {},
            context: { kind: "home" as const },
            provider,
            connectionId: null,
            connectionRevision: null,
        };
        await expect(inTx(async (tx) => await resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(
            tx,
            metadataInput,
        ))).resolves.toMatchObject({ runtimeFingerprint: expect.stringContaining(":3:4:5:") });

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
        await expect(inTx(async (tx) => await resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(
            tx,
            metadataInput,
        ))).resolves.toBeNull();
        await db.gitHubAppRegistration.update({
            where: { id: registration.id },
            data: {
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
            },
        });

        const resolved = await inTx(async (tx) => await resolveManagedGitHubIdentityProviderModuleInTx(tx, {
            env: {},
            context: { kind: "home" },
            provider,
            connectionId: null,
            connectionRevision: null,
            publicServerUrl: "https://home.example.test",
        }));
        expect(resolved?.module).toMatchObject({
            id: providerRow.id,
            oauth: { id: providerRow.id },
            identity: { id: providerRow.id },
            auth: { id: providerRow.id },
        });
        expect(resolved?.runtimeFingerprint).toContain(":3:4:5:");

        await db.gitHubAppInstallation.update({
            where: { id: installation.id },
            data: { suspendedAt: new Date(), state: "suspended" },
        });
        await expect(inTx(async (tx) => await resolveManagedGitHubIdentityProviderModuleInTx(tx, {
            env: {},
            context: { kind: "home" },
            provider,
            connectionId: null,
            connectionRevision: null,
            publicServerUrl: "https://home.example.test",
        }))).resolves.toBeNull();
    });
});
