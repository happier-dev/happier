import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { Buffer } from "node:buffer";
import type { FastifyRequest, RouteOptions } from "fastify";

import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol";
import {
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    ExternalActionRequestEnvelopeSchema,
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    measureExternalActionResponseEnvelopeUtf8BytesV1,
    prepareExternalActionResponseEnvelopeV1,
    prepareExternalActionResponseV2,
    sealExternalActionRequestV2,
    createExternalActionDaemonDispatchResponse,
    ExternalActionExecutionAuthorizationV1Schema,
} from "@happier-dev/protocol/actions";
import { EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2 } from "@happier-dev/protocol/actions/externalActionApi";
import { createExternalActionDaemonDispatcher } from "@/app/api/socket/externalActionDispatcher";
import { Server } from "socket.io";
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';
import {
    type RegisterExternalActionRoutesDependencies,
    registerExternalActionRoutes,
} from "./registerExternalActionRoutes";

function dispatchedResponse(response: unknown) {
    return {
        kind: "response" as const,
        prepared: prepareExternalActionResponseEnvelopeV1(response),
    };
}

function createApp(params: Readonly<{
    dispatch?: RegisterExternalActionRoutesDependencies["dispatch"];
    withGlobalCors?: boolean;
    beforeRegister?: (app: ReturnType<typeof createAuthenticatedTestApp>) => void;
}> = {}) {
    const app = createAuthenticatedTestApp();
    if (params.withGlobalCors) {
        app.register(import("@fastify/cors"), { origin: "*" });
    }
    params.beforeRegister?.(app);
    registerExternalActionRoutes(app, {
        dispatch: params.dispatch ?? vi.fn(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            ...(request.envelope.requestId === undefined
                ? {}
                : { requestId: request.envelope.requestId }),
            execution: { ok: true as const, result: { accepted: true } },
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

function externalActionV2JsonPayloadWithByteLength(byteLength: number): string {
    const prefix = '{"v":2,"requestId":"request-limit","payload":{"t":"encrypted","c":"';
    const suffix = '"}}';
    const paddingLength = byteLength - Buffer.byteLength(`${prefix}${suffix}`, "utf8");
    if (paddingLength < 1) throw new Error("Requested payload is too small");
    return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

describe("registerExternalActionRoutes", () => {
    it.each([false, true])('excludes multiline exception content from the real HTTP log (unproven stack: %s)', unproven => {
        const records: unknown[] = [];
        const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
        const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
        const failure = new Error('private message\n    at /CREDENTIAL_SENTINEL.js:7:9');
        if (unproven) failure.stack = '    at /UNPROVEN_SENTINEL.js:1:2';
        try {
            logUnexpectedRequestError(failure, { module: 'external-action-error', httpRequestId: 'http-request' });
            expect(JSON.stringify(records)).not.toContain('SENTINEL');
            expect(records).toEqual([expect.objectContaining({ errorClass: 'Error',
                stackFrames: unproven ? [] : expect.arrayContaining([
                    expect.objectContaining({ file: expect.stringContaining('registerExternalActionRoutes.test.ts') }),
                ]) })]);
        } finally { sink.mockRestore(); }
    });

    it.each([
        { name: 'PrismaClientKnownRequestError', code: 'P2028', errorClass: 'PrismaClientKnownRequestError', prismaCode: 'P2028',
            file: '/srv/happier/apps/server/sources/storage/inTx.ts' },
        { name: 'private-name', code: 'private-code', errorClass: 'Error', prismaCode: undefined,
            file: 'C:\\happier\\apps\\server\\sources\\storage\\inTx.ts' },
        { name: 'TypeError', code: 'E_PRIVATE_TOKEN', errorClass: 'TypeError', prismaCode: undefined,
            file: '/srv/happier/action.ts' },
    ])('logs safe unexpected-error pointers for $errorClass correlated to the Action request without exception content', async diagnostic => {
        const requestId = '887f79a3-8bf6-4152-a141-312b294b1b23';
        const failure = Object.assign(new Error('private-driver-message'), { name: diagnostic.name, code: diagnostic.code,
            stack: `${diagnostic.name}: private-driver-message\nSQL private-query\n    at privateFunction (${diagnostic.file}:250:18)\n    at privateFunction (https://private-host/source.js?private-token:1:2)` });
        const records: unknown[] = [];
        const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
        const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
        const app = createApp({ beforeRegister: instance => {
            // Authentication/driver failure arrives at Fastify's route error boundary.
            instance.addHook('preHandler', async () => { throw failure; });
        } });
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/actions/session.spawn_new', headers: patHeaders,
                payload: { v: 1, requestId, input: { private: 'private-input' } } });
            expect(response.statusCode).toBe(500);
            expect(response.json()).toMatchObject({ code: 'action_not_admitted', requestId });
            expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'external-action-error',
                requestId, actionId: 'session.spawn_new', phase: 'action_request',
                httpRequestId: expect.any(String), errorClass: diagnostic.errorClass,
                errorCode: diagnostic.prismaCode ?? null,
                ...(diagnostic.prismaCode ? { prismaCode: diagnostic.prismaCode } : {}),
                stackFrames: [{ file: diagnostic.file, line: 250, column: 18 }] })]));
            expect(JSON.stringify(records.filter(record => record && typeof record === 'object'
                && 'module' in record && record.module === 'external-action-error'))).not.toContain('private-');
            expect(response.body).not.toContain('P2028');
        } finally { sink.mockRestore(); await app.close(); }
    });

    it.each(['skills.list', 'skills.read'] as const)('admits the interactive Account plugin-library reader %s without a Session origin', async (actionId) => {
        const app = createApp({ beforeRegister: instance => {
            // Credential authentication is the boundary; catalog admission stays real.
            instance.addHook('onRequest', async (request: FastifyRequest) => {
                request.authTokenLegacy = false;
                request.authTokenEpoch = 1;
            });
        } });
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: 'Bearer signed-account-token', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'account' },
                payload: { v: 1, requestId: 'plugin-library-read', target: { kind: 'machine', machineId: 'machine-1' },
                    input: actionId === 'skills.read' ? { skillId: 'plugin:example.plugin/check' } : {} },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ actionId, execution: { ok: true } });
            const write = await app.inject({ method: 'POST', url: '/v1/actions/skills.duplicate',
                headers: { authorization: 'Bearer signed-account-token', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'account' },
                payload: { v: 1, requestId: 'plugin-library-write', target: { kind: 'machine', machineId: 'machine-1' },
                    input: { skillId: 'plugin:example.plugin/check' } },
            });
            expect(write.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('reports a paired terminal decision authority refusal without calling its credential invalid', async () => {
        const dispatch = vi.fn();
        const app = createApp({ dispatch, beforeRegister: instance => {
            instance.addHook('onRequest', async (request: FastifyRequest) => {
                request.authTokenLegacy = false;
                request.authTokenEpoch = 1;
            });
        } });
        try {
            const envelope = { v: 1, requestId: 'terminal-decision', target: { kind: 'machine', machineId: 'peer' },
                input: { artifactId: 'approval', decision: 'approve' } };
            for (const suffix of ['', '/execution-authorization']) {
                const response = await app.inject({ method: 'POST', url: `/v1/actions/approval.request.decide${suffix}`,
                    headers: { authorization: 'Bearer terminal-token', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'terminal' },
                    payload: suffix ? { v: 1, machineId: 'peer', envelope } : envelope });
                expect(response.statusCode).toBe(403);
                expect(response.json()).toEqual({ error: 'credential_scope_denied' });
            }
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it('refuses host-only Account and PAT plugin claims before Action dispatch or authorization issuance', async () => {
        const dispatch = vi.fn(async (request: Parameters<NonNullable<RegisterExternalActionRoutesDependencies['dispatch']>>[0]) => dispatchedResponse({ v: 1, actionId: request.actionId,
            requestId: request.envelope.requestId, execution: { ok: true, result: { accepted: true } } }));
        const app = createApp({ dispatch, beforeRegister: instance => {
            // Credential authentication is the boundary; retain real route and policy owners.
            instance.addHook('preHandler', async (request: FastifyRequest) => {
                request.authTokenLegacy = false;
                request.authTokenEpoch = 1;
            });
        } });
        const pluginInvocation = { kind: 'mountedPluginSurface', mountedBinding: {
            pluginId: 'happier.channels', contributionLocalId: 'channels-app', occurrenceId: 'mounted-occurrence',
            sourceCustody: { kind: 'development', registeredRootId: 'channels-root' },
            materializationRef: { machineId: 'machine-1', pluginId: 'happier.channels', materializationId: 'installed-channels' },
        } };
        try {
            for (const candidate of [
                { actionId: 'automation.conversation.targets.list', headers: {
                    authorization: 'Bearer signed-account-token', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'account',
                }, invocation: {} },
                { actionId: 'automation.conversation.targets.list', headers: patHeaders, invocation: { pluginInvocation } },
                { actionId: 'plugins.list', headers: patHeaders, invocation: { pluginInvocation } },
                { actionId: 'automation.conversation.targets.list', headers: {
                    authorization: 'Bearer terminal-token', 'x-test-user-id': 'account-1', 'x-test-auth-token-kind': 'terminal',
                }, invocation: { pluginInvocation } },
            ]) {
                const envelope = { v: 1, requestId: 'plugin-root',
                    target: { kind: 'machine', machineId: 'machine-1' }, input: {}, ...candidate.invocation };
                for (const suffix of ['', '/execution-authorization']) {
                    const response = await app.inject({ method: 'POST',
                        url: `/v1/actions/${candidate.actionId}${suffix}`, headers: candidate.headers,
                        payload: suffix ? { v: 1, machineId: 'machine-1', envelope } : envelope,
                    });
                    expect(response.statusCode, candidate.actionId + suffix).toBe(401);
                    expect(response.json()).toEqual({ error: 'invalid_token' });
                }
            }
            expect(dispatch).not.toHaveBeenCalled();
            const admitted = await app.inject({ method: 'POST', url: '/v1/actions/automation.conversation.targets.list',
                headers: { authorization: 'Bearer signed-account-token', 'x-test-user-id': 'account-1',
                    'x-test-auth-token-kind': 'account' },
                payload: { v: 1, requestId: 'plugin-root', target: { kind: 'machine', machineId: 'machine-1' },
                    input: {}, pluginInvocation },
            });
            expect(admitted.statusCode).toBe(200);
            expect(admitted.json()).toMatchObject({ requestId: 'plugin-root', execution: { ok: true } });
        } finally { await app.close(); }
    });

    it("relays opaque V2 through the real dispatcher and preserves its binary response", async () => {
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(9) };
        const target = { kind: "machine" as const, machineId: "machine-1" };
        const binding = { serverIdentityId: "srv_test", accountId: "account-1",
            credentialId: "00000000-0000-4000-8000-000000000001", actionId: "session.message.send",
            requestId: "private-relay", target };
        const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material,
            input: { sessionId: "session-1", message: "private-input-sentinel" },
            randomBytes: (length) => new Uint8Array(length).fill(2) });
        const prepared = prepareExternalActionResponseV2({ binding, material, request,
            executedMachineId: target.machineId, randomBytes: (length) => new Uint8Array(length).fill(3),
            execution: { ok: false, errorCode: "conflict", error: "private-error-sentinel" } });
        const io = new Server();
        const dispatch = createExternalActionDaemonDispatcher({ io,
            resolveMachine: async () => "available",
            getServerIdentityId: async () => binding.serverIdentityId,
            mintExecutionAuthorization: async (authorizationBinding) => ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1,
                token: "unit-test-execution-authorization",
                binding: { ...authorizationBinding, custodianAccountId: authorizationBinding.accountId,
                    installationId: 'installation-1' },
            }),
            // Network boundary only: real route/dispatcher/framing owners remain composed.
            forwardRpc: async (call) => {
                expect(call.callParams).toMatchObject({ envelope: request });
                expect(call.callParams).toMatchObject({
                    executionAuthorization: {
                        v: 1,
                        token: "unit-test-execution-authorization",
                    },
                });
                expect(JSON.stringify(call.callParams)).not.toContain("sentinel");
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
            },
        });
        const app = createApp({ dispatch });
        try {
            const response = await app.inject({ method: "POST", url: "/v1/actions/session.message.send",
                payload: request, headers: { ...patHeaders, "x-test-api-token-credential-id": binding.credentialId } });
            expect(response.statusCode).toBe(200);
            expect(response.body).toBe(prepared.body);
            expect(response.body).not.toContain("sentinel");
        } finally { await app.close(); }
    });

    it("accepts a verified PAT, relays only the outer envelope, and forwards server-stamped provenance", async () => {
        const dispatch = vi.fn(async () => dispatchedResponse({
            v: 1 as const,
            actionId: "session.spawn_new" as const,
            requestId: "request-1",
            execution: { ok: true as const, result: { sessionId: "session-1" } },
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
                    grant: API_TOKEN_FULL_GRANT_V1,
                    authority: "account_automation",
                },
            }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await app.close();
        }
    });

    it("returns typed invalid_action_output rather than a recursive JSON response failure", async () => {
        const dispatch = vi.fn()
            .mockImplementationOnce(async (request) => dispatchedResponse({
                v: 1 as const,
                actionId: request.actionId,
                execution: {
                    ok: true as const,
                    result: createDeepExternalActionResult(),
                },
            }))
            .mockImplementationOnce(async (request) => dispatchedResponse({
                v: 1 as const,
                actionId: request.actionId,
                execution: { ok: true as const, result: { carrier: "usable" } },
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
            .mockImplementationOnce(async (request) => dispatchedResponse({
                v: 1 as const,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true as const, result: exactLimitResult },
            }))
            .mockImplementationOnce(async (request) => dispatchedResponse({
                v: 1 as const,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true as const, result: `${exactLimitResult}a` },
            }))
            .mockImplementationOnce(async (request) => dispatchedResponse({
                v: 1 as const,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true as const, result: { carrier: "usable" } },
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

    it("rejects missing authentication before the JSON parser or placement relay", async () => {
        const dispatch = vi.fn();
        const parse = vi.fn();
        const app = createApp({
            dispatch,
            beforeRegister: (instance) => {
                instance.removeContentTypeParser("application/json");
                instance.addContentTypeParser(
                    "application/json",
                    { parseAs: "string" },
                    (
                        _request: unknown,
                        body: string,
                        done: (error: Error | null, value?: unknown) => void,
                    ) => {
                        parse();
                        done(null, { received: body });
                    },
                );
            },
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { "content-type": "application/json" },
                payload: "{not-json",
            });

            expect(response.statusCode).toBe(401);
            expect(parse).not.toHaveBeenCalled();
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

    it("rejects a custom-parser non-finite input before the server relay", async () => {
        const dispatch = vi.fn();
        const app = createApp({
            dispatch,
            beforeRegister: (instance) => {
                instance.removeContentTypeParser("application/json");
                instance.addContentTypeParser(
                    "application/json",
                    { parseAs: "string" },
                    (
                        _request: unknown,
                        _body: string,
                        done: (error: Error | null, value?: unknown) => void,
                    ) => done(null, { v: 1, input: Number.NaN }),
                );
            },
        });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: patHeaders,
                payload: "{}",
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_envelope" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("keeps an admitted Action's invalid_action domain failure in the canonical response envelope", async () => {
        const dispatch = vi.fn(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: {
                ok: false as const,
                errorCode: "invalid_action",
                error: "invalid_action",
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
        const dispatch = vi.fn(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: { ok: true as const, result: { accepted: true } },
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
            expect(response.headers["access-control-allow-origin"]).toBe("*");
            expect(response.json()).toEqual({ error: "invalid_request", code: "invalid_envelope" });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("enforces the shared byte ceiling with a typed no-store response under the global CORS owner", async () => {
        const dispatch = vi.fn(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: { ok: true as const, result: { accepted: true } },
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
            expect(exactLimitResponse.headers["access-control-allow-origin"]).toBe("*");
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
            expect(oneByteOverLimitResponse.headers["access-control-allow-origin"]).toBe("*");
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

    it("rejects protected request bytes beyond the derived ciphertext envelope before dispatch", async () => {
        const dispatch = vi.fn(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: { ok: true as const, result: { accepted: true } },
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const exactLimitPayload = externalActionV2JsonPayloadWithByteLength(
                EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2,
            );
            const exactLimitResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { ...patHeaders, "content-type": "application/json" },
                payload: exactLimitPayload,
            });
            expect(exactLimitResponse.statusCode).toBe(200);
            expect(dispatch).toHaveBeenCalledOnce();
            dispatch.mockClear();

            const oneByteOverLimitPayload = externalActionV2JsonPayloadWithByteLength(
                EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2 + 1,
            );
            // Keep the envelope structurally valid so this exercises the byte
            // owner, rather than the ciphertext field's schema-length rejection.
            expect(ExternalActionRequestEnvelopeSchema.safeParse(JSON.parse(oneByteOverLimitPayload)).success).toBe(true);
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    ...patHeaders,
                    "content-type": "application/json",
                },
                payload: oneByteOverLimitPayload,
            });
            expect(response.statusCode).toBe(413);
            expect(response.json()).toEqual({
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

    it("returns V2 placement failures through the strict correlated outer error", async () => {
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
                payload: {
                    v: 2,
                    requestId: "protected-placement",
                    payload: { t: "encrypted", c: "opaque" },
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid_request",
                code: "target_required",
                requestId: "protected-placement",
            });
        } finally {
            await app.close();
        }
    });

    it("does not fabricate a plaintext target failure after protected submission", async () => {
        const dispatch = vi.fn(async () => ({ kind: "submitted_unknown" as const }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/action.spec.get",
                headers: patHeaders,
                payload: {
                    v: 2,
                    requestId: "protected-submitted-unknown",
                    target: { kind: "machine", machineId: "machine-1" },
                    payload: { t: "encrypted", c: "opaque" },
                },
            });

            expect(response.statusCode).toBe(502);
            expect(response.body).toBe("");
            expect(response.body).not.toContain("target_unavailable");
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("projects exact-Machine targeted-input incompatibility as the operation-scoped update requirement", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "placement_error" as const,
            code: "session_input_target_update_required" as const,
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.message.send",
                headers: patHeaders,
                payload: {
                    v: 1,
                    requestId: "request-targeted",
                    target: { kind: "machine", machineId: "machine-1" },
                    input: {
                        sessionId: "session-1",
                        message: "Continue the attached Run",
                        recipient: { kind: "execution_run", runId: "run-1" },
                    },
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                v: 1,
                actionId: "session.message.send",
                requestId: "request-targeted",
                execution: {
                    ok: false,
                    errorCode: "session_input_target_update_required",
                    error: "session_input_target_update_required",
                },
            });
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("preserves the external Action support failure for an unrelated V1 Action", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "placement_error" as const,
            code: "encrypted_action_unsupported" as const,
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/action.spec.get",
                headers: patHeaders,
                payload: {
                    v: 1,
                    requestId: "request-old-daemon",
                    target: { kind: "machine", machineId: "machine-1" },
                    input: { actionId: "session.message.send" },
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                v: 1,
                actionId: "action.spec.get",
                requestId: "request-old-daemon",
                execution: {
                    ok: false,
                    errorCode: "encrypted_action_unsupported",
                    error: "encrypted_action_unsupported",
                },
            });
        } finally {
            await app.close();
        }
    });

    it("returns protected targeted-input incompatibility through the strict correlated outer error", async () => {
        const dispatch = vi.fn(async () => ({
            kind: "placement_error" as const,
            code: "session_input_target_update_required" as const,
        }));
        const app = createApp({ dispatch });
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.message.send",
                headers: patHeaders,
                payload: {
                    v: 2,
                    requestId: "protected-targeted-update",
                    target: { kind: "machine", machineId: "machine-1" },
                    payload: { t: "encrypted", c: "opaque" },
                },
            });

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({
                error: "invalid_request",
                code: "session_input_target_update_required",
                requestId: "protected-targeted-update",
            });
            expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("answers Action preflight through the global CORS owner", async () => {
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

            expect(response.statusCode).toBe(204);
            expect(response.headers["access-control-allow-origin"]).toBe("*");
        } finally {
            await app.close();
        }
    });
});
