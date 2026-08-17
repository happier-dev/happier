import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    updateMany: vi.fn(),
    markAccountChanged: vi.fn(async () => undefined),
}));

vi.mock("@/storage/db", () => ({
    db: {
        pluginWebhookDelivery: {
            findMany: mocks.findMany,
            updateMany: mocks.updateMany,
        },
    },
}));
vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: Readonly<{
        pluginWebhookDelivery: Readonly<{ updateMany: typeof mocks.updateMany }>;
    }>) => Promise<unknown>) => await fn({
        pluginWebhookDelivery: { updateMany: mocks.updateMany },
    }),
}));
vi.mock("@/storage/prisma", () => ({
    getActivePrismaRuntime: () => ({ DbNull: null }),
}));
vi.mock("./accountChange", () => ({
    markPluginWebhookAccountChangedInTxV1: mocks.markAccountChanged,
}));

import { ageOverduePluginWebhookDeliveriesV1 } from "./claimStore";

describe("plugin webhook overdue queue aging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.updateMany.mockResolvedValue({ count: 1 });
    });

    it("starts the offline clock for overdue work and dead-letters it after seven days without charging an attempt", async () => {
        const now = new Date("2026-08-10T00:00:00.000Z");
        mocks.findMany.mockResolvedValue([
            {
                id: "delivery-new",
                accountId: "account-1",
                targetPluginId: "acme.github",
                revision: 2,
                attemptCount: 0,
                offlineSinceAt: null,
            },
            {
                id: "delivery-expired",
                accountId: "account-1",
                targetPluginId: "acme.github",
                revision: 5,
                attemptCount: 0,
                offlineSinceAt: new Date("2026-08-03T00:00:00.000Z"),
            },
        ]);

        await expect(ageOverduePluginWebhookDeliveriesV1({ now, batchSize: 100 })).resolves.toEqual({
            markedOffline: 1,
            deadLettered: 1,
        });
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ state: "queued", nextAttemptAt: { lte: now } }),
            take: 100,
        }));
        expect(mocks.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({ id: "delivery-new", revision: 2, state: "queued" }),
            data: expect.objectContaining({
                offlineSinceAt: now,
                lastErrorCode: "target_offline",
                revision: { increment: 1 },
            }),
        }));
        expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ id: "delivery-expired", revision: 5, state: "queued" }),
            data: expect.objectContaining({
                state: "dead_letter",
                lastErrorCode: "target_offline",
                revision: { increment: 1 },
            }),
        }));
        expect(mocks.markAccountChanged).toHaveBeenCalledTimes(2);
    });
});
