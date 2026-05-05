import { beforeEach, describe, expect, it, vi } from "vitest";

const serverCtor = vi.hoisted(() => vi.fn());
vi.mock("socket.io", () => ({
    Server: function ServerMock(this: unknown, ...args: unknown[]) {
        return serverCtor.apply(undefined, args);
    },
}));

const onShutdownMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: (...args: unknown[]) => onShutdownMock.apply(undefined, args),
}));

const eventRouterSetIoMock = vi.hoisted(() => vi.fn());
const eventRouterAddConnectionMock = vi.hoisted(() => vi.fn());
const eventRouterRemoveConnectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/events/eventRouter", () => ({
    buildMachineActivityEphemeral: vi.fn(),
    eventRouter: {
        setIo: (...args: unknown[]) => eventRouterSetIoMock.apply(undefined, args),
        addConnection: (...args: unknown[]) => eventRouterAddConnectionMock.apply(undefined, args),
        removeConnection: (...args: unknown[]) => eventRouterRemoveConnectionMock.apply(undefined, args),
        emitEphemeral: vi.fn(),
    },
}));

const recordSocketConnectConvergencePhaseMock = vi.hoisted(() => vi.fn());
const recordSocketConnectConvergenceDurationMock = vi.hoisted(() => vi.fn());
const trackWebSocketConnectionMock = vi.hoisted(() => vi.fn());
const untrackWebSocketConnectionMock = vi.hoisted(() => vi.fn());
vi.mock("../monitoring/metrics/index", () => ({
    recordSocketAuthHandshake: vi.fn(),
    recordSocketAuthHandshakeStageDuration: vi.fn(),
    recordSocketAuthHandshakeException: vi.fn(),
    recordSocketConnectConvergencePhase: (...args: unknown[]) =>
        recordSocketConnectConvergencePhaseMock.apply(undefined, args),
    recordSocketConnectConvergenceDuration: (...args: unknown[]) =>
        recordSocketConnectConvergenceDurationMock.apply(undefined, args),
    recordSocketTransportUpgradeOutcome: vi.fn(),
    setSocketAdapterModeInfo: vi.fn(),
    trackWebSocketConnection: (...args: unknown[]) => trackWebSocketConnectionMock.apply(undefined, args),
    untrackWebSocketConnection: (...args: unknown[]) => untrackWebSocketConnectionMock.apply(undefined, args),
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/app/auth/auth", () => ({
    auth: { verifyToken: vi.fn() },
}));
vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility: vi.fn(),
}));
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        seedSessionValidity: vi.fn(),
        seedMachineValidity: vi.fn(),
    },
}));
vi.mock("./socket/sessionScopedBinding", () => ({
    resolveSessionScopedSocketBinding: vi.fn(),
}));
vi.mock("@/config/socketAdapter", () => ({
    readSocketAdapterRuntimeConfigFromEnv: vi.fn(() => ({
        adapter: "memory",
        redisStreamsEnabled: false,
        redisStreamsOptions: {},
    })),
}));
vi.mock("@/app/features/catalog/serverFeatureGate", () => ({
    isServerFeatureEnabledForRequest: vi.fn(() => false),
}));
vi.mock("@/app/features/catalog/readFeatureEnv", () => ({
    readMachineTransferFeatureEnv: vi.fn(() => ({
        allowDaemonTakeover: true,
        serverRoutedMaxBytes: 1_000_000,
        serverRoutedMaxActiveTransfersPerSocket: 1,
    })),
    readMachineLiveStreamFeatureEnv: vi.fn(() => ({
        directPeerEnabled: true,
        serverRoutedEnabled: false,
        serverRoutedCaps: null,
        serverRoutedDisabledReason: "relay_not_enabled",
    })),
    readMachineTunnelFeatureEnv: vi.fn(() => ({
        directPeerEnabled: true,
        serverRoutedEnabled: false,
        serverRoutedMaxBytes: 1_000_000,
        serverRoutedMaxActiveTunnelsPerSocket: 1,
        serverRoutedMaxFrameBytes: 65_536,
        maxIdleMs: 30_000,
        maxDurationMs: 60_000,
        allowedPorts: [],
    })),
    readPeerMediationFeatureEnv: vi.fn(() => ({
        grantSigningKeys: [],
    })),
}));
vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: vi.fn(),
        },
    },
    isPrismaErrorCode: vi.fn(() => false),
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("./socket/usageHandler", () => ({ usageHandler: vi.fn() }));
vi.mock("./socket/rpcHandler", () => ({ rpcHandler: vi.fn() }));
vi.mock("./socket/pingHandler", () => ({ pingHandler: vi.fn() }));
vi.mock("./socket/sessionUpdateHandler", () => ({ sessionUpdateHandler: vi.fn() }));
vi.mock("./socket/machineUpdateHandler", () => ({ machineUpdateHandler: vi.fn() }));
vi.mock("./socket/machineTransferHandler", () => ({ machineTransferHandler: vi.fn() }));
vi.mock("./socket/transferRelayV2Handler", () => ({ transferRelayV2Handler: vi.fn() }));
vi.mock("./socket/artifactUpdateHandler", () => ({ artifactUpdateHandler: vi.fn() }));
vi.mock("./socket/accessKeyHandler", () => ({ accessKeyHandler: vi.fn() }));
vi.mock("./socket/serverRpcForwarder", () => ({ createServerRpcForwarder: vi.fn(() => vi.fn()) }));
vi.mock("./socket/machineSocketOwnershipRegistry", () => ({
    createMachineSocketOwnershipRegistry: vi.fn(() => ({
        claimOwner: vi.fn(async () => ({ result: "already-owned-by-self" })),
        releaseOwner: vi.fn(async () => {}),
        shutdown: vi.fn(async () => {}),
    })),
}));

