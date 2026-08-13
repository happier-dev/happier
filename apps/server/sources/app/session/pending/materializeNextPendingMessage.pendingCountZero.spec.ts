import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const hasCurrentSessionScopedMachineAccessInTx = vi.fn(async () => true);
vi.mock("@/app/api/socket/sessionScopedBinding", () => ({
    hasCurrentSessionScopedMachineAccessInTx,
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionPendingMessage: ["findFirst", "count"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const txSessionFindUnique = vi.fn();
const txSessionFindUniqueOrThrow = vi.fn();
const txSessionUpdate = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionPendingMessageFindFirst = vi.fn();
const txSessionPendingMessageFindMany = vi.fn();
const txSessionPendingMessageCount = vi.fn();
const txSessionPendingMessageUpdateMany = vi.fn();
const txSessionMessageFindFirst = vi.fn();
const tx = {
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
    sessionMessage: {
        findFirst: txSessionMessageFindFirst,
    },
};

const inTx = vi.fn(async (run: (txArg: typeof tx) => Promise<unknown>) => await run(tx));
vi.mock("@/storage/inTx", () => ({
    inTx,
    isTransactionAcquisitionUnavailableError: () => false,
    isTransactionDeadlineExceededError: () => false,
}));

let materializeNextPendingMessage: typeof import("./materializeNextPendingMessage").materializeNextPendingMessage;

const trustedPublisherFence = {
    accountId: "u1",
    machineId: "machine-1",
    sessionId: "s1",
    committedFence: new Date("2026-07-13T12:00:00.000Z"),
} as const;

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
    encryptionMode: "e2ee",
    pendingCount: 1,
    pendingBlockedCount: 0,
    pendingVersion: 9,
    active: true,
    archivedAt: null,
    lastActiveAt: trustedPublisherFence.committedFence,
    runtimeActivityState: "idle",
    runtimeActivityActiveCount: 0,
    runtimeActivityObservedAt: 1_000n,
    runtimeActivityRevision: 12n,
    updatedAt: new Date("2026-07-02T08:00:00.000Z"),
    ...overrides,
});

let selectedSessionRow = sessionRow({ pendingCount: 0, pendingVersion: 8 });

function installSessionFindUniqueResponses(): void {
    txSessionFindUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) => (
        args.select?.encryptionMode
            ? selectedSessionRow
            : {
                accountId: trustedPublisherFence.accountId,
                active: true,
                archivedAt: null,
                lastActiveAt: trustedPublisherFence.committedFence,
            }
    ));
}

const pendingRow = (
    kind: "enqueue" | "send_now",
    overrides: Record<string, unknown> = {},
) => ({
    localId: `pending-${kind}`,
    messageRole: "user",
    content: { t: "encrypted", c: "encrypted-user-message" },
    requestedAction: { v: 1, kind },
    providerAction: null,
    status: "queued",
    deliveryState: null,
    createdAt: new Date("2026-07-02T08:00:00.000Z"),
    updatedAt: new Date("2026-07-02T08:00:00.000Z"),
    ...overrides,
});

