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
