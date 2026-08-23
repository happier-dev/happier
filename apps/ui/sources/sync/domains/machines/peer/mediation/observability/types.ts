import type {
    PeerFlowKindV1,
    PeerMediationObservabilityEventV1,
    PeerMediationObservabilityFlowRefV1,
    PeerMediationObservabilityFlowSnapshotV1,
    PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

export type PeerMediationObservabilitySource = 'server' | 'daemon';

export type PeerMediationObservabilityScopeStatus =
    | 'idle'
    | 'ready'
    | 'stale'
    | 'unavailable';

export type PeerMediationObservabilitySourceFamily = Readonly<{
    sequence: number;
    lastUpdatedAtMs: number;
    snapshot: PeerMediationObservabilityFlowSnapshotV1;
    events: readonly PeerMediationObservabilityEventV1[];
}>;

export type PeerMediationObservabilityFlowEntry = Readonly<{
    key: string;
    machineKey: string;
    flowId: string;
    flowKind: PeerFlowKindV1;
    sources: Partial<Record<PeerMediationObservabilitySource, PeerMediationObservabilitySourceFamily>>;
}>;

export type PeerMediationObservabilityScopeState = Readonly<{
    scope: PeerMediationObservabilityScopeV1;
    scopeKey: string;
    status: PeerMediationObservabilityScopeStatus;
    /**
     * A sequence gap or scope mismatch was observed, so this scope's flows may be incomplete until a
     * fresh snapshot lands. PMS-9 REQ "resubscribe-on-gap" is NOT implemented: nothing re-emits
     * `subscribe`. The predecessor carried a second boolean, `resubscribeRequired`, that was assigned
     * exactly this value at all five write sites and read by nothing — one concept, two fields.
     */
    stale: boolean;
    unavailableReasonCode: string | null;
    lastAppliedSequenceBySource: Partial<Record<PeerMediationObservabilitySource, number>>;
    staleSourceBySource: Partial<Record<PeerMediationObservabilitySource, boolean>>;
    flowsByKey: Readonly<Record<string, PeerMediationObservabilityFlowEntry>>;
}>;

export type PeerMediationObservabilityUiStore = Readonly<{
    scopesByKey: Readonly<Record<string, PeerMediationObservabilityScopeState>>;
}>;

export type PeerMediationObservabilityFlowSummary = Readonly<{
    key: string;
    machineKey: string;
    flowId: string;
    flowKind: PeerFlowKindV1;
    flow: PeerMediationObservabilityFlowRefV1;
    lifecycleState: PeerMediationObservabilityFlowSnapshotV1['lifecycleState'];
    startedAtMs: number;
    lastActivityAtMs: number;
    closedAtMs?: number;
    bytesIn: number;
    bytesOut: number;
    framesIn: number;
    framesOut: number;
    messagesIn: number;
    messagesOut: number;
    activeSubstreams: number;
    totalSubstreams?: number;
    movingThroughputBps?: number;
    capProfileId?: string;
    capUsagePercent?: number;
    closeReasonCode?: string;
    abortReasonCode?: string;
    errorReasonCode?: string;
    http?: Record<string, unknown>;
    websocket?: Record<string, unknown>;
    sourceFamilies: Partial<Record<PeerMediationObservabilitySource, Readonly<{
        sequence: number;
        lastUpdatedAtMs: number;
    }>>>;
}>;

export type PeerMediationPreviewProxyDiagnostics = Readonly<
    | {
        status: 'unavailable';
        reasonCode: string;
      }
    | {
        status: 'stale';
        attribution: 'traffic_for_preview_all_views';
        activeFlowCount: number;
        flows: readonly PeerMediationObservabilityFlowSummary[];
      }
    | {
        status: 'available';
        attribution: 'traffic_for_preview_all_views';
        activeFlowCount: number;
        flows: readonly PeerMediationObservabilityFlowSummary[];
      }
>;
