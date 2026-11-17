import { sanitizeDeviceLabel } from '@happier-dev/protocol/auth/deviceLabel';
import { SOCKET_PING_INTERVAL_MS, SOCKET_PING_TIMEOUT_MS } from '@happier-dev/protocol/actions/externalActionLimits';
import { onShutdown } from "@/utils/process/shutdown";
import { isIrohIngressRequest, IROH_REQUEST_IP } from '@/app/net/requestIngress';
import { registerUiFocusSocketEvent } from '@/app/api/socket/registerUiFocusSocketEvent';
import { registerSessionConsumptionSocketEvent, retireSessionConsumptionAfterAccessChange } from '@/app/api/socket/sessionConsumption';
import { registerSocketRoomDiscovery } from '@/app/api/socket/socketRoomDiscovery';
import { Fastify } from "./types";
import { buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT, CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT } from "@/app/events/socketRoomEmitter";
import { readAccountChangeRowsDemandV1 } from '@happier-dev/protocol/changes';
import { registerMachineAccessLossHandler } from '@/app/events/machineAccessLoss';
import { registerAccountSignInRevokedHandler, registerSignInPolicyChangeHandler } from '@/app/events/signInPolicyChange';
import { registerClusterPushReconcile } from '@/app/events/clusterPushReconcile';
import { evictSignInIneligibleSockets, recheckSocketAdmittedUnderOlderSignInPolicy, registerAccountSignInRevocation,
    registerSignInPolicyEviction } from '@/app/auth/signInPolicyEviction';
