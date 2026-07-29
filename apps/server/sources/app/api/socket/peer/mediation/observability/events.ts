import {
    PeerMediationObservabilityEventV1Schema,
    type PeerFlowKindV1,
    type PeerMediationObservabilityEventKindV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityFlowRefV1,
    type PeerMediationObservabilityScopeV1,
    type PeerRouteKindV1,
} from "@happier-dev/protocol";

import type { PeerMediationObservabilityHeaders } from "./redaction";
import {
    redactPeerMediationObservabilityHeaders,
    redactPeerMediationObservabilityMetadata,
    redactPeerMediationObservabilityUrl,
    redactedPeerMediationReference,
} from "./redaction";

export type PeerMediationObservabilityEvent = PeerMediationObservabilityEventV1;
export type PeerMediationObservabilityEventKind = PeerMediationObservabilityEventKindV1;
export type PeerMediationObservabilityFlowKind = PeerFlowKindV1;

export type PeerMediationObservabilityEmitter = Readonly<{
    emit(event: PeerMediationObservabilityEventV1): void;
}>;

function createEventId(input: Readonly<{
    accountId: string;
    machineId?: string;
    flowId: string;
    kind: string;
    nowMs: number;
}>): string {
    const machine = input.machineId ?? "none";
    return `obs_${redactedPeerMediationReference("event", `${input.accountId}:${machine}:${input.flowId}:${input.kind}:${input.nowMs}`)}`;
}

function machineScope(input: Readonly<{ accountId: string; machineId?: string }>): PeerMediationObservabilityScopeV1 {
    return {
        kind: "machine",
        accountId: input.accountId,
        machineId: input.machineId ?? "unknown",
    };
}

function flowRef(input: Readonly<{
    flowKind: PeerFlowKindV1;
    flowId: string;
    routeKind?: PeerRouteKindV1;
    routeGrantId?: string;
    previewId?: string;
    substreamId?: string;
}>): PeerMediationObservabilityFlowRefV1 {
    return {
        flowId: input.flowId,
        flowKind: input.flowKind,
        ...(input.routeKind ? { routeKind: input.routeKind } : {}),
        ...(input.flowKind === "tcp_tunnel" ? { tunnelId: input.flowId } : {}),
        ...(input.substreamId ? { substreamId: input.substreamId } : {}),
        ...(input.flowKind === "live_stream" ? { streamId: input.flowId } : {}),
        ...(input.routeGrantId ? { routeGrantId: redactedPeerMediationReference("grant", input.routeGrantId) } : {}),
        ...(input.previewId ? { productRef: { kind: "preview", id: input.previewId, redacted: false } } : {}),
    };
}

function parseEvent(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1 {
    return PeerMediationObservabilityEventV1Schema.parse(event);
}

function headerValues(value: string | readonly string[] | undefined): readonly string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
}

function countWebSocketSubprotocols(headers: PeerMediationObservabilityHeaders): number {
    let count = 0;
    for (const [name, value] of Object.entries(headers)) {
        if (name.trim().toLowerCase() !== "sec-websocket-protocol") continue;
        for (const headerValue of headerValues(value)) {
            count += headerValue.split(",").map((item) => item.trim()).filter(Boolean).length;
        }
    }
    return count;
}

