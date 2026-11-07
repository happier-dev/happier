import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Fastify as AppFastify } from "./types";
import { startSocket } from "./socket";

type SocketHandler = (...args: any[]) => unknown | Promise<unknown>;
type SocketMiddleware = (socket: FakeSocket, next: (error?: Error) => void) => void | Promise<void>;

type FakeSocket = {
    id: string;
    data: Record<string, unknown>;
    handshake: {
        address: string;
        auth: Record<string, unknown>;
        headers: Record<string, string>;
    };
    conn: { remotePort: number; transport: { name: string } };
    handlers: Map<string, SocketHandler>;
    disconnect: ReturnType<typeof vi.fn>;
    join: ReturnType<typeof vi.fn>;
    on: (event: string, handler: SocketHandler) => FakeSocket;
    timeout: () => { emitWithAck: ReturnType<typeof vi.fn> };
};

const socketTestMocks = vi.hoisted(() => ({
    serverCtor: vi.fn(),
    shutdownHandlers: new Map<string, () => unknown | Promise<unknown>>(),
    emitEphemeral: vi.fn(),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
}));

vi.mock("socket.io", () => ({
    Server: function ServerMock(this: any, ...args: any[]) {
        return socketTestMocks.serverCtor(...args);
    },
}));

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: vi.fn((name: string, handler: () => unknown | Promise<unknown>) => {
        socketTestMocks.shutdownHandlers.set(name, handler);
    }),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        addConnection: socketTestMocks.addConnection,
        removeConnection: socketTestMocks.removeConnection,
        emitEphemeral: socketTestMocks.emitEphemeral,
        setIo: vi.fn(),
    },
    buildMachineActivityEphemeral: (machineId: string, active: boolean, time: number) => ({
        type: "machine-activity",
        machineId,
        active,
        time,
    }),
}));

vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken: vi.fn(async () => ({ userId: "user-1" })) },
}));

vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: vi.fn(async () => ({ id: "machine-1", revokedAt: null, replacedByMachineId: null })),
        },
    },
}));

vi.mock("@/app/features/catalog/serverFeatureGate", () => ({
    isServerFeatureEnabledForRequest: vi.fn(() => false),
}));

vi.mock("@/app/features/catalog/readFeatureEnv", () => ({
    readMachineTransferFeatureEnv: vi.fn(() => ({
        serverRoutedMaxBytes: 0,
        serverRoutedMaxActiveTransfersPerSocket: 0,
    })),
}));

vi.mock("@/app/api/socket/machineSocketOwnershipRegistry", () => ({
    createMachineSocketOwnershipRegistry: vi.fn(() => ({
        claimOwner: vi.fn(async () => ({ result: "claimed" })),
        releaseOwner: vi.fn(async () => true),
    })),
}));

vi.mock("@/app/api/socket/usageHandler", () => ({ usageHandler: vi.fn() }));
vi.mock("@/app/api/socket/rpcHandler", () => ({ rpcHandler: vi.fn() }));
vi.mock("@/app/api/socket/pingHandler", () => ({ pingHandler: vi.fn() }));
vi.mock("@/app/api/socket/sessionUpdateHandler", () => ({ sessionUpdateHandler: vi.fn() }));
vi.mock("@/app/api/socket/machineUpdateHandler", () => ({ machineUpdateHandler: vi.fn() }));
vi.mock("@/app/api/socket/machineTransferHandler", () => ({ machineTransferHandler: vi.fn() }));
vi.mock("@/app/api/socket/artifactUpdateHandler", () => ({ artifactUpdateHandler: vi.fn() }));
vi.mock("@/app/api/socket/accessKeyHandler", () => ({ accessKeyHandler: vi.fn() }));

vi.mock("@/app/monitoring/metrics2", () => ({
    websocketEventsCounter: { inc: vi.fn() },
    incrementWebSocketConnection: vi.fn(),
    decrementWebSocketConnection: vi.fn(),
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/storage/redis/redis", () => ({ getRedisClient: vi.fn() }));
vi.mock("@socket.io/redis-streams-adapter", () => ({ createAdapter: vi.fn() }));

function createFastifyLikeApp(): AppFastify {
    return { server: {} } as unknown as AppFastify;
}

function createIoHarness() {
    const middlewares: SocketMiddleware[] = [];
    let connectionHandler: SocketHandler | null = null;
    const sockets = new Set<FakeSocket>();
    const io = {
        emit: vi.fn(),
        use: vi.fn((middleware: SocketMiddleware) => {
            middlewares.push(middleware);
            return io;
        }),
        on: vi.fn((event: string, handler: SocketHandler) => {
            if (event === "connection") {
                connectionHandler = handler;
            }
            return io;
        }),
        close: vi.fn(async () => {
            for (const socket of sockets) {
                await socket.handlers.get("disconnect")?.("server shutting down");
            }
        }),
        to: vi.fn(() => ({ emit: vi.fn() })),
    };

    async function connect(socket: FakeSocket): Promise<void> {
        for (const middleware of middlewares) {
            await new Promise<void>((resolve, reject) => {
                void middleware(socket, (error?: Error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }
        if (!connectionHandler) {
            throw new Error("missing connection handler");
        }
        await connectionHandler(socket);
        sockets.add(socket);
    }

    return { io, connect };
}

function createMachineSocket(): FakeSocket {
    const handlers = new Map<string, SocketHandler>();
    let socket: FakeSocket;
    socket = {
        id: "socket-machine-1",
        data: {},
        handshake: {
            address: "127.0.0.1",
            auth: {
                token: "token-1",
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
            headers: { "user-agent": "vitest" },
        },
        conn: { remotePort: 1234, transport: { name: "websocket" } },
        handlers,
        disconnect: vi.fn(),
        join: vi.fn(),
        on(event: string, handler: SocketHandler) {
            handlers.set(event, handler);
            return socket;
        },
        timeout: () => ({ emitWithAck: vi.fn() }),
    };
    return socket;
}

describe("startSocket planned shutdown machine presence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        socketTestMocks.shutdownHandlers.clear();
        process.env.HAPPIER_SOCKET_ADAPTER = "memory";
    });

    it("broadcasts machine inactive on ordinary machine socket disconnect", async () => {
        const harness = createIoHarness();
        socketTestMocks.serverCtor.mockReturnValue(harness.io);

        startSocket(createFastifyLikeApp());

        const socket = createMachineSocket();
        await harness.connect(socket);
        socketTestMocks.emitEphemeral.mockClear();

        await socket.handlers.get("disconnect")?.("transport close");

        expect(socketTestMocks.removeConnection).toHaveBeenCalled();
        expect(socketTestMocks.emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                type: "machine-activity",
                machineId: "machine-1",
                active: false,
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));
    });

    it("does not broadcast machine inactive when planned server shutdown closes sockets", async () => {
        const harness = createIoHarness();
        socketTestMocks.serverCtor.mockReturnValue(harness.io);

        startSocket(createFastifyLikeApp());

        const socket = createMachineSocket();
        await harness.connect(socket);
        socketTestMocks.emitEphemeral.mockClear();

        const shutdown = socketTestMocks.shutdownHandlers.get("api:socket");
        if (!shutdown) {
            throw new Error("missing socket shutdown handler");
        }
        await shutdown();

        expect(harness.io.emit).toHaveBeenCalledWith("server:restarting", expect.objectContaining({
            retryAfterMs: expect.any(Number),
        }));
        expect(socketTestMocks.removeConnection).toHaveBeenCalled();
        expect(socketTestMocks.emitEphemeral).not.toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                type: "machine-activity",
                machineId: "machine-1",
                active: false,
            }),
        }));
    });
});
