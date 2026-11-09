import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const randomUUID = vi.hoisted(() => vi.fn<() => `${string}-${string}-${string}-${string}-${string}`>());
vi.mock("node:crypto", async (importOriginal) => ({
    ...await importOriginal<typeof import("node:crypto")>(),
    randomUUID,
}));

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";

import {
    createIdentityProviderInstanceInTx,
    readIdentityProviderInstancePresentationByIdInTx,
    readIdentityProviderRuntimeFactsByIdsInTx,
    recordIdentityProviderInstanceSuccessfulTestInTx,
    replaceIdentityProviderSecretsInTx,
    resolveIdentityProviderInstanceRuntimeInTx,
    resolveIdentityProviderRuntimeForOwner,
    setIdentityProviderInstanceEnabledInTx,
    updateIdentityProviderInstanceInTx,
} from "./identityProviderInstanceLifecycle";

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
        tempDirPrefix: "happier-provider-instance-lifecycle-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    randomUUID.mockReset();
    await db.accountChange.deleteMany({});
    await db.accountIdentity.deleteMany({});
    await db.identityProviderInstance.deleteMany({});
    await db.gitHubAppInstallation.deleteMany({});
    await db.gitHubAppRegistration.deleteMany({});
    await db.team.deleteMany({});
});

async function createGitHubInstallation(ownerTeamId: string | null, suffix: number): Promise<string> {
    const registration = await db.gitHubAppRegistration.create({
        data: {
            ownerTeamId,
            githubHost: "https://github.com",
            githubAppId: BigInt(100 + suffix),
            githubClientId: `Iv1.${suffix}`,
            config: { v: 1 },
            encryptedSecrets: Uint8Array.from([suffix]),
        },
    });
    return (await db.gitHubAppInstallation.create({
        data: {
            registrationId: registration.id,
            githubInstallationId: BigInt(200 + suffix),
            githubOrganizationId: BigInt(300 + suffix),
            githubOrganizationLogin: `organization-${suffix}`,
            repositorySelection: "all",
            state: "verified",
        },
        select: { id: true },
    })).id;
}

