import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, triggerSocketHandler } from "../../testkit/socketHarness";
import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";

describe("publisher-authoritative model-transition RPC routing on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-model-transition-rpc-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const initialFence = new Date("2026-07-28T12:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: initialFence,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        return {
            binding: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
            },
            initialFence,
        };
    }

    function createRoutingIo(params: Readonly<{
        accountId: string;
        method: string;
        targets: readonly object[];
        targetsBySocketId: ReadonlyMap<string, readonly object[]>;
    }>): Server {
        const rpcRoom = `rpc:${params.accountId}:${params.method}`;
        return {
            in: vi.fn((room: string) => {
                const targets = room === rpcRoom
                    ? params.targets
                    : params.targetsBySocketId.get(room) ?? [];
                return {
                    timeout: vi.fn(() => ({
                        fetchSockets: vi.fn(async () => targets),
                    })),
                    fetchSockets: vi.fn(async () => targets),
                };
            }),
        } as unknown as Server;
    }

    function createCaller(): ReturnType<typeof createFakeSocket> {
        return createFakeSocket({
            id: `caller-${randomUUID()}`,
            data: { clientType: "user-scoped" },
        });
    }

    it("routes around a stale first socket and accepts the exact result after the selected socket advances its fence", async () => {
        const seeded = await seed();
        let now = new Date(seeded.initialFence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const staleEffect = vi.fn(async () => "stale-result");
        const staleTarget = {
            id: "a-stale",
            data: { clientType: "session-scoped" },
            timeout: vi.fn(() => ({ emitWithAck: staleEffect })),
        };
        const staleRegistration = await presence.registerPublisher({
            socket: staleTarget,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (staleRegistration.status !== "registered") {
            throw new Error("expected stale publisher registration");
        }

        const exactResult = {
            ok: false,
            status: "restart_required",
            activeSelection: {
                agentTargetKey: "backend:codex",
                providerConnectionId: null,
                modelId: "old-model",
            },
            requestedSelection: {
                agentTargetKey: "backend:codex",
                providerConnectionId: null,
                modelId: "next-model",
            },
        } as const;
        const currentTarget = {
            id: "z-current",
            data: { clientType: "session-scoped" } as Record<string, unknown>,
            timeout: vi.fn(),
        };
        const currentEffect = vi.fn(async () => {
            now = new Date(now.getTime() + 10);
            const touched = await presence.touchPublisher({ socket: currentTarget });
            if (touched.status !== "touched") throw new Error("expected publisher heartbeat");
            return exactResult;
        });
        currentTarget.timeout.mockReturnValue({ emitWithAck: currentEffect });
        now = new Date(staleRegistration.committedFence.getTime() + 10);
        const currentRegistration = await presence.registerPublisher({
            socket: currentTarget,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (currentRegistration.status !== "registered") {
            throw new Error("expected current publisher registration");
        }

        const method = `${seeded.binding.sessionId}:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const io = createRoutingIo({
            accountId: seeded.binding.accountId,
            method,
            targets: [staleTarget, currentTarget],
            targetsBySocketId: new Map([[currentTarget.id, [currentTarget]]]),
        });
        const caller = createCaller();
        const callback = vi.fn();
        registerSocketRpcHandlers({
            userId: seeded.binding.accountId,
            socket: caller as unknown as Socket,
            io,
            sessionPublisherPresence: presence,
        });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: {
                v: 1,
                selection: exactResult.requestedSelection,
            },
        }, callback);

        expect(staleEffect).not.toHaveBeenCalled();
        expect(currentEffect).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({ ok: true, result: exactResult });
    });

    it("suppresses the selected socket result when a successor wins during the emit", async () => {
        const seeded = await seed();
        let now = new Date(seeded.initialFence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const successor = {
            id: "successor",
            data: { clientType: "session-scoped" } as Record<string, unknown>,
        };
        const currentTarget = {
            id: "current",
            data: { clientType: "session-scoped" } as Record<string, unknown>,
            timeout: vi.fn(),
        };
        const currentRegistration = await presence.registerPublisher({
            socket: currentTarget,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (currentRegistration.status !== "registered") {
            throw new Error("expected current publisher registration");
        }
        const currentEffect = vi.fn(async () => {
            now = new Date(currentRegistration.committedFence.getTime() + 10);
            const successorRegistration = await presence.registerPublisher({
                socket: successor,
                binding: seeded.binding,
                completeActivitySnapshot: { state: "active", activeCount: 1 },
            });
            if (successorRegistration.status !== "registered") {
                throw new Error("expected successor publisher registration");
            }
            return { ok: true, status: "applied" } as const;
        });
        currentTarget.timeout.mockReturnValue({ emitWithAck: currentEffect });

        const method = `${seeded.binding.sessionId}:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const io = createRoutingIo({
            accountId: seeded.binding.accountId,
            method,
            targets: [currentTarget],
            targetsBySocketId: new Map([[currentTarget.id, [currentTarget]]]),
        });
        const caller = createCaller();
        const callback = vi.fn();
        registerSocketRpcHandlers({
            userId: seeded.binding.accountId,
            socket: caller as unknown as Socket,
            io,
            sessionPublisherPresence: presence,
        });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-request",
        }, callback);

        expect(currentEffect).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });
});
