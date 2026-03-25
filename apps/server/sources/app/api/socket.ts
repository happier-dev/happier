import { onShutdown } from "@/utils/process/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import { decrementWebSocketConnection, incrementWebSocketConnection, websocketEventsCounter } from "../monitoring/metrics2";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { machineTransferHandler } from "./socket/machineTransferHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { createServerRpcForwarder } from "./socket/serverRpcForwarder";
import { getSocketRooms } from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { getRedisClient } from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { getSocketAdapterFromEnv, isRedisStreamsEnabled } from "@/config/backends";
import { db } from "@/storage/db";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readMachineTransferFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveSessionScopedSocketBinding } from "./socket/sessionScopedBinding";

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

export function startSocket(app: Fastify) {
    const socketAdapter = getSocketAdapterFromEnv(process.env, "memory");
    const shouldEnableRedisAdapter = isRedisStreamsEnabled(process.env, socketAdapter);
    const serverRoutedTransferEnabled = isServerFeatureEnabledForRequest(
        'machines.transfer.serverRouted',
        process.env,
    );
    const machineTransferFeatureEnv = readMachineTransferFeatureEnv(process.env);
    const fastDisconnectLogThresholdMs = resolveSocketFastDisconnectLogThresholdMsFromEnv(process.env);

    const instanceId = process.env.HAPPIER_INSTANCE_ID?.trim() || process.env.HAPPY_INSTANCE_ID?.trim() || randomUUID();

    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            // We authenticate via token in the Socket.IO handshake, not cookies.
            credentials: false,
            allowedHeaders: ["authorization", "content-type"]
        },
        ...(shouldEnableRedisAdapter ? { adapter: createAdapter(getRedisClient()) } : {}),
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

    function rejectSocket(params: { statusCode: number; error: string; provider?: string }) {
        const err: any = new Error(params.error);
        err.data = {
            error: params.error,
            statusCode: params.statusCode,
            ...(params.provider ? { provider: params.provider } : {}),
        };
        return err;
    }

    let rpcListeners = new Map<string, Map<string, Socket>>();
    app.forwardRpcForUser = createServerRpcForwarder({
        io,
        allRpcListeners: rpcListeners,
        redisRegistry: shouldEnableRedisAdapter ? { enabled: true, instanceId } : { enabled: false },
    });
    eventRouter.setIo(io);

    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const clientPurpose = socket.handshake.auth.clientPurpose as string | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            return next(rejectSocket({ statusCode: 401, error: 'invalid-token' }));
        }

        if (clientType === 'session-scoped' && !sessionId) {
            return next(rejectSocket({ statusCode: 400, error: 'missing-session-id' }));
        }

        if (clientType === 'machine-scoped' && !machineId) {
            return next(rejectSocket({ statusCode: 400, error: 'missing-machine-id' }));
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            return next(rejectSocket({ statusCode: 401, error: 'invalid-token' }));
        }

        const eligibility = await enforceLoginEligibility({ accountId: verified.userId, env: process.env });
        if (!eligibility.ok) {
            return next(rejectSocket({
                statusCode: eligibility.statusCode,
                error: eligibility.error,
                ...(eligibility.error === 'provider-required' ? { provider: eligibility.provider } : {}),
            }));
        }

        if (clientType === 'machine-scoped') {
            const machine = await db.machine.findFirst({
                where: { accountId: verified.userId, id: machineId },
                select: { id: true },
            });
            if (!machine) {
                return next(rejectSocket({ statusCode: 403, error: 'invalid-machine' }));
            }
        }

        if (clientType === 'session-scoped' && sessionId) {
            const binding = await resolveSessionScopedSocketBinding({
                userId: verified.userId,
                sessionId,
                machineId,
            });
            if (!binding.ok) {
                return next(rejectSocket({ statusCode: binding.statusCode, error: binding.error }));
            }
            (socket.data as any).sessionScopedBinding = binding.binding;
        }

        (socket.data as any).userId = verified.userId;
        (socket.data as any).clientType = clientType;
        (socket.data as any).clientPurpose = clientPurpose;
        (socket.data as any).sessionId = sessionId;
        (socket.data as any).machineId = machineId;
        return next();
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
        const clientType = (socket.data as any).clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const clientPurpose = (socket.data as any).clientPurpose as string | undefined;
        const sessionId =
            (socket.data as any).sessionScopedBinding?.sessionId as string | undefined
            ?? (socket.data as any).sessionId as string | undefined;
        const machineId = (socket.data as any).machineId as string | undefined;

        if (!userId) {
            socket.disconnect();
            return;
        }

        log(
            {
                module: 'websocket',
                socketId: socket.id,
                userId,
                clientType: clientType || 'user-scoped',
                clientPurpose: clientPurpose || 'unknown',
                sessionId: sessionId || 'none',
                machineId: machineId || 'none',
                remoteAddress,
                userAgent,
                transport,
            },
            `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, purpose: ${clientPurpose || 'unknown'}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id} (remote=${remoteLabel}, transport=${transport ?? 'unknown'}, ua=${userAgentLabel})`,
        );

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', clientPurpose: clientPurpose || 'unknown', sessionId, machineId };
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
        incrementWebSocketConnection(connection.connectionType);

        // Join Socket.IO rooms for multi-process fanout (Phase 5).
        // Note: we keep the existing in-memory routing for now; rooms are a forward-compat hook.
        socket.join(getSocketRooms({
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

        socket.on('disconnect', (reason) => {
            websocketEventsCounter.inc({ event_type: 'disconnect' });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            decrementWebSocketConnection(connection.connectionType);

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

        // Handlers
        let userRpcListeners = rpcListeners.get(userId);
        if (!userRpcListeners) {
            userRpcListeners = new Map<string, Socket>();
            rpcListeners.set(userId, userRpcListeners);
        }
        rpcHandler(userId, socket, userRpcListeners, rpcListeners, {
            io,
            // Cluster-aware RPC routing only works when a shared Socket.IO adapter is enabled.
            redisRegistry: shouldEnableRedisAdapter ? { enabled: true, instanceId } : { enabled: false },
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
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
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
