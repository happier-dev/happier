import { Counter, Gauge, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export type SocketConnectionType = "user-scoped" | "session-scoped" | "machine-scoped";
export type SocketTransportName = "polling" | "websocket" | "webtransport" | "unknown";
type SocketRole = "all" | "api" | "worker";
export type SocketAuthHandshakeStage =
    | "verify-token"
    | "login-eligibility"
    | "machine-lookup"
    | "machine-ownership"
    | "session-binding";
export type SocketConnectConvergencePhase = "start" | "complete" | "disconnect_before_ready";
export type SocketConnectConvergenceResult = "ready" | "disconnect_before_ready";
export type SocketAuthHandshakeExceptionClassification =
    | "prisma-p1001"
    | "prisma-p1008"
    | "prisma-p2024"
    | "prisma-p2028"
    | "prisma-p2037"
    | "prisma-engine-empty-response"
    | "prisma-unknown"
    | "unknown";

type TrackedSocketConnection = Readonly<{
    socketId: string;
    userId: string;
    clientType: SocketConnectionType;
    sessionId?: string;
    machineId?: string;
    transport: SocketTransportName;
    reconnectKey: string;
}>;

const legacyConnectionCounts: Record<SocketConnectionType, number> = {
    "user-scoped": 0,
    "session-scoped": 0,
    "machine-scoped": 0,
};

const activeConnectionsBySocketId = new Map<string, TrackedSocketConnection>();
const activeUsers = new Map<string, number>();
const activeSessions = new Map<string, number>();
const activeMachines = new Map<string, number>();
const activeTransportCounts = new Map<SocketTransportName, number>();
const recentDisconnectsByReconnectKey = new Map<string, number>();

export const websocketConnectionsGauge = getOrCreateMetric("websocket_connections_total", () => new Gauge({
    name: "websocket_connections_total",
    help: "Deprecated: number of active WebSocket connections by client type",
    labelNames: ["type"] as const,
    registers: [register],
}));

export const websocketConnectionsActiveGauge = getOrCreateMetric("websocket_connections_active", () => new Gauge({
    name: "websocket_connections_active",
    help: "Number of active WebSocket connections by process role and client type",
    labelNames: ["role", "type"] as const,
    registers: [register],
}));

export const websocketActiveEntitiesGauge = getOrCreateMetric("websocket_active_entities", () => new Gauge({
    name: "websocket_active_entities",
    help: "Number of unique active websocket entities tracked by this process",
    labelNames: ["role", "entity_type"] as const,
    registers: [register],
}));

export const websocketTransportConnectionsActiveGauge = getOrCreateMetric("websocket_transport_connections_active", () => new Gauge({
    name: "websocket_transport_connections_active",
    help: "Number of active websocket connections by process role and current transport",
    labelNames: ["role", "transport"] as const,
    registers: [register],
}));

export const websocketEventsCounter = getOrCreateMetric("websocket_events_total", () => new Counter({
    name: "websocket_events_total",
    help: "Total WebSocket events received by type",
    labelNames: ["event_type"] as const,
    registers: [register],
}));

export const socketMessageAckCounter = getOrCreateMetric("socket_message_ack_total", () => new Counter({
    name: "socket_message_ack_total",
    help: "Total socket message acknowledgements by result",
    labelNames: ["result", "error"] as const,
    registers: [register],
}));

export const socketAdapterModeInfo = getOrCreateMetric("socket_adapter_mode_info", () => new Gauge({
    name: "socket_adapter_mode_info",
    help: "Socket adapter mode currently configured for this process role",
    labelNames: ["adapter", "redis_enabled", "role"] as const,
    registers: [register],
}));

export const websocketAuthHandshakesCounter = getOrCreateMetric("websocket_auth_handshakes_total", () => new Counter({
    name: "websocket_auth_handshakes_total",
    help: "Total socket authentication handshake outcomes",
    labelNames: ["role", "client_type", "transport", "result", "failure"] as const,
    registers: [register],
}));

export const websocketAuthHandshakeDurationHistogram = getOrCreateMetric("websocket_auth_handshake_duration_seconds", () => new Histogram({
    name: "websocket_auth_handshake_duration_seconds",
    help: "Socket authentication handshake duration in seconds",
    labelNames: ["role", "client_type", "result", "failure"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [register],
}));

export const websocketAuthHandshakeStageDurationHistogram = getOrCreateMetric("websocket_auth_handshake_stage_duration_seconds", () => new Histogram({
    name: "websocket_auth_handshake_stage_duration_seconds",
    help: "Socket authentication handshake stage duration in seconds",
    labelNames: ["role", "client_type", "transport", "stage", "result"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [register],
}));

export const websocketAuthHandshakeExceptionsCounter = getOrCreateMetric("websocket_auth_handshake_exceptions_total", () => new Counter({
    name: "websocket_auth_handshake_exceptions_total",
    help: "Unexpected exceptions during socket authentication handshake by stage and classification",
    labelNames: ["role", "client_type", "transport", "stage", "classification"] as const,
    registers: [register],
}));

export const websocketConnectConvergenceCounter = getOrCreateMetric("websocket_connect_convergence_total", () => new Counter({
    name: "websocket_connect_convergence_total",
    help: "Total socket connect convergence lifecycle events observed by this process",
    labelNames: ["role", "client_type", "transport", "phase"] as const,
    registers: [register],
}));

export const websocketConnectConvergenceDurationHistogram = getOrCreateMetric("websocket_connect_convergence_duration_seconds", () => new Histogram({
    name: "websocket_connect_convergence_duration_seconds",
    help: "Socket connect convergence duration in seconds from connection callback entry to ready or pre-ready disconnect",
    labelNames: ["role", "client_type", "transport", "result"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 10, 30],
    registers: [register],
}));

export const websocketDisconnectsCounter = getOrCreateMetric("websocket_disconnects_total", () => new Counter({
    name: "websocket_disconnects_total",
    help: "Total socket disconnects by reason",
    labelNames: ["role", "client_type", "transport", "reason"] as const,
    registers: [register],
}));

export const websocketTransportUpgradeOutcomesCounter = getOrCreateMetric("websocket_transport_upgrade_outcomes_total", () => new Counter({
    name: "websocket_transport_upgrade_outcomes_total",
    help: "Total transport upgrade outcomes observed by this process",
    labelNames: ["role", "from_transport", "to_transport", "result"] as const,
    registers: [register],
}));

export const websocketReconnectionsCounter = getOrCreateMetric("websocket_reconnections_total", () => new Counter({
    name: "websocket_reconnections_total",
    help: "Total reconnects observed by this process within the configured reconnect window",
    labelNames: ["role", "client_type"] as const,
    registers: [register],
}));

function resolveSocketMetricsRole(env: NodeJS.ProcessEnv = process.env): SocketRole {
    const role = env.SERVER_ROLE?.trim();
    return role === "api" || role === "worker" ? role : "all";
}

function resolveSocketReconnectWindowMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = (env.HAPPIER_SOCKET_RECONNECT_WINDOW_MS ?? env.HAPPY_SOCKET_RECONNECT_WINDOW_MS ?? "").trim();
    if (!raw) {
        return 30_000;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
}

function normalizeTransportName(transport: string | undefined): SocketTransportName {
    if (transport === "polling" || transport === "websocket" || transport === "webtransport") {
        return transport;
    }
    return "unknown";
}

function buildReconnectKey(params: Readonly<{
    userId: string;
    clientType: SocketConnectionType;
    sessionId?: string;
    machineId?: string;
}>): string {
    return [
        params.userId,
        params.clientType,
        params.sessionId ?? "",
        params.machineId ?? "",
    ].join(":");
}

function bumpRefCount(store: Map<string, number>, key: string | undefined): void {
    if (!key) return;
    store.set(key, (store.get(key) ?? 0) + 1);
}

function decrementRefCount(store: Map<string, number>, key: string | undefined): void {
    if (!key) return;
    const next = Math.max(0, (store.get(key) ?? 0) - 1);
    if (next === 0) {
        store.delete(key);
        return;
    }
    store.set(key, next);
}

function adjustTransportCount(transport: SocketTransportName, delta: 1 | -1): void {
    const next = Math.max(0, (activeTransportCounts.get(transport) ?? 0) + delta);
    if (next === 0) {
        activeTransportCounts.delete(transport);
        return;
    }
    activeTransportCounts.set(transport, next);
}

function refreshConnectionGauges(): void {
    const role = resolveSocketMetricsRole();
    for (const [type, count] of Object.entries(legacyConnectionCounts) as Array<[SocketConnectionType, number]>) {
        websocketConnectionsGauge.set({ type }, count);
        websocketConnectionsActiveGauge.set({ role, type }, count);
    }

    websocketActiveEntitiesGauge.set({ role, entity_type: "user" }, activeUsers.size);
    websocketActiveEntitiesGauge.set({ role, entity_type: "session" }, activeSessions.size);
    websocketActiveEntitiesGauge.set({ role, entity_type: "machine" }, activeMachines.size);

    for (const transport of ["polling", "websocket", "webtransport", "unknown"] as const) {
        websocketTransportConnectionsActiveGauge.set(
            { role, transport },
            activeTransportCounts.get(transport) ?? 0,
        );
    }
}

export function incrementWebSocketConnection(type: SocketConnectionType): void {
    legacyConnectionCounts[type] += 1;
    refreshConnectionGauges();
}

export function decrementWebSocketConnection(type: SocketConnectionType): void {
    legacyConnectionCounts[type] = Math.max(0, legacyConnectionCounts[type] - 1);
    refreshConnectionGauges();
}

export function trackWebSocketConnection(params: Readonly<{
    socketId: string;
    userId: string;
    clientType: SocketConnectionType;
    sessionId?: string;
    machineId?: string;
    transport?: string;
    reconnectWindowMs?: number;
    nowMs?: number;
}>): void {
    const reconnectKey = buildReconnectKey(params);
    const nowMs = params.nowMs ?? Date.now();
    const reconnectWindowMs = params.reconnectWindowMs ?? resolveSocketReconnectWindowMs();
    const transport = normalizeTransportName(params.transport);

    for (const [key, timestamp] of recentDisconnectsByReconnectKey.entries()) {
        if (nowMs - timestamp > reconnectWindowMs) {
            recentDisconnectsByReconnectKey.delete(key);
        }
    }

    const disconnectedAtMs = recentDisconnectsByReconnectKey.get(reconnectKey);
    if (typeof disconnectedAtMs === "number" && nowMs - disconnectedAtMs <= reconnectWindowMs) {
        websocketReconnectionsCounter.inc({
            role: resolveSocketMetricsRole(),
            client_type: params.clientType,
        });
        recentDisconnectsByReconnectKey.delete(reconnectKey);
    }

    activeConnectionsBySocketId.set(params.socketId, {
        socketId: params.socketId,
        userId: params.userId,
        clientType: params.clientType,
        sessionId: params.sessionId,
        machineId: params.machineId,
        transport,
        reconnectKey,
    });

    legacyConnectionCounts[params.clientType] += 1;
    adjustTransportCount(transport, 1);
    bumpRefCount(activeUsers, params.userId);
    bumpRefCount(activeSessions, params.sessionId);
    bumpRefCount(activeMachines, params.machineId);
    refreshConnectionGauges();
}

export function recordSocketTransportUpgradeOutcome(params: Readonly<{
    socketId: string;
    fromTransport: string;
    toTransport?: string;
    result: "success" | "abandoned";
}>): void {
    const role = resolveSocketMetricsRole();
    const fromTransport = normalizeTransportName(params.fromTransport);
    const toTransport = normalizeTransportName(params.toTransport);
    websocketTransportUpgradeOutcomesCounter.inc({
        role,
        from_transport: fromTransport,
        to_transport: toTransport,
        result: params.result,
    });

    if (params.result !== "success") {
        return;
    }

    const tracked = activeConnectionsBySocketId.get(params.socketId);
    if (!tracked) {
        return;
    }

    if (tracked.transport !== fromTransport) {
        return;
    }

    adjustTransportCount(fromTransport, -1);
    adjustTransportCount(toTransport, 1);
    activeConnectionsBySocketId.set(params.socketId, {
        ...tracked,
        transport: toTransport,
    });
    refreshConnectionGauges();
}

export function recordSocketAuthHandshake(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    durationMs: number;
    result: "ok" | "error";
    failure?: string;
}>): void {
    const role = resolveSocketMetricsRole();
    const failure = params.failure ?? "none";
    const transport = normalizeTransportName(params.transport);
    websocketAuthHandshakesCounter.inc({
        role,
        client_type: params.clientType,
        transport,
        result: params.result,
        failure,
    });
    websocketAuthHandshakeDurationHistogram.observe(
        {
            role,
            client_type: params.clientType,
            result: params.result,
            failure,
        },
        Math.max(0, params.durationMs) / 1000,
    );
}

export function recordSocketAuthHandshakeException(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    stage: SocketAuthHandshakeStage;
    classification: SocketAuthHandshakeExceptionClassification;
}>): void {
    websocketAuthHandshakeExceptionsCounter.inc({
        role: resolveSocketMetricsRole(),
        client_type: params.clientType,
        transport: normalizeTransportName(params.transport),
        stage: params.stage,
        classification: params.classification,
    });
}

export function recordSocketConnectConvergencePhase(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    phase: SocketConnectConvergencePhase;
}>): void {
    websocketConnectConvergenceCounter.inc({
        role: resolveSocketMetricsRole(),
        client_type: params.clientType,
        transport: normalizeTransportName(params.transport),
        phase: params.phase,
    });
}

