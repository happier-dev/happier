import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { mutatePluginAccountStorage, readPluginAccountStorageInTx } from "./pluginAccountStorage";
import { mutatePluginDeclarativeSettings } from "./pluginDeclarativeSettingsStorage";
import { mutateAuthoringMemory } from "./authoringMemoryStorage";
import { buildAuthoringMemoryPhysicalKey, buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey } from "./accountScopedKv";

import { createPrismaTransactionBoundary } from "../api/testkit/txHarness";

const transaction = vi.hoisted(() => vi.fn());
const readCommittedRow = vi.hoisted(() => vi.fn());

vi.mock("@/storage/db", () => ({ db: { $transaction: transaction,
    userKVStore: { findUnique: readCommittedRow } } }));

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
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        }),
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
            findMany: vi.fn(async (input: { where: { key: { in: string[] } } }) =>
                input.where.key.in.flatMap(key => rows.has(key) ? [rows.get(key)!] : [])),
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
            updateMany: vi.fn(async (input: {
                where: { key: string; version: number };
                data: { value: Uint8Array | null; version: number };
            }) => {
                const current = rows.get(input.where.key);
                if (!current || current.version !== input.where.version) return { count: 0 };
                const row = {
                    key: current.key,
                    value: input.data.value,
                    version: input.data.version,
                };
                rows.set(current.key, row);
                return { count: 1 };
            }),
        },
        accountChange: {
            upsert: vi.fn(async () => ({})),
        },
    };
    transaction.mockImplementation(createPrismaTransactionBoundary(() => tx));
    readCommittedRow.mockImplementation(tx.userKVStore.findUnique);
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
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "encrypted", c: "opaque-ciphertext" }),
                version: 4,
            },
        });

        await expect(mutatePluginAccountStorage({
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 4,
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "account-mode-mismatch" });
        expect(tx.userKVStore.updateMany).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("rejects another Account-scoped ciphertext domain before an E2EE read can disclose it", async () => {
        const {
            sealAccountScopedBlobCiphertext,
        } = await import("@happier-dev/protocol");
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
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
        // 512 KiB plaintext row + 42 bytes of Account-scoped cipher framing encodes to 699,108 base64 bytes.
        // One additional decoded byte crosses the next padded-base64 block (699,112 bytes).
        const oversizedCiphertextBytes = Buffer.alloc(524_332);
        oversizedCiphertextBytes[0] = 0xa1;
        oversizedCiphertextBytes[1] = 18;
        const { tx } = createTx({ mode: "e2ee" });

        await expect(mutatePluginAccountStorage({
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: {
                t: "encrypted",
                c: oversizedCiphertextBytes.toString("base64"),
            },
        })).resolves.toEqual({ status: "invalid-stored-content" });
        expect(tx.userKVStore.create).not.toHaveBeenCalled();
        expect(tx.userKVStore.updateMany).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("acquires Account transition admission before inspecting a mode-bound Account-KV row", async () => {
        const { buildPluginAccountStoragePhysicalKey } = await import("./accountScopedKv");
        const { tx } = createTx({
            row: {
                key: buildPluginAccountStoragePhysicalKey("example.tasks"),
                value: encodeEnvelope(plainEnvelope),
                version: 1,
            },
        });

        await expect(mutatePluginAccountStorage({
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
            tx.userKVStore.findMany.mock.invocationCallOrder[0],
        );
    });

    it.each(['account-kv', 'settings', 'authoring-memory'] as const)("returns the committed revision after a late %s CAS refusal leaves the transaction", async domain => {
        const key = domain === 'account-kv' ? buildPluginAccountStoragePhysicalKey('example.tasks')
            : domain === 'settings' ? buildPluginDeclarativeSettingsPhysicalKey('example.tasks')
            : buildAuthoringMemoryPhysicalKey('lastUsedProfile');
        const { tx, rows } = createTx({ row: { key, value: null, version: 1 } });
        let transactionFinished = false;
        transaction.mockImplementationOnce(async (callback: (transactionTx: typeof tx) => Promise<unknown>) => {
            try { return await callback(tx); }
            finally { transactionFinished = true; }
        });
        // A peer commits its tombstone after admission, so this database CAS loses.
        tx.userKVStore.updateMany.mockImplementationOnce(async () => {
            rows.set(key, { key, value: null, version: 2 });
            return { count: 0 };
        });
        readCommittedRow.mockImplementationOnce(async () => {
            expect(transactionFinished).toBe(true);
            return rows.get(key);
        });
        const input = { accountId: 'account-1', pluginId: 'example.tasks', expectedRevision: 1, envelope: null };
        const result = domain === 'account-kv' ? mutatePluginAccountStorage(input)
            : domain === 'settings' ? mutatePluginDeclarativeSettings(input)
            : mutateAuthoringMemory({ accountId: input.accountId, key: 'lastUsedProfile', expectedRevision: 1, envelope: null });
        await expect(result).resolves.toEqual({ status: 'conflict', revision: 2 });
        expect(rows.get(key)).toEqual({ key, value: null, version: 2 });
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("uses the shared row CAS tombstone primitive and emits one content-free data-KV invalidation", async () => {
        const { tx } = createTx();

        await expect(mutatePluginAccountStorage({
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

        await expect(mutatePluginAccountStorage({
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 0,
            envelope: null,
        })).resolves.toEqual({ status: "updated", revision: 1, cursor: 2 });
        await expect(readPluginAccountStorageInTx(tx as never, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "deleted", revision: 1 });

        await expect(mutatePluginAccountStorage({
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: plainEnvelope,
        })).resolves.toEqual({ status: "conflict", revision: 1 });
    });
});
