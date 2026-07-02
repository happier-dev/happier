import { onShutdown } from "@/utils/process/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { buildMachineOwnerConflictSocketPayload, readMachineDaemonOwnershipMetadataFromSocketAuth } from "@happier-dev/protocol";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import {
    recordSocketAuthHandshake,
    recordSocketAuthHandshakeStageDuration,
    recordSocketAuthHandshakeException,
    recordSocketConnectConvergenceDuration,
    recordSocketConnectConvergencePhase,
    type SocketAuthHandshakeExceptionClassification,
    type SocketAuthHandshakeStage,
    recordSocketTransportUpgradeOutcome,
    setSocketAdapterModeInfo,
    trackWebSocketConnection,
    untrackWebSocketConnection,
    websocketEventsCounter,
} from "../monitoring/metrics/index";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { machineTransferHandler } from "./socket/machineTransferHandler";
import { machineLiveStreamRelayHandler } from "./socket/machineLiveStreamRelayHandler";
import { transferRelayV2Handler } from "./socket/transferRelayV2Handler";
import { registerPeerTcpTunnelRelaySocketHandler } from "./socket/peer/mediation/tunnel/registerRelay";
import { createPeerTcpTunnelRelayBridge } from "./socket/peer/mediation/tunnel/relayBridge";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { createServerRpcForwarder } from "./socket/serverRpcForwarder";
import { getSocketRooms, type SocketClientType } from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { getRedisClient } from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { readSocketAdapterRuntimeConfigFromEnv } from "@/config/socketAdapter";
import { db, isPrismaErrorCode } from "@/storage/db";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readMachineLiveStreamFeatureEnv, readMachineTransferFeatureEnv, readMachineTunnelFeatureEnv, readPeerMediationFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveSessionScopedSocketBinding } from "./socket/sessionScopedBinding";
import { createMachineSocketOwnershipRegistry } from "./socket/machineSocketOwnershipRegistry";
import { activityCache } from "@/app/presence/sessionCache";
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";

export const DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE = 25_000_000;

export function resolveSocketMaxHttpBufferSizeFromEnv(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE ?? env.HAPPY_SOCKET_MAX_HTTP_BUFFER_SIZE ?? '').trim();
    if (!raw) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    return parsed;
}

export const DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS = 1_000;

export function resolveSocketFastDisconnectLogThresholdMsFromEnv(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS ?? env.HAPPY_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS ?? '').trim();
    if (!raw) return DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS;
    return parsed;
}

export function normalizeSocketHandshakeClientType(clientType: unknown): SocketClientType {
    if (
        clientType === 'user-scoped' ||
        clientType === 'session-scoped' ||
        clientType === 'machine-scoped'
    ) {
        return clientType;
    }
    return 'user-scoped';
}

function classifySocketHandshakeException(error: unknown): SocketAuthHandshakeExceptionClassification {
    if (isPrismaErrorCode(error, "P2037")) return "prisma-p2037";
    if (isPrismaErrorCode(error, "P2028")) return "prisma-p2028";
    if (isPrismaErrorCode(error, "P2024")) return "prisma-p2024";
    if (isPrismaErrorCode(error, "P1008")) return "prisma-p1008";
    if (isPrismaErrorCode(error, "P1001")) return "prisma-p1001";
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("Response from the Engine was empty")) {
        return "prisma-engine-empty-response";
    }
    if (typeof error === "object" && error !== null && "code" in error) {
        return "prisma-unknown";
    }
    return "unknown";
}

