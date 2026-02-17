import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/storage/db", () => ({
    db: {
        voiceSessionLease: {
            deleteMany: vi.fn(async () => ({ count: 0 })),
            create: vi.fn(async () => ({ id: "lease_1" })),
            findMany: vi.fn(async () => [{ id: "lease_1" }]),
            delete: vi.fn(async () => ({})),
        },
    },
}));

class FakeApp {
    public authenticate = vi.fn();
    public postOptsByPath = new Map<string, any>();
    public routes = new Map<string, any>();

    get() { }
    post(path: string, opts: any, handler: any) {
        this.postOptsByPath.set(path, opts);
        this.routes.set(`POST ${path}`, handler);
    }
}

describe("voiceRoutes (rate limit)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = {
            ...originalEnv,
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("registers /v1/voice/token with a per-user rate limit by default", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const opts = app.postOptsByPath.get("/v1/voice/token");
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: expect.any(Number),
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
    });

    it("registers /v1/voice/session/complete with a per-user rate limit by default", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const opts = app.postOptsByPath.get("/v1/voice/session/complete");
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: expect.any(Number),
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
    });
});
