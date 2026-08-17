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
            findUnique: vi.fn(async ({ where }: any) =>
                rows.get(where.accountId_key.key) ?? null),
            create: vi.fn(async ({ data }: any) => {
                const row = { key: data.key, value: data.value, version: 0 };
                rows.set(data.key, row);
                return row;
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const current = rows.get(where.accountId_key.key);
                if (!current) throw new Error("missing UserKVStore row");
                const row = {
                    key: current.key,
                    value: data.value,
                    version: data.version,
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

describe("plugin declarative settings storage", () => {
    const originalDbProvider = process.env.HAPPIER_DB_PROVIDER;

    beforeEach(() => {
        // The narrow fake implements the Prisma fallback AccountChange write,
        // while the Settings mutation still exercises the SQLite Account fence.
        process.env.HAPPIER_DB_PROVIDER = "sqlite";
    });

    afterEach(() => {
        if (originalDbProvider === undefined) {
            delete process.env.HAPPIER_DB_PROVIDER;
        } else {
            process.env.HAPPIER_DB_PROVIDER = originalDbProvider;
        }
    });

    it("returns a mode-checked raw envelope and revision without server decryption", async () => {
        const { buildPluginDeclarativeSettingsPhysicalKey } = await import("./accountScopedKv");
        const { readPluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const envelope = { t: "plain", v: { v: 1, values: { theme: "dark" } } } as const;
        const { tx } = createTx({
            row: {
                key: buildPluginDeclarativeSettingsPhysicalKey("example.tasks"),
                value: encodeEnvelope(envelope),
                version: 4,
            },
        });

        await expect(readPluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({
            status: "present",
            revision: 4,
            envelope,
        });
    });

    it("rejects a mode-mismatched envelope before any CAS mutation", async () => {
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const { tx } = createTx({ mode: "plain" });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "encrypted", c: "opaque-ciphertext" },
        })).resolves.toEqual({ status: "account-mode-mismatch" });
        expect(tx.userKVStore.findUnique).not.toHaveBeenCalled();
        expect(tx.userKVStore.create).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("accepts an E2EE Settings ciphertext only in the declarative Settings cipher domain", async () => {
        const { sealAccountScopedBlobCiphertext } = await import("@happier-dev/protocol");
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_declarative_settings",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(41) },
            payload: { v: 1, values: { theme: "dark" } },
            randomBytes: (length) => new Uint8Array(length).fill(42),
        });
        const { tx } = createTx({ mode: "e2ee" });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "encrypted", c: ciphertext },
        })).resolves.toEqual({ status: "updated", revision: 0, cursor: 1 });
    });

    it("rejects an oversized correct-purpose E2EE Settings CAS candidate before storage mutation", async () => {
        const {
            PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1,
            sealAccountScopedBlobCiphertext,
        } = await import("@happier-dev/protocol");
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const seedCiphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_declarative_settings",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(51) },
            payload: { v: 1, values: {} },
            randomBytes: (length) => new Uint8Array(length).fill(52),
        });
        const minimumRawCiphertextBytes = 3 * Math.ceil(
            (PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes + 1) / 4,
        );
        const ciphertextBytes = Buffer.alloc(minimumRawCiphertextBytes);
        // The server can only structurally admit E2EE: V1 magic plus the
        // declarative Settings domain byte. It never opens client ciphertext.
        ciphertextBytes.set(Buffer.from(seedCiphertext, "base64").subarray(0, 2));
        const ciphertext = ciphertextBytes.toString("base64");
        expect(Buffer.byteLength(ciphertext, "utf8"))
            .toBeGreaterThan(PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes);
        const { tx } = createTx({ mode: "e2ee" });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "encrypted", c: ciphertext },
        })).resolves.toEqual({ status: "invalid-stored-content" });
        expect(tx.userKVStore.create).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("rejects an Account-KV ciphertext before an E2EE Settings candidate can mutate storage", async () => {
        const { sealAccountScopedBlobCiphertext } = await import("@happier-dev/protocol");
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_account_kv_private_payload",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(43) },
            payload: { v: 1, values: {} },
            randomBytes: (length) => new Uint8Array(length).fill(44),
        });
        const { tx } = createTx({ mode: "e2ee" });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "encrypted", c: ciphertext },
        })).resolves.toEqual({ status: "account-mode-mismatch" });
        expect(tx.userKVStore.findUnique).not.toHaveBeenCalled();
        expect(tx.userKVStore.create).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("acquires Account transition admission before inspecting a mode-bound Settings row", async () => {
        const { buildPluginDeclarativeSettingsPhysicalKey } = await import("./accountScopedKv");
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const { tx } = createTx({
            mode: "plain",
            row: {
                key: buildPluginDeclarativeSettingsPhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "plain", v: { v: 1, values: { theme: "light" } } }),
                version: 1,
            },
        });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 0,
            envelope: { t: "plain", v: { v: 1, values: { theme: "dark" } } },
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

    it("rejects a persisted plain envelope that is not the canonical bounded Settings values payload", async () => {
        const { buildPluginDeclarativeSettingsPhysicalKey } = await import("./accountScopedKv");
        const { readPluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const { tx } = createTx({
            row: {
                key: buildPluginDeclarativeSettingsPhysicalKey("example.tasks"),
                // This is raw database input, rather than an impossible typed
                // mutation request. The Protocol owner requires `{ v: 1, values }`.
                value: encodeEnvelope({ t: "plain", v: { theme: "dark" } }),
                version: 0,
            },
        });

        await expect(readPluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "invalid-stored-content" });
    });

    it("rejects a Collection ciphertext before an E2EE Settings read can disclose it", async () => {
        const { sealAccountScopedBlobCiphertext } = await import("@happier-dev/protocol");
        const { buildPluginDeclarativeSettingsPhysicalKey } = await import("./accountScopedKv");
        const { readPluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_collection_private_payload",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(45) },
            payload: { v: 1, values: {} },
            randomBytes: (length) => new Uint8Array(length).fill(46),
        });
        const { tx } = createTx({
            mode: "e2ee",
            row: {
                key: buildPluginDeclarativeSettingsPhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "encrypted", c: ciphertext }),
                version: 4,
            },
        });

        await expect(readPluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "account-mode-mismatch" });
    });

    it("rejects an existing other-purpose ciphertext before Settings CAS can replace it", async () => {
        const { sealAccountScopedBlobCiphertext } = await import("@happier-dev/protocol");
        const { buildPluginDeclarativeSettingsPhysicalKey } = await import("./accountScopedKv");
        const { mutatePluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(47) };
        const existingCiphertext = sealAccountScopedBlobCiphertext({
            kind: "account_settings",
            material,
            payload: { schemaVersion: 1 },
            randomBytes: (length) => new Uint8Array(length).fill(48),
        });
        const candidateCiphertext = sealAccountScopedBlobCiphertext({
            kind: "plugin_declarative_settings",
            material,
            payload: { v: 1, values: { theme: "dark" } },
            randomBytes: (length) => new Uint8Array(length).fill(49),
        });
        const { tx } = createTx({
            mode: "e2ee",
            row: {
                key: buildPluginDeclarativeSettingsPhysicalKey("example.tasks"),
                value: encodeEnvelope({ t: "encrypted", c: existingCiphertext }),
                version: 4,
            },
        });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 4,
            envelope: { t: "encrypted", c: candidateCiphertext },
        })).resolves.toEqual({ status: "account-mode-mismatch" });
        expect(tx.userKVStore.update).not.toHaveBeenCalled();
        expect(tx.accountChange.upsert).not.toHaveBeenCalled();
    });

    it("uses the shared CAS tombstone primitive and emits one content-free settings invalidation", async () => {
        const { mutatePluginDeclarativeSettingsInTx, readPluginDeclarativeSettingsInTx } = await import("./pluginDeclarativeSettingsStorage");
        const { tx } = createTx();

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "plain", v: { v: 1, values: { theme: "dark" } } },
        })).resolves.toEqual({ status: "updated", revision: 0, cursor: 1 });

        expect(tx.accountChange.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-1",
                    kind: "pluginDomain",
                    entityId: "pluginDomain/example.tasks/settings",
                },
            },
            create: expect.objectContaining({
                hint: {
                    pluginDomain: "settings",
                    pluginId: "example.tasks",
                    scope: "account",
                    revision: 0,
                },
            }),
        }));

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: 0,
            envelope: null,
        })).resolves.toEqual({ status: "updated", revision: 1, cursor: 2 });
        await expect(readPluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
        })).resolves.toEqual({ status: "deleted", revision: 1 });

        await expect(mutatePluginDeclarativeSettingsInTx(tx as any, {
            accountId: "account-1",
            pluginId: "example.tasks",
            expectedRevision: "absent",
            envelope: { t: "plain", v: { v: 1, values: { theme: "light" } } },
        })).resolves.toEqual({ status: "conflict", revision: 1 });
    });
});
