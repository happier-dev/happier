import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const dbMocks = createDbMocks({
    session: ["findUniqueOrThrow", "update", "updateMany"],
    sessionPendingMessage: ["count"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const inTxMock = vi.fn(async <T>(fn: (tx: typeof dbMocks.db) => Promise<T>): Promise<T> => {
    return await fn(dbMocks.db);
});

vi.doMock("@/storage/inTx", () => ({
    inTx: inTxMock,
}));

describe("reconcileSessionPendingQueueState", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        dbMocks.db.sessionPendingMessage.count.mockResolvedValue(2);
        dbMocks.db.session.findUniqueOrThrow.mockResolvedValue({ pendingCount: 0, pendingVersion: 5 });
        dbMocks.db.session.update.mockResolvedValue({ pendingCount: 2, pendingVersion: 8 });
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 1 });
    });

    it("repairs stale pending counts from current DB state inside one transaction", async () => {
        const { reconcileSessionPendingQueueState } = await import("./reconcileSessionPendingQueueState");
        dbMocks.db.session.findUniqueOrThrow
            .mockResolvedValueOnce({ pendingCount: 1, pendingVersion: 7 })
            .mockResolvedValueOnce({ pendingCount: 2, pendingVersion: 8 });

        await expect(reconcileSessionPendingQueueState({
            sessionId: "s1",
            pendingCount: 0,
            pendingVersion: 5,
        })).resolves.toEqual({
            pendingCount: 2,
            pendingVersion: 8,
            didRepair: true,
        });
        expect(inTxMock).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.sessionPendingMessage.count).toHaveBeenCalledWith({
            where: { sessionId: "s1", status: "queued" },
        });
        expect(dbMocks.db.session.findUniqueOrThrow).toHaveBeenNthCalledWith(1, {
            where: { id: "s1" },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 1, pendingVersion: 7 },
            data: { pendingCount: 2, pendingVersion: { increment: 1 } },
        });
        expect(dbMocks.db.session.findUniqueOrThrow).toHaveBeenNthCalledWith(2, {
            where: { id: "s1" },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(dbMocks.db.session.update).not.toHaveBeenCalled();
    });

    it("keeps current DB state when queued rows already match current pending count", async () => {
        dbMocks.db.sessionPendingMessage.count.mockResolvedValue(2);
        dbMocks.db.session.findUniqueOrThrow.mockResolvedValue({ pendingCount: 2, pendingVersion: 9 });
        const { reconcileSessionPendingQueueState } = await import("./reconcileSessionPendingQueueState");

        await expect(reconcileSessionPendingQueueState({
            sessionId: "s1",
            pendingCount: 0,
            pendingVersion: 5,
        })).resolves.toEqual({
            pendingCount: 2,
            pendingVersion: 9,
            didRepair: false,
        });
        expect(dbMocks.db.session.updateMany).not.toHaveBeenCalled();
        expect(dbMocks.db.session.update).not.toHaveBeenCalled();
    });

    it("returns latest DB state when optimistic repair loses a concurrent race", async () => {
        const { reconcileSessionPendingQueueState } = await import("./reconcileSessionPendingQueueState");
        dbMocks.db.session.findUniqueOrThrow
            .mockResolvedValueOnce({ pendingCount: 1, pendingVersion: 7 })
            .mockResolvedValueOnce({ pendingCount: 3, pendingVersion: 10 });
        dbMocks.db.session.updateMany.mockResolvedValue({ count: 0 });

        await expect(reconcileSessionPendingQueueState({
            sessionId: "s1",
            pendingCount: 0,
            pendingVersion: 5,
        })).resolves.toEqual({
            pendingCount: 3,
            pendingVersion: 10,
            didRepair: false,
        });
        expect(dbMocks.db.session.updateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 1, pendingVersion: 7 },
            data: { pendingCount: 2, pendingVersion: { increment: 1 } },
        });
        expect(dbMocks.db.session.findUniqueOrThrow).toHaveBeenCalledTimes(2);
        expect(dbMocks.db.session.update).not.toHaveBeenCalled();
    });
});
