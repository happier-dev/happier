import Fastify from "fastify";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
    ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    AccountEncryptionMigratePredecessorSuccessResponseSchema,
    AccountStoredContentUpgradeRequiredV1Schema,
    encodeSessionOwnerMetadataEnvelopeV1,
    sealPluginCollectionPrivatePayloadV1,
    sealSessionOwnerMetadataEnvelopeV1,
} from "@happier-dev/protocol";

import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";
import {
    PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX,
    PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX,
} from "@/app/kv/accountScopedKv";
import {
    materializePluginCollectionContractsFromManifestTx,
} from "@/app/plugins/data/collections/contracts";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";

// Exact wire from cli-v0.2.1, the 0.2.2 preview, and the current
// ../remote-dev@41f22ebf7dbd3af41d944c941f31267197f08fa5 predecessor.
const PREDECESSOR_REQUEST = {
    toMode: "plain",
    expectedSettingsVersion: 0,
    settingsContent: null,
    connectedServices: { action: "assert_empty" },
    automations: { action: "assert_empty" },
} as const;

const COLLECTION_BLOCKER_PLUGIN_ID = "compat.predecessor-live-collection";
const COLLECTION_BLOCKER_COLLECTION_ID = "private-items";

const COLLECTION_BLOCKER_MANIFEST = {
    schemaVersion: 2,
    id: COLLECTION_BLOCKER_PLUGIN_ID,
    version: "1.0.0",
    displayName: "Predecessor compatibility Collection fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: COLLECTION_BLOCKER_COLLECTION_ID,
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["open", "closed"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [],
        }],
    },
} as const;

async function createLiveCollectionBlocker(accountId: string) {
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: COLLECTION_BLOCKER_MANIFEST,
        })
    ));
    if (!ref) throw new Error("Expected a fixture Collection contract.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
        select: { id: true, contractDigest: true },
    });
    const row = await db.pluginCollectionRow.create({
        data: {
            accountId,
            pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
            collectionId: COLLECTION_BLOCKER_COLLECTION_ID,
            rowId: "private-row",
            schemaVersion: 1,
            revision: 7,
            contractId: contract.id,
            contractDigest: contract.contractDigest,
            contentEnvelope: {
                t: "encrypted",
                c: sealPluginCollectionPrivatePayloadV1({
                    material: {
                        type: "legacy",
                        secret: new Uint8Array(32).fill(19),
                    },
                    payload: { privateNote: "predecessor collection" },
                    randomBytes: (length) =>
                        new Uint8Array(length).fill(23),
                }),
            },
        },
    });
    await db.pluginCollectionProjection.create({
        data: {
            rowDbId: row.id,
            accountId,
            pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
            collectionId: COLLECTION_BLOCKER_COLLECTION_ID,
            rowId: "private-row",
            fieldId: "status",
            typedEncodedValue: JSON.stringify("open"),
            rowRevision: 7,
        },
    });
    return row;
}

const IDENTITY_BLOCKER_PLUGIN_ID = "compat.identity-live-collection";

const IDENTITY_BLOCKER_MANIFEST = {
    ...COLLECTION_BLOCKER_MANIFEST,
    id: IDENTITY_BLOCKER_PLUGIN_ID,
    contributes: {
        accountCollections: [{
            ...COLLECTION_BLOCKER_MANIFEST.contributes.accountCollections[0],
            // A mode-derived row address the platform cannot recompute. It
            // reaches the terminal identity refusal instead of the zero-limit
            // one, so it proves both arms name the same blocking domain.
            identityFields: ["id"],
        }],
    },
} as const;

