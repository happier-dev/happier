import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const leaseFindFirst = vi.fn();
const conversationUpsert = vi.fn();
const conversationFindUnique = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        voiceSessionLease: {
            findFirst: (...args: any[]) => leaseFindFirst(...args),
        },
        voiceConversation: {
            findUnique: (...args: any[]) => conversationFindUnique(...args),
            upsert: (...args: any[]) => conversationUpsert(...args),
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

describe("voiceRoutes (session complete)", () => {
    const originalEnv = process.env;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env = {
            ...originalEnv,
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID: "agent_dev",
        };
        leaseFindFirst.mockResolvedValue({
            id: "lease_1",
            accountId: "u1",
            elevenLabsAgentId: "agent_dev",
            createdAt: new Date("2026-02-01T00:00:00.000Z"),
            expiresAt: new Date("2026-02-01T01:00:00.000Z"),
        });
        conversationUpsert.mockResolvedValue({ id: "vc_1" });
        conversationFindUnique.mockResolvedValue(null);
        globalThis.fetch = vi.fn() as any;
    });

    afterEach(() => {
        process.env = originalEnv;
        globalThis.fetch = originalFetch;
    });

    it("fetches conversation details and stores duration for a valid lease", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                conversation_id: "conv_123",
                agent_id: "agent_dev",
                metadata: {
                    start_time_unix_secs: 1769904632,
                    call_duration_secs: 42,
                },
            }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/session/complete");
        const reply = replyStub();
        const res = await handler({ userId: "u1", body: { leaseId: "lease_1", providerConversationId: "conv_123" } }, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(res).toEqual(expect.objectContaining({ ok: true, durationSeconds: 42 }));
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://api.elevenlabs.io/v1/convai/conversations/conv_123",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ "xi-api-key": "el_key" }),
            }),
        );
        expect(conversationUpsert).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when Happier Voice is disabled", async () => {
        process.env.HAPPIER_FEATURE_VOICE__ENABLED = "0";

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/session/complete");
        const reply = replyStub();
        const res = await handler({ userId: "u1", body: { leaseId: "lease_1", providerConversationId: "conv_123" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ ok: false, reason: "not_found" });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("returns 503 when persisting the conversation fails", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                conversation_id: "conv_123",
                agent_id: "agent_dev",
                metadata: {
                    start_time_unix_secs: 1769904632,
                    call_duration_secs: 42,
                },
            }),
        });
        conversationUpsert.mockRejectedValueOnce(new Error("db-down"));

        const { voiceRoutes } = await import("./voiceRoutes");
        const app = new FakeApp();
        voiceRoutes(app as any);

        const handler = app.routes.get("POST /v1/voice/session/complete");
        const reply = replyStub();
        const res = await handler({ userId: "u1", body: { leaseId: "lease_1", providerConversationId: "conv_123" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(res).toEqual({ ok: false, reason: "upstream_error" });
    });
});