function buildEvent(input: Readonly<{
    accountId: string;
    machineId?: string;
    flowKind: PeerFlowKindV1;
    flowId: string;
    kind: PeerMediationObservabilityEventKindV1;
    nowMs: number;
    routeKind?: PeerRouteKindV1;
    routeGrantId?: string;
    previewId?: string;
    substreamId?: string;
    data?: Readonly<Record<string, unknown>>;
}>): PeerMediationObservabilityEventV1 {
    return parseEvent({
        v: 1,
        eventId: createEventId(input),
        sequence: 1,
        emittedAtMs: input.nowMs,
        scope: machineScope(input),
        flow: flowRef(input),
        kind: input.kind,
        data: input.data ?? {},
        redaction: {
            level: "metadataOnly",
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
    });
}

export function createPeerMediationFlowEvent(input: Readonly<{
    accountId: string;
    machineId?: string;
    flowKind: PeerFlowKindV1;
    flowId: string;
    kind: PeerMediationObservabilityEventKindV1;
    nowMs: number;
    routeKind?: PeerRouteKindV1;
    reasonCode?: string;
    routeGrantId?: string;
    bytesIn?: number;
    bytesOut?: number;
    metadata?: Readonly<Record<string, unknown>>;
}>): PeerMediationObservabilityEventV1 {
    return buildEvent({
        accountId: input.accountId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        flowKind: input.flowKind,
        flowId: input.flowId,
        kind: input.kind,
        nowMs: input.nowMs,
        routeKind: input.routeKind ?? "server_relay",
        ...(input.routeGrantId ? { routeGrantId: input.routeGrantId } : {}),
        data: {
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(input.bytesIn !== undefined ? { bytesIn: input.bytesIn } : {}),
            ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
            ...redactPeerMediationObservabilityMetadata(input.metadata),
        },
    });
}

export function createPeerMediationHttpRequestStartedEvent(input: Readonly<{
    accountId: string;
    machineId: string;
    previewId: string;
    tunnelId: string;
    substreamId: string;
    requestId: string;
    method: string;
    url: string;
    headers: PeerMediationObservabilityHeaders;
    nowMs: number;
}>): PeerMediationObservabilityEventV1 {
    const url = redactPeerMediationObservabilityUrl(input.url);
    return buildEvent({
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: "tcp_tunnel",
        flowId: input.tunnelId,
        kind: "http.request.started",
        nowMs: input.nowMs,
        routeKind: "server_relay",
        previewId: input.previewId,
        substreamId: input.substreamId,
        data: {
            requestId: input.requestId,
            method: input.method.toUpperCase(),
            path: url.path,
            queryKeys: url.queryKeys,
            headers: redactPeerMediationObservabilityHeaders(input.headers),
        },
    });
}

export function createPeerMediationHttpRequestFinishedEvent(input: Readonly<{
    accountId: string;
    machineId: string;
    previewId: string;
    tunnelId: string;
    substreamId: string;
    requestId: string;
    method: string;
    url: string;
    statusCode: number;
    durationMs: number;
    requestBytes?: number;
    responseBytes?: number;
    nowMs: number;
}>): PeerMediationObservabilityEventV1 {
    const url = redactPeerMediationObservabilityUrl(input.url);
    return buildEvent({
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: "tcp_tunnel",
        flowId: input.tunnelId,
        kind: "http.request.finished",
        nowMs: input.nowMs,
        routeKind: "server_relay",
        previewId: input.previewId,
        substreamId: input.substreamId,
        data: {
            requestId: input.requestId,
            method: input.method.toUpperCase(),
            path: url.path,
            queryKeys: url.queryKeys,
            statusCode: input.statusCode,
            durationMs: input.durationMs,
            ...(input.requestBytes !== undefined ? { requestBytes: input.requestBytes } : {}),
            ...(input.responseBytes !== undefined ? { responseBytes: input.responseBytes } : {}),
        },
    });
}

export function createPeerMediationHttpRequestAbortedEvent(input: Readonly<{
    accountId: string;
    machineId: string;
    previewId: string;
    tunnelId: string;
    substreamId: string;
    requestId: string;
    method: string;
    url: string;
    reasonCode: string;
    durationMs: number;
    requestBytes?: number;
    responseBytes?: number;
    nowMs: number;
}>): PeerMediationObservabilityEventV1 {
    const url = redactPeerMediationObservabilityUrl(input.url);
    return buildEvent({
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: "tcp_tunnel",
        flowId: input.tunnelId,
        kind: "http.request.aborted",
        nowMs: input.nowMs,
        routeKind: "server_relay",
        previewId: input.previewId,
        substreamId: input.substreamId,
        data: {
            requestId: input.requestId,
            method: input.method.toUpperCase(),
            path: url.path,
            queryKeys: url.queryKeys,
            reasonCode: input.reasonCode,
            durationMs: input.durationMs,
            ...(input.requestBytes !== undefined ? { requestBytes: input.requestBytes } : {}),
            ...(input.responseBytes !== undefined ? { responseBytes: input.responseBytes } : {}),
        },
    });
}

export function createPeerMediationWebSocketEvent(input: Readonly<{
    kind: "websocket.opened" | "websocket.closed" | "websocket.aborted" | "websocket.errored";
    accountId: string;
    machineId: string;
    previewId: string;
    tunnelId: string;
    substreamId: string;
    socketId: string;
    url: string;
    headers: PeerMediationObservabilityHeaders;
    nowMs: number;
    durationMs?: number;
    clientBytes?: number;
    upstreamBytes?: number;
    closeCode?: number;
    reasonCode?: string;
}>): PeerMediationObservabilityEventV1 {
    const url = redactPeerMediationObservabilityUrl(input.url);
    const headers = redactPeerMediationObservabilityHeaders(input.headers);
    const subprotocolCount = countWebSocketSubprotocols(input.headers);
    return buildEvent({
        accountId: input.accountId,
        machineId: input.machineId,
        flowKind: "tcp_tunnel",
        flowId: input.tunnelId,
        kind: input.kind,
        nowMs: input.nowMs,
        routeKind: "server_relay",
        previewId: input.previewId,
        substreamId: input.substreamId,
        data: {
            socketId: input.socketId,
            path: url.path,
            queryKeys: url.queryKeys,
            headers,
            ...(subprotocolCount > 0 ? { subprotocolCount } : {}),
            ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
            ...(input.clientBytes !== undefined ? { clientBytes: input.clientBytes } : {}),
            ...(input.upstreamBytes !== undefined ? { upstreamBytes: input.upstreamBytes } : {}),
            ...(input.closeCode !== undefined ? { closeCode: input.closeCode } : {}),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        },
    });
}
