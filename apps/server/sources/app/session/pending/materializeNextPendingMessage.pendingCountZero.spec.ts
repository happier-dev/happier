import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionPendingMessage: ["findFirst"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const txSessionFindUniqueOrThrow = vi.fn();
const txSessionUpdate = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionPendingMessageFindFirst = vi.fn();
const tx = {
    session: {
        findUniqueOrThrow: txSessionFindUniqueOrThrow,
        update: txSessionUpdate,
        updateMany: txSessionUpdateMany,
    },
    sessionPendingMessage: {
        findFirst: txSessionPendingMessageFindFirst,
    },
};
const inTx = vi.fn(async <T>(run: (txArg: typeof tx) => Promise<T>) => run(tx));
vi.mock("@/storage/inTx", () => ({
    inTx,
}));

let materializeNextPendingMessage: typeof import("./materializeNextPendingMessage").materializeNextPendingMessage;

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    beforeAll(async () => {
        ({ materializeNextPendingMessage } = await import("./materializeNextPendingMessage"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionUpdate.mockReset();
        txSessionUpdateMany.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        dbMocks.db.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingVersion: 8 });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
    });

    it("returns didMaterialize=false with pending state without starting a transaction when pendingCount is 0", async () => {
        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(resolveSessionPendingOwnerAccess).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(1);
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 8 });
    });

    it("repairs stale positive pendingCount when no queued pending row exists", async () => {
        dbMocks.db.session.findUnique.mockResolvedValueOnce({ encryptionMode: "e2ee", pendingCount: 3, pendingVersion: 8 });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({ pendingCount: 3, pendingVersion: 8 })
            .mockResolvedValueOnce({ pendingCount: 0, pendingVersion: 9 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 1 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(dbMocks.db.sessionPendingMessage.findFirst).not.toHaveBeenCalled();
        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 3, pendingVersion: 8 },
            data: { pendingCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 9 });
    });

    it("does not clobber concurrent pending counter changes when stale-positive repair loses the version race", async () => {
        dbMocks.db.session.findUnique.mockResolvedValueOnce({ encryptionMode: "e2ee", pendingCount: 3, pendingVersion: 8 });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({ pendingCount: 3, pendingVersion: 8 })
            .mockResolvedValueOnce({ pendingCount: 4, pendingVersion: 9 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 0 });
        txSessionUpdate.mockResolvedValue({ pendingCount: 0, pendingVersion: 9 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 3, pendingVersion: 8 },
            data: { pendingCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 4, pendingVersion: 9 });
    });
});
