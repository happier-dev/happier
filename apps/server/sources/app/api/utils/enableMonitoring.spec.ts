import Fastify from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "@/app/monitoring/metrics/registry";
import { enableMonitoring } from "./enableMonitoring";
import type { Fastify as HappierFastify } from "../types";

// Logging is a process-output boundary; keep expected failure-path tests quiet.
vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

type MetricSample = {
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

function createMonitoringApp(): HappierFastify {
    return Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
}

describe("enableMonitoring", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("records hot endpoint metrics only for auth and changes route families", async () => {
        register.resetMetrics();
        const app = createMonitoringApp();
        enableMonitoring(app);
        app.get("/v2/changes", async () => ({ ok: true }));
        app.post("/v1/auth", async () => ({ ok: true }));
        app.get("/v1/other", async () => ({ ok: true }));
        await app.ready();

        try {
            await app.inject({ method: "GET", url: "/v2/changes" });
            await app.inject({ method: "POST", url: "/v1/auth" });
            await app.inject({ method: "GET", url: "/v1/other" });

            const samples = await readMetricSamples("http_hot_endpoint_requests_total");
            expect(samples).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { family: "changes", route: "/v2/changes", method: "GET", status: "200" },
                        value: 1,
                    }),
                    expect.objectContaining({
                        labels: { family: "auth", route: "/v1/auth", method: "POST", status: "200" },
                        value: 1,
                    }),
                ]),
            );
            expect(
                samples.find((sample) => sample.labels.route === "/v1/other"),
            ).toBeUndefined();
        } finally {
            await app.close();
        }
    });

    it("returns process liveness for /health when the database is unavailable", async () => {
        register.resetMetrics();
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/health" });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status?: string; timestamp?: string; service?: string };
            expect(body.status).toBe("ok");
            expect(body.service).toBe("happier-server");
            expect(typeof body.timestamp).toBe("string");
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual([]);
            expect(await readMetricSamples("db_readiness_duration_seconds")).toEqual([]);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it.each(["/live", "/health/db"])("does not register removed monitoring alias %s", async (url) => {
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: "GET", url });
            expect(res.statusCode).toBe(404);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("records successful database readiness checks with duration telemetry", async () => {
        register.resetMetrics();
        const app = createMonitoringApp();

        try {
            enableMonitoring(app, { databaseReadinessProbe: async () => [{ one: 1 }] });
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });
            expect(res.statusCode).toBe(200);
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "ok", reason: "none" },
                        value: 1,
                    }),
                ]),
            );
            expect(await readMetricSamples("db_readiness_duration_seconds")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "ok", reason: "none", le: expect.any(String) },
                    }),
                ]),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("coalesces concurrent database readiness checks into a single probe", async () => {
        register.resetMetrics();
        const app = createMonitoringApp();
        const query = { resolve: null as ((value: unknown) => void) | null };
        const databaseReadinessProbe = vi.fn(() => new Promise((resolve) => {
            query.resolve = resolve;
        }));

        try {
            enableMonitoring(app, { databaseReadinessProbe });
            await app.ready();

            const first = app.inject({ method: "GET", url: "/ready" });
            const second = app.inject({ method: "GET", url: "/ready" });

            await vi.waitFor(() => {
                expect(databaseReadinessProbe).toHaveBeenCalledTimes(1);
            });

            query.resolve?.([{ one: 1 }]);
            const [firstRes, secondRes] = await Promise.all([first, second]);

            expect(firstRes.statusCode).toBe(200);
            expect(secondRes.statusCode).toBe(200);
            expect(databaseReadinessProbe).toHaveBeenCalledTimes(1);
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "ok", reason: "none" },
                        value: 2,
                    }),
                ]),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns sanitized 503 readiness details and metrics when database readiness is unavailable", async () => {
        register.resetMetrics();
        const app = createMonitoringApp();

        try {
            enableMonitoring(app, { databaseReadinessProbe: async () => { throw new Error("SQLITE_CANTOPEN: cannot open database"); } });
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string };
            expect(body.status).toBe("error");
            expect(body.service).toBe("happier-server");
            expect(body.error).toBe("Database connectivity failed");
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "error", reason: "db_error" },
                        value: 1,
                    }),
                ]),
            );
            expect(await readMetricSamples("db_readiness_duration_seconds")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "error", reason: "db_error", le: expect.any(String) },
                    }),
                ]),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns 503 when database readiness exceeds the configured timeout", async () => {
        register.resetMetrics();
        vi.useFakeTimers();
        const app = createMonitoringApp();

        try {
            enableMonitoring(app, {
                env: { HAPPIER_DB_READINESS_TIMEOUT_MS: "25" },
                databaseReadinessProbe: () => new Promise(() => {}),
            });
            await app.ready();

            const response = app.inject({ method: "GET", url: "/ready" });
            await vi.advanceTimersByTimeAsync(25);

            const res = await response;
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string };
            expect(body.status).toBe("error");
            expect(body.service).toBe("happier-server");
            expect(body.error).toBe("Database connectivity failed");
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "timeout", reason: "db_timeout" },
                        value: 1,
                    }),
                ]),
            );
            expect(await readMetricSamples("db_readiness_duration_seconds")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "timeout", reason: "db_timeout", le: expect.any(String) },
                    }),
                ]),
            );
        } finally {
            vi.useRealTimers();
            await app.close().catch(() => {});
        }
    });

    it("uses a 15s default database readiness timeout", async () => {
        register.resetMetrics();
        vi.useFakeTimers();
        const app = createMonitoringApp();

        try {
            enableMonitoring(app, {
                env: {},
                databaseReadinessProbe: () => new Promise(() => {}),
            });
            await app.ready();

            const response = app.inject({ method: "GET", url: "/ready" });
            let settled = false;
            void response.finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(5_000);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(10_000);
            const res = await response;
            expect(res.statusCode).toBe(503);
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        labels: { result: "timeout", reason: "db_timeout" },
                        value: 1,
                    }),
                ]),
            );
        } finally {
            vi.useRealTimers();
            await app.close().catch(() => {});
        }
    });

    it("returns 503 from /health during shutdown without querying the database", async () => {
        vi.resetModules();
        register.resetMetrics();
        const app = createMonitoringApp();
        const databaseReadinessProbe = vi.fn(async () => [{ one: 1 }]);

        try {
            const { enableMonitoring: enableMonitoringAfterReset } = await import("./enableMonitoring");
            const { initiateShutdown } = await import("@/utils/process/shutdown");
            enableMonitoringAfterReset(app, { databaseReadinessProbe });
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/health" });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; reason?: string };
            expect(body.status).toBe("error");
            expect(body.service).toBe("happier-server");
            expect(body.reason).toBe("shutting_down");
            expect(databaseReadinessProbe).not.toHaveBeenCalled();
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual([]);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("returns 503 from /ready during shutdown without querying the database", async () => {
        vi.resetModules();
        register.resetMetrics();
        const app = createMonitoringApp();
        const databaseReadinessProbe = vi.fn(async () => [{ one: 1 }]);

        try {
            const { enableMonitoring: enableMonitoringAfterReset } = await import("./enableMonitoring");
            const { initiateShutdown } = await import("@/utils/process/shutdown");
            enableMonitoringAfterReset(app, { databaseReadinessProbe });
            await app.ready();
            await initiateShutdown("test");

            const res = await app.inject({ method: "GET", url: "/ready" });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; reason?: string };
            expect(body.status).toBe("error");
            expect(body.service).toBe("happier-server");
            expect(body.reason).toBe("shutting_down");
            expect(databaseReadinessProbe).not.toHaveBeenCalled();
            expect(await readMetricSamples("db_readiness_checks_total")).toEqual([]);
        } finally {
            await app.close().catch(() => {});
        }
    });
});
