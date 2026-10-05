import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import type { Tx } from "@/storage/inTx";
import { createInTxHarness } from "@/app/api/testkit/txHarness";

type ArtifactTxFixture = {
    account: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    accountChange: { upsert: ReturnType<typeof vi.fn> };
    artifactRevision: {
        create: ReturnType<typeof vi.fn>;
        findMany: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
    };
    artifactBlob: {
        findMany: ReturnType<typeof vi.fn>;
        findUnique: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
    };
    artifact: {
        findUnique: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
    };
};

let txFixture: ArtifactTxFixture;
let currentTx: Tx;

function createArtifactTxFixture(): ArtifactTxFixture {
    return {
        account: {
            findUnique: vi.fn(),
            update: vi.fn().mockResolvedValue({ seq: 1 }),
        },
        accountChange: { upsert: vi.fn().mockResolvedValue({}) },
        artifactRevision: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        artifactBlob: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null),
            findFirst: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        artifact: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            delete: vi.fn(),
            deleteMany: vi.fn(),
        },
    };
}

vi.mock("@/storage/inTx", () => createInTxHarness(() => currentTx));

import {
    createArtifact,
    createArtifactTx,
    deleteArtifact,
    updateArtifact,
} from "./artifactWriteService";

describe("artifactWriteService", () => {
    beforeEach(() => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        txFixture = createArtifactTxFixture();
        txFixture.account.findUnique.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        // Persistent queries return the owner/grant joins required by the real
        // access and audience owners; no internal domain service is mocked.
        currentTx = {
            ...txFixture,
            __afterTxCallbacks: [],
            artifact: { ...txFixture.artifact, findFirst: async (...args: unknown[]) => {
                const row = await txFixture.artifact.findFirst(...args);
                if (!row) return row;
                const accountId = row.accountId ?? "u1";
                return { ...row, accountId,
                    account: row.account ?? await txFixture.account.findUnique({ where: { id: accountId } }),
                    accountGrants: row.accountGrants ?? [], teamGrants: row.teamGrants ?? [], groupGrants: row.groupGrants ?? [],
                };
            } },
        } as unknown as Tx;
    });

    const artifactBytes = (value: string): Uint8Array => privacyKit.decodeBase64(value);

    describe("createArtifact", () => {
        it("lets a qualified transaction owner publish its one domain change instead of a generic Artifact change", async () => {
            const header = artifactBytes(
                encodePlainArtifactStoredContent({ title: "plugin UI" }),
            );
            const body = artifactBytes(
                encodePlainArtifactStoredContent({ body: "archive" }),
            );
            const dataEncryptionKey = artifactBytes(
                ARTIFACT_PLAIN_DATA_KEY_MARKER,
            );
            txFixture.artifact.findUnique.mockResolvedValue(null);
            txFixture.account.findUnique.mockResolvedValue({
                encryptionMode: "plain",
                publicKey: null,
                contentPublicKey: null,
                contentPublicKeySig: null,
            });
            txFixture.artifact.create.mockResolvedValue({
                id: "plugin-ui-archive",
                header,
                headerVersion: 1,
                body,
                bodyVersion: 1,
                dataEncryptionKey,
                seq: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const markQualifiedChange = vi.fn(async () => 77);

            const result = await createArtifactTx(currentTx, {
                actorUserId: "u1",
                artifactId: "plugin-ui-archive",
                header,
                body,
                dataEncryptionKey,
                markChanged: markQualifiedChange,
            });

            expect(result).toMatchObject({
                ok: true,
                didWrite: true,
                cursor: 77,
            });
            expect(markQualifiedChange).toHaveBeenCalledWith(
                "plugin-ui-archive",
            );
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("is idempotent for same account (no write, no cursor)", async () => {
            const header = artifactBytes(encodePlainArtifactStoredContent({ title: "existing" }));
            const body = artifactBytes(encodePlainArtifactStoredContent({ body: "existing" }));
            const dataEncryptionKey = artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER);
            const existing = {
                id: "a1",
                accountId: "u1",
                header,
                headerVersion: 1,
                body,
                bodyVersion: 1,
                dataEncryptionKey,
                seq: 0,
                createdAt: new Date("2020-01-01T00:00:00.000Z"),
                updatedAt: new Date("2020-01-01T00:00:00.000Z"),
            };
            txFixture.artifact.findUnique.mockResolvedValue(existing);

            const res = await createArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header,
                body,
                dataEncryptionKey,
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.didWrite).toBe(false);
            if (res.didWrite !== false) throw new Error("expected didWrite false");
            expect(res.artifact.id).toBe("a1");
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("does not expose a classified plugin UI archive through generic create idempotency", async () => {
            txFixture.artifact.findUnique.mockResolvedValue({
                id: "plugin-ui-archive",
                accountId: "u1",
                header: new Uint8Array([1]),
                headerVersion: 1,
                body: new Uint8Array([2]),
                bodyVersion: 1,
                dataEncryptionKey: new Uint8Array([3]),
                seq: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                pluginUiArtifact: { artifactId: "plugin-ui-archive" },
            });

            const result = await createArtifact({
                actorUserId: "u1",
                artifactId: "plugin-ui-archive",
                header: new Uint8Array([9]),
                body: new Uint8Array([9]),
                dataEncryptionKey: new Uint8Array([9]),
            });

            expect(result).toEqual({ ok: false, error: "conflict" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("does not expose a classified package-asset archive through generic create idempotency", async () => {
            txFixture.artifact.findUnique.mockResolvedValue({
                id: "plugin-package-assets",
                accountId: "u1",
                header: new Uint8Array([1]),
                headerVersion: 1,
                body: new Uint8Array([2]),
                bodyVersion: 1,
                dataEncryptionKey: new Uint8Array([3]),
                seq: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                pluginUiArtifact: null,
                packageAssetRelease: {
                    accountId: "u1",
                    pluginId: "com.acme.assets",
                },
            });

            const result = await createArtifact({
                actorUserId: "u1",
                artifactId: "plugin-package-assets",
                header: new Uint8Array([9]),
                body: new Uint8Array([9]),
                dataEncryptionKey: new Uint8Array([9]),
            });

            expect(result).toEqual({ ok: false, error: "conflict" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("fails with conflict when artifact id exists on another account", async () => {
            txFixture.artifact.findUnique.mockResolvedValue({
                id: "a1",
                accountId: "someone-else",
                header: new Uint8Array([]),
                headerVersion: 1,
                body: new Uint8Array([]),
                bodyVersion: 1,
                dataEncryptionKey: new Uint8Array([]),
                seq: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const res = await createArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: new Uint8Array([9]),
                body: new Uint8Array([9]),
                dataEncryptionKey: new Uint8Array([9]),
            });

            expect(res).toEqual({ ok: false, error: "conflict" });
        });

        it("accepts only the Artifact representation matching the account mode before create", async () => {
            txFixture.artifact.findUnique.mockResolvedValue(null);
            txFixture.account.findUnique.mockResolvedValue({
                encryptionMode: "plain",
                publicKey: null,
            });

            const rejected = await createArtifact({
                actorUserId: "u1",
                artifactId: "encrypted-on-plain",
                header: new Uint8Array([1]),
                body: new Uint8Array([2]),
                dataEncryptionKey: new Uint8Array([3]),
            });
            expect(rejected).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();

            txFixture.artifact.create.mockResolvedValue({
                id: "plain",
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                headerVersion: 1,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                bodyVersion: 1,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                seq: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            txFixture.account.update.mockResolvedValueOnce({ seq: 1 });

            const accepted = await createArtifact({
                actorUserId: "u1",
                artifactId: "plain",
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });
            expect(accepted.ok).toBe(true);
            expect(txFixture.artifact.create).toHaveBeenCalledOnce();
        });

        it("rejects an omitted plain Artifact value before persistence", async () => {
            txFixture.artifact.findUnique.mockResolvedValue(null);
            txFixture.account.findUnique.mockResolvedValue({
                encryptionMode: "plain",
                publicKey: null,
                contentPublicKey: null,
                contentPublicKeySig: null,
            });
            const malformedPlainEnvelope = new TextEncoder().encode(
                JSON.stringify({ t: "plain" }),
            );

            const result = await createArtifact({
                actorUserId: "u1",
                artifactId: "malformed-plain",
                header: malformedPlainEnvelope,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "valid" })),
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            expect(result).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });
    });

    describe("updateArtifact", () => {
        it("does not make a classified plugin UI archive mutable through the generic writer", async () => {
            txFixture.artifact.findFirst.mockImplementation(async (input: Readonly<{
                where: Readonly<{
                    pluginUiArtifact?: Readonly<{ is: null }>;
                    packageAssetRelease?: Readonly<{ is: null }>;
                }>;
            }>) => (
                input.where.pluginUiArtifact?.is === null
                    && input.where.packageAssetRelease?.is === null
                    ? null
                    : {
                        id: "plugin-ui-archive",
                        seq: 5,
                        header: new Uint8Array([1]),
                        headerVersion: 1,
                        body: new Uint8Array([2]),
                        bodyVersion: 1,
                        dataEncryptionKey: new Uint8Array([3]),
                    }
            ));

            const result = await updateArtifact({
                actorUserId: "u1",
                artifactId: "plugin-ui-archive",
                header: { bytes: new Uint8Array([9]), expectedVersion: 1 },
            });

            expect(result).toEqual({ ok: false, error: "not-found" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("updates via CAS and returns cursor + updated field versions", async () => {
            const header = artifactBytes(encodePlainArtifactStoredContent({ title: "current" }));
            const body = artifactBytes(encodePlainArtifactStoredContent({ body: "current" }));
            const dataEncryptionKey = artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER);
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header,
                headerVersion: 10,
                body,
                bodyVersion: 20,
                dataEncryptionKey,
            });
            txFixture.artifact.updateMany.mockResolvedValue({ count: 1 });
            txFixture.account.update.mockResolvedValueOnce({ seq: 123 });

            const res = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: artifactBytes(encodePlainArtifactStoredContent({ title: "updated" })),
                    expectedVersion: 10,
                },
                body: {
                    bytes: artifactBytes(encodePlainArtifactStoredContent({ body: "updated" })),
                    expectedVersion: 20,
                },
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.cursor).toBe(123);
            expect(res.header?.version).toBe(11);
            expect(res.body?.version).toBe(21);
        });

        it("returns version-mismatch with current bytes", async () => {
            const header = artifactBytes(encodePlainArtifactStoredContent({ title: "current" }));
            const body = artifactBytes(encodePlainArtifactStoredContent({ body: "current" }));
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header,
                headerVersion: 10,
                body,
                bodyVersion: 20,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            const res = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: artifactBytes(encodePlainArtifactStoredContent({ title: "updated" })),
                    expectedVersion: 9,
                },
            });

            expect(res.ok).toBe(false);
            if (res.ok) throw new Error("expected mismatch");
            expect(res.error).toBe("version-mismatch");
            if (res.error !== "version-mismatch") throw new Error("expected mismatch");
            expect(res.current?.headerVersion).toBe(10);
        });

        it("rejects non-plain updates to an Artifact whose persisted marker is plain", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                headerVersion: 10,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                bodyVersion: 20,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            const res = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: { bytes: new Uint8Array([9]), expectedVersion: 10 },
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
        });

        it("rejects explicit plain updates to an Artifact whose persisted marker is encrypted", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: new Uint8Array([1]),
                headerVersion: 10,
                body: new Uint8Array([2]),
                bodyVersion: 20,
                dataEncryptionKey: new Uint8Array([3]),
            });

            const res = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                    expectedVersion: 10,
                },
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
        });

        it("returns the current valid row after an update loses its CAS race", async () => {
            const initial = {
                id: "a1", seq: 5,
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "before" })), headerVersion: 10,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "before" })), bodyVersion: 20,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            };
            txFixture.artifact.findFirst
                .mockResolvedValueOnce(initial) // authorized cleanup admission
                .mockResolvedValueOnce(initial) // live owner/grant lookup
                .mockResolvedValueOnce(initial) // pre-CAS content read
                .mockResolvedValueOnce({ ...initial, headerVersion: 11, bodyVersion: 21 });
            txFixture.artifact.updateMany.mockResolvedValue({ count: 0 });
            const rejected = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: artifactBytes(
                        encodePlainArtifactStoredContent({ title: "attempted" }),
                    ),
                    expectedVersion: 10,
                },
            });

            expect(rejected).toMatchObject({
                ok: false,
                error: "version-mismatch",
                current: {
                    headerVersion: 11,
                    bodyVersion: 21,
                },
            });
            expect(txFixture.artifact.updateMany).toHaveBeenCalledOnce();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("rejects an omitted plain Artifact update value without mutation", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                headerVersion: 10,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                bodyVersion: 20,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            const result = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: new TextEncoder().encode(JSON.stringify({ t: "plain" })),
                    expectedVersion: 10,
                },
            });

            expect(result).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });
    });

    describe("deleteArtifact", () => {
        it("does not delete a classified plugin UI archive through the generic writer", async () => {
            txFixture.artifact.findFirst.mockImplementation(async (input: Readonly<{
                where: Readonly<{
                    pluginUiArtifact?: Readonly<{ is: null }>;
                    packageAssetRelease?: Readonly<{ is: null }>;
                }>;
            }>) => (
                input.where.pluginUiArtifact?.is === null
                    && input.where.packageAssetRelease?.is === null
                    ? null
                    : {
                        id: "plugin-ui-archive",
                        dataEncryptionKey: new Uint8Array([3]),
                    }
            ));

            const result = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "plugin-ui-archive",
            });

            expect(result).toEqual({ ok: false, error: "not-found" });
            expect(txFixture.artifact.delete).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("returns not-found when missing", async () => {
            txFixture.artifact.findFirst.mockResolvedValue(null);
            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: false, error: "not-found" });
        });

        it("does not delete a plaintext-marked Artifact from an E2EE Account", async () => {
            txFixture.account.findUnique.mockResolvedValue({
                encryptionMode: "e2ee",
                publicKey: new Uint8Array([1]),
                contentPublicKey: new Uint8Array([2]),
                contentPublicKeySig: new Uint8Array([3]),
            });
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            const result = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "a1",
            });

            expect(result).toEqual({ ok: false, error: "internal" });
            expect(txFixture.artifact.delete).not.toHaveBeenCalled();
            expect(txFixture.accountChange.upsert).not.toHaveBeenCalled();
        });

        it("deletes and marks change", async () => {
            let deleted = false;
            let deletedAt: Date | null = null;
            txFixture.artifact.findFirst.mockImplementation(async () => deleted ? null : {
                id: "a1", dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                headerVersion: 1, bodyVersion: 1, blobs: [], deletedAt,
            });
            txFixture.artifact.updateMany.mockImplementation(async (input: { data: { deletedAt: Date } }) => {
                deletedAt = input.data.deletedAt;
                return { count: 1 };
            });
            txFixture.artifact.deleteMany.mockImplementation(async () => { deleted = true; return { count: 1 }; });
            txFixture.account.update.mockResolvedValueOnce({ seq: 77 });

            const res = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "a1",
            });
            expect(res).toEqual({ ok: true, cursor: 77 });
            expect(deleted).toBe(true);
            expect(deletedAt).toBeInstanceOf(Date);
        });

    });
});