export function recordSocketConnectConvergenceDuration(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    result: SocketConnectConvergenceResult;
    durationMs: number;
}>): void {
    websocketConnectConvergenceDurationHistogram.observe(
        {
            role: resolveSocketMetricsRole(),
            client_type: params.clientType,
            transport: normalizeTransportName(params.transport),
            result: params.result,
        },
        Math.max(0, params.durationMs) / 1000,
    );
}

export function recordSocketAuthHandshakeStageDuration(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    stage: SocketAuthHandshakeStage;
    durationMs: number;
    result: "ok" | "error";
}>): void {
    websocketAuthHandshakeStageDurationHistogram.observe(
        {
            role: resolveSocketMetricsRole(),
            client_type: params.clientType,
            transport: normalizeTransportName(params.transport),
            stage: params.stage,
            result: params.result,
        },
        Math.max(0, params.durationMs) / 1000,
    );
}

export function recordSocketDisconnect(params: Readonly<{
    clientType: SocketConnectionType;
    transport?: string;
    reason: string;
}>): void {
    websocketDisconnectsCounter.inc({
        role: resolveSocketMetricsRole(),
        client_type: params.clientType,
        transport: normalizeTransportName(params.transport),
        reason: params.reason || "unknown",
    });
}

export function untrackWebSocketConnection(params: Readonly<{
    socketId: string;
    reason?: string;
    nowMs?: number;
}>): void {
    const tracked = activeConnectionsBySocketId.get(params.socketId);
    if (!tracked) {
        return;
    }

    activeConnectionsBySocketId.delete(params.socketId);
    legacyConnectionCounts[tracked.clientType] = Math.max(0, legacyConnectionCounts[tracked.clientType] - 1);
    adjustTransportCount(tracked.transport, -1);
    decrementRefCount(activeUsers, tracked.userId);
    decrementRefCount(activeSessions, tracked.sessionId);
    decrementRefCount(activeMachines, tracked.machineId);
    recentDisconnectsByReconnectKey.set(tracked.reconnectKey, params.nowMs ?? Date.now());

    if (tracked.transport === "polling") {
        recordSocketTransportUpgradeOutcome({
            socketId: params.socketId,
            fromTransport: "polling",
            toTransport: "polling",
            result: "abandoned",
        });
    }

    if (params.reason) {
        recordSocketDisconnect({
            clientType: tracked.clientType,
            transport: tracked.transport,
            reason: params.reason,
        });
    }

    refreshConnectionGauges();
}

export function setSocketAdapterModeInfo(params: Readonly<{
    adapter: string;
    redisEnabled: boolean;
    role: SocketRole;
}>): void {
    socketAdapterModeInfo.set(
        {
            adapter: params.adapter,
            redis_enabled: params.redisEnabled ? "true" : "false",
            role: params.role,
        },
        1,
    );
}
