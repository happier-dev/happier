import { Buffer } from "node:buffer";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";
import { Server } from "socket.io";

import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    ExternalActionDaemonDispatchRequestV1Schema,
    measureExternalActionResponseEnvelopeUtf8BytesV1,
} from "@happier-dev/protocol/actions";
import {
    SOCKET_RPC_EVENTS,
    type SocketRpcRequestPayload,
} from "@happier-dev/protocol/socketRpc";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createExternalActionDaemonDispatcher } from "./externalActionDispatcher";
import { DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE } from "../socket";
import { buildRpcMethodRoom } from "./rpc/rpcMethodRoom";
import { registerExternalActionRoutes } from "../routes/actions/registerExternalActionRoutes";

const machineId = "machine-external-action-carrier";
const expectedHttpBodyLimitBytes = 33_554_432;
const expectedRequestCarrierLimitBytes = 34_603_008;
const expectedResponseCarrierLimitBytes = 25_000_000;

type RelayedRequestSummary = Readonly<{
    actionId: string;
    socketPayloadBytes: number;
    inputBlobBytes: number | null;
    inputHasMultibyteCharacter: boolean;
}>;

function waitForConnection(socket: ReturnType<typeof ioClient>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };

        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
}

function externalActionJsonPayloadWithByteLength(byteLength: number): string {
    const prefix = '{"v":1,"requestId":"carrier-boundary","target":{"kind":"machine","machineId":"machine-external-action-carrier"},"input":{"blob":"';
    const suffix = '"}}';
    const multibyteCharacter = "é";
    const paddingLength = byteLength - Buffer.byteLength(prefix + multibyteCharacter + suffix, "utf8");
    if (paddingLength < 0) throw new Error("Requested payload is too small");

    const payload = prefix + "x".repeat(paddingLength) + multibyteCharacter + suffix;
    if (Buffer.byteLength(payload, "utf8") !== byteLength) {
        throw new Error("External Action payload did not reach the requested byte length");
    }
    return payload;
}

function createExactLimitMultibyteResponseResult(): string {
    const emptyResponse = {
        v: 1,
        actionId: "session.spawn_new",
        requestId: "carrier-response-boundary",
        execution: { ok: true, result: "" },
    } as const;
    const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse);
    const multibyteMarker = "é";
    const markerBytes = Buffer.byteLength(multibyteMarker, "utf8");
    return "a".repeat(
        EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
    ) + multibyteMarker;
}

function summarizeRelayedRequest(rawRequest: unknown): Readonly<{
    summary: RelayedRequestSummary;
    dispatch: ReturnType<typeof ExternalActionDaemonDispatchRequestV1Schema.parse>;
}> {
    const request = rawRequest as SocketRpcRequestPayload;
    const dispatch = ExternalActionDaemonDispatchRequestV1Schema.parse(request.params);
    const input = dispatch.envelope.input;
    const blob = (
        typeof input === "object"
        && input !== null
        && !Array.isArray(input)
        && typeof (input as Record<string, unknown>).blob === "string"
    )
        ? (input as Record<string, unknown>).blob as string
        : null;

    return {
        summary: {
            actionId: dispatch.actionId,
            socketPayloadBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
            inputBlobBytes: blob === null ? null : Buffer.byteLength(blob, "utf8"),
            inputHasMultibyteCharacter: blob?.includes("é") ?? false,
        },
        dispatch,
    };
}

