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
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { getSocketRooms } from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { getRedisClient } from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { getSocketAdapterFromEnv, isRedisStreamsEnabled } from "@/config/backends";

export function startSocket(app: Fastify) {
    const socketAdapter = getSocketAdapterFromEnv(process.env, "memory");
    const shouldEnableRedisAdapter = isRedisStreamsEnabled(process.env, socketAdapter);

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
    eventRouter.setIo(io);

    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
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

        (socket.data as any).userId = verified.userId;
        (socket.data as any).clientType = clientType;
        (socket.data as any).sessionId = sessionId;
        (socket.data as any).machineId = machineId;
        return next();
    });

    io.on("connection", async (socket) => {
        log({ module: 'websocket' }, `New connection attempt from socket: ${socket.id}`);
        const userId = (socket.data as any).userId as string | undefined;
        const clientType = (socket.data as any).clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = (socket.data as any).sessionId as string | undefined;
        const machineId = (socket.data as any).machineId as string | undefined;

        if (!userId) {
            socket.disconnect();
            return;
        }

        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
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

        socket.on('disconnect', () => {
            websocketEventsCounter.inc({ event_type: 'disconnect' });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            decrementWebSocketConnection(connection.connectionType);

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

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
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
