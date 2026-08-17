import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { captureAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { buildPluginAccountStoragePhysicalKey } from "@/app/kv/accountScopedKv";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { kvRoutes } from "./kvRoutes";

const { emitUpdate, markAccountChanged } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
    markAccountChanged: vi.fn(async () => 900),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildKVBatchUpdateUpdate: vi.fn((_changes: unknown, seq: number) => ({
        id: "update-id",
        seq,
        body: { t: "kv-batch-update" },
    })),
}));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "update-id") }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const CURRENT_HEADERS = {
    "x-happier-account-stored-content-protocol":
        String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
} as const;

// remote-dev ba6ecc07: Encryption.encryptRaw stores nonce ||
// crypto_secretbox_easy(JSON) and returns its base64 form to KV.
const RELEASED_SECRETBOX_TODO_VALUE =
    "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJr91zgQjd2U84B/OLFWa+t/doZphbPlyJSwZ2jdgWjwk9saxROyK+se1SiWqotjQNPveX1Iru";

function encodeWireEnvelope(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("kvRoutes Todo stored-content compatibility", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-kv-todo-compat-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedAccount(mode: "plain" | "e2ee" = "plain") {
        if (mode === "e2ee") {
            const signing = tweetnacl.sign.keyPair();
            const content = tweetnacl.box.keyPair();
            const contentBinding = Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(content.publicKey),
            ]);
            return await db.account.create({
                data: {
                    publicKey: Buffer.from(signing.publicKey).toString("hex"),
                    encryptionMode: mode,
                    contentPublicKey: new Uint8Array(content.publicKey),
                    contentPublicKeySig: new Uint8Array(
                        tweetnacl.sign.detached(
                            contentBinding,
                            signing.secretKey,
                        ),
                    ),
                },
                select: { id: true },
            });
        }
        return await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: mode,
            },
            select: { id: true },
        });
    }

    async function withKvApp(run: Parameters<typeof withAuthenticatedTestApp>[1]) {
        await withAuthenticatedTestApp(
            (app) => {
                app.addHook("preHandler", async (request: Parameters<typeof captureAccountStoredContentCompatibilityForHttpRequest>[0]) => {
                    captureAccountStoredContentCompatibilityForHttpRequest(request);
                });
                kvRoutes(app);
            },
            run,
        );
    }

    it("never exposes or mutates AccountScopedKv rows through public generic KV", async () => {
        const account = await seedAccount();
        const physicalKey = buildPluginAccountStoragePhysicalKey("example.tasks");
        const persistedValue = Buffer.from("private plugin row", "utf8");
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: physicalKey,
                value: persistedValue,
                version: 7,
            },
        });

        await withKvApp(async (app) => {
            const requests = [
                {
                    method: "GET" as const,
                    url: `/v1/kv/${encodeURIComponent(physicalKey)}`,
                },
                {
                    method: "GET" as const,
                    url: "/v1/kv?prefix=%40",
                },
                {
                    method: "POST" as const,
                    url: "/v1/kv/bulk",
                    payload: { keys: [physicalKey] },
                },
                {
                    method: "POST" as const,
                    url: "/v1/kv",
                    payload: {
                        mutations: [{
                            key: physicalKey,
                            value: Buffer.from("attempted overwrite", "utf8").toString("base64"),
                            version: 7,
                        }],
                    },
                },
            ];

            for (const request of requests) {
                const response = await app.inject({
                    ...request,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                    },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({ error: "Invalid parameters" });
                expect(response.body).not.toContain(physicalKey);
                expect(response.body).not.toContain(persistedValue.toString("base64"));
            }
        });

        await expect(db.userKVStore.findUniqueOrThrow({
            where: { accountId_key: { accountId: account.id, key: physicalKey } },
        })).resolves.toMatchObject({ value: persistedValue, version: 7 });
        expect(markAccountChanged).not.toHaveBeenCalled();
    });

    it("requires the current declaration for marked Todo single, list, and bulk reads", async () => {
        const account = await seedAccount();
        const marker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(marker, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            for (const request of [
                { method: "GET" as const, url: "/v1/kv/todo.index" },
                { method: "GET" as const, url: "/v1/kv?prefix=todo." },
                {
                    method: "POST" as const,
                    url: "/v1/kv/bulk",
                    payload: { keys: ["todo.index"] },
                },
            ]) {
                const response = await app.inject({
                    ...request,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                    },
                });

                expect(response.statusCode).toBe(426);
                expect(response.json()).toEqual({
                    error: "client-upgrade-required",
                    requirement: {
                        v: 1,
                        kind: "account-stored-content",
                        minimumProtocolVersion:
                            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    },
                });
                expect(response.body).not.toContain(marker);
            }
        });
    });

    it.each([
        {
            accountMode: "plain" as const,
            storedValue: Buffer.from(
                "released-e2ee-todo-ciphertext",
            ).toString("base64"),
        },
        {
            accountMode: "e2ee" as const,
            storedValue: encodeWireEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
        },
    ])("refuses $accountMode Account GET/list/bulk reads of the opposite Todo envelope mode", async ({
        accountMode,
        storedValue,
    }) => {
        const account = await seedAccount(accountMode);
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            for (const request of [
                { method: "GET" as const, url: "/v1/kv/todo.index" },
                { method: "GET" as const, url: "/v1/kv?prefix=todo." },
                {
                    method: "POST" as const,
                    url: "/v1/kv/bulk",
                    payload: { keys: ["todo.index"] },
                },
            ]) {
                const response = await app.inject({
                    ...request,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...CURRENT_HEADERS,
                    },
                });

                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "Invalid parameters",
                });
                expect(response.body).not.toContain(storedValue);
            }
        });
    });

    it.each([
        {
            name: "empty encrypted marker",
            storedValue: encodeWireEnvelope({ t: "encrypted", c: "" }),
        },
        {
            name: "future marker",
            storedValue: encodeWireEnvelope({
                t: "future",
                v: { undoneOrder: [] },
            }),
        },
        {
            name: "incomplete plain marker",
            storedValue: encodeWireEnvelope({ t: "plain" }),
        },
    ])("refuses E2EE GET/list/bulk disclosure of a $name", async ({
        storedValue,
    }) => {
        const account = await seedAccount("e2ee");
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            for (const request of [
                { method: "GET" as const, url: "/v1/kv/todo.index" },
                { method: "GET" as const, url: "/v1/kv?prefix=todo." },
                {
                    method: "POST" as const,
                    url: "/v1/kv/bulk",
                    payload: { keys: ["todo.index"] },
                },
            ]) {
                const response = await app.inject({
                    ...request,
                    headers: {
                        "x-test-user-id": account.id,
                        "content-type": "application/json",
                        ...CURRENT_HEADERS,
                    },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json()).toEqual({
                    error: "Invalid parameters",
                });
                expect(response.body).not.toContain(storedValue);
            }
        });
    });

    it.each([
        ...[
            {
                name: "empty encrypted marker",
                storedValue: encodeWireEnvelope({ t: "encrypted", c: "" }),
            },
            {
                name: "future marker",
                storedValue: encodeWireEnvelope({
                    t: "future",
                    v: { undoneOrder: [] },
                }),
            },
            {
                name: "incomplete plain marker",
                storedValue: encodeWireEnvelope({ t: "plain" }),
            },
        ].flatMap(({ name, storedValue }) => [
            {
                name,
                storedValue,
                operation: "overwrite",
                nextValue: Buffer.from(
                    "replacement-ciphertext",
                ).toString("base64"),
            },
            { name, storedValue, operation: "delete", nextValue: null },
        ]),
    ])("refuses a legacy E2EE $operation of a $name without changing storage", async ({
        storedValue,
        nextValue,
    }) => {
        const account = await seedAccount("e2ee");
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: nextValue,
                        version: 4,
                    }],
                },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                error: "Invalid parameters",
            });
        });

        const stored = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
            select: { value: true, version: true },
        });
        expect(stored?.version).toBe(4);
        expect(Buffer.from(stored?.value ?? []).toString("base64"))
            .toBe(storedValue);
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("admits a strict current encrypted Todo envelope for E2EE reads and mutation", async () => {
        const account = await seedAccount("e2ee");
        const storedValue = encodeWireEnvelope({
            t: "encrypted",
            c: "ciphertext-one",
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 0,
            },
        });

        await withKvApp(async (app) => {
            const read = await app.inject({
                method: "GET",
                url: "/v1/kv/todo.index",
                headers: {
                    "x-test-user-id": account.id,
                    ...CURRENT_HEADERS,
                },
            });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ value: storedValue, version: 0 });

            const nextValue = encodeWireEnvelope({
                t: "encrypted",
                c: "ciphertext-two",
            });
            const mutation = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: nextValue,
                        version: 0,
                    }],
                },
            });
            expect(mutation.statusCode).toBe(200);
        });
    });

    it("leaves unrelated generic KV opaque and available to legacy callers", async () => {
        const account = await seedAccount();
        const genericKeyAtTodoNamespaceBoundary = "todo.";
        const markerLookingValue = encodeWireEnvelope({
            t: "plain",
            v: { thisIsNotTodoState: true },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: genericKeyAtTodoNamespaceBoundary,
                value: Buffer.from(markerLookingValue, "base64"),
                version: 0,
            },
        });

        await withKvApp(async (app) => {
            const read = await app.inject({
                method: "GET",
                url: `/v1/kv/${genericKeyAtTodoNamespaceBoundary}`,
                headers: { "x-test-user-id": account.id },
            });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({
                key: genericKeyAtTodoNamespaceBoundary,
                value: markerLookingValue,
                version: 0,
            });

            const update = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: genericKeyAtTodoNamespaceBoundary,
                        value: markerLookingValue,
                        version: 0,
                    }],
                },
            });
            expect(update.statusCode).toBe(200);
        });
    });

    it("rejects the released stale Todo overwrite vector without changing bytes or version", async () => {
        const account = await seedAccount();
        const marker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: ["todo-1"], completedOrder: [] },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(marker, "base64"),
                version: 7,
            },
        });

        await withKvApp(async (app) => {
            // Immutable cli-v0.2.1/UI behavior decrypts a marker as empty and then
            // CAS-writes released ciphertext using the exact version it just read.
            const response = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: Buffer.from("released-link-unlink-ciphertext").toString("base64"),
                        version: 7,
                    }],
                },
            });

            expect(response.statusCode).toBe(426);
        });

        const stored = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
            select: { value: true, version: true },
        });
        expect(stored?.version).toBe(7);
        expect(Buffer.from(stored?.value ?? []).toString("base64")).toBe(marker);
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns upgrade-required instead of leaking marked bytes in a CAS conflict", async () => {
        const account = await seedAccount();
        const marker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(marker, "base64"),
                version: 3,
            },
        });

        await withKvApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: Buffer.from("released-ciphertext").toString("base64"),
                        version: 2,
                    }],
                },
            });

            expect(response.statusCode).toBe(426);
            expect(response.body).not.toContain(marker);
        });
    });

    it("requires a current caller for marked create and delete", async () => {
        const account = await seedAccount();
        const marker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });

        await withKvApp(async (app) => {
            const create = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: marker,
                        version: -1,
                    }],
                },
            });
            expect(create.statusCode).toBe(426);
        });
        await expect(db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
        })).resolves.toBeNull();

        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(marker, "base64"),
                version: 2,
            },
        });
        await withKvApp(async (app) => {
            const remove = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: null,
                        version: 2,
                    }],
                },
            });
            expect(remove.statusCode).toBe(426);
        });
        const storedAfterDelete = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
            select: { value: true, version: true },
        });
        expect(storedAfterDelete?.version).toBe(2);
        expect(Buffer.from(storedAfterDelete?.value ?? []).toString("base64")).toBe(marker);
    });

    it("matches new Todo values to Account mode and updates to persisted representation", async () => {
        const plainAccount = await seedAccount("plain");
        const e2eeAccount = await seedAccount("e2ee");
        const plainMarker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });
        await db.userKVStore.create({
            data: {
                accountId: plainAccount.id,
                key: "todo.index",
                value: Buffer.from(plainMarker, "base64"),
                version: 0,
            },
        });

        await withKvApp(async (app) => {
            const wrongCreate = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": e2eeAccount.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: plainMarker,
                        version: -1,
                    }],
                },
            });
            expect(wrongCreate.statusCode).toBe(400);

            const wrongUpdate = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": plainAccount.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: Buffer.from("legacy-ciphertext").toString("base64"),
                        version: 0,
                    }],
                },
            });
            expect(wrongUpdate.statusCode).toBe(400);

            const matchingCreate = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": plainAccount.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.todo-1",
                        value: encodeWireEnvelope({
                            t: "plain",
                            v: {
                                id: "todo-1",
                                title: "Current",
                                done: false,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        }),
                        version: -1,
                    }],
                },
            });
            expect(matchingCreate.statusCode).toBe(200);
        });
    });

    it.each([
        {
            accountMode: "plain" as const,
            storedValue: Buffer.from(
                "released-e2ee-todo-ciphertext",
            ).toString("base64"),
            nextValue: Buffer.from(
                "replacement-e2ee-todo-ciphertext",
            ).toString("base64"),
        },
        {
            accountMode: "e2ee" as const,
            storedValue: encodeWireEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            nextValue: encodeWireEnvelope({
                t: "plain",
                v: { undoneOrder: ["todo-1"], completedOrder: [] },
            }),
        },
        {
            accountMode: "e2ee" as const,
            storedValue: encodeWireEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            nextValue: null,
        },
    ])("refuses an existing-row mutation whose persisted Todo envelope mismatches a $accountMode Account", async ({
        accountMode,
        storedValue,
        nextValue,
    }) => {
        const account = await seedAccount(accountMode);
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: nextValue,
                        version: 4,
                    }],
                },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                error: "Invalid parameters",
            });
        });

        const stored = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
            select: { value: true, version: true },
        });
        expect(stored?.version).toBe(4);
        expect(Buffer.from(stored?.value ?? []).toString("base64"))
            .toBe(storedValue);
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("refuses Todo reads and mutations when E2EE Account currentness is invalid", async () => {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({
            data: {
                publicKey: Buffer.from(signing.publicKey).toString("hex"),
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        const storedValue = Buffer.from(
            "released-e2ee-todo-ciphertext",
        ).toString("base64");
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(storedValue, "base64"),
                version: 4,
            },
        });

        await withKvApp(async (app) => {
            const read = await app.inject({
                method: "GET",
                url: "/v1/kv/todo.index",
                headers: {
                    "x-test-user-id": account.id,
                    ...CURRENT_HEADERS,
                },
            });
            expect(read.statusCode).toBe(400);
            expect(read.body).not.toContain(storedValue);

            const mutation = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: Buffer.from(
                            "replacement-e2ee-todo-ciphertext",
                        ).toString("base64"),
                        version: 4,
                    }],
                },
            });
            expect(mutation.statusCode).toBe(400);
        });

        const stored = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: account.id,
                    key: "todo.index",
                },
            },
            select: { value: true, version: true },
        });
        expect(stored?.version).toBe(4);
        expect(Buffer.from(stored?.value ?? []).toString("base64"))
            .toBe(storedValue);
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("preserves released E2EE Todo behavior for a legacy caller", async () => {
        const account = await seedAccount("e2ee");
        const legacyValue = RELEASED_SECRETBOX_TODO_VALUE;

        await withKvApp(async (app) => {
            const create = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: legacyValue,
                        version: -1,
                    }],
                },
            });
            expect(create.statusCode).toBe(200);

            const read = await app.inject({
                method: "GET",
                url: "/v1/kv/todo.index",
                headers: { "x-test-user-id": account.id },
            });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({
                key: "todo.index",
                value: legacyValue,
                version: 0,
            });

            const remove = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: null,
                        version: 0,
                    }],
                },
            });
            expect(remove.statusCode).toBe(200);
        });
    });

    it("rejects a mixed bulk atomically without row, cursor, or event changes", async () => {
        const account = await seedAccount();
        const marker = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });
        await db.userKVStore.createMany({
            data: [
                {
                    accountId: account.id,
                    key: "todo.index",
                    value: Buffer.from(marker, "base64"),
                    version: 5,
                },
                {
                    accountId: account.id,
                    key: "preferences",
                    value: Buffer.from("before"),
                    version: 2,
                },
            ],
        });

        await withKvApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                },
                payload: {
                    mutations: [
                        {
                            key: "preferences",
                            value: Buffer.from("after").toString("base64"),
                            version: 2,
                        },
                        {
                            key: "todo.index",
                            value: Buffer.from("released-ciphertext").toString("base64"),
                            version: 5,
                        },
                    ],
                },
            });
            expect(response.statusCode).toBe(426);
        });

        const rows = await db.userKVStore.findMany({
            where: { accountId: account.id },
            orderBy: { key: "asc" },
            select: { key: true, value: true, version: true },
        });
        expect(rows.map((row) => ({
            key: row.key,
            value: Buffer.from(row.value ?? []).toString("base64"),
            version: row.version,
        }))).toEqual([
            {
                key: "preferences",
                value: Buffer.from("before").toString("base64"),
                version: 2,
            },
            { key: "todo.index", value: marker, version: 5 },
        ]);
        expect(markAccountChanged).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("allows a current caller to update and delete a marked Todo row", async () => {
        const account = await seedAccount();
        const initial = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: [], completedOrder: [] },
        });
        const updated = encodeWireEnvelope({
            t: "plain",
            v: { undoneOrder: ["todo-1"], completedOrder: [] },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: Buffer.from(initial, "base64"),
                version: 0,
            },
        });

        await withKvApp(async (app) => {
            const update = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: updated,
                        version: 0,
                    }],
                },
            });
            expect(update.statusCode).toBe(200);
            expect(update.json()).toEqual({
                success: true,
                results: [{ key: "todo.index", version: 1 }],
            });

            const remove = await app.inject({
                method: "POST",
                url: "/v1/kv",
                headers: {
                    "x-test-user-id": account.id,
                    "content-type": "application/json",
                    ...CURRENT_HEADERS,
                },
                payload: {
                    mutations: [{
                        key: "todo.index",
                        value: null,
                        version: 1,
                    }],
                },
            });
            expect(remove.statusCode).toBe(200);
            expect(remove.json()).toEqual({
                success: true,
                results: [{ key: "todo.index", version: 2 }],
            });
        });
    });
});