async function createLiveIdentityCollectionBlocker(accountId: string) {
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: IDENTITY_BLOCKER_MANIFEST,
        })
    ));
    if (!ref) throw new Error("Expected a fixture Collection contract.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
        select: { id: true, contractDigest: true },
    });
    return await db.pluginCollectionRow.create({
        data: {
            accountId,
            pluginId: IDENTITY_BLOCKER_PLUGIN_ID,
            collectionId: COLLECTION_BLOCKER_COLLECTION_ID,
            rowId: "identity-row",
            schemaVersion: 1,
            revision: 3,
            contractId: contract.id,
            contractDigest: contract.contractDigest,
            contentEnvelope: {
                t: "encrypted",
                c: sealPluginCollectionPrivatePayloadV1({
                    material: {
                        type: "legacy",
                        secret: new Uint8Array(32).fill(37),
                    },
                    payload: { privateNote: "identity collection" },
                    randomBytes: (length) =>
                        new Uint8Array(length).fill(41),
                }),
            },
        },
    });
}

async function createResidualCollectionTombstoneBlocker(accountId: string) {
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
            collectionId: COLLECTION_BLOCKER_COLLECTION_ID,
            schemaVersion: 1,
        },
        select: { id: true, contractDigest: true },
    });
    return await db.pluginCollectionRow.create({
        data: {
            accountId,
            pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
            collectionId: COLLECTION_BLOCKER_COLLECTION_ID,
            rowId: "residual-private-tombstone",
            schemaVersion: 1,
            revision: 5,
            contractId: contract.id,
            contractDigest: contract.contractDigest,
            contentEnvelope: {
                t: "encrypted",
                c: sealPluginCollectionPrivatePayloadV1({
                    material: {
                        type: "legacy",
                        secret: new Uint8Array(32).fill(29),
                    },
                    payload: { privateNote: "residual tombstone" },
                    randomBytes: (length) =>
                        new Uint8Array(length).fill(31),
                }),
            },
            deletedAt: new Date("2026-08-14T00:00:00.000Z"),
        },
    });
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Narrow boundary fixture: this app installs the production decorations below.
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate(
        "authenticate",
        async (
            request: {
                headers: Record<string, unknown>;
                userId?: string;
            },
            reply: {
                code: (status: number) => {
                    send: (body: unknown) => unknown;
                };
            },
        ) => {
            const accountId =
                request.headers["x-test-user-id"];
            if (
                typeof accountId !== "string"
                || accountId.length === 0
            ) {
                return reply
                    .code(401)
                    .send({ error: "Unauthorized" });
            }
            request.userId = accountId;
            captureAccountStoredContentCompatibilityForHttpRequest(
                request as any,
            );
        },
    );
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

function createEncryptedOwnerEnvelope(marker: number) {
    return sealSessionOwnerMetadataEnvelopeV1({
        material: {
            type: "legacy",
            secret: new Uint8Array(32).fill(61),
        },
        ownerMetadata: { v: 1 },
        randomBytes: (length) =>
            new Uint8Array(length).fill(marker),
    });
}