function createFakeServer() {
    return {
        on: vi.fn(),
        use: vi.fn(),
        close: vi.fn(),
        to: vi.fn(() => ({ emit: vi.fn() })),
    };
}

function readConnectionHandler(fakeServer: ReturnType<typeof createFakeServer>) {
    return fakeServer.on.mock.calls.find(([event]) => event === "connection")?.[1] as
        | ((socket: Record<string, unknown>) => Promise<void>)
        | undefined;
}

describe("startSocket connect convergence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("records connect start and completion without counting a later disconnect as pre-ready", async () => {
        const fakeServer = createFakeServer();
        serverCtor.mockReturnValue(fakeServer);

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as never);

        const connectionHandler = readConnectionHandler(fakeServer);
        expect(connectionHandler).toBeTypeOf("function");

        const socketOn = vi.fn();
        const socket = {
            id: "socket-1",
            data: {
                userId: "user-1",
                clientType: "user-scoped",
                clientPurpose: "stress",
            },
            handshake: {
                address: "127.0.0.1",
                headers: { "user-agent": "test-agent" },
            },
            conn: {
                transport: { name: "websocket" },
                remotePort: 3000,
            },
            join: vi.fn(async () => {}),
            on: socketOn,
            disconnect: vi.fn(),
            connected: true,
        };

        await connectionHandler!(socket);
        const disconnectListener = socketOn.mock.calls.find(([event]) => event === "disconnect")?.[1] as
            | ((reason: string) => void)
            | undefined;
        expect(disconnectListener).toBeTypeOf("function");

        disconnectListener!("transport close");

        expect(recordSocketConnectConvergencePhaseMock).toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "start",
        });
        expect(recordSocketConnectConvergencePhaseMock).toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "complete",
        });
        expect(recordSocketConnectConvergencePhaseMock).not.toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "disconnect_before_ready",
        });
        expect(recordSocketConnectConvergenceDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "user-scoped",
                transport: "websocket",
                result: "ready",
            }),
        );
        expect(recordSocketConnectConvergenceDurationMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "user-scoped",
                transport: "websocket",
                result: "disconnect_before_ready",
            }),
        );
    });

    it("records a disconnect before ready when the socket drops during room join", async () => {
        const fakeServer = createFakeServer();
        serverCtor.mockReturnValue(fakeServer);

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as never);

        const connectionHandler = readConnectionHandler(fakeServer);
        expect(connectionHandler).toBeTypeOf("function");

        let resolveJoin!: () => void;
        const joinPromise = new Promise<void>((resolve) => {
            resolveJoin = resolve;
        });
        const socketOn = vi.fn();
        const socket = {
            id: "socket-join-drop",
            data: {
                userId: "user-2",
                clientType: "user-scoped",
                clientPurpose: "stress",
            },
            handshake: {
                address: "127.0.0.1",
                headers: { "user-agent": "test-agent" },
            },
            conn: {
                transport: { name: "websocket" },
                remotePort: 3001,
            },
            join: vi.fn(() => joinPromise),
            on: socketOn,
            disconnect: vi.fn(),
            connected: true,
        };

        const connectionPromise = connectionHandler!(socket);
        await Promise.resolve();

        const disconnectListener = socketOn.mock.calls.find(([event]) => event === "disconnect")?.[1] as
            | ((reason: string) => void)
            | undefined;
        expect(disconnectListener).toBeTypeOf("function");

        disconnectListener!("transport close");
        resolveJoin();
        await connectionPromise;

        expect(recordSocketConnectConvergencePhaseMock).toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "start",
        });
        expect(recordSocketConnectConvergencePhaseMock).toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "disconnect_before_ready",
        });
        expect(recordSocketConnectConvergencePhaseMock).not.toHaveBeenCalledWith({
            clientType: "user-scoped",
            transport: "websocket",
            phase: "complete",
        });
        expect(recordSocketConnectConvergenceDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "user-scoped",
                transport: "websocket",
                result: "disconnect_before_ready",
            }),
        );
    });
});
