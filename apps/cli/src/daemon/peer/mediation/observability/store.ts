import {
    createPeerMediationObservabilityFlowStore,
    type PeerMediationObservabilityDeltaV1,
    type PeerMediationObservabilityEventV1,
    type PeerMediationObservabilityScopeV1,
    type PeerMediationObservabilitySnapshotV1,
} from '@happier-dev/protocol';

/**
 * Daemon-side peer-mediation observability store. The engine itself lives in the single shared
 * protocol owner (`createPeerMediationObservabilityFlowStore`); this module only binds the daemon's
 * `(machineId, accountId)` call signature so `apps/cli` and `apps/server` cannot re-drift (DEC-8).
 * cli must not import server and vice versa — protocol is the shared layer both may import.
 *
 * The predecessor copy carried two observable defects the shared owner fixes: it collapsed every
 * non-machine scope into a single `unknown:unknown` bucket, and it summed the cumulative byte
 * gauges the relay terminators emit instead of taking the latest sample.
 */

export type DaemonPeerMediationObservabilitySnapshot = PeerMediationObservabilitySnapshotV1;
export type DaemonPeerMediationObservabilityDeltaListener = (delta: PeerMediationObservabilityDeltaV1) => void;

export type DaemonPeerMediationObservabilityStore = Readonly<{
    publish(event: PeerMediationObservabilityEventV1): PeerMediationObservabilityEventV1;
    delta(machineId: string, accountId: string): PeerMediationObservabilityDeltaV1;
    snapshot(machineId: string, accountId: string): PeerMediationObservabilitySnapshotV1;
    subscribe(machineId: string, accountId: string, listener: DaemonPeerMediationObservabilityDeltaListener): () => void;
}>;

function machineScope(machineId: string, accountId: string): PeerMediationObservabilityScopeV1 {
    return { kind: 'machine', accountId, machineId };
}

export function createDaemonPeerMediationObservabilityStore(input: Readonly<{
    maxEventsPerMachine?: number;
    maxEventsPerFlow?: number;
    retentionWindowMs?: number;
    eventPayloadMaxBytes?: number;
    nowMs?: () => number;
}> = {}): DaemonPeerMediationObservabilityStore {
    const store = createPeerMediationObservabilityFlowStore({
        ...(input.maxEventsPerMachine !== undefined ? { maxEventsPerScope: input.maxEventsPerMachine } : {}),
        ...(input.maxEventsPerFlow !== undefined ? { maxEventsPerFlow: input.maxEventsPerFlow } : {}),
        ...(input.retentionWindowMs !== undefined ? { retentionWindowMs: input.retentionWindowMs } : {}),
        ...(input.eventPayloadMaxBytes !== undefined ? { eventPayloadMaxBytes: input.eventPayloadMaxBytes } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });

    return {
        publish: (event) => store.publish(event),
        delta: (machineId, accountId) => store.delta(machineScope(machineId, accountId)),
        snapshot: (machineId, accountId) => store.snapshot(machineScope(machineId, accountId)),
        subscribe: (machineId, accountId, listener) => store.subscribe(machineScope(machineId, accountId), listener),
    };
}