describe("managed identity-provider instance creation", () => {
    it("keeps scalar and set runtime admission identical across owner, disabled, corrupt and revised rows", async () => {
        const id = "11111111-1111-4111-8111-111111111111" as const;
        const team = await db.team.create({ data: { name: "Runtime owner" } });
        const teamOwner = { kind: "team", teamId: team.id } as const;
        randomUUID.mockReturnValueOnce(id);
        expect(await inTx(tx => createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" }, kind: "oidc", displayName: "Runtime parity", config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" }, createdByAccountId: null,
        }))).toMatchObject({ status: "created" });
        const compare = (requestedOwner: ProviderCatalogContext = { kind: "home" }) => inTx(async tx => {
            const facts = await readIdentityProviderRuntimeFactsByIdsInTx(tx, { ids: [id, "missing"] });
            for (const owner of [{ kind: "home" } as const, teamOwner, { kind: "team", teamId: "other-team" } as const]) {
                for (const includeDisabled of [false, true]) {
                    for (const providerId of [id, "missing"]) {
                        const scalar = await resolveIdentityProviderInstanceRuntimeInTx(tx, { id: providerId, owner, includeDisabled });
                        expect(resolveIdentityProviderRuntimeForOwner(facts.get(providerId), owner, includeDisabled)).toEqual(scalar);
                    }
                }
            }
            return resolveIdentityProviderRuntimeForOwner(facts.get(id), requestedOwner);
        });
        expect(await compare()).toEqual({ status: "disabled" });
        await db.identityProviderInstance.update({ where: { id }, data: { enabled: true } });
        expect(await compare()).toMatchObject({ status: "ready", instance: { securityRevision: 1, revision: 1 } });
        await db.identityProviderInstance.update({ where: { id }, data: {
            securityRevision: { increment: 1 }, revision: { increment: 1 }, config: { ...config, clientId: "revised" },
        } });
        expect(await compare()).toMatchObject({ status: "ready", instance: { securityRevision: 2, revision: 2, config: { clientId: "revised" } } });
        await db.identityProviderInstance.update({ where: { id }, data: { ownerTeamId: team.id } });
        expect(await compare(teamOwner)).toMatchObject({ status: "ready", instance: { owner: teamOwner } });
        expect(await compare()).toEqual({ status: "not_found" });
        await db.identityProviderInstance.update({ where: { id }, data: { encryptedSecrets: Uint8Array.from([1, 2, 3]) } });
        expect(await compare(teamOwner)).toEqual({ status: "unreadable" });
        await db.identityProviderInstance.update({ where: { id }, data: { enabled: false } });
        expect(await compare(teamOwner)).toEqual({ status: "disabled" });
        await db.identityProviderInstance.update({ where: { id }, data: { config: { v: 1, kind: "oidc" } } });
        expect(await compare(teamOwner)).toEqual({ status: "disabled" });
    });

    it("invalidates every linked Account when provider presentation or currentness changes", async () => {
        const id = "11111111-1111-4111-8111-111111111111" as const;
        randomUUID.mockReturnValueOnce(id);
        const created = await inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "oidc",
            displayName: "Managed",
            config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" },
            createdByAccountId: null,
        }));
        expect(created).toMatchObject({ status: "created" });
        const account = await db.account.create({ data: { publicKey: "provider-presentation-account" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: id,
                providerUserId: "exact-subject",
                providerLogin: "alice",
                profile: { sub: "exact-subject" },
            },
        });

        const updated = await inTx(async (tx) => await updateIdentityProviderInstanceInTx(tx, {
            id,
            owner: { kind: "home" },
            expectedRevision: 1,
            displayName: "Renamed provider",
        }));
        expect(updated).toMatchObject({ status: "applied", instance: { revision: 2 } });
        await expect(db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "linked-identities" } },
        })).resolves.toMatchObject({ cursor: 1 });

        const replaced = await inTx(async (tx) => await replaceIdentityProviderSecretsInTx(tx, {
            id,
            owner: { kind: "home" },
            expectedRevision: 2,
            secrets: { v: 1, kind: "oidc", clientSecret: "replacement-secret" },
        }));
        expect(replaced).toMatchObject({ status: "applied", instance: { revision: 3, securityRevision: 2 } });
        await expect(db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "linked-identities" } },
        })).resolves.toMatchObject({ cursor: 2 });

        const enabled = await inTx(async (tx) => await setIdentityProviderInstanceEnabledInTx(tx, {
            id,
            owner: { kind: "home" },
            expectedRevision: 3,
            expectedSecurityRevision: 2,
            enabled: true,
        }));
        expect(enabled).toMatchObject({ status: "applied", instance: { revision: 4, securityRevision: 3, enabled: true } });
        await expect(db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "linked-identities" } },
        })).resolves.toMatchObject({ cursor: 3 });

        await expect(inTx(async (tx) => await updateIdentityProviderInstanceInTx(tx, {
            id,
            owner: { kind: "home" },
            expectedRevision: 3,
            displayName: "Stale rename",
        }))).resolves.toMatchObject({ status: "revision_conflict" });
        await expect(db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "linked-identities" } },
        })).resolves.toMatchObject({ cursor: 3 });
    });

    it("rejects a display name beyond the portable provider label bound", async () => {
        await expect(inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "oidc",
            displayName: "x".repeat(257),
            config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" },
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(db.identityProviderInstance.count()).resolves.toBe(0);
    });

    it("records a successful test only for the exact owner and current security revision", async () => {
        const id = "11111111-1111-4111-8111-111111111111" as const;
        randomUUID.mockReturnValueOnce(id);
        const created = await inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "oidc",
            displayName: "Managed",
            config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" },
            createdByAccountId: null,
        }));
        expect(created).toMatchObject({ status: "created" });

        const testedAt = new Date("2026-09-06T01:02:03.000Z");
        await expect(inTx(async (tx) => await recordIdentityProviderInstanceSuccessfulTestInTx(tx, {
            id,
            owner: { kind: "team", teamId: "other-team" },
            securityRevision: 1,
            runtimeFingerprint: "managed-oidc:v1:wrong-owner",
            testedAt,
        }))).resolves.toEqual({ status: "not_found" });
        await expect(inTx(async (tx) => await recordIdentityProviderInstanceSuccessfulTestInTx(tx, {
            id,
            owner: { kind: "home" },
            securityRevision: 2,
            runtimeFingerprint: "managed-oidc:v1:stale",
            testedAt,
        }))).resolves.toEqual({ status: "configuration_changed" });

        await expect(inTx(async (tx) => await recordIdentityProviderInstanceSuccessfulTestInTx(tx, {
            id,
            owner: { kind: "home" },
            securityRevision: 1,
            runtimeFingerprint: "managed-oidc:v1:exact",
            testedAt,
        }))).resolves.toMatchObject({
            status: "applied",
            instance: {
                revision: 1,
                securityRevision: 1,
                lastSuccessfulTest: {
                    testedAt,
                    runtimeFingerprint: "managed-oidc:v1:exact",
                    securityRevision: 1,
                },
            },
        });
    });

    it("reads one exact instance through the non-secret presentation projection", async () => {
        const id = "11111111-1111-4111-8111-111111111111" as const;
        randomUUID.mockReturnValueOnce(id);
        const created = await inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "oidc",
            displayName: "Managed",
            config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" },
            createdByAccountId: null,
        }));
        expect(created).toMatchObject({ status: "created" });

        await expect(inTx(async (tx) => await readIdentityProviderInstancePresentationByIdInTx(tx, { id })))
            .resolves.toMatchObject({
                status: "ready",
                instance: {
                    id,
                    owner: { kind: "home" },
                    displayName: "Managed",
                    revision: 1,
                    securityRevision: 1,
                    config: { kind: "oidc", ui: { iconHint: "oidc" } },
                },
            });
        await expect(inTx(async (tx) => await readIdentityProviderInstancePresentationByIdInTx(tx, { id: "missing" })))
            .resolves.toEqual({ status: "not_found" });
    });

    it("does not allocate an ID reserved by the deployment provider namespace", async () => {
        const reserved = "11111111-1111-4111-8111-111111111111" as const;
        const allocated = "22222222-2222-4222-8222-222222222222" as const;
        randomUUID.mockReturnValueOnce(reserved).mockReturnValueOnce(allocated);
        const env = {
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                id: reserved,
                type: "oidc",
                displayName: "Deployment",
                issuer: "https://deployment.example.test",
                clientId: "client",
                clientAuthenticationMethod: "client_secret_post",
                clientSecret: "secret",
                redirectUrl: `https://home.example.test/v1/oauth/${reserved}/callback`,
            }]),
        };
        const result = await inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            env,
            owner: { kind: "home" },
            kind: "oidc",
            displayName: "Managed",
            config,
            secrets: { v: 1, kind: "oidc", clientSecret: "managed-secret" },
            createdByAccountId: null,
        }));
        expect(result).toMatchObject({ status: "created", instance: { id: allocated } });
    });

    it("rejects a GitHub identity instance before persistence unless its installation exists", async () => {
        await expect(inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "github_app_identity",
            displayName: "GitHub Enterprise",
            config: { v: 1, kind: "github_app_identity" },
            secrets: null,
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "github_app_identity",
            displayName: "GitHub Enterprise",
            config: { v: 1, kind: "github_app_identity" },
            secrets: null,
            githubAppInstallationId: "missing-installation",
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(db.identityProviderInstance.count()).resolves.toBe(0);
    });

    it("rejects GitHub App installations outside the provider owner's eligible scope", async () => {
        const team = await db.team.create({ data: { name: "Managed identity" }, select: { id: true } });
        const otherTeam = await db.team.create({ data: { name: "Other managed identity" }, select: { id: true } });
        const teamInstallationId = await createGitHubInstallation(team.id, 1);
        const otherTeamInstallationId = await createGitHubInstallation(otherTeam.id, 2);

        await expect(inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "home" },
            kind: "github_app_identity",
            displayName: "Team-owned GitHub",
            config: { v: 1, kind: "github_app_identity" },
            secrets: null,
            githubAppInstallationId: teamInstallationId,
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
            owner: { kind: "team", teamId: team.id },
            kind: "github_app_identity",
            displayName: "Other Team GitHub",
            config: { v: 1, kind: "github_app_identity" },
            secrets: null,
            githubAppInstallationId: otherTeamInstallationId,
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(db.identityProviderInstance.count()).resolves.toBe(0);
    });

    it("accepts Home-owned installations for Home or Team providers and same-Team installations", async () => {
        const team = await db.team.create({ data: { name: "Managed identity" }, select: { id: true } });
        const homeInstallationId = await createGitHubInstallation(null, 3);
        const teamInstallationId = await createGitHubInstallation(team.id, 4);
        randomUUID
            .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
            .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
            .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");

        const create = (owner: { kind: "home" } | { kind: "team"; teamId: string }, installationId: string) =>
            inTx(async (tx) => await createIdentityProviderInstanceInTx(tx, {
                owner,
                kind: "github_app_identity",
                displayName: "GitHub",
                config: { v: 1, kind: "github_app_identity" },
                secrets: null,
                githubAppInstallationId: installationId,
                createdByAccountId: null,
            }));

        await expect(create({ kind: "home" }, homeInstallationId)).resolves.toMatchObject({ status: "created" });
        await expect(create({ kind: "team", teamId: team.id }, homeInstallationId)).resolves.toMatchObject({ status: "created" });
        await expect(create({ kind: "team", teamId: team.id }, teamInstallationId)).resolves.toMatchObject({ status: "created" });
    });
});
