import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE } from "@happier-dev/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createHostedElevenLabsService,
    resolveElevenLabsAgentId,
    resolveElevenLabsApiBaseUrl,
    type HostedElevenLabsFetch,
} from "./elevenLabs";

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function createFetchMock(): ReturnType<typeof vi.fn<HostedElevenLabsFetch>> {
    return vi.fn<HostedElevenLabsFetch>();
}

describe("hosted ElevenLabs provider service", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("resolves environment configuration without exposing the API key", () => {
        expect(resolveElevenLabsAgentId({})).toBeUndefined();
        expect(resolveElevenLabsAgentId({
            NODE_ENV: "production",
            ELEVENLABS_AGENT_ID: " generic ",
            ELEVENLABS_AGENT_ID_PROD: " production ",
        })).toBe("production");
        expect(resolveElevenLabsApiBaseUrl({ ELEVENLABS_API_BASE_URL: "https://provider.example///" })).toBe(
            "https://provider.example",
        );

        const service = createHostedElevenLabsService({
            ELEVENLABS_API_KEY: "sensitive-api-key",
            ELEVENLABS_AGENT_ID: "agent_1",
        });
        expect(service.isApiConfigured).toBe(true);
        expect(service.configuredAgentId).toBe("agent_1");
        expect(JSON.stringify(service)).not.toContain("sensitive-api-key");
    });

    it("mints a token through the provider boundary and rejects malformed responses", async () => {
        const fetchImpl = createFetchMock();
        fetchImpl
            .mockResolvedValueOnce(jsonResponse({ token: " token_1 " }))
            .mockResolvedValueOnce(jsonResponse({ token: 42 }));
        const service = createHostedElevenLabsService(
            {
                ELEVENLABS_API_KEY: "sensitive-api-key",
                ELEVENLABS_AGENT_ID: "agent/with space",
                ELEVENLABS_API_BASE_URL: "https://provider.example/",
            },
            { fetchImpl },
        );

        await expect(service.mintConversationToken()).resolves.toEqual({ ok: true, token: "token_1" });
        expect(fetchImpl).toHaveBeenNthCalledWith(
            1,
            "https://provider.example/v1/convai/conversation/token?agent_id=agent%2Fwith%20space",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ "xi-api-key": "sensitive-api-key" }),
            }),
        );
        await expect(service.mintConversationToken()).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "invalid_mint_response",
        });
    });

    it("distinguishes caller abort from the provider timeout without returning raw errors", async () => {
        vi.useFakeTimers();
        const fetchImpl = createFetchMock();
        fetchImpl.mockImplementation(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("sensitive-api-key provider-body")), { once: true });
        }));
        const service = createHostedElevenLabsService(
            {
                ELEVENLABS_API_KEY: "sensitive-api-key",
                ELEVENLABS_AGENT_ID: "agent_1",
            },
            { fetchImpl, requestTimeoutMs: 25 },
        );

        const timedOut = service.mintConversationToken();
        await vi.advanceTimersByTimeAsync(25);
        const timeoutResult = await timedOut;
        expect(timeoutResult).toEqual({ ok: false, reason: "upstream_error", diagnosticCode: "timeout" });
        expect(JSON.stringify(timeoutResult)).not.toContain("sensitive-api-key");
        expect(JSON.stringify(timeoutResult)).not.toContain("provider-body");

        const caller = new AbortController();
        const aborted = service.mintConversationToken({ signal: caller.signal });
        caller.abort();
        await expect(aborted).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "aborted",
        });
    });

    it("keeps timeout and caller abort active while the provider response body is streaming", async () => {
        vi.useFakeTimers();
        const activeBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
        const fetchImpl = createFetchMock();
        fetchImpl.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                activeBodies.push(controller);
                controller.enqueue(new TextEncoder().encode('{"token":"partial'));
            },
        })));
        const service = createHostedElevenLabsService(
            {
                ELEVENLABS_API_KEY: "sensitive-api-key",
                ELEVENLABS_AGENT_ID: "agent_1",
            },
            { fetchImpl, requestTimeoutMs: 25 },
        );

        const timedOut = service.mintConversationToken();
        let timeoutOutcome: Awaited<typeof timedOut> | undefined;
        void timedOut.then((result) => {
            timeoutOutcome = result;
        });
        await vi.advanceTimersByTimeAsync(25);
        await Promise.resolve();
        if (!timeoutOutcome) activeBodies[0]?.close();
        await timedOut;
        expect(timeoutOutcome).toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "timeout",
        });

        const caller = new AbortController();
        const aborted = service.mintConversationToken({ signal: caller.signal });
        let abortOutcome: Awaited<typeof aborted> | undefined;
        void aborted.then((result) => {
            abortOutcome = result;
        });
        caller.abort();
        await Promise.resolve();
        if (!abortOutcome) activeBodies[1]?.close();
        await aborted;
        expect(abortOutcome).toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "aborted",
        });
    });

    it("bounds successful JSON bodies and cancels unread or rejected provider bodies", async () => {
        let rejectedBodyCancelled = false;
        const oversizedChunk = new Uint8Array(5 * 1024 * 1024);
        let oversizedChunkSent = false;
        const fetchImpl = createFetchMock();
        fetchImpl
            .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (!oversizedChunkSent) {
                        oversizedChunkSent = true;
                        controller.enqueue(oversizedChunk);
                        return;
                    }
                    controller.close();
                },
            })))
            .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("private-provider-body"));
                },
                cancel() {
                    rejectedBodyCancelled = true;
                },
            }), { status: 503 }));
        const service = createHostedElevenLabsService(
            {
                ELEVENLABS_API_KEY: "sensitive-api-key",
                ELEVENLABS_AGENT_ID: "agent_1",
            },
            { fetchImpl },
        );

        await expect(service.mintConversationToken()).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "response_too_large",
        });
        await expect(service.mintConversationToken()).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "provider_http_error",
        });
        expect(rejectedBodyCancelled).toBe(true);
    });

    it("does not follow provider redirects with the API key", async () => {
        const fetchImpl = createFetchMock();
        fetchImpl.mockResolvedValueOnce(new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/collect" },
        }));
        const service = createHostedElevenLabsService(
            {
                ELEVENLABS_API_KEY: "sensitive-api-key",
                ELEVENLABS_AGENT_ID: "agent_1",
            },
            { fetchImpl },
        );

        await expect(service.mintConversationToken()).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "provider_http_error",
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ redirect: "manual" }),
        );
    });

    it("normalizes provider-attested conversation identity, nonce, time, and duration", async () => {
        const fetchImpl = createFetchMock();
        fetchImpl.mockResolvedValueOnce(jsonResponse({
            conversation_id: "conversation/1",
            metadata: {
                agent_id: "agent_1",
                start_time_unix_secs: "1700000000",
                call_duration_secs: "42.9",
            },
            conversationInitiationClientData: {
                dynamicVariables: {
                    [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: "nonce_1",
                },
            },
        }));
        const service = createHostedElevenLabsService(
            { ELEVENLABS_API_KEY: "api-key" },
            { fetchImpl },
        );
        const leaseCreatedAt = new Date((1_700_000_000 - 60) * 1000);
        const leaseExpiresAt = new Date((1_700_000_000 + 600) * 1000);

        await expect(service.verifyConversation({
            providerConversationId: "conversation/1",
            expectedAgentId: "agent_1",
            expectedBindingNonce: "nonce_1",
            leaseCreatedAt,
            leaseExpiresAt,
        })).resolves.toEqual({
            ok: true,
            durationSeconds: 42,
            startedAt: new Date(1_700_000_000 * 1000),
            endedAt: new Date((1_700_000_000 + 42) * 1000),
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://api.elevenlabs.io/v1/convai/conversations/conversation%2F1",
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("fails closed for agent, nonce, and lease-window mismatches", async () => {
        const fetchImpl = createFetchMock();
        const startTime = 1_700_000_000;
        const basePayload = {
            conversation_id: "conversation_1",
            agent_id: "other_agent",
            metadata: { start_time_unix_secs: startTime, call_duration_secs: 12 },
            conversation_initiation_client_data: {
                dynamic_variables: { [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: "nonce_1" },
            },
        };
        fetchImpl
            .mockResolvedValueOnce(jsonResponse(basePayload))
            .mockResolvedValueOnce(jsonResponse({ ...basePayload, agent_id: "agent_1", conversation_initiation_client_data: {
                dynamic_variables: { [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: " nonce_1 " },
            } }))
            .mockResolvedValueOnce(jsonResponse({ ...basePayload, agent_id: "agent_1", metadata: {
                start_time_unix_secs: startTime + 10_000,
                call_duration_secs: 12,
            } }))
            .mockResolvedValueOnce(jsonResponse({ ...basePayload, conversation_id: "other_conversation", agent_id: "agent_1" }));
        const service = createHostedElevenLabsService({ ELEVENLABS_API_KEY: "api-key" }, { fetchImpl });
        const input = {
            providerConversationId: "conversation_1",
            expectedAgentId: "agent_1",
            expectedBindingNonce: "nonce_1",
            leaseCreatedAt: new Date((startTime - 60) * 1000),
            leaseExpiresAt: new Date((startTime + 600) * 1000),
        };

        await expect(service.verifyConversation(input)).resolves.toEqual({
            ok: false,
            reason: "not_found",
            diagnosticCode: "agent_mismatch",
        });
        await expect(service.verifyConversation(input)).resolves.toEqual({
            ok: false,
            reason: "not_found",
            diagnosticCode: "binding_nonce_mismatch",
        });
        await expect(service.verifyConversation(input)).resolves.toEqual({
            ok: false,
            reason: "not_found",
            diagnosticCode: "conversation_outside_lease_window",
        });
        await expect(service.verifyConversation(input)).resolves.toEqual({
            ok: false,
            reason: "not_found",
            diagnosticCode: "conversation_id_mismatch",
        });
    });

    it("rejects malformed fetch responses and returns only bounded diagnostics", async () => {
        const fetchImpl = createFetchMock();
        fetchImpl
            .mockResolvedValueOnce(jsonResponse({
                conversation_id: "conversation_1",
                agent_id: "agent_1",
                metadata: { start_time_unix_secs: "1700000000", call_duration_secs: " " },
                conversation_initiation_client_data: {
                    dynamic_variables: { [HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE]: "nonce_1" },
                },
            }))
            .mockResolvedValueOnce(jsonResponse({ conversation_id: "conversation_1", metadata: { call_duration_secs: -1 } }))
            .mockResolvedValueOnce(jsonResponse({ error: "secret provider body" }, 500))
            .mockRejectedValueOnce(new Error("api-key secret provider body"));
        const service = createHostedElevenLabsService({ ELEVENLABS_API_KEY: "api-key" }, { fetchImpl });
        const input = {
            providerConversationId: "conversation_1",
            expectedAgentId: "agent_1",
            expectedBindingNonce: "nonce_1",
            leaseCreatedAt: new Date(0),
            leaseExpiresAt: new Date(2_000_000_000_000),
        };

        const invalidResponse = {
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "invalid_conversation_response",
        } as const;
        await expect(service.verifyConversation(input)).resolves.toEqual(invalidResponse);
        await expect(service.verifyConversation(input)).resolves.toEqual(invalidResponse);
        await expect(service.verifyConversation(input)).resolves.toEqual({
            ok: false,
            reason: "upstream_error",
            diagnosticCode: "provider_http_error",
        });
        const thrown = await service.verifyConversation(input);
        expect(thrown).toEqual({ ok: false, reason: "upstream_error", diagnosticCode: "network_error" });
        expect(JSON.stringify(thrown)).not.toContain("api-key");
        expect(JSON.stringify(thrown)).not.toContain("provider body");
    });
});
