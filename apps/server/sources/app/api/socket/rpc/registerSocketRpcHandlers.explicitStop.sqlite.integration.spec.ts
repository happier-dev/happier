import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, triggerSocketHandler } from "../../testkit/socketHarness";
import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";

describe("explicit machine stop RPC on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-explicit-stop-rpc-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("marks the exact session inactive only after the daemon proves it stopped", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });

        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({
            socket: {},
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected publisher registration");

        const method = `${machineId}:${RPC_METHODS.STOP_SESSION}`;
        const targetEmitWithAck = vi.fn().mockResolvedValue({
            v: 1,
            result: "opaque-encrypted-stop-result",
            acknowledgement: {
                kind: "session.stop",
                status: "stopped",
            },
        });
        const target = {
            id: "target-socket",
            data: { clientType: "machine-scoped", machineId },
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([target]) })),
                fetchSockets: vi.fn().mockResolvedValue([target]),
            })),
        } as unknown as Server;
        const caller = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
        });
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: owner.id,
            socket: caller as unknown as Socket,
            io,
            sessionPublisherPresence: presence,
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: session.id,
            },
        }, callback);

        expect(targetEmitWithAck).toHaveBeenCalledOnce();
        expect(targetEmitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method,
                params: "opaque-encrypted-stop-request",
                authorization: {
                    kind: "session.write",
                    sessionId: session.id,
                },
                timeoutMs: 30_000,
                transportResponseEnvelopeVersion: 1,
            },
        );
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: "opaque-encrypted-stop-result",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: false });

        const replacementPublisherSocket = {};
        const replacementRegistered = await presence.registerPublisher({
            socket: replacementPublisherSocket,
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (replacementRegistered.status !== "registered") {
            throw new Error("expected replacement publisher registration");
        }
        targetEmitWithAck.mockResolvedValueOnce("opaque-encrypted-incomplete-result");
        callback.mockClear();

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-second-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: session.id,
            },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: "opaque-encrypted-incomplete-result",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });
});
