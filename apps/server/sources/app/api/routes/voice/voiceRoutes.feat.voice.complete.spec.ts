import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE } from "@happier-dev/protocol";

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from "../../testkit/dbMocks";
import { createEnvReset } from "../../testkit/env";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const logSpy = vi.hoisted(() => vi.fn());

vi.mock("@/utils/logging/log", () => ({ log: logSpy }));

const dbMocks = createDbMocks({
    voiceSessionLease: ["findFirst", "updateMany"],
    voiceConversation: ["findUnique", "findFirst", "create"],
} as const);

const leaseFindFirst = dbMocks.db.voiceSessionLease.findFirst;
const leaseUpdateMany = dbMocks.db.voiceSessionLease.updateMany;
const conversationCreate = dbMocks.db.voiceConversation.create;
const conversationFindUnique = dbMocks.db.voiceConversation.findUnique;
const conversationFindFirst = dbMocks.db.voiceConversation.findFirst;
const dbTransactionMock = createDbTransactionMock(() => dbMocks.db);

installDbModuleMock(() => ({
    db: dbTransactionMock.wrapDb(dbMocks.db),
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
        const now = Date.now();
        leaseFindFirst.mockResolvedValue({
            id: "lease_1",
            accountId: "u1",
            elevenLabsAgentId: "agent_dev",
            providerBindingNonce: "nonce_lease_1",
            createdAt: new Date(now - 60_000),
            expiresAt: new Date(now + 60 * 60 * 1000),
        });
        leaseUpdateMany.mockResolvedValue({ count: 1 });
        conversationCreate.mockResolvedValue({ id: "vc_1" });
        conversationFindUnique.mockResolvedValue(null);
        conversationFindFirst.mockResolvedValue(null);
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

    function providerJsonResponse(payload: unknown, status = 200): Response {
        return new Response(JSON.stringify(payload), {
            status,
            headers: { "content-type": "application/json" },
        });
    }

    function providerConversationDetails(params: {
        bindingNonce?: string;
        durationSeconds: number;
        startTimeUnixSecs?: number;
        agentId?: string;
    }) {
        return {
            conversation_id: "conv_123",
            agent_id: params.agentId ?? "agent_dev",
            metadata: {
                start_time_unix_secs: params.startTimeUnixSecs ?? Math.floor(Date.now() / 1000),
                call_duration_secs: params.durationSeconds,
            },
            conversation_initiation_client_data: {
                dynamic_variables: {
                    [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: params.bindingNonce ?? "nonce_lease_1",
                },
            },
        };
    }

    it("fetches conversation details and stores duration for a valid lease", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            providerJsonResponse(providerConversationDetails({ durationSeconds: 42 })),
        );

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
        expect(conversationCreate).toHaveBeenCalledTimes(1);
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
        (globalThis.fetch as any).mockResolvedValueOnce(
            providerJsonResponse(providerConversationDetails({ durationSeconds: 42 })),
        );
        conversationCreate.mockRejectedValueOnce(new Error("db-down"));

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
        const startedAt = new Date(Date.now() + 50 * 60 * 1000);
        const startedAtUnixSecs = Math.floor(startedAt.getTime() / 1000);

        (globalThis.fetch as any).mockResolvedValueOnce(
            providerJsonResponse(providerConversationDetails({
                startTimeUnixSecs: startedAtUnixSecs,
                // Lease expires at 01:00Z (+5m slack), so this pushes endedAt beyond the upper bound.
                durationSeconds: 20 * 60,
            })),
        );

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
        expect(conversationCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when provider conversation details do not echo the lease nonce", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            providerJsonResponse(providerConversationDetails({
                bindingNonce: "attacker_nonce",
                durationSeconds: 42,
            })),
        );

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
        expect(conversationCreate).not.toHaveBeenCalled();
    });

    it("returns a safe bounded diagnostic when provider conversation data is malformed", async () => {
        (globalThis.fetch as any).mockResolvedValueOnce(
            providerJsonResponse({
                metadata: {
                    call_duration_secs: "private-provider-body",
                    start_time_unix_secs: Math.floor(Date.now() / 1000),
                },
            }),
        );

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
        expect(renderedLogs()).toContain("invalid_conversation_response");
        expect(renderedLogs()).not.toContain("el_key");
        expect(renderedLogs()).not.toContain("private-provider-body");
        expect(conversationCreate).not.toHaveBeenCalled();
    });
});
