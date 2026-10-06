import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock, installPrismaModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
const dbMocks = createDbMocks({
    account: ["findUnique"],
    voiceSessionLease: ["deleteMany", "create", "findMany", "delete"],
} as const);
installDbModuleMock(() => ({
    db: dbMocks.db,
}));
// Registration uses the database fixture, so loading generated Prisma metadata is unnecessary.
installPrismaModuleMock({ getDbProviderFromEnv: () => "sqlite", isPrismaErrorCode: () => false });

// Rate-limit options read current env when each app registers the shared routes.
const { voiceRoutes } = await import("./voiceRoutes");
const { auth } = await import("@/app/auth/auth");

describe("voiceRoutes (rate limit)", () => {
    const resetVoiceEnv = createEnvReset();
    let accountToken: string;

    beforeEach(async () => {
        dbMocks.reset();
        dbMocks.db.account.findUnique.mockResolvedValue({ tokenEpoch: 0, status: "active" });
        resetVoiceEnv({
            HANDY_MASTER_SECRET: "voice-rate-limit-spec-secret",
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
        await auth.init();
        accountToken = await auth.createToken("user-1", undefined, { kind: "account", authority: "present_user" });
    });

    afterEach(() => {
        resetVoiceEnv();
    });

    it("composes one Fastify request limiter for both mint aliases and disables their automatic route limiters", async () => {
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const tokenRoute = getRouteEntry(app, "POST", "/v1/voice/token").opts;
        const leaseMintRoute = getRouteEntry(app, "POST", "/v1/voice/lease/mint").opts;
        expect(app.rateLimit).toHaveBeenCalledTimes(1);
        expect(app.rateLimit).toHaveBeenCalledWith(
            expect.objectContaining({
                max: 10,
                timeWindow: "1 minute",
            }),
        );
        const sharedHandler = app.rateLimit.mock.results[0]?.value;
        expect(tokenRoute.config?.rateLimit).toBe(false);
        expect(leaseMintRoute.config?.rateLimit).toBe(false);
        expect(tokenRoute.onRequest).toBe(sharedHandler);
        expect(leaseMintRoute.onRequest).toBe(sharedHandler);
        expect(tokenRoute.preHandler).toBe(app.authenticate);
        expect(leaseMintRoute.preHandler).toBe(app.authenticate);

        const rateLimitOptions = app.rateLimit.mock.calls[0]?.[0];
        expect(rateLimitOptions?.keyGenerator).toEqual(expect.any(Function));
        expect(await rateLimitOptions?.keyGenerator?.({ headers: { authorization: `Bearer ${accountToken}` }, ip: "203.0.113.9" })).toBe(
            "uid:user-1",
        );
    });

    it("registers /v1/voice/session/complete with a per-user rate limit by default", async () => {
        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const sessionStart = getRouteEntry(app, "POST", "/v1/voice/session/start").opts;
        const opts = getRouteEntry(app, "POST", "/v1/voice/session/complete").opts;
        expect(sessionStart.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 60,
                timeWindow: "1 minute",
            }),
        );
        expect(opts).toBeTruthy();
        expect(opts?.config?.rateLimit).toEqual(
            expect.objectContaining({
                max: 60,
                timeWindow: "1 minute",
            }),
        );
        expect(opts?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await opts?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: `Bearer ${accountToken}` }, ip: "203.0.113.9" })).toBe(
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

        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        const rateLimitOptions = app.rateLimit.mock.calls[0]?.[0];
        expect(await rateLimitOptions?.keyGenerator?.({ headers: { authorization: `Bearer ${accountToken}` }, ip: "203.0.113.9" })).toBe(
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

        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        expect(app.rateLimit).toHaveBeenCalledWith(
            expect.objectContaining({
                max: 7,
                timeWindow: "30 seconds",
            }),
        );
    });

    it("does not create a mint handler when API route rate limiting is disabled", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            HAPPIER_API_RATE_LIMITS_ENABLED: "false",
        });

        const app = createFakeRouteApp();
        voiceRoutes(app as any);

        expect(app.rateLimit).not.toHaveBeenCalled();
        expect(getRouteEntry(app, "POST", "/v1/voice/token").opts.onRequest).toBeUndefined();
        expect(getRouteEntry(app, "POST", "/v1/voice/lease/mint").opts.onRequest).toBeUndefined();
    });
});