export function startSocket(app: Fastify) {
    const socketAdapterConfig = readSocketAdapterRuntimeConfigFromEnv(process.env, "memory");
    const socketAdapter = socketAdapterConfig.adapter;
    const shouldEnableRedisAdapter = socketAdapterConfig.redisStreamsEnabled;
    const serverRoutedTransferEnabled = isServerFeatureEnabledForRequest(
        'machines.transfer.serverRouted',
        process.env,
    );
    const serverRoutedLiveStreamEnabled = isServerFeatureEnabledForRequest(
        'machines.liveStream.serverRouted',
        process.env,
    );
    const serverRoutedTunnelEnabled = isServerFeatureEnabledForRequest(
        'machines.tunnel.serverRouted',
        process.env,
    );
    const machineTransferFeatureEnv = readMachineTransferFeatureEnv(process.env);
    const machineLiveStreamFeatureEnv = readMachineLiveStreamFeatureEnv(process.env);
    const machineTunnelFeatureEnv = readMachineTunnelFeatureEnv(process.env);
    const peerMediationFeatureEnv = readPeerMediationFeatureEnv(process.env);
    const fastDisconnectLogThresholdMs = resolveSocketFastDisconnectLogThresholdMsFromEnv(process.env);

    const instanceId = process.env.HAPPIER_INSTANCE_ID?.trim() || process.env.HAPPY_INSTANCE_ID?.trim() || randomUUID();
    const roleToken = process.env.SERVER_ROLE?.trim();
    const role = roleToken === "api" || roleToken === "worker" ? roleToken : "all";

    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            // We authenticate via token in the Socket.IO handshake, not cookies.
            credentials: false,
            allowedHeaders: ["authorization", "content-type"]
        },
        ...(shouldEnableRedisAdapter ? { adapter: createAdapter(getRedisClient(), socketAdapterConfig.redisStreamsOptions) } : {}),
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        maxHttpBufferSize: resolveSocketMaxHttpBufferSizeFromEnv(process.env),
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false // Don't serve the client files
    });

    setSocketAdapterModeInfo({
        adapter: socketAdapter,
        redisEnabled: shouldEnableRedisAdapter,
        role,
    });

    function rejectSocket(params: { statusCode: number; error: string; provider?: string; data?: Record<string, unknown> }) {
        const err: any = new Error(params.error);
        err.data = {
            error: params.error,
            statusCode: params.statusCode,
            ...(params.provider ? { provider: params.provider } : {}),
            ...(params.data ?? {}),
        };
        return err;
    }

    const machineOwnershipRegistry = createMachineSocketOwnershipRegistry({
        io,
        config: shouldEnableRedisAdapter ? { enabled: true, instanceId } : { enabled: false },
    });
    app.forwardRpcForUser = createServerRpcForwarder({
        io,
    });
    eventRouter.setIo(io);
    const tunnelRelayBridge = createPeerTcpTunnelRelayBridge(io);
    const tunnelRelayAuthorizationTrustRoots = peerMediationFeatureEnv.grantSigningKeys.map((key) => ({
        keyId: key.keyId,
        publicKeyBase64Url: key.publicKey,
    }));
    const tunnelRelayHandlerOptions = {
        io: tunnelRelayBridge.io,
        relayAuthorizationTrustRoots: tunnelRelayAuthorizationTrustRoots,
        serverRoutedEnabled: serverRoutedTunnelEnabled,
        maxBytes: machineTunnelFeatureEnv.serverRoutedMaxBytes,
        maxActiveTunnelsPerSocket: machineTunnelFeatureEnv.serverRoutedMaxActiveTunnelsPerSocket,
        maxFrameBytes: machineTunnelFeatureEnv.serverRoutedMaxFrameBytes,
        supportedEncodings: machineTunnelFeatureEnv.serverRoutedSupportedEncodings,
        preferredEncoding: machineTunnelFeatureEnv.serverRoutedPreferredEncoding,
        allowV1Fallback: machineTunnelFeatureEnv.serverRoutedAllowV1Fallback,
        maxBinaryHeaderBytes: machineTunnelFeatureEnv.serverRoutedMaxBinaryHeaderBytes,
        maxRawPayloadBytes: machineTunnelFeatureEnv.serverRoutedMaxRawPayloadBytes,
        maxFramedMessageBytes: machineTunnelFeatureEnv.serverRoutedMaxFramedMessageBytes,
        substreams: machineTunnelFeatureEnv.serverRoutedSubstreams,
        maxIdleMs: machineTunnelFeatureEnv.maxIdleMs,
        maxDurationMs: machineTunnelFeatureEnv.maxDurationMs,
        allowedPorts: machineTunnelFeatureEnv.allowedPorts,
    } as const;
    app.createPeerTcpTunnelRelayTransport = ({ accountId }) => {
        const transport = tunnelRelayBridge.createTransport({ accountId });
        let relayHandler: ((payload?: unknown) => void | Promise<void>) | null = null;
        let disconnectHandler: (() => void | Promise<void>) | null = null;
        registerPeerTcpTunnelRelaySocketHandler(accountId, {
            data: { clientType: "user-scoped" },
            on: (event, handler) => {
                if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) {
                    relayHandler = handler;
                } else if (event === "disconnect") {
                    disconnectHandler = handler as () => void | Promise<void>;
                }
            },
            emit: () => undefined,
        }, tunnelRelayHandlerOptions);

        return {
            send: (event, envelope: PeerTcpTunnelRelayEnvelope) => {
                if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT && relayHandler) {
                    void relayHandler(envelope);
                    return;
                }
                transport.send(event, envelope);
            },
            subscribe: transport.subscribe,
            close: () => {
                void disconnectHandler?.();
                transport.close();
            },
        };
    };

    io.use(async (socket, next) => {
        const handshakeStartedAt = Date.now();
        const token = socket.handshake.auth.token as string;
        const clientType = normalizeSocketHandshakeClientType(socket.handshake.auth.clientType);
        const clientPurpose = socket.handshake.auth.clientPurpose as string | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;
        let handshakeStage: SocketAuthHandshakeStage = "verify-token";
        let handshakeStageStartedAt = handshakeStartedAt;
        const takeoverRequested =
            socket.handshake.auth.takeover === true ||
            socket.handshake.auth.takeover === "true";
        const handshakeTransport = (socket.conn as unknown as { transport?: { name?: string } } | undefined)?.transport?.name;

        const setHandshakeStage = (stage: SocketAuthHandshakeStage) => {
            handshakeStage = stage;
            handshakeStageStartedAt = Date.now();
        };

        const observeHandshakeStage = (result: "ok" | "error") => {
            recordSocketAuthHandshakeStageDuration({
                clientType,
                transport: handshakeTransport,
                stage: handshakeStage,
                durationMs: Date.now() - handshakeStageStartedAt,
                result,
            });
        };

        const rejectHandshake = (params: { statusCode: number; error: string; provider?: string; data?: Record<string, unknown> }) => {
            recordSocketAuthHandshake({
                clientType,
                transport: handshakeTransport,
                durationMs: Date.now() - handshakeStartedAt,
                result: "error",
                failure: params.error,
            });
            return next(rejectSocket(params));
        };

        if (!token) {
            return rejectHandshake({ statusCode: 401, error: 'invalid-token' });
        }

        if (clientType === 'session-scoped' && !sessionId) {
            return rejectHandshake({ statusCode: 400, error: 'missing-session-id' });
        }

        if (clientType === 'machine-scoped' && !machineId) {
            return rejectHandshake({ statusCode: 400, error: 'missing-machine-id' });
        }
        try {
            setHandshakeStage("verify-token");
            const verified = await auth.verifyToken(token);
            if (!verified) {
                observeHandshakeStage("error");
                return rejectHandshake({ statusCode: 401, error: 'invalid-token' });
            }
            observeHandshakeStage("ok");

            setHandshakeStage("login-eligibility");
            const eligibility = await enforceLoginEligibility({ accountId: verified.userId, env: process.env });
            if (!eligibility.ok) {
                observeHandshakeStage("error");
                return rejectHandshake({
                    statusCode: eligibility.statusCode,
                    error: eligibility.error,
                    ...(eligibility.error === 'provider-required' ? { provider: eligibility.provider } : {}),
                });
            }
            observeHandshakeStage("ok");

            if (clientType === 'machine-scoped') {
                setHandshakeStage("machine-lookup");
                const machine = await db.machine.findFirst({
                    where: { accountId: verified.userId, id: machineId },
                    select: { id: true, active: true, lastActiveAt: true, revokedAt: true, replacedByMachineId: true },
                });
                if (!machine) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 403, error: 'invalid-machine' });
                }
                if (machine.revokedAt || machine.replacedByMachineId) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 403, error: 'invalid-machine' });
                }
                observeHandshakeStage("ok");

                setHandshakeStage("machine-ownership");
                const ownershipClaim = await machineOwnershipRegistry.claimOwner({
                    accountId: verified.userId,
                    machineId: machineId!,
                    socketId: socket.id,
                    owner: {
                        ...readMachineDaemonOwnershipMetadataFromSocketAuth(socket.handshake.auth),
                        takeoverRequested,
                    },
                });
                if (ownershipClaim.result === 'conflict') {
                    observeHandshakeStage("error");
                    const { socketId: _socketId, ...owner } = ownershipClaim.owner;
                    return rejectHandshake({
                        statusCode: 409,
                        error: 'machine-owner-conflict',
                        data: buildMachineOwnerConflictSocketPayload(readMachineDaemonOwnershipMetadataFromSocketAuth(owner)),
                    });
                }
                observeHandshakeStage("ok");

                activityCache.seedMachineValidity({
                    machineId: machine.id,
                    userId: verified.userId,
                    active: machine.active,
                    lastActiveAt: machine.lastActiveAt,
                });
            }

            if (clientType === 'session-scoped' && sessionId) {
                setHandshakeStage("session-binding");
                const binding = await resolveSessionScopedSocketBinding({
                    userId: verified.userId,
                    sessionId,
                    machineId,
                });
                if (!binding.ok) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: binding.statusCode, error: binding.error });
                }
                observeHandshakeStage("ok");

                activityCache.seedSessionValidity({
                    sessionId: binding.binding.sessionId,
                    userId: verified.userId,
                    active: binding.cacheWarmState.session.active,
                    lastActiveAt: binding.cacheWarmState.session.lastActiveAt,
                });
                if (binding.cacheWarmState.machine && binding.binding.machineId) {
                    activityCache.seedMachineValidity({
                        machineId: binding.binding.machineId,
                        userId: verified.userId,
                        active: binding.cacheWarmState.machine.active,
                        lastActiveAt: binding.cacheWarmState.machine.lastActiveAt,
                    });
                }
                (socket.data as any).sessionScopedBinding = binding.binding;
            }

            (socket.data as any).userId = verified.userId;
            (socket.data as any).clientType = clientType;
            (socket.data as any).clientPurpose = clientPurpose;
            (socket.data as any).sessionId = sessionId;
            (socket.data as any).machineId = machineId;
            recordSocketAuthHandshake({
                clientType,
                transport: handshakeTransport,
                durationMs: Date.now() - handshakeStartedAt,
                result: "ok",
            });
            return next();
        } catch (error) {
            observeHandshakeStage("error");
            const classification = classifySocketHandshakeException(error);
            recordSocketAuthHandshakeException({
                clientType,
                transport: handshakeTransport,
                stage: handshakeStage,
                classification,
            });
            log(
                {
                    module: "websocket-auth-handshake",
                    socketId: socket.id,
                    clientType,
                    handshakeStage,
                    classification,
                    sessionId,
                    machineId,
                    err: error,
                },
                "Socket authentication handshake failed unexpectedly",
            );
            return rejectHandshake({ statusCode: 503, error: "upstream_error" });
        }
    });

    io.on("connection", async (socket) => {
        const connectedAtMs = Date.now();
        const remoteAddress = socket.handshake.address;
        const remotePort =
            typeof (socket.conn as unknown as { remotePort?: unknown } | undefined)?.remotePort === 'number'
                ? (socket.conn as unknown as { remotePort: number }).remotePort
                : undefined;
        const userAgent =
            typeof socket.handshake.headers['user-agent'] === 'string'
                ? socket.handshake.headers['user-agent']
                : undefined;
        const transport = (socket.conn as unknown as { transport?: { name?: string } } | undefined)?.transport?.name;
        const remoteLabel = `${remoteAddress ?? 'unknown'}${typeof remotePort === 'number' ? `:${remotePort}` : ''}`;
        const userAgentLabel = userAgent ? userAgent.slice(0, 160) : 'unknown';

        log(
            { module: 'websocket', socketId: socket.id, remoteAddress, userAgent, transport },
            `New connection attempt from socket: ${socket.id} (remote=${remoteLabel}, transport=${transport ?? 'unknown'}, ua=${userAgentLabel})`,
        );
        const userId = (socket.data as any).userId as string | undefined;
        const clientType = normalizeSocketHandshakeClientType((socket.data as any).clientType);
        const clientPurpose = (socket.data as any).clientPurpose as string | undefined;
        const sessionId =
            (socket.data as any).sessionScopedBinding?.sessionId as string | undefined
            ?? (socket.data as any).sessionId as string | undefined;
        const machineId = (socket.data as any).machineId as string | undefined;
        let connectConvergenceFinished = false;
        let connectReady = false;

        const finalizeConnectConvergence = (result: "ready" | "disconnect_before_ready") => {
            if (connectConvergenceFinished) {
                return;
            }
            connectConvergenceFinished = true;
            recordSocketConnectConvergencePhase({
                clientType,
                transport,
                phase: result === "ready" ? "complete" : "disconnect_before_ready",
            });
            recordSocketConnectConvergenceDuration({
                clientType,
                transport,
                result,
                durationMs: Date.now() - connectedAtMs,
            });
        };

        recordSocketConnectConvergencePhase({
            clientType,
            transport,
            phase: "start",
        });

        if (!userId) {
            finalizeConnectConvergence("disconnect_before_ready");
            socket.disconnect();
            return;
        }

        log(
            {
                module: 'websocket',
                socketId: socket.id,
                userId,
                clientType,
                clientPurpose: clientPurpose || 'unknown',
                sessionId: sessionId || 'none',
                machineId: machineId || 'none',
                remoteAddress,
                userAgent,
                transport,
            },
            `Token verified: ${userId}, clientType: ${clientType}, purpose: ${clientPurpose || 'unknown'}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id} (remote=${remoteLabel}, transport=${transport ?? 'unknown'}, ua=${userAgentLabel})`,
        );

        // Store connection based on type
        const metadata = { clientType, clientPurpose: clientPurpose || 'unknown', sessionId, machineId };
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId
            };
        }
        eventRouter.addConnection(userId, connection);
        trackWebSocketConnection({
            socketId: socket.id,
            userId,
            clientType: connection.connectionType,
            sessionId,
            machineId,
            transport,
        });

        socket.on('disconnect', (reason) => {
            websocketEventsCounter.inc({ event_type: 'disconnect' });

            if (!connectReady) {
                finalizeConnectConvergence("disconnect_before_ready");
            }

            if (connection.connectionType === 'machine-scoped') {
                void machineOwnershipRegistry.releaseOwner({
                    accountId: userId,
                    machineId: connection.machineId,
                    socketId: socket.id,
                });
            }

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            untrackWebSocketConnection({
                socketId: socket.id,
                reason: String(reason),
            });

            const durationMs = Math.max(0, Date.now() - connectedAtMs);
            const isFastDisconnect = fastDisconnectLogThresholdMs > 0 && durationMs <= fastDisconnectLogThresholdMs;

            log(
                {
                    module: 'websocket',
                    socketId: socket.id,
                    userId,
                    clientType: metadata.clientType,
                    clientPurpose: metadata.clientPurpose,
                    sessionId: sessionId || 'none',
                    machineId: machineId || 'none',
                    reason,
                    durationMs,
                    ...(isFastDisconnect ? { remoteAddress, userAgent, transport } : null),
                },
                isFastDisconnect
                    ? `User disconnected: ${userId} (reason=${String(reason)}, durationMs=${durationMs}, socketId=${socket.id}, clientType=${metadata.clientType}, purpose=${metadata.clientPurpose}, remote=${remoteLabel}, transport=${transport ?? 'unknown'}, ua=${userAgentLabel})`
                    : `User disconnected: ${userId} (reason=${String(reason)}, durationMs=${durationMs}, socketId=${socket.id}, clientType=${metadata.clientType}, purpose=${metadata.clientPurpose})`,
            );

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        if (transport === "polling") {
            (socket.conn as unknown as { on?: (event: string, listener: (...args: any[]) => void) => void } | undefined)?.on?.(
                "upgrade",
                (upgradedTransport: { name?: string } | undefined) => {
                    recordSocketTransportUpgradeOutcome({
                        socketId: socket.id,
                        fromTransport: "polling",
                        toTransport: upgradedTransport?.name,
                        result: "success",
                    });
                },
            );
        }

        // Join the canonical Socket.IO rooms used for multi-replica fanout and RPC routing.
        await socket.join(getSocketRooms({
            userId,
            clientType: metadata.clientType,
            sessionId,
            machineId,
        }));

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
                });
        }

        // Handlers
        rpcHandler(userId, socket, {
            io,
        });
        usageHandler(userId, socket);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        machineTransferHandler(userId, socket, {
            io,
            serverRoutedTransferEnabled,
            serverRoutedTransferMaxBytes: machineTransferFeatureEnv.serverRoutedMaxBytes,
            serverRoutedTransferMaxActiveTransfersPerSocket: machineTransferFeatureEnv.serverRoutedMaxActiveTransfersPerSocket,
        });
        machineLiveStreamRelayHandler(userId, socket, {
            io,
            serverRoutedLiveStreamEnabled,
            relayCaps: machineLiveStreamFeatureEnv.serverRoutedCaps,
            relayAuthorizationTrustRoots: tunnelRelayAuthorizationTrustRoots,
        });
        transferRelayV2Handler(userId, socket, {
            io,
            serverRelayTransferEnabled: serverRoutedTransferEnabled,
            serverRelayTransferMaxBytes: machineTransferFeatureEnv.serverRoutedMaxBytes,
            serverRelayTransferMaxActiveTransfersPerSocket: machineTransferFeatureEnv.serverRoutedMaxActiveTransfersPerSocket,
        });
        registerPeerTcpTunnelRelaySocketHandler(userId, socket, {
            ...tunnelRelayHandlerOptions,
        });
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
        connectReady = true;
        finalizeConnectConvergence("ready");
        log(
            {
                module: 'websocket',
                socketId: socket.id,
                userId,
                clientType: metadata.clientType,
                clientPurpose: metadata.clientPurpose,
                sessionId: sessionId || 'none',
                machineId: machineId || 'none',
                remoteAddress,
                userAgent,
                transport,
            },
            `User connected: ${userId} (socketId=${socket.id}, clientType=${metadata.clientType}, purpose=${metadata.clientPurpose}, remote=${remoteLabel}, transport=${transport ?? 'unknown'}, ua=${userAgentLabel})`,
        );
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
