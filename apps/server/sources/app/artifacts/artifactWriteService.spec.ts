import { beforeEach, describe, expect, it, vi } from "vitest";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: any) => await fn(currentTx),
}));

const markAccountChanged = vi.fn();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: (...args: any[]) => markAccountChanged(...args),
}));

import { createArtifact, deleteArtifact, updateArtifact } from "./artifactWriteService";

describe("artifactWriteService", () => {
    beforeEach(() => {
        markAccountChanged.mockReset();

        currentTx = {
            artifact: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                updateMany: vi.fn(),
                delete: vi.fn(),
            },
        };
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
            currentTx.artifact.findUnique.mockResolvedValue(existing);

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
            expect(currentTx.artifact.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("fails with conflict when artifact id exists on another account", async () => {
            currentTx.artifact.findUnique.mockResolvedValue({
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
            currentTx.artifact.findFirst.mockResolvedValue({
                id: "a1",
                seq: 5,
                header: new Uint8Array([1]),
                headerVersion: 10,
                body: new Uint8Array([2]),
                bodyVersion: 20,
            });
            currentTx.artifact.updateMany.mockResolvedValue({ count: 1 });
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
            currentTx.artifact.findFirst.mockResolvedValue({
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
            currentTx.artifact.findFirst.mockResolvedValue(null);
            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: false, error: "not-found" });
        });

        it("deletes and marks change", async () => {
            currentTx.artifact.findFirst.mockResolvedValue({ id: "a1" });
            markAccountChanged.mockResolvedValueOnce(77);

            const res = await deleteArtifact({ actorUserId: "u1", artifactId: "a1" });
            expect(res).toEqual({ ok: true, cursor: 77 });
            expect(currentTx.artifact.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
        });
    });
});

