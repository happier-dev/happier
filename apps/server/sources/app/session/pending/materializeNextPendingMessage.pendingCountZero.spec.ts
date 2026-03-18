import { describe, expect, it, vi } from "vitest";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const dbSessionFindUnique = vi.fn(async () => ({ encryptionMode: "e2ee", pendingCount: 0 }));
const dbSessionPendingMessageFindFirst = vi.fn(async () => null);
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: dbSessionFindUnique,
        },
        sessionPendingMessage: {
            findFirst: dbSessionPendingMessageFindFirst,
        },
    },
}));

const inTx = vi.fn(async () => {
    throw new Error("inTx should not be called when pendingCount is 0");
});
vi.mock("@/storage/inTx", () => ({
    inTx,
}));

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    it("returns didMaterialize=false without starting a transaction when pendingCount is 0", async () => {
        const { materializeNextPendingMessage } = await import("./materializeNextPendingMessage");

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(resolveSessionPendingOwnerAccess).toHaveBeenCalledTimes(1);
        expect(dbSessionFindUnique).toHaveBeenCalledTimes(1);
        expect(dbSessionPendingMessageFindFirst).toHaveBeenCalledTimes(1);
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false });
    });
});
