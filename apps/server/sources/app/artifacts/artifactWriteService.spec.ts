import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import type { Tx } from "@/storage/inTx";

type ArtifactTxFixture = {
    account: {
        findUnique: ReturnType<typeof vi.fn>;
    };
    artifact: {
        findUnique: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
    };
};

let txFixture: ArtifactTxFixture;
let currentTx: Tx;

function createArtifactTxFixture(): ArtifactTxFixture {
    return {
        account: {
            findUnique: vi.fn(),
        },
        artifact: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            delete: vi.fn(),
        },
    };
}

vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(fn: (tx: Tx) => Promise<T>) => await fn(currentTx),
}));

const markAccountChanged = vi.fn<(tx: Tx, params: { accountId: string; kind: "artifact"; entityId: string }) => Promise<number>>();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: (tx: Tx, params: { accountId: string; kind: "artifact"; entityId: string }) =>
        markAccountChanged(tx, params),
}));

import {
    createArtifact,
    createArtifactTx,
    deleteArtifact,
    updateArtifact,
} from "./artifactWriteService";

describe("artifactWriteService", () => {
    beforeEach(() => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        markAccountChanged.mockReset();
        txFixture = createArtifactTxFixture();
        currentTx = txFixture as unknown as Tx;
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
                supportsCurrentStoredContentProtocol: true,
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
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("is idempotent for same account (no write, no cursor)", async () => {
            const existing = {
                id: "a1",
                accountId: "u1",
                header: new Uint8Array([1]),
                headerVersion: 1,
                body: new Uint8Array([2]),
                bodyVersion: 1,
                dataEncryptionKey: new Uint8Array([3]),
                seq: 0,
                createdAt: new Date("2020-01-01T00:00:00.000Z"),
                updatedAt: new Date("2020-01-01T00:00:00.000Z"),
            };
            txFixture.artifact.findUnique.mockResolvedValue(existing);

            const res = await createArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: new Uint8Array([9]),
                body: new Uint8Array([9]),
                dataEncryptionKey: new Uint8Array([9]),
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.didWrite).toBe(false);
            if (res.didWrite !== false) throw new Error("expected didWrite false");
            expect(res.artifact.id).toBe("a1");
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
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
            expect(markAccountChanged).not.toHaveBeenCalled();
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
            expect(markAccountChanged).not.toHaveBeenCalled();
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
            markAccountChanged.mockResolvedValueOnce(1);

            const accepted = await createArtifact({
                actorUserId: "u1",
                artifactId: "plain",
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                supportsCurrentStoredContentProtocol: true,
            });
            expect(accepted.ok).toBe(true);
            expect(txFixture.artifact.create).toHaveBeenCalledOnce();
        });

        it("requires current stored-content support before a plain create or marked idempotent response", async () => {
            const plainHeader = artifactBytes(encodePlainArtifactStoredContent({ title: "plain" }));
            const plainBody = artifactBytes(encodePlainArtifactStoredContent({ body: "value" }));
            const marker = artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER);

            txFixture.artifact.findUnique.mockResolvedValueOnce(null);
            const rejectedCreate = await createArtifact({
                actorUserId: "u1",
                artifactId: "plain",
                header: plainHeader,
                body: plainBody,
                dataEncryptionKey: marker,
                supportsCurrentStoredContentProtocol: false,
            });
            expect(rejectedCreate).toEqual({ ok: false, error: "client-upgrade-required" });
            expect(txFixture.account.findUnique).not.toHaveBeenCalled();
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();

            txFixture.artifact.findUnique.mockResolvedValueOnce({
                id: "plain",
                accountId: "u1",
                header: plainHeader,
                headerVersion: 4,
                body: plainBody,
                bodyVersion: 7,
                dataEncryptionKey: marker,
                seq: 9,
                createdAt: new Date("2020-01-01T00:00:00.000Z"),
                updatedAt: new Date("2020-01-01T00:00:00.000Z"),
            });
            const rejectedExisting = await createArtifact({
                actorUserId: "u1",
                artifactId: "plain",
                header: plainHeader,
                body: plainBody,
                dataEncryptionKey: marker,
                supportsCurrentStoredContentProtocol: false,
            });
            expect(rejectedExisting).toEqual({ ok: false, error: "client-upgrade-required" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
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
                supportsCurrentStoredContentProtocol: true,
            });

            expect(result).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
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
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("updates via CAS and returns cursor + updated field versions", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: new Uint8Array([1]),
                headerVersion: 10,
                body: new Uint8Array([2]),
                bodyVersion: 20,
                dataEncryptionKey: new Uint8Array([3]),
            });
            txFixture.artifact.updateMany.mockResolvedValue({ count: 1 });
            markAccountChanged.mockResolvedValueOnce(123);

            const res = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: { bytes: new Uint8Array([9]), expectedVersion: 10 },
                body: { bytes: new Uint8Array([8]), expectedVersion: 20 },
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.cursor).toBe(123);
            expect(res.header?.version).toBe(11);
            expect(res.body?.version).toBe(21);
        });

        it("returns version-mismatch with current bytes", async () => {
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
                header: { bytes: new Uint8Array([9]), expectedVersion: 9 },
            });

            expect(res.ok).toBe(false);
            if (res.ok) throw new Error("expected mismatch");
            expect(res.error).toBe("version-mismatch");
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
                supportsCurrentStoredContentProtocol: true,
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

        it("requires current stored-content support before marked update or stale current-value exposure", async () => {
            const current = {
                id: "a1",
                seq: 5,
                header: artifactBytes(encodePlainArtifactStoredContent({ title: "plain" })),
                headerVersion: 10,
                body: artifactBytes(encodePlainArtifactStoredContent({ body: "value" })),
                bodyVersion: 20,
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            };
            txFixture.artifact.findFirst.mockResolvedValue(current);

            const rejected = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: artifactBytes(encodePlainArtifactStoredContent({ title: "updated" })),
                    expectedVersion: 9,
                },
                supportsCurrentStoredContentProtocol: false,
            });

            expect(rejected).toEqual({ ok: false, error: "client-upgrade-required" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("does not expose a newly marked row after a legacy update loses its CAS race", async () => {
            txFixture.artifact.findFirst
                .mockResolvedValueOnce({
                    id: "a1",
                    seq: 5,
                    header: new Uint8Array([1]),
                    headerVersion: 10,
                    body: new Uint8Array([2]),
                    bodyVersion: 20,
                    dataEncryptionKey: new Uint8Array([3]),
                })
                .mockResolvedValueOnce({
                    id: "a1",
                    header: artifactBytes(
                        encodePlainArtifactStoredContent({ title: "plain" }),
                    ),
                    headerVersion: 11,
                    body: artifactBytes(
                        encodePlainArtifactStoredContent({ body: "plain" }),
                    ),
                    bodyVersion: 21,
                    dataEncryptionKey: artifactBytes(
                        ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    ),
                });
            txFixture.artifact.updateMany.mockResolvedValue({ count: 0 });

            const rejected = await updateArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                header: {
                    bytes: new Uint8Array([9]),
                    expectedVersion: 10,
                },
                supportsCurrentStoredContentProtocol: false,
            });

            expect(rejected).toEqual({
                ok: false,
                error: "client-upgrade-required",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
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
                supportsCurrentStoredContentProtocol: true,
            });

            expect(result).toEqual({ ok: false, error: "invalid-params" });
            expect(txFixture.artifact.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
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
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("returns not-found when missing", async () => {
            txFixture.artifact.findFirst.mockResolvedValue(null);
            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: false, error: "not-found" });
        });

        it("deletes and marks change", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                dataEncryptionKey: new Uint8Array([3]),
            });
            markAccountChanged.mockResolvedValueOnce(77);

            const res = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "a1",
            });
            expect(res).toEqual({ ok: true, cursor: 77 });
            expect(txFixture.artifact.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
        });

        it("requires current stored-content support before deleting a marked Artifact", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                dataEncryptionKey: artifactBytes(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            });

            const rejected = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                supportsCurrentStoredContentProtocol: false,
            });
            expect(rejected).toEqual({
                ok: false,
                error: "client-upgrade-required",
            });
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(txFixture.artifact.delete).not.toHaveBeenCalled();

            markAccountChanged.mockResolvedValueOnce(77);
            const deleted = await deleteArtifact({
                actorUserId: "u1",
                artifactId: "a1",
                supportsCurrentStoredContentProtocol: true,
            });
            expect(deleted).toEqual({ ok: true, cursor: 77 });
            expect(markAccountChanged).toHaveBeenCalledOnce();
            expect(txFixture.artifact.delete).toHaveBeenCalledOnce();
        });
    });
});