describe("Account encryption migration predecessor compatibility", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix:
                "happier-account-encryption-migrate-compatibility-",
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.pluginCollectionProjection.deleteMany({
            where: { pluginId: COLLECTION_BLOCKER_PLUGIN_ID },
        }).catch(() => {});
        await db.pluginCollectionRow.deleteMany({
            where: { pluginId: COLLECTION_BLOCKER_PLUGIN_ID },
        }).catch(() => {});
        await db.pluginCollectionContract.deleteMany({
            where: { pluginId: COLLECTION_BLOCKER_PLUGIN_ID },
        }).catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("admits the exact immutable request when the complete layout-1 inventory is empty", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const layoutZero = await db.session.create({
            data: {
                accountId: account.id,
                tag: "predecessor-layout-zero",
                metadata: "shared-layout-zero",
                metadataVersion: 3,
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                agentState: "agent-layout-zero",
                agentStateVersion: 4,
            },
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(200);
            expect(
                AccountEncryptionMigratePredecessorSuccessResponseSchema
                    .parse(response.json()),
            ).toEqual({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 1,
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: layoutZero.id },
            })).resolves.toEqual(layoutZero);
        } finally {
            await app.close();
        }
    });

    it("returns typed upgrade-required for active and archived layout-1 rows before mutation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const ownerMetadata =
            encodeSessionOwnerMetadataEnvelopeV1(
                createEncryptedOwnerEnvelope(67),
            );
        await Promise.all([
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "active-layout-one",
                    metadata: "active-shared",
                    metadataVersion: 5,
                    metadataLayoutVersion: 1,
                    ownerMetadata,
                    agentState: "active-agent",
                    agentStateVersion: 6,
                    archivedAt: null,
                },
            }),
            db.session.create({
                data: {
                    accountId: account.id,
                    tag: "archived-layout-one",
                    metadata: "archived-shared",
                    metadataVersion: 7,
                    metadataLayoutVersion: 1,
                    ownerMetadata,
                    agentState: "archived-agent",
                    agentStateVersion: 8,
                    archivedAt:
                        new Date(1_700_000_000_000),
                },
            }),
        ]);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            sessions: await db.session.findMany({
                where: { accountId: account.id },
                orderBy: { tag: "asc" },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(426);
            expect(
                AccountStoredContentUpgradeRequiredV1Schema.parse(
                    response.json(),
                ),
            ).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.session.findMany({
                where: { accountId: account.id },
                orderBy: { tag: "asc" },
            })).resolves.toEqual(before.sessions);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("returns the predecessor operation-level upgrade requirement for a live Collection before mutation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        const collection = await createLiveCollectionBlocker(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(426);
            expect(
                AccountStoredContentUpgradeRequiredV1Schema.parse(
                    response.json(),
                ),
            ).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("returns the predecessor operation-level upgrade requirement when a retained Collection tombstone reaches the size refusal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        await inTx(async (tx) => {
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: COLLECTION_BLOCKER_MANIFEST,
            });
        });
        const collection = await createResidualCollectionTombstoneBlocker(
            account.id,
        );
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(426);
            expect(
                AccountStoredContentUpgradeRequiredV1Schema.parse(
                    response.json(),
                ),
            ).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it.each([
        {
            name: "plugin Account-KV",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key: `${PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX}compat.predecessor-blocker`,
                        value: new TextEncoder().encode("mode-bound-plugin-data"),
                    },
                });
            },
        },
        {
            name: "plugin declarative settings",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key: `${PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX}compat.predecessor-blocker`,
                        value: new TextEncoder().encode("mode-bound-plugin-settings"),
                    },
                });
            },
        },
        {
            name: "a residual private tombstone",
            populate: async (accountId: string) => {
                await createResidualCollectionTombstoneBlocker(accountId);
            },
        },
    ])("returns predecessor 426 for a live Collection beside $name", async ({ populate }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        await createLiveCollectionBlocker(account.id);
        await populate(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collections: await db.pluginCollectionRow.findMany({
                where: { accountId: account.id },
                orderBy: { rowId: "asc" },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(426);
            expect(
                AccountStoredContentUpgradeRequiredV1Schema.parse(
                    response.json(),
                ),
            ).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findMany({
                where: { accountId: account.id },
                orderBy: { rowId: "asc" },
            })).resolves.toEqual(before.collections);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("authenticates before evaluating a live Collection compatibility refusal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        const collection = await createLiveCollectionBlocker(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: { "content-type": "application/json" },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(401);
            expect(response.json()).toEqual({ error: "Unauthorized" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("keeps the predecessor settings currentness conflict ahead of a live Collection refusal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 1,
            },
        });
        const collection = await createLiveCollectionBlocker(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(409);
            expect(response.json()).toEqual({
                error: "version-mismatch",
                currentVersion: 1,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: collection.id },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("names the blocking plugin Collections for a current request with a live Collection", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        await createLiveCollectionBlocker(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
                },
            }),
        };
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(
            account,
        );
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                        String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: { action: "assert_empty" },
                    reviewComments: { action: "assert_empty" },
                    sessionOrganization: { action: "assert_empty" },
                    pets: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body)
                .toBe(400);
            expect(response.json()).toEqual({
                error: "plugin_collections_not_empty",
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    pluginId: COLLECTION_BLOCKER_PLUGIN_ID,
                },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("names the blocking plugin Collections for a live identity-bearing Collection", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        await createLiveIdentityCollectionBlocker(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            collection: await db.pluginCollectionRow.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    pluginId: IDENTITY_BLOCKER_PLUGIN_ID,
                },
            }),
        };
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(
            account,
        );
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]:
                        String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: { action: "assert_empty" },
                    reviewComments: { action: "assert_empty" },
                    sessionOrganization: { action: "assert_empty" },
                    pets: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body)
                .toBe(400);
            expect(response.json()).toEqual({
                error: "plugin_collections_not_empty",
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.pluginCollectionRow.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    pluginId: IDENTITY_BLOCKER_PLUGIN_ID,
                },
            })).resolves.toEqual(before.collection);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it.each([
        {
            domain: "Review Comments",
            populate: async (accountId: string) => {
                await db.reviewComment.create({
                    data: {
                        id: "review-comment-predecessor-blocker",
                        accountId,
                        projectId: "project-predecessor-blocker",
                        threadId: "thread-predecessor-blocker",
                        state: "open",
                        flagsJson: "{}",
                        anchorJson: JSON.stringify({
                            kind: "file",
                            filePath: "src/predecessor.ts",
                        }),
                        anchorFilePath: "src/predecessor.ts",
                        snapshotEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "snapshot-predecessor-blocker",
                        }),
                        bodyEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "body-predecessor-blocker",
                        }),
                        bodyVersion: 1,
                        authorJson: JSON.stringify({
                            kind: "user",
                            userId: "user-predecessor-blocker",
                        }),
                        editsJson: "[]",
                        dispositionsJson: "{}",
                        transitionsJson: "[]",
                        serverRevision: 1,
                        createdAt: 1n,
                        updatedAt: 1n,
                    },
                });
            },
        },
        {
            domain: "Session Organization",
            populate: async (accountId: string) => {
                await db.sessionOrganizationFolder.create({
                    data: {
                        id: "folder-predecessor-blocker",
                        accountId,
                        folderKey: "folder-predecessor-blocker",
                        folderHash:
                            "folder-predecessor-blocker-hash",
                        displayDbValue: JSON.stringify({
                            t: "encrypted",
                            c: "folder-predecessor-blocker",
                        }),
                    },
                });
            },
        },
        {
            domain: "Account Pets",
            populate: async (accountId: string) => {
                await db.accountPetPackage.create({
                    data: {
                        id: "pet-predecessor-blocker",
                        accountId,
                        packageFormat: "codexAtlasV1",
                        contentMode: "plain",
                        manifest: {
                            id: "pet-predecessor-blocker",
                        },
                        digest: "sha256:pet-predecessor-blocker",
                        sizeBytes: 1,
                        origin: { kind: "manualImport" },
                    },
                });
            },
        },
    ])("returns typed upgrade-required before mutation when $domain is populated", async ({
        populate,
    }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:
                "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT:
                "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        await populate(account.id);
        const before = {
            account: await db.account.findUniqueOrThrow({
                where: { id: account.id },
            }),
            reviewComments: await db.reviewComment.findMany({
                where: { accountId: account.id },
            }),
            sessionOrganizationFolders:
                await db.sessionOrganizationFolder.findMany({
                    where: { accountId: account.id },
                }),
            petPackages: await db.accountPetPackage.findMany({
                where: { accountId: account.id },
            }),
        };
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: PREDECESSOR_REQUEST,
            });

            expect(response.statusCode, response.body)
                .toBe(426);
            expect(
                AccountStoredContentUpgradeRequiredV1Schema.parse(
                    response.json(),
                ),
            ).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
            })).resolves.toEqual(before.account);
            await expect(db.reviewComment.findMany({
                where: { accountId: account.id },
            })).resolves.toEqual(before.reviewComments);
            await expect(db.sessionOrganizationFolder.findMany({
                where: { accountId: account.id },
            })).resolves.toEqual(
                before.sessionOrganizationFolders,
            );
            await expect(db.accountPetPackage.findMany({
                where: { accountId: account.id },
            })).resolves.toEqual(before.petPackages);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });
});
