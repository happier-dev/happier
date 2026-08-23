import {
    PeerMediationObservabilityEventV1Schema,
    type PeerFlowKindV1,
    type PeerMediationObservabilityEventKindV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityFlowRefV1,
    type PeerMediationObservabilityScopeV1,
    type PeerRouteKindV1,
} from '@happier-dev/protocol';

import {
    redactDaemonPeerMediationObservabilityMetadata,
    redactedDaemonPeerMediationReference,
} from './redaction';

export type DaemonPeerMediationObservabilityEventKind = PeerMediationObservabilityEventKindV1;
export type DaemonPeerMediationObservabilityFlowKind = PeerFlowKindV1;
export type DaemonPeerMediationObservabilityEvent = PeerMediationObservabilityEventV1;

export type DaemonPeerMediationObservabilityEmitter = Readonly<{
    emit(event: PeerMediationObservabilityEventV1): void;
}>;

function createEventId(input: Readonly<{
    accountId: string;
    machineId: string;
    flowId: string;
    kind: string;
    nowMs: number;
}>): string {
    return `obs_${redactedDaemonPeerMediationReference("event", `${input.accountId}:${input.machineId}:${input.flowId}:${input.kind}:${input.nowMs}`)}`;
}

function machineScope(input: Readonly<{ accountId: string; machineId: string }>): PeerMediationObservabilityScopeV1 {
    return {
        kind: 'machine',
        accountId: input.accountId,
        machineId: input.machineId,
    };
}

function flowRef(input: Readonly<{
    flowKind: PeerFlowKindV1;
    flowId: string;
    routeKind?: PeerRouteKindV1;
    routeGrantId?: string;
}>): PeerMediationObservabilityFlowRefV1 {
    return {
        flowId: input.flowId,
        flowKind: input.flowKind,
        ...(input.routeKind ? { routeKind: input.routeKind } : {}),
        ...(input.flowKind === 'tcp_tunnel' ? { tunnelId: input.flowId } : {}),
        ...(input.flowKind === 'live_stream' ? { streamId: input.flowId } : {}),
        ...(input.routeGrantId ? { routeGrantId: redactedDaemonPeerMediationReference('grant', input.routeGrantId) } : {}),
    };
}

export function createDaemonPeerMediationFlowEvent(input: Readonly<{
    accountId: string;
    machineId: string;
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
    return PeerMediationObservabilityEventV1Schema.parse({
        v: 1,
        eventId: createEventId(input),
        sequence: 1,
        emittedAtMs: input.nowMs,
        scope: machineScope(input),
        flow: flowRef({
            flowKind: input.flowKind,
            flowId: input.flowId,
            routeKind: input.routeKind ?? 'server_relay',
            ...(input.routeGrantId ? { routeGrantId: input.routeGrantId } : {}),
        }),
        kind: input.kind,
        data: {
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(input.bytesIn !== undefined ? { bytesIn: input.bytesIn } : {}),
            ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
            ...redactDaemonPeerMediationObservabilityMetadata(input.metadata),
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
    });
}

/**
 * Scope-bound flow observer for the DIRECT routes (P1-9).
 *
 * Before this, the observability emitter reached only the two relay terminators, so the direct
 * loopback route — the substrate's entire reason to exist — produced no observability facts at all:
 * a user could open a direct tunnel, RPC call or live stream and the flow list stayed empty.
 *
 * The route registrars sit behind one composition root (`createPeerMediationLoopbackApp`), which
 * already knows the account, machine, route kind and clock, so the binding happens once there and
 * each registrar keeps one-line emit calls. When no emitter is supplied the observer is inert, so
 * registrars need no null checks and narrow unit callers are unaffected.
 */
export type DaemonPeerMediationDirectFlowObserver = Readonly<{
    emit(input: Readonly<{
        flowKind: PeerFlowKindV1;
        flowId: string;
        kind: PeerMediationObservabilityEventKindV1;
        reasonCode?: string;
        routeGrantId?: string;
        bytesIn?: number;
        bytesOut?: number;
        metadata?: Readonly<Record<string, unknown>>;
    }>): void;
}>;

const INERT_DIRECT_FLOW_OBSERVER: DaemonPeerMediationDirectFlowObserver = { emit: () => undefined };

export function createDaemonPeerMediationDirectFlowObserver(input: Readonly<{
    observability?: DaemonPeerMediationObservabilityEmitter | undefined;
    accountId: string;
    machineId: string;
    routeKind: PeerRouteKindV1;
    nowMs: () => number;
}>): DaemonPeerMediationDirectFlowObserver {
    const emitter = input.observability;
    if (!emitter) return INERT_DIRECT_FLOW_OBSERVER;
    return {
        emit: (event) => {
            emitter.emit(createDaemonPeerMediationFlowEvent({
                accountId: input.accountId,
                machineId: input.machineId,
                flowKind: event.flowKind,
                flowId: event.flowId,
                kind: event.kind,
                nowMs: input.nowMs(),
                routeKind: input.routeKind,
                ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
                ...(event.routeGrantId ? { routeGrantId: event.routeGrantId } : {}),
                ...(event.bytesIn !== undefined ? { bytesIn: event.bytesIn } : {}),
                ...(event.bytesOut !== undefined ? { bytesOut: event.bytesOut } : {}),
                ...(event.metadata ? { metadata: event.metadata } : {}),
            }));
        },
    };
}
