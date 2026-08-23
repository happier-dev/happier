import {
    createPeerMediationObservabilityFlowStore,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityScopeV1,
    type PeerMediationObservabilitySnapshotV1,
} from "@happier-dev/protocol";

/**
 * Server-side peer-mediation observability store. The engine itself lives in the single shared
 * protocol owner (`createPeerMediationObservabilityFlowStore`); this module only binds the server's
 * retention option names so `apps/cli` and `apps/server` cannot re-drift (DEC-8). server must not
 * import cli and vice versa — protocol is the shared layer both may import.
 *
 * The predecessor copy summed the cumulative byte gauges the relay terminators emit instead of
 * taking the latest sample, so a flow reporting the same 1 000-byte total twice read 2 000.
 */

export type PeerMediationObservabilityScope = PeerMediationObservabilityScopeV1;
export type PeerMediationObservabilitySnapshot = PeerMediationObservabilitySnapshotV1;
export type PeerMediationObservabilityDeltaListener = (delta: PeerMediationObservabilityDeltaV1) => void;

export type PeerMediationObservabilityStore = Readonly<{
    publish(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1;
    delta(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilityDeltaV1;
    snapshot(scope: PeerMediationObservabilityScopeV1): PeerMediationObservabilitySnapshotV1;
    subscribe(scope: PeerMediationObservabilityScopeV1, listener: PeerMediationObservabilityDeltaListener): () => void;
}>;

export function createPeerMediationObservabilityStore(input: Readonly<{
    /** Per-flow retained event cap (the server's historical name for it). */
    maxEventsPerScope?: number;
    maxEventsPerMachineAggregate?: number;
    retentionWindowMs?: number;
    eventPayloadMaxBytes?: number;
    nowMs?: () => number;
}> = {}): PeerMediationObservabilityStore {
    const maxEventsPerScope = input.maxEventsPerMachineAggregate ?? input.maxEventsPerScope;
    return createPeerMediationObservabilityFlowStore({
        ...(input.maxEventsPerScope !== undefined ? { maxEventsPerFlow: input.maxEventsPerScope } : {}),
        ...(maxEventsPerScope !== undefined ? { maxEventsPerScope } : {}),
        ...(input.retentionWindowMs !== undefined ? { retentionWindowMs: input.retentionWindowMs } : {}),
        ...(input.eventPayloadMaxBytes !== undefined ? { eventPayloadMaxBytes: input.eventPayloadMaxBytes } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });
}
