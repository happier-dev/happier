import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const leaseCount = vi.fn();
const leaseCreate = vi.fn();
const leaseFindMany = vi.fn();
const leaseDelete = vi.fn();
const leaseDeleteMany = vi.fn();
const conversationAggregate = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        voiceSessionLease: {
            count: (...args: any[]) => leaseCount(...args),
            create: (...args: any[]) => leaseCreate(...args),
            findMany: (...args: any[]) => leaseFindMany(...args),
            delete: (...args: any[]) => leaseDelete(...args),
            deleteMany: (...args: any[]) => leaseDeleteMany(...args),
        },
        voiceConversation: {
            aggregate: (...args: any[]) => conversationAggregate(...args),
        },
    },
}));

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get() { }
    post(path: string, _opts: any, handler: any) {
        this.routes.set(`POST ${path}`, handler);
    }
}

function replyStub() {
    const reply: any = { send: vi.fn((p: any) => p), code: vi.fn(() => reply) };
    return reply;
}

describe("voiceRoutes (secure)", () => {
    const originalEnv = process.env;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-02-03T12:00:00.000Z"));
        vi.clearAllMocks();
        leaseCount.mockResolvedValue(0);
        leaseCreate.mockResolvedValue({ id: "lease_1" });
        leaseFindMany.mockResolvedValue([{ id: "lease_1" }]);
        leaseDelete.mockResolvedValue({});
        leaseDeleteMany.mockResolvedValue({ count: 0 });
        conversationAggregate.mockResolvedValue({ _sum: { durationSeconds: 0 } });

        process.env = {
            ...originalEnv,
            NODE_ENV: "production",
            VOICE_ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID_PROD: "agent_prod",
            REVENUECAT_SECRET_KEY: "rc_secret",
            VOICE_FREE_SESSIONS_PER_MONTH: "0",
            VOICE_MAX_CONCURRENT_SESSIONS: "1",
            VOICE_MAX_SESSION_SECONDS: "600",
        };

        globalThis.fetch = vi.fn() as any;
    });

    afterEach(() => {
        vi.useRealTimers();
        process.env = originalEnv;
        globalThis.fetch = originalFetch;
    });

    it("returns 403 when voice is disabled", async () => {
        process.env.VOICE_ENABLED = "0";

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "voice_disabled" }));
    });

    it("returns 503 when ElevenLabs is not configured", async () => {
        delete process.env.ELEVENLABS_API_KEY;

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
    });

    it("returns 403 when user is not subscribed and free quota is 0", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "subscription_required" }));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns 403 quota_exceeded when user is not subscribed and free minutes are exhausted", async () => {
        process.env.VOICE_FREE_MINUTES_PER_MONTH = "1";
        process.env.VOICE_FREE_SESSIONS_PER_MONTH = "0";
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 60 } });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
    });

    it("returns 503 when RevenueCat is unavailable", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 503,
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "upstream_error" }));
    });

    it("returns 503 when RevenueCat credentials are invalid (401)", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 401,
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

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
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

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
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

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
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        const res = await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(res).toEqual(expect.objectContaining({ allowed: true, token: "conv_token", leaseId: "lease_1", expiresAtMs: expect.any(Number) }));
        expect(leaseCreate).toHaveBeenCalledTimes(1);
        expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("returns 403 when max minutes per day is exceeded", async () => {
        process.env.VOICE_REQUIRE_SUBSCRIPTION = "0";
        process.env.VOICE_MAX_MINUTES_PER_DAY = "1";
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 60 } });
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ token: "conv_token" }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
        expect(leaseCreate).not.toHaveBeenCalled();
    });

    it("returns 403 when max minutes per day is exceeded by pending leases", async () => {
        process.env.VOICE_REQUIRE_SUBSCRIPTION = "0";
        process.env.VOICE_MAX_MINUTES_PER_DAY = "1";
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 0 } });
        leaseCount.mockResolvedValueOnce(1);

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
        expect(leaseCreate).not.toHaveBeenCalled();
    });

    it("returns 403 quota_exceeded when free minutes are exhausted by pending leases", async () => {
        process.env.VOICE_FREE_MINUTES_PER_MONTH = "1";
        process.env.VOICE_FREE_SESSIONS_PER_MONTH = "0";
        conversationAggregate.mockResolvedValueOnce({ _sum: { durationSeconds: 0 } });
        leaseCount.mockResolvedValueOnce(1);

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ subscriber: { entitlements: { active: {} } } }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/token");
        const reply = replyStub();
        await handler({ userId: "u1", body: { sessionId: "s1" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, reason: "quota_exceeded" }));
    });
});