import { buildMachineOwnerConflictSocketPayload, readMachineDaemonOwnershipMetadataFromSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';
import { Server, Socket } from "socket.io";
import { log, warn } from "@/utils/logging/log";
import { auth } from "@/app/auth/auth";
import { verifyCurrentMaterializedRunnerPrincipal } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { narrowCredentialAuthority } from "@/app/auth/effectiveCredentialAuthority";
import { admitApiTokenSessionOperation, isRestrictedAuthTokenKind } from "@/app/api/utils/apiTokenRouteAdmission";
import { isApiTokenRequestOriginAllowed } from "./utils/isApiTokenRequestOriginAllowed";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
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
import { readSignInPolicyGeneration } from "@/app/auth/signInPolicyGeneration";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { registerReleasedUiV021SessionEndSocketEvent } from "@/app/session/compatibility/registerReleasedUiV021SessionEndSocketEvent";
import { createSessionHumanPresenceService } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { registerSessionHumanPresenceSocketHandlers, releaseSessionHumanPresenceHoldAfterFinalCurrentness } from "@/app/session/humanPresence/registerSessionHumanPresenceSocketHandlers";
import { machineUpdateHandler, observeMachineAliveFromSocket } from "./socket/machineUpdateHandler";
import { withdrawMachineConnectionCapabilitiesForSocketClaim } from './socket/machineOperationCapabilities';
import { recordMachineDisconnect, schedulePresenceDeadline } from '@/app/presence/timeout';
import { registerPresenceDeadlineNotifications } from '@/app/presence/presenceDeadlineNotification';
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
import { resolveMachineSocketInstallationIdentity } from "./socket/machineSocketInstallationProof";
import { rejectSocket, resolveSocketAuthUnavailableError } from "./socket/socketAuthError";
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import {
    getAccountRevocationSocketRoom,
    getAccountChangeRowsSocketRoom,
    getApiTokenRevocationSocketRoom,
    getMachineInstallationSocketRoom,
    getProtectedSocketRooms,
    type SocketClientType,
} from "./socketRooms";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import {
    closeRedisSocketClusterClient,
    createRedisSocketClusterRelayAdmissionClient,
    getRedisSocketClusterAdapterClient,
    onSocketClusterAdapterPublishLost,
    onSocketClusterAdapterResubscribed,
} from "@/storage/redis/redis";
import { randomUUID } from "node:crypto";
import { forwardRpcCall } from './socket/rpc/forwardRpcCall';
import { readSocketAdapterRuntimeConfigFromEnv } from "@/config/socketAdapter";
import { db, isPrismaErrorCode } from "@/storage/db";
import { readSharedQaSchemaMismatchDiagnostic } from '@/storage/prismaErrors';
import { isServerFeatureEnabledForHome, isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { readMachineLiveStreamFeatureEnv, readMachineTransferFeatureEnv, readMachineTunnelFeatureEnv, readPeerMediationFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isMachineScopedSocketAdmissionCurrent, reconfirmMachineScopedSocketAdmissions } from './socket/machinePublication';
import { confirmSessionScopedMachineAccess, readSessionScopedSocketBinding, reconfirmSessionScopedMachineAccess,
    resolveSessionScopedSocketBinding, resolveSocketResourceIdentity, watchSessionScopedMachineAccess } from "./socket/sessionScopedBinding";
import {
    resolveRestrictedSocketAdmission,
    type RestrictedSocketAdmission,
} from "./socket/restrictedSocketAdmission";
import { createMachineSocketOwnershipRegistry } from "./socket/machineSocketOwnershipRegistry";
import { createPeerMediationViewerSocketOwnershipVerifier, createPeerMediationViewerSessionAuthenticationReader } from "./socket/viewerSocketOwnership";
import { activityCache } from "@/app/presence/sessionCache";
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { EXTERNAL_SESSION_OPERATION_SOCKET_MAX_BATCH_ITEMS_V1, resolveExternalSessionOperationSocketBatchLimitsV1, type ExternalSessionOperationSocketBatchLimitResolutionV1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { resolvePeerRouteFeatureId } from '@happier-dev/protocol/machines/peer/mediation/routeFeature';
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
import { destroyUnclaimedHttpUpgrades } from './utils/httpUpgradeOwnership';
import { registerEngineHeartbeatDiagnostics } from './socket/engineHeartbeatDiagnostics';
import { registerClientDisconnectCleanup } from './socket/clientDisconnect';
import { dispatchSocketPacket } from './socket/dispatchSocketPacket';
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
    io: Pick<Server, 'local'>,
    retryAfterMs: number,
): void {
    const normalizedRetryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.trunc(retryAfterMs)
        : DEFAULT_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS;
    // Only this process is shutting down. A cluster broadcast would make
    // healthy peers' clients declare their Home unavailable and disconnect.
    io.local.emit('server:restarting', { retryAfterMs: normalizedRetryAfterMs });
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

const SOCKET_IO_PATH = '/v1/updates';

export function startSocket(app: Fastify): () => Promise<void> {
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
        pingTimeout: SOCKET_PING_TIMEOUT_MS,
        pingInterval: SOCKET_PING_INTERVAL_MS,
        path: SOCKET_IO_PATH,
        // Upgrades that Socket.IO does not own belong to the local service data planes, which can
        // take longer than its fixed one-second cleanup to answer; unclaimed ones are closed below.
        destroyUpgrade: false,
        maxHttpBufferSize: socketMaxHttpBufferSize,
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false // Don't serve the client files
    });

    const pendingMachineDisconnects = new Set<Promise<void>>();
    registerClientDisconnectCleanup(io);
    registerEngineHeartbeatDiagnostics(io, process.env, diagnostic => {
        // Opt-in only; emit at warn so the flag works under the default warn log level.
        warn({ module: 'socket-heartbeat-diagnostic', ...diagnostic }, 'Engine.IO heartbeat diagnostic');
    });
    destroyUnclaimedHttpUpgrades(app.server, SOCKET_IO_PATH);
    registerSocketRoomDiscovery(io);
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
        onSessionAccessChanged: sessionId => retireSessionConsumptionAfterAccessChange(io.sockets.sockets.values(), sessionId),
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
    const machineOwnershipRegistry = createMachineSocketOwnershipRegistry({
        io,
        config: shouldEnableRedisAdapter ? { enabled: true, instanceId } : { enabled: false },
    });
    const tunnelRelayCoordinator = createPeerTcpTunnelRelayCoordinator({
        io,
        config: shouldEnableRedisAdapter
            ? {
                mode: "redis",
                createRelayAdmissionRedis: createRedisSocketClusterRelayAdmissionClient,
                readMachineSocketOwner: machineOwnershipRegistry.readOwner,
            }
            : { mode: "memory" },
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
    const readViewerSessionAuthentication = createPeerMediationViewerSessionAuthenticationReader(io);
    app.verifyPeerMediationViewerSocketOwnership = verifyPeerMediationViewerSocketOwnership;
    eventRouter.setIo(io, {
        forwardRpc: (request) => forwardRpcCall({ io, ...request }),
        broadcastServerSideEvent: (event, payload) => {
            if (shouldEnableRedisAdapter) {
                io.serverSideEmit(event, payload);
            }
        },
    });
    io.on(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, (delivery: unknown) => {
        void eventRouter.receiveCredentialQualifiedSessionDelivery(io.local, delivery);
    });
    io.on(ACCOUNT_CHANGE_ROWS_DELIVERY_EVENT, (delivery: unknown) => {
        void eventRouter.receiveAccountChangeRowsDelivery(io.local, delivery);
    });
    const releasePresenceDeadlineNotifications = registerPresenceDeadlineNotifications(io, schedulePresenceDeadline);
    const releaseMachineAccessLoss = registerMachineAccessLossHandler(io, input => eventRouter.receiveMachineAccessLoss(input));
    const releaseSignInPolicyChange = registerSignInPolicyChangeHandler(io, () => eventRouter.receiveSignInPolicyChange());
    const releaseSignInPolicyEviction = registerSignInPolicyEviction({ sockets: () => io.of('/').sockets.values(),
        onSignInPolicyChange: listener => eventRouter.onSignInPolicyChange(listener) });
    const releaseAccountSignInRevokedNotice = registerAccountSignInRevokedHandler(io, accountId => eventRouter.receiveAccountSignInRevoked(accountId));
    const releaseAccountSignInRevocation = registerAccountSignInRevocation(listener => eventRouter.onAccountSignInRevoked(listener));
    // Access-loss and sign-in policy pushes between nodes are at-most-once Pub/Sub; re-check this
    // node's live sockets once when its adapter subscriber is ready again, or a peer lost its publish.
    const releaseClusterPushReconcile = shouldEnableRedisAdapter
        ? registerClusterPushReconcile({ io, redis: { onSocketClusterAdapterResubscribed, onSocketClusterAdapterPublishLost }, reconcile: () => {
            void reconfirmSessionScopedMachineAccess(io.of('/').sockets.values());
            void reconfirmMachineScopedSocketAdmissions(io.of('/').sockets.values());
            void evictSignInIneligibleSockets(io.of('/').sockets.values()).catch(error => {
                log({ module: 'auth-sign-in-policy', error }, 'Sign-in policy socket re-check after a possibly lost cluster push failed');
            });
        } })
        : () => {};
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
                if (origin !== undefined && !await isApiTokenRequestOriginAllowed(principal.grant, origin, () => readHomeConfigEnv())) {
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
            // A sign-in policy change during this admission re-decides the socket on connection.
            socket.data.signInPolicyGeneration = readSignInPolicyGeneration();
            const eligibility = await enforceLoginEligibility({
                accountId: verified.userId,
                readEnv: () => readHomeConfigEnv(),
                verifiedCredential: verified,
            });
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
                const installationIdentity = resolveMachineSocketInstallationIdentity({
                    accountId: verified.userId,
                    machineId: machine.id,
                    machine,
                    socketAuth: socket.handshake.auth,
                });
                if (installationIdentity.kind === 'displaced') {
                    observeHandshakeStage("error");
                    return rejectHandshake({ statusCode: 410, error: 'machine_revoked' });
                }
                verifiedMachineInstallationId = installationIdentity.kind === 'verified' ? installationIdentity.installationId : null;
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
                // Retained capabilities describe the prior daemon, including a
                // newer binary on this exact installation. Withdraw connection facts
                // before connect can expose this new RPC owner to callers.
                if (!await withdrawMachineConnectionCapabilitiesForSocketClaim({
                    accountId: verified.userId, machineId: machine.id, installationId: machine.installationId,
                    isCurrent: () => machineOwnershipRegistry.isOwner({
                        accountId: verified.userId, machineId: machine.id, socketId: socket.id,
                    }),
                })) {
                    observeHandshakeStage('error');
                    await releaseMachineOwnershipIfClaimed();
                    return rejectHandshake({ statusCode: 403, error: 'invalid-machine' });
                }
                observeHandshakeStage("ok");
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
                });
                socket.data.sessionScopedBinding = binding.binding;
            }

            socket.data.userId = verified.userId;
            socket.data.tokenEpoch = verified.tokenEpoch;
            socket.data.authTokenKind = verified.authTokenKind;
            socket.data.authTokenLegacy = verified.legacy;
            socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
            socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
            socket.data.clientType = clientType;
            socket.data.clientPurpose = clientPurpose;
            // Optional app presentation, retained only for this authenticated live socket.
            socket.data.rpcDeviceLabel = clientType === 'user-scoped' && clientPurpose === 'sync'
                && !ephemeralRunnerAdmission
                ? sanitizeDeviceLabel(socket.handshake.auth.deviceLabel) : null;
            // A Session-scoped socket carries the ids its handshake admitted, the same ones its rooms use.
            const resourceIdentity = resolveSocketResourceIdentity({ ...socket.data, sessionId, machineId });
            socket.data.sessionId = resourceIdentity.sessionId;
            socket.data.machineId = resourceIdentity.machineId;
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
            if (clientType === "user-scoped" || clientType === "session-scoped") {
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
            return rejectHandshake(resolveSocketAuthUnavailableError(error));
        }
    });

    io.on("connection", async (socket) => {
        void recheckSocketAdmittedUnderOlderSignInPolicy(socket).catch(error => {
            log({ module: 'auth-sign-in-policy', error }, 'Sign-in policy re-check of a socket admitted under an older policy failed');
        });
        const connectedAtMs = Date.now();
        const remoteAddress = isIrohIngressRequest(socket.request) ? IROH_REQUEST_IP : socket.handshake.address;
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
        const { sessionId, machineId } = resolveSocketResourceIdentity(socket.data);
        const isMachineSocketCurrent = async (): Promise<boolean> => socket.connected
            && typeof machineId === 'string'
            && (await machineOwnershipRegistry.readOwner({ accountId: userId, machineId }))?.socketId === socket.id;
        const token = socket.handshake.auth.token as string;
        let connectConvergenceFinished = false;
        let connectReady = false;
        let finishPacketAdmission!: (admitted: boolean) => void;
        const packetAdmission = new Promise<boolean>((resolve) => { finishPacketAdmission = resolve; });
        // Socket.IO exposes `connect` before this async callback finishes. Hold
        // packets in its native dispatch middleware until currentness, rooms,
        // and all handlers are ready; otherwise the first RPC can be lost.
        socket.use((packet, next) => {
            if (connectReady && socket.connected) {
                dispatchSocketPacket(socket, packet, next);
                return;
            }
            void packetAdmission.then((admitted) => {
                if (admitted && socket.connected) dispatchSocketPacket(socket, packet, next);
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
            registerSessionConsumptionSocketEvent(socket, packetAdmission);
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
        // Pushed change rows are authorized for this socket's credential through the feed owner. Only an
        // unrestricted Account credential (a daemon's Machine socket, a session host's Account socket)
        // reads the whole Account feed; restricted admissions keep the wake.
        const accountChangeRowsDemand = (clientType === 'machine-scoped' || clientType === 'user-scoped') && !handshakeEphemeralRunnerAdmission
            && readAccountStoredContentCompatibilityForSocket(socket).supportsPluginDataProtocol
            ? readAccountChangeRowsDemandV1(socket.handshake.auth) : null;
        if (accountChangeRowsDemand) {
            socket.data.accountChangeRows = { kinds: accountChangeRowsDemand.kinds };
            protectedRooms.push(getAccountChangeRowsSocketRoom(userId));
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

        // Session-scoped Machine access is admitted at the handshake and withdrawn by the access
        // owner's push; subscribe before the post-join confirmation read below.
        const releaseSessionScopedMachineAccessWatch = watchSessionScopedMachineAccess({
            socket, accountId: userId, onMachineAccessLoss: listener => eventRouter.onMachineAccessLoss(listener),
        });
        socket.once("disconnect", releaseSessionScopedMachineAccessWatch);
        try {
            await socket.join(getAccountRevocationSocketRoom(userId));
            if (handshakeEphemeralRunnerAdmission?.kind === "api-token-session-viewer") {
                const principal = handshakeEphemeralRunnerAdmission.principal;
                await socket.join([getApiTokenRevocationSocketRoom(principal.credentialId),
                    ...(principal.parentTokenId ? [getApiTokenRevocationSocketRoom(principal.parentTokenId)] : [])]);
            }
            // Bearer verification belongs to the handshake. After joining the
            // eviction rooms, close the connect-time publication gap using the
            // existing credential row owners, without verifying the bearer again.
            const admission = handshakeEphemeralRunnerAdmission;
            if (admission?.kind === 'api-token-session-viewer') {
                const principal = await auth.verifyCurrentApiTokenPrincipal(admission.principal);
                if (!socket.connected || !principal) {
                    await rejectPostConnectAdmission(); return;
                }
                const origin = socket.handshake.headers.origin;
                const admitted = await admitApiTokenSessionOperation({ principal,
                    sessionId: admission.sessionId, actionId: 'session.transcript.get',
                    capability: 'readTranscript', targetMachineId: await resolveCurrentSessionMachine({
                        accountId: userId, sessionId: admission.sessionId,
                    }),
                });
                if (!admitted.ok || (origin !== undefined && !await isApiTokenRequestOriginAllowed(principal.grant, origin, () => readHomeConfigEnv()))) {
                    await rejectPostConnectAdmission(); return;
                }
                socket.data.apiTokenPrincipal = principal;
                socket.data.ephemeralRunnerAdmission = { ...admission, principal };
            } else if (!socket.connected || !await auth.isSignedCredentialCurrent(db, userId, socket.data.tokenEpoch)) {
                await rejectPostConnectAdmission(); return;
            }
            if (admission && admission.kind !== 'api-token-session-viewer'
                && !await verifyCurrentMaterializedRunnerPrincipal(admission.principal)) {
                await rejectPostConnectAdmission(); return;
            }
            await socket.join(protectedRooms);
            await confirmSessionScopedMachineAccess({ socket, accountId: userId });
            // Handlers rely on push disconnects to the Machine room just joined; one read closes the join window.
            if (!socket.connected || !await isMachineScopedSocketAdmissionCurrent(socket, userId)) {
                await rejectPostConnectAdmission();
                return;
            }
            // Connect admission and protected-room setup succeeded: release the presence
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
                const publisher = {
                    accountId: userId,
                    machineId: connection.machineId,
                    socketId: socket.id,
                };
                // A retiring predecessor must not mark its replacement offline.
                // Release after the presence write, before notification work.
                const releasePublisher = () => machineOwnershipRegistry.releaseOwner(publisher);
                const disconnect = recordMachineDisconnect(publisher, () => machineOwnershipRegistry.isOwner(publisher), releasePublisher).catch(error => {
                    log({ module: 'machine-presence', error }, 'Failed to publish Machine disconnect');
                });
                pendingMachineDisconnects.add(disconnect);
                void disconnect.finally(() => pendingMachineDisconnects.delete(disconnect));
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


        // Handlers
        if (ephemeralRunnerAdmission?.kind !== "machine-runtime" && ephemeralRunnerAdmission?.kind !== "api-token-session-viewer") {
            usageHandler(
                userId,
                socket,
                connection,
                ephemeralRunnerAdmission?.kind === "session-runtime" ? ephemeralRunnerAdmission.principal : null,
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
                isMachineSocketCurrent,
                sessionPublisherPresence,
                resolveCurrentSessionMachine,
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
                readViewerSessionAuthentication,
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

        // A connect becomes an observation only after final currentness and all
        // handlers are installed. Disconnect does not invent a new last-seen;
        // the observation's existing deadline remains its owner.
        if (connection.connectionType === 'machine-scoped' && !ephemeralRunnerAdmission) {
            try {
                await observeMachineAliveFromSocket({ userId, socket, timestamp: Date.now(),
                    machineId: connection.machineId, continuingBeat: false, isCurrent: isMachineSocketCurrent });
            } catch (error) {
                log({ module: 'presence', error }, 'Connect observation failed');
            }
        }

        // Ready
        connectReady = true;
        finalizeConnectConvergence("ready");
        if (ephemeralRunnerAdmission?.kind === 'api-token-session-viewer') {
            // Rooms are joined and currentness is proved: Self can now close the
            // gap between initial credential admission and pushed configuration.
            socket.emit('ephemeral', { type: 'api-token-embed-config-changed' });
        }
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

    const close = async () => {
        releasePresenceDeadlineNotifications();
        releaseMachineAccessLoss();
        releaseSignInPolicyChange();
        releaseSignInPolicyEviction();
        releaseAccountSignInRevokedNotice();
        releaseAccountSignInRevocation();
        releaseClusterPushReconcile();
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
        // Socket closure starts asynchronous presence writes. Finish them
        // before the later database shutdown disconnects their transaction.
        await Promise.all(pendingMachineDisconnects);
        await tunnelRelayCoordinator.close();
        if (shouldEnableRedisAdapter) {
            closeRedisSocketClusterClient();
        }
    };
    const releaseShutdown = onShutdown('api:socket', close);
    return async () => {
        releaseShutdown();
        await close();
    };
}
