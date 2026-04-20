import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const logSpy = vi.hoisted(() => vi.fn());

vi.mock("@/utils/logging/log", () => ({ log: logSpy }));

const dbMocks = createDbMocks({
    voiceSessionLease: ["findFirst"],
    voiceConversation: ["findUnique", "upsert"],
} as const);

const leaseFindFirst = dbMocks.db.voiceSessionLease.findFirst;
const conversationUpsert = dbMocks.db.voiceConversation.upsert;
const conversationFindUnique = dbMocks.db.voiceConversation.findUnique;

installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("voiceRoutes (session complete)", () => {
    const resetVoiceEnv = createEnvReset();
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        dbMocks.reset();
        resetVoiceEnv({
            HAPPIER_FEATURE_VOICE__ENABLED: "1",
            ELEVENLABS_API_KEY: "el_key",
            ELEVENLABS_AGENT_ID: "agent_dev",
        });
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
        resetVoiceEnv();
        globalThis.fetch = originalFetch;
    });

    function renderedLogs(): string {
        return logSpy.mock.calls
            .flatMap((call) => call.map((value) => (typeof value === "string" ? value : JSON.stringify(value))))
            .join(" ");
    }

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
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

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
        resetVoiceEnv({ HAPPIER_FEATURE_VOICE__ENABLED: "0" });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

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
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

        expect(reply.code).toHaveBeenCalledWith(503);
        expect(res).toEqual({ ok: false, reason: "upstream_error" });
        expect(renderedLogs()).not.toContain("lease_1");
        expect(renderedLogs()).not.toContain("conv_123");
    });

    it("returns 404 when the provider-reported duration exceeds the lease window", async () => {
        const startedAt = new Date("2026-02-01T00:50:00.000Z");
        const startedAtUnixSecs = Math.floor(startedAt.getTime() / 1000);

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                conversation_id: "conv_123",
                agent_id: "agent_dev",
                metadata: {
                    start_time_unix_secs: startedAtUnixSecs,
                    // Lease expires at 01:00Z (+5m slack), so this pushes endedAt beyond the upper bound.
                    call_duration_secs: 20 * 60,
                },
            }),
        });

        const { voiceRoutes } = await import("./voiceRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/voice/session/complete",
            registerRoutes(app) {
                voiceRoutes(app as any);
            },
        });
        const { response: res, reply } = await route.invoke({
            userId: "u1",
            body: { leaseId: "lease_1", providerConversationId: "conv_123" },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ ok: false, reason: "not_found" });
        expect(conversationUpsert).not.toHaveBeenCalled();
    });
});
