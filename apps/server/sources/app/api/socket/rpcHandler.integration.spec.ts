import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS, parseSocketRpcAuthorizationContext } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { db } from "@/storage/db";
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createEnvReset } from "../testkit/env";
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from "../testkit/socketHarness";
import { rpcHandler } from "./rpcHandler";

const RELEASED_SERVER_V0_2_0_PROVENANCE = Object.freeze({
    tag: "server-v0.2.0",
    commit: "739fb368aaf4d510e0b2280cdbe2acee3fefcf12",
    linuxX64Sha256: "64083eddbb181ccd4a1113670295945670d7bdd30b86a342ecf6b9888ea0bef2",
});

function createTarget(id: string, result: unknown) {
    const emitWithAck = vi.fn().mockResolvedValue(result);
    return {
        socket: {
            id,
            timeout: vi.fn(() => ({
                emitWithAck,
            })),
        },
        emitWithAck,
    };
}

function createIo(responsesByRoom: Record<string, unknown[][]>) {
    const fetchesByRoom = new Map<string, unknown[][]>(
        Object.entries(responsesByRoom).map(([room, responses]) => [room, [...responses]]),
    );
    const socketsById = new Map<string, unknown[]>();
    for (const responses of Object.values(responsesByRoom)) {
        for (const sockets of responses) {
            for (const socket of sockets) {
                if (socket && typeof socket === "object" && "id" in socket && typeof socket.id === "string") {
                    socketsById.set(socket.id, [socket]);
                }
            }
        }
    }

    const io = createSocketRoomDiscoveryHarness(async room => {
        const queue = fetchesByRoom.get(room);
        if (!queue) {
            return socketsById.get(room) ?? [];
        }
        if (queue.length === 0) {
            return [];
        }
        if (queue.length === 1) {
            return queue[0];
        }
        return queue.shift() ?? [];
    });
    const inMock = vi.spyOn(io, 'in');

    return {
        io,
        inMock,
    };
}

