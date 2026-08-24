import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import {
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResponseEnvelopeUtf8BytesV1,
} from "@happier-dev/protocol/actions";
import {
    type RegisterExternalActionRoutesDependencies,
    registerExternalActionRoutes,
} from "./registerExternalActionRoutes";

function createApp(params: Readonly<{
    dispatch?: RegisterExternalActionRoutesDependencies["dispatch"];
    withGlobalCors?: boolean;
}> = {}) {
    const app = createAuthenticatedTestApp();
    if (params.withGlobalCors) {
        app.register(import("@fastify/cors"), { origin: "*" });
    }
    registerExternalActionRoutes(app, {
        dispatch: params.dispatch ?? vi.fn(async (request) => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true as const, result: { accepted: true } },
            },
        })),
    });
    return app;
}

const patHeaders = {
    authorization: "Bearer pat-secret",
    "x-test-user-id": "account-1",
    "x-test-auth-token-kind": "api_token",
    "x-test-api-token-account-id": "account-1",
    "x-test-api-token-principal-id": "principal-1",
    "x-test-api-token-credential-id": "credential-1",
};

function createDeepExternalActionResult(depth = 12_000): unknown {
    let result: unknown = "leaf";
    for (let index = 0; index < depth; index += 1) {
        result = { value: result };
    }
    return result;
}

function createExactLimitMultibyteResponseResult(): string {
    const emptyResponse = {
        v: 1,
        actionId: "session.spawn_new",
        requestId: "response-limit",
        execution: { ok: true, result: "" },
    } as const;
    const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse);
    const multibyteMarker = "é";
    const markerBytes = Buffer.byteLength(multibyteMarker, "utf8");
    return "a".repeat(
        EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
    ) + multibyteMarker;
}

function externalActionJsonPayloadWithByteLength(byteLength: number): string {
    const prefix = '{"v":1,"input":{"blob":"';
    const suffix = '"}}';
    const multiByteCharacter = "é";
    const paddingLength = byteLength - Buffer.byteLength(`${prefix}${multiByteCharacter}${suffix}`, "utf8");
    if (paddingLength < 0) throw new Error("Requested payload is too small");

    const payload = `${prefix}${"x".repeat(paddingLength)}${multiByteCharacter}${suffix}`;
    if (Buffer.byteLength(payload, "utf8") !== byteLength) {
        throw new Error("External Action payload did not reach the requested byte length");
    }
    return payload;
}

