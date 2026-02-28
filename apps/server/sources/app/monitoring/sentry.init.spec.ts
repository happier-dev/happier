import { beforeEach, describe, expect, it, vi } from "vitest";

type InitArg = Record<string, unknown>;

describe("app/monitoring/sentry (init)", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("does nothing when Sentry is already initialized", async () => {
        const initSpy = vi.fn();

        vi.doMock("@sentry/node", () => ({
            getClient: () => ({}),
            init: initSpy,
            fastifyIntegration: vi.fn(() => ({ name: "fastify" })),
        }));
        vi.doMock("@sentry/profiling-node", () => ({
            nodeProfilingIntegration: vi.fn(() => ({ name: "profiling" })),
        }));

        const { initializeServerSentry } = await import("./sentry");

        initializeServerSentry({ SENTRY_DSN: "https://dsn@example/1" } as any);

        expect(initSpy).toHaveBeenCalledTimes(0);
    });

    it("initializes Sentry once when DSN is set", async () => {
        const initSpy = vi.fn();
        const fastifyIntegrationSpy = vi.fn(() => ({ name: "fastify" }));
        const profilingIntegrationSpy = vi.fn(() => ({ name: "profiling" }));

        let initialized = false;
        vi.doMock("@sentry/node", () => ({
            getClient: () => (initialized ? ({} as any) : null),
            init: (arg: InitArg) => {
                initialized = true;
                initSpy(arg);
            },
            fastifyIntegration: fastifyIntegrationSpy,
        }));
        vi.doMock("@sentry/profiling-node", () => ({
            nodeProfilingIntegration: profilingIntegrationSpy,
        }));

        const { initializeServerSentry } = await import("./sentry");

        initializeServerSentry({
            SENTRY_DSN: "https://dsn@example/1",
            SENTRY_TRACES_SAMPLE_RATE: "0.1",
        } as any);
        initializeServerSentry({
            SENTRY_DSN: "https://dsn@example/1",
            SENTRY_TRACES_SAMPLE_RATE: "0.1",
        } as any);

        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(fastifyIntegrationSpy).toHaveBeenCalledTimes(0);

        const initArg = initSpy.mock.calls[0]?.[0] as any;
        expect(initArg).toEqual(
            expect.objectContaining({
                dsn: "https://dsn@example/1",
                tracesSampleRate: 0.1,
            }),
        );
        expect(typeof initArg.integrations).toBe("function");

        const merged = initArg.integrations([{ name: "default" }]);
        expect(merged).toEqual([{ name: "default" }, { name: "fastify" }]);
        expect(fastifyIntegrationSpy).toHaveBeenCalledTimes(1);
        expect(profilingIntegrationSpy).toHaveBeenCalledTimes(0);
    });

    it("adds profiling integration when profiling is enabled", async () => {
        const initSpy = vi.fn();

        vi.doMock("@sentry/node", () => ({ getClient: () => null, init: initSpy, fastifyIntegration: vi.fn() }));

        const { initializeServerSentry } = await import("./sentry");

        initializeServerSentry({
            SENTRY_DSN: "https://dsn@example/1",
            SENTRY_PROFILE_SESSION_SAMPLE_RATE: "0.25",
            SENTRY_PROFILE_LIFECYCLE: "trace",
        } as any);

        const initArg = initSpy.mock.calls[0]?.[0] as any;
        expect(initArg).toEqual(
            expect.objectContaining({
                dsn: "https://dsn@example/1",
                profileSessionSampleRate: 0.25,
                profileLifecycle: "trace",
            }),
        );
        expect(typeof initArg.integrations).toBe("function");
        const merged = initArg.integrations([]);
        expect(merged).toEqual([expect.objectContaining({ name: expect.stringMatching(/profil/i) })]);
    });
});
