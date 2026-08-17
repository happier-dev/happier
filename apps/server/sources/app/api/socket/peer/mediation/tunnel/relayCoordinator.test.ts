import { EventEmitter } from "node:events";

import type { PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";
import type { Redis } from "ioredis";
import type { Server, Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";
import { createPeerTcpTunnelRelayCoordinator } from "./relayCoordinator";

describe("createPeerTcpTunnelRelayCoordinator", () => {
    it("does not consume a grant when close wins a pending Redis readiness wait", async () => {
        let redisStatus = "reconnecting";
        const set = vi.fn(async () => "OK" as const);
        const disconnect = vi.fn();
        const relayAdmissionRedis = Object.assign(new EventEmitter(), {
            set,
            disconnect,
        });
        Object.defineProperty(relayAdmissionRedis, "status", {
            get: () => redisStatus,
        });
        const io = {
            sockets: {
                sockets: new Map(),
            },
            on: vi.fn(),
            off: vi.fn(),
            serverSideEmit: vi.fn(),
            serverSideEmitWithAck: vi.fn(async () => []),
        } as unknown as Server;
        const coordinator = createPeerTcpTunnelRelayCoordinator({
            io,
            config: {
                mode: "redis",
                redis: {
                    duplicate: vi.fn(() => relayAdmissionRedis),
                } as unknown as Pick<Redis, "duplicate">,
            },
        });
        const nowMs = Date.now();
        const admission = coordinator.admit({
            accountId: "account-closing",
            tunnelKey: "account-closing:machine:machine-closing:user:tunnel-closing",
            grantId: "grant-closing",
            grantExpiresAt: nowMs + 60_000,
            machineId: "machine-closing",
            maxDurationMs: 30_000,
            nowMs,
            onMachineEnvelope: vi.fn(),
            onMachineDisconnect: vi.fn(),
        });

        expect(relayAdmissionRedis.listenerCount("ready")).toBe(1);
        expect(relayAdmissionRedis.listenerCount("end")).toBe(1);
        const close = coordinator.close();
        redisStatus = "ready";
        relayAdmissionRedis.emit("ready");

        await expect(admission).resolves.toEqual({
            status: "rejected",
            reason: "cluster_unavailable",
        });
        await expect(Promise.race([
            close.then(() => "closed" as const),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
        ])).resolves.toBe("closed");
        expect(set).not.toHaveBeenCalled();
        expect(relayAdmissionRedis.listenerCount("ready")).toBe(0);
        expect(relayAdmissionRedis.listenerCount("end")).toBe(0);
    });

    it("gives relay admission its own bounded reconnect policy", async () => {
        const disconnect = vi.fn();
        const off = vi.fn();
        const on = vi.fn();
        const duplicate = vi.fn((_options?: unknown) => ({
            disconnect,
            off,
            on,
            set: vi.fn(),
        }));
        const io = {
            sockets: {
                sockets: new Map(),
            },
            on: vi.fn(),
            off: vi.fn(),
            serverSideEmit: vi.fn(),
        } as unknown as Server;
        const coordinator = createPeerTcpTunnelRelayCoordinator({
            io,
            config: {
                mode: "redis",
                redis: { duplicate } as unknown as Pick<Redis, "duplicate">,
            },
        });

        try {
            const options = duplicate.mock.calls[0]?.[0] as Readonly<{
                enableOfflineQueue?: boolean;
                maxRetriesPerRequest?: number;
                retryStrategy?: (attempt: number) => number;
                socketTimeout?: number;
            }>;
            expect(options).toMatchObject({
                enableOfflineQueue: false,
                maxRetriesPerRequest: 0,
                retryStrategy: expect.any(Function),
                socketTimeout: 2_000,
            });
            expect(options.retryStrategy?.(1)).toBe(50);
            expect(options.retryStrategy?.(100)).toBe(2_000);
        } finally {
            await coordinator.close();
        }
    });

    it("shares one disconnect listener across active attachments on the exact machine socket", async () => {
        const accountId = "account-shared-machine-socket";
        const machineId = "machine-shared-machine-socket";
        const machineSocketId = "socket-shared-machine-socket";
        const machineSocket = Object.assign(new EventEmitter(), {
            connected: true,
            id: machineSocketId,
            data: {
                userId: accountId,
                clientType: "machine-scoped",
                machineId,
            },
            rooms: new Set(getSocketRooms({
                userId: accountId,
                clientType: "machine-scoped",
                machineId,
            })),
        });
        const io = {
            sockets: {
                sockets: new Map([[machineSocketId, machineSocket]]),
            },
            on: vi.fn(),
            off: vi.fn(),
            in: vi.fn(() => ({
                local: {
                    fetchSockets: vi.fn(async () => [machineSocket]),
                },
            })),
            to: vi.fn(() => ({ emit: vi.fn() })),
            serverSideEmit: vi.fn(),
            serverSideEmitWithAck: vi.fn(async () => []),
        } as unknown as Server;
        const coordinator = createPeerTcpTunnelRelayCoordinator({
            io,
            config: { mode: "memory" },
        });
        const envelope = {
            v: 1,
            scopeUserId: accountId,
            sender: { kind: "machine", machineId },
            recipient: { kind: "user", socketId: "user-socket" },
            frame: {
                v: 1,
                kind: "abort",
                tunnelId: "tunnel-shared-machine-socket",
                reasonCode: "test",
            },
        } satisfies PeerTcpTunnelRelayEnvelope;
        const firstBatch = Array.from({ length: 12 }, (_, index) => ({
            tunnelKey: `${accountId}:machine:${machineId}:user:release-${index}`,
            onMachineDisconnect: vi.fn(),
        }));
        const disconnectBatch = Array.from({ length: 12 }, (_, index) => ({
            tunnelKey: `${accountId}:machine:${machineId}:user:disconnect-${index}`,
            onMachineDisconnect: vi.fn(),
        }));
        const admitBatch = async (
            batch: ReadonlyArray<Readonly<{
                tunnelKey: string;
                onMachineDisconnect: ReturnType<typeof vi.fn>;
            }>>,
            grantPrefix: string,
        ): Promise<void> => {
            for (const [index, attachment] of batch.entries()) {
                const nowMs = Date.now();
                await expect(coordinator.admit({
                    accountId,
                    tunnelKey: attachment.tunnelKey,
                    grantId: `${grantPrefix}-${index}`,
                    grantExpiresAt: nowMs + 60_000,
                    machineId,
                    maxDurationMs: 30_000,
                    nowMs,
                    onMachineEnvelope: vi.fn(),
                    onMachineDisconnect: attachment.onMachineDisconnect,
                })).resolves.toEqual({ status: "attached" });
            }
        };

        try {
            await admitBatch(firstBatch, "grant-release");
            expect(machineSocket.listenerCount("disconnect")).toBe(1);

            for (const attachment of firstBatch) {
                coordinator.release(attachment.tunnelKey);
            }
            expect(machineSocket.listenerCount("disconnect")).toBe(0);
            expect(firstBatch.every(({ onMachineDisconnect }) =>
                onMachineDisconnect.mock.calls.length === 0
            )).toBe(true);

            await admitBatch(disconnectBatch, "grant-disconnect");
            expect(machineSocket.listenerCount("disconnect")).toBe(1);

            machineSocket.emit("disconnect");
            machineSocket.emit("disconnect");

            expect(machineSocket.listenerCount("disconnect")).toBe(0);
            for (const attachment of disconnectBatch) {
                expect(attachment.onMachineDisconnect).toHaveBeenCalledOnce();
                expect(coordinator.routeMachineEnvelope({
                    tunnelKey: attachment.tunnelKey,
                    machineSocketId,
                    envelope,
                })).toBe("rejected");
                coordinator.release(attachment.tunnelKey);
            }
            expect(machineSocket.listenerCount("disconnect")).toBe(0);
        } finally {
            await coordinator.close();
            await coordinator.close();
        }
    });

    it("admits an exact local machine without waiting for an unavailable peer replica", async () => {
        const accountId = "account-local-survivor";
        const machineId = "machine-local-survivor";
        const machineSocketId = "socket-local-survivor";
        const rooms = new Set(getSocketRooms({
            userId: accountId,
            clientType: "machine-scoped",
            machineId,
        }));
        const machineSocket = {
            connected: true,
            id: machineSocketId,
            data: {
                userId: accountId,
                clientType: "machine-scoped",
                machineId,
            },
            rooms,
            once: vi.fn(),
            off: vi.fn(),
        } as unknown as Socket;
        const clusterFetchSockets = vi.fn(async () => {
            throw new Error("peer replica acknowledgement timed out");
        });
        const localFetchSockets = vi.fn(async () => [machineSocket]);
        const io = {
            sockets: {
                sockets: new Map([[machineSocketId, machineSocket]]),
            },
            on: vi.fn(),
            off: vi.fn(),
            in: vi.fn(() => ({
                local: {
                    fetchSockets: localFetchSockets,
                },
                timeout: vi.fn(() => ({
                    fetchSockets: clusterFetchSockets,
                })),
            })),
            to: vi.fn(() => ({
                emit: vi.fn(),
            })),
            serverSideEmit: vi.fn(),
            serverSideEmitWithAck: vi.fn(),
        } as unknown as Server;
        const coordinator = createPeerTcpTunnelRelayCoordinator({
            io,
            config: { mode: "memory" },
        });
        const envelope = {
            v: 1,
            scopeUserId: accountId,
            sender: { kind: "machine", machineId },
            recipient: { kind: "user", socketId: "user-socket" },
            frame: {
                v: 1,
                kind: "abort",
                tunnelId: "tunnel-local-survivor",
                reasonCode: "test",
            },
        } satisfies PeerTcpTunnelRelayEnvelope;

        try {
            await expect(coordinator.admit({
                accountId,
                tunnelKey: `${accountId}:machine:${machineId}:user:tunnel-local-survivor`,
                grantId: "grant-local-survivor",
                grantExpiresAt: 60_000,
                machineId,
                maxDurationMs: 30_000,
                nowMs: 1_000,
                onMachineEnvelope: vi.fn(),
                onMachineDisconnect: vi.fn(),
            })).resolves.toEqual({ status: "attached" });
            expect(localFetchSockets).toHaveBeenCalledOnce();
            expect(clusterFetchSockets).not.toHaveBeenCalled();
            expect(coordinator.routeMachineEnvelope({
                tunnelKey: `${accountId}:machine:${machineId}:user:tunnel-local-survivor`,
                machineSocketId,
                envelope,
            })).toBe("local_exact");
        } finally {
            await coordinator.close();
        }
    });
});
