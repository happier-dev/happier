import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import {
    buildConnectedServiceCredentialRecord,
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    QualifiedConnectedAccountRefSchema,
    type ConnectedServiceCredentialRecordV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    createSignedAccountContentBinding,
} from "@/testkit/accountEncryption";
import {
    buildAccountConnectedServicesProjection,
} from "@/app/api/routes/account/connectedServicesProjection";
import {
    withAuthenticatedTestApp,
} from "@/app/api/testkit/sqliteFastify";
import {
    registerAccountEncryptionMigrateRoutes,
} from "../../account/registerAccountEncryptionMigrateRoutes";
import {
    acquireQualifiedConnectedServiceRefreshLease,
    deleteQualifiedConnectedServiceCredential,
    listQualifiedConnectedAccounts,
    mutateQualifiedConnectedAccountConfiguration,
    mutateQualifiedConnectedServiceCredential,
    mutateQualifiedConnectedServiceCredentialHealth,
    readQualifiedConnectedAccountConfiguration,
    readQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    setQualifiedConnectedAccountGroupActiveAccount,
} from "./groupRepository";
import {
    createQualifiedConnectedAccountGroupDigest,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "./identity";
import {
    registerConnectedServiceCredentialRoutesV3,
} from "../connectedServicesV3/registerConnectedServiceCredentialRoutesV3";
import {
    registerConnectedServiceCredentialRoutesV2,
} from "../connectedServicesV2/registerConnectedServiceCredentialRoutesV2";
import {
    registerConnectedServiceV1ShimRoutes,
} from "../connectedServicesV2/registerConnectedServiceV1ShimRoutes";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./registerQualifiedConnectedAccountCredentialRoutesV4";
import {
    registerConnectedServiceAuthGroupRoutesV3,
} from "../connectedServicesV3/registerConnectedServiceAuthGroupRoutesV3";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    writeQualifiedProviderAccountUsageRecord,
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
} from "./usageRepository";
import {
    deleteLegacyConnectedServiceVendorToken,
    mutateLegacyConnectedServiceVendorToken,
} from "../credentials/mutation";

const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";

function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
    const source = new TextEncoder().encode(value);
    const result = new Uint8Array(new ArrayBuffer(source.byteLength));
    result.set(source);
    return result;
}

function observeAccountMigrationTransactionMutations(): Readonly<{
    accountMutationAttempted: () => boolean;
    credentialMutationAttempted: () => boolean;
    restore: () => void;
}> {
    // Test-only database-boundary interception keeps real Prisma operations while observing ordering.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;
    let accountMutationAttempted = false;
    let credentialMutationAttempted = false;
    mutableDb.$transaction = async (
        input: unknown,
        options?: unknown,
    ): Promise<unknown> => {
        if (typeof input !== "function") {
            return await originalTransaction.call(mutableDb, input, options);
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const wrapDelegate = (
                    delegate: Record<PropertyKey, unknown>,
                    mutationMethods: ReadonlySet<PropertyKey>,
                    recordMutation: () => void,
                ) => new Proxy(delegate, {
                    get(target, property) {
                        const value = Reflect.get(target, property, target);
                        if (
                            typeof value !== "function"
                            || !mutationMethods.has(property)
                        ) {
                            return value;
                        }
                        return (...args: unknown[]) => {
                            recordMutation();
                            return value.apply(target, args);
                        };
                    },
                });
                const account = wrapDelegate(
                    tx.account,
                    new Set(["create", "delete", "deleteMany", "update", "updateMany", "upsert"]),
                    () => {
                        accountMutationAttempted = true;
                    },
                );
                const serviceAccountToken = wrapDelegate(
                    tx.serviceAccountToken,
                    new Set(["create", "delete", "deleteMany", "update", "updateMany", "upsert"]),
                    () => {
                        credentialMutationAttempted = true;
                    },
                );
                return await input(new Proxy(tx, {
                    get(target, property) {
                        if (property === "account") return account;
                        if (property === "serviceAccountToken") {
                            return serviceAccountToken;
                        }
                        return Reflect.get(target, property, target);
                    },
                }));
            },
            options,
        );
    };
    return {
        accountMutationAttempted: () => accountMutationAttempted,
        credentialMutationAttempted: () => credentialMutationAttempted,
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

function claudeRecord(
    profileId: string,
    kind: "oauth" | "token",
): ConnectedServiceCredentialRecordV1 {
    if (kind === "oauth") {
        return buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: "claude-subscription",
            profileId,
            kind,
            oauth: {
                accessToken: `access-${profileId}`,
                refreshToken: `refresh-${profileId}`,
                idToken: null,
                scope: "account:read",
                tokenType: "Bearer",
                providerAccountId: `provider-${profileId}`,
                providerEmail: `${profileId}@example.com`,
            },
        });
    }
    return buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: "claude-subscription",
        profileId,
        kind,
        token: {
            token: `setup-${profileId}`,
            providerAccountId: `provider-${profileId}`,
            providerEmail: `${profileId}@example.com`,
        },
    });
}

