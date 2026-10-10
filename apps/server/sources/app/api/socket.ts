import { onShutdown } from "@/utils/process/shutdown";
import { registerUiFocusSocketEvent } from '@/app/api/socket/registerUiFocusSocketEvent';
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT } from "@/app/events/socketRoomEmitter";
import {
    buildMachineOwnerConflictSocketPayload,
    readMachineDaemonOwnershipMetadataFromSocketAuth,
} from "@happier-dev/protocol";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import { narrowCredentialAuthority } from "@/app/auth/effectiveCredentialAuthority";
import { admitApiTokenSessionOperation, isRestrictedAuthTokenKind } from "@/app/api/utils/apiTokenRouteAdmission";
import { isApiTokenRequestOriginAllowed } from "./utils/isApiTokenRequestOriginAllowed";
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
import { createSessionHumanPresenceService } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { registerSessionHumanPresenceSocketHandlers, releaseSessionHumanPresenceHoldAfterFinalCurrentness } from "@/app/session/humanPresence/registerSessionHumanPresenceSocketHandlers";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { machineTransferHandler } from "./socket/machineTransferHandler";
import { machineLiveStreamRelayHandler } from "./socket/machineLiveStreamRelayHandler";
import { externalSessionStatusDemandHandler } from "./socket/externalSessionStatusDemandHandler";
import { transferRelayV2Handler } from "./socket/transferRelayV2Handler";
import { registerPeerTcpTunnelRelaySocketHandler } from "./socket/peer/mediation/tunnel/registerRelay";
import { createPeerTcpTunnelRelayBridge } from "./socket/peer/mediation/tunnel/relayBridge";
import { createPeerTcpTunnelRelayCoordinator } from "./socket/peer/mediation/tunnel/relayCoordinator";
import {
    createExternalProviderBrokerDispatcher,
    createTeamCredentialResourceTestBrokerDispatcher,
} from "./routes/providers/externalProviderBrokerDispatcher";
import { createPeerMediationObservabilityEmitter, createPeerMediationObservabilityStore } from "./socket/peer/mediation/observability/store";
import {
    registerPeerMediationObservabilitySocketRoutes,
    type PeerMediationObservabilityPrincipal,
} from "./socket/peer/mediation/observability/routes";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { createServerRpcForwarder } from "./socket/serverRpcForwarder";
import { createAutomationReplyHandoffDaemonDispatcher } from "./socket/automationReplyHandoffDispatcher";
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer, resolveCurrentSessionPublisherFromServer } from "./socket/externalActionDispatcher";
import {
    createSessionServerStartAutomationIngress,
    createSessionServerStartDaemonDispatcher,
} from "./socket/sessionServerStartDispatcher";
import { resolveVerifiedMachineSocketInstallationId } from "./socket/machineSocketInstallationProof";
import { installSessionPublisherCredentialCurrentness } from "./socket/socketCredentialCurrentness";
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import {
    getAccountRevocationSocketRoom,
    getApiTokenRevocationSocketRoom,
    getAccountTerminalSocketRoom,
    getMachineInstallationSocketRoom,
    getProtectedSocketRooms,
    type SocketClientType,
} from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import {
    closeRedisSocketClusterClient,
    createRedisSocketClusterRelayAdmissionClient,
    getRedisSocketClusterAdapterClient,
} from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { forwardRpcCall } from './socket/rpc/forwardRpcCall';
import { readSocketAdapterRuntimeConfigFromEnv } from "@/config/socketAdapter";
import { db, isPrismaErrorCode } from "@/storage/db";
import { readSharedQaSchemaMismatchDiagnostic } from '@/storage/prismaErrors';
import { isServerFeatureEnabledForHome, isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readMachineLiveStreamFeatureEnv, readMachineTransferFeatureEnv, readMachineTunnelFeatureEnv, readPeerMediationFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { readSessionScopedSocketBinding, resolveSessionScopedSocketBinding } from "./socket/sessionScopedBinding";
import {
    resolveRestrictedSocketAdmission,
    type RestrictedSocketAdmission,
} from "./socket/restrictedSocketAdmission";
import { createMachineSocketOwnershipRegistry } from "./socket/machineSocketOwnershipRegistry";
import { createPeerMediationViewerSocketOwnershipVerifier } from "./socket/viewerSocketOwnership";
import { activityCache } from "@/app/presence/sessionCache";
import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1,
    resolvePeerRouteFeatureId,
    resolveExternalSessionOperationSocketBatchLimitsV1,
    type ExternalSessionOperationSocketBatchLimitResolutionV1,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { createExecutionRunBrokerCurrentnessResolver } from "@/app/teams/credentials/executionRunBrokerAuthorityResolver";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
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

import { resolveSocketMaxHttpBufferSizeFromEnv } from './socket/transportBudget';
export { DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE, resolveSocketMaxHttpBufferSizeFromEnv } from './socket/transportBudget';
// Socket.IO adds its event name, acknowledgement id, and packet framing around the
// serialized command. Keep that reserve beside the one live transport ceiling.
export const EXTERNAL_SESSION_OPERATION_SOCKET_ENVELOPE_RESERVE_BYTES = 64 * 1024;
export const EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_SERIALIZED_BYTES = 512 * 1024;

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

export function scheduleApiTokenSocketExpiry(socket: Pick<Socket, "once" | "disconnect">, expiresAt: Date): void {
    const expiresAtMs = expiresAt.getTime();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = (): void => {
        const remaining = expiresAtMs - Date.now();
        if (remaining <= 0) { socket.disconnect(true); return; }
        // The platform timer range is not a credential lifetime limit.
        expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    socket.once("disconnect", () => { if (expiryTimer) clearTimeout(expiryTimer); });
    expire();
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
    const serverRoutedTunnelRelayEnabledByFlowKind = {
        tcp_tunnel: isServerFeatureEnabledForRequest(
            resolvePeerRouteFeatureId({ flowKind: 'tcp_tunnel', routeKind: 'server_relay' }),
            process.env,
        ),
        voice_media: isServerFeatureEnabledForRequest(
            resolvePeerRouteFeatureId({ flowKind: 'voice_media', routeKind: 'server_relay' }),
            process.env,
        ),
        provider_broker: isServerFeatureEnabledForRequest(
            resolvePeerRouteFeatureId({ flowKind: 'provider_broker', routeKind: 'server_relay' }),
            process.env,
        ),
    } as const;
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
            // Adapter 0.3.1 duplicates the supplied client for its blocking
            // stream reader and its Pub/Sub subscriber. The adapter-facing
            // wrapper makes each of those a fresh, independently instrumented
            // connection while the adapter keeps owning their lifecycle.
            adapter: createAdapter(getRedisSocketClusterAdapterClient(), socketAdapterConfig.redisStreamsOptions),
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

    app.machineDaemonPresence = io;
    const resolveCurrentSessionMachine = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({
        ...input, io, presence: sessionPublisherPresence,
    });
    app.resolveCurrentSessionMachine = resolveCurrentSessionMachine;
    app.resolveCurrentSessionPublisher = input => resolveCurrentSessionPublisherFromServer({
        ...input, io, presence: sessionPublisherPresence,
    });
    const humanPresence = createSessionHumanPresenceService({
        io,
        clusterAccessChangePublicationEnabled: shouldEnableRedisAdapter,
    });
    if (typeof app.addHook === "function") {
        app.addHook("onClose", async () => { humanPresence.close(); });
    }

    app.disconnectAccountSockets = (accountId: string): void => {
        eventRouter.disconnectAccountSockets(accountId);
    };
    app.disconnectApiTokenSockets = tokenIds => eventRouter.disconnectApiTokenSockets(tokenIds);

    setSocketAdapterModeInfo({
        adapter: socketAdapter,
        redisEnabled: shouldEnableRedisAdapter,
        role,
    });
    const tunnelRelayCoordinator = createPeerTcpTunnelRelayCoordinator({
        io,
        config: shouldEnableRedisAdapter
            ? {
                mode: "redis",
                createRelayAdmissionRedis: createRedisSocketClusterRelayAdmissionClient,
            }
            : { mode: "memory" },
    });

    function rejectSocket(params: { statusCode: number; error: string; message?: string; provider?: string; data?: Record<string, unknown> }) {
        const err: Error & { data?: Record<string, unknown> } = new Error(params.message ?? params.error);
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
    const resolveExecutionRunCurrentness = createExecutionRunBrokerCurrentnessResolver({
        app,
        resolveServerIdentityId: () => getOrCreateServerIdentityId(process.env),
        createNonce: randomUUID,
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
    eventRouter.setIo(io, { forwardRpc: (request) => forwardRpcCall({ io, ...request }) });
    io.on(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, (delivery: unknown) => {
        void eventRouter.receiveCredentialQualifiedSessionDelivery(io.local, delivery);
    });
    const tunnelRelayBridge = createPeerTcpTunnelRelayBridge(io);
    const peerMediationObservabilityStore = createPeerMediationObservabilityStore();
    const peerMediationObservabilityEmitter = createPeerMediationObservabilityEmitter(peerMediationObservabilityStore);
    app.peerMediationObservability = peerMediationObservabilityEmitter;
    const tunnelRelayAuthorizationTrustRoots = peerMediationFeatureEnv.grantSigningKeys.map((key) => ({
        keyId: key.keyId,
        publicKeyBase64Url: key.publicKey,
    }));
    const tunnelRelayHandlerOptions = {
        io: tunnelRelayBridge.io,
        relayAuthorizationTrustRoots: tunnelRelayAuthorizationTrustRoots,
        serverRoutedEnabled: serverRoutedTunnelRelayEnabledByFlowKind.tcp_tunnel,
        serverRoutedEnabledByFlowKind: serverRoutedTunnelRelayEnabledByFlowKind,
        maxActiveTunnelsPerSocket: machineTunnelFeatureEnv.serverRoutedMaxActiveTunnelsPerSocket,
        maxFrameBytes: machineTunnelFeatureEnv.serverRoutedMaxFrameBytes,
        supportedEncodings: machineTunnelFeatureEnv.serverRoutedSupportedEncodings,
        preferredEncoding: machineTunnelFeatureEnv.serverRoutedPreferredEncoding,
        maxBinaryHeaderBytes: machineTunnelFeatureEnv.serverRoutedMaxBinaryHeaderBytes,
        maxRawPayloadBytes: machineTunnelFeatureEnv.serverRoutedMaxRawPayloadBytes,
        maxFramedMessageBytes: machineTunnelFeatureEnv.serverRoutedMaxFramedMessageBytes,
        substreams: machineTunnelFeatureEnv.serverRoutedSubstreams,
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
        }, {
            ...tunnelRelayHandlerOptions,
            readMachineAdmission: (machineId: string) => resolveMachineAdmission({ actorAccountId: accountId, machineId }),
        });

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
    // The provider broker relay is `teams.credentialResources`, a live feature: decided per dispatch
    // on the Home-effective configuration (the tunnel relay's startup capture above stays the
    // transport ceiling for frames of flows these dispatchers already authorized).
    const providerBrokerRelayEnabled = () => isServerFeatureEnabledForHome(
        resolvePeerRouteFeatureId({ flowKind: 'provider_broker', routeKind: 'server_relay' }),
    );
    app.forwardExternalProviderBrokerRequest = createExternalProviderBrokerDispatcher({
        env: process.env,
        createRelayTransport: app.createPeerTcpTunnelRelayTransport,
        enabled: providerBrokerRelayEnabled,
    });
    app.forwardTeamCredentialBrokerResourceTest = createTeamCredentialResourceTestBrokerDispatcher({
        env: process.env,
        createRelayTransport: app.createPeerTcpTunnelRelayTransport,
        enabled: providerBrokerRelayEnabled,
    });

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

        const rejectHandshake = (params: { statusCode: number; error: string; message?: string; provider?: string; data?: Record<string, unknown> }) => {
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
        let ephemeralRunnerAdmission: RestrictedSocketAdmission | null = null;
        try {
            setHandshakeStage("verify-token");
            const verified = await auth.verifyTokenForRoute(token);
            if (!verified) {
                observeHandshakeStage("error");
                return rejectHandshake({ statusCode: 401, error: 'invalid-token' });
            }
            ephemeralRunnerAdmission = verified.authTokenKind === "ephemeral_session_runner" || verified.authTokenKind === "api_token"
                ? resolveRestrictedSocketAdmission({
                    principal: verified.ephemeralSessionRunnerPrincipal,
                    apiTokenPrincipal: verified.apiTokenPrincipal,
                    clientType,
                    ...(sessionId ? { sessionId } : {}),
                    ...(machineId ? { machineId } : {}),
                })
                : null;
            if (isRestrictedAuthTokenKind(verified.authTokenKind) && !ephemeralRunnerAdmission) {
                observeHandshakeStage("error");
                return rejectHandshake({ statusCode: 401, error: 'invalid-token' });
            }
            if (ephemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                const principal = ephemeralRunnerAdmission.principal;
                const origin = socket.handshake.headers.origin;
                if (origin !== undefined && !isApiTokenRequestOriginAllowed(principal.grant, origin)) {
                    return rejectHandshake({ statusCode: 403, error: "origin_denied" });
                }
                const admitted = await admitApiTokenSessionOperation({ principal,
                    sessionId: ephemeralRunnerAdmission.sessionId, actionId: "session.transcript.get",
                    capability: "readTranscript", targetMachineId: await resolveCurrentSessionMachine({
                        accountId: principal.accountId, sessionId: ephemeralRunnerAdmission.sessionId,
                    }),
                });
                if (!admitted.ok) return rejectHandshake({ statusCode: 403, error: admitted.error });
                socket.data.apiTokenPrincipal = principal;
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
                        kind: true,
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
                if (
                    machine.kind === "ephemeral_session_runner"
                    && ephemeralRunnerAdmission?.kind !== "machine-runtime"
                ) {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 403, error: "invalid-machine" });
                }
                verifiedMachineInstallationId = resolveVerifiedMachineSocketInstallationId({
                    accountId: verified.userId,
                    machineId: machine.id,
                    machine,
                    socketAuth: socket.handshake.auth,
                });
                if (
                    ephemeralRunnerAdmission?.kind === "machine-runtime"
                    && verifiedMachineInstallationId !== ephemeralRunnerAdmission.principal.installationId
                ) {
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
            socket.data.authTokenKind = verified.authTokenKind;
            socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
            socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
            socket.data.clientType = clientType;
            socket.data.clientPurpose = clientPurpose;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            if (ephemeralRunnerAdmission) {
                socket.data.ephemeralRunnerAdmission = ephemeralRunnerAdmission;
            }
            if (verifiedMachineInstallationId) {
                socket.data.verifiedMachineInstallationId = verifiedMachineInstallationId;
            }

            // Install user presence before `next()` completes the Socket.IO
            // handshake. The client can emit its first replacement as soon as
            // it receives `connect`; registering later in the async connection
            // callback races that packet and can silently lose the declaration.
            if (clientType === "user-scoped") {
                registerSessionHumanPresenceSocketHandlers({
                    presence: humanPresence,
                    socket,
                    accountId: verified.userId,
                });
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
            const schemaMismatch = readSharedQaSchemaMismatchDiagnostic(error);
            return rejectHandshake({ statusCode: 503, ...(schemaMismatch ?? { error: "upstream_error" }) });
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
        let finishPacketAdmission!: (admitted: boolean) => void;
        const packetAdmission = new Promise<boolean>((resolve) => { finishPacketAdmission = resolve; });
        // Socket.IO exposes `connect` before this async callback finishes. Hold
        // packets in its native dispatch middleware until currentness, rooms,
        // and all handlers are ready; otherwise the first RPC can be lost.
        socket.use((_packet, next) => {
            if (connectReady && socket.connected) {
                next();
                return;
            }
            void packetAdmission.then((admitted) => {
                if (admitted && socket.connected) next();
            });
        });

        const finalizeConnectConvergence = (result: "ready" | "disconnect_before_ready") => {
            if (connectConvergenceFinished) {
                return;
            }
            connectConvergenceFinished = true;
            finishPacketAdmission(result === 'ready');
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

        if (clientType === 'user-scoped') {
            registerUiFocusSocketEvent(socket, packetAdmission);
        }

        // Socket.IO adds this socket to the namespace before this callback. Join
        // only the content-free revocation room until final token currentness is
        // established; protected fanout rooms remain unavailable in that window.
        const handshakeEphemeralRunnerAdmission = (
            socket.data as { ephemeralRunnerAdmission?: RestrictedSocketAdmission }
        ).ephemeralRunnerAdmission ?? null;
        const protectedRooms = getProtectedSocketRooms({
            userId,
            clientType,
            sessionId,
            machineId,
            ...(handshakeEphemeralRunnerAdmission?.kind === "session-runtime" || handshakeEphemeralRunnerAdmission?.kind === "api-token-session-viewer"
                ? { includeUserRoomForSessionScoped: false }
                : {}),
            ...(handshakeEphemeralRunnerAdmission?.kind === "machine-runtime"
                ? { includeUserMachinesRoom: false }
                : {}),
            includeAccountStoredContentV3Room:
                !handshakeEphemeralRunnerAdmission
                && readAccountStoredContentCompatibilityForSocket(socket).supportsPluginDataProtocol,
        });
        if (clientType === 'machine-scoped' && machineId && typeof socket.data.verifiedMachineInstallationId === 'string') {
            protectedRooms.push(getMachineInstallationSocketRoom(userId, machineId, socket.data.verifiedMachineInstallationId));
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
            await socket.join(getAccountRevocationSocketRoom(userId));
            // Join before the existing final currentness read, closing the
            // policy-change window without admitting protected fanout early.
            if (socket.data.authTokenKind === "terminal") await socket.join(getAccountTerminalSocketRoom(userId));
            if (handshakeEphemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                const principal = handshakeEphemeralRunnerAdmission.principal;
                await socket.join([getApiTokenRevocationSocketRoom(principal.credentialId),
                    ...(principal.parentTokenId ? [getApiTokenRevocationSocketRoom(principal.parentTokenId)] : [])]);
            }
            const currentVerified = await auth.verifyTokenForRoute(token);
            const currentEphemeralRunnerAdmission = currentVerified?.authTokenKind === "ephemeral_session_runner" || currentVerified?.authTokenKind === "api_token"
                ? resolveRestrictedSocketAdmission({
                    principal: currentVerified.ephemeralSessionRunnerPrincipal,
                    apiTokenPrincipal: currentVerified.apiTokenPrincipal,
                    clientType,
                    ...(sessionId ? { sessionId } : {}),
                    ...(machineId ? { machineId } : {}),
                })
                : null;
            if (
                !socket.connected
                || !currentVerified
                || (isRestrictedAuthTokenKind(currentVerified.authTokenKind) && !currentEphemeralRunnerAdmission)
                || currentVerified.userId !== userId
            ) {
                await rejectPostConnectAdmission();
                return;
            }
            socket.data.authTokenKind = currentVerified.authTokenKind;
            socket.data.authAuthority = narrowCredentialAuthority(currentVerified.authority, socket.handshake.auth.authorityCeiling);
            socket.data.authTokenAuthenticationEvidence = currentVerified.authenticationEvidence;
            if (currentEphemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                const principal = currentEphemeralRunnerAdmission.principal;
                const origin = socket.handshake.headers.origin;
                const admitted = await admitApiTokenSessionOperation({ principal,
                    sessionId: currentEphemeralRunnerAdmission.sessionId, actionId: "session.transcript.get",
                    capability: "readTranscript", targetMachineId: await resolveCurrentSessionMachine({
                        accountId: userId, sessionId: currentEphemeralRunnerAdmission.sessionId,
                    }),
                });
                if (!admitted.ok || (origin !== undefined && !isApiTokenRequestOriginAllowed(principal.grant, origin))) {
                    await rejectPostConnectAdmission(); return;
                }
                socket.data.apiTokenPrincipal = principal;
                socket.data.ephemeralRunnerAdmission = currentEphemeralRunnerAdmission;
            }
            await socket.join(protectedRooms);
            if (!socket.connected) {
                await rejectPostConnectAdmission();
                return;
            }
            // The final socket-currentness check succeeded: release the presence
            // hold so an early replacement declaration is admitted through the
            // ordinary path. Until this point it could not acknowledge, authorize,
            // join a presence room, or emit a snapshot.
            releaseSessionHumanPresenceHoldAfterFinalCurrentness(socket);
        } catch (error) {
            await rejectPostConnectAdmission();
            const schemaMismatch = readSharedQaSchemaMismatchDiagnostic(error);
            log(
                {
                    module: "websocket-auth-admission",
                    socketId: socket.id,
                    clientType,
                    sessionId,
                    machineId,
                    err: error,
                    ...(schemaMismatch ? { errorCode: schemaMismatch.error } : {}),
                },
                schemaMismatch?.message ?? "Post-connect Socket authentication admission failed unexpectedly",
            );
            return;
        }

        const viewerAdmission = (socket.data as { ephemeralRunnerAdmission?: RestrictedSocketAdmission })
            .ephemeralRunnerAdmission;
        if (viewerAdmission?.kind === "api-token-session-viewer" && viewerAdmission.principal.expiresAt) {
            scheduleApiTokenSocketExpiry(socket, viewerAdmission.principal.expiresAt);
        }

        // Store connection based on type
        const metadata = { clientType, clientPurpose: clientPurpose || 'unknown', sessionId, machineId };
        const ephemeralRunnerAdmission = (
            socket.data as { ephemeralRunnerAdmission?: RestrictedSocketAdmission }
        ).ephemeralRunnerAdmission ?? null;
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                ...(machineId ? { machineId } : {}),
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
                        await Promise.all(disconnected.recipientCursors.map(async ({ accountId, cursor }) => {
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

            // Broadcast daemon offline status. A temporary Runner Machine stays out
            // of this Account-wide inventory fanout; its Session owns its presence.
            if (connection.connectionType === 'machine-scoped' && ephemeralRunnerAdmission?.kind !== "machine-runtime") {
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

        // The packet admission hold releases connect-time calls/registrations
        // only after currentness, room membership, and handler setup complete.
        rpcHandler(userId, socket, {
            io,
            sessionPublisherPresence,
            ephemeralRunnerAdmission,
        });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped' && ephemeralRunnerAdmission?.kind !== "machine-runtime") {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
                });
        }

        // Handlers
        if (ephemeralRunnerAdmission?.kind !== "machine-runtime" && ephemeralRunnerAdmission?.kind !== "api-token-session-viewer") {
            usageHandler(
                userId,
                socket,
                connection,
                ephemeralRunnerAdmission?.kind === "session-runtime",
            );
        }
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
        if (ephemeralRunnerAdmission?.kind !== "machine-runtime") {
            if (!ephemeralRunnerAdmission && sessionBinding?.proof === "machine-access-key") {
                installSessionPublisherCredentialCurrentness(userId, socket);
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
                ephemeralRunnerAdmission?.kind === "session-runtime"
                    ? {
                        principalKind: "ephemeral-session-runner",
                        principal: ephemeralRunnerAdmission.principal,
                    }
                    : ephemeralRunnerAdmission?.kind === "api-token-session-viewer"
                        ? { principalKind: "api-token-session-viewer", principal: ephemeralRunnerAdmission.principal,
                            resolveSessionMachine: resolveCurrentSessionMachine }
                        : undefined,
                { resolveExecutionRunCurrentness },
            );
        }
        pingHandler(socket);
        if (!ephemeralRunnerAdmission) {
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
                readMachineAdmission: (machineId: string) => resolveMachineAdmission({ actorAccountId: userId, machineId }),
                socketMaxHttpBufferSize,
                resolveAccountEncryptionMode: async () => {
                    const account = await db.account.findUnique({ where: { id: userId }, select: { encryptionMode: true } });
                    return account?.encryptionMode === 'plain' || account?.encryptionMode === 'e2ee'
                        ? account.encryptionMode : null;
                },
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
            registerPeerMediationObservabilitySocketRoutes(socket, {
                store: peerMediationObservabilityStore,
                principal: resolvePeerMediationObservabilityPrincipal({
                    userId,
                    clientType,
                    ...(sessionId ? { sessionId } : {}),
                    ...(machineId ? { machineId } : {}),
                }),
            });
            artifactUpdateHandler(userId, socket);
            accessKeyHandler(userId, socket, connection);
        }
        if (
            !ephemeralRunnerAdmission
            || ephemeralRunnerAdmission.kind === "machine-runtime"
        ) {
            registerPeerTcpTunnelRelaySocketHandler(userId, socket, {
                ...tunnelRelayHandlerOptions,
                readMachineAdmission: (machineId: string) => resolveMachineAdmission({ actorAccountId: userId, machineId }),
            });
        }

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
        humanPresence.close();
        await io.close();
        await tunnelRelayCoordinator.close();
        if (shouldEnableRedisAdapter) {
            closeRedisSocketClusterClient();
        }
    });
}
