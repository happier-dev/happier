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

    it("invalidates the local lease when the Redis refresh loop fails", async () => {
        vi.useFakeTimers();
        try {
            const io = createIoStub();
            const originalSocket = setSocket(io, "socket-1", true);
            setSocket(io, "socket-2", true);

            redisEvalMock.mockResolvedValueOnce("granted");
            redisEvalMock.mockRejectedValueOnce(new Error("redis down"));
            redisEvalMock.mockResolvedValueOnce(1);

            const registry = createMachineSocketOwnershipRegistry({
                io,
                config: { enabled: true, instanceId: "instance-1", ttlSeconds: 2 },
            });

            const granted = await registry.claimOwner({
                accountId: "acct-1",
                machineId: "machine-1",
                socketId: "socket-1",
                owner: {},
            });

            expect(granted).toEqual({ result: "granted" });

            await vi.advanceTimersByTimeAsync(1000);
            await Promise.resolve();

            expect(redisEvalMock).toHaveBeenCalledTimes(3);
            expect(originalSocket.disconnect).toHaveBeenCalledWith(true);
            expect(redisEvalMock).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining("DEL"),
                1,
                "machine-owner:acct-1:machine-1",
                "socket-1",
            );

            redisEvalMock.mockResolvedValueOnce("granted");

            await expect(
                registry.claimOwner({
                    accountId: "acct-1",
                    machineId: "machine-1",
                    socketId: "socket-2",
                    owner: {},
                }),
            ).resolves.toEqual({ result: "granted" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("invalidates the local lease when the Redis refresh loop reports lease loss", async () => {
        vi.useFakeTimers();
        try {
            const io = createIoStub();
            const originalSocket = setSocket(io, "socket-1", true);
            setSocket(io, "socket-2", true);

            redisEvalMock.mockResolvedValueOnce("granted");
            redisEvalMock.mockResolvedValueOnce(0);
            redisEvalMock.mockResolvedValueOnce("granted");

            const registry = createMachineSocketOwnershipRegistry({
                io,
                config: { enabled: true, instanceId: "instance-1", ttlSeconds: 2 },
            });

            await expect(
                registry.claimOwner({
                    accountId: "acct-1",
                    machineId: "machine-1",
                    socketId: "socket-1",
                    owner: {},
                }),
            ).resolves.toEqual({ result: "granted" });

            await vi.advanceTimersByTimeAsync(1000);
            await Promise.resolve();

            expect(originalSocket.disconnect).toHaveBeenCalledWith(true);

            await expect(
                registry.claimOwner({
                    accountId: "acct-1",
                    machineId: "machine-1",
                    socketId: "socket-2",
                    owner: {},
                }),
            ).resolves.toEqual({ result: "granted" });
        } finally {
            vi.useRealTimers();
        }
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

    it("keeps the replacement owner's refresh loop alive when a stale prior refresh resolves late", async () => {
        vi.useFakeTimers();
        try {
            const io = createIoStub();
            const oldSocket = setSocket(io, "socket-old", true);
            setSocket(io, "socket-new", true);

            let resolveStaleRefresh: ((value: number) => void) | undefined;
            const staleRefresh = new Promise<number>((resolve) => {
                resolveStaleRefresh = resolve;
            });

            redisHmgetMock
                .mockResolvedValueOnce([null, null, null, null, null, null, null])
                .mockResolvedValueOnce([
                    "socket-old",
                    "runtime-same",
                    "0.2.3",
                    "preview",
                    "manual",
                    "false",
                    null,
                ]);
            redisEvalMock.mockResolvedValueOnce("granted");
            redisEvalMock.mockImplementationOnce(() => staleRefresh);
            redisEvalMock.mockResolvedValueOnce(1);

            const registry = createMachineSocketOwnershipRegistry({
                io,
                config: { enabled: true, instanceId: "instance-1", ttlSeconds: 2 },
            });

            await expect(
                registry.claimOwner({
                    accountId: "acct-1",
                    machineId: "machine-1",
                    socketId: "socket-old",
                    owner: {
                        runtimeId: "runtime-same",
                    },
                }),
            ).resolves.toEqual({ result: "granted" });

            await vi.advanceTimersByTimeAsync(1000);

            await expect(
                registry.claimOwner({
                    accountId: "acct-1",
                    machineId: "machine-1",
                    socketId: "socket-new",
                    owner: {
                        runtimeId: "runtime-same",
                    },
                }),
            ).resolves.toEqual({ result: "already-owned-by-self" });

            expect(oldSocket.disconnect).toHaveBeenCalledWith(true);

            resolveStaleRefresh?.(0);
            await Promise.resolve();
            await Promise.resolve();

            await vi.advanceTimersByTimeAsync(1000);

            expect(redisEvalMock).toHaveBeenCalledTimes(3);
            expect(redisEvalMock).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining("updatedAt"),
                1,
                "machine-owner:acct-1:machine-1",
                "socket-new",
                expect.any(String),
                "instance-1",
                "2",
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("fails closed when Redis reports a conflict but owner readback is empty", async () => {
        const io = createIoStub();
        setSocket(io, "socket-new", true);

        redisEvalMock.mockResolvedValueOnce("conflict");
        redisHmgetMock
            .mockResolvedValueOnce([null, null, null, null, null, null, null])
            .mockResolvedValueOnce([null, null, null, null, null, null, null]);

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: true, instanceId: "instance-1" },
        });

        await expect(registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-new",
            owner: {
                runtimeId: "runtime-new",
                cliVersion: "0.2.4",
                publicReleaseChannel: "preview",
                startupSource: "background-service",
                serviceManaged: true,
            },
        })).resolves.toEqual({
            result: "conflict",
            owner: { socketId: "unknown" },
        });
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

    it("allows takeover when the live owner is manual even when legacy metadata omits serviceManaged but still carries a service label", async () => {
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
                serviceLabel: "com.happier.cli.daemon.default",
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

    it("rejects takeover when legacy owner metadata omits serviceManaged but still carries background-service startup", async () => {
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
                cliVersion: "0.2.2",
                publicReleaseChannel: "preview",
                startupSource: "background-service",
                serviceLabel: "Happier\\happier-daemon",
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
                cliVersion: "0.2.2",
                publicReleaseChannel: "preview",
                startupSource: "background-service",
                serviceLabel: "Happier\\happier-daemon",
                socketId: "socket-stable",
            }),
        });
        expect(stableSocket.disconnect).not.toHaveBeenCalled();
    });

    it("swallows Redis errors while releasing ownership so disconnect handlers don't emit unhandled rejections", async () => {
        const io = createIoStub();
        setSocket(io, "socket-1", true);

        redisEvalMock.mockResolvedValueOnce("granted");
        redisEvalMock.mockImplementationOnce(() => {
            throw new Error("redis down");
        });

        const registry = createMachineSocketOwnershipRegistry({
            io,
            config: { enabled: true, instanceId: "instance-1", ttlSeconds: 10 },
        });

        await registry.claimOwner({
            accountId: "acct-1",
            machineId: "machine-1",
            socketId: "socket-1",
            owner: {},
        });

        await expect(
            registry.releaseOwner({
                accountId: "acct-1",
                machineId: "machine-1",
                socketId: "socket-1",
            }),
        ).resolves.toBeUndefined();
    });
});
