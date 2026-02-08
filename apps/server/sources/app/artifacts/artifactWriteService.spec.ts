import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

type ArtifactTxFixture = {
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

import { createArtifact, deleteArtifact, updateArtifact } from "./artifactWriteService";

describe("artifactWriteService", () => {
    beforeEach(() => {
        markAccountChanged.mockReset();
        txFixture = createArtifactTxFixture();
        currentTx = txFixture as unknown as Tx;
    });

    describe("createArtifact", () => {
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
    });

    describe("updateArtifact", () => {
        it("updates via CAS and returns cursor + updated field versions", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: new Uint8Array([1]),
                headerVersion: 10,
                body: new Uint8Array([2]),
                bodyVersion: 20,
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
    });

    describe("deleteArtifact", () => {
        it("returns not-found when missing", async () => {
            txFixture.artifact.findFirst.mockResolvedValue(null);
            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: false, error: "not-found" });
        });

        it("deletes and marks change", async () => {
            txFixture.artifact.findFirst.mockResolvedValue({ id: "a1" });
            markAccountChanged.mockResolvedValueOnce(77);

            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: true, cursor: 77 });
            expect(txFixture.artifact.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
        });
    });
});
