import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES } from "@happier-dev/protocol/actions";
import {
    type RegisterExternalActionRoutesDependencies,
    registerExternalActionRoutes,
    type VerifyExternalActionPat,
} from "./registerExternalActionRoutes";

const verifiedPat = {
    ok: true as const,
    accountId: "account-1",
    principalId: "principal-1",
    credentialId: "credential-1",
    expiresAt: null,
    authority: "account_automation" as const,
};

function createApp(params: Readonly<{
    verifyPat?: VerifyExternalActionPat;
    dispatch?: RegisterExternalActionRoutesDependencies["dispatch"];
    withGlobalCors?: boolean;
}> = {}) {
    const app = createAuthenticatedTestApp();
    if (params.withGlobalCors) {
        app.register(import("@fastify/cors"), { origin: "*" });
    }
    registerExternalActionRoutes(app, {
        verifyPat: params.verifyPat ?? vi.fn(async () => verifiedPat),
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
};

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
        const verifyPat = vi.fn(async () => verifiedPat);
        const dispatch = vi.fn(async () => ({
            kind: "response" as const,
            response: {
                v: 1 as const,
                actionId: "session.spawn_new",
                requestId: "request-1",
                execution: { ok: true as const, result: { sessionId: "session-1" } },
            },
        }));
        const app = createApp({ verifyPat, dispatch });
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
            expect(verifyPat).toHaveBeenCalledWith("pat-secret", expect.any(AbortSignal));
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

    it("rejects non-PAT and daemon-control credentials without dispatching", async () => {
        const verifyPat = vi.fn(async () => verifiedPat);
        const dispatch = vi.fn();
        const app = createApp({ verifyPat, dispatch });
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
            expect(verifyPat).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("fails closed when PAT re-verification does not match the authenticated account", async () => {
        const verifyPat = vi.fn(async () => ({
            ...verifiedPat,
            accountId: "account-2",
            principalId: "principal-2",
        }));
        const dispatch = vi.fn();
        const app = createApp({ verifyPat, dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
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

    it("projects a daemon-rejected invalid action id through the same typed HTTP error contract", async () => {
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
                url: "/v1/actions/not-a-public-action",
                headers: patHeaders,
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(400);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_action" });
            expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
                actionId: "not-a-public-action",
            }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        } finally {
            await app.close();
        }
    });
});
