import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const emitEphemeral = vi.fn();
const buildUsageEphemeral = vi.fn(() => ({ type: "usage" }));
const usageReportWritesCounterInc = vi.fn();

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral },
    buildUsageEphemeral,
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    usageReportWritesCounter: { inc: usageReportWritesCounterInc },
}));

const dbSessionFindFirst = vi.fn();
const dbUsageReportUpsert = vi.fn();
const txSessionFindFirst = vi.fn();
const txUsageReportFindUnique = vi.fn();
const txUsageReportUpsert = vi.fn();
const inTx = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({
    session: { findFirst: txSessionFindFirst },
    usageReport: {
        findUnique: txUsageReportFindUnique,
        upsert: txUsageReportUpsert,
    },
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: { findFirst: dbSessionFindFirst },
        usageReport: { upsert: dbUsageReportUpsert },
    },
}));

vi.mock("@/storage/inTx", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/storage/inTx")>(),
    inTx,
    afterTx: vi.fn(),
}));

describe("usageHandler usage writes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbSessionFindFirst.mockResolvedValue({ id: "s1" });
        dbUsageReportUpsert.mockRejectedValue(Object.assign(new Error("Socket timeout"), { code: "P1008" }));
        txSessionFindFirst.mockResolvedValue({ id: "s1" });
        txUsageReportFindUnique.mockResolvedValue(null);
        txUsageReportUpsert.mockResolvedValue({
            id: "report-1",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:01.000Z"),
        });
    });

    it("records socket usage reports through the transactional retry path", async () => {
        const { usageHandler } = await import("./usageHandler");
        const socket = createFakeSocket();
        usageHandler("u1", socket as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-report")({
            key: "k1",
            sessionId: "s1",
            tokens: { total: 10, prompt: 4 },
            cost: { total: 0.25 },
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            reportId: "report-1",
        }));
        expect(inTx).toHaveBeenCalledTimes(1);
        expect(txSessionFindFirst).toHaveBeenCalledWith({
            where: { id: "s1", accountId: "u1" },
            select: { id: true },
        });
        expect(txUsageReportFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_sessionId_key: {
                    accountId: "u1",
                    sessionId: "s1",
                    key: "k1",
                },
            },
            select: {
                id: true,
                createdAt: true,
                updatedAt: true,
                data: true,
            },
        });
        expect(txUsageReportUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId_sessionId_key: {
                    accountId: "u1",
                    sessionId: "s1",
                    key: "k1",
                },
            },
            create: expect.objectContaining({
                accountId: "u1",
                sessionId: "s1",
                key: "k1",
            }),
        }));
        expect(dbUsageReportUpsert).not.toHaveBeenCalled();
        expect(usageReportWritesCounterInc).toHaveBeenCalledWith({ scope: "session", result: "created" });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it("acknowledges unchanged socket usage reports without emitting duplicate ephemeral updates", async () => {
        const { usageHandler } = await import("./usageHandler");
        const socket = createFakeSocket();
        usageHandler("u1", socket as any);
        txUsageReportFindUnique.mockResolvedValue({
            id: "report-1",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:01.000Z"),
            data: { tokens: { total: 10, prompt: 4 }, cost: { total: 0.25 } },
        });

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-report")({
            key: "k1",
            sessionId: "s1",
            tokens: { total: 10, prompt: 4 },
            cost: { total: 0.25 },
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            reportId: "report-1",
        }));
        expect(txUsageReportUpsert).not.toHaveBeenCalled();
        expect(usageReportWritesCounterInc).toHaveBeenCalledWith({ scope: "session", result: "unchanged" });
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