describe("materializeNextPendingMessage current Pending owner", () => {
    beforeAll(async () => {
        ({ materializeNextPendingMessage } = await import("./materializeNextPendingMessage"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txSessionFindUnique.mockReset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionUpdate.mockReset();
        txSessionUpdateMany.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        txSessionPendingMessageFindMany.mockReset();
        txSessionPendingMessageCount.mockReset();
        txSessionPendingMessageUpdateMany.mockReset();
        txSessionMessageFindFirst.mockReset();
        selectedSessionRow = sessionRow({ pendingCount: 0, pendingVersion: 8 });
        dbMocks.db.session.findUnique.mockResolvedValue(sessionRow({ pendingCount: 0, pendingVersion: 8 }));
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
        dbMocks.db.sessionPendingMessage.count.mockResolvedValue(0);
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionPendingMessageFindMany.mockResolvedValue([]);
        txSessionPendingMessageCount.mockResolvedValue(0);
        txSessionPendingMessageUpdateMany.mockResolvedValue({ count: 0 });
        txSessionMessageFindFirst.mockResolvedValue(null);
        installSessionFindUniqueResponses();
    });

    it("rejoins current-publisher claims before using pendingCount as a no-work hint", async () => {
        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            trustedPublisherFence,
        });

        expect(resolveSessionPendingOwnerAccess).not.toHaveBeenCalled();
        expect(txSessionPendingMessageFindFirst).toHaveBeenCalledTimes(2);
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

    it("selects an urgent FIFO action without reading or validating Activity", async () => {
        const malformedActivity = sessionRow({
            runtimeActivityState: "malformed",
            runtimeActivityActiveCount: -1,
            runtimeActivityObservedAt: -1n,
            runtimeActivityRevision: -1n,
        });
        selectedSessionRow = malformedActivity;
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce(malformedActivity)
            .mockResolvedValueOnce({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 });
        txSessionPendingMessageFindMany.mockResolvedValue([pendingRow("send_now")]);

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            trustedPublisherFence,
            deliveryTiming: "after_runtime_idle",
            foregroundState: "active_unsteerable",
        });

        expect(txSessionPendingMessageUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ localId: "pending-send_now" }),
                data: expect.objectContaining({ providerAction: "interrupt_and_send" }),
            }),
        );
        expect(result).toMatchObject({ ok: true, didMaterialize: false });
    });

    it.each([
        {
            label: "active",
            projection: {
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 1n,
                runtimeActivityRevision: 12n,
            },
            deferredReason: "waiting_for_runtime_activity",
        },
        {
            label: "malformed",
            projection: {
                runtimeActivityState: "idle",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 12n,
            },
            deferredReason: "runtime_activity_unknown",
        },
    ])("validates ordinary after-runtime-idle Activity inside the transaction for $label state", async ({
        projection,
        deferredReason,
    }) => {
        const before = sessionRow(projection);
        selectedSessionRow = before;
        txSessionFindUniqueOrThrow.mockResolvedValue(before);
        txSessionPendingMessageFindMany.mockResolvedValue([pendingRow("enqueue")]);

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            trustedPublisherFence,
            deliveryTiming: "after_runtime_idle",
        });

        expect(txSessionPendingMessageUpdateMany).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, didMaterialize: false, deferredReason });
    });

    it("requires the exact idle revision for a current publisher before claiming ordinary work", async () => {
        const committedFence = new Date("2026-07-13T12:00:00.000Z");
        const idle = sessionRow({ lastActiveAt: committedFence });
        const authority = {
            accountId: "u1",
            machineId: "machine-1",
            sessionId: "s1",
            committedFence,
        };
        selectedSessionRow = idle;
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionPendingMessageFindMany.mockResolvedValue([pendingRow("enqueue")]);
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce(idle)
            .mockResolvedValueOnce(idle)
            .mockResolvedValueOnce({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 });

        const stale = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            deliveryTiming: "after_runtime_idle",
            expectedRuntimeActivityRevision: 11,
            trustedPublisherFence: authority,
        });
        expect(stale).toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "runtime_activity_unknown",
        });
        expect(txSessionPendingMessageUpdateMany).not.toHaveBeenCalled();

        vi.clearAllMocks();
        txSessionFindUnique.mockReset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        txSessionPendingMessageFindMany.mockReset();
        txSessionPendingMessageUpdateMany.mockReset();
        resolveSessionPendingOwnerAccess.mockResolvedValue({ ok: true });
        hasCurrentSessionScopedMachineAccessInTx.mockResolvedValue(true);
        selectedSessionRow = idle;
        installSessionFindUniqueResponses();
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionPendingMessageFindMany.mockResolvedValue([pendingRow("enqueue")]);
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce(idle)
            .mockResolvedValueOnce(idle)
            .mockResolvedValueOnce({ pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 9 });
        txSessionPendingMessageUpdateMany.mockResolvedValue({ count: 0 });

        const exact = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            deliveryTiming: "after_runtime_idle",
            expectedRuntimeActivityRevision: 12,
            trustedPublisherFence: authority,
        });

        expect(exact).toMatchObject({ ok: true, didMaterialize: false });
        expect(exact).not.toHaveProperty("deferredReason");
        expect(txSessionPendingMessageUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ localId: "pending-enqueue" }) }),
        );
        const transactionPreflightSelect = txSessionFindUnique.mock.calls.find((call) => call[0]?.select?.encryptionMode)?.[0]?.select as Record<string, unknown>;
        const transactionSelect = txSessionFindUniqueOrThrow.mock.calls[0]?.[0]?.select as Record<string, unknown>;
        expect(transactionPreflightSelect).not.toHaveProperty("runtimeActivitySourceClass");
        expect(transactionSelect).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("repairs stale positive pending counters without clobbering a newer version", async () => {
        selectedSessionRow = sessionRow({ pendingCount: 2 });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({ pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 })
            .mockResolvedValueOnce({ pendingCount: 3, pendingBlockedCount: 0, pendingVersion: 10 });
        txSessionPendingMessageFindMany.mockResolvedValue([]);
        txSessionUpdateMany.mockResolvedValue({ count: 0 });

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            trustedPublisherFence,
        });

        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 9 },
            data: { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(result).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 10,
            deliveryState: { mode: "provider", unresolved: false },
        });
    });

    it("does not start a second materialization transaction after an unexpected transaction failure", async () => {
        inTx.mockRejectedValueOnce({ code: "P2002" });

        const result = await materializeNextPendingMessage({
            actorUserId: "u1",
            sessionId: "s1",
            trustedPublisherFence,
        });

        expect(inTx).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            ok: false,
            error: "internal",
        });
    });
});
