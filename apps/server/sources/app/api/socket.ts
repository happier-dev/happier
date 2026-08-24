import { onShutdown } from "@/utils/process/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import {
    buildMachineOwnerConflictSocketPayload,
    readMachineDaemonOwnershipMetadataFromSocketAuth,
} from "@happier-dev/protocol";
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
import { registerReleasedUiV021SessionEndSocketEvent } from "@/app/session/compatibility/registerReleasedUiV021SessionEndSocketEvent";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { machineTransferHandler } from "./socket/machineTransferHandler";
import { machineLiveStreamRelayHandler } from "./socket/machineLiveStreamRelayHandler";
import { externalSessionStatusDemandHandler } from "./socket/externalSessionStatusDemandHandler";
import { transferRelayV2Handler } from "./socket/transferRelayV2Handler";
import { registerPeerTcpTunnelRelaySocketHandler } from "./socket/peer/mediation/tunnel/registerRelay";
import { createPeerTcpTunnelRelayBridge } from "./socket/peer/mediation/tunnel/relayBridge";
import { createPeerTcpTunnelRelayCoordinator } from "./socket/peer/mediation/tunnel/relayCoordinator";
import { createPeerMediationObservabilityStore } from "./socket/peer/mediation/observability/store";
import {
    registerPeerMediationObservabilitySocketRoutes,
    type PeerMediationObservabilityPrincipal,
} from "./socket/peer/mediation/observability/routes";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { createServerRpcForwarder } from "./socket/serverRpcForwarder";
import { createAutomationReplyHandoffDaemonDispatcher } from "./socket/automationReplyHandoffDispatcher";
import { createExternalActionDaemonDispatcher } from "./socket/externalActionDispatcher";
import {
    createSessionServerStartAutomationIngress,
    createSessionServerStartDaemonDispatcher,
} from "./socket/sessionServerStartDispatcher";
import { resolveVerifiedMachineSocketInstallationId } from "./socket/machineSocketInstallationProof";
import { getSocketRooms, type SocketClientType } from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import {
    closeRedisSocketClusterClient,
    getRedisSocketClusterClient,
} from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { readSocketAdapterRuntimeConfigFromEnv } from "@/config/socketAdapter";
import { db, isPrismaErrorCode } from "@/storage/db";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readMachineLiveStreamFeatureEnv, readMachineTransferFeatureEnv, readMachineTunnelFeatureEnv, readPeerMediationFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveFeaturesFromEnv } from "@/app/features/registry";
import { readSessionScopedSocketBinding, resolveSessionScopedSocketBinding } from "./socket/sessionScopedBinding";
import { createMachineSocketOwnershipRegistry } from "./socket/machineSocketOwnershipRegistry";
import { createPeerMediationViewerSocketOwnershipVerifier } from "./socket/viewerSocketOwnership";
import { activityCache } from "@/app/presence/sessionCache";
import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1,
    resolveExternalSessionOperationSocketBatchLimitsV1,
    type ExternalSessionOperationSocketBatchLimitResolutionV1,
    type PeerMediationObservabilityEventV1,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    evaluateAccountStoredContentSocketCompatibility,
    readAccountStoredContentCompatibilityForSocket,
    writeAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";

export const DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE = 25_000_000;
// Socket.IO adds its event name, acknowledgement id, and packet framing around the
// serialized command. Keep that reserve beside the one live transport ceiling.
export const EXTERNAL_SESSION_OPERATION_SOCKET_ENVELOPE_RESERVE_BYTES = 64 * 1024;
export const EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_SERIALIZED_BYTES = 512 * 1024;

export function resolveSocketMaxHttpBufferSizeFromEnv(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE ?? env.HAPPY_SOCKET_MAX_HTTP_BUFFER_SIZE ?? '').trim();
    if (!raw) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    return parsed;
}

export function resolveExternalSessionOperationSocketBatchLimitsForMaxHttpBufferSize(
    socketMaxHttpBufferSize: number,
): ExternalSessionOperationSocketBatchLimitResolutionV1 {
    return resolveExternalSessionOperationSocketBatchLimitsV1({
        socketMaxSerializedBytes: socketMaxHttpBufferSize,
        envelopeOverheadBytes: EXTERNAL_SESSION_OPERATION_SOCKET_ENVELOPE_RESERVE_BYTES,
        configuredMaxSerializedBytes: EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_SERIALIZED_BYTES,
        configuredMaxItems: EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1,
    });
}

