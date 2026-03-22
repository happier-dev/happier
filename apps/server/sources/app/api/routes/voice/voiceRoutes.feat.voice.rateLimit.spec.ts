import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));
const dbMocks = createDbMocks({
    voiceSessionLease: ["deleteMany", "create", "findMany", "delete"],
} as const);
installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("voiceRoutes (rate limit)", () => {
    const resetVoiceEnv = createEnvReset();

    beforeEach(() => {
        vi.resetModules();
        dbMocks.reset();
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
        });
        dbMocks.db.voiceSessionLease.deleteMany.mockResolvedValue({ count: 0 });
        dbMocks.db.voiceSessionLease.create.mockResolvedValue({ id: "lease_1" });
        dbMocks.db.voiceSessionLease.findMany.mockResolvedValue([{ id: "lease_1" }]);
        dbMocks.db.voiceSessionLease.delete.mockResolvedValue({});
    });

    afterEach(() => {
        resetVoiceEnv();
    });

    it("registers /v1/voice/token with a per-user rate limit by default", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const opts = getRouteEntry(app, "POST", "/v1/voice/token").opts;
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 10,
                timeWindow: "1 minute",
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe(
            "uid:user-1",
        );
    });

    it("registers /v1/voice/session/complete with a per-user rate limit by default", async () => {
        const { voiceRoutes } = await import("./voiceRoutes");
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const opts = getRouteEntry(app, "POST", "/v1/voice/session/complete").opts;
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 60,
                timeWindow: "1 minute",
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe(
            "uid:user-1",
        );
    });

    it("can force ip-only route keying strategy via HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only",
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const opts = getRouteEntry(app, "POST", "/v1/voice/token").opts;
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe(
            "ip:203.0.113.9",
        );
    });

    it("allows overriding voice token max/window via HAPPIER_VOICE_TOKEN_RATE_LIMIT_*", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: "7",
            HAPPIER_VOICE_TOKEN_RATE_LIMIT_WINDOW: "30 seconds",
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const opts = getRouteEntry(app, "POST", "/v1/voice/token").opts;
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 7,
                timeWindow: "30 seconds",
            }),
        );
    });
});
