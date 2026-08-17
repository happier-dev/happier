import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { registerConnectedServiceCredentialRoutesV2 } from "../connect/connectedServicesV2/registerConnectedServiceCredentialRoutesV2";
import { registerConnectedServiceCredentialRoutesV3 } from "../connect/connectedServicesV3/registerConnectedServiceCredentialRoutesV3";
import { registerAutomationCrudRoutes } from "../automations/registerAutomationCrudRoutes";
import {
    createUsageSnapshot,
} from "../connect/providerAccountUsageTestkit";
import {
    writeProviderAccountUsageRecord,
} from "../connect/providerAccountUsage/recordStorage";
import { accountRoutes } from "./accountRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX,
    PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX,
} from "@/app/kv/accountScopedKv";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function installEmptyCredentialCountBarrier(accountId: string): Readonly<{
    countObserved: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const countObserved = deferred();
    const releaseCount = deferred();
    let paused = false;

    const pauseAfterTargetCount = async <T>(args: unknown, result: T): Promise<T> => {
        const where = (args as { where?: { accountId?: string } } | undefined)?.where;
        if (!paused && where?.accountId === accountId && result === 0) {
            paused = true;
            countObserved.resolve();
            await releaseCount.promise;
        }
        return result;
    };

    // This test-only scheduler wraps the real Prisma boundary so the route still performs real DB work.
    const mutableDb = db as any;
    const directDelegate = mutableDb.serviceAccountToken;
    const originalDirectCount = directDelegate.count;
    const originalTransaction = mutableDb.$transaction;

    directDelegate.count = async (args: unknown) => {
        return await pauseAfterTargetCount(args, await originalDirectCount.call(directDelegate, args));
    };
    mutableDb.$transaction = async (operation: unknown, options: unknown) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(mutableDb, operation, options);
        }
        return await originalTransaction.call(mutableDb, async (tx: any) => {
            const transactionDelegate = tx.serviceAccountToken;
            const originalTransactionCount = transactionDelegate.count.bind(transactionDelegate);
            const wrappedDelegate = new Proxy(transactionDelegate, {
                get(target, property, receiver) {
                    if (property === "count") {
                        return async (args: unknown) => {
                            return await pauseAfterTargetCount(args, await originalTransactionCount(args));
                        };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            const wrappedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === "serviceAccountToken") return wrappedDelegate;
                    return Reflect.get(target, property, receiver);
                },
            });
            return await operation(wrappedTx);
        }, options);
    };

    return {
        countObserved: countObserved.promise,
        release: releaseCount.resolve,
        restore: () => {
            releaseCount.resolve();
            directDelegate.count = originalDirectCount;
            mutableDb.$transaction = originalTransaction;
        },
    };
}

function installAccountModeReadBarrier(accountId: string): Readonly<{
    modeObserved: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const modeObserved = deferred();
    const releaseRead = deferred();
    let paused = false;
    const mutableDb = db as any;
    const accountDelegate = mutableDb.account;
    const originalFindUnique = accountDelegate.findUnique;

    accountDelegate.findUnique = async (args: unknown) => {
        const result = await originalFindUnique.call(accountDelegate, args);
        const query = args as { where?: { id?: string }; select?: { encryptionMode?: boolean } } | undefined;
        if (!paused && query?.where?.id === accountId && query.select?.encryptionMode === true) {
            paused = true;
            modeObserved.resolve();
            await releaseRead.promise;
        }
        return result;
    };

    return {
        modeObserved: modeObserved.promise,
        release: releaseRead.resolve,
        restore: () => {
            releaseRead.resolve();
            accountDelegate.findUnique = originalFindUnique;
        },
    };
}

