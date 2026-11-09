import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { usageHandler } from "./usageHandler";

const { emitEphemeral, usageReportWritesCounterInc } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    usageReportWritesCounterInc: vi.fn(),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral },
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));

vi.mock("@/utils/logging/log", () => ({ debug: vi.fn(), log: vi.fn(), warn: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    usageReportWritesCounter: { inc: usageReportWritesCounterInc },
}));

describe("usageHandler account-level usage writes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-account-usage-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageReport.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("canonicalizes duplicate account-level socket usage reports to one row", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-socket-dedup" },
            select: { id: true },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "account-total",
                data: { tokens: { total: 1 }, cost: { total: 0.01 } },
            },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "account-total",
                data: { tokens: { total: 2 }, cost: { total: 0.02 } },
            },
        });

        const socket = createFakeSocket();
        usageHandler(account.id, socket as unknown as Parameters<typeof usageHandler>[1]);

        const callback = vi.fn();
        await getSocketHandler(socket, "usage-report")({
            key: "account-total",
            tokens: { total: 7, prompt: 3 },
            cost: { total: 0.07 },
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            reportId: expect.any(String),
        }));

        const reports = await db.usageReport.findMany({
            where: {
                accountId: account.id,
                sessionId: null,
                key: "account-total",
            },
            select: {
                id: true,
                sessionId: true,
                data: true,
            },
        });
        expect(reports).toEqual([
            {
                id: expect.any(String),
                sessionId: null,
                data: { tokens: { total: 7, prompt: 3 }, cost: { total: 0.07 } },
            },
        ]);
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
