import type { PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";
import type { Server, Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";
import { createPeerTcpTunnelRelayCoordinator } from "./relayCoordinator";

describe("createPeerTcpTunnelRelayCoordinator", () => {
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
