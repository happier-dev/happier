import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import { Server } from "socket.io";
import nacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';

const protocolSerializerSpy = vi.hoisted(() => vi.fn());
const protocolPrepareSpy = vi.hoisted(() => vi.fn());

vi.mock("@happier-dev/protocol/actions", async (importOriginal) => {
    const protocol = await importOriginal<typeof import("@happier-dev/protocol/actions")>();
    return {
        ...protocol,
        prepareExternalActionResponseEnvelopeV1: (value: unknown) => {
            protocolPrepareSpy(value);
            return protocol.prepareExternalActionResponseEnvelopeV1(value);
        },
        serializeExternalActionResponseEnvelopeV1: (value: unknown) => {
            protocolSerializerSpy(value);
            return protocol.serializeExternalActionResponseEnvelopeV1(value);
        },
    };
});

import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    ExternalActionDaemonDispatchRequestSchema,
    openExternalActionRequestV2,
    openExternalActionResponseV2,
    sealExternalActionRequestV2,
    prepareExternalActionResponseV2,
    measureExternalActionResponseEnvelopeUtf8BytesV1,
    prepareExternalActionResponseEnvelopeV1,
    getActionSpec,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from "@happier-dev/protocol/actions";
import {
    SOCKET_RPC_EVENTS,
    type SocketRpcRequestPayload,
} from "@happier-dev/protocol/socketRpc";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { reconcileExternalActionTarget } from '../../../../../cli/src/daemon/externalActions/reconcileExternalActionTarget';

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
    dispatch: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse>;
}> {
    const request = rawRequest as SocketRpcRequestPayload;
    const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.params);
    if (dispatch.envelope.v !== 1) {
        throw new TypeError("Expected the V1 carrier branch");
    }
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

    it.each(['account', 'terminal'] as const)('relays opaque Machine-targeted Session input for an original %s credential and checks the resolved Session', async (kind) => {
        const account = await db.account.create({ data: { publicKey: `qa7-${kind}`, encryptionMode: 'e2ee' } });
        const other = await db.account.create({ data: { publicKey: `qa7-other-${kind}` } });
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
        const installationId = 'qa7-installation';
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
            installationPublicKey: installation.publicKey, metadata: 'opaque', active: true,
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] },
            } } });
        const session = await db.session.create({ data: { accountId: account.id, tag: `qa7-${kind}`, metadata: 'opaque' } });
        const foreign = await db.session.create({ data: { accountId: other.id, tag: `qa7-foreign-${kind}`, metadata: 'opaque' } });
        const unbound = await db.session.create({ data: { accountId: account.id, tag: `qa7-unbound-${kind}`, metadata: 'opaque' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: 'opaque' } });
        const token = await auth.createToken(account.id, undefined, { kind,
            authority: kind === 'account' ? 'present_user' : 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const io = new Server(app.server, { path: '/v1/updates', transports: ['websocket'] });
        let receivingSocket: import('socket.io').Socket | undefined;
        let received = 0;
        const ready = new Promise<void>(resolve => io.on('connection', async socket => {
            receivingSocket = socket;
            socket.data.clientType = 'machine-scoped'; socket.data.userId = account.id;
            socket.data.machineId = machineId; socket.data.verifiedMachineInstallationId = installationId;
            await socket.join(buildRpcMethodRoom({ userId: account.id, method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
            resolve();
        }));
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io }) });
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
        const daemon = ioClient(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false });
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
        const bindingFor = (requestId: string) => ({ serverIdentityId: homeId, accountId: account.id,
            authentication: { kind, tokenEpoch: account.tokenEpoch }, actionId: 'session.message.send', requestId,
            target: { kind: 'machine' as const, machineId } });
        const verificationStatuses: number[] = [];
        // Only the remote daemon transport edge is represented here. Ingress,
        // minting, exact installation guard, crypto and signed resolved-target
        // admission are the real production owners.
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (raw: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
            received += 1;
            const request = ExternalActionDaemonDispatchRequestSchema.parse(raw.params);
            if (request.envelope.v !== 2 || !request.envelope.requestId || !request.executionAuthorization) throw new Error('Expected protected dispatch');
            const binding = bindingFor(request.envelope.requestId);
            const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material });
            const parsed = getActionSpec('session.message.send').inputSchema.parse(opened?.input);
            const reconciled = reconcileExternalActionTarget({ actionId: 'session.message.send', rawInput: parsed,
                target: request.envelope.target, currentMachineId: machineId });
            if (reconciled.kind !== 'ready' || reconciled.target?.kind !== 'session') throw new Error('Session target was not reconciled');
            const target = reconciled.target;
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(request.actionId);
            const body = { v: 1 };
            const authorized = request.executionAuthorization;
            const verified = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorized.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: request.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorized.token,
                    effectActionId: request.actionId, target, installationId, requestId: authorized.binding.requestId,
                    method: 'POST', path, body, privateKey: installation.secretKey }),
            } });
            verificationStatuses.push(verified.statusCode);
            const prepared = prepareExternalActionResponseV2({ binding, request: request.envelope, executedMachineId: machineId,
                execution: verified.statusCode === 200 ? { ok: true, result: { accepted: true } }
                    : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }, material,
                randomBytes: length => new Uint8Array(length).fill(3) });
            acknowledge({ kind: 'response', body: new TextEncoder().encode(prepared.body) });
        });
        const relay = async (sessionId: string, requestId: string) => {
            const binding = bindingFor(requestId);
            const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: length => new Uint8Array(length).fill(4), input: {
                sessionId, message: 'Reply without tools', localId: requestId, permissionModeOverride: 'read_only', wait: false,
            } });
            const response = await app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                headers: { authorization: `Bearer ${token}`, 'x-happier-authority-ceiling': 'account_automation' }, payload: envelope });
            return { response, execution: response.statusCode === 200
                ? openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope }) : null };
        };
        try {
            const connected = waitForConnection(daemon); daemon.connect(); await connected; await ready;
            const valid = await relay(session.id, 'qa7-valid');
            expect(valid.response.statusCode, valid.response.body).toBe(200);
            expect(valid.execution).toMatchObject({ ok: true, result: { accepted: true } });
            expect(verificationStatuses).toEqual([200]);
            const denied = await relay(foreign.id, 'qa7-foreign');
            expect(denied.response.statusCode, denied.response.body).toBe(200);
            expect(denied.execution).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
            expect(verificationStatuses).toEqual([200, 401]);
            const noBinding = await relay(unbound.id, 'qa7-unbound');
            expect(noBinding.response.statusCode).toBe(200);
            expect(noBinding.execution).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
            expect(verificationStatuses).toEqual([200, 401, 401]);
            // A valid room with the wrong installed daemon must never receive
            // input. This is the composed wiring sensitivity check.
            receivingSocket!.data.verifiedMachineInstallationId = 'wrong-installation';
            expect((await relay(session.id, 'qa7-miswired')).response.statusCode).toBe(409);
            expect(received).toBe(3);
            receivingSocket!.data.verifiedMachineInstallationId = installationId;
            await db.machine.update({ where: { id: machineId }, data: { active: false } });
            const offline = await relay(session.id, 'qa7-offline');
            expect(offline.response.statusCode).toBe(409);
            expect(offline.response.json()).toMatchObject({ code: 'target_unavailable' });
            expect(received).toBe(3);
        } finally { daemon.disconnect(); await io.close(); await app.close(); }
    });

    it("keeps exact/+1 multibyte request and response boundaries usable through the real daemon socket", async () => {
        expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBe(expectedHttpBodyLimitBytes);
        expect(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE).toBeGreaterThanOrEqual(expectedRequestCarrierLimitBytes);
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
                installationId: "installation-external-action-carrier",
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: true,
                operationProtocolCapabilities: {
                    externalActionExecutionAuthorization: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
            select: { id: true },
        });

        const credential = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(),
            label: 'Carrier boundary', grant: API_TOKEN_FULL_GRANT_V1 });
        const requestHeaders = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' };
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const io = new Server(app.server, {
            path: "/v1/updates",
            transports: ["websocket"],
            maxHttpBufferSize: DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE,
        });
        const method = machineId + ":" + EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1;
        const relayedRequests: RelayedRequestSummary[] = [];
        let responseResult: unknown = { accepted: true };
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
        const privateBinding = { serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id,
            credentialId: credential.tokenId, actionId: 'session.spawn_new',
            requestId: 'carrier-response-boundary', target: { kind: 'machine' as const, machineId } };
        let privateRequestBytes = 0;
        const daemonReady = new Promise<void>((resolve) => {
            io.on("connection", async (serverSocket) => {
                serverSocket.data.clientType = "machine-scoped";
                serverSocket.data.userId = account.id;
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
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse((request as SocketRpcRequestPayload).params);
            if (dispatch.envelope.v === 2) {
                privateRequestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
                const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: dispatch.envelope, binding: privateBinding, material });
                expect(opened).not.toBeNull();
                const prepared = prepareExternalActionResponseV2({ binding: privateBinding, request: dispatch.envelope,
                    executedMachineId: machineId, execution: { ok: true, result: responseResult }, material,
                    randomBytes: (length) => new Uint8Array(length).fill(3) });
                acknowledge({ kind: 'response', body: new TextEncoder().encode(prepared.body) });
                return;
            }
            const relayed = summarizeRelayedRequest(request);
            relayedRequests.push(relayed.summary);
            const response = {
                v: 1,
                actionId: relayed.dispatch.actionId,
                ...(relayed.dispatch.envelope.requestId === undefined
                    ? {}
                    : { requestId: relayed.dispatch.envelope.requestId }),
                execution: { ok: true, result: responseResult },
            } as const;
            const prepared = prepareExternalActionResponseEnvelopeV1(response);
            acknowledge({
                kind: "response",
                body: new TextEncoder().encode(prepared.body),
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
                headers: requestHeaders,
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
                headers: requestHeaders,
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
                headers: requestHeaders,
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
                headers: requestHeaders,
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

            protocolSerializerSpy.mockClear();
            protocolPrepareSpy.mockClear();
            responseResult = { carrier: "daemon-prepared" };
            const daemonPreparedResponse = await app.inject(responseBoundaryRequest);
            expect(daemonPreparedResponse.statusCode).toBe(200);
            expect(daemonPreparedResponse.body).toBe(JSON.stringify({
                v: 1,
                actionId: "session.spawn_new",
                requestId: "carrier-response-boundary",
                execution: { ok: true, result: { carrier: "daemon-prepared" } },
            }));
            expect(protocolSerializerSpy).not.toHaveBeenCalled();
            expect(protocolPrepareSpy).toHaveBeenCalledTimes(1);
            expect(relayedRequests).toHaveLength(6);
            expect(daemonSocket.connected).toBe(true);

            // The real socket must carry base64-expanded V2 bodies above V1's wire ceiling.
            const privateInput = { blob: 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - 1024) };
            const privateRequest = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: privateBinding, input: privateInput,
                material, randomBytes: (length) => new Uint8Array(length).fill(2) });
            responseResult = exactResponseResult;
            const privateResponse = await app.inject({ ...responseBoundaryRequest,
                payload: privateRequest });
            expect(privateResponse.statusCode).toBe(200);
            expect(privateRequestBytes).toBeGreaterThan(expectedRequestCarrierLimitBytes);
            expect(privateRequestBytes).toBeLessThanOrEqual(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE);
            expect(Buffer.byteLength(privateResponse.body, 'utf8')).toBeGreaterThan(expectedResponseCarrierLimitBytes);
            expect(openExternalActionResponseV2({ envelope: privateResponse.json(), binding: privateBinding,
                request: privateRequest, material })).toEqual({ ok: true, result: exactResponseResult });
            expect(daemonSocket.connected).toBe(true);
        } finally {
            daemonSocket.close();
            io.close();
            await app.close();
        }
    }, 120_000);
});