describe("registerExternalActionRoutes", () => {
    it("accepts a verified PAT, relays only the outer envelope, and forwards server-stamped provenance", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: "session.spawn_new" as const,
                requestId: "request-1",
                execution: { ok: true as const, result: { sessionId: "session-1" } },
            },
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const envelope = {
                v: 1,
                requestId: "request-1",
                target: { kind: "machine", machineId: "machine-1" },
                input: {
                    directory: "/workspace",
                    callerSuppliedAuthority: "present_user",
                },
            };
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: envelope,
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
            expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.body, "utf8"));
            expect(response.json()).toEqual({
                v: 1,
                actionId: "session.spawn_new",
                requestId: "request-1",
                execution: { ok: true, result: { sessionId: "session-1" } },
            });
            expect(dispatch).toHaveBeenCalledWith({
                actionId: "session.spawn_new",
                envelope,
                principal: {
                    accountId: "account-1",
                    principalId: "principal-1",
                    credentialId: "credential-1",
                    authority: "account_automation",
                },
            }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await app.close();
        }
    });

    it("returns typed invalid_action_output rather than a recursive JSON response failure", async () => {
        const dispatch = vi.fn()
            .mockImplementationOnce(async (request) => ({
                kind: "response" as const,
                response: {
                    v: 1 as const,
                    actionId: request.actionId,
                    execution: {
                        ok: true as const,
                        result: createDeepExternalActionResult(),
                    },
                },
            }))
            .mockImplementationOnce(async (request) => ({
                kind: "response" as const,
                response: {
                    v: 1 as const,
                    actionId: request.actionId,
                    execution: { ok: true as const, result: { carrier: "usable" } },
                },
            }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const deepResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });

            expect(deepResponse.statusCode).toBe(200);
            expect(deepResponse.json()).toMatchObject({
                v: 1,
                    actionId: "session.spawn_new",
                    execution: {
                        ok: false,
                        errorCode: "invalid_action_output",
                        error: "invalid_action_output",
                    },
                });

            const nextResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });
            expect(nextResponse.statusCode).toBe(200);
            expect(nextResponse.json()).toMatchObject({
                execution: { ok: true, result: { carrier: "usable" } },
            });
            expect(dispatch).toHaveBeenCalledTimes(2);
        } finally {
            await app.close();
        }
    });

    it("serializes exact response bytes, projects one extra byte, and stays usable through the server Fastify adapter", async () => {
        const exactLimitResult = createExactLimitMultibyteResponseResult();
        const dispatch = vi.fn()
            .mockImplementationOnce(async (request) => ({
                kind: "response" as const,
                response: {
                    v: 1 as const,
                    actionId: request.actionId,
                    ...(request.envelope.requestId === undefined
                        ? {}
                        : { requestId: request.envelope.requestId }),
                    execution: { ok: true as const, result: exactLimitResult },
                },
            }))
            .mockImplementationOnce(async (request) => ({
                kind: "response" as const,
                response: {
                    v: 1 as const,
                    actionId: request.actionId,
                    ...(request.envelope.requestId === undefined
                        ? {}
                        : { requestId: request.envelope.requestId }),
                    execution: { ok: true as const, result: `${exactLimitResult}a` },
                },
            }))
            .mockImplementationOnce(async (request) => ({
                kind: "response" as const,
                response: {
                    v: 1 as const,
                    actionId: request.actionId,
                    ...(request.envelope.requestId === undefined
                        ? {}
                        : { requestId: request.envelope.requestId }),
                    execution: { ok: true as const, result: { carrier: "usable" } },
                },
            }));
        const app = createApp({ dispatch });
        await app.ready();
        const request = {
            method: "POST" as const,
            url: "/v1/actions/session.spawn_new",
            headers: patHeaders,
            payload: { v: 1, requestId: "response-limit", input: {} },
        };
        try {
            const exact = await app.inject(request);
            expect(exact.statusCode).toBe(200);
            expect(exact.headers["cache-control"]).toBe("no-store");
            expect(Number(exact.headers["content-length"])).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
            expect(Buffer.byteLength(exact.body, "utf8")).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
            expect(exact.json()).toMatchObject({
                execution: { ok: true, result: exactLimitResult },
            });

            const oversized = await app.inject(request);
            expect(oversized.statusCode).toBe(200);
            expect(oversized.json()).toMatchObject({
                execution: {
                    ok: false,
                    errorCode: "result_too_large",
                    details: {
                        executionCompleted: true,
                        maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
                    },
                },
            });

            const followUp = await app.inject(request);
            expect(followUp.statusCode).toBe(200);
            expect(followUp.json()).toMatchObject({
                execution: { ok: true, result: { carrier: "usable" } },
            });
            expect(dispatch).toHaveBeenCalledTimes(3);
        } finally {
            await app.close();
        }
    });

    it("rejects non-PAT and daemon-control credentials without dispatching", async () => {
        const dispatch = vi.fn();
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const signedAccountResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    authorization: "Bearer signed-account-token",
                    "x-test-user-id": "account-1",
                    "x-test-auth-token-kind": "account",
                },
                payload: { v: 1, target: { kind: "machine", machineId: "machine-1" }, input: {} },
            });
            const daemonTokenResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    "x-happier-daemon-token": "private-control-token",
                    "x-test-user-id": "account-1",
                    "x-test-auth-token-kind": "api_token",
                },
                payload: { v: 1, target: { kind: "machine", machineId: "machine-1" }, input: {} },
            });

            expect(signedAccountResponse.statusCode).toBe(401);
            expect(signedAccountResponse.json()).toEqual({ error: "invalid_token" });
            expect(daemonTokenResponse.statusCode).toBe(401);
            expect(daemonTokenResponse.json()).toEqual({ error: "invalid_token" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("fails closed when request-local PAT provenance does not match the authenticated account", async () => {
        const dispatch = vi.fn();
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "x-test-api-token-account-id": "account-2",
                    "x-test-api-token-principal-id": "principal-2",
                },
                payload: { v: 1, target: { kind: "machine", machineId: "machine-1" }, input: {} },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("rejects malformed outer envelopes before placement relay", async () => {
        const dispatch = vi.fn();
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: {
                    v: 1,
                    target: { kind: "machine", machineId: "machine-1" },
                    input: {},
                    authority: "present_user",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_envelope" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("keeps an admitted Action's invalid_action domain failure in the canonical response envelope", async () => {
        const dispatch = vi.fn(async (request) => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: request.actionId,
                execution: {
                    ok: false as const,
                    errorCode: "invalid_action",
                    error: "invalid_action",
                },
            },
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
            expect(response.json()).toEqual({
                v: 1,
                actionId: "session.spawn_new",
                execution: {
                    ok: false,
                    errorCode: "invalid_action",
                    error: "invalid_action",
                },
            });
            expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
                actionId: "session.spawn_new",
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await app.close();
        }
    });

    it("relays an opaque newer Action id to the daemon without server-side admission", async () => {
        const dispatch = vi.fn(async (request) => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: request.actionId,
                execution: { ok: true as const, result: { accepted: true } },
            },
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/not-a-public-action",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                v: 1,
                actionId: "not-a-public-action",
                execution: { ok: true, result: { accepted: true } },
            });
            expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
                actionId: "not-a-public-action",
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await app.close();
        }
    });

    it("maps a daemon admission failure to the canonical invalid-request response", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "invalid_request" as const,
            errorCode: "invalid_action" as const,
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/not-a-public-action",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(400);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_action" });
            expect(dispatch).toHaveBeenCalledOnce();
        } finally {
            await app.close();
        }
    });

    it.each([
        ["malformed JSON", '{"v":', "application/json"],
        ["empty JSON", "", "application/json"],
        ["unsupported media type", '{"v":1,"input":{}}', "application/x-happier-external-action"],
    ])("maps %s parser failures to invalid_envelope without dispatching", async (_label, payload, contentType) => {
        const dispatch = vi.fn();
        const app = createApp({ dispatch, withGlobalCors: true });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "content-type": contentType,
                },
                payload,
            });

            expect(response.statusCode).toBe(400);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_envelope" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("enforces the shared byte ceiling with a typed non-CORS no-store response", async () => {
        const dispatch = vi.fn(async (request) => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: request.actionId,
                execution: { ok: true as const, result: { accepted: true } },
            },
        }));
        const app = createApp({ dispatch, withGlobalCors: true });
        await app.ready();
        try {
            expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBe(33_554_432);
            const exactLimitPayload = externalActionJsonPayloadWithByteLength(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
            const exactLimitResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "content-type": "application/json",
                },
                payload: exactLimitPayload,
            });
            expect(exactLimitResponse.statusCode).toBe(200);
            expect(exactLimitResponse.headers["cache-control"]).toBe("no-store");
            expect(exactLimitResponse.headers["access-control-allow-origin"]).toBeUndefined();
            expect(dispatch).toHaveBeenCalledOnce();

            dispatch.mockClear();
            const oneByteOverLimitPayload = externalActionJsonPayloadWithByteLength(
                EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES + 1,
            );
            const oneByteOverLimitResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "content-type": "application/json",
                },
                payload: oneByteOverLimitPayload,
            });
            expect(oneByteOverLimitResponse.statusCode).toBe(413);
            expect(oneByteOverLimitResponse.headers["cache-control"]).toBe("no-store");
            expect(oneByteOverLimitResponse.headers["access-control-allow-origin"]).toBeUndefined();
            expect(oneByteOverLimitResponse.json()).toEqual({
                error: "invalid_request",
                code: "request_too_large",
            });
            expect(dispatch).not.toHaveBeenCalled();

            const postRejectionResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "content-type": "application/json",
                },
                payload: { v: 1, input: { relay: "still-usable" } },
            });
            expect(postRejectionResponse.statusCode).toBe(200);
            expect(dispatch).toHaveBeenCalledOnce();
        } finally {
            await app.close();
        }
    });

    it("projects server placement failures through the finite Action response envelope", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "placement_error" as const,
            code: "target_required" as const,
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: { v: 1, requestId: "request-1", input: {} },
            });

            expect(response.statusCode).toBe(200);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.json()).toEqual({
                v: 1,
                actionId: "session.spawn_new",
                requestId: "request-1",
                execution: {
                    ok: false,
                    errorCode: "target_required",
                    error: "target_required",
                },
            });
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("keeps Action preflight unhandled and non-CORS", async () => {
        const app = createApp({ withGlobalCors: true });
        await app.ready();
        try {
            const response = await app.inject({
                method: "OPTIONS",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    origin: "https://example.test",
                    "access-control-request-method": "POST",
                },
            });

            expect(response.statusCode).toBe(404);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        } finally {
            await app.close();
        }
    });
});
