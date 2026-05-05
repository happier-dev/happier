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
vi.mock("@/app/events/eventRouter", () => ({
    buildMachineActivityEphemeral: vi.fn(),
    eventRouter: {
        setIo: (...args: unknown[]) => eventRouterSetIoMock.apply(undefined, args),
        addConnection: vi.fn(),
        emitEphemeral: vi.fn(),
    },
}));

const authVerifyTokenMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: (...args: unknown[]) => authVerifyTokenMock.apply(undefined, args),
    },
}));

const enforceLoginEligibilityMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/enforceLoginEligibility", () => ({
    enforceLoginEligibility: (...args: unknown[]) => enforceLoginEligibilityMock.apply(undefined, args),
}));

const seedSessionValidityMock = vi.hoisted(() => vi.fn());
const seedMachineValidityMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        seedSessionValidity: (...args: unknown[]) => seedSessionValidityMock.apply(undefined, args),
        seedMachineValidity: (...args: unknown[]) => seedMachineValidityMock.apply(undefined, args),
    },
}));

const resolveSessionScopedSocketBindingMock = vi.hoisted(() => vi.fn());
vi.mock("./socket/sessionScopedBinding", () => ({
    resolveSessionScopedSocketBinding: (...args: unknown[]) => resolveSessionScopedSocketBindingMock.apply(undefined, args),
}));

const recordSocketAuthHandshakeExceptionMock = vi.hoisted(() => vi.fn());
const recordSocketAuthHandshakeStageDurationMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());

const createMachineSocketOwnershipRegistryMock = vi.hoisted(() => vi.fn((_params?: unknown) => ({
    claimOwner: vi.fn(async () => ({ result: "already-owned-by-self" })),
    releaseOwner: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
})));
vi.mock("./socket/machineSocketOwnershipRegistry", () => ({
    createMachineSocketOwnershipRegistry: (params: unknown) => createMachineSocketOwnershipRegistryMock(params),
}));

vi.mock("../monitoring/metrics/index", () => ({
    recordSocketAuthHandshake: vi.fn(),
    recordSocketAuthHandshakeStageDuration: (...args: unknown[]) => recordSocketAuthHandshakeStageDurationMock.apply(undefined, args),
    recordSocketAuthHandshakeException: (...args: unknown[]) => recordSocketAuthHandshakeExceptionMock.apply(undefined, args),
    recordSocketTransportUpgradeOutcome: vi.fn(),
    setSocketAdapterModeInfo: vi.fn(),
    trackWebSocketConnection: vi.fn(),
    untrackWebSocketConnection: vi.fn(),
    websocketEventsCounter: { inc: vi.fn() },
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
    readMachineTransferFeatureEnv: vi.fn(() => ({ allowDaemonTakeover: true })),
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
    isPrismaErrorCode: (error: unknown, code: string) =>
        (error as { code?: unknown } | null | undefined)?.code === code,
}));

vi.mock("@/utils/logging/log", () => ({ log: (...args: unknown[]) => logMock.apply(undefined, args) }));
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

describe("startSocket handshake cache warmup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authVerifyTokenMock.mockResolvedValue({ userId: "u1" });
        enforceLoginEligibilityMock.mockResolvedValue({ ok: true });
        resolveSessionScopedSocketBindingMock.mockResolvedValue({
            ok: true,
            binding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
            cacheWarmState: {
                session: {
                    active: true,
                    lastActiveAt: new Date("2026-04-19T18:00:00.000Z"),
                },
                machine: {
                    active: true,
                    lastActiveAt: new Date("2026-04-19T18:00:00.000Z"),
                },
            },
        });
    });

    it("seeds session and machine validity from a successful machine-bound session handshake", async () => {
        const fakeServer = {
            on: vi.fn(),
            use: vi.fn(),
            close: vi.fn(),
            to: vi.fn(() => ({ emit: vi.fn() })),
        };
        serverCtor.mockReturnValue(fakeServer);

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as never);

        const middleware = fakeServer.use.mock.calls[0]?.[0] as
            | ((socket: Record<string, unknown>, next: (err?: unknown) => void) => Promise<void>)
            | undefined;
        expect(middleware).toBeTypeOf("function");

        const next = vi.fn();
        const socket = {
            id: "socket-1",
            handshake: {
                auth: {
                    token: "token-1",
                    clientType: "session-scoped",
                    sessionId: "s1",
                    machineId: "m1",
                },
            },
            conn: {
                transport: { name: "websocket" },
            },
            data: {},
        };

        await middleware!(socket, next);

        expect(next).toHaveBeenCalledWith();
        expect(resolveSessionScopedSocketBindingMock).toHaveBeenCalledWith({
            userId: "u1",
            sessionId: "s1",
            machineId: "m1",
        });
        expect(seedSessionValidityMock).toHaveBeenCalledWith({
            sessionId: "s1",
            userId: "u1",
            active: true,
            lastActiveAt: new Date("2026-04-19T18:00:00.000Z"),
        });
        expect(seedMachineValidityMock).toHaveBeenCalledWith({
            machineId: "m1",
            userId: "u1",
            active: true,
            lastActiveAt: new Date("2026-04-19T18:00:00.000Z"),
        });
        expect(recordSocketAuthHandshakeStageDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "session-scoped",
                transport: "websocket",
                stage: "verify-token",
                result: "ok",
            }),
        );
        expect(recordSocketAuthHandshakeStageDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "session-scoped",
                transport: "websocket",
                stage: "login-eligibility",
                result: "ok",
            }),
        );
        expect(recordSocketAuthHandshakeStageDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "session-scoped",
                transport: "websocket",
                stage: "session-binding",
                result: "ok",
            }),
        );
    });

    it("rejects a session-scoped handshake with upstream_error when binding lookup throws", async () => {
        const fakeServer = {
            on: vi.fn(),
            use: vi.fn(),
            close: vi.fn(),
            to: vi.fn(() => ({ emit: vi.fn() })),
        };
        serverCtor.mockReturnValue(fakeServer);
        resolveSessionScopedSocketBindingMock.mockRejectedValueOnce({ code: "P2037" });

        const { startSocket } = await import("./socket");
        startSocket({ server: {} } as never);

        const middleware = fakeServer.use.mock.calls[0]?.[0] as
            | ((socket: Record<string, unknown>, next: (err?: unknown) => void) => Promise<void>)
            | undefined;
        expect(middleware).toBeTypeOf("function");

        const next = vi.fn();
        const socket = {
            id: "socket-db-failure",
            handshake: {
                auth: {
                    token: "token-1",
                    clientType: "session-scoped",
                    sessionId: "s1",
                    machineId: "m1",
                },
            },
            conn: {
                transport: { name: "websocket" },
            },
            data: {},
        };

        await middleware!(socket, next);

        expect(next).toHaveBeenCalledTimes(1);
        const err = next.mock.calls[0]?.[0] as { message?: string; data?: Record<string, unknown> } | undefined;
        expect(err?.message).toBe("upstream_error");
        expect(err?.data).toMatchObject({
            error: "upstream_error",
            statusCode: 503,
        });
        expect(recordSocketAuthHandshakeExceptionMock).toHaveBeenCalledWith({
            clientType: "session-scoped",
            transport: "websocket",
            stage: "session-binding",
            classification: "prisma-p2037",
        });
        expect(recordSocketAuthHandshakeStageDurationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientType: "session-scoped",
                transport: "websocket",
                stage: "session-binding",
                result: "error",
            }),
        );
        expect(logMock).toHaveBeenCalled();
    });
});
