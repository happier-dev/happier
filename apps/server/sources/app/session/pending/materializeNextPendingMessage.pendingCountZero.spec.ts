import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const fenceExactCurrentPublisherAuthorityInTx = vi.fn(async () => true);
vi.mock("@/app/session/pending/hasExactCurrentPublisherAuthorityInTx", () => ({
    fenceExactCurrentPublisherAuthorityInTx,
    hasExactCurrentPublisherAuthorityInTx: vi.fn(async () => true),
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionPendingMessage: ["findFirst", "count"],
} as const);
installDbModuleMock({ db: dbMocks.db, isPrismaErrorCode: vi.fn(() => false) });

const txSessionFindUniqueOrThrow = vi.fn();
const txSessionFindUnique = vi.fn();
const txExecuteRaw = vi.fn(async () => 0);
const txSessionUpdate = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionPendingMessageFindMany = vi.fn();
const txSessionPendingMessageFindFirst = vi.fn();
const txSessionPendingMessageCount = vi.fn();
const txSessionPendingMessageUpdateMany = vi.fn();
const tx = {
    $executeRaw: txExecuteRaw,
    session: {
        findUnique: txSessionFindUnique,
        findUniqueOrThrow: txSessionFindUniqueOrThrow,
        update: txSessionUpdate,
        updateMany: txSessionUpdateMany,
    },
    sessionPendingMessage: {
        findFirst: txSessionPendingMessageFindFirst,
        findMany: txSessionPendingMessageFindMany,
        count: txSessionPendingMessageCount,
        updateMany: txSessionPendingMessageUpdateMany,
    },
};
const inTx = vi.fn(async <T>(run: (txArg: typeof tx) => Promise<T>) => run(tx));
vi.mock("@/storage/inTx", () => ({
    inTx,
    isTransactionAcquisitionUnavailableError: () => false,
    isTransactionDeadlineExceededError: () => false,
}));

let materializeNextPendingMessage: typeof import("./materializeNextPendingMessage").materializeNextPendingMessage;
const publisherAuthority = {
    accountId: "u1",
    machineId: "m1",
    sessionId: "s1",
    committedFence: new Date(0),
} as const;

const materialize = () => materializeNextPendingMessage({
    actorUserId: "u1",
    sessionId: "s1",
    deliveryState: "provider",
    deliveryTiming: "after_foreground_ready",
    foregroundState: "ready",
    publisherAuthority,
});

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    beforeAll(async () => {
        ({ materializeNextPendingMessage } = await import("./materializeNextPendingMessage"));
    }, 60_000);

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionFindUnique.mockReset();
        txExecuteRaw.mockReset();
        txExecuteRaw.mockResolvedValue(0);
        txSessionUpdate.mockReset();
        txSessionUpdateMany.mockReset();
        txSessionPendingMessageFindMany.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        txSessionPendingMessageCount.mockReset();
        txSessionPendingMessageUpdateMany.mockReset();
        dbMocks.db.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 8 });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
        dbMocks.db.sessionPendingMessage.count.mockResolvedValue(0);
        txSessionPendingMessageUpdateMany.mockResolvedValue({ count: 0 });
        txSessionFindUnique.mockResolvedValue({
            accountId: "u1",
            encryptionMode: "e2ee",
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 8,
        });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionPendingMessageCount.mockImplementation(async (args: { where?: { deliveryState?: string } }) => (
            args.where?.deliveryState === "blocked" ? 0 : 0
        ));
    });

    it("returns didMaterialize=false through the same exact-authority transaction when pendingCount is 0", async () => {
        const result = await materialize();

        expect(fenceExactCurrentPublisherAuthorityInTx).toHaveBeenCalledTimes(1);
        expect(txSessionFindUnique).toHaveBeenCalledTimes(1);
        expect(txSessionPendingMessageFindFirst).toHaveBeenCalledTimes(1);
        expect(txSessionPendingMessageCount).toHaveBeenCalledWith({
            where: { sessionId: "s1", status: "queued" },
        });
        expect(inTx).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            deliveryState: { mode: "provider", unresolved: false },
        });
    });

});
