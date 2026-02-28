import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));
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
                max: 10,
                timeWindow: "1 minute",
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("uid:user-1");
    });

    it("registers /v1/voice/session/complete with a per-user rate limit by default", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const opts = app.postOptsByPath.get("/v1/voice/session/complete");
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 60,
                timeWindow: "1 minute",
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("uid:user-1");
    });

    it("can force ip-only route keying strategy via HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY", async () => {
        process.env = {
            ...process.env,
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only",
        };

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const opts = app.postOptsByPath.get("/v1/voice/token");
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
    });

    it("allows overriding voice token max/window via HAPPIER_VOICE_TOKEN_RATE_LIMIT_*", async () => {
        process.env = {
            ...process.env,
            HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "7",
            HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "30 seconds",
        };

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const opts = app.postOptsByPath.get("/v1/voice/token");
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 7,
                timeWindow: "30 seconds",
            }),
        );
    });
});
