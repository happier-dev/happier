import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { createMachineSocketOwnershipRegistry } from "./machineSocketOwnershipRegistry";

const redisEvalMock = vi.fn();
const redisHmgetMock = vi.fn();

vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: () => ({
        eval: redisEvalMock,
        hmget: redisHmgetMock,
    }),
}));

function createIoStub() {
    const sockets = new Map<string, Socket>();
    return {
        sockets: {
            sockets,
        },
        in: vi.fn((socketId: string) => ({
            disconnectSockets: vi.fn((disconnect: boolean) => {
                if (!disconnect) return;
                const socket = sockets.get(socketId);
                if (!socket) return;
                (socket as unknown as { connected?: boolean }).connected = false;
                const disconnectFn = (socket as unknown as { disconnect?: (close?: boolean) => void }).disconnect;
                disconnectFn?.call(socket, true);
            }),
        })),
    } as unknown as Server;
}

function setSocket(io: Server, socketId: string, connected: boolean): Socket {
    const disconnect = vi.fn((close?: boolean) => {
        if (close !== false) {
            (socket as unknown as { connected?: boolean }).connected = false;
        }
    });
    const socket = {
        connected,
        disconnect,
    } as unknown as Socket;
    io.sockets.sockets.set(socketId, socket);
    return socket;
}

describe("createMachineSocketOwnershipRegistry", () => {
    beforeEach(() => {
        delete process.env.HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS;
        redisEvalMock.mockReset();
        redisHmgetMock.mockReset();
    });

    it("rejects a second live owner for the same account and machine", async () => {
        const io = createIoStub();
        setSocket(io, "socket-stable", true);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: false },
        });

        const first = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-stable",
            owner: {
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
            },
        });

        expect(first).toEqual({ result: "granted" });

        const second = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-dev",
            owner: {
                runtimeId: "runtime-dev",
                cliVersion: "0.2.3-dev",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        expect(second).toEqual({
            result: "conflict",
            owner: expect.objectContaining({
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
                socketId: "socket-stable",
            }),
        });
        expect((io as unknown as { timeout?: unknown }).timeout).toBeUndefined();
    });

    it("allows the same runtime to reclaim ownership on a new socket and disconnects the old socket", async () => {
        const io = createIoStub();
        const oldSocket = setSocket(io, "socket-old", true);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: false },
        });

        await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-old",
            owner: {
                runtimeId: "runtime-same",
                cliVersion: "0.2.3",
                publicReleaseChannel: "preview",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        setSocket(io, "socket-new", true);

        const reclaimed = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-new",
            owner: {
                runtimeId: "runtime-same",
                cliVersion: "0.2.3",
                publicReleaseChannel: "preview",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        expect(reclaimed).toEqual({ result: "already-owned-by-self" });
        expect(oldSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it("allows the same runtime to reclaim Redis-backed ownership on a new socket and disconnects the old socket", async () => {
        const io = createIoStub();
        const oldSocket = setSocket(io, "socket-old", true);
        setSocket(io, "socket-new", true);

        redisHmgetMock.mockResolvedValueOnce([
            "socket-old",
            "runtime-same",
            "0.2.3",
            "preview",
            "manual",
            "false",
            null,
        ]);
        redisEvalMock.mockResolvedValueOnce("self");

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: true, instanceId: "instance-1" },
        });

        const reclaimed = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-new",
            owner: {
                runtimeId: "runtime-same",
                cliVersion: "0.2.3",
                publicReleaseChannel: "preview",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        expect(reclaimed).toEqual({ result: "already-owned-by-self" });
        expect(oldSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it("drops a stale disconnected owner before granting a new one", async () => {
        const io = createIoStub();
        setSocket(io, "socket-old", false);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: false },
        });

        await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-old",
            owner: {
                runtimeId: "runtime-old",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
            },
        });

        setSocket(io, "socket-new", true);

        const next = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-new",
            owner: {
                runtimeId: "runtime-new",
                cliVersion: "0.2.4",
                publicReleaseChannel: "preview",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        expect(next).toEqual({ result: "granted" });
    });

    it("rejects takeover when the live owner is background-service managed", async () => {
        const io = createIoStub();
        const stableSocket = setSocket(io, "socket-stable", true);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: false },
        });

        await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-stable",
            owner: {
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
            },
        });

        setSocket(io, "socket-dev", true);

        const takeover = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-dev",
            owner: {
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
                takeoverRequested: true,
            },
        });

        expect(takeover).toEqual({
            result: "conflict",
            owner: expect.objectContaining({
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                socketId: "socket-stable",
            }),
        });
        expect(stableSocket.disconnect).not.toHaveBeenCalled();
    });

    it("allows takeover when the live owner is manual even when legacy metadata omits serviceManaged", async () => {
        const io = createIoStub();
        const stableSocket = setSocket(io, "socket-stable", true);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: false },
        });

        await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-stable",
            owner: {
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "manual",
            },
        });

        setSocket(io, "socket-dev", true);

        const takeover = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-dev",
            owner: {
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
                takeoverRequested: true,
            },
        });

        expect(takeover).toEqual({ result: "takeover-granted" });
        expect(stableSocket.disconnect).toHaveBeenCalledWith(true);

        const followup = await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-third",
            owner: {
                runtimeId: "runtime-third",
                cliVersion: "0.2.5",
                publicReleaseChannel: "preview",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        expect(followup).toEqual({
            result: "conflict",
            owner: expect.objectContaining({
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
                socketId: "socket-dev",
            }),
        });
    });
});
