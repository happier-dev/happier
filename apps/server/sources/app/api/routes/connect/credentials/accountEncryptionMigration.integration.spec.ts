import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    createSignedAccountContentBinding,
} from "@/testkit/accountEncryption";

import {
    prepareConnectedServiceCredentialMutationV3,
} from "../connectedServicesV3/prepareConnectedServiceCredentialMutationV3";
import {
    encodeCredentialTokenBytes,
} from "../connectedServicesV2/credentialTokenCodec";
import {
    mutateQualifiedConnectedServiceCredential,
    readQualifiedConnectedServiceCredentialForLegacyProjection,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../qualifiedConnectedAccounts/identity";
import {
    ConnectedServicesAccountEncryptionMigrationConflictError,
    matchConnectedServicesAccountEncryptionMigrationPostStateInTx,
    migrateConnectedServicesAccountEncryptionInTx,
} from "./accountEncryptionMigration";
import { mutateConnectedServiceCredential } from "./mutation";

function createPlainCredentialRecord(params: Readonly<{
    serviceId: "anthropic";
    profileId: string;
    token: string;
}>) {
    return {
        v: 1 as const,
        serviceId: params.serviceId,
        profileId: params.profileId,
        createdAt: 1,
        updatedAt: 2,
        expiresAt: null,
        kind: "token" as const,
        oauth: null,
        token: {
            token: params.token,
            providerAccountId: null,
            providerEmail: null,
            raw: null,
        },
    };
}

async function createPlainLegacyCredential(params: Readonly<{
    accountId: string;
    profileId: string;
    token: string;
}>): Promise<string> {
    const prepared = prepareConnectedServiceCredentialMutationV3({
        accountId: params.accountId,
        serviceId: "anthropic",
        profileId: params.profileId,
        record: createPlainCredentialRecord({
            serviceId: "anthropic",
            profileId: params.profileId,
            token: params.token,
        }),
    });
    const result = await mutateConnectedServiceCredential({
        accountId: params.accountId,
        serviceId: "anthropic",
        profileId: params.profileId,
        ...prepared,
        storageMode: "plain",
        allowProviderIdentityChange: false,
        expectedCredentialRevision: null,
    });
    expect(result.status).toBe("written");
    if (result.status !== "written") {
        throw new Error("Failed to create legacy credential fixture");
    }
    return result.credentialRevision;
}

async function createSealedLegacyCredential(params: Readonly<{
    accountId: string;
    profileId: string;
    ciphertext: string;
}>): Promise<string> {
    const result = await mutateConnectedServiceCredential({
        accountId: params.accountId,
        serviceId: "anthropic",
        profileId: params.profileId,
        token: encodeCredentialTokenBytes(params.ciphertext),
        metadata: {
            v: 2,
            format: "account_scoped_v1",
            kind: "token",
            providerAccountId: null,
            providerEmail: null,
        },
        expiresAt: null,
        storageMode: "sealed",
        incomingIdentity: {
            providerAccountId: null,
            providerEmail: null,
        },
        allowProviderIdentityChange: false,
        expectedCredentialRevision: null,
    });
    expect(result.status).toBe("written");
    if (result.status !== "written") {
        throw new Error("Failed to create sealed credential fixture");
    }
    return result.credentialRevision;
}

async function readCredentialRows(accountId: string) {
    const rows = await db.serviceAccountToken.findMany({
        where: { accountId },
        orderBy: { id: "asc" },
        select: {
            id: true,
            token: true,
            metadata: true,
            configurationRevision: true,
            configurationContent: true,
            updatedAt: true,
        },
    });
    return rows.map((row) => ({
        ...row,
        token: Buffer.from(row.token).toString("base64"),
        configurationContent:
            row.configurationContent === null
                ? null
                : Buffer.from(row.configurationContent).toString("base64"),
    }));
}

describe("Connected Services account-encryption migration owner", () => {
    let harness: LightSqliteHarness;
    const previousPlainCredentialAtRest =
        process.env
            .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix:
                "happier-connected-services-account-encryption-migration-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        if (previousPlainCredentialAtRest === undefined) {
            delete process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST;
        } else {
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST =
                previousPlainCredentialAtRest;
        }
        await db.serviceAccountToken.deleteMany();
        await db.accountChange.deleteMany();
        await db.account.deleteMany();
    });

    it("rolls back every credential when a later legacy revision is stale", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true, seq: true },
        });
        const firstRevision = await createSealedLegacyCredential({
            accountId: account.id,
            profileId: "first",
            ciphertext: "first-before",
        });
        await createSealedLegacyCredential({
            accountId: account.id,
            profileId: "second",
            ciphertext: "second-before",
        });
        const beforeRows = await readCredentialRows(account.id);
        const beforeAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        });

        await expect(inTx(async (tx) =>
            await migrateConnectedServicesAccountEncryptionInTx({
                tx,
                accountId: account.id,
                currentMode: "e2ee",
                toMode: "plain",
                directive: {
                    action: "migrate",
                    credentials: [
                        {
                            serviceId: "anthropic",
                            profileId: "first",
                            expectedCredentialRevision: firstRevision,
                            kind: "plain",
                            record: createPlainCredentialRecord({
                                serviceId: "anthropic",
                                profileId: "first",
                                token: "first-after",
                            }),
                        },
                        {
                            serviceId: "anthropic",
                            profileId: "second",
                            expectedCredentialRevision:
                                "csr_0123456789ABCDEFGHJKMNPQRS",
                            kind: "plain",
                            record: createPlainCredentialRecord({
                                serviceId: "anthropic",
                                profileId: "second",
                                token: "second-after",
                            }),
                        },
                    ],
                    qualifiedCredentials: [],
                },
            }))).rejects.toBeInstanceOf(
            ConnectedServicesAccountEncryptionMigrationConflictError,
        );

        await expect(readCredentialRows(account.id)).resolves.toEqual(
            beforeRows,
        );
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).resolves.toEqual(beforeAccount);
    });

    it.each([
        "credential",
        "configuration",
    ] as const)(
        "rolls back the legacy rewrite when a qualified %s fence is stale",
        async (staleFence) => {
            const account = await db.account.create({
                data: {
                    ...createSignedAccountContentBinding(),
                    encryptionMode: "e2ee",
                },
                select: { id: true },
            });
            const legacyRevision = await createSealedLegacyCredential({
                accountId: account.id,
                profileId: "legacy",
                ciphertext: "legacy-before",
            });
            const ref = {
                service: {
                    pluginId: "example.connected-accounts",
                    localId: "account-migration",
                },
                accountId: "provider-account",
            };
            const qualified =
                await mutateQualifiedConnectedServiceCredential({
                    accountId: account.id,
                    ref,
                    expectedCredentialRevision: null,
                    authenticationModeId: "api-key",
                    content: {
                        t: "encrypted",
                        c: "qualified-before",
                    },
                    metadata: {
                        displayName: "Qualified before",
                        scopes: [],
                    },
                    initialConfiguration: {
                        expectedConfigurationRevision: null,
                        replacementContentEnvelope: {
                            t: "encrypted",
                            c: "configuration-before",
                        },
                    },
                });
            expect(qualified.status).toBe("written");
            if (qualified.status !== "written") {
                throw new Error(
                    "Failed to create qualified credential fixture",
                );
            }
            const beforeRows = await readCredentialRows(account.id);
            const beforeAccount = await db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { seq: true },
            });

            await expect(inTx(async (tx) =>
                await migrateConnectedServicesAccountEncryptionInTx({
                    tx,
                    accountId: account.id,
                    currentMode: "e2ee",
                    toMode: "plain",
                    directive: {
                        action: "migrate",
                        credentials: [{
                            serviceId: "anthropic",
                            profileId: "legacy",
                            expectedCredentialRevision:
                                legacyRevision,
                            kind: "plain",
                            record: createPlainCredentialRecord({
                                serviceId: "anthropic",
                                profileId: "legacy",
                                token: "legacy-after",
                            }),
                        }],
                        qualifiedCredentials: [{
                            ref,
                            expectedCredentialRevision:
                                staleFence === "credential"
                                    ? "csr_0123456789ABCDEFGHJKMNPQRS"
                                    : qualified.credentialRevision,
                            expectedConfigurationRevision:
                                staleFence === "configuration"
                                    ? "configuration-stale"
                                    : qualified.configurationRevision,
                            authenticationModeId: "api-key",
                            replacementCredentialContentEnvelope: {
                                t: "plain",
                                v: { token: "qualified-after" },
                            },
                            replacementConfigurationContentEnvelope: {
                                t: "plain",
                                v: { endpoint: "after" },
                            },
                            metadata: {
                                displayName: "Qualified after",
                                scopes: [],
                            },
                        }],
                    },
                }))).rejects.toBeInstanceOf(
                ConnectedServicesAccountEncryptionMigrationConflictError,
            );

            await expect(readCredentialRows(account.id)).resolves.toEqual(
                beforeRows,
            );
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { seq: true },
            })).resolves.toEqual(beforeAccount);
        },
    );

    it("matches exact qualified credential/configuration post-state without predicting target revisions", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const ref = {
            service: {
                pluginId: "example.connected-accounts",
                localId: "post-state",
            },
            accountId: "provider-account-post-state",
        } as const;
        const source =
            await mutateQualifiedConnectedServiceCredential({
                accountId: account.id,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: {
                    t: "encrypted",
                    c: "qualified-before",
                },
                metadata: {
                    displayName: "Qualified before",
                    scopes: [],
                },
                initialConfiguration: {
                    expectedConfigurationRevision: null,
                    replacementContentEnvelope: {
                        t: "encrypted",
                        c: "configuration-before",
                    },
                },
            });
        expect(source.status).toBe("written");
        if (source.status !== "written"
            || source.configurationRevision === null) {
            throw new Error(
                "Failed to create qualified post-state fixture",
            );
        }
        const directive = {
            action: "migrate" as const,
            credentials: [],
            qualifiedCredentials: [{
                ref,
                expectedCredentialRevision:
                    source.credentialRevision,
                expectedConfigurationRevision:
                    source.configurationRevision,
                authenticationModeId: "api-key",
                replacementCredentialContentEnvelope: {
                    t: "plain" as const,
                    v: { token: "qualified-after" },
                },
                replacementConfigurationContentEnvelope: {
                    t: "plain" as const,
                    v: { endpoint: "after" },
                },
                metadata: {
                    displayName: "Qualified after",
                    scopes: [],
                },
            }],
        };
        await inTx(async (tx) => {
            await expect(
                migrateConnectedServicesAccountEncryptionInTx({
                    tx,
                    accountId: account.id,
                    currentMode: "e2ee",
                    toMode: "plain",
                    directive,
                }),
            ).resolves.toMatchObject({
                status: "applied",
                changed: true,
            });
            await tx.account.update({
                where: { id: account.id },
                data: { encryptionMode: "plain" },
            });
        });
        const beforeMatch = await readCredentialRows(account.id);

        await expect(inTx(async (tx) =>
            await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive,
            }),
        )).resolves.toEqual({ status: "matched" });
        await expect(inTx(async (tx) =>
            await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: {
                    ...directive,
                    qualifiedCredentials: [{
                        ...directive.qualifiedCredentials[0],
                        replacementCredentialContentEnvelope: {
                            t: "plain",
                            v: { token: "different" },
                        },
                    }],
                },
            }),
        )).resolves.toEqual({ status: "mismatch" });
        await expect(readCredentialRows(account.id)).resolves.toEqual(
            beforeMatch,
        );
    });

    it("matches assert-empty and clear only when credentials and usage are absent", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });

        await expect(inTx(async (tx) =>
            await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: { action: "assert_empty" },
            }),
        )).resolves.toEqual({ status: "matched" });
        await expect(inTx(async (tx) =>
            await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "matched" });

        await createPlainLegacyCredential({
            accountId: account.id,
            profileId: "not-empty",
            token: "not-empty",
        });
        await expect(inTx(async (tx) =>
            await matchConnectedServicesAccountEncryptionMigrationPostStateInTx({
                tx,
                accountId: account.id,
                toMode: "plain",
                directive: { action: "clear" },
            }),
        )).resolves.toEqual({ status: "mismatch" });
    });

    it.each([
        "none",
        "server_sealed",
    ] as const)(
        "uses the normal v3 preparation and repository storage under %s at rest",
        async (atRest) => {
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST =
                atRest;
            const normalAccount = await db.account.create({
                data: {
                    publicKey: null,
                    encryptionMode: "plain",
                },
                select: { id: true },
            });
            const migrationAccount = await db.account.create({
                data: {
                    ...createSignedAccountContentBinding(),
                    encryptionMode: "e2ee",
                },
                select: { id: true },
            });
            const record = createPlainCredentialRecord({
                serviceId: "anthropic",
                profileId: "canonical",
                token: `canonical-${atRest}`,
            });
            await createPlainLegacyCredential({
                accountId: normalAccount.id,
                profileId: "canonical",
                token: `canonical-${atRest}`,
            });
            const sourceRevision = await createSealedLegacyCredential({
                accountId: migrationAccount.id,
                profileId: "canonical",
                ciphertext: `source-${atRest}`,
            });

            const migration = await inTx(async (tx) => {
                const result =
                    await migrateConnectedServicesAccountEncryptionInTx({
                        tx,
                        accountId: migrationAccount.id,
                        currentMode: "e2ee",
                        toMode: "plain",
                        directive: {
                            action: "migrate",
                            credentials: [{
                                serviceId: "anthropic",
                                profileId: "canonical",
                                expectedCredentialRevision:
                                    sourceRevision,
                                kind: "plain",
                                record,
                            }],
                            qualifiedCredentials: [],
                        },
                    });
                await tx.account.update({
                    where: { id: migrationAccount.id },
                    data: { encryptionMode: "plain" },
                });
                return result;
            });
            expect(migration).toMatchObject({
                status: "applied",
                changed: true,
            });

            const identity =
                resolveLegacyServiceAccountTokenIdentityFields({
                    serviceId: "anthropic",
                    profileId: "canonical",
                    credentialKind: "token",
                });
            const ref = {
                service: {
                    pluginId: identity.servicePluginId,
                    localId: identity.serviceLocalId,
                },
                accountId: identity.connectedAccountId,
            };
            const [normalSnapshot, migrationSnapshot] =
                await Promise.all([
                    readQualifiedConnectedServiceCredentialForLegacyProjection(
                        {
                            accountId: normalAccount.id,
                            ref,
                        },
                    ),
                    readQualifiedConnectedServiceCredentialForLegacyProjection(
                        {
                            accountId: migrationAccount.id,
                            ref,
                        },
                    ),
                ]);
            expect(normalSnapshot).toMatchObject({
                status: "resolved",
                credential: {
                    content: { t: "plain", v: record },
                    expiresAt: null,
                },
            });
            expect(migrationSnapshot).toMatchObject({
                status: "resolved",
                credential: {
                    content: { t: "plain", v: record },
                    expiresAt: null,
                },
            });
            if (
                normalSnapshot.status !== "resolved"
                || migrationSnapshot.status !== "resolved"
            ) {
                throw new Error("Credential snapshots did not resolve");
            }
            expect(migrationSnapshot.credential.metadata).toEqual(
                normalSnapshot.credential.metadata,
            );

            const [normalRow, migrationRow] = await Promise.all([
                db.serviceAccountToken.findFirstOrThrow({
                    where: { accountId: normalAccount.id },
                    select: { token: true, metadata: true },
                }),
                db.serviceAccountToken.findFirstOrThrow({
                    where: { accountId: migrationAccount.id },
                    select: { token: true, metadata: true },
                }),
            ]);
            const normalContainer = JSON.parse(
                new TextDecoder().decode(normalRow.token),
            ) as Readonly<{ storage: string; content?: unknown }>;
            const migrationContainer = JSON.parse(
                new TextDecoder().decode(migrationRow.token),
            ) as Readonly<{ storage: string; content?: unknown }>;
            expect(normalContainer.storage).toBe(
                atRest === "none"
                    ? "json_v1"
                    : "server_sealed_json_v1",
            );
            expect(migrationContainer.storage).toBe(
                normalContainer.storage,
            );
            if (atRest === "none") {
                expect(migrationContainer.content).toEqual(
                    normalContainer.content,
                );
            }
            const stripCredentialRevision = (metadata: unknown) => {
                const recordMetadata =
                    metadata as Readonly<Record<string, unknown>>;
                const {
                    credentialRevision: _credentialRevision,
                    ...stable
                } = recordMetadata;
                return stable;
            };
            expect(stripCredentialRevision(migrationRow.metadata)).toEqual(
                stripCredentialRevision(normalRow.metadata),
            );
        },
    );

    it("migrates a plain legacy credential to the exact encrypted envelope", async () => {
        process.env
            .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST =
            "none";
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sourceRevision = await createPlainLegacyCredential({
            accountId: account.id,
            profileId: "encrypted-target",
            token: "plain-source",
        });
        const ciphertext = "encrypted-target-ciphertext";

        await inTx(async (tx) => {
            const result =
                await migrateConnectedServicesAccountEncryptionInTx({
                    tx,
                    accountId: account.id,
                    currentMode: "plain",
                    toMode: "e2ee",
                    directive: {
                        action: "migrate",
                        credentials: [{
                            serviceId: "anthropic",
                            profileId: "encrypted-target",
                            expectedCredentialRevision:
                                sourceRevision,
                            kind: "sealed",
                            sealed: {
                                format: "account_scoped_v1",
                                ciphertext,
                            },
                            metadata: {
                                kind: "token",
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                            },
                        }],
                        qualifiedCredentials: [],
                    },
                });
            expect(result).toMatchObject({
                status: "applied",
                changed: true,
            });
            await tx.account.update({
                where: { id: account.id },
                data: {
                    ...createSignedAccountContentBinding(),
                    encryptionMode: "e2ee",
                },
            });
        });

        const identity =
            resolveLegacyServiceAccountTokenIdentityFields({
                serviceId: "anthropic",
                profileId: "encrypted-target",
                credentialKind: "token",
            });
        await expect(
            readQualifiedConnectedServiceCredentialForLegacyProjection({
                accountId: account.id,
                ref: {
                    service: {
                        pluginId: identity.servicePluginId,
                        localId: identity.serviceLocalId,
                    },
                    accountId: identity.connectedAccountId,
                },
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            credential: {
                content: {
                    t: "encrypted",
                    c: ciphertext,
                },
            },
        });
    });

    it.each([
        {
            name: "misbound",
            record: createPlainCredentialRecord({
                serviceId: "anthropic",
                profileId: "different-profile",
                token: "misbound",
            }),
        },
        {
            name: "oversized",
            record: createPlainCredentialRecord({
                serviceId: "anthropic",
                profileId: "invalid-preparation",
                token: "x".repeat(220_001),
            }),
        },
    ])(
        "rejects $name v3 content before any migration write",
        async ({ record }) => {
            const account = await db.account.create({
                data: {
                    ...createSignedAccountContentBinding(),
                    encryptionMode: "e2ee",
                },
                select: { id: true },
            });
            const sourceRevision =
                await createSealedLegacyCredential({
                    accountId: account.id,
                    profileId: "invalid-preparation",
                    ciphertext: "source-before-invalid-preparation",
                });
            const beforeRows = await readCredentialRows(account.id);
            const beforeAccount = await db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { seq: true },
            });

            await expect(inTx(async (tx) =>
                await migrateConnectedServicesAccountEncryptionInTx({
                    tx,
                    accountId: account.id,
                    currentMode: "e2ee",
                    toMode: "plain",
                    directive: {
                        action: "migrate",
                        credentials: [{
                            serviceId: "anthropic",
                            profileId: "invalid-preparation",
                            expectedCredentialRevision:
                                sourceRevision,
                            kind: "plain",
                            record,
                        }],
                        qualifiedCredentials: [],
                    },
                }))).resolves.toEqual({
                status: "invalid_content",
            });
            await expect(readCredentialRows(account.id)).resolves.toEqual(
                beforeRows,
            );
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { seq: true },
            })).resolves.toEqual(beforeAccount);
        },
    );
});