export const DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS = 1_000;

export function resolveSocketFastDisconnectLogThresholdMsFromEnv(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS ?? env.HAPPY_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS ?? '').trim();
    if (!raw) return DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS;
    return parsed;
}

export const DEFAULT_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS = 10_000;

export function resolveSocketPlannedRestartRetryAfterMsFromEnv(env: Record<string, string | undefined>): number {
    const raw = (
        env.HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS
        ?? env.HAPPY_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS
        ?? ''
    ).trim();
    if (!raw) return DEFAULT_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS;
    return parsed;
}

export function emitSocketPlannedRestart(
    io: Readonly<{ emit: (event: string, payload: { retryAfterMs: number }) => unknown }>,
    retryAfterMs: number,
): void {
    const normalizedRetryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.trunc(retryAfterMs)
        : DEFAULT_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS;
    io.emit('server:restarting', { retryAfterMs: normalizedRetryAfterMs });
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

function resolvePeerMediationObservabilityPrincipal(input: Readonly<{
    userId: string;
    clientType: SocketClientType;
    sessionId?: string;
    machineId?: string;
}>): PeerMediationObservabilityPrincipal {
    if (input.clientType === "machine-scoped" && input.machineId) {
        return { kind: "machineOwner", accountId: input.userId, machineId: input.machineId };
    }
    if (input.clientType === "session-scoped" && input.sessionId) {
        return { kind: "sessionOwner", accountId: input.userId, sessionId: input.sessionId };
    }
    return { kind: "accountOwner", accountId: input.userId };
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
    const sessionPublisherPresence = createSessionPublisherPresence();
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
    const plannedRestartRetryAfterMs = resolveSocketPlannedRestartRetryAfterMsFromEnv(process.env);
    const socketMaxHttpBufferSize = resolveSocketMaxHttpBufferSizeFromEnv(process.env);
    const externalSessionOperationSocketBatchLimits =
        resolveExternalSessionOperationSocketBatchLimitsForMaxHttpBufferSize(socketMaxHttpBufferSize);

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
        ...(shouldEnableRedisAdapter ? {
            adapter: createAdapter(getRedisSocketClusterClient(), socketAdapterConfig.redisStreamsOptions),
        } : {}),
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        maxHttpBufferSize: socketMaxHttpBufferSize,
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false // Don't serve the client files
    });

    app.disconnectAccountSockets = (accountId: string): void => {
        // `user:` contains user- and session-scoped sockets; machine daemons
        // deliberately live in the separate account machine room.
        io.in(`user:${accountId}`).disconnectSockets(true);
        io.in(`user-machines:${accountId}`).disconnectSockets(true);
    };

    setSocketAdapterModeInfo({
        adapter: socketAdapter,
        redisEnabled: shouldEnableRedisAdapter,
        role,
    });
    const tunnelRelayCoordinator = createPeerTcpTunnelRelayCoordinator({
        io,
        config: shouldEnableRedisAdapter
            ? { mode: "redis", redis: getRedisSocketClusterClient() }
            : { mode: "memory" },
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
    app.forwardAutomationReplyHandoffToMachine =
        createAutomationReplyHandoffDaemonDispatcher({ io });
    app.forwardExternalActionToMachine = createExternalActionDaemonDispatcher({
        io,
        sessionPublisherPresence,
    });
    app.forwardSessionServerStartToMachine =
        createSessionServerStartDaemonDispatcher({ io });
    const sessionServerStartAutomationIngress = createSessionServerStartAutomationIngress({
        forward: app.forwardSessionServerStartToMachine,
    });
    const verifyPeerMediationViewerSocketOwnership = createPeerMediationViewerSocketOwnershipVerifier(io);
    app.verifyPeerMediationViewerSocketOwnership = verifyPeerMediationViewerSocketOwnership;
    eventRouter.setIo(io);
    const tunnelRelayBridge = createPeerTcpTunnelRelayBridge(io);
    const peerMediationObservabilityStore = createPeerMediationObservabilityStore();
    const peerMediationObservabilityEmitter = {
        emit: (event: PeerMediationObservabilityEventV1): void => {
            peerMediationObservabilityStore.publish(event);
        },
    } as const;
    app.peerMediationObservability = peerMediationObservabilityEmitter;
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
        observability: peerMediationObservabilityEmitter,
        coordinator: tunnelRelayCoordinator,
    } as const;
    app.createPeerTcpTunnelRelayTransport = ({ accountId }) => {
        const transport = tunnelRelayBridge.createTransport({ accountId });
        let relayHandler: ((payload?: unknown) => void | Promise<void>) | null = null;
        let disconnectHandler: (() => void | Promise<void>) | null = null;
        registerPeerTcpTunnelRelaySocketHandler(accountId, {
            id: transport.relaySocketId,
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
            relaySocketId: transport.relaySocketId,
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
        let releaseMachineOwnershipIfClaimed: (() => Promise<void>) | null = null;
        try {
            setHandshakeStage("verify-token");
            const verified = await auth.verifyToken(token);
            if (!verified) {
                observeHandshakeStage("error");
                return rejectHandshake({ statusCode: 401, error: 'invalid-token' });
            }
            if (verified.authTokenKind === "api_token") {
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

            const accountStoredContentCompatibility =
                evaluateAccountStoredContentSocketCompatibility(
                    socket.handshake.auth,
                );
            writeAccountStoredContentCompatibilityForSocket(
                socket,
                accountStoredContentCompatibility,
            );
            let verifiedMachineInstallationId: string | null = null;
            let machineOwnershipClaimed = false;
            releaseMachineOwnershipIfClaimed = async (): Promise<void> => {
                if (!machineOwnershipClaimed || !machineId) return;
                machineOwnershipClaimed = false;
                await machineOwnershipRegistry.releaseOwner({
                    accountId: verified.userId,
                    machineId,
                    socketId: socket.id,
                });
            };
            if (clientType === 'machine-scoped') {
                setHandshakeStage("machine-lookup");
                const machine = await db.machine.findFirst({
                    where: { accountId: verified.userId, id: machineId },
                    select: {
                        id: true,
                        active: true,
                        lastActiveAt: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                        installationId: true,
                        installationPublicKey: true,
                    },
                });
                if (!machine) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 403, error: 'invalid-machine' });
                }
                if (machine.revokedAt || machine.replacedByMachineId) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 403, error: 'invalid-machine' });
                }
                verifiedMachineInstallationId = resolveVerifiedMachineSocketInstallationId({
                    accountId: verified.userId,
                    machineId: machine.id,
                    machine,
                    socketAuth: socket.handshake.auth,
                });
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
                machineOwnershipClaimed = true;
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
                socket.data.sessionScopedBinding = binding.binding;
            }

            socket.data.userId = verified.userId;
            socket.data.clientType = clientType;
            socket.data.clientPurpose = clientPurpose;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            if (verifiedMachineInstallationId) {
                socket.data.verifiedMachineInstallationId = verifiedMachineInstallationId;
            }

            recordSocketAuthHandshake({
                clientType,
                transport: handshakeTransport,
                durationMs: Date.now() - handshakeStartedAt,
                result: "ok",
            });
            return next();
        } catch (error) {
            if (releaseMachineOwnershipIfClaimed) {
                await releaseMachineOwnershipIfClaimed().catch(() => {});
            }
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
        const userId = socket.data.userId;
        const clientType = normalizeSocketHandshakeClientType(socket.data.clientType);
        const clientPurpose = socket.data.clientPurpose;
        const sessionId =
            socket.data.sessionScopedBinding?.sessionId
            ?? socket.data.sessionId;
        const machineId = socket.data.machineId;
        const token = socket.handshake.auth.token as string;
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

        // Join the canonical fanout rooms before the final currentness read.
        // Socket.IO adds this socket to the namespace before this callback, so
        // account-wide revocation can reach it while that read is in flight.
        const canonicalRoomJoin = socket.join(getSocketRooms({
            userId,
            clientType,
            sessionId,
            machineId,
            includeAccountStoredContentV3Room:
                readAccountStoredContentCompatibilityForSocket(socket).supportsPluginDataProtocol,
        }));

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

        const releasePostConnectMachineOwnership = async (): Promise<void> => {
            if (clientType !== "machine-scoped" || !machineId) return;
            await machineOwnershipRegistry.releaseOwner({
                accountId: userId,
                machineId,
                socketId: socket.id,
            });
        };

        const rejectPostConnectAdmission = async (): Promise<void> => {
            await releasePostConnectMachineOwnership().catch(() => {});
            finalizeConnectConvergence("disconnect_before_ready");
            socket.disconnect(true);
        };

        try {
            await canonicalRoomJoin;
            const currentVerified = await auth.verifyToken(token);
            if (
                !socket.connected
                || !currentVerified
                || currentVerified.authTokenKind === "api_token"
                || currentVerified.userId !== userId
            ) {
                await rejectPostConnectAdmission();
                return;
            }
        } catch (error) {
            await rejectPostConnectAdmission();
            log(
                {
                    module: "websocket-auth-admission",
                    socketId: socket.id,
                    clientType,
                    sessionId,
                    machineId,
                    err: error,
                },
                "Post-connect Socket authentication admission failed unexpectedly",
            );
            return;
        }

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

            if (connection.connectionType === "session-scoped") {
                void sessionPublisherPresence.forgetDisconnectedPublisher({ socket }).then(async (disconnected) => {
                    if (disconnected.status !== "applied") return;
                    const session = await loadSessionTranscriptPublicationRecipientProjection(connection.sessionId);
                    if (session) {
                        await Promise.all(disconnected.participantCursors.map(async ({ accountId, cursor }) => {
                            const projection = projectSessionTranscriptPublicationRealtimeProjection(
                                disconnected.projection,
                                session,
                                accountId,
                            );
                            if (projection.kind === "suppress") return;
                            eventRouter.emitUpdate({
                                userId: accountId,
                                payload: buildUpdateSessionUpdate(
                                    connection.sessionId,
                                    cursor,
                                    randomKeyNaked(12),
                                    undefined,
                                    undefined,
                                    projection.value,
                                ),
                                recipientFilter: { type: "all-interested-in-session", sessionId: connection.sessionId },
                            });
                        }));
                    }
                }).catch((error) => {
                    log({ module: "session-publisher-presence", sessionId: connection.sessionId, error }, "Failed to forget disconnected session publisher");
                });
            }

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

        // Room membership and the final currentness check completed before any
        // authority-bearing listener is installed. Register RPC immediately
        // afterward: machine clients replay their rpc-register burst from
        // their connect callback and Socket.IO does not replay delivered events.
        // Socket.IO does not buffer application events for listeners attached after delivery, and
        rpcHandler(userId, socket, {
            io,
            sessionPublisherPresence,
        });

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
        usageHandler(userId, socket, connection);
        const sessionBinding = connection.connectionType === "session-scoped"
            ? readSessionScopedSocketBinding(socket)
            : null;
        if (connection.connectionType === "user-scoped") {
            registerReleasedUiV021SessionEndSocketEvent({
                socket,
                accountId: userId,
                connection,
            });
        }
        sessionUpdateHandler(
            userId,
            socket,
            connection,
            sessionBinding?.proof === "machine-access-key" && sessionBinding.machineId
                ? {
                    presence: sessionPublisherPresence,
                    binding: {
                        accountId: userId,
                        machineId: sessionBinding.machineId,
                        sessionId: sessionBinding.sessionId,
                    },
                }
                : undefined,
        );
        pingHandler(socket);
        machineUpdateHandler(userId, socket, {
            operationSocketBatchLimits: externalSessionOperationSocketBatchLimits,
            sessionPublisherPresence,
            sessionServerStartIngress: sessionServerStartAutomationIngress,
        });
        externalSessionStatusDemandHandler(userId, socket, { io });
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
            verifyViewerSocketOwnership: verifyPeerMediationViewerSocketOwnership,
            observability: peerMediationObservabilityEmitter,
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
        registerPeerMediationObservabilitySocketRoutes(socket, {
            store: peerMediationObservabilityStore,
            featurePayload: () => resolveFeaturesFromEnv(process.env),
            principal: resolvePeerMediationObservabilityPrincipal({
                userId,
                clientType,
                ...(sessionId ? { sessionId } : {}),
                ...(machineId ? { machineId } : {}),
            }),
        });
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket, connection);

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

    onShutdown('api:socket', async () => {
        try {
            emitSocketPlannedRestart(io, plannedRestartRetryAfterMs);
        } catch (error) {
            log(
                { module: 'websocket', error },
                'Failed to broadcast planned socket restart before shutdown',
            );
        }
        await io.close();
        await tunnelRelayCoordinator.close();
        if (shouldEnableRedisAdapter) {
            closeRedisSocketClusterClient();
        }
    });
}