describe("qualified Connected Account activated legacy compatibility", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix:
                "happier-qualified-connected-account-legacy-compatibility-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    it.each([
        {
            profileId: "claude-oauth",
            kind: "oauth" as const,
            authenticationModeId: "oauth",
        },
        {
            profileId: "claude-setup-token",
            kind: "token" as const,
            authenticationModeId: "setup-token",
        },
    ])(
        "lists, reads, and reconnects an activated Claude $kind row without a second secret",
        async ({ profileId, kind, authenticationModeId }) => {
            const account = await db.account.create({
                data: { publicKey: null, encryptionMode: "plain" },
                select: { id: true },
            });
            const identity =
                resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: "claude-subscription",
                    profileId,
                    credentialKind: kind,
                });
            const ref = {
                service: {
                    pluginId: identity.servicePluginId,
                    localId: identity.serviceLocalId,
                },
                accountId: identity.connectedAccountId,
            };
            const record = claudeRecord(profileId, kind);
            const seeded = await db.serviceAccountToken.create({
                data: {
                    accountId: account.id,
                    vendor: "claude-subscription",
                    profileId,
                    ...identity,
                    token: encodeUtf8(JSON.stringify(record)),
                    metadata: {
                        v: 3,
                        storage: "plain_json_v1",
                        kind,
                        credentialRevision,
                        providerEmail: `${profileId}@example.com`,
                        providerAccountId: `provider-${profileId}`,
                    },
                },
                select: { id: true },
            });

            await expect(listQualifiedConnectedAccounts({
                accountId: account.id,
                service: ref.service,
            })).resolves.toEqual([
                expect.objectContaining({
                    ref,
                    authenticationModeId,
                    credentialRevision,
                    kind,
                }),
            ]);
            await expect(readQualifiedConnectedServiceCredential({
                accountId: account.id,
                ref,
            })).resolves.toMatchObject({
                status: "resolved",
                credential: {
                    authenticationModeId,
                    credentialRevision,
                    configurationRevision: null,
                    content: { t: "plain", v: record },
                },
            });

            const replacement = claudeRecord(profileId, kind);
            const reconnected =
                await mutateQualifiedConnectedServiceCredential({
                    accountId: account.id,
                    ref,
                    expectedCredentialRevision: credentialRevision,
                    expectedConfigurationRevision: null,
                    authenticationModeId,
                    content: { t: "plain", v: replacement },
                    metadata: {
                        providerIdentity: {
                            accountId: `provider-${profileId}`,
                            email: `${profileId}@example.com`,
                        },
                        scopes: ["account:read"],
                    },
                    legacyIdentity: {
                        serviceId: "claude-subscription",
                        profileId,
                    },
                });
            expect(reconnected).toMatchObject({ status: "written" });
            expect(await db.serviceAccountToken.count({
                where: { accountId: account.id },
            })).toBe(1);
            await expect(db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: account.id },
                select: {
                    id: true,
                    vendor: true,
                    profileId: true,
                    qualifiedIdentityDigest: true,
                },
            })).resolves.toEqual({
                id: seeded.id,
                vendor: "claude-subscription",
                profileId,
                qualifiedIdentityDigest: identity.qualifiedIdentityDigest,
            });
        },
    );

    it("keeps an authoritative retained legacy credential decode failure distinct from absence through V4", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const profileId = "retained-invalid-binding";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId,
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const retainedRecord = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: "github",
            profileId: "different-profile",
            kind: "oauth",
            oauth: {
                accessToken: "retained-secret",
                refreshToken: "retained-refresh",
                idToken: null,
                scope: null,
                tokenType: "Bearer",
                providerAccountId: null,
                providerEmail: null,
            },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId,
                ...identity,
                token: encodeUtf8(JSON.stringify(retainedRecord)),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    credentialRevision,
                    providerEmail: null,
                    providerAccountId: null,
                },
            },
        });

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toEqual({ status: "unsupported_format" });

        const encodedRef =
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                ref,
            );
        await withAuthenticatedTestApp(
            (app) =>
                registerQualifiedConnectedAccountCredentialRoutesV4(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url:
                        `/v4/connect/qualified/credential?ref=${encodeURIComponent(encodedRef)}`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(409);
                expect(response.json()).toEqual({
                    error: "connect_credential_unsupported_format",
                });
                expect(response.body).not.toContain("retained-secret");
            },
        );
    });

    it("keeps a corrupt native V4 sealed credential fail-closed without exposing its content", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "server_sealed",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const ref = {
            service: {
                pluginId: "example.connected-accounts",
                localId: "native-v4",
            },
            accountId: "corrupt-sealed",
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: {
                t: "plain",
                v: { token: "native-v4-secret-must-not-leak" },
            },
            metadata: { scopes: [] },
        });
        if (created.status !== "written") {
            throw new Error("Expected native V4 credential create");
        }
        const row = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        await db.serviceAccountToken.update({
            where: { id: row.id },
            data: {
                token: encodeUtf8(JSON.stringify({
                    v: 1,
                    storage: "server_sealed_json_v1",
                    ciphertext:
                        Buffer.from("corrupt-sealed-bytes").toString("base64"),
                })),
            },
        });

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).rejects.toThrow();

        const encodedRef =
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                ref,
            );
        await withAuthenticatedTestApp(
            (app) =>
                registerQualifiedConnectedAccountCredentialRoutesV4(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url:
                        `/v4/connect/qualified/credential?ref=${encodeURIComponent(encodedRef)}`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(500);
                expect(response.body).not.toContain(
                    "native-v4-secret-must-not-leak",
                );
            },
        );
    });

    it("reads and reconnects an activated E2EE V2 row on the same canonical credential", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const profileId = "sealed-account";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId,
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const seeded = await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId,
                ...identity,
                token: encodeUtf8("opaque-legacy-e2ee"),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "oauth",
                    credentialRevision,
                },
            },
            select: { id: true },
        });

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                authenticationModeId: "oauth",
                credentialRevision,
                content: {
                    t: "encrypted",
                    c: "opaque-legacy-e2ee",
                },
            },
        });

        const reconnected =
            await mutateQualifiedConnectedServiceCredential({
                accountId: account.id,
                ref,
                expectedCredentialRevision: credentialRevision,
                expectedConfigurationRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "encrypted",
                    c: "opaque-replacement-e2ee",
                },
                metadata: { scopes: [] },
                legacyIdentity: {
                    serviceId: "openai-codex",
                    profileId,
                },
            });
        expect(reconnected).toMatchObject({ status: "written" });
        await expect(db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        })).resolves.toEqual({ id: seeded.id });
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("fails closed on a legacy-prefixed digest instead of lazily rewriting identity", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const profileId = "invalid-digest";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai",
            profileId,
            credentialKind: "token",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const row = await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai",
                profileId,
                ...identity,
                qualifiedIdentityDigest: "legacy:projection-shadow",
                token: encodeUtf8("{}"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "token",
                    credentialRevision,
                },
            },
            select: { id: true },
        });

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).rejects.toThrow(/digest mismatch/i);
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: { id: row.id },
            select: { qualifiedIdentityDigest: true },
        })).resolves.toEqual({
            qualifiedIdentityDigest: "legacy:projection-shadow",
        });
    });

    it("rejects a legacy boundary identity that disagrees with the qualified ref before writing", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const openAi = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai",
            profileId: "work",
            credentialKind: "token",
        });

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: {
                service: {
                    pluginId: openAi.servicePluginId,
                    localId: openAi.serviceLocalId,
                },
                accountId: openAi.connectedAccountId,
            },
            expectedCredentialRevision: null,
            authenticationModeId: openAi.authenticationModeId,
            content: {
                t: "plain",
                v: { token: "must-not-write" },
            },
            metadata: { scopes: [] },
            legacyIdentity: {
                serviceId: "anthropic",
                profileId: "different-account",
            },
        })).rejects.toThrow(/identity mismatch/i);
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(0);
    });

    it("projects a V4-built built-in credential through the released V2 account view without losing status or revision", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: identity.authenticationModeId,
            content: {
                t: "plain",
                v: { accessToken: "credential" },
            },
            metadata: {
                providerIdentity: {
                    accountId: "provider-work",
                    email: "work@example.com",
                },
                scopes: ["account:read"],
            },
        });
        if (created.status !== "written") {
            throw new Error("Expected V4 credential create");
        }

        await expect(buildAccountConnectedServicesProjection({
            tx: db,
            accountId: account.id,
            includeGroups: false,
        })).resolves.toMatchObject({
            connectedServicesV2: [
                {
                    serviceId: "openai-codex",
                    profiles: [
                        {
                            profileId: "work",
                            status: "connected",
                            kind: "oauth",
                            providerEmail: "work@example.com",
                            providerAccountId: "provider-work",
                        },
                    ],
                },
            ],
            connectedServiceCredentialRevisionsV1: [
                {
                    serviceId: "openai-codex",
                    profileId: "work",
                    credentialRevision: created.credentialRevision,
                },
            ],
            connectedAccountsV4: [
                {
                    ref,
                    status: "connected",
                    authenticationModeId: identity.authenticationModeId,
                    credentialRevision: created.credentialRevision,
                    configurationReady: false,
                    configurationRevision: null,
                    providerIdentity: {
                        accountId: "provider-work",
                        email: "work@example.com",
                    },
                    scopes: ["account:read"],
                },
            ],
            connectedAccountGroupsV4: [],
        });
    });

    it("projects qualified groups through V4 while legacy group projection is disabled", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
            credentialKind: "oauth",
        });
        const service = {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        };
        const credential = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: {
                service,
                accountId: identity.connectedAccountId,
            },
            expectedCredentialRevision: null,
            authenticationModeId: identity.authenticationModeId,
            content: {
                t: "plain",
                v: { accessToken: "credential" },
            },
            metadata: { scopes: [] },
        });
        expect(credential.status).toBe("written");
        const group = await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: {
                groupId: "codex-main",
                displayName: "Codex Main",
            },
            initialMembers: [{
                connectedAccountId: identity.connectedAccountId,
                priority: 10,
            }],
            activeConnectedAccountId: identity.connectedAccountId,
        });
        expect(group.status).toBe("written");

        const projection = await buildAccountConnectedServicesProjection({
            tx: db,
            accountId: account.id,
            includeGroups: false,
        });

        expect(projection.connectedServicesV2).toEqual([
            expect.objectContaining({
                serviceId: "openai-codex",
                groups: [],
            }),
        ]);
        expect(projection.connectedAccountGroupsV4).toEqual([
            expect.objectContaining({
                ref: {
                    service,
                    groupId: "codex-main",
                },
                displayName: "Codex Main",
                activeConnectedAccountId: identity.connectedAccountId,
                members: [
                    expect.objectContaining({
                        connectedAccountId:
                            identity.connectedAccountId,
                    }),
                ],
            }),
        ]);
    });

    it("derives the released projection kind from canonical authentication-mode identity", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
            credentialKind: "oauth",
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                ...identity,
                token: Buffer.from("sealed-credential", "utf8"),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "token",
                },
            },
        });

        const projection = await buildAccountConnectedServicesProjection({
            tx: db,
            accountId: account.id,
            includeGroups: false,
        });
        expect(projection.connectedServicesV2).toEqual([
            expect.objectContaining({
                serviceId: "openai-codex",
                profiles: [
                    expect.objectContaining({
                        profileId: "work",
                        kind: "oauth",
                    }),
                ],
            }),
        ]);
    });

    it("serves and reconnects a V4-built configured built-in through the released V3 credential routes on one row", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const profileId = "configured-setup-token";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId,
            credentialKind: "token",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const initialRecord = claudeRecord(profileId, "token");
        if (initialRecord.kind !== "token") {
            throw new Error("Expected setup-token credential");
        }
        const releasedInitialRecord = {
            ...initialRecord,
            oauth: null,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "setup-token",
            content: { t: "plain", v: initialRecord },
            metadata: {
                providerIdentity: {
                    accountId: `provider-${profileId}`,
                    email: `${profileId}@example.com`,
                },
                scopes: [],
            },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { endpoint: "https://example.invalid" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured V4 credential create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });
        const replacementRecord = {
            ...releasedInitialRecord,
            updatedAt: initialRecord.updatedAt + 1,
            token: {
                ...initialRecord.token,
                token: `replacement-${profileId}`,
            },
        };
        let reconnectRevision: string | null = null;

        await withAuthenticatedTestApp(
            (app) => registerConnectedServiceCredentialRoutesV3(app),
            async (app) => {
                const read = await app.inject({
                    method: "GET",
                    url:
                        `/v3/connect/claude-subscription/profiles/${profileId}/credential`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(read.statusCode).toBe(200);
                expect(read.json()).toEqual({
                    credentialRevision: created.credentialRevision,
                    content: {
                        t: "plain",
                        v: releasedInitialRecord,
                    },
                });

                const reconnect = await app.inject({
                    method: "POST",
                    url:
                        `/v3/connect/claude-subscription/profiles/${profileId}/credential`,
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        content: { t: "plain", v: replacementRecord },
                        expectedCredentialRevision:
                            created.credentialRevision,
                    },
                });
                expect(reconnect.statusCode).toBe(200);
                reconnectRevision =
                    reconnect.json().credentialRevision as string;

                const health = await app.inject({
                    method: "PATCH",
                    url:
                        `/v3/connect/claude-subscription/profiles/${profileId}/credential/health`,
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        health: {
                            v: 1,
                            status: "needs_reauth",
                            reconnectRequired: true,
                            providerErrorCode: "invalid_grant",
                        },
                        expectedCredentialRevision: reconnectRevision,
                    },
                });
                expect(health.statusCode).toBe(200);
                expect(health.json()).toEqual({
                    success: true,
                    credentialRevision: reconnectRevision,
                });
            },
        );

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                authenticationModeId: "setup-token",
                configurationRevision: created.configurationRevision,
                content: { t: "plain", v: replacementRecord },
            },
        });
        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service: ref.service,
        })).resolves.toEqual([
            expect.objectContaining({
                ref,
                status: "needs_reauth",
                credentialRevision: reconnectRevision,
                configurationRevision: created.configurationRevision,
            }),
        ]);
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            configurationRevision: created.configurationRevision,
            configurationContent: {
                t: "plain",
                v: { endpoint: "https://example.invalid" },
            },
        });
        await expect(db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                configurationContent: true,
                configurationRevision: true,
            },
        })).resolves.toEqual(before);
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("rejects a released V3 writer that would change a configured V4 account authentication mode", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const profileId = "configured-oauth";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId,
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "plain",
                v: claudeRecord(profileId, "oauth"),
            },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { endpoint: "https://example.invalid" },
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured OAuth credential create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                token: true,
                metadata: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });

        await withAuthenticatedTestApp(
            (app) => registerConnectedServiceCredentialRoutesV3(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url:
                        `/v3/connect/claude-subscription/profiles/${profileId}/credential`,
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        content: {
                            t: "plain",
                            v: claudeRecord(profileId, "token"),
                        },
                        expectedCredentialRevision:
                            created.credentialRevision,
                    },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "invalid-params",
                });
            },
        );

        const after = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                token: true,
                metadata: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });
        expect(after.id).toBe(before.id);
        expect(Buffer.from(after.token)).toEqual(Buffer.from(before.token));
        expect(after.metadata).toEqual(before.metadata);
        expect(Buffer.from(
            after.configurationContent ?? [],
        )).toEqual(Buffer.from(
            before.configurationContent ?? [],
        ));
        expect(after.configurationRevision).toBe(
            before.configurationRevision,
        );
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("serves and reconnects a configured V4-built E2EE built-in through released V2 routes", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const profileId = "configured-e2ee";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId,
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "opaque-v4-e2ee-credential",
            },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "encrypted",
                    c: "opaque-v4-e2ee-configuration",
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured V4 E2EE create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });

        await withAuthenticatedTestApp(
            (app) => registerConnectedServiceCredentialRoutesV2(app, {
                credentialMaxLen: 220_000,
            }),
            async (app) => {
                const read = await app.inject({
                    method: "GET",
                    url:
                        `/v2/connect/openai-codex/profiles/${profileId}/credential`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(read.statusCode).toBe(200);
                expect(read.json()).toEqual({
                    credentialRevision: created.credentialRevision,
                    sealed: {
                        format: "account_scoped_v1",
                        ciphertext: "opaque-v4-e2ee-credential",
                    },
                    metadata: {
                        kind: "oauth",
                        providerEmail: null,
                        providerAccountId: null,
                        expiresAt: null,
                    },
                });

                const reconnect = await app.inject({
                    method: "POST",
                    url:
                        `/v2/connect/openai-codex/profiles/${profileId}/credential`,
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "replacement-v2-e2ee-credential",
                        },
                        metadata: {
                            kind: "oauth",
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                        },
                        expectedCredentialRevision:
                            created.credentialRevision,
                    },
                });
                expect(reconnect.statusCode).toBe(200);
            },
        );

        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                authenticationModeId: "oauth",
                configurationRevision: created.configurationRevision,
                content: {
                    t: "encrypted",
                    c: "replacement-v2-e2ee-credential",
                },
            },
        });
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            configurationRevision: created.configurationRevision,
            configurationContent: {
                t: "encrypted",
                c: "opaque-v4-e2ee-configuration",
            },
        });
        await expect(db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                configurationContent: true,
                configurationRevision: true,
            },
        })).resolves.toEqual(before);
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("creates a released V3 group and member with the exact qualified credential ownership", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: { t: "plain", v: { accessToken: "credential" } },
            metadata: { scopes: [] },
        });
        expect(created.status).toBe("written");
        const credential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        const qualifiedGroupDigest =
            createQualifiedConnectedAccountGroupDigest({
                service: ref.service,
                groupId: "team",
            });

        await withAuthenticatedTestApp(
            (app) => registerConnectedServiceAuthGroupRoutesV3(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v3/connect/openai-codex/groups",
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        groupId: "team",
                        displayName: "Team",
                        members: [{
                            profileId: "work",
                            priority: 1,
                            enabled: true,
                        }],
                        activeProfileId: "work",
                        policy: { autoSwitch: false },
                    },
                });
                expect(
                    response.statusCode,
                    JSON.stringify(response.json()),
                ).toBe(200);
            },
        );

        await expect(db.connectedServiceAuthGroup.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                qualifiedGroupDigest: true,
                members: {
                    select: {
                        credentialId: true,
                        qualifiedServiceDigest: true,
                        qualifiedGroupDigest: true,
                        qualifiedIdentityDigest: true,
                    },
                },
            },
        })).resolves.toEqual({
            servicePluginId: identity.servicePluginId,
            serviceLocalId: identity.serviceLocalId,
            qualifiedServiceDigest: identity.qualifiedServiceDigest,
            qualifiedGroupDigest,
            members: [{
                credentialId: credential.id,
                qualifiedServiceDigest: identity.qualifiedServiceDigest,
                qualifiedGroupDigest,
                qualifiedIdentityDigest: identity.qualifiedIdentityDigest,
            }],
        });
    });

    it("preserves released empty V3 group creation while assigning generated qualified service identity", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "identity-only",
            credentialKind: "oauth",
        });
        const service = {
            pluginId: identity.servicePluginId,
            localId: identity.serviceLocalId,
        };
        const qualifiedGroupDigest =
            createQualifiedConnectedAccountGroupDigest({
                service,
                groupId: "empty-team",
            });

        await withAuthenticatedTestApp(
            (app) => registerConnectedServiceAuthGroupRoutesV3(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v3/connect/openai-codex/groups",
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        groupId: "empty-team",
                        displayName: "Empty team",
                        members: [],
                        policy: { autoSwitch: false },
                    },
                });
                expect(
                    response.statusCode,
                    JSON.stringify(response.json()),
                ).toBe(200);
            },
        );

        await expect(db.connectedServiceAuthGroup.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                qualifiedGroupDigest: true,
                members: true,
            },
        })).resolves.toMatchObject({
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: identity.qualifiedServiceDigest,
            qualifiedGroupDigest,
            members: [],
        });
    });

    it("links a released usage source to the exact qualified credential identity", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "work",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: { t: "plain", v: { accessToken: "credential" } },
            metadata: {
                providerIdentity: {
                    accountId: "acct_provider_subject",
                },
                scopes: [],
            },
        });
        expect(created.status).toBe("written");
        const credential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey();
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
        });
        await expect(
            writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            source: {
                ref,
                bindingKind: "account",
            },
        })).resolves.toMatchObject({
            sourceOutcome: { status: "linked" },
        });
        await expect(db.connectedServiceUsageSource.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
                credentialId: true,
            },
        })).resolves.toEqual({
            servicePluginId: identity.servicePluginId,
            serviceLocalId: identity.serviceLocalId,
            qualifiedServiceDigest: identity.qualifiedServiceDigest,
            connectedAccountId: identity.connectedAccountId,
            qualifiedIdentityDigest: identity.qualifiedIdentityDigest,
            credentialId: credential.id,
        });
    });

    it("round-trips and CAS-replaces an E2EE configuration sidecar without exposing plaintext", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "e2ee-configured",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "opaque-credential-ciphertext",
            },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "encrypted",
                    c: "opaque-configuration-ciphertext",
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected E2EE configured credential create");
        }

        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            credentialRevision: created.credentialRevision,
            configurationRevision: created.configurationRevision,
            configurationContent: {
                t: "encrypted",
                c: "opaque-configuration-ciphertext",
            },
        });
        const patched = await mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            replacementContentEnvelope: {
                t: "encrypted",
                c: "replacement-configuration-ciphertext",
            },
        });
        if (patched.status !== "written") {
            throw new Error("Expected E2EE configuration patch");
        }
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            credentialRevision: created.credentialRevision,
            configurationRevision: patched.configurationRevision,
            configurationContent: {
                t: "encrypted",
                c: "replacement-configuration-ciphertext",
            },
        });
        const stored = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true, configurationContent: true },
        });
        const storedCredential = Buffer.from(stored.token).toString("utf8");
        const storedConfiguration = Buffer.from(
            stored.configurationContent ?? [],
        ).toString("utf8");
        expect(storedCredential).toContain('"t":"encrypted"');
        expect(storedCredential).not.toContain('"t":"plain"');
        expect(storedConfiguration).toContain('"t":"encrypted"');
        expect(storedConfiguration).not.toContain('"t":"plain"');
    });

    it("returns the old-reader-safe predecessor refusal before inspecting a mismatched stored qualified identity", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "opaque-settings-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "mismatched-qualified-identity",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "opaque-credential-ciphertext",
            },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "encrypted",
                    c: "opaque-configuration-ciphertext",
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured E2EE credential create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                token: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });
        await db.serviceAccountToken.update({
            where: { id: before.id },
            data: { qualifiedServiceDigest: "0".repeat(64) },
        });
        const mutationObserver =
            observeAccountMigrationTransactionMutations();

        try {
            await withAuthenticatedTestApp(
                (app) => registerAccountEncryptionMigrateRoutes(app),
                async (app) => {
                    const response = await app.inject({
                        method: "POST",
                        url: "/v1/account/encryption/migrate",
                        headers: { "x-test-user-id": account.id },
                        payload: {
                            toMode: "plain",
                            expectedSettingsVersion: 0,
                            settingsContent: {
                                t: "plain",
                                v: { schemaVersion: 2 },
                            },
                            connectedServices: {
                                action: "migrate",
                                qualifiedCredentials: [{
                                    ref,
                                    expectedCredentialRevision:
                                        created.credentialRevision,
                                    expectedConfigurationRevision:
                                        created.configurationRevision,
                                    authenticationModeId: "oauth",
                                    replacementCredentialContentEnvelope: {
                                        t: "plain",
                                        v: {
                                            accessToken:
                                                "replacement-credential",
                                        },
                                    },
                                    replacementConfigurationContentEnvelope: {
                                        t: "plain",
                                        v: {
                                            endpoint:
                                                "https://example.invalid",
                                        },
                                    },
                                    metadata: { scopes: [] },
                                }],
                            },
                            automations: { action: "assert_empty" },
                        },
                    });

                    expect(response.statusCode, response.body).toBe(400);
                    expect(response.json()).toEqual({
                        error: "invalid-params",
                    });
                    expect(
                        mutationObserver.accountMutationAttempted(),
                    ).toBe(false);
                    expect(
                        mutationObserver.credentialMutationAttempted(),
                    ).toBe(false);
                },
            );

            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "opaque-settings-ciphertext",
                settingsVersion: 0,
            });
            const after = await db.serviceAccountToken.findUniqueOrThrow({
                where: { id: before.id },
                select: {
                    token: true,
                    configurationContent: true,
                    configurationRevision: true,
                    qualifiedServiceDigest: true,
                },
            });
            expect(Buffer.from(after.token)).toEqual(Buffer.from(before.token));
            expect(Buffer.from(after.configurationContent ?? [])).toEqual(
                Buffer.from(before.configurationContent ?? []),
            );
            expect(after.configurationRevision).toBe(
                before.configurationRevision,
            );
            expect(after.qualifiedServiceDigest).toBe("0".repeat(64));
        } finally {
            mutationObserver.restore();
        }
    });

    it("refuses a predecessor migration of a configured qualified credential without mutating it", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "opaque-settings-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "migrate-configured",
            credentialKind: "oauth",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "opaque-credential-ciphertext",
            },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "encrypted",
                    c: "opaque-configuration-ciphertext",
                },
            },
        });
        if (
            created.status !== "written"
            || created.configurationRevision === null
        ) {
            throw new Error("Expected configured E2EE credential create");
        }
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                token: true,
                configurationContent: true,
                configurationRevision: true,
            },
        });

        const migrationPayload = {
            toMode: "plain",
            expectedSettingsVersion: 0,
            settingsContent: { t: "plain", v: { schemaVersion: 2 } },
            connectedServices: {
                action: "migrate",
                qualifiedCredentials: [{
                    ref,
                    expectedCredentialRevision:
                        created.credentialRevision,
                    expectedConfigurationRevision:
                        created.configurationRevision,
                    authenticationModeId: "oauth",
                    replacementCredentialContentEnvelope: {
                        t: "plain",
                        v: { accessToken: "replacement-credential" },
                    },
                    replacementConfigurationContentEnvelope: {
                        t: "plain",
                        v: { endpoint: "https://example.invalid" },
                    },
                    metadata: { scopes: [] },
                }],
            },
            automations: { action: "assert_empty" },
        } as const;

        await withAuthenticatedTestApp(
            (app) => registerAccountEncryptionMigrateRoutes(app),
            async (app) => {
                const stale = await app.inject({
                    method: "POST",
                    url: "/v1/account/encryption/migrate",
                    headers: { "x-test-user-id": account.id },
                    payload: {
                        ...migrationPayload,
                        connectedServices: {
                            ...migrationPayload.connectedServices,
                            qualifiedCredentials:
                                migrationPayload.connectedServices
                                    .qualifiedCredentials.map((credential) => ({
                                        ...credential,
                                        expectedConfigurationRevision:
                                            "cscr_stale",
                                    })),
                        },
                    },
                });
                expect(stale.statusCode).toBe(400);
                expect(stale.json()).toEqual({
                    error: "invalid-params",
                });

                await expect(db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: {
                        encryptionMode: true,
                        settings: true,
                        settingsVersion: true,
                    },
                })).resolves.toEqual({
                    encryptionMode: "e2ee",
                    settings: "opaque-settings-ciphertext",
                    settingsVersion: 0,
                });
                const afterRejected = await db.serviceAccountToken
                    .findFirstOrThrow({
                        where: { accountId: account.id },
                        select: {
                            id: true,
                            token: true,
                            configurationContent: true,
                            configurationRevision: true,
                        },
                    });
                expect(afterRejected.id).toBe(before.id);
                expect(Buffer.from(afterRejected.token)).toEqual(
                    Buffer.from(before.token),
                );
                expect(Buffer.from(
                    afterRejected.configurationContent ?? [],
                )).toEqual(Buffer.from(
                    before.configurationContent ?? [],
                ));
                expect(afterRejected.configurationRevision).toBe(
                    before.configurationRevision,
                );

                const migrated = await app.inject({
                    method: "POST",
                    url: "/v1/account/encryption/migrate",
                    headers: { "x-test-user-id": account.id },
                    payload: migrationPayload,
                });
                expect(migrated.statusCode).toBe(400);
                expect(migrated.json()).toEqual({
                    error: "invalid-params",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                settings: true,
                settingsVersion: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            settings: "opaque-settings-ciphertext",
            settingsVersion: 0,
        });
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                authenticationModeId: "oauth",
                content: {
                    t: "encrypted",
                    c: "opaque-credential-ciphertext",
                },
            },
        });
        await expect(readQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref },
        })).resolves.toMatchObject({
            configurationContent: {
                t: "encrypted",
                c: "opaque-configuration-ciphertext",
            },
        });
        const migratedRow = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true, token: true, configurationContent: true },
        });
        expect(migratedRow.id).toBe(before.id);
        expect(Buffer.from(migratedRow.token)).toEqual(
            Buffer.from(before.token),
        );
        expect(Buffer.from(
            migratedRow.configurationContent ?? [],
        )).toEqual(Buffer.from(
            before.configurationContent ?? [],
        ));
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(1);
    });

    it("requires an explicit revision across legacy credential mutation paths without changing qualified rows, configuration, or groups", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const plainAccount = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const v3ProfileId = "revision-required-v3";
        const v3Identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId: v3ProfileId,
            credentialKind: "token",
        });
        const v3Ref = {
            service: {
                pluginId: v3Identity.servicePluginId,
                localId: v3Identity.serviceLocalId,
            },
            accountId: v3Identity.connectedAccountId,
        };
        const v3Record = claudeRecord(v3ProfileId, "token");
        const v3Created = await mutateQualifiedConnectedServiceCredential({
            accountId: plainAccount.id,
            ref: v3Ref,
            expectedCredentialRevision: null,
            authenticationModeId: "setup-token",
            content: { t: "plain", v: v3Record },
            metadata: { scopes: [] },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "plain",
                    v: { endpoint: "https://v3.example.test" },
                },
            },
        });
        if (
            v3Created.status !== "written"
            || v3Created.configurationRevision === null
        ) {
            throw new Error("Expected V3 guard fixture create");
        }
        await expect(createQualifiedConnectedAccountGroup({
            accountId: plainAccount.id,
            service: v3Ref.service,
            group: { groupId: "revision-required-v3" },
            initialMembers: [{
                connectedAccountId: v3Ref.accountId,
            }],
            activeConnectedAccountId: v3Ref.accountId,
        })).resolves.toMatchObject({ status: "written" });

        const e2eeAccount = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const createE2eeFixture = async (profileId: string) => {
            const identity = resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "openai-codex",
                profileId,
                credentialKind: "oauth",
            });
            const ref = {
                service: {
                    pluginId: identity.servicePluginId,
                    localId: identity.serviceLocalId,
                },
                accountId: identity.connectedAccountId,
            };
            const created = await mutateQualifiedConnectedServiceCredential({
                accountId: e2eeAccount.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "encrypted",
                    c: `initial-${profileId}`,
                },
                metadata: { scopes: [] },
                initialConfiguration: {
                    expectedConfigurationRevision: null,
                    replacementContentEnvelope: {
                        t: "encrypted",
                        c: `configuration-${profileId}`,
                    },
                },
            });
            if (
                created.status !== "written"
                || created.configurationRevision === null
            ) {
                throw new Error("Expected E2EE guard fixture create");
            }
            return { identity, ref, created };
        };
        const v2Fixture = await createE2eeFixture("revision-required-v2");
        const v1Fixture = await createE2eeFixture("default");
        await expect(createQualifiedConnectedAccountGroup({
            accountId: e2eeAccount.id,
            service: v2Fixture.ref.service,
            group: { groupId: "revision-required-v2" },
            initialMembers: [{
                connectedAccountId: v2Fixture.ref.accountId,
            }],
            activeConnectedAccountId: v2Fixture.ref.accountId,
        })).resolves.toMatchObject({ status: "written" });

        const snapshotQualifiedState = async (params: Readonly<{
            accountId: string;
            qualifiedIdentityDigest: string;
        }>) => ({
            credential: await db.serviceAccountToken.findFirstOrThrow({
                where: {
                    accountId: params.accountId,
                    qualifiedIdentityDigest: params.qualifiedIdentityDigest,
                },
                select: {
                    id: true,
                    token: true,
                    metadata: true,
                    configurationContent: true,
                    configurationRevision: true,
                    expiresAt: true,
                    refreshLeaseOwnerMachineId: true,
                    refreshLeaseExpiresAt: true,
                    updatedAt: true,
                },
            }),
            groups: await db.connectedServiceAuthGroup.findMany({
                where: { accountId: params.accountId },
                orderBy: { id: "asc" },
                select: {
                    id: true,
                    groupId: true,
                    activeConnectedAccountId: true,
                    activeProfileId: true,
                    generation: true,
                    runtimeStateRevision: true,
                    stateJson: true,
                    updatedAt: true,
                    members: {
                        orderBy: { id: "asc" },
                        select: {
                            id: true,
                            credentialId: true,
                            enabled: true,
                            priority: true,
                            stateJson: true,
                            updatedAt: true,
                        },
                    },
                },
            }),
        });

        await withAuthenticatedTestApp(
            (app) => {
                registerConnectedServiceV1ShimRoutes(app, {
                    credentialMaxLen: 220_000,
                });
                registerConnectedServiceCredentialRoutesV2(app, {
                    credentialMaxLen: 220_000,
                });
                registerConnectedServiceCredentialRoutesV3(app);
            },
            async (app) => {
                const v3WriteB = await app.inject({
                    method: "POST",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential`,
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: {
                        content: { t: "plain", v: v3Record },
                        expectedCredentialRevision:
                            v3Created.credentialRevision,
                    },
                });
                expect(v3WriteB.statusCode).toBe(200);
                const v3RevisionB = (
                    v3WriteB.json() as { credentialRevision: string }
                ).credentialRevision;
                expect(v3RevisionB).not.toBe(v3Created.credentialRevision);

                const v2WriteB = await app.inject({
                    method: "POST",
                    url:
                        "/v2/connect/openai-codex/profiles/revision-required-v2/credential",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "replacement-v2",
                        },
                        expectedCredentialRevision:
                            v2Fixture.created.credentialRevision,
                    },
                });
                expect(v2WriteB.statusCode).toBe(200);
                const v2RevisionB = (
                    v2WriteB.json() as { credentialRevision: string }
                ).credentialRevision;
                expect(v2RevisionB).not.toBe(
                    v2Fixture.created.credentialRevision,
                );

                const v1WriteB = await app.inject({
                    method: "POST",
                    url: "/v2/connect/openai-codex/profiles/default/credential",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "replacement-v1-b",
                        },
                        expectedCredentialRevision:
                            v1Fixture.created.credentialRevision,
                    },
                });
                expect(v1WriteB.statusCode).toBe(200);
                const v1RevisionB = (
                    v1WriteB.json() as { credentialRevision: string }
                ).credentialRevision;
                expect(v1RevisionB).not.toBe(
                    v1Fixture.created.credentialRevision,
                );

                const explicitV3Create = await app.inject({
                    method: "POST",
                    url: "/v3/connect/claude-subscription/profiles/revision-required-v3-create/credential",
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: {
                        content: {
                            t: "plain",
                            v: claudeRecord(
                                "revision-required-v3-create",
                                "token",
                            ),
                        },
                        expectedCredentialRevision: null,
                    },
                });
                expect(explicitV3Create.statusCode).toBe(200);

                const explicitV2Create = await app.inject({
                    method: "POST",
                    url: "/v2/connect/openai-codex/profiles/revision-required-v2-create/credential",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "explicit-v2-create",
                        },
                        expectedCredentialRevision: null,
                    },
                });
                expect(explicitV2Create.statusCode).toBe(200);

                const v3Before = await snapshotQualifiedState({
                    accountId: plainAccount.id,
                    qualifiedIdentityDigest:
                        v3Identity.qualifiedIdentityDigest,
                });
                const v2Before = await snapshotQualifiedState({
                    accountId: e2eeAccount.id,
                    qualifiedIdentityDigest:
                        v2Fixture.identity.qualifiedIdentityDigest,
                });
                const v1Before = await snapshotQualifiedState({
                    accountId: e2eeAccount.id,
                    qualifiedIdentityDigest:
                        v1Fixture.identity.qualifiedIdentityDigest,
                });

                const staleV3Write = await app.inject({
                    method: "POST",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential`,
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: {
                        content: { t: "plain", v: v3Record },
                        expectedCredentialRevision:
                            v3Created.credentialRevision,
                    },
                });
                expect(staleV3Write.statusCode).toBe(409);
                expect(staleV3Write.json()).toEqual({
                    error: "connect_credential_mutation_superseded",
                    reason: "revision_mismatch",
                    credentialRevision: v3RevisionB,
                });

                const staleV2Write = await app.inject({
                    method: "POST",
                    url:
                        "/v2/connect/openai-codex/profiles/revision-required-v2/credential",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "stale-v2-write",
                        },
                        expectedCredentialRevision:
                            v2Fixture.created.credentialRevision,
                    },
                });
                expect(staleV2Write.statusCode).toBe(409);
                expect(staleV2Write.json()).toEqual({
                    error: "connect_credential_mutation_superseded",
                    reason: "revision_mismatch",
                    credentialRevision: v2RevisionB,
                });

                const staleV3Health = await app.inject({
                    method: "PATCH",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential/health`,
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: {
                        expectedCredentialRevision:
                            v3Created.credentialRevision,
                        health: {
                            v: 1,
                            status: "needs_reauth",
                            reconnectRequired: true,
                        },
                    },
                });
                expect(staleV3Health.statusCode).toBe(409);
                expect(staleV3Health.json()).toEqual({
                    error: "connect_credential_mutation_superseded",
                    reason: "revision_mismatch",
                    credentialRevision: v3RevisionB,
                });

                const staleV3Delete = await app.inject({
                    method: "DELETE",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential?cleanupGroupReferences=true&expectedCredentialRevision=${encodeURIComponent(v3Created.credentialRevision)}`,
                    headers: { "x-test-user-id": plainAccount.id },
                });
                expect(staleV3Delete.statusCode).toBe(409);
                expect(staleV3Delete.json()).toEqual({
                    error: "connect_credential_mutation_superseded",
                    reason: "revision_mismatch",
                    credentialRevision: v3RevisionB,
                });

                const staleV2Delete = await app.inject({
                    method: "DELETE",
                    url:
                        "/v2/connect/openai-codex/profiles/revision-required-v2/credential"
                        + `?cleanupGroupReferences=true&expectedCredentialRevision=${encodeURIComponent(v2Fixture.created.credentialRevision)}`,
                    headers: { "x-test-user-id": e2eeAccount.id },
                });
                expect(staleV2Delete.statusCode).toBe(409);
                expect(staleV2Delete.json()).toEqual({
                    error: "connect_credential_mutation_superseded",
                    reason: "revision_mismatch",
                    credentialRevision: v2RevisionB,
                });

                const unguardedV3Write = await app.inject({
                    method: "POST",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential`,
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: { content: { t: "plain", v: v3Record } },
                });
                expect(unguardedV3Write.statusCode).toBe(400);
                expect(unguardedV3Write.json()).toEqual({
                    error: "invalid-params",
                });

                const unguardedV2Write = await app.inject({
                    method: "POST",
                    url:
                        "/v2/connect/openai-codex/profiles/revision-required-v2/credential",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "unguarded-v2-write",
                        },
                    },
                });
                expect(unguardedV2Write.statusCode).toBe(400);
                expect(unguardedV2Write.json()).toEqual({
                    error: "connect_credential_invalid",
                });

                const unguardedV3Health = await app.inject({
                    method: "PATCH",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential/health`,
                    headers: { "x-test-user-id": plainAccount.id },
                    payload: {
                        health: {
                            v: 1,
                            status: "needs_reauth",
                            reconnectRequired: true,
                        },
                    },
                });
                expect(unguardedV3Health.statusCode).toBe(400);
                expect(unguardedV3Health.json()).toEqual({
                    error: "invalid-params",
                });

                const unguardedV3Delete = await app.inject({
                    method: "DELETE",
                    url:
                        `/v3/connect/claude-subscription/profiles/${v3ProfileId}/credential?cleanupGroupReferences=true`,
                    headers: { "x-test-user-id": plainAccount.id },
                });
                expect(unguardedV3Delete.statusCode).toBe(400);
                expect(unguardedV3Delete.json()).toEqual({
                    error: "invalid-params",
                });

                const unguardedV2Delete = await app.inject({
                    method: "DELETE",
                    url:
                        "/v2/connect/openai-codex/profiles/revision-required-v2/credential?cleanupGroupReferences=true",
                    headers: { "x-test-user-id": e2eeAccount.id },
                });
                expect(unguardedV2Delete.statusCode).toBe(400);
                expect(unguardedV2Delete.json()).toEqual({
                    error: "connect_credential_invalid",
                });

                const unguardedV1Write = await app.inject({
                    method: "POST",
                    url: "/v1/connect/openai-codex/register-sealed",
                    headers: { "x-test-user-id": e2eeAccount.id },
                    payload: {
                        sealed: {
                            format: "account_scoped_v1",
                            ciphertext: "replacement-v1",
                        },
                    },
                });
                expect(unguardedV1Write.statusCode).toBe(400);
                expect(unguardedV1Write.json()).toEqual({
                    error: "connect_credential_invalid",
                });

                await expect(snapshotQualifiedState({
                    accountId: plainAccount.id,
                    qualifiedIdentityDigest:
                        v3Identity.qualifiedIdentityDigest,
                })).resolves.toEqual(v3Before);
                await expect(snapshotQualifiedState({
                    accountId: e2eeAccount.id,
                    qualifiedIdentityDigest:
                        v2Fixture.identity.qualifiedIdentityDigest,
                })).resolves.toEqual(v2Before);
                await expect(snapshotQualifiedState({
                    accountId: e2eeAccount.id,
                    qualifiedIdentityDigest:
                        v1Fixture.identity.qualifiedIdentityDigest,
                })).resolves.toEqual(v1Before);
            },
        );

        await expect(readQualifiedConnectedServiceCredential({
            accountId: plainAccount.id,
            ref: v3Ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                credentialRevision: expect.any(String),
                content: { t: "plain", v: v3Record },
            },
        });
        await expect(readQualifiedConnectedServiceCredential({
            accountId: e2eeAccount.id,
            ref: v2Fixture.ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                credentialRevision: expect.any(String),
                content: { t: "encrypted", c: "replacement-v2" },
            },
        });
        await expect(readQualifiedConnectedServiceCredential({
            accountId: e2eeAccount.id,
            ref: v1Fixture.ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                credentialRevision: expect.any(String),
                content: { t: "encrypted", c: "replacement-v1-b" },
            },
        });
    });

    it("keeps raw, V2, and V3 rows unfenced while refusing every credential, group, usage, and cache authority effect", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const v3ProfileId = "unfenced-v3";
        const v3Identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "claude-subscription",
            profileId: v3ProfileId,
            credentialKind: "token",
        });
        const v3Ref = {
            service: {
                pluginId: v3Identity.servicePluginId,
                localId: v3Identity.serviceLocalId,
            },
            accountId: v3Identity.connectedAccountId,
        };
        const v3Record = claudeRecord(v3ProfileId, "token");
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "claude-subscription",
                profileId: v3ProfileId,
                ...v3Identity,
                token: encodeUtf8(JSON.stringify(v3Record)),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "token",
                    providerEmail: "unfenced-v3@example.com",
                    providerAccountId: "unfenced-v3-provider",
                },
            },
        });

        const v2Identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex",
            profileId: "unfenced-v2",
            credentialKind: "oauth",
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "unfenced-v2",
                ...v2Identity,
                token: new Uint8Array([2]),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "oauth",
                    providerEmail: null,
                    providerAccountId: null,
                },
            },
        });

        const rawIdentity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai",
            profileId: "unfenced-raw",
            credentialKind: "token",
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai",
                profileId: "unfenced-raw",
                ...rawIdentity,
                token: new Uint8Array([3]),
                metadata: null,
            },
        });

        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service: v3Ref.service,
        })).resolves.toEqual([
            expect.objectContaining({
                ref: v3Ref,
                revisionSemantics: "legacy_unfenced",
                credentialRevision: null,
            }),
        ]);
        const allProfiles = await listQualifiedConnectedAccounts({
            accountId: account.id,
            service: {
                pluginId: v2Identity.servicePluginId,
                localId: v2Identity.serviceLocalId,
            },
        });
        expect(allProfiles).toEqual([
            expect.objectContaining({
                revisionSemantics: "legacy_unfenced",
                credentialRevision: null,
            }),
        ]);
        await expect(listQualifiedConnectedAccounts({
            accountId: account.id,
            service: {
                pluginId: rawIdentity.servicePluginId,
                localId: rawIdentity.serviceLocalId,
            },
        })).resolves.toEqual([
            expect.objectContaining({
                revisionSemantics: "legacy_unfenced",
                credentialRevision: null,
            }),
        ]);
        await expect(readQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: v3Ref,
        })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                revisionSemantics: "legacy_unfenced",
                credentialRevision: null,
                content: { t: "plain", v: v3Record },
            },
        });

        const before = await db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_qualifiedIdentityDigest: {
                    accountId: account.id,
                    qualifiedIdentityDigest:
                        v3Identity.qualifiedIdentityDigest,
                },
            },
            select: {
                token: true,
                metadata: true,
                configurationContent: true,
                configurationRevision: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
                updatedAt: true,
            },
        });

        await expect(mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: v3Ref,
            expectedCredentialRevision: credentialRevision,
            expectedConfigurationRevision: null,
            authenticationModeId: v3Identity.authenticationModeId,
            content: { t: "plain", v: v3Record },
            metadata: { scopes: [] },
        })).resolves.toEqual({ status: "revision_required" });
        await expect(mutateQualifiedConnectedAccountConfiguration({
            accountId: account.id,
            target: { kind: "account", ref: v3Ref },
            expectedCredentialRevision: credentialRevision,
            expectedConfigurationRevision: null,
            replacementContentEnvelope: {
                t: "plain",
                v: { endpoint: "https://unfenced.example.test" },
            },
        })).resolves.toEqual({ status: "revision_required" });
        await expect(mutateQualifiedConnectedServiceCredentialHealth({
            accountId: account.id,
            ref: v3Ref,
            expectedCredentialRevision: credentialRevision,
            expectedConfigurationRevision: null,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
            },
        })).resolves.toEqual({ status: "revision_required" });
        await expect(deleteQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: v3Ref,
            expectedCredentialRevision: credentialRevision,
            cleanupGroupReferences: true,
        })).resolves.toEqual({ status: "revision_required" });
        await expect(acquireQualifiedConnectedServiceRefreshLease({
            accountId: account.id,
            ref: v3Ref,
            expectedCredentialRevision: credentialRevision,
            ownerId: "unfenced-owner",
            ttlMs: 60_000,
        })).resolves.toEqual({ status: "revision_required" });
        await expect(createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service: v3Ref.service,
            group: { groupId: "unfenced-group" },
            initialMembers: [{
                connectedAccountId: v3Ref.accountId,
            }],
            activeConnectedAccountId: v3Ref.accountId,
        })).resolves.toEqual({ status: "source_superseded" });

        const historicalGroupRef = {
            service: v3Ref.service,
            groupId: "historical-unfenced-group",
        };
        const historicalGroup = await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service: historicalGroupRef.service,
            group: { groupId: historicalGroupRef.groupId },
        });
        if (historicalGroup.status !== "written") {
            throw new Error("Expected empty historical group creation");
        }
        await expect(createQualifiedConnectedAccountGroupMember({
            accountId: account.id,
            mutation: {
                group: historicalGroupRef,
                connectedAccountId: v3Ref.accountId,
            },
        })).resolves.toEqual({ status: "source_superseded" });

        // Simulate an already-persisted historical membership. The owner must
        // refuse making it active without rewriting the passive legacy row.
        const [storedHistoricalGroup, storedV3Credential] = await Promise.all([
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: {
                    accountId_qualifiedGroupDigest: {
                        accountId: account.id,
                        qualifiedGroupDigest:
                            createQualifiedConnectedAccountGroupDigest(
                                historicalGroupRef,
                            ),
                    },
                },
                select: {
                    id: true,
                    vendor: true,
                    groupId: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                    activeConnectedAccountId: true,
                    activeProfileId: true,
                    generation: true,
                    runtimeStateRevision: true,
                },
            }),
            db.serviceAccountToken.findUniqueOrThrow({
                where: {
                    accountId_qualifiedIdentityDigest: {
                        accountId: account.id,
                        qualifiedIdentityDigest:
                            v3Identity.qualifiedIdentityDigest,
                    },
                },
                select: {
                    id: true,
                    profileId: true,
                    qualifiedIdentityDigest: true,
                },
            }),
        ]);
        await db.connectedServiceAuthGroupMember.create({
            data: {
                groupDbId: storedHistoricalGroup.id,
                accountId: account.id,
                credentialId: storedV3Credential.id,
                qualifiedServiceDigest:
                    storedHistoricalGroup.qualifiedServiceDigest,
                qualifiedGroupDigest:
                    storedHistoricalGroup.qualifiedGroupDigest,
                qualifiedIdentityDigest:
                    storedV3Credential.qualifiedIdentityDigest,
                vendor: storedHistoricalGroup.vendor,
                groupId: storedHistoricalGroup.groupId,
                profileId: storedV3Credential.profileId,
                stateJson: "{}",
            },
        });
        await expect(setQualifiedConnectedAccountGroupActiveAccount({
            accountId: account.id,
            mutation: {
                group: historicalGroupRef,
                connectedAccountId: v3Ref.accountId,
            },
        })).resolves.toEqual({ status: "source_superseded" });
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: storedHistoricalGroup.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId:
                storedHistoricalGroup.activeConnectedAccountId,
            activeProfileId: storedHistoricalGroup.activeProfileId,
            generation: storedHistoricalGroup.generation,
            runtimeStateRevision:
                storedHistoricalGroup.runtimeStateRevision,
        });

        const recordKey = createProviderAccountUsageRecordKey();
        const snapshot = createUsageSnapshot({
            fetchedAt: 1_000,
            recordKey,
            serviceId: "claude-subscription",
            profileId: v3ProfileId,
        });
        await expect(writeQualifiedProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            source: { ref: v3Ref, bindingKind: "account" },
            expectedCredentialRevision: credentialRevision,
            expectedConfigurationRevision: null,
        })).rejects.toMatchObject({
            code: "connected_service_usage_source_binding",
            kind: "unavailable",
        });

        await expect(buildAccountConnectedServicesProjection({
            tx: db,
            accountId: account.id,
            includeGroups: false,
        })).resolves.toMatchObject({
            connectedServiceCredentialRevisionsV1: [],
            connectedAccountsV4: expect.arrayContaining([
                expect.objectContaining({
                    ref: v3Ref,
                    revisionSemantics: "legacy_unfenced",
                    credentialRevision: null,
                }),
            ]),
        });
        await expect(db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_qualifiedIdentityDigest: {
                    accountId: account.id,
                    qualifiedIdentityDigest:
                        v3Identity.qualifiedIdentityDigest,
                },
            },
            select: {
                token: true,
                metadata: true,
                configurationContent: true,
                configurationRevision: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
                updatedAt: true,
            },
        })).resolves.toEqual(before);
        await expect(db.connectedServiceAuthGroup.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("contracts the raw vendor-token seam before it can overwrite or delete a V4 credential", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai",
            profileId: "default",
            credentialKind: "token",
        });
        const ref = {
            service: {
                pluginId: identity.servicePluginId,
                localId: identity.serviceLocalId,
            },
            accountId: identity.connectedAccountId,
        };
        const created = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: identity.authenticationModeId,
            content: { t: "plain", v: { token: "canonical-secret" } },
            metadata: { scopes: [] },
        });
        expect(created.status).toBe("written");
        const before = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true, token: true, metadata: true },
        });

        await expect(mutateLegacyConnectedServiceVendorToken({
            accountId: account.id,
            vendor: "openai",
        })).resolves.toEqual({ status: "revision_required" });
        await expect(deleteLegacyConnectedServiceVendorToken({
            accountId: account.id,
            vendor: "openai",
        })).resolves.toEqual({ status: "revision_required" });
        const after = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { id: true, token: true, metadata: true },
        });
        expect(after.id).toBe(before.id);
        expect(Buffer.from(after.token).equals(Buffer.from(before.token))).toBe(
            true,
        );
        expect(after.metadata).toEqual(before.metadata);
    });
});
