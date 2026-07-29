import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    stringifyConnectedServiceAuthGroupPolicy,
} from "../connect/connectedServicesV3/authGroupPolicy";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "../connect/testkit/qualifiedConnectedAccountFixtureIdentity";
import {
    mutateQualifiedConnectedServiceCredential,
} from "../connect/qualifiedConnectedAccounts/credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
} from "../connect/qualifiedConnectedAccounts/groupRepository";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../connect/qualifiedConnectedAccounts/identity";

describe("Account profile (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-profile-", initAuth: false });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("GET /v1/account/profile returns linkedProviders derived from AccountIdentity", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-gh" },
                    select: { id: true },
                });

                const githubProfile = { id: 123, login: "octocat", avatar_url: "x", name: "Octo Cat" };
                await db.accountIdentity.create({
                    data: {
                        accountId: account.id,
                        provider: "github",
                        providerUserId: "123",
                        providerLogin: "octocat",
                        profile: githubProfile as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.github).toBeUndefined();
                expect(body.linkedProviders).toEqual([
                    {
                        id: "github",
                        login: "octocat",
                        displayName: "Octo Cat",
                        avatarUrl: "x",
                        profileUrl: "https://github.com/octocat",
                        showOnProfile: true,
                    },
                ]);
            },
        );
    });

    it("projects historical Gemini OAuth as needs_reauth without changing its legacy kind", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: {
                        publicKey: null,
                        encryptionMode: "plain",
                    },
                    select: { id: true },
                });
                const legacy =
                    resolveLegacyServiceAccountTokenIdentityFields({
                        serviceId: "gemini",
                        profileId: "old-oauth",
                        credentialKind: "oauth",
                    });
                await expect(
                    mutateQualifiedConnectedServiceCredential({
                        accountId: account.id,
                        ref: {
                            service: {
                                pluginId: legacy.servicePluginId,
                                localId: legacy.serviceLocalId,
                            },
                            accountId: legacy.connectedAccountId,
                        },
                        expectedCredentialRevision: null,
                        authenticationModeId:
                            legacy.authenticationModeId,
                        content: {
                            t: "plain",
                            v: { oauth: "historical" },
                        },
                        metadata: { scopes: [] },
                        legacyIdentity: {
                            serviceId: "gemini",
                            profileId: "old-oauth",
                        },
                    }),
                ).resolves.toMatchObject({ status: "written" });

                const response = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.connectedServicesV2).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            serviceId: "gemini",
                            profiles: expect.arrayContaining([
                                expect.objectContaining({
                                    profileId: "old-oauth",
                                    kind: "oauth",
                                    status: "needs_reauth",
                                }),
                            ]),
                        }),
                    ]),
                );
                expect(body.connectedAccountsV4).toEqual([
                    expect.objectContaining({
                        authenticationModeId: null,
                        status: "needs_reauth",
                    }),
                ]);
                expect(JSON.stringify(body)).not.toContain(
                    "legacy-oauth-unsupported",
                );
            },
        );
    });

    it("GET /v1/account/profile includes connectedServicesV2 with per-profile status", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2" },
                    select: { id: true },
                });

                // Legacy token (v1) stored under the same service id but without v2 metadata.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "anthropic",
                        profileId: "default",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "anthropic",
                            profileId: "default",
                        }),
                        token: Buffer.from("legacy", "utf8"),
                        metadata: null,
                    },
                });

                // Sealed v2 record (ciphertext bytes + v2 metadata only; server never decrypts).
                const workCredential = await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "work",
                            credentialKind: "oauth",
                        }),
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: {
                            v: 2,
                            format: "account_scoped_v1",
                            kind: "oauth",
                            credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
                            providerEmail: "user@example.com",
                            health: {
                                v: 1,
                                status: "needs_reauth",
                                reconnectRequired: true,
                                lastRefreshFailureKind: "invalid_grant",
                                lastRefreshFailureAt: 2,
                            },
                        } as any,
                        expiresAt: new Date(Date.now() + 3600_000),
                    },
                });
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "legacy-v2-no-revision",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "legacy-v2-no-revision",
                            credentialKind: "oauth",
                        }),
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: {
                            v: 2,
                            format: "account_scoped_v1",
                            kind: "oauth",
                        },
                    },
                });
                const group = await db.connectedServiceAuthGroup.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        ...createLegacyGroupFixtureIdentity({
                            serviceId: "openai-codex",
                            groupId: "codex-main",
                        }),
                        displayName: "Codex Main",
                        activeProfileId: "work",
                        generation: 3,
                        policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "work",
                        ...createLegacyGroupMemberFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "work",
                            groupId: "codex-main",
                            credentialId: workCredential.id,
                            credentialKind: "oauth",
                        }),
                        priority: 10,
                    },
                });

                // Plain/v3 credential rows are also account-level connected services.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "github",
                        profileId: "personal",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "github",
                            profileId: "personal",
                            credentialKind: "token",
                        }),
                        token: Buffer.from("{}", "utf8"),
                        metadata: {
                            v: 3,
                            storage: "plain_json_v1",
                            kind: "oauth",
                            providerEmail: "plain@example.com",
                            providerAccountId: "github-plain-account",
                        } as any,
                    },
                });

                // Legacy token (v1) stored under the same service id but without v2 metadata.
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai",
                            profileId: "default",
                        }),
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(Array.isArray(body.connectedServicesV2)).toBe(true);
                expect(body.connectedServiceCredentialRevisionsV1).toEqual([{
                    serviceId: "openai-codex",
                    profileId: "work",
                    credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
                }]);
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        profiles: expect.arrayContaining([
                            expect.objectContaining({
                                profileId: "work",
                                status: "needs_reauth",
                                providerEmail: "user@example.com",
                                health: expect.objectContaining({
                                    status: "needs_reauth",
                                    reconnectRequired: true,
                                    lastRefreshFailureKind: "invalid_grant",
                                }),
                            }),
                        ]),
                        groups: [
                            {
                                groupId: "codex-main",
                                displayName: "Codex Main",
                                activeProfileId: "work",
                                generation: 3,
                                memberProfileIds: ["work"],
                            },
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "github",
                        profiles: [
                            expect.objectContaining({
                                profileId: "personal",
                                status: "connected",
                                kind: "token",
                                providerEmail: "plain@example.com",
                                providerAccountId: "github-plain-account",
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "openai",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                                status: "needs_reauth",
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        serviceId: "anthropic",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                                status: "needs_reauth",
                            }),
                        ],
                    }),
                ]));
            },
        );
    });

    it("GET /v1/account/profile clears impossible auth-group activeProfileId values from the synced projection", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-disabled-active" },
                    select: { id: true },
                });

                const workCredential = await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "work",
                            credentialKind: "oauth",
                        }),
                        token: Buffer.from("work", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });
                const disabledCredential = await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "disabled-backup",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "disabled-backup",
                            credentialKind: "oauth",
                        }),
                        token: Buffer.from("backup", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });

                const group = await db.connectedServiceAuthGroup.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        ...createLegacyGroupFixtureIdentity({
                            serviceId: "openai-codex",
                            groupId: "codex-main",
                        }),
                        activeProfileId: "disabled-backup",
                        generation: 4,
                        policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "work",
                        ...createLegacyGroupMemberFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "work",
                            groupId: "codex-main",
                            credentialId: workCredential.id,
                            credentialKind: "oauth",
                        }),
                        priority: 10,
                    },
                });
                await db.connectedServiceAuthGroupMember.create({
                    data: {
                        groupDbId: group.id,
                        accountId: account.id,
                        vendor: "openai-codex",
                        groupId: "codex-main",
                        profileId: "disabled-backup",
                        ...createLegacyGroupMemberFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "disabled-backup",
                            groupId: "codex-main",
                            credentialId: disabledCredential.id,
                            credentialKind: "oauth",
                        }),
                        priority: 20,
                        enabled: false,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        groups: [
                            {
                                groupId: "codex-main",
                                displayName: null,
                                activeProfileId: null,
                                generation: 4,
                                memberProfileIds: ["work"],
                            },
                        ],
                    }),
                ]));
            },
        );
    });

    it("projects legacy account fields from the canonical qualified identity", async () => {
        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-canonical-identity" },
                    select: { id: true },
                });
                const qualifiedIdentity =
                    resolveLegacyServiceAccountTokenIdentityFields({
                        serviceId: "anthropic",
                        profileId: "default",
                    });
                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        ...qualifiedIdentity,
                        token: Buffer.from("legacy-anthropic", "utf8"),
                        metadata: null,
                    },
                });

                const response = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({
                    connectedServices: ["anthropic"],
                    connectedServicesV2: [{
                        serviceId: "anthropic",
                        profiles: [
                            expect.objectContaining({
                                profileId: "default",
                            }),
                        ],
                        groups: [],
                    }],
                    connectedAccountsV4: [
                        expect.objectContaining({
                            ref: {
                                service: {
                                    pluginId:
                                        qualifiedIdentity.servicePluginId,
                                    localId:
                                        qualifiedIdentity.serviceLocalId,
                                },
                                accountId: "default",
                            },
                        }),
                    ],
                });
            },
        );
    });

    it("GET /v1/account/profile keeps Connected Accounts projected when the retired master env is off", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0" });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: { publicKey: "pk-profile-csv2-disabled" },
                    select: { id: true },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai",
                        profileId: "default",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai",
                            profileId: "default",
                        }),
                        token: Buffer.from("legacy-openai", "utf8"),
                        metadata: null,
                    },
                });

                await db.serviceAccountToken.create({
                    data: {
                        accountId: account.id,
                        vendor: "openai-codex",
                        profileId: "work",
                        ...createLegacyCredentialFixtureIdentity({
                            serviceId: "openai-codex",
                            profileId: "work",
                            credentialKind: "oauth",
                        }),
                        token: Buffer.from("c2VhbGVk", "utf8"),
                        metadata: { v: 2, format: "account_scoped_v1", kind: "oauth" } as any,
                    },
                });

                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                const body = res.json() as any;
                expect(body.connectedServices).toEqual(expect.arrayContaining(["openai"]));
                expect(body.connectedServicesV2).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        serviceId: "openai",
                        profiles: expect.arrayContaining([
                            expect.objectContaining({ profileId: "default" }),
                        ]),
                    }),
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        profiles: expect.arrayContaining([
                            expect.objectContaining({ profileId: "work" }),
                        ]),
                    }),
                ]));
            },
        );
    });

    it("GET /v1/account/profile keeps V4 groups visible while legacy group projection is disabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: "0",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const account = await db.account.create({
                    data: {
                        publicKey: null,
                        encryptionMode: "plain",
                    },
                    select: { id: true },
                });
                const identity =
                    resolveLegacyServiceAccountTokenIdentityFields({
                        serviceId: "openai-codex",
                        profileId: "work",
                        credentialKind: "oauth",
                    });
                const service = {
                    pluginId: identity.servicePluginId,
                    localId: identity.serviceLocalId,
                };
                const credential =
                    await mutateQualifiedConnectedServiceCredential({
                        accountId: account.id,
                        ref: {
                            service,
                            accountId: identity.connectedAccountId,
                        },
                        expectedCredentialRevision: null,
                        authenticationModeId:
                            identity.authenticationModeId,
                        content: {
                            t: "plain",
                            v: { accessToken: "credential" },
                        },
                        metadata: { scopes: [] },
                    });
                expect(credential.status).toBe("written");
                const group =
                    await createQualifiedConnectedAccountGroup({
                        accountId: account.id,
                        service,
                        group: {
                            groupId: "codex-main",
                            displayName: "Codex Main",
                        },
                        initialMembers: [{
                            connectedAccountId:
                                identity.connectedAccountId,
                        }],
                        activeConnectedAccountId:
                            identity.connectedAccountId,
                    });
                expect(group.status).toBe("written");

                const response = await app.inject({
                    method: "GET",
                    url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.connectedServicesV2).toEqual([
                    expect.objectContaining({
                        serviceId: "openai-codex",
                        groups: [],
                    }),
                ]);
                expect(body.connectedAccountGroupsV4).toEqual([
                    expect.objectContaining({
                        ref: {
                            service,
                            groupId: "codex-main",
                        },
                        activeConnectedAccountId:
                            identity.connectedAccountId,
                        members: [
                            expect.objectContaining({
                                connectedAccountId:
                                    identity.connectedAccountId,
                            }),
                        ],
                    }),
                ]);
            },
        );
    });
});