function installReviewCommentInventoryFailure(): Readonly<{
    restore: () => void;
}> {
    // Test-only fault injection wraps the genuine Prisma boundary; production logic remains real.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;

    mutableDb.$transaction = async (operation: unknown, options: unknown) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(mutableDb, operation, options);
        }
        return await originalTransaction.call(mutableDb, async (tx: any) => {
            const originalQueryRaw = tx.$queryRaw.bind(tx);
            const wrappedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === "$queryRaw") {
                        return async (query: unknown) => {
                            const sql = (
                                query as {
                                    strings?: readonly string[];
                                }
                            ).strings?.join(" ") ?? "";
                            if (sql.includes("FROM review_comments")) {
                                throw new Error(
                                    "review-comment-storage-unavailable",
                                );
                            }
                            return await originalQueryRaw(query);
                        };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            return await operation(wrappedTx);
        }, options);
    };

    return {
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

describe("accountRoutes (encryption mode integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-",
            initAuth: false,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpointOperation.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.accountPetAsset.deleteMany(),
            () => db.accountPetPackage.deleteMany(),
            () => db.reviewCommentEvent.deleteMany(),
            () => db.reviewComment.deleteMany(),
            () => db.sessionOrganizationFolder.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.pluginCollectionRow.deleteMany({
                where: { pluginId: "acme.patch-transition-blocker" },
            }),
            () => db.pluginCollectionContract.deleteMany({
                where: { pluginId: "acme.patch-transition-blocker" },
            }),
            () => db.userKVStore.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.serviceAccountToken.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("GET /v1/account/encryption returns account encryption mode", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                ...binding,
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ mode: "e2ee", updatedAt: 1771322400000 });
            },
        );
    });

    it("GET Account encryption endpoints reject inconsistent E2EE binding before disclosure", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                for (const url of [
                    "/v1/account/encryption",
                    "/v1/account/encryption/currentness",
                ]) {
                    const response = await app.inject({
                        method: "GET",
                        url,
                        headers: {
                            "x-test-user-id": account.id,
                        },
                    });

                    expect(response.statusCode).toBe(400);
                    expect(response.json()).toEqual({
                        error: "migration-required",
                    });
                }
            },
        );
    });

    it("GET /v1/account/encryption/currentness returns the Account sequence and retained key fingerprints", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                publicKey: binding.publicKey,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig:
                    binding.contentPublicKeySig,
                encryptionMode: "plain",
                encryptionModeUpdatedAt:
                    new Date("2026-02-17T10:00:00.000Z"),
                seq: 7,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url:
                        "/v1/account/encryption/currentness",
                    headers: {
                        "x-test-user-id": account.id,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({
                    mode: "plain",
                    version: 7,
                    signingKeyFingerprint:
                        computeAccountEncryptionMigrateKeyFingerprintV1(
                            new Uint8Array(
                                Buffer.from(
                                    binding.publicKey,
                                    "hex",
                                ),
                            ),
                        ),
                    contentKeyFingerprint:
                        computeAccountEncryptionMigrateKeyFingerprintV1(
                            binding.contentPublicKey,
                        ),
                    updatedAt: 1771322400000,
                });
            },
        );
    });

    it("PATCH /v1/account/encryption returns 404 when account opt-out is disabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "0",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "not_found" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("e2ee");
    });

    it("PATCH /v1/account/encryption updates the account mode when account opt-out is enabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
            },
            select: { id: true, seq: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({ mode: "plain", updatedAt: expect.any(Number) });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                seq: true,
            },
        });
        expect(stored?.encryptionMode).toBe("plain");
        expect(stored?.encryptionModeUpdatedAt?.getTime()).toBeGreaterThan(1771322400000);
        expect(stored?.seq).toBe(account.seq + 1);
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "account",
                    entityId: "self",
                },
            },
            select: { cursor: true },
        })).resolves.toEqual({ cursor: account.seq + 1 });
    });

    it("PATCH /v1/account/encryption clears orphaned source-mode usage through the Connected Services owner", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
        });
        await writeProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-orphan-usage",
            },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await expect(db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "plain" },
                });

                expect(response.statusCode, response.body).toBe(200);
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("PATCH /v1/account/encryption preserves the internal response for a missing account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": "missing-account" },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(500);
                expect(res.json()).toEqual({ error: "internal" });
            },
        );
    });

    it("PATCH /v1/account/encryption refuses proofless e2ee before inspecting stored content-key material", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                ...binding,
                contentPublicKeySig: new Uint8Array(
                    binding.contentPublicKeySig.byteLength,
                ),
                encryptionMode: "plain",
            },
            select: { id: true, updatedAt: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "e2ee" },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "migration-required",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            encryptionMode: "plain",
            updatedAt: account.updatedAt,
        });
    });

    it("PATCH /v1/account/encryption refuses plain-to-e2ee without a fresh possession proof", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                ...binding,
                encryptionMode: "plain",
            },
            select: {
                id: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "e2ee" },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "migration-required",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            encryptionMode: "plain",
            encryptionModeUpdatedAt:
                account.encryptionModeUpdatedAt,
            updatedAt: account.updatedAt,
        });
    });

    it("PATCH /v1/account/encryption rejects mode flips that require migration", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
                settings: "cipher",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "migration-required" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settings: true },
        });
        expect(stored?.encryptionMode).toBe("e2ee");
        expect(stored?.settings).toBe("cipher");
    });

    it.each([
        "machine",
        "todo",
        "artifact",
    ] as const)("PATCH /v1/account/encryption refuses a non-empty %s inventory before Account mutation", async (domain) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const encryptionModeUpdatedAt =
            new Date("2026-02-17T10:00:00.000Z");
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt,
            },
            select: {
                id: true,
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
            },
        });
        if (domain === "machine") {
            await db.machine.create({
                data: {
                    id: "machine-account-encryption-migration-required",
                    accountId: account.id,
                    metadata: "machine-bytes-before",
                    metadataVersion: 7,
                    daemonState: "daemon-bytes-before",
                    daemonStateVersion: 8,
                    dataEncryptionKey: new Uint8Array([1, 2, 3]),
                },
            });
        } else if (domain === "todo") {
            await db.userKVStore.create({
                data: {
                    accountId: account.id,
                    key: "todo.index",
                    value: new Uint8Array([4, 5, 6]),
                    version: 9,
                },
            });
        } else {
            await db.artifact.create({
                data: {
                    id: "00000000-0000-4000-8000-000000000007",
                    accountId: account.id,
                    header: new Uint8Array([7, 8]),
                    headerVersion: 10,
                    body: new Uint8Array([9, 10]),
                    bodyVersion: 11,
                    dataEncryptionKey: new Uint8Array([11, 12]),
                },
            });
        }

        const domainBefore =
            domain === "machine"
                ? await db.machine.findUniqueOrThrow({
                    where: {
                        id:
                            "machine-account-encryption-migration-required",
                    },
                })
                : domain === "todo"
                    ? await db.userKVStore.findUniqueOrThrow({
                        where: {
                            accountId_key: {
                                accountId: account.id,
                                key: "todo.index",
                            },
                        },
                    })
                    : await db.artifact.findUniqueOrThrow({
                        where: {
                            id:
                                "00000000-0000-4000-8000-000000000007",
                        },
                    });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "plain" },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "migration-required",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            encryptionMode: account.encryptionMode,
            encryptionModeUpdatedAt: account.encryptionModeUpdatedAt,
            updatedAt: account.updatedAt,
        });
        const domainAfter =
            domain === "machine"
                ? await db.machine.findUniqueOrThrow({
                    where: {
                        id:
                            "machine-account-encryption-migration-required",
                    },
                })
                : domain === "todo"
                    ? await db.userKVStore.findUniqueOrThrow({
                        where: {
                            accountId_key: {
                                accountId: account.id,
                                key: "todo.index",
                            },
                        },
                    })
                    : await db.artifact.findUniqueOrThrow({
                        where: {
                            id:
                                "00000000-0000-4000-8000-000000000007",
                        },
                    });
        expect(domainAfter).toEqual(domainBefore);
    });

    it.each([
        {
            domain: "Plugin Account KV",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key:
                            `${PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX}acme.patch-transition-blocker`,
                        value: new TextEncoder().encode(
                            "mode-bound-plugin-account-data",
                        ),
                    },
                });
            },
        },
        {
            domain: "Plugin Collection",
            populate: async (accountId: string) => {
                const pluginId = "acme.patch-transition-blocker";
                const collectionId = "private-items";
                const contract = await db.pluginCollectionContract.create({
                    data: {
                        pluginId,
                        collectionId,
                        schemaVersion: 1,
                        contractDigest: "a".repeat(43),
                        normalizedSchema: {},
                        indexes: [],
                        relations: [],
                        privacyProjection: {},
                    },
                    select: {
                        id: true,
                        contractDigest: true,
                    },
                });
                await db.pluginCollectionRow.create({
                    data: {
                        accountId,
                        pluginId,
                        collectionId,
                        rowId: "private-row",
                        schemaVersion: 1,
                        revision: 1,
                        contractId: contract.id,
                        contractDigest: contract.contractDigest,
                        contentEnvelope: {
                            t: "encrypted",
                            c: "mode-bound-plugin-collection",
                        },
                    },
                });
            },
        },
        {
            domain: "Plugin Declarative Settings",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key:
                            `${PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX}acme.patch-transition-blocker`,
                        value: new TextEncoder().encode(
                            "mode-bound-plugin-declarative-settings",
                        ),
                    },
                });
            },
        },
        {
            domain: "Account Settings History",
            populate: async (accountId: string) => {
                await db.accountSettingsSnapshot.create({
                    data: {
                        accountId,
                        version: 1,
                        settingsDbValue: "retained-settings-history",
                        encryptionMode: "e2ee",
                        contentKind: "encrypted",
                    },
                });
            },
        },
        {
            domain: "Review Comments",
            populate: async (accountId: string) => {
                await db.reviewComment.create({
                    data: {
                        id: "review-comment-patch-transition-blocker",
                        accountId,
                        projectId: "project-patch-transition-blocker",
                        threadId: "thread-patch-transition-blocker",
                        state: "open",
                        flagsJson: "{}",
                        anchorJson: JSON.stringify({
                            kind: "file",
                            filePath: "src/example.ts",
                        }),
                        anchorFilePath: "src/example.ts",
                        snapshotEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "snapshot-source",
                        }),
                        bodyEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "body-source",
                        }),
                        bodyVersion: 1,
                        authorJson: JSON.stringify({
                            kind: "user",
                            userId: "user-patch-transition-blocker",
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
                        id: "folder-patch-transition-blocker",
                        accountId,
                        folderKey: "folder-patch-transition-blocker",
                        folderHash: "folder-patch-transition-blocker-hash",
                        displayDbValue: JSON.stringify({
                            t: "encrypted",
                            c: "folder-source",
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
                        id: "pet-patch-transition-blocker",
                        accountId,
                        packageFormat: "codexAtlasV1",
                        contentMode: "plain",
                        manifest: { id: "pet-patch-transition-blocker" },
                        digest: "sha256:pet-patch-transition-blocker",
                        sizeBytes: 1,
                        origin: { kind: "manualImport" },
                    },
                });
            },
        },
        {
            domain: "Plugin Webhooks",
            populate: async (accountId: string) => {
                const route = await db.pluginWebhookRoute.create({
                    data: {
                        id: "route-patch-transition-blocker",
                        opaqueRouteId: "opaque-patch-transition-blocker",
                        verifierKind: "github_hmac_sha256_v1",
                        routingKind: "accountEndpoint",
                    },
                });
                const endpoint = await db.pluginWebhookEndpoint.create({
                    data: {
                        id: "endpoint-patch-transition-blocker",
                        accountId,
                        routeId: route.id,
                        routingKind: "accountEndpoint",
                    },
                });
                await db.pluginWebhookDelivery.create({
                    data: {
                        id: "delivery-patch-transition-blocker",
                        endpointId: endpoint.id,
                        accountId,
                        routeId: route.id,
                        deliveryIdentityDigest:
                            "a".repeat(64),
                        verifierKind: "github_hmac_sha256_v1",
                        targetMachineId: "machine-patch-transition-blocker",
                        targetMachineInstallationId:
                            "installation-patch-transition-blocker",
                        targetMaterializationId:
                            "materialization-patch-transition-blocker",
                        targetPluginId: "acme.github",
                        targetPluginVersion: "1.0.0",
                        endpointRevision: endpoint.revision,
                        endpointWebhookContributionId: "github-events",
                        endpointHandlerActionId: "handle-webhook",
                        endpointSourceInstanceId:
                            "source-patch-transition-blocker",
                        payloadKind: "plain",
                        payload: { t: "plain", v: { marker: "payload-bearing" } },
                        payloadBytes: 1n,
                        wireVersion: 1,
                        payloadVersion: 1,
                        state: "dead_letter",
                        nextAttemptAt: new Date("2026-08-10T00:00:00.000Z"),
                        metadataDeleteAt:
                            new Date("2026-11-10T00:00:00.000Z"),
                        receivedAt: new Date("2026-08-10T00:00:00.000Z"),
                    },
                });
            },
        },
    ])("PATCH /v1/account/encryption refuses non-empty $domain through the canonical transition owner", async ({
        populate,
    }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const encryptionModeUpdatedAt =
            new Date("2026-02-17T10:00:00.000Z");
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt,
            },
            select: {
                id: true,
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
                seq: true,
            },
        });
        await populate(account.id);

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "plain" },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "migration-required",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
                seq: true,
            },
        })).resolves.toEqual({
            encryptionMode: account.encryptionMode,
            encryptionModeUpdatedAt: account.encryptionModeUpdatedAt,
            updatedAt: account.updatedAt,
            seq: account.seq,
        });
    });

    it("PATCH /v1/account/encryption preserves an unexpected Review Comment storage failure", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: {
                id: true,
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
                seq: true,
            },
        });
        const failure = installReviewCommentInventoryFailure();

        try {
            await withAuthenticatedTestApp(
                (app) => accountRoutes(app as any),
                async (app) => {
                    const response = await app.inject({
                        method: "PATCH",
                        url: "/v1/account/encryption",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": account.id,
                        },
                        payload: { mode: "plain" },
                    });

                    expect(response.statusCode).toBe(500);
                    expect(response.json()).toEqual({ error: "internal" });
                },
            );
        } finally {
            failure.restore();
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
                seq: true,
            },
        })).resolves.toEqual({
            encryptionMode: account.encryptionMode,
            encryptionModeUpdatedAt: account.encryptionModeUpdatedAt,
            updatedAt: account.updatedAt,
            seq: account.seq,
        });
    });

    it("PATCH /v1/account/encryption refuses an archived owner-metadata Session with zero Account mutation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const encryptionModeUpdatedAt = new Date("2026-02-17T10:00:00.000Z");
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt,
            },
            select: { id: true, updatedAt: true },
        });
        await db.session.create({
            data: {
                accountId: account.id,
                tag: "archived-owner-metadata",
                metadata: "legacy-session-metadata",
                metadataLayoutVersion: 1,
                ownerMetadata: "owner-only-ciphertext",
                archivedAt: new Date("2026-02-18T10:00:00.000Z"),
            },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: { mode: "plain" },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "metadata_privacy_upgrade_required",
                });
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            encryptionModeUpdatedAt,
            updatedAt: account.updatedAt,
        });
    });

    it("serializes a mode PATCH against a first V2 credential write", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => {
                accountRoutes(app as any);
                registerConnectedServiceCredentialRoutesV2(app as any, { credentialMaxLen: 1024 });
            },
            async (app) => {
                const barrier = installEmptyCredentialCountBarrier(account.id);
                try {
                    const modePatch = app.inject({
                        method: "PATCH",
                        url: "/v1/account/encryption",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: { mode: "plain" },
                    });
                    await barrier.countObserved;

                    const credentialWritePromise = app.inject({
                        method: "POST",
                        url: "/v2/connect/openai-codex/profiles/work/credential",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: {
                            sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                            metadata: { kind: "oauth", providerEmail: "race@example.com" },
                        },
                    });
                    await Promise.race([
                        credentialWritePromise.then(() => undefined),
                        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
                    ]);

                    barrier.release();
                    const [credentialWrite, modeResult] = await Promise.all([credentialWritePromise, modePatch]);
                    expect([credentialWrite.statusCode, modeResult.statusCode].sort()).toEqual([200, 400]);
                    if (credentialWrite.statusCode === 400) {
                        expect(credentialWrite.json()).toEqual({ error: "connect_credential_invalid" });
                    } else {
                        expect(modeResult.json()).toEqual({ error: "migration-required" });
                    }
                } finally {
                    barrier.restore();
                }
            },
        );

        const storedAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        const storedCredential = await db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: account.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            select: { metadata: true },
        });
        if (storedAccount.encryptionMode === "plain") {
            expect(storedCredential).toBeNull();
        } else {
            expect(storedCredential?.metadata).toMatchObject({ v: 2, format: "account_scoped_v1" });
        }
    });

    it("keeps a concurrent plain automation create valid when the proofless e2ee PATCH is refused", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const contentBinding = createSignedAccountContentBinding();
        const account = await db.account.create({
            data: {
                ...contentBinding,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const plainTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "must not survive an e2ee flip" },
        });

        await withAuthenticatedTestApp(
            (app) => {
                accountRoutes(app as any);
                registerAutomationCrudRoutes(app as any);
            },
            async (app) => {
                const barrier = installAccountModeReadBarrier(account.id);
                try {
                    const automationCreate = app.inject({
                        method: "POST",
                        url: "/v2/automations",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: {
                            name: "Plain snapshot race",
                            enabled: false,
                            schedule: { kind: "interval", everyMs: 60_000 },
                            targetType: "new_session",
                            templateCiphertext: plainTemplateCiphertext,
                            assignments: [],
                        },
                    });
                    await barrier.modeObserved;

                    const modePatch = await app.inject({
                        method: "PATCH",
                        url: "/v1/account/encryption",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: { mode: "e2ee" },
                    });
                    expect(modePatch.statusCode).toBe(400);
                    expect(modePatch.json()).toEqual({
                        error: "migration-required",
                    });

                    barrier.release();
                    const automationResult = await automationCreate;
                    expect(automationResult.statusCode).toBe(200);
                } finally {
                    barrier.restore();
                }
            },
        );

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
        await expect(db.automation.count({ where: { accountId: account.id } })).resolves.toBe(1);
    });

    it("rejects a mode PATCH after a first V3 credential write wins", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-account-encryption-v3-winner", encryptionMode: "plain" },
            select: { id: true },
        });
        const now = Date.now();

        await withAuthenticatedTestApp(
            (app) => {
                accountRoutes(app as any);
                registerConnectedServiceCredentialRoutesV3(app as any);
            },
            async (app) => {
                const credentialWrite = await app.inject({
                    method: "POST",
                    url: "/v3/connect/openai-codex/profiles/work/credential",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        expectedCredentialRevision: null,
                        content: {
                            t: "plain",
                            v: {
                                v: 1,
                                serviceId: "openai-codex",
                                profileId: "work",
                                kind: "token",
                                createdAt: now,
                                updatedAt: now,
                                expiresAt: null,
                                oauth: null,
                                token: {
                                    token: "plain-token",
                                    providerAccountId: null,
                                    providerEmail: "v3-race@example.com",
                                    raw: null,
                                },
                            },
                        },
                    },
                });
                expect(
                    credentialWrite.statusCode,
                    credentialWrite.body,
                ).toBe(200);
                const credentialRead = await app.inject({
                    method: "GET",
                    url: "/v3/connect/openai-codex/profiles/work/credential",
                    headers: { "x-test-user-id": account.id },
                });
                expect(
                    credentialRead.statusCode,
                    credentialRead.body,
                ).toBe(200);
                expect(credentialRead.json()).toMatchObject({
                    content: {
                        t: "plain",
                        v: {
                            serviceId: "openai-codex",
                            profileId: "work",
                            kind: "token",
                        },
                    },
                });

                const modePatch = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "e2ee" },
                });
                expect(modePatch.statusCode).toBe(400);
                expect(modePatch.json()).toEqual({ error: "migration-required" });
            },
        );

        const storedAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        const storedCredential = await db.serviceAccountToken.findUniqueOrThrow({
            where: {
                accountId_vendor_profileId: {
                    accountId: account.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            select: { metadata: true },
        });
        expect(storedAccount.encryptionMode).toBe("plain");
        expect(storedCredential.metadata).toMatchObject({
            v: 4,
            storage: "stored_envelope_v1",
        });
    });
});
