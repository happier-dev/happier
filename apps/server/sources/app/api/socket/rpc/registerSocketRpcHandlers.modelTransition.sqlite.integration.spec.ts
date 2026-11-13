import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { getAccountSessionSocketRoom } from "@/app/api/socketRooms";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from "../../testkit/socketHarness";
import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

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
        return createSocketRoomDiscoveryHarness(async room => room === rpcRoom
            ? params.targets
            : params.targetsBySocketId.get(room) ?? []);
    }

    function createCaller(): ReturnType<typeof createFakeSocket> {
        return createFakeSocket({
            id: `caller-${randomUUID()}`,
            data: {
                clientType: "user-scoped",
                authAuthority: "present_user",
                authTokenAuthenticationEvidence: [],
            },
        });
    }

    it.each([SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION, 'session.update.post'])(
        'distinguishes a replacement publisher gap from unsupported %s and routes to its successor', async rpcMethod => {
            const seeded = await seed();
            const presence = createSessionPublisherPresence();
            const effect = vi.fn(async () => ({ persisted: true, localId: 'successor-original' }));
            const successor = { id: 'successor', data: { clientType: 'session-scoped' } as Record<string, unknown>,
                timeout: () => ({ emitWithAck: effect }) };
            const method = `${seeded.binding.sessionId}:${rpcMethod}`;
            const targets: object[] = [];
            const peers = new Map<string, readonly object[]>();
            const io = createRoutingIo({ accountId: seeded.binding.accountId, method, targets, targetsBySocketId: peers });
            const caller = createCaller();
            const callback = vi.fn();
            registerSocketRpcHandlers({ userId: seeded.binding.accountId, socket: caller as unknown as Socket,
                io, sessionPublisherPresence: presence });
            const call = () => triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: 'opaque-request' }, callback);

            await call();
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }));
            expect(effect).not.toHaveBeenCalled();

            const registration = await presence.registerPublisher({ socket: successor, binding: seeded.binding,
                completeActivitySnapshot: { state: 'active', activeCount: 1 } });
            expect(registration.status).toBe('registered');
            peers.set(getAccountSessionSocketRoom(seeded.binding.accountId, seeded.binding.sessionId), [successor]);
            peers.set(successor.id, [successor]);
            await call();
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
            expect(effect).not.toHaveBeenCalled();

            targets.push(successor);
            await call();
            expect(callback).toHaveBeenLastCalledWith({ ok: true, result: { persisted: true, localId: 'successor-original' } });
            expect(effect).toHaveBeenCalledOnce();
        },
    );

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

    it("does not emit after specialized target currentness succeeds when the editor loses Session access", async () => {
        const seeded = await seed();
        const editor = await db.account.create({
            data: {
                publicKey: `editor-${randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: seeded.binding.sessionId,
                createdByAccountId: seeded.binding.accountId,
                accountId: editor.id,
                accessLevel: "edit",
                canApprovePermissions: false,
            },
        });

        let now = new Date(seeded.initialFence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const targetEffect = vi.fn(async () => ({ ok: true, status: "applied" } as const));
        const target = {
            id: "current",
            data: { clientType: "session-scoped" } as Record<string, unknown>,
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const registration = await presence.registerPublisher({
            socket: target,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registration.status !== "registered") {
            throw new Error("expected current publisher registration");
        }

        const specializedCurrentnessSucceeded = deferred<void>();
        const resumeSpecializedGuard = deferred<void>();
        const instrumentedPresence = {
            ...presence,
            isCurrentPublisherProjection: async (
                params: Parameters<typeof presence.isCurrentPublisherProjection>[0],
            ) => {
                const current = await presence.isCurrentPublisherProjection(params);
                if (current) {
                    specializedCurrentnessSucceeded.resolve();
                    await resumeSpecializedGuard.promise;
                }
                return current;
            },
        };
        const method = `${seeded.binding.sessionId}:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const io = createRoutingIo({
            accountId: seeded.binding.accountId,
            method,
            targets: [target],
            targetsBySocketId: new Map([[target.id, [target]]]),
        });
        const caller = createCaller();
        const callback = vi.fn();
        registerSocketRpcHandlers({
            userId: editor.id,
            socket: caller as unknown as Socket,
            io,
            sessionPublisherPresence: instrumentedPresence,
        });

        const call = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: {
                v: 1,
                selection: {
                    agentTargetKey: "backend:codex",
                    providerConnectionId: null,
                    modelId: "next-model",
                },
            },
        }, callback);

        await specializedCurrentnessSucceeded.promise;
        await db.sessionGrant.delete({
            where: { principalKind: 'account',
                sessionId_accountId: {
                    sessionId: seeded.binding.sessionId,
                    accountId: editor.id,
                },
            },
        });
        resumeSpecializedGuard.resolve();
        await call;

        expect(targetEffect).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
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
        // The selected publisher received this mutation before losing custody.
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
        }));
    });
});