describe("rpcHandler", () => {
    const resetRpcAvailabilityEnv = createEnvReset();
    let harness: LightSqliteHarness;
    let accountId: string;
    let ownerId: string;
    let sessionId: string;
    let machineId: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-rpc-handler-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(async () => {
        harness.resetEnv();
        const account = await db.account.create({ data: { publicKey: `caller-${randomUUID()}` } });
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        accountId = account.id;
        ownerId = owner.id;
        sessionId = session.id;
        machineId = machine.id;
    });
    afterAll(async () => { if (harness) await harness.close(); });

    it.each([RPC_METHODS.SESSION_CONTINUATION_INSPECT, RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH,
        RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW])('requires exact Session read access for continuation on a shared Machine: %s', async operation => {
        await db.account.updateMany({ where: { id: { in: [accountId, ownerId] } }, data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: machineId }, data: { accountId: ownerId, active: true,
            installationId: 'continuation-installation', metadata: encodePlainMachineStoredContent({ host: 'test',
                platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: ownerId, machineId,
            principal: { kind: 'account', accountId }, level: 'view' }))).toMatchObject({ kind: 'saved', readiness: 'ready' });
        expect(await resolveMachineAdmission({ actorAccountId: accountId, machineId, rpcMethod: operation }))
            .toMatchObject({ kind: 'admitted', role: 'use' });
        const foreignSession = await db.session.create({ data: { accountId: ownerId, tag: randomUUID(), metadata: '{}' } });
        const method = `${machineId}:${operation}`;
        const result = { type: 'available' };
        const target = createTarget('continuation-daemon', result);
        const accountStoredContentCompatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        Object.assign(target.socket, { data: { clientType: 'machine-scoped', machineId,
            verifiedMachineInstallationId: 'continuation-installation', accountStoredContentCompatibility } });
        const { io } = createIo({ [`rpc:${ownerId}:${method}`]: [[target.socket]] });
        const caller = createAuthenticatedFakeSocket({ data: { accountStoredContentCompatibility } });
        rpcHandler(accountId, caller as unknown as Socket, { io });
        for (const authorization of [undefined, { kind: 'session.read', sessionId: foreignSession.id }]) {
            const refused = vi.fn();
            await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method, params: { opaque: 'encrypted-request' },
                ...(authorization ? { authorization } : {}) }, refused);
            expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(target.emitWithAck).not.toHaveBeenCalled();
        }
        const callback = vi.fn();
        await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method, params: { opaque: 'encrypted-request' },
            authorization: { kind: 'session.read', sessionId } }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true, result });
        expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            authorization: { kind: 'session.read', sessionId },
            machineAdmission: expect.objectContaining({ actorAccountId: accountId, custodianAccountId: ownerId, role: 'use' }),
        }));
        await db.sessionShare.create({ data: { sessionId: foreignSession.id, sharedByUserId: ownerId,
            sharedWithUserId: accountId, accessLevel: 'view' } });
        const readOnly = vi.fn();
        await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method, params: { opaque: 'encrypted-request' },
            authorization: { kind: 'session.read', sessionId: foreignSession.id } }, readOnly);
        expect(readOnly).toHaveBeenCalledWith({ ok: true, result });
    });

    it("waits briefly for a late session-scoped room member before forwarding the RPC", async () => {
        resetRpcAvailabilityEnv({
            HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: "30",
            HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: "10",
        });

        try {
            const target = createTarget("target-socket", { ok: true, value: 123 });
            const { io, inMock } = createIo({
                [`rpc:${accountId}:${sessionId}:execution.run.stream.start`]: [
                    [],
                    [],
                    [target.socket],
                ],
            });
            const callerSocket = createAuthenticatedFakeSocket({
                id: "caller-socket",
                emit: vi.fn(),
            });

            rpcHandler(accountId, callerSocket as unknown as Socket, { io });

            const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
            const callback = vi.fn();
            await handler({ method: `${sessionId}:execution.run.stream.start`, params: { runId: "run-1" } }, callback);

            expect(inMock).toHaveBeenCalledWith(`rpc:${accountId}:${sessionId}:execution.run.stream.start`);
            expect(target.socket.timeout).toHaveBeenCalledWith(30000, { rejectOnDisconnect: true });
            expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
                method: `${sessionId}:execution.run.stream.start`,
                params: { runId: "run-1" },
                callerAuthority: "present_user",
                authorization: { kind: "session.write", sessionId },
                timeoutMs: 30000,
            });
            expect(callback).toHaveBeenCalledWith({
                ok: true,
                result: { ok: true, value: 123 },
            });
        } finally {
            resetRpcAvailabilityEnv();
        }
    });

    it("preserves released-server opaque session RPC forwarding for Agent-realtime control without audio", async () => {
        // server-v0.2.0 rpcHandler.ts at the pinned commit forwards normalized
        // arbitrary method strings and opaque params without parsing Agent realtime.
        expect(RELEASED_SERVER_V0_2_0_PROVENANCE).toEqual({
            tag: "server-v0.2.0",
            commit: "739fb368aaf4d510e0b2280cdbe2acee3fefcf12",
            linuxX64Sha256: "64083eddbb181ccd4a1113670295945670d7bdd30b86a342ecf6b9888ea0bef2",
        });
        const inspectMethod = `${sessionId}:session.agentRealtime.inspect`;
        const startMethod = `${sessionId}:session.agentRealtime.start`;
        const provider = {
            pluginId: "happier.agent.codex",
            localId: "realtime-codex",
        };
        const inspectPayload = { v: 1, provider };
        const startPayload = {
            ...inspectPayload,
            applicationAttemptId: "voice:released-server-vector",
            transport: {
                kind: "webrtc",
                offerSdp: "v=0\r\na=released-server-vector\r\n",
            },
        };
        const inspectTarget = createTarget("daemon-inspect-socket", {
            ok: true,
            status: "available",
            transport: "webrtc",
        });
        const startTarget = createTarget("daemon-start-socket", {
            ok: true,
            status: "started",
            transport: {
                kind: "webrtc",
                answerSdp: "v=0\r\na=released-server-answer\r\n",
            },
        });
        const { io, inMock } = createIo({
            [`rpc:${accountId}:${inspectMethod}`]: [[inspectTarget.socket]],
            [`rpc:${accountId}:${startMethod}`]: [[startTarget.socket]],
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: "current-ui-socket",
            emit: vi.fn(),
        });

        rpcHandler(accountId, callerSocket as unknown as Socket, { io });
        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const inspectCallback = vi.fn();
        const startCallback = vi.fn();

        await handler({ method: inspectMethod, params: inspectPayload }, inspectCallback);
        await handler({ method: startMethod, params: startPayload }, startCallback);

        expect(inMock).toHaveBeenCalledWith(`rpc:${accountId}:${inspectMethod}`);
        expect(inMock).toHaveBeenCalledWith(`rpc:${accountId}:${startMethod}`);
        expect(inspectTarget.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: inspectMethod,
            params: inspectPayload,
            callerAuthority: "present_user",
            authorization: { kind: "session.write", sessionId },
            timeoutMs: 30000,
        });
        expect(startTarget.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: startMethod,
            params: startPayload,
            callerAuthority: "present_user",
            authorization: { kind: "session.write", sessionId, authority: "sessionOwner" },
            timeoutMs: 30000,
        });
        const startRequest = startTarget.emitWithAck.mock.calls[0]?.[1];
        expect(parseSocketRpcAuthorizationContext(startRequest.authorization))
            .toEqual({ kind: "session.write", sessionId, authority: "sessionOwner" });
        expect(startPayload).not.toHaveProperty("audio");
        expect(startPayload).not.toHaveProperty("pcm");
        expect(JSON.stringify(startPayload)).not.toContain("voice_media");
        expect(inspectCallback).toHaveBeenCalledWith({
            ok: true,
            result: {
                ok: true,
                status: "available",
                transport: "webrtc",
            },
        });
        expect(startCallback).toHaveBeenCalledWith({
            ok: true,
            result: {
                ok: true,
                status: "started",
                transport: {
                    kind: "webrtc",
                    answerSdp: "v=0\r\na=released-server-answer\r\n",
                },
            },
        });
    });

    it("refuses shared-editor native Realtime Start before forwarding, including a forged owner marker", async () => {
        await db.session.update({ where: { id: sessionId }, data: { accountId: ownerId } });
        await db.sessionShare.create({ data: { sessionId, sharedByUserId: ownerId,
            sharedWithUserId: accountId, accessLevel: "edit", canApprovePermissions: false } });
        const method = `${sessionId}:session.agentRealtime.start`;
        const target = createTarget("owner-realtime-socket", { ok: true, status: "started" });
        const { io } = createIo({ [`rpc:${ownerId}:${method}`]: [[target.socket]] });
        const callerSocket = createAuthenticatedFakeSocket({ id: "shared-editor", emit: vi.fn() });
        rpcHandler(accountId, callerSocket as unknown as Socket, { io });
        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        for (const authorization of [undefined, { kind: "session.write", sessionId, authority: "sessionOwner" }]) {
            const callback = vi.fn();
            await handler({ method, params: { v: 1, provider: { pluginId: "happier.agent.codex", localId: "realtime-codex" },
                applicationAttemptId: "shared-start", transport: { kind: "webrtc", offerSdp: "v=0\r\n" } },
                ...(authorization ? { authorization } : {}) }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: false, error: "Forbidden", errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        expect(target.emitWithAck).not.toHaveBeenCalled();
    });

    it.each([SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, RPC_METHODS.SESSION_USER_ACTION_ANSWER])(
        "keeps shared-editor ordinary input and question RPC available without owner proof: %s", async rpcMethod => {
        await db.session.update({ where: { id: sessionId }, data: { accountId: ownerId } });
        await db.sessionShare.create({ data: { sessionId, sharedByUserId: ownerId,
            sharedWithUserId: accountId, accessLevel: "edit", canApprovePermissions: false } });
        const method = `${sessionId}:${rpcMethod}`;
        const target = createTarget("owner-input-socket", { ok: true });
        const { io } = createIo({ [`rpc:${ownerId}:${method}`]: [[target.socket]] });
        const callerSocket = createAuthenticatedFakeSocket({ id: "shared-editor", emit: vi.fn() });
        rpcHandler(accountId, callerSocket as unknown as Socket, { io });
        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method, params: "opaque-session-input",
            authorization: { kind: "session.write", sessionId, authority: "sessionOwner" } }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
        expect(target.emitWithAck).toHaveBeenCalledOnce();
        const forwarded = target.emitWithAck.mock.calls[0]?.[1];
        expect(forwarded.callerAuthority).toBe("present_user");
        expect(forwarded.authorization).not.toHaveProperty("authority");
        expect(parseSocketRpcAuthorizationContext(forwarded.authorization)).toEqual(forwarded.authorization);
    });

    it("routes delegated permission RPCs through the owner room", async () => {
        await db.session.update({ where: { id: sessionId }, data: { accountId: ownerId } });
        await db.sessionShare.create({ data: { sessionId, sharedByUserId: ownerId,
            sharedWithUserId: accountId, accessLevel: "edit", canApprovePermissions: true } });
        const target = createTarget("owner-socket", { ok: true, value: "owner" });
        const { io, inMock } = createIo({
            [`rpc:${ownerId}:${sessionId}:permission`]: [[target.socket]],
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
        });
        rpcHandler(accountId, callerSocket as unknown as Socket, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: `${sessionId}:permission`, params: { requestId: "perm-1" } }, callback);

        expect(inMock).toHaveBeenCalledWith(`rpc:${ownerId}:${sessionId}:permission`);
        expect(target.socket.timeout).toHaveBeenCalledWith(30000, { rejectOnDisconnect: true });
        expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: `${sessionId}:permission`,
            params: { requestId: "perm-1" },
            callerAuthority: "present_user",
            authorization: { kind: "session.permission.respond", sessionId,
                actor: { kind: "accountUser", accountId, relationship: "sharedApprover" } },
            timeoutMs: 30000,
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, value: "owner" },
        });
    });

    it("returns forbidden for delegated permission RPCs when approval is denied", async () => {
        await db.session.update({ where: { id: sessionId }, data: { accountId: ownerId } });
        await db.sessionShare.create({ data: { sessionId, sharedByUserId: ownerId,
            sharedWithUserId: accountId, accessLevel: "edit", canApprovePermissions: false } });
        const target = createTarget("owner-socket", { ok: true });
        const { io, inMock } = createIo({
            [`rpc:${ownerId}:${sessionId}:permission`]: [[target.socket]],
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
        });
        rpcHandler(accountId, callerSocket as unknown as Socket, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: `${sessionId}:permission`, params: { requestId: "perm-1" } }, callback);

        expect(inMock).not.toHaveBeenCalled();
        expect(target.emitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
    });

    it("returns METHOD_NOT_AVAILABLE when the room stays empty", async () => {
        const { io } = createIo({
            [`rpc:${accountId}:missing-method`]: [[]],
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
        });

        rpcHandler(accountId, callerSocket as unknown as Socket, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: "missing-method", params: {} }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it("preserves an explicit longer caller timeout for capabilities RPCs", async () => {
        const target = createTarget("target-socket", { ok: true, result: "{}" });
        const { io } = createIo({
            [`rpc:${accountId}:${machineId}:capabilities.invoke`]: [[target.socket]],
        });
        const callerSocket = createAuthenticatedFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
        });

        rpcHandler(accountId, callerSocket as unknown as Socket, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: `${machineId}:capabilities.invoke`, params: { id: "cli.gemini" }, timeoutMs: 120000 }, callback);

        expect(target.socket.timeout).toHaveBeenCalledWith(120000, { rejectOnDisconnect: true });
        expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: `${machineId}:capabilities.invoke`,
            params: { id: "cli.gemini" },
            callerAuthority: "present_user",
            timeoutMs: 120000,
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, result: "{}" },
        });
    });

    // The daemon's raw Browser and Computer control routes admit only present_user (SEC-FIX-1101 S2).
    it.each([
        [RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, "present_user"],
        [RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE, "present_user"],
        [RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, "account_automation"],
        [RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE, "account_automation"],
    ] as const)("forwards %s human takeover with the caller credential's %s authority", async (rpcMethod, authAuthority) => {
        const method = `${machineId}:${rpcMethod}`;
        const target = createTarget(`takeover-${authAuthority}`, { ok: true });
        const { io } = createIo({ [`rpc:${accountId}:${method}`]: [[target.socket]] });
        const callerSocket = createAuthenticatedFakeSocket({ id: `ui-${authAuthority}`, emit: vi.fn(), data: { authAuthority } });
        rpcHandler(accountId, callerSocket as unknown as Socket, { io });
        const callback = vi.fn();
        await getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL)({ method, params: "opaque-control" }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
        expect(target.emitWithAck.mock.calls[0]?.[1]).toMatchObject({ method, callerAuthority: authAuthority });
    });
});
