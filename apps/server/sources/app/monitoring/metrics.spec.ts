import { describe, expect, it, vi } from "vitest";

const mockPrismaMetrics = vi.fn();
const mockQueryRaw = vi.fn();
const mockRegisterMetrics = vi.fn();
const mockDbReadinessChecksInc = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $metrics: { prometheus: mockPrismaMetrics },
        $queryRaw: mockQueryRaw,
    },
}));

vi.mock("@/app/monitoring/metrics/index", () => ({
    register: { metrics: mockRegisterMetrics },
    dbReadinessChecksCounter: { inc: mockDbReadinessChecksInc },
    dbReadinessDurationHistogram: { observe: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

describe("metrics server", () => {
    it("exposes database readiness on /ready for worker probes", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const app = await createMetricsServer();

        try {
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(200);
            expect(mockQueryRaw).toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: "ok", reason: "none" });
        } finally {
            await app.close().catch(() => {});
        }
    });
});
