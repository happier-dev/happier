import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { createInTxHarness } from "../api/testkit/txHarness";

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({}));
    return { inTx, afterTx };
});

type StoredRow = Readonly<{
    key: string;
    value: Uint8Array | null;
    version: number;
}>;

function encodeEnvelope(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

function encodeEnvelopeWithMalformedUtf8(): Uint8Array {
    const prefix = new TextEncoder().encode(
        '{"t":"plain","v":{"v":1,"values":{"selected-project":{"version":0,"value":"',
    );
    const suffix = new TextEncoder().encode('"}}}}');
    return Uint8Array.from([...prefix, 0xff, ...suffix]);
}

function createE2eeAccount() {
    const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const content = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(23));
    return {
        encryptionMode: "e2ee" as const,
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: content.publicKey,
        contentPublicKeySig: tweetnacl.sign.detached(
            Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(content.publicKey),
            ]),
            signing.secretKey,
        ),
    };
}

function createTx(options: Readonly<{
    mode?: "plain" | "e2ee";
    row?: StoredRow | null;
}> = {}) {
    const rows = new Map<string, StoredRow>();
    if (options.row) rows.set(options.row.key, options.row);
    let sequence = 0;
    const account = options.mode === "e2ee"
        ? createE2eeAccount()
        : {
            encryptionMode: "plain" as const,
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        };
    const tx = {
        __afterTxCallbacks: [],
        $executeRawUnsafe: vi.fn(async () => 1),
        $queryRawUnsafe: vi.fn(async () => [{ id: "account-1" }]),
        account: {
            findUnique: vi.fn(async () => account),
            update: vi.fn(async () => ({ seq: ++sequence })),
        },
        userKVStore: {
            findUnique: vi.fn(async (input: {
                where: { accountId_key: { key: string } };
            }) => rows.get(input.where.accountId_key.key) ?? null),
            create: vi.fn(async (input: {
                data: { key: string; value: Uint8Array | null };
            }) => {
                const row = { key: input.data.key, value: input.data.value, version: 0 };
                rows.set(input.data.key, row);
                return row;
            }),
            update: vi.fn(async (input: {
                where: { accountId_key: { key: string } };
                data: { value: Uint8Array | null; version: number };
            }) => {
                const current = rows.get(input.where.accountId_key.key);
                if (!current) throw new Error("missing UserKVStore row");
                const row = {
                    key: current.key,
                    value: input.data.value,
                    version: input.data.version,
                };
                rows.set(current.key, row);
                return row;
            }),
        },
        accountChange: {
            upsert: vi.fn(async () => ({})),
        },
    };
    return { tx, rows };
}

describe("plugin Account KV storage", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;

    beforeEach(() => {
        // The narrow fake implements the Prisma fallback AccountChange write,
        // while the Account-KV mutation still exercises the SQLite Account fence.
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
    });

    afterEach(() => {
        if (originalDbProvider === undefined) {
            delete process.env.HAPPIER_DB_PROVIDER;
        } else {
            process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        }
    });

    const plainEnvelope = {
        t: "plain",
        v: {
            v: 1,
            values: {
                "selected-project": { version: 0, value: { id: "project-1" } },
            },
        },
    } as const;

    const plainEnvelopeWithRetainedLogicalTombstone = {
        t: "plain",
        v: {
            v: 1,
            values: {
                "selected-project": { version: 0, value: { id: "project-1" } },
                "retired-project": { version: 3, deleted: true },
            },
        },
    } as const;

    it("reads one bounded, mode-checked plugin row without exposing its physical key", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { readPluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope(plainEnvelope),
                version: 4,
            },
        });

        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({
            status: "present",
            revision: 4,
            envelope: plainEnvelope,
        });
    });

    it("retains a logical tombstone as valid opaque Account-row content", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { readPluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope(plainEnvelopeWithRetainedLogicalTombstone),
                version: 5,
            },
        });

        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({
            status: "present",
            revision: 5,
            envelope: plainEnvelopeWithRetainedLogicalTombstone,
        });
    });

    it("rejects malformed UTF-8 bytes instead of coercing them into a valid Account-KV envelope", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { readPluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelopeWithMalformedUtf8(),
                version: 5,
            },
        });

        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "invalid-stored-content" });
    });

    it("rejects a mode-mismatched row before a stale client can overwrite it", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { mutatePluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "encrypted", c: "opaque-ciphertext" }),
                version: 4,
            },
        });

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 4,
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "account-mode-mismatch" });
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("rejects another Account-scoped ciphertext domain before an E2EE read can disclose it", async () => {
        const {
            sealAccountScopedBlobCiphertext,
        } = await import("@happier-dev/protocol");
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { readPluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const material = {
            type: "dataKey" as const,
            machineKey: new Uint8Array(32).fill(29),
        };
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_collection_private_payload",
            material,
            payload: { v: 1, values: {} },
            randomBytes: (length) => new Uint8Array(length).fill(31),
        });
        const { tx } = createTx({
            mode: "e2ee",
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "encrypted", c: ciphertext }),
                version: 4,
            },
        });

        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "account-mode-mismatch" });
    });

    it("rejects an oversized E2EE ciphertext before it reaches the shared UserKV mutation", async () => {
        const { mutatePluginAccountStorageInTx } = await import("./pluginAccountStorage");
        // 512 KiB plaintext row + 42 bytes of Account-scoped cipher framing encodes to 699,108 base64 bytes.
        // One additional decoded byte crosses the next padded-base64 block (699,112 bytes).
        const oversizedCiphertextBytes = Buffer.alloc(524_332);
        oversizedCiphertextBytes[0] = 0xa1;
        oversizedCiphertextBytes[1] = 18;
        const { tx } = createTx({ mode: "e2ee" });

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: {
                t: "encrypted",
                c: oversizedCiphertextBytes.toString("base64"),
            },
        })).resolves.toEqual({ status: "invalid-stored-content" });
        expect(tx.userKVStore.create).not.toHaveBeenCalled();
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("acquires Account transition admission before inspecting a mode-bound Account-KV row", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { mutatePluginAccountStorageInTx } = await import("./pluginAccountStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope(plainEnvelope),
                version: 1,
            },
        });

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 0,
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "conflict", revision: 1 });

        const admissionCallOrder = [
            ...tx.$executeRawUnsafe.mock.invocationCallOrder,
            ...tx.$queryRawUnsafe.mock.invocationCallOrder,
        ];
        expect(admissionCallOrder).toHaveLength(1);
        expect(admissionCallOrder[0]).toBeLessThan(
            tx.userKVStore.findUnique.mock.invocationCallOrder[0],
        );
    });

    it("uses the shared row CAS tombstone primitive and emits one content-free data-KV invalidation", async () => {
        const {
            mutatePluginAccountStorageInTx,
            readPluginAccountStorageInTx,
        } = await import("./pluginAccountStorage");
        const { tx } = createTx();

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "updated", revision: 0, cursor: 1 });

        expect(tx.accountChange.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-1",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/example.tasks/data-kv",
                },
            },
            create: expect.objectContaining({
                hint: {
                    pluginDomain: "dataKv",
                    pluginId: "example.tasks",
                    full: true,
                },
            }),
        }));

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 0,
            envelope: null,
        })).resolves.toEqual({ status: "updated", revision: 1, cursor: 2 });
        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "deleted", revision: 1 });

        await expect(mutatePluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "conflict", revision: 1 });
    });
});
