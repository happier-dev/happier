import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrismaMetrics = vi.fn();
const mockQueryRaw = vi.fn();
const mockRegisterMetrics = vi.fn();
const mockDbReadinessChecksInc = vi.fn();
const mockDbReadinessDurationObserve = vi.fn();
const mockLog = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $metrics: { prometheus: mockPrismaMetrics },
    },
    probeDbReadiness: () => mockQueryRaw(),
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    register: { metrics: mockRegisterMetrics },
    dbReadinessChecksCounter: { inc: mockDbReadinessChecksInc },
    dbReadinessDurationHistogram: { observe: mockDbReadinessDurationObserve },
}));

vi.mock("@/utils/logging/log", () => ({
    log: mockLog,
}));

describe("metrics server", () => {
    beforeEach(() => {
        vi.resetModules();
        mockPrismaMetrics.mockReset();
        mockQueryRaw.mockReset();
        mockRegisterMetrics.mockReset();
        mockDbReadinessChecksInc.mockReset();
        mockDbReadinessDurationObserve.mockReset();
        mockLog.mockReset();
    });

    it("exposes database readiness on /ready for worker probes", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const app = await createMetricsServer();

        try {
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(200);
            expect(res.json()).not.toHaveProperty("apiStartupIdentity");
            expect(mockQueryRaw).toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: "ok", reason: "none" });
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns shutting-down liveness from /health during shutdown", async () => {
        const { createMetricsServer } = await import("./metrics");
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        const app = await createMetricsServer();

        try {
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/health" });

            expect(res.statusCode).toBe(503);
            expect(res.json()).toMatchObject({
                status: "error",
                service: "happier-server",
                reason: "shutting_down",
            });
            expect(mockQueryRaw).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns shutting-down readiness from /ready during shutdown without querying the database", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        const app = await createMetricsServer();

        try {
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(503);
            expect(res.json()).toMatchObject({
                status: "error",
                service: "happier-server",
                reason: "shutting_down",
            });
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });
});