describe("external Action server-to-daemon request carrier", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-action-carrier-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("keeps exact/+1 multibyte request and response boundaries usable through the real daemon socket", async () => {
        expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBe(expectedHttpBodyLimitBytes);
        expect(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE).toBe(expectedRequestCarrierLimitBytes);
        expect(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES).toBe(24_000_000);
        expect(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES)
            .toBe(expectedResponseCarrierLimitBytes);
        expect(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE)
            .toBeGreaterThanOrEqual(expectedResponseCarrierLimitBytes);

        const account = await db.account.create({
            data: { publicKey: "external-action-carrier-account" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: true,
            },
            select: { id: true },
        });

        const app = createAuthenticatedTestApp();
        const io = new Server(app.server, {
            path: "/v1/updates",
            transports: ["websocket"],
            maxHttpBufferSize: DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE,
        });
        const method = machineId + ":" + EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1;
        const relayedRequests: RelayedRequestSummary[] = [];
        let responseResult: unknown = { accepted: true };
        const daemonReady = new Promise<void>((resolve) => {
            io.on("connection", async (serverSocket) => {
                serverSocket.data.clientType = "machine-scoped";
                serverSocket.data.machineId = machineId;
                serverSocket.data.verifiedMachineInstallationId = "installation-external-action-carrier";
                await serverSocket.join(buildRpcMethodRoom({
                    userId: account.id,
                    method,
                }));
                resolve();
            });
        });
        const dispatch = createExternalActionDaemonDispatcher({ io });
        registerExternalActionRoutes(app, { dispatch });
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            io.close();
            await app.close();
            throw new Error("Failed to bind external Action carrier test server");
        }

        const daemonSocket = ioClient("http://127.0.0.1:" + port, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
        });
        daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: unknown, acknowledge: (response: unknown) => void) => {
            const relayed = summarizeRelayedRequest(request);
            relayedRequests.push(relayed.summary);
            acknowledge({
                kind: "response",
                response: {
                    v: 1,
                    actionId: relayed.dispatch.actionId,
                    ...(relayed.dispatch.envelope.requestId === undefined
                        ? {}
                        : { requestId: relayed.dispatch.envelope.requestId }),
                    execution: { ok: true, result: responseResult },
                },
            });
        });

        try {
            const connected = waitForConnection(daemonSocket);
            daemonSocket.connect();
            await connected;
            await daemonReady;

            const exactLimitPayload = externalActionJsonPayloadWithByteLength(
                EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
            );
            expect(Buffer.byteLength(exactLimitPayload, "utf8")).toBe(expectedHttpBodyLimitBytes);
            expect(exactLimitPayload).toContain("é");

            const exactLimitResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    authorization: "Bearer carrier-test",
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-test-auth-token-kind": "api_token",
                    "x-test-api-token-account-id": account.id,
                    "x-test-api-token-principal-id": "carrier-principal",
                    "x-test-api-token-credential-id": "carrier-credential",
                },
                payload: exactLimitPayload,
            });

            expect(exactLimitResponse.statusCode).toBe(200);
            expect(relayedRequests).toEqual([{
                actionId: "session.spawn_new",
                socketPayloadBytes: expect.any(Number),
                inputBlobBytes: expect.any(Number),
                inputHasMultibyteCharacter: true,
            }]);
            expect(relayedRequests[0]?.socketPayloadBytes).toBeGreaterThan(expectedHttpBodyLimitBytes);
            expect(relayedRequests[0]?.socketPayloadBytes).toBeLessThanOrEqual(
                expectedRequestCarrierLimitBytes,
            );

            const oneByteOverLimitResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    authorization: "Bearer carrier-test",
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-test-auth-token-kind": "api_token",
                    "x-test-api-token-account-id": account.id,
                    "x-test-api-token-principal-id": "carrier-principal",
                    "x-test-api-token-credential-id": "carrier-credential",
                },
                payload: externalActionJsonPayloadWithByteLength(
                    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES + 1,
                ),
            });

            expect(oneByteOverLimitResponse.statusCode).toBe(413);
            expect(oneByteOverLimitResponse.json()).toEqual({
                error: "invalid_request",
                code: "request_too_large",
            });
            expect(relayedRequests).toHaveLength(1);
            expect(daemonSocket.connected).toBe(true);

            const postRejectionResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: {
                    authorization: "Bearer carrier-test",
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-test-auth-token-kind": "api_token",
                    "x-test-api-token-account-id": account.id,
                    "x-test-api-token-principal-id": "carrier-principal",
                    "x-test-api-token-credential-id": "carrier-credential",
                },
                payload: {
                    v: 1,
                    target: { kind: "machine", machineId },
                    input: { relay: "still-usable" },
                },
            });

            expect(postRejectionResponse.statusCode).toBe(200);
            expect(relayedRequests).toHaveLength(2);
            expect(daemonSocket.connected).toBe(true);

            const responseBoundaryRequest = {
                method: "POST" as const,
                url: "/v1/actions/session.spawn_new",
                headers: {
                    authorization: "Bearer carrier-test",
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-test-auth-token-kind": "api_token",
                    "x-test-api-token-account-id": account.id,
                    "x-test-api-token-principal-id": "carrier-principal",
                    "x-test-api-token-credential-id": "carrier-credential",
                },
                payload: {
                    v: 1,
                    requestId: "carrier-response-boundary",
                    target: { kind: "machine", machineId },
                    input: {},
                },
            };
            const exactResponseResult = createExactLimitMultibyteResponseResult();
            responseResult = exactResponseResult;
            const exactResponse = await app.inject(responseBoundaryRequest);
            expect(exactResponse.statusCode).toBe(200);
            expect(Number(exactResponse.headers["content-length"]))
                .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
            expect(Buffer.byteLength(exactResponse.body, "utf8"))
                .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
            expect(exactResponse.body).toContain("é");
            expect(relayedRequests).toHaveLength(3);
            expect(daemonSocket.connected).toBe(true);

            responseResult = exactResponseResult + "a";
            const oversizedResponse = await app.inject(responseBoundaryRequest);
            expect(oversizedResponse.statusCode).toBe(200);
            expect(oversizedResponse.json()).toMatchObject({
                execution: {
                    ok: false,
                    errorCode: "result_too_large",
                    details: {
                        executionCompleted: true,
                        maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
                    },
                },
            });
            expect(relayedRequests).toHaveLength(4);
            expect(daemonSocket.connected).toBe(true);

            responseResult = { carrier: "response-still-usable" };
            const postResponseRejection = await app.inject(responseBoundaryRequest);
            expect(postResponseRejection.statusCode).toBe(200);
            expect(postResponseRejection.json()).toMatchObject({
                execution: { ok: true, result: { carrier: "response-still-usable" } },
            });
            expect(relayedRequests).toHaveLength(5);
            expect(daemonSocket.connected).toBe(true);
        } finally {
            daemonSocket.close();
            io.close();
            await app.close();
        }
    }, 120_000);
});
