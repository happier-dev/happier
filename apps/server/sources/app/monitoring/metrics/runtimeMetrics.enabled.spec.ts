import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance, type monitorEventLoopDelay } from "node:perf_hooks";
import Fastify from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Server as SocketServer } from "socket.io";
import { io as connectSocket } from "socket.io-client";

import type { Fastify as HappierFastify } from "@/app/api/types";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const monitors = vi.hoisted(() => [] as ReturnType<typeof monitorEventLoopDelay>[]);

// Observe the native sampling boundary; the histogram and GC observer stay real.
vi.mock("node:perf_hooks", async (importOriginal) => {
    const native = await importOriginal<typeof import("node:perf_hooks")>();
    return {
        ...native,
        monitorEventLoopDelay: (options: Parameters<typeof monitorEventLoopDelay>[0]) => {
            const monitor = native.monitorEventLoopDelay(options);
            monitors.push(monitor);
            return monitor;
        },
    };
});

afterEach(async () => {
    const { initiateShutdown } = await import("@/utils/process/shutdown");
    await initiateShutdown("runtime-metrics-exporter-test");
    monitors.length = 0;
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("runtime metric sampling demand", () => {
    it("installs zero event-loop sampling timers at idle when the exporter is disabled", async () => {
        vi.stubEnv("METRICS_ENABLED", "false");
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
            await import("./runtimeMetrics");
            expect(monitors).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            const { initiateShutdown } = await import("@/utils/process/shutdown");
            await initiateShutdown("runtime-metrics-idle-test");
            vi.useRealTimers();
        }
    });

    it.each([1500, 0])("reports a %ims stall with only the in-flight route template", async (blockMs) => {
        vi.stubEnv("METRICS_ENABLED", "false");
        const { enableMonitoring } = await import("@/app/api/utils/enableMonitoring");
        const { log } = await import("@/utils/logging/log");
        vi.mocked(log).mockClear();
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;

        try {
            enableMonitoring(app);
            app.get("/diagnostic/:id", async () => {
                if (blockMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
                return { ok: true };
            });
            await app.ready();
            await new Promise(resolve => setTimeout(resolve, 40));
            const startedAt = Date.now();
            expect((await app.inject("/diagnostic/private-id?token=private-token")).statusCode).toBe(200);
            await new Promise(resolve => setTimeout(resolve, 40));

            const warnings = vi.mocked(log).mock.calls.filter(([entry]) =>
                entry?.module === "runtime-metrics" && entry.level === "warn");
            if (blockMs) {
                expect(warnings).toEqual([[
                    {
                        module: "runtime-metrics",
                        level: "warn",
                        durationMs: expect.any(Number),
                        httpRoutes: [{ route: "/diagnostic/:id", startedAtMs: expect.any(Number) }],
                        socketEvents: [],
                    },
                    "Long event-loop block",
                ]]);
                expect(warnings[0]![0].durationMs).toBeGreaterThanOrEqual(1450);
                expect(warnings[0]![0].httpRoutes[0].startedAtMs).toBeGreaterThanOrEqual(startedAt);
            } else {
                expect(warnings).toEqual([]);
            }
        } finally {
            await app.close();
        }
    });

    it.each([999, 1000])("applies the stall threshold at %ims and returns to idle", async (blockMs) => {
        vi.stubEnv("METRICS_ENABLED", "false");
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        let monotonicMs = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        try {
            const { enableMonitoring } = await import("@/app/api/utils/enableMonitoring");
            const { log } = await import("@/utils/logging/log");
            vi.mocked(log).mockClear();
            enableMonitoring(app);
            app.get("/threshold", async () => {
                expect(vi.getTimerCount()).toBe(1);
                // The loop makes no progress while the monotonic clock advances.
                monotonicMs += blockMs;
                return { ok: true };
            });
            await app.ready();
            // Starting a request after a long idle period resets the sample baseline.
            monotonicMs += 30_000;
            expect((await app.inject("/threshold")).statusCode).toBe(200);
            expect(vi.getTimerCount()).toBe(0);

            const warnings = vi.mocked(log).mock.calls.filter(([, message]) => message === "Long event-loop block");
            if (blockMs === 1000) {
                expect(warnings).toEqual([[
                    expect.objectContaining({
                        durationMs: 1000,
                        httpRoutes: [{ route: "/threshold", startedAtMs: expect.any(Number) }],
                    }),
                    "Long event-loop block",
                ]]);
            } else {
                expect(warnings).toEqual([]);
            }
        } finally {
            await app.close();
            await initiateShutdown("runtime-metrics-threshold-test");
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it("keeps a registered socket event in flight across an asynchronous handler continuation", async () => {
        vi.stubEnv("METRICS_ENABLED", "false");
        const { trackRuntimeSocketHandlers } = await import("./runtimeMetrics");
        const { log } = await import("@/utils/logging/log");
        vi.mocked(log).mockClear();
        const server = createServer();
        const sockets = new SocketServer(server);
        sockets.on("connection", socket => {
            trackRuntimeSocketHandlers(socket);
            socket.on("diagnostic", async (_payload: unknown, acknowledge: () => void) => {
                await new Promise(resolve => setImmediate(resolve));
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
                acknowledge();
            });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as AddressInfo;
        const client = connectSocket(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
        try {
            await client.timeout(10_000).emitWithAck("diagnostic", { token: "private-token" });
            const warnings = vi.mocked(log).mock.calls.filter(([entry]) =>
                entry?.module === "runtime-metrics" && entry.level === "warn");
            expect(warnings).toEqual([[
                {
                    module: "runtime-metrics",
                    level: "warn",
                    durationMs: expect.any(Number),
                    httpRoutes: [],
                    socketEvents: [{ event: "diagnostic", startedAtMs: expect.any(Number) }],
                },
                "Long event-loop block",
            ]]);
        } finally {
            client.close();
            await sockets.close();
        }
    });

    it("samples for an enabled exporter and stops at shutdown", async () => {
        vi.stubEnv("METRICS_ENABLED", "true");
        const { runtimeEventLoopLagSecondsGauge } = await import("./runtimeMetrics");
        expect(monitors).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 80));
        const metric = await runtimeEventLoopLagSecondsGauge.get();
        expect(metric.values.find(value => value.labels.stat === "max")?.value).toBeGreaterThan(0);
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("runtime-metrics-exporter-test");
        const samples = monitors[0]!.count;
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(monitors[0]!.count).toBe(samples);
    });
});
