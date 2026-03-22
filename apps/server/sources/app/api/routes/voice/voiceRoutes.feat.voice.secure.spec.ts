import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const dbMocks = createDbMocks({
    voiceSessionLease: ["count", "create", "findMany", "delete", "deleteMany"],
    voiceConversation: ["aggregate"],
} as const);
const leaseCount = dbMocks.db.voiceSessionLease.count;
const leaseCreate = dbMocks.db.voiceSessionLease.create;
const leaseFindMany = dbMocks.db.voiceSessionLease.findMany;
const leaseDelete = dbMocks.db.voiceSessionLease.delete;
const leaseDeleteMany = dbMocks.db.voiceSessionLease.deleteMany;
const conversationAggregate = dbMocks.db.voiceConversation.aggregate;
const dbTransaction = createDbTransactionMock(() => ({
    voiceSessionLease: dbMocks.db.voiceSessionLease,
    voiceConversation: dbMocks.db.voiceConversation,
}));

installDbModuleMock(() => ({
    db: dbTransaction.wrapDb(dbMocks.db),
}));

describe("voiceRoutes (secure)", () => {
    const resetVoiceEnv = createEnvReset();
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-02-03T12:00:00.000Z"));
        vi.clearAllMocks();
        dbMocks.reset();
        dbTransaction.transaction.mockClear();
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });
        leaseCount.mockResolvedValue(0);
        leaseCreate.mockResolvedValue({ id: "lease_1" });
        leaseFindMany.mockResolvedValue([{ id: "lease_1" }]);
        leaseDelete.mockResolvedValue({});
        leaseDeleteMany.mockResolvedValue({ count: 0 });
        conversationAggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } });

        globalThis.fetch = vi.fn() as any;
    });

    afterEach(() => {
        vi.useRealTimers();
        resetVoiceEnv();
        globalThis.fetch = originalFetch;
    });

    it("returns 403 when voice is disabled", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "0",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "voice_disabled" }));
    });

    it("returns 403 when build policy denies voice even if voice is requested but misconfigured", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            HAPPIER_FEATURE_POLICY_ENV: "preview",
            HAPPIER_EMBEDDED_POLICY_ENV: "preview",
            ELEVENLABS_API_KEY: undefined,
            ELEVENLABS_AGENT_ID_PROD: undefined,
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "voice_disabled" }));
    });

    it("returns 503 when ElevenLabs is not configured", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: undefined,
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
    });

    it("returns 403 when user is not subscribed and free quota is 0", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "subscription_required" }));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns 403 quota_exceeded when user is not subscribed and free minutes are exhausted", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_MINUTES_PER_MONTH: "1",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 60 } });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
    });

    it("returns 503 when RevenueCat is unavailable", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 503,
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "upstream_error" }));
    });

    it("returns 503 when RevenueCat credentials are invalid (401)", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "upstream_error" }));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns 503 when RevenueCat forbids access (403)", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 403,
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "upstream_error" }));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns 429 when user already has an active session", async () => {
        leaseFindMany.mockResolvedValueOnce([{ id: "lease_other" }]);

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: { voice: { expires_date: "2099-01-01" } } } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(429);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "too_many_sessions" }));
        expect(leaseCreate).toHaveBeenCalledTimes(1);
        expect(leaseDelete).toHaveBeenCalledTimes(1);
    });

    it("returns token when user is subscribed (voice entitlement)", async () => {
        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ subscriber: { entitlements: { active: { voice: { expires_date: "2099-01-01" } } } } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ token: "conv_token" }),
            });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).not.toHaveBeenCalled();
        expect(res).toEqual(expect.objectContaining({ allowed: true, token: "conv_token", leaseId: "lease_1", expiresAtMs: expect.any(Number) }));
        expect(leaseCreate).toHaveBeenCalledTimes(1);
        expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("aliases /v1/voice/lease/mint and persists a lease with sessionId null when body is empty", async () => {
        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ subscriber: { entitlements: { active: { voice: { expires_date: "2099-01-01" } } } } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ token: "conv_token" }),
            });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/lease/mint",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });

        const { response: res, reply } = await route.invoke({ userId: "u1", body: {} });

        expect(reply.code).not.toHaveBeenCalled();
        expect(res).toEqual(
            expect.objectContaining({ allowed: true, token: "conv_token", leaseId: "lease_1", expiresAtMs: expect.any(Number) }),
        );
        expect(leaseCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ sessionId: null }),
            }),
        );
    });

    it("normalizes empty/whitespace sessionId to null for /v1/voice/token", async () => {
        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ subscriber: { entitlements: { active: { voice: { expires_date: "2099-01-01" } } } } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ token: "conv_token" }),
            });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "   " } });

        expect(reply.code).not.toHaveBeenCalled();
        expect(leaseCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ sessionId: null }),
            }),
        );
    });

    it("returns 403 when max minutes per day is exceeded", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "0",
            VOICE_MAX_MINUTES_PER_DAY: "1",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 60 } });
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: "conv_token" }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
        expect(leaseCreate).not.toHaveBeenCalled();
    });

    it("returns 403 when max minutes per day is exceeded by pending leases", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "0",
            VOICE_MAX_MINUTES_PER_DAY: "1",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 0 } });
        leaseCount.mockResolvedValueOnce(1);

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
        expect(leaseCreate).not.toHaveBeenCalled();
    });

    it("returns 403 quota_exceeded when free minutes are exhausted by pending leases", async () => {
        resetVoiceEnv({
            NODE_ENV: "production",
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_MINUTES_PER_MONTH: "1",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        });
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 0 } });
        leaseCount.mockResolvedValueOnce(1);

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/token",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "u1", body: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
    });
});
