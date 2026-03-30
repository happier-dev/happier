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

const inTx = vi.fn(async () => {
    throw new Error("inTx should not be called when pendingCount is 0");
});
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
        dbMocks.db.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0 });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
    });

    it("returns didMaterialize=false without starting a transaction when pendingCount is 0", async () => {
        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(resolveSessionPendingOwnerAccess).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(1);
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false });
    });
});
